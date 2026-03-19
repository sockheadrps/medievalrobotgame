// NPCBrain — LLM decision layer for NPC behavior.
// Calls the player's local Ollama directly for high-level intent decisions,
// then feeds validated commands to NPCTaskRunner.

import Phaser from 'phaser';
import { TILE_SIZE } from '../constants.js';
import { generateDecision, checkConnection } from '../net/LLMClient.js';
import { DriveSystem, TASK_DRIVE_AFFINITY } from './DriveSystem.js';

const DECISION_COOLDOWN_BASE = 4000;  // base ms between LLM calls (scaled by personality.decisionSpeed)
const IDLE_REFRESH_BASE      = 12000; // base idle refresh (scaled by personality.decisionSpeed)
const BUSY_REFRESH_BASE      = 15000; // base busy refresh (scaled by personality.decisionSpeed)
const MAX_FAIL_BACKOFF_MS  = 60000; // max backoff after repeated failures
const FAIL_BACKOFF_BASE_MS = 5000;  // initial backoff after a failure
const HP_DANGER_PCT        = 0.35; // trigger decision when HP drops below this
const EMOTION_DELTA_MAX    = 0.05; // max emotion shift per decision — small nudges only

// Emotion thresholds for autonomous reactions (bypass LLM)
const FEAR_REACT_THRESHOLD  = 0.7;  // flee toward player
const ANGER_REACT_THRESHOLD = 0.8;  // attack nearest (Berserker-only automatic rage)
const EMOTION_REACT_COOLDOWN = 6000; // ms between emotion-triggered reactions

// Maps LLM intents to TaskRunner tasks
const INTENT_TO_TASK = {
  follow:           { task: 'follow' },
  stay_near_player: { task: 'follow' },
  defend_player:    { task: 'defend_player' },
  attack_enemy:     { task: 'attack_nearest_enemy' },
  attack_player:    null, // handled specially — needs target_id
  attack_npc:       null, // handled specially — needs target info
  retreat:          { task: 'follow' },
  hold_position:    { task: 'idle' },
  observe:          { task: 'idle' },
  reposition:       { task: 'follow' },
  do_nothing:       { task: 'idle' },
  gather_wood:      { task: 'gather', item: 'wood' },
  give_logs:        { task: 'give_logs' },
  train:            { task: 'train' },
  practice_ki:      { task: 'practice_ki' },
  pickup_stone:     { task: 'pickup_stone' },
  refine_stone:     { task: 'refine_stone' },
  give_materials:   { task: 'give_materials' },
  mine_ore:         { task: 'mine_ore' },
  deposit_to_crate: { task: 'deposit_to_crate' },
  socialize_npc:    null, // handled specially — needs target info
  steal_logs:       null, // handled specially — needs target info
};

const VALID_INTENTS = new Set(Object.keys(INTENT_TO_TASK));

// Personality-specific fallback lines (shown as speech when falling back)
const FALLBACK_LINES = {
  Guardian:   ['Staying close.', 'I\'ll guard you.', 'Watching the area.'],
  Scout:      ['Looking around...', 'Hmm, what\'s over there?', 'Taking a look.'],
  Berserker:  ['Where\'s the fight?!', 'Come on!!', 'Who wants some?!'],
  Caretaker:  ['I\'m right here.', 'Staying near you.', 'Everything okay?'],
  Paranoid:   ['...staying close.', 'Don\'t trust this.', 'Something feels off.'],
  Pragmatist: ['Might as well gather.', 'Making myself useful.', 'No orders? I\'ll work.'],
};

function _makeFallbackResponse(personalityType) {
  const fallbackTask = {
    Guardian: 'defend_player', Scout: 'idle', Berserker: 'attack_enemy',
    Caretaker: 'follow', Paranoid: 'follow', Pragmatist: 'gather_wood',
  }[personalityType] || 'follow';
  const lines = FALLBACK_LINES[personalityType] || ['Following.'];
  const speech = lines[Math.floor(Math.random() * lines.length)];
  return {
    primary_intent: fallbackTask,
    secondary_intent: null,
    target_id: null,
    speech,
    emotion_delta: { trust: 0, fear: 0, anger: 0 },
    memory_candidates: [],
    reason_summary: `Fallback (${personalityType}): ${fallbackTask}.`,
  };
}

