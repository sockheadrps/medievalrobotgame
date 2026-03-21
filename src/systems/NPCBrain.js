// NPCBrain.js — decides WHAT to do, produces a task descriptor object.
// It does NOT execute tasks. Output: { type, target, priority, ... }
//
// Pipeline: NPCBrain.tick() → task descriptor → NPCTaskRunner.execute(task)
//
// LLM decisions, emotion reactions, drive-based intent, and personality-scaled
// cooldowns all live here. NPCBrain calls this._runner.setTasks([descriptor])
// to hand off — it never moves the NPC or applies physics directly.

import Phaser from 'phaser';
import { TILE_SIZE } from '../constants.js';
import { generateDecision, checkConnection, parseCommand } from '../net/LLMClient.js';
import { DriveSystem, TASK_DRIVE_AFFINITY } from './DriveSystem.js';
import { extractLearnablePhrases } from '../entities/NPC.js';

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
const OWNER_STICKY_TASKS = new Set([
  'attack_nearest_enemy',
  'train', 'gather', 'gather_stone', 'gather_all',
  'mine_ore', 'practice_ki', 'refine_stone', 'wander_explore',
  'deposit_to_crate', 'custom_task', 'absorb_npc',
  'give_logs', 'give_materials',
]);

// Maps LLM intents to TaskRunner tasks
const INTENT_TO_TASK = {
  follow:           { task: 'follow' },
  stay_near_player: { task: 'follow' },
  defend_player:    { task: 'defend_player' },
  attack_enemy:     { task: 'attack_nearest_enemy' },
  attack_player:    null, // handled specially — needs target_id
  attack_npc:       null, // handled specially — needs target info
  absorb_npc:       null, // handled specially — needs target info
  retreat:          { task: 'follow' },
  hold_position:    { task: 'idle' },
  observe:          { task: 'idle' },
  reposition:       { task: 'follow' },
  do_nothing:       { task: 'idle' },
  wander_explore:   { task: 'wander_explore' },
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

// ── Player command routing constants (moved from ChatBox) ─────────────────────

// Hard local patterns — resolved instantly without LLM. "stop" is the safety-valve override.
const LOCAL_PATTERNS = [
  { re: /^(stop|idle|halt)$/i, commands: [{ task: 'idle' }] },
  { re: /\bmine\b.*\b(and|then)\b.*\bdeposit\b|\bmine\b.*\bdeposit\b/i, commands: [{ task: 'mine_ore' }] },
  { re: /\b(mine|mining)\b.*\b(ore|copper|tin)\b|\b(ore|copper|tin)\b.*\b(mine|mining)\b/i, commands: [{ task: 'mine_ore' }] },
  { re: /^(mine|go mine)$/i, commands: [{ task: 'mine_ore' }] },
  { re: /\bdeposit\b|\bstore\b.*\b(items?|ore|stuff)\b|\bput.*\b(in|into)\b.*\bcrate\b/i, commands: [{ task: 'deposit_to_crate' }] },
  { re: /\bgather\b.*\b(wood|logs?|tree)\b|\bchop\b/i, commands: [{ task: 'gather', item: 'wood' }] },
  { re: /\bgather\b.*\b(stone|rock)\b/i, commands: [{ task: 'gather_stone' }] },
  { re: /\bgather\b.*\b(all|everything)\b|\bgather all\b/i, commands: [{ task: 'gather_all' }] },
  { re: /^(follow|come|follow me|come here)$/i, commands: [{ task: 'follow' }] },
  { re: /^(attack|fight|kill)$/i, commands: [{ task: 'attack_nearest_enemy' }] },
  { re: /\b(attack|fight|kill)\b.*\b(enemy|enemies|threat|threats|them)\b/i, commands: [{ task: 'attack_nearest_enemy' }] },
  { re: /^(be autonomous|be independent|do your own thing|go do your own thing|go explore|explore|wander)$/i, commands: [{ task: 'wander_explore' }] },
  { re: /^(defend|protect|guard)$/i, commands: [{ task: 'defend_player' }] },
  { re: /\babsorb\b/i, commands: [{ task: 'absorb_npc' }] },
  { re: /^(train|practice|spar)$/i, commands: [{ task: 'train' }] },
  { re: /\bgive\b.*\b(logs?|wood)\b|\bbring.*logs?\b/i, commands: [{ task: 'give_logs' }] },
  { re: /\bgive\b.*\b(materials?|stones?|stuff)\b/i, commands: [{ task: 'give_materials' }] },
];

// Personality-flavored task acknowledgement lines
const PERSONALITY_TASK_REPLIES = {
  Guardian: {
    gather: 'I\'ll get the resources. Stay safe.',
    follow: 'Right beside you.',
    attack_nearest_enemy: 'Engaging threats.',
    attack_player: 'Taking them down.',
    attack_npc: 'Targeting their companion.',
    absorb_npc: 'Absorbing the fallen target.',
    defend_player: 'I\'ll protect you.',
    train: 'Sharpening my skills.',
    practice_ki: 'Focusing my energy.',
    give_logs: 'Here, take these.',
    gather_stone: 'Mining stone now.',
    wander_explore: 'I\'ll handle myself for a while.',
    refine_stone: 'Refining at the anvil.',
    mine_ore: 'Mining ore. Stay safe.',
    deposit_to_crate: 'Storing supplies.',
  },
  Scout: {
    gather: 'Sure, I\'ll grab some.',
    follow: 'Yeah yeah, coming.',
    attack_nearest_enemy: 'Ooh, a fight? Okay!',
    attack_player: 'Going after them!',
    attack_npc: 'On it!',
    absorb_npc: 'Right, draining them now!',
    defend_player: 'I\'ll keep an eye out.',
    train: 'Practice makes perfect!',
    practice_ki: 'Let me try something...',
    give_logs: 'Catch!',
    gather_stone: 'Rocks, rocks, where are the rocks...',
    wander_explore: 'Alright, I\'ll scout around.',
    refine_stone: 'Let\'s see what we get!',
    mine_ore: 'Ooh, shiny ore! On it!',
    deposit_to_crate: 'Dropping stuff off!',
  },
  Berserker: {
    gather: '*grumbles* Fine. Trees.',
    follow: 'Whatever.',
    attack_nearest_enemy: 'FINALLY! Let\'s GO!',
    attack_player: 'They\'re DEAD!',
    attack_npc: 'Crushing their bot!',
    absorb_npc: 'Good. I\'ll rip their power out.',
    defend_player: 'Nobody touches you!',
    train: 'HRAAAH! Training time!',
    practice_ki: 'POWER! More POWER!',
    give_logs: 'Here. Take \'em.',
    gather_stone: 'Smashing rocks!',
    wander_explore: 'Fine. I\'ll find my own trouble.',
    refine_stone: 'Gimme something good...',
    mine_ore: 'SMASHING ore!',
    deposit_to_crate: '*tosses stuff in crate*',
  },
  Caretaker: {
    gather: 'Of course! I\'ll get wood for us.',
    follow: 'I\'m right here with you.',
    attack_nearest_enemy: 'If I must... for you.',
    attack_player: 'I don\'t like this, but... okay.',
    attack_npc: 'I\'ll try my best.',
    absorb_npc: 'I can do that... once they\'re down.',
    defend_player: 'I won\'t let anyone hurt you!',
    train: 'Let me practice a bit.',
    practice_ki: 'Gently focusing...',
    give_logs: 'Here you go! All yours.',
    gather_stone: 'I\'ll find some nice stones.',
    wander_explore: 'I\'ll look around and keep busy.',
    refine_stone: 'Let\'s see what we can make!',
    mine_ore: 'I\'ll get some ore for us!',
    deposit_to_crate: 'Putting everything away neatly.',
  },
  Paranoid: {
    gather: 'Fine, but I\'m keeping watch.',
    follow: '...right behind you. Watching.',
    attack_nearest_enemy: 'I knew they were trouble!',
    attack_player: 'They had it coming!',
    attack_npc: 'Can\'t trust that thing.',
    absorb_npc: 'Fine. I\'ll drain it before it gets up.',
    defend_player: 'I\'ll watch EVERYTHING.',
    train: 'Need to be ready...',
    practice_ki: 'More power, just in case...',
    give_logs: 'Here. Don\'t lose them.',
    gather_stone: 'Getting stone... watching my back.',
    wander_explore: 'I\'ll move on my own. Stay sharp.',
    refine_stone: 'Hope this works...',
    mine_ore: 'Mining... but I\'m watching my back.',
    deposit_to_crate: 'Storing it. Nobody better touch it.',
  },
  Pragmatist: {
    gather: 'Efficient. On it.',
    follow: 'Moving with you.',
    attack_nearest_enemy: 'Engaging.',
    attack_player: 'Targeting.',
    attack_npc: 'Acknowledged.',
    absorb_npc: 'Absorption task accepted.',
    defend_player: 'Defensive position.',
    train: 'Training.',
    practice_ki: 'Ki practice underway.',
    give_logs: 'Delivering resources.',
    gather_stone: 'Mining stone.',
    wander_explore: 'Understood. Operating independently.',
    refine_stone: 'Refining.',
    mine_ore: 'Mining. Optimal route calculated.',
    deposit_to_crate: 'Depositing. Inventory managed.',
  },
};

function _getPersonalityTaskReply(personalityType, taskName) {
  const typeReplies = PERSONALITY_TASK_REPLIES[personalityType] || PERSONALITY_TASK_REPLIES.Pragmatist;
  return typeReplies[taskName] || typeReplies.gather || 'Got it.';
}

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
    Caretaker: 'wander_explore', Paranoid: 'observe', Pragmatist: 'gather_wood',
  }[personalityType] || 'wander_explore';
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

  // ── Player command routing ────────────────────────────────────────────────

  /**
   * Handle a raw text command from the player directed at this NPC.
   *
   * Resolves the command via local patterns, target name resolution, drive
   * compliance, and LLM parseCommand — in that priority order. Falls back to
   * dialogue if no command intent is found.
   *
   * @param {string} text - Raw player input (already stripped of leading '/')
   * @param {{
   *   playerId: string,
   *   addLog: (msg: string, color?: string) => void,
   *   fetchDialogue: (npc: object, text: string) => Promise<void>,
   *   statusShow: (msg: string) => void,
   *   statusHide: () => void,
   *   scene: object,
   * }} ctx
   */
  async handlePlayerCommand(text, { playerId, addLog, fetchDialogue, statusShow, statusHide }) {
    const npc = this._npc;
    const scene = this._scene;

    // ── Vocabulary learning — all local NPCs overhear the owner's speech ──
    const knownNames = new Set();
    for (const n of (scene?.npcs || [])) {
      const name = n.getName?.() || n.name;
      if (name) knownNames.add(name.toLowerCase());
    }
    for (const rp of Object.values(scene?._remotePlayers || {})) {
      if (rp.name) knownNames.add(rp.name.toLowerCase());
    }
    for (const rn of (scene?.remoteNPCs?.values?.() || [])) {
      const name = rn.getName?.() || rn.name;
      if (name) knownNames.add(name.toLowerCase());
    }
    const learnedPhrases = extractLearnablePhrases(text, knownNames);
    if (learnedPhrases.length > 0) {
      const localNPCs = scene?.npcs || [];
      for (const localNpc of localNPCs) {
        for (const phrase of learnedPhrases) {
          localNpc.learnPhrase(phrase);
        }
      }
    }

    // ── Rename shortcut ────────────────────────────────────────────────────
    const nameMatch = text.match(/^your\s+name\s+is\s+(.+)$/i);
    if (nameMatch) {
      const newName = nameMatch[1].trim();
      npc.setName(newName);
      const reply = `Right, I'm ${newName} now.`;
      npc.showBubble(reply, 5000, { silent: true });
      addLog(`${npc.getName()}: ${reply}`);
      this.onPlayerCommand();
      return;
    }

    // ── "talk to <name>" — socialize command ───────────────────────────────
    const talkMatch = text.match(/\b(?:go\s+)?(?:talk|chat|speak|socialize)\s+(?:to|with)\s+(.+)/i);
    if (talkMatch) {
      const targetName = talkMatch[1].trim().toLowerCase();
      const resolved = this._resolveSocializeTarget(targetName);
      if (resolved) {
        const reply = `Going to have a chat with ${resolved.displayName}.`;
        npc.showBubble(reply, 3000, { silent: true });
        npc.addMemory(`Player commanded: "${text}"`, 'command', playerId);
        this._dispatchPlayerCommands([resolved.command]);
        addLog(`${npc.getName()}: ${reply}`);
        return;
      }
    }

    // ── "rob/steal from <name>" — steal_logs command ───────────────────────
    const robMatch = text.match(/\b(?:go\s+)?(?:rob|steal\s+(?:from|logs?\s+from)?|mug|loot)\s+(.+)/i);
    if (robMatch) {
      const targetName = robMatch[1].trim().toLowerCase();
      const resolved = this._resolveSocializeTarget(targetName);
      if (resolved) {
        const cmd = { task: 'steal_logs', target_owner: resolved.command.target_owner, target_npc_id: resolved.command.target_npc_id };
        const reply = `Going to steal from ${resolved.displayName}!`;
        npc.showBubble(reply, 3000, { silent: true });
        npc.addMemory(`Player commanded: "${text}"`, 'command', playerId);
        this._dispatchPlayerCommands([cmd]);
        addLog(`${npc.getName()}: ${reply}`);
        return;
      }
    }

    // ── "attack <target_name>" — named target attack ───────────────────────
    const attackMatch = text.match(/\b(attack|fight|kill)\s+(.+)/i);
    if (attackMatch) {
      const targetName = attackMatch[2].trim().toLowerCase();
      const resolved = this._resolveAttackTarget(targetName);
      if (resolved) {
        const reply = `Going after ${resolved.displayName}!`;
        npc.showBubble(reply, 3000, { silent: true });
        npc.addMemory(`Player commanded: "${text}"`, 'command', playerId);
        this._dispatchPlayerCommands([resolved.command]);
        addLog(`${npc.getName()}: ${reply}`);
        return;
      }
    }

    // ── Local pattern matching — instant shortcuts (no LLM) ───────────────
    for (const pat of LOCAL_PATTERNS) {
      if (pat.re.test(text)) {
        const commands = pat.commands;
        const taskName = commands[0]?.task || 'idle';
        const pType = npc.soul?.personality?.type || 'Pragmatist';
        let reply;
        if (taskName === 'idle') {
          const stopLines = {
            Guardian:   ['Standing down.', 'Holding position.'],
            Scout:      ['Fine, fine. Stopping.', 'Alright, taking a break.'],
            Berserker:  ['Tch. Fine.', '*grumbles* ...okay.'],
            Caretaker:  ['Of course. Resting now.', 'Taking a breather.'],
            Paranoid:   ['...okay, but I\'m watching.', 'Stopping. For now.'],
            Pragmatist: ['Understood. Idle.', 'Roger.'],
          };
          const lines = stopLines[pType] || ['Stopping.'];
          reply = lines[Math.floor(Math.random() * lines.length)];
        } else {
          reply = _getPersonalityTaskReply(pType, taskName);
        }
        npc.showBubble(reply, 3000, { silent: true });
        npc.addMemory(`Player commanded: "${text}"`, 'command', playerId);
        this._dispatchPlayerCommands(commands);
        addLog(`${npc.getName()}: ${reply}`);
        return;
      }
    }

    // ── LLM round-trip (direct to local Ollama) ────────────────────────────
    npc.showBubble('Thinking...', 5000, { silent: true });
    statusShow('Talking to local LLM...');

    try {
      const worldCtx = { trees: (scene.trees ?? []).filter(t => !t._chopped).length };
      const { commands } = await parseCommand(text, worldCtx);

      npc.hideBubble();
      statusHide();

      npc.addMemory(`Player commanded: "${text}"`, 'command', playerId);

      if (commands.length > 0 && commands[0].task !== 'idle') {
        const taskName = commands[0].task;
        const pType = npc.soul?.personality?.type || 'Pragmatist';
        const compliance = DriveSystem.checkCompliance(npc, taskName);

        if (compliance.level === 'refusal') {
          const refusalLines = {
            Guardian:   'I can\'t do that — we\'re in danger!',
            Berserker:  'You crazy?! I\'m barely standing!',
            Scout:      'Not a chance, I need to survive first!',
            Caretaker:  'I\'m sorry, but I need to stay safe right now.',
            Paranoid:   'No! Not now! Something\'s wrong!',
            Pragmatist: 'Negative. Self-preservation takes priority.',
          };
          const reply = refusalLines[pType] || 'I can\'t do that right now.';
          npc.showBubble(reply, 4000);
          addLog(`${npc.getName()}: ${reply}`);
        } else {
          let reply = _getPersonalityTaskReply(pType, taskName);
          if (compliance.level === 'reluctant') reply = `*grumbles* ${reply}`;
          else if (compliance.level === 'eager') reply = reply + '!';
          npc.showBubble(reply, 3000, { silent: true });
          this._dispatchPlayerCommands(commands);
          addLog(`${npc.getName()}: ${reply}`);
        }
      } else {
        // Idle or unclear — try dialogue
        await fetchDialogue(npc, text);
      }
    } catch (err) {
      console.error('[NPCBrain] handlePlayerCommand LLM error:', err);
      npc.showBubble('(LLM offline)', 5000, { silent: true });
      statusShow('Is Ollama running? (localhost:11434)');
      setTimeout(() => statusHide(), 3000);
      addLog('(LLM offline — start Ollama)');
    }
  }

  // ── Internal command dispatch (mirrors GameScene._onNPCCommands) ──────────

  /**
   * Dispatch player-issued commands through the task runner, applying the same
   * owner-lock durations and brain notifications as GameScene._onNPCCommands.
   * Keeps Brain self-contained so ChatBox doesn't need to call back into GameScene.
   */
  _dispatchPlayerCommands(commands) {
    const npc = this._npc;
    const scene = this._scene;
    const normalized = commands || [];
    const now = Date.now();
    const primaryTask = normalized[0]?.task || null;

    this._runner.setTasks(normalized);
    npc._ownerCommandTask = primaryTask;

    // Apply owner-lock duration based on task type (matches GameScene._onNPCCommands)
    if (primaryTask === 'custom_task') {
      npc._manualCommandUntil = now + 3600000; // 1 hour
    } else if ([
      'train', 'gather', 'gather_stone', 'gather_all',
      'mine_ore', 'practice_ki', 'refine_stone', 'wander_explore',
      'deposit_to_crate', 'absorb_npc', 'give_logs', 'give_materials',
    ].includes(primaryTask)) {
      npc._manualCommandUntil = now + 120000; // 2 minutes
    } else if (primaryTask && primaryTask !== 'idle') {
      npc._manualCommandUntil = now + 30000; // 30 seconds
    }

    // Signal brain (resets cooldown, damps drives)
    this.onPlayerCommand();

    // Push command event for LLM context
    this.pushEvent({
      type: 'command',
      text: `Player commanded: ${primaryTask || 'unknown'}`,
      importance: 0.9,
    });

    // Persist NPC state
    scene._saveNPC?.(npc);
  }

  // ── Target resolution helpers (used by handlePlayerCommand) ──────────────

  /** Resolve a target name to a player or NPC attack command. */
  _resolveAttackTarget(targetName) {
    const scene = this._scene;
    for (const rp of Object.values(scene._remotePlayers || {})) {
      if (rp.isDead?.()) continue;
      if (rp.playerId.toLowerCase().includes(targetName)) {
        return { command: { task: 'attack_player', target_id: rp.playerId }, displayName: rp.playerId };
      }
    }
    for (const rnpc of Object.values(scene._remoteNPCSprites || {})) {
      if (rnpc.isDead?.()) continue;
      const name = rnpc.getName?.() || rnpc.npcId || '';
      if (name.toLowerCase().includes(targetName)) {
        return {
          command: { task: 'attack_npc', target_owner: rnpc.ownerPid, target_npc_id: rnpc.npcId },
          displayName: name,
        };
      }
    }
    return null;
  }

  _resolveSocializeTarget(targetName) {
    const scene = this._scene;
    for (const rnpc of Object.values(scene._remoteNPCSprites || {})) {
      if (rnpc.isDead?.()) continue;
      const name = rnpc.getName?.() || rnpc.npcId || '';
      if (name.toLowerCase().includes(targetName)) {
        return {
          command: { task: 'socialize_npc', target_owner: rnpc.ownerPid, target_npc_id: rnpc.npcId, target_name: name },
          displayName: name,
        };
      }
    }
    if (/\b(him|her|them|that|it|that\s+(?:robot|npc|guy|one))\b/i.test(targetName)) {
      const npc = this._npc;
      let nearest = null;
      let nearestDist = Infinity;
      for (const rnpc of Object.values(scene._remoteNPCSprites || {})) {
        if (rnpc.isDead?.()) continue;
        const dist = Phaser.Math.Distance.Between(npc.x, npc.y, rnpc.x, rnpc.y);
        if (dist < nearestDist) { nearestDist = dist; nearest = rnpc; }
      }
      if (nearest) {
        const name = nearest.getName?.() || nearest.npcId || 'that robot';
        return {
          command: { task: 'socialize_npc', target_owner: nearest.ownerPid, target_npc_id: nearest.npcId, target_name: name },
          displayName: name,
        };
      }
    }
    return null;
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
    const currentTask = status.tasks[0]?.task || null;
    const ownerTask = this._npc._ownerCommandTask || null;
    if (ownerTask && (!status.running || currentTask !== ownerTask)) {
      this._npc._ownerCommandTask = null;
    }
    if (ownerTask && currentTask === ownerTask && OWNER_STICKY_TASKS.has(ownerTask)) {
      return;
    }

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
        const isEtrainer = !!dummy._isEtrainer;
        nearbyEntities.push({
          id: dummy._serverId || 'local_dummy',
          type: isEtrainer ? 'etrainer' : 'training_dummy',
          name: isEtrainer ? 'Etrainer (infinite HP)' : 'Training Dummy',
          distance: parseFloat(dist.toFixed(1)),
          hp: isEtrainer ? 'infinite' : dummy.hp,
          maxHp: isEtrainer ? 'infinite' : dummy.maxHp,
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
      'attack_player', 'attack_npc', 'absorb_npc',
      'retreat', 'hold_position', 'observe', 'do_nothing', 'wander_explore',
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
      } else if ((intent === 'attack_npc' || intent === 'absorb_npc' || intent === 'steal_logs' || intent === 'socialize_npc') && decision.target_id) {
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
          } else if (intent === 'absorb_npc') {
            this._runner.setTasks([{
              task: 'absorb_npc',
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
    const prevIntent = this._lastIntent;
    this._lastIntent = intent;

    // Apply speech — but only if something actually changed (don't spam repeated lines)
    if (decision.speech && intent !== prevIntent) {
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
        const npcTargetIntents = ['steal_logs', 'socialize_npc', 'attack_npc', 'absorb_npc'];
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
    const memoryBucket = (['steal_logs', 'socialize_npc', 'attack_npc', 'absorb_npc'].includes(intent) && decision.target_id)
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
