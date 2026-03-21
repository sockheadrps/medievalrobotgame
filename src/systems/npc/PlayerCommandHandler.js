// PlayerCommandHandler.js — handles player text commands directed at an NPC.
// Extracted from NPCBrain.js. Receives (scene, npc, brain) in constructor.
//
// Responsibilities:
//   - Local pattern matching (instant shortcuts, no LLM)
//   - Named target resolution (attack/socialize/steal)
//   - LLM parseCommand round-trip for freeform input
//   - Drive compliance checks before dispatching tasks
//   - Vocabulary learning side-effect for all nearby local NPCs

import Phaser from 'phaser';
import { parseCommand } from '../../net/LLMClient.js';
import { DriveSystem } from '../DriveSystem.js';
import { extractLearnablePhrases } from '../../entities/NPC.js';

// ── Hard local patterns — resolved instantly without LLM ─────────────────────
// "stop" is the safety-valve override.
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

// ── Personality-flavored task acknowledgement lines ───────────────────────────
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

export function _getPersonalityTaskReply(personalityType, taskName) {
  const typeReplies = PERSONALITY_TASK_REPLIES[personalityType] || PERSONALITY_TASK_REPLIES.Pragmatist;
  return typeReplies[taskName] || typeReplies.gather || 'Got it.';
}

// ── Personality-specific fallback lines (shown as speech when falling back) ───
const FALLBACK_LINES = {
  Guardian:   ['Staying close.', 'I\'ll guard you.', 'Watching the area.'],
  Scout:      ['Looking around...', 'Hmm, what\'s over there?', 'Taking a look.'],
  Berserker:  ['Where\'s the fight?!', 'Come on!!', 'Who wants some?!'],
  Caretaker:  ['I\'m right here.', 'Staying near you.', 'Everything okay?'],
  Paranoid:   ['...staying close.', 'Don\'t trust this.', 'Something feels off.'],
  Pragmatist: ['Might as well gather.', 'Making myself useful.', 'No orders? I\'ll work.'],
};

export function _makeFallbackResponse(personalityType) {
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

export class PlayerCommandHandler {
  constructor(scene, npc, brain) {
    this._scene = scene;
    this._npc = npc;
    this._brain = brain;
  }

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
      this._brain.onPlayerCommand();
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
    const brain = this._brain;
    const normalized = commands || [];
    const now = Date.now();
    const primaryTask = normalized[0]?.task || null;

    brain._runner.setTasks(normalized);
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
    brain.onPlayerCommand();

    // Push command event for LLM context
    brain.pushEvent({
      type: 'command',
      text: `Player commanded: ${primaryTask || 'unknown'}`,
      importance: 0.9,
    });

    // Persist NPC state
    scene._saveNPC?.(npc);
  }

  // ── Target resolution helpers ─────────────────────────────────────────────

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
}