export class NPCBrain {
  constructor(scene, npc, taskRunner) {
    this._scene  = scene;
    this._npc    = npc;
    this._runner = taskRunner;

    this._lastDecisionTime = 0;
    this._pending = false;  // true while awaiting LLM response
    this._lastHpPct = 1.0;
    this._lastIntent = null;
    this._lastDecision = null; // most recent validated decision (for UI)
    this._enabled = true;
    this._eventQueue = []; // events that trigger a decision
    this._recentEvents = []; // rolling window for context
    this._consecutiveFails = 0; // backoff counter for LLM failures
    this._backoffUntil = 0;    // timestamp — don't request until this time
    this._ollamaDown = false;  // true after connectivity check fails
    this._lastConnCheck = 0;   // timestamp of last connectivity check
    this._lastAppliedTask = null; // track what task is actually running to avoid re-deciding
    this._lastEmotionReactTime = 0; // throttle emotion-triggered reactions
    this._lastDriveIntent = null; // track last drive-based intent to avoid re-firing
  }

  // ── Personality-scaled decision timings ─────────────────────────────────────

  _getDecisionCooldown() {
    const mod = this._npc._personalityMod?.decisionSpeed ?? 1.0;
    return Math.round(DECISION_COOLDOWN_BASE * mod);
  }

  _getIdleRefresh() {
    const mod = this._npc._personalityMod?.decisionSpeed ?? 1.0;
    return Math.round(IDLE_REFRESH_BASE * mod);
  }

  _getBusyRefresh() {
    const mod = this._npc._personalityMod?.decisionSpeed ?? 1.0;
    return Math.round(BUSY_REFRESH_BASE * mod);
  }

  /** Enable/disable autonomous decision-making. */
  setEnabled(on) { this._enabled = on; }

  /** Push an event that may trigger a new decision. */
  pushEvent(event) {
    // event: { type, text, importance, age_ms? }
    event.ts = Date.now();
    event.age_ms = 0;
    this._recentEvents.push(event);
    // Keep only last 10
    if (this._recentEvents.length > 10) this._recentEvents.shift();

    // High-importance events trigger immediate decision
    if (event.importance >= 0.8) {
      this._eventQueue.push(event);
    }
  }

  /** Called when player gives an explicit command via chat. Pause autonomous decisions briefly. */
  onPlayerCommand() {
    const now = Date.now();
    this._lastDecisionTime = now;
    this._npc._manualCommandUntil = now + 12000;
    this._npc._emotionReactTarget = null;
    this._lastDriveIntent = null; // allow drive re-evaluation after manual command window expires
    // Damp the dominant drive — player's attention distracts the NPC
    const drives = this._npc.soul?.drives;
    if (drives) {
      const label = DriveSystem.getDominantDriveLabel?.(drives) ||
        Object.entries(drives).filter(([k]) => !k.startsWith('_'))
          .sort((a, b) => b[1] - a[1])[0]?.[0];
      if (label && typeof drives[label] === 'number') {
        drives[label] = Math.max(0, drives[label] * 0.7);
      }
      drives._commitUntil = 0;
    }
  }

  /** Extract bare npcId from composite key. "test2_npc_1" → "npc_1", "npc_1" → "npc_1" */
  _extractNpcId(compositeKey) {
    const match = compositeKey.match(/(npc_\d+)$/);
    return match ? match[1] : compositeKey;
  }

