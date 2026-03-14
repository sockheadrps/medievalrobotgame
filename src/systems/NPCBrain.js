// NPCBrain — LLM decision layer for NPC behavior.
// Calls the player's local Ollama directly for high-level intent decisions,
// then feeds validated commands to NPCTaskRunner.

import Phaser from 'phaser';
import { TILE_SIZE } from '../constants.js';
import { generateDecision, checkConnection } from '../net/LLMClient.js';

const DECISION_COOLDOWN_MS = 4000;  // minimum ms between LLM calls when triggered by events
const IDLE_REFRESH_MS      = 12000; // how often to re-decide when idle
const BUSY_REFRESH_MS      = 15000; // minimum ms between LLM calls when runner is busy
const MAX_FAIL_BACKOFF_MS  = 60000; // max backoff after repeated failures
const FAIL_BACKOFF_BASE_MS = 5000;  // initial backoff after a failure
const HP_DANGER_PCT        = 0.35; // trigger decision when HP drops below this
const EMOTION_DELTA_MAX    = 0.05; // max emotion shift per decision — small nudges only

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
  build_fence:      { task: 'build_fence' },
  light_campfire:   { task: 'light_campfire' },
  guard_fire:       { task: 'guard_fire' },
  train:            { task: 'train' },
  learn_ki:         { task: 'learn_ki' },
  show_blast:       { task: 'show_blast' },
  practice_ki:      { task: 'practice_ki' },
  pickup_stone:     { task: 'pickup_stone' },
  refine_stone:     { task: 'refine_stone' },
  give_materials:   { task: 'give_materials' },
  meditate:         { task: 'meditate' },
  socialize_npc:    null, // handled specially — needs target info
  steal_logs:       null, // handled specially — needs target info
};

const VALID_INTENTS = new Set(Object.keys(INTENT_TO_TASK));

const FALLBACK_RESPONSE = {
  primary_intent: 'follow',
  secondary_intent: null,
  target_id: null,
  speech: null,
  emotion_delta: { trust: 0, fear: 0, anger: 0 },
  memory_candidates: [],
  reason_summary: 'Fallback: following player.',
};

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
    this._lastDecisionTime = Date.now();
  }

  /** Extract bare npcId from composite key. "test2_npc_1" → "npc_1", "npc_1" → "npc_1" */
  _extractNpcId(compositeKey) {
    const match = compositeKey.match(/(npc_\d+)$/);
    return match ? match[1] : compositeKey;
  }

  /** Called every frame from GameScene. */
  update(delta) {
    if (!this._enabled || this._npc.isDead() || this._npc.meditating || this._pending) return;

    const now = Date.now();
    const elapsed = now - this._lastDecisionTime;

    // Check triggers
    let shouldDecide = false;
    const status = this._runner.getStatus();
    const isBusy = status.running;

    // If runner is busy, use a longer cooldown to avoid spamming LLM with the same decision
    const minCooldown = isBusy ? BUSY_REFRESH_MS : DECISION_COOLDOWN_MS;

    // 1. Event-triggered (combat, player command, etc.)
    if (this._eventQueue.length > 0) {
      shouldDecide = elapsed >= minCooldown;
      if (shouldDecide) this._eventQueue.length = 0;
    }

    // 2. HP dropped below danger threshold — always use short cooldown for danger
    const hpPct = this._npc.hp / this._npc.maxHp;
    if (hpPct < HP_DANGER_PCT && this._lastHpPct >= HP_DANGER_PCT) {
      shouldDecide = elapsed >= DECISION_COOLDOWN_MS;
    }
    this._lastHpPct = hpPct;

    // 3. Task runner finished all tasks (NPC is idle) — needs new orders
    if (!isBusy && elapsed >= IDLE_REFRESH_MS) {
      shouldDecide = true;
    }

    if (shouldDecide) {
      this._requestDecision();
    }
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
          status: currentCommand.type,
        },
        current_command: currentCommand,
        emotion: soul.emotional_state,
        relationship: soul.relationship,
        npc_relationships: npcRelationships,
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
      learned_phrases: soul.learned_phrases || [],
      recent_events: recentEvents,
      memory_summary: _summarizeMemories(soul.memories),
      allowed_actions: this._getAllowedActions(),
    };
  }

  _getAllowedActions() {
    return [
      'follow', 'stay_near_player', 'defend_player', 'attack_enemy',
      'attack_player', 'attack_npc',
      'retreat', 'hold_position', 'observe', 'do_nothing',
      'gather_wood', 'give_logs', 'build_fence', 'light_campfire', 'guard_fire', 'train',
      'learn_ki', 'socialize_npc', 'steal_logs',
    ];
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
    const isLearningKi = currentTasks.some(t => t.task === 'learn_ki');
    const isPracticingKi = currentTasks.some(t => t.task === 'practice_ki');
    const isRefining = currentTasks.some(t => t.task === 'refine_stone');
    if (isDelivering || isSocializing || isStealing || isLearningKi || isPracticingKi || isRefining) {
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
    this._lastIntent = intent;

    // Apply speech
    if (decision.speech) {
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
    if (!raw || typeof raw !== 'object') return { ...FALLBACK_RESPONSE };

    const out = { ...FALLBACK_RESPONSE };

    if (VALID_INTENTS.has(raw.primary_intent)) out.primary_intent = raw.primary_intent;
    if (raw.secondary_intent && VALID_INTENTS.has(raw.secondary_intent)) out.secondary_intent = raw.secondary_intent;
    if (typeof raw.target_id === 'string') out.target_id = raw.target_id;
    if (typeof raw.speech === 'string' && raw.speech.length > 0) out.speech = raw.speech.slice(0, 80);

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
        out.primary_intent = 'follow';
        out.speech = null;
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