  /** Called every frame from GameScene. */
  update(delta) {
    if (!this._enabled || this._npc.isDead() || this._pending) return;

    const now = Date.now();

    // ── Drive tick (runs every frame, before all decision logic) ──
    DriveSystem.tick(this._npc, this._scene, delta);

    // ── Apply task decay to the running drive ──
    const status = this._runner.getStatus();
    if (status.running && status.tasks[0]) {
      DriveSystem.applyTaskDecay(this._npc, status.tasks[0].task, delta);
    }

    const elapsed = now - this._lastDecisionTime;

    // ── Emotion-triggered autonomous reactions (no LLM, instant) ──
    if (now - this._lastEmotionReactTime >= EMOTION_REACT_COOLDOWN) {
      const reacted = this._checkEmotionReactions(now);
      if (reacted) return; // skip LLM decision this frame
    }

    // ── Drive-based silent task switching (no LLM) ──
    const isManualLocked = this._npc._manualCommandUntil && now < this._npc._manualCommandUntil;
    const isCommitLocked = (this._npc.soul?.drives?._commitUntil ?? 0) > now;
    if (!isManualLocked && !isCommitLocked) {
      const dominantDrive = DriveSystem.getDominantIntent(this._npc, this._scene);
      if (dominantDrive && dominantDrive !== this._lastDriveIntent) {
        const taskDef = DriveSystem.driveToTask(dominantDrive, this._npc, this._scene);
        if (taskDef) {
          // Don't interrupt blocking tasks
          const isBusyBlocking = status.tasks.some(t =>
            ['give_logs', 'socialize_npc', 'steal_logs', 'practice_ki', 'refine_stone', 'deposit_to_crate', 'custom_task'].includes(t.task)
          );
          if (!isBusyBlocking) {
            this._runner.setTasks([taskDef]);
            this._lastDriveIntent = dominantDrive;
            // Set commitment lock
            const pType = this._npc.soul?.personality?.type || 'Pragmatist';
            this._npc.soul.drives._commitUntil = now + DriveSystem.getCommitDuration(pType);
            return;
          }
        }
      }
    }

    // Check triggers for LLM — skip if manually locked (recent LLM decision or player command)
    if (isManualLocked) return;

    let shouldDecide = false;
    const isBusy = status.running;

    // Use personality-scaled cooldowns
    const minCooldown = isBusy ? this._getBusyRefresh() : this._getDecisionCooldown();

    // 1. Event-triggered (combat, player command, etc.)
    if (this._eventQueue.length > 0) {
      shouldDecide = elapsed >= minCooldown;
      if (shouldDecide) this._eventQueue.length = 0;
    }

    // 2. HP dropped below danger threshold — always use short cooldown for danger
    const hpPct = this._npc.hp / this._npc.maxHp;
    if (hpPct < HP_DANGER_PCT && this._lastHpPct >= HP_DANGER_PCT) {
      shouldDecide = elapsed >= this._getDecisionCooldown();
    }
    this._lastHpPct = hpPct;

    // 3. Task runner finished all tasks (NPC is idle) — needs new orders
    if (!isBusy && elapsed >= this._getIdleRefresh()) {
      shouldDecide = true;
    }

    // 4. Drive conflict — two drives nearly equal and both high → LLM narrates
    //    Use busy refresh (not short cooldown) to avoid spamming the LLM
    if (DriveSystem.hasDriveConflict(this._npc) && elapsed >= this._getBusyRefresh()) {
      shouldDecide = true;
    }

    if (shouldDecide) {
      this._requestDecision();
    }
  }

  // ── Emotion-triggered autonomous reactions ────────────────────────────────

  /** Check if emotional state should trigger an instant reaction (no LLM). Returns true if reacted. */
  _checkEmotionReactions(now) {
    const npc = this._npc;
    const rel = npc._getOwnerRelationship?.();
    if (!rel) return false;
    const personalityType = npc.soul?.personality?.type;

    // Don't override manual commands from the player
    if (npc._manualCommandUntil && now < npc._manualCommandUntil) return false;

    // High fear → flee toward player (all personality types)
    if (rel.fear > FEAR_REACT_THRESHOLD) {
      const currentTasks = this._runner.getStatus().tasks;
      const alreadyFleeing = currentTasks.some(t => t.task === 'follow');
      if (!alreadyFleeing) {
        const fearLines = {
          Guardian:   ['Falling back to you!', 'Too dangerous, retreating!'],
          Scout:      ['Nope, getting out of here!', 'That\'s my cue to leave!'],
          Berserker:  ['Tch... fine, pulling back!', 'I\'ll be back for you!'],
          Caretaker:  ['I\'m scared... staying close!', 'Please, let\'s get away!'],
          Paranoid:   ['I KNEW it! Running!', 'We need to go NOW!'],
          Pragmatist: ['Tactical retreat.', 'Not worth the risk.'],
        };
        const lines = fearLines[personalityType] || ['Retreating!'];
        npc.showBubble(lines[Math.floor(Math.random() * lines.length)], 2500);
        this._runner.setTasks([{ task: 'follow' }]);
        this._lastEmotionReactTime = now;
        this._lastIntent = 'follow';
        console.log(`[NPCBrain] ${npc.getName()}: FEAR reaction (${rel.fear.toFixed(2)}) → flee`);
        return true;
      }
    }

    // High anger + Berserker → attack nearest (rage mode)
    if (rel.anger > ANGER_REACT_THRESHOLD && personalityType === 'Berserker') {
      const currentTasks = this._runner.getStatus().tasks;
      const alreadyAttacking = currentTasks.some(t =>
        t.task === 'attack_nearest_enemy' || t.task === 'attack_player' || t.task === 'attack_npc'
      );
      if (!alreadyAttacking) {
        const rageLines = ['RAAAGH!', 'COME HERE!!', 'I\'LL BREAK YOU!', 'FIGHT ME!!'];
        npc.showBubble(rageLines[Math.floor(Math.random() * rageLines.length)], 2000);
        this._runner.setTasks([{ task: 'attack_nearest_enemy' }]);
        this._lastEmotionReactTime = now;
        this._lastIntent = 'attack_enemy';
        console.log(`[NPCBrain] ${npc.getName()}: RAGE reaction (anger ${rel.anger.toFixed(2)}) → attack`);
        return true;
      }
    }

    // High anger + Guardian → defend player (protective instinct)
    if (rel.anger > 0.6 && personalityType === 'Guardian') {
      const currentTasks = this._runner.getStatus().tasks;
      const alreadyDefending = currentTasks.some(t => t.task === 'defend_player');
      if (!alreadyDefending) {
        const protectLines = ['Nobody threatens us!', 'Stay behind me!', 'I\'ll handle this!'];
        npc.showBubble(protectLines[Math.floor(Math.random() * protectLines.length)], 2500);
        this._runner.setTasks([{ task: 'defend_player' }]);
        this._lastEmotionReactTime = now;
        this._lastIntent = 'defend_player';
        console.log(`[NPCBrain] ${npc.getName()}: PROTECT reaction (anger ${rel.anger.toFixed(2)}) → defend`);
        return true;
      }
    }

    return false;
  }

  // ── Build state packet ──────────────────────────────────────────────────────

  _buildStatePacket() {
    const scene = this._scene;
    const npc   = this._npc;
    const player = scene.player;
    const playerId = scene.playerId;

    const playerDist = player
      ? Phaser.Math.Distance.Between(npc.x, npc.y, player.x, player.y) / TILE_SIZE
      : 999;

    // Current task runner status
    const runnerStatus = this._runner.getStatus();
    const currentCommand = runnerStatus.running
      ? { type: runnerStatus.tasks[0]?.task || 'idle', age_ms: Date.now() - this._lastDecisionTime }
      : { type: 'idle', age_ms: 0 };

    // Nearby entities — dummies, other players, remote NPCs
    const nearbyEntities = [];
    for (const dummy of (scene.dummies ?? [])) {
      if (dummy.isDead()) continue;
      const dist = Phaser.Math.Distance.Between(npc.x, npc.y, dummy.x, dummy.y) / TILE_SIZE;
      if (dist < 12) {
        nearbyEntities.push({
          id: dummy._serverId || 'local_dummy',
          type: 'training_dummy',
          name: 'Training Dummy',
          distance: parseFloat(dist.toFixed(1)),
          hp: dummy.hp,
          maxHp: dummy.maxHp,
          visible: true,
        });
      }
    }

    // Other players
    for (const rp of Object.values(scene._remotePlayers || {})) {
      if (rp.isDead?.()) continue;
      const dist = Phaser.Math.Distance.Between(npc.x, npc.y, rp.x, rp.y) / TILE_SIZE;
      if (dist < 12) {
        nearbyEntities.push({
          id: rp.playerId,
          type: 'player',
          name: rp.playerId,
          distance: parseFloat(dist.toFixed(1)),
          hp: rp._hp,
          maxHp: rp._maxHp,
          visible: true,
        });
      }
    }

    // Other players' NPCs
    for (const rnpc of Object.values(scene._remoteNPCSprites || {})) {
      if (rnpc.isDead?.()) continue;
      const dist = Phaser.Math.Distance.Between(npc.x, npc.y, rnpc.x, rnpc.y) / TILE_SIZE;
      if (dist < 12) {
        nearbyEntities.push({
          id: `${rnpc.ownerPid}_${rnpc.npcId}`,
          npc_id: rnpc.npcId,
          type: 'enemy_npc',
          name: rnpc.getName(),
          owner: rnpc.ownerPid,
          distance: parseFloat(dist.toFixed(1)),
          hp: rnpc.hp,
          maxHp: rnpc.maxHp,
          logs: rnpc.logs ?? 0,
          maxLogs: rnpc.maxLogs ?? 0,
          gathering: rnpc.gathering ?? false,
          visible: true,
        });
      }
    }

    // Nearby threats tracked from recent combat events
    const nearbyThreats = [];
    const recentThreats = scene._recentThreats || {};
    for (const rp of Object.values(scene._remotePlayers || {})) {
      if (rp.isDead?.()) continue;
      const threatKey = `player:${rp.playerId}`;
      if (!recentThreats[threatKey]) continue;
      const dist = Phaser.Math.Distance.Between(npc.x, npc.y, rp.x, rp.y) / TILE_SIZE;
      if (dist >= 12) continue;
      nearbyThreats.push({
        id: rp.playerId,
        type: 'player',
        name: rp.playerId,
        distance: parseFloat(dist.toFixed(1)),
      });
    }
    for (const rnpc of Object.values(scene._remoteNPCSprites || {})) {
      if (rnpc.isDead?.()) continue;
      const threatKey = `npc:${rnpc.npcId}`;
      if (!recentThreats[threatKey]) continue;
      const dist = Phaser.Math.Distance.Between(npc.x, npc.y, rnpc.x, rnpc.y) / TILE_SIZE;
      if (dist >= 12) continue;
      nearbyThreats.push({
        id: `${rnpc.ownerPid}_${rnpc.npcId}`,
        npc_id: rnpc.npcId,
        type: 'enemy_npc',
        name: rnpc.getName(),
        owner: rnpc.ownerPid,
        distance: parseFloat(dist.toFixed(1)),
      });
    }

    // Nearby trees (un-chopped)
    let nearbyTrees = 0;
    for (const tree of (scene.trees ?? [])) {
      if (tree._chopped) continue;
      const dist = Phaser.Math.Distance.Between(npc.x, npc.y, tree.x, tree.y) / TILE_SIZE;
      if (dist < 10) nearbyTrees++;
    }

    // Nearby mineable world objects (ores)
    const nearbyOres = [];
    for (const [woId, wo] of Object.entries(scene._worldObjSprites || {})) {
      if (!wo || wo._depleted) continue;
      const dist = Phaser.Math.Distance.Between(npc.x, npc.y, wo.x, wo.y) / TILE_SIZE;
      if (dist < 12) {
        nearbyOres.push({ id: woId, asset_id: wo._assetId || 'ore', distance: parseFloat(dist.toFixed(1)) });
      }
    }

    // Nearby crates (for depositing)
    const nearbyCrates = [];
    for (const crate of (scene._crates || [])) {
      const dist = Phaser.Math.Distance.Between(npc.x, npc.y, crate.x, crate.y) / TILE_SIZE;
      if (dist < 12) {
        nearbyCrates.push({ id: crate._serverId, label: crate.getLabel?.() || '', distance: parseFloat(dist.toFixed(1)), stored: crate.getStored?.() || {} });
      }
    }

    // Recent events — age them
    const now = Date.now();
    const recentEvents = this._recentEvents
      .map(e => ({
        type: e.type,
        text: e.text,
        age_ms: now - e.ts,
        importance: e.importance,
      }))
      .filter(e => e.age_ms < 30000); // only last 30s

    // Soul context
    const soul = npc.getSoulContext(playerId);

    // NPC-to-NPC relationships — summarize grudges/friendships with nearby NPCs
    const npcRelationships = {};
    for (const entity of nearbyEntities) {
      if (entity.type !== 'enemy_npc') continue;
      const relKey = `npc:${entity.npc_id || entity.id}`;
      const rel = npc.soul.relationships[relKey];
      if (rel) {
        npcRelationships[entity.id] = {
          name: entity.name,
          trust: rel.trust,
          anger: rel.anger,
          fear: rel.fear,
          label: rel.label,
        };
      }
      // Include relevant memories about this NPC (use bare npcId key)
      const memKey = `npc:${entity.npc_id || entity.id}`;
      const mems = npc.soul.memories[memKey];
      if (mems?.length > 0) {
        npcRelationships[entity.id] = npcRelationships[entity.id] || { name: entity.name };
        npcRelationships[entity.id].memories = mems.slice(0, 3).map(m => m.text);
      }
    }

    // Build the packet
    return {
      mode: 'decision',
      npc: {
        id: npc.id,
        name: npc.getName(),
        personality: soul.personality,
        state: {
          hp: npc.hp,
          maxHp: npc.maxHp,
          str: npc.str,
          def: npc.def,
          level: npc.level,
          logs: npc.logs,
          maxLogs: npc.maxLogs,
          inventory: npc._npcInventory || {},
          stones: npc.stones || 0,
          status: currentCommand.type,
        },
        current_command: currentCommand,
        emotion: soul.emotional_state,
        relationship: soul.relationship,
        npc_relationships: npcRelationships,
        drives: npc.soul?.drives ? {
          aggression: +(npc.soul.drives.aggression ?? 0).toFixed(2),
          attachment: +(npc.soul.drives.attachment ?? 0).toFixed(2),
          curiosity:  +(npc.soul.drives.curiosity  ?? 0).toFixed(2),
          greed:      +(npc.soul.drives.greed      ?? 0).toFixed(2),
          social:     +(npc.soul.drives.social     ?? 0).toFixed(2),
          survival:   +(npc.soul.drives.survival   ?? 0).toFixed(2),
          ambition:   +(npc.soul.drives.ambition   ?? 0).toFixed(2),
        } : null,
      },
      player: {
        id: playerId,
        distance: parseFloat(playerDist.toFixed(1)),
        visible: true,
        hp: player?.hp ?? 0,
        maxHp: player?.maxHp ?? 0,
        logs: player?.logs ?? 0,
      },
      nearby_entities: nearbyEntities,
      nearby_threats: nearbyThreats,
      nearby_trees: nearbyTrees,
      nearby_ores: nearbyOres,
      nearby_crates: nearbyCrates,
      learned_phrases: soul.learned_phrases || [],
      recent_events: recentEvents,
      memory_summary: _summarizeMemories(soul.memories),
      allowed_actions: this._getAllowedActions(),
    };
  }

  _getAllowedActions() {
    const actions = [
      'follow', 'stay_near_player', 'defend_player', 'attack_enemy',
      'attack_player', 'attack_npc',
      'retreat', 'hold_position', 'observe', 'do_nothing',
      'gather_wood', 'give_logs', 'train', 'practice_ki',
      'socialize_npc', 'steal_logs',
    ];
    // Context-dependent actions — only offer if relevant entities exist
    const scene = this._scene;
    const hasOres = Object.values(scene._worldObjSprites || {}).some(wo => wo && !wo._depleted);
    const hasCrates = (scene._crates || []).length > 0;
    if (hasOres) actions.push('mine_ore');
    if (hasCrates) actions.push('deposit_to_crate');
    return actions;
  }

  // ── Request decision from local Ollama ──────────────────────────────────────

  async _requestDecision() {
    if (this._pending) return;
    const now = Date.now();

    // Backoff after repeated failures
    if (now < this._backoffUntil) return;

    // Periodic connectivity check — don't spam if Ollama is down
    if (this._ollamaDown || this._consecutiveFails >= 3) {
      if (now - this._lastConnCheck < 30000) return; // check at most every 30s
      this._lastConnCheck = now;
      const ok = await checkConnection();
      if (!ok) {
        this._ollamaDown = true;
        this._backoffUntil = now + 30000;
        return;
      }
      this._ollamaDown = false;
      this._consecutiveFails = 0;
    }

    this._pending = true;
    this._lastDecisionTime = now;

    try {
      const packet = this._buildStatePacket();
      const decision = await generateDecision(packet);
      if (decision) {
        this._applyDecision(decision);
        this._consecutiveFails = 0;
        this._backoffUntil = 0;
      } else {
        this._consecutiveFails++;
        const delay = Math.min(FAIL_BACKOFF_BASE_MS * Math.pow(2, this._consecutiveFails - 1), MAX_FAIL_BACKOFF_MS);
        this._backoffUntil = now + delay;
        console.warn(`[NPCBrain] No valid decision — backing off ${(delay / 1000).toFixed(0)}s (fail #${this._consecutiveFails})`);
      }
    } catch (e) {
      this._consecutiveFails++;
      const delay = Math.min(FAIL_BACKOFF_BASE_MS * Math.pow(2, this._consecutiveFails - 1), MAX_FAIL_BACKOFF_MS);
      this._backoffUntil = now + delay;
      console.warn(`[NPCBrain] Decision error — backing off ${(delay / 1000).toFixed(0)}s:`, e.message);
    } finally {
      this._pending = false;
    }
  }

  // ── Validate + apply decision ───────────────────────────────────────────────

  _applyDecision(raw) {
    const decision = this._validate(raw);
    const npc = this._npc;
    const playerId = this._scene.playerId;

    // Apply intent as task
    const intent = decision.primary_intent;
    // Don't interrupt give_logs — let the NPC finish delivering before reassigning
    const currentTasks = this._runner.getStatus().tasks;
    const isDelivering = currentTasks.some(t => t.task === 'give_logs');
    const isSocializing = currentTasks.some(t => t.task === 'socialize_npc');
    const isStealing = currentTasks.some(t => t.task === 'steal_logs');
    const isPracticingKi = currentTasks.some(t => t.task === 'practice_ki');
    const isRefining = currentTasks.some(t => t.task === 'refine_stone');
    const isDepositing = currentTasks.some(t => t.task === 'deposit_to_crate');
    if (isDelivering || isSocializing || isStealing || isPracticingKi || isRefining || isDepositing) {
      this._lastIntent = intent;
      this._lastDecision = decision;
      return;
    }
    if (intent !== this._lastIntent || !this._runner.getStatus().running) {
      if (intent === 'attack_player' && decision.target_id) {
        this._runner.setTasks([{ task: 'attack_player', target_id: decision.target_id }]);
      } else if ((intent === 'attack_npc' || intent === 'steal_logs' || intent === 'socialize_npc') && decision.target_id) {
        const scene = this._scene;
        // target_id is composite key "ownerPid_npcId" (e.g. "test2_npc_1")
        const rnpcEntry = scene._remoteNPCSprites?.[decision.target_id]
          || Object.values(scene._remoteNPCSprites || {}).find(
            r => r.npcId === decision.target_id || `${r.ownerPid}_${r.npcId}` === decision.target_id
          );
        if (rnpcEntry) {
          if (intent === 'steal_logs') {
            this._runner.setTasks([{
              task: 'steal_logs',
              target_owner: rnpcEntry.ownerPid,
              target_npc_id: rnpcEntry.npcId,
            }]);
          } else if (intent === 'socialize_npc') {
            this._runner.setTasks([{
              task: 'socialize_npc',
              target_owner: rnpcEntry.ownerPid,
              target_npc_id: rnpcEntry.npcId,
              target_name: rnpcEntry.getName?.() || rnpcEntry.npcId,
            }]);
          } else {
            this._runner.setTasks([{
              task: 'attack_npc',
              target_owner: rnpcEntry.ownerPid,
              target_npc_id: rnpcEntry.npcId,
            }]);
          }
        } else {
          this._runner.setTasks([{ task: 'defend_player' }]);
        }
      } else {
        const taskDef = INTENT_TO_TASK[intent];
        if (taskDef) {
          this._runner.setTasks([{ ...taskDef }]);
        }
      }
    }
    if (!['attack_player', 'attack_npc', 'attack_enemy', 'defend_player', 'retreat'].includes(intent)) {
      this._npc._manualCommandUntil = Date.now() + 8000;
      this._npc._emotionReactTarget = null;
    }
    this._lastIntent = intent;

    // Apply speech — but only if something actually changed (don't spam repeated lines)
    if (decision.speech && intent !== this._lastIntent) {
      npc.showBubble(decision.speech, 4000);
    }

    // Apply emotion deltas — toward player by default, toward target NPC if relevant
    if (decision.emotion_delta) {
      const clamped = {};
      for (const [key, val] of Object.entries(decision.emotion_delta)) {
        if (['trust', 'fear', 'anger'].includes(key)) {
          clamped[key] = Math.max(-EMOTION_DELTA_MAX, Math.min(EMOTION_DELTA_MAX, Number(val) || 0));
        }
      }
      if (Object.keys(clamped).length > 0) {
        // If the intent targets another NPC, apply emotions toward that NPC too
        const npcTargetIntents = ['steal_logs', 'socialize_npc', 'attack_npc'];
        if (npcTargetIntents.includes(intent) && decision.target_id) {
          // Extract bare npcId from composite key (e.g. "test2_npc_1" → "npc_1")
          const bareId = this._extractNpcId(decision.target_id);
          npc.applyEmotionDeltas(clamped, `npc:${bareId}`);
        } else {
          npc.applyEmotionDeltas(clamped, playerId);
        }
      }
    }

    // Process memory candidates — store under target NPC key if relevant
    const memoryBucket = (['steal_logs', 'socialize_npc', 'attack_npc'].includes(intent) && decision.target_id)
      ? `npc:${this._extractNpcId(decision.target_id)}`
      : playerId;

    if (decision.memory_candidates?.length > 0) {
      for (const mem of decision.memory_candidates.slice(0, 2)) {
        if (mem.importance >= 0.65 && mem.text) {
          // Check for duplicate-ish memories
          const existing = npc.soul.memories[memoryBucket] || [];
          const isDupe = existing.some(m =>
            m.text.toLowerCase().includes(mem.text.toLowerCase().slice(0, 20))
          );
          if (!isDupe) {
            npc.addMemory(mem.text, mem.type || 'observation', memoryBucket, mem.importance);
          }
        }
      }
    }

    this._lastDecision = decision;
    console.log(`[NPCBrain] ${npc.getName()}: ${intent} | ${decision.reason_summary}`);
  }

  _validate(raw) {
    const personalityType = this._npc.soul?.personality?.type || 'Pragmatist';
    const fallback = _makeFallbackResponse(personalityType);
    if (!raw || typeof raw !== 'object') return fallback;

    const out = { ...fallback };

    if (VALID_INTENTS.has(raw.primary_intent)) out.primary_intent = raw.primary_intent;
    if (raw.secondary_intent && VALID_INTENTS.has(raw.secondary_intent)) out.secondary_intent = raw.secondary_intent;
    if (typeof raw.target_id === 'string') out.target_id = raw.target_id;
    // Only use fallback speech if the LLM didn't provide a valid response at all.
    // If LLM returned null/empty speech intentionally, clear the fallback speech.
    if (typeof raw.speech === 'string' && raw.speech.length > 0) {
      out.speech = raw.speech.slice(0, 80);
    } else if (raw.primary_intent) {
      // LLM gave a valid intent but no speech — don't use fallback chatter
      out.speech = null;
    }

    if (raw.emotion_delta && typeof raw.emotion_delta === 'object') {
      out.emotion_delta = {};
      for (const key of ['trust', 'fear', 'anger']) {
        const v = Number(raw.emotion_delta[key]);
        out.emotion_delta[key] = isNaN(v) ? 0 : Math.max(-EMOTION_DELTA_MAX, Math.min(EMOTION_DELTA_MAX, v));
      }
    }

    if (Array.isArray(raw.memory_candidates)) {
      out.memory_candidates = raw.memory_candidates
        .filter(m => m && typeof m.text === 'string' && typeof m.importance === 'number')
        .slice(0, 2);
    }

    if (typeof raw.reason_summary === 'string') out.reason_summary = raw.reason_summary.slice(0, 200);

    if (typeof raw.decision_confidence === 'number') {
      out.decision_confidence = Math.max(0, Math.min(1, raw.decision_confidence));
      if (out.decision_confidence < 0.3) {
        // Low confidence — fall back to personality-specific default
        out.primary_intent = fallback.primary_intent;
        out.speech = fallback.speech;
      }
    }

    const hasThreats = this._getNearbyThreatCount() > 0;
    if (hasThreats) {
      if (out.secondary_intent === 'gather_wood') out.secondary_intent = null;
      if (!['retreat', 'defend_player'].includes(out.primary_intent)) {
        out.secondary_intent = null;
      }
    }

    return out;
  }

  _getNearbyThreatCount() {
    const scene = this._scene;
    const npc = this._npc;
    const recentThreats = scene?._recentThreats || {};
    let count = 0;

    for (const rp of Object.values(scene?._remotePlayers || {})) {
      if (rp.isDead?.()) continue;
      if (!recentThreats[`player:${rp.playerId}`]) continue;
      const dist = Phaser.Math.Distance.Between(npc.x, npc.y, rp.x, rp.y) / TILE_SIZE;
      if (dist < 12) count++;
    }
    for (const rnpc of Object.values(scene?._remoteNPCSprites || {})) {
      if (rnpc.isDead?.()) continue;
      if (!recentThreats[`npc:${rnpc.npcId}`]) continue;
      const dist = Phaser.Math.Distance.Between(npc.x, npc.y, rnpc.x, rnpc.y) / TILE_SIZE;
      if (dist < 12) count++;
    }

    return count;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _summarizeMemories(memories) {
  if (!memories || memories.length === 0) {
    return { self: 'I am a robot companion built by the player.', player: 'The player is my creator.' };
  }
  const recent = memories.slice(-5);
  return {
    self: 'I am a robot companion built by the player.',
    player: recent.join(' | ').slice(0, 200) || 'The player is my creator.',
  };
}
