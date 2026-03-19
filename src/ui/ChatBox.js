// ChatBox — bottom-of-screen chat input + persistent chat log.
// Press Enter to open, type, Enter to send, Escape to cancel.
// LLM calls go directly to the player's local Ollama — no server round-trip.

import Phaser from 'phaser';
import { parseCommand, generateDialogue } from '../net/LLMClient.js';
import { extractLearnablePhrases } from '../entities/NPC.js';
import { DriveSystem } from '../systems/DriveSystem.js';

const MAX_LOG_LINES = 80;
const LOG_PAD = 12;
const LOG_FONT_SIZE = 18;

// Only "stop" is kept as a hard local pattern — everything else routes through the LLM
// so NPC personality can shape the response. This is the safety-valve override.
const LOCAL_PATTERNS = [
  { re: /^(stop|idle|halt)$/i, commands: [{ task: 'idle' }], reply: null },
  { re: /\bmine\b.*\b(and|then)\b.*\bdeposit\b|\bmine\b.*\bdeposit\b/i, commands: [{ task: 'mine_ore' }], reply: null },  // "mine and deposit" — mine_ore auto-chains to deposit when full
  { re: /\b(mine|mining)\b.*\b(ore|copper|tin)\b|\b(ore|copper|tin)\b.*\b(mine|mining)\b/i, commands: [{ task: 'mine_ore' }], reply: null },
  { re: /^(mine|go mine)$/i, commands: [{ task: 'mine_ore' }], reply: null },
  { re: /\bdeposit\b|\bstore\b.*\b(items?|ore|stuff)\b|\bput.*\b(in|into)\b.*\bcrate\b/i, commands: [{ task: 'deposit_to_crate' }], reply: null },
  { re: /\bgather\b.*\b(wood|logs?|tree)\b|\bchop\b/i, commands: [{ task: 'gather', item: 'wood' }], reply: null },
  { re: /\bgather\b.*\b(stone|rock)\b/i, commands: [{ task: 'gather_stone' }], reply: null },
  { re: /\bgather\b.*\b(all|everything)\b|\bgather all\b/i, commands: [{ task: 'gather_all' }], reply: null },
  { re: /^(follow|come|follow me|come here)$/i, commands: [{ task: 'follow' }], reply: null },
  { re: /^(defend|protect|guard)$/i, commands: [{ task: 'defend_player' }], reply: null },
  { re: /^(train|practice|spar)$/i, commands: [{ task: 'train' }], reply: null },
  { re: /\bgive\b.*\b(logs?|wood)\b|\bbring.*logs?\b/i, commands: [{ task: 'give_logs' }], reply: null },
  { re: /\bgive\b.*\b(materials?|stones?|stuff)\b/i, commands: [{ task: 'give_materials' }], reply: null },
];

// Personality-flavored task acknowledgement lines
const PERSONALITY_TASK_REPLIES = {
  Guardian: {
    gather: 'I\'ll get the resources. Stay safe.',
    follow: 'Right beside you.',
    attack_nearest_enemy: 'Engaging threats.',
    attack_player: 'Taking them down.',
    attack_npc: 'Targeting their companion.',
    defend_player: 'I\'ll protect you.',
    train: 'Sharpening my skills.',
    practice_ki: 'Focusing my energy.',
    give_logs: 'Here, take these.',
    gather_stone: 'Mining stone now.',
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
    defend_player: 'I\'ll keep an eye out.',
    train: 'Practice makes perfect!',
    practice_ki: 'Let me try something...',
    give_logs: 'Catch!',
    gather_stone: 'Rocks, rocks, where are the rocks...',
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
    defend_player: 'Nobody touches you!',
    train: 'HRAAAH! Training time!',
    practice_ki: 'POWER! More POWER!',
    give_logs: 'Here. Take \'em.',
    gather_stone: 'Smashing rocks!',
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
    defend_player: 'I won\'t let anyone hurt you!',
    train: 'Let me practice a bit.',
    practice_ki: 'Gently focusing...',
    give_logs: 'Here you go! All yours.',
    gather_stone: 'I\'ll find some nice stones.',
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
    defend_player: 'I\'ll watch EVERYTHING.',
    train: 'Need to be ready...',
    practice_ki: 'More power, just in case...',
    give_logs: 'Here. Don\'t lose them.',
    gather_stone: 'Getting stone... watching my back.',
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
    defend_player: 'Defensive position.',
    train: 'Training.',
    practice_ki: 'Ki practice underway.',
    give_logs: 'Delivering resources.',
    gather_stone: 'Mining stone.',
    refine_stone: 'Refining.',
    mine_ore: 'Mining. Optimal route calculated.',
    deposit_to_crate: 'Depositing. Inventory managed.',
  },
};

function _getPersonalityTaskReply(personalityType, taskName) {
  const typeReplies = PERSONALITY_TASK_REPLIES[personalityType] || PERSONALITY_TASK_REPLIES.Pragmatist;
  return typeReplies[taskName] || typeReplies.gather || 'Got it.';
}

/** Format emotion deltas into a compact display string. Returns '' if no meaningful changes. */
function _formatDeltas(deltas) {
  if (!deltas) return '';
  const names = { trust: 'Trust', fear: 'Fear', anger: 'Anger' };
  const parts = [];
  for (const [key, val] of Object.entries(deltas)) {
    const n = Number(val);
    if (!n || Math.abs(n) < 0.005) continue;
    const sign = n > 0 ? '+' : '';
    parts.push(`${names[key] ?? key} ${sign}${n.toFixed(2)}`);
  }
  return parts.length > 0 ? `[${parts.join(', ')}]` : '';
}

export class ChatBox {
  constructor(scene, getSelectedNPC, onCommands, selectNPC, getPlayerId) {
    this._scene          = scene;
    this._getSelectedNPC = getSelectedNPC;
    this._onCommands     = onCommands;
    this._selectNPC      = selectNPC ?? (() => {});
    this._getPlayerId    = getPlayerId ?? (() => 'default');
    this._open           = false;
    this._input          = '';
    this._closedAt       = 0;
    this._chatLog        = [];  // { text, color }
    this._chatHistory    = new Map();  // npcId → [{ role: 'player'|'npc', text }] (recent conversation turns)
    this._history        = [];  // past commands
    this._historyIdx     = -1;  // -1 = not browsing history
    this._historyDraft   = '';  // saves current input when browsing

    const hud = (obj) => scene.addHud(obj);
    this._hud = hud;

    const W = scene.scale?.width ?? scene.cameras.main.width;
    const H = scene.scale?.height ?? scene.cameras.main.height;

    // ── Chat log panel (always visible, bottom-left) ──────────────────────────
    const INPUT_BAR_H = 54;
    const logW = Math.min(780, W - 24);
    const logH = 240;
    const logX = 10;
    const logBottom = H - INPUT_BAR_H;  // above the input bar, flush to bottom
    const logTop = logBottom - logH;
    this._logW = logW;
    this._logH = logH;
    this._logX = logX;
    this._logYTop = logTop;
    this._logBottom = logBottom;
    this._textW = logW - LOG_PAD * 2;

    // Semi-transparent background with subtle border
    this._logBg = hud(scene.add.rectangle(logX, logTop, logW, logH, 0x0a0a18, 0.7)
      .setDepth(49).setOrigin(0, 0));
    const border = hud(scene.add.rectangle(logX, logTop, logW, logH)
      .setDepth(49).setOrigin(0, 0).setStrokeStyle(1, 0x334466, 0.5));
    this._logBorder = border;

    // Mask to clip text within the log area
    const maskGfx = scene.make.graphics({ x: 0, y: 0, add: false });
    maskGfx.fillStyle(0xffffff);
    maskGfx.fillRect(logX, logTop, logW, logH);
    this._logMask = maskGfx.createGeometryMask();

    // Text objects pool — created on demand, positioned bottom-up
    this._logTextObjs = [];

    // ── Input bar (shown when open) ───────────────────────────────────────────
    const inputY = H - INPUT_BAR_H / 2;
    this._bg = hud(scene.add.rectangle(W / 2, inputY, W - 20, INPUT_BAR_H, 0x0a0a18, 0.88)
      .setDepth(50).setOrigin(0.5, 0.5).setVisible(false));
    this._inputBorder = hud(scene.add.rectangle(W / 2, inputY, W - 20, INPUT_BAR_H)
      .setDepth(50).setOrigin(0.5, 0.5).setStrokeStyle(1, 0x446688, 0.6).setVisible(false));

    this._label = hud(scene.add.text(32, inputY, 'Say:', {
      fontSize: '20px', color: '#6699cc', fontStyle: 'bold',
    }).setDepth(51).setOrigin(0, 0.5).setVisible(false));

    this._text = hud(scene.add.text(95, inputY, '', {
      fontSize: '20px', color: '#e0e0e0',
    }).setDepth(51).setOrigin(0, 0.5).setVisible(false));

    this._cursor = hud(scene.add.text(95, inputY, '|', {
      fontSize: '20px', color: '#88bbee',
    }).setDepth(51).setOrigin(0, 0.5).setVisible(false));
    scene.time.addEvent({ delay: 500, loop: true, callback: () => {
      if (this._open) this._cursor.setVisible(!this._cursor.visible);
    }});

    this._status = hud(scene.add.text(W / 2, logBottom - 6, '', {
      fontSize: '16px', color: '#ffcc44', backgroundColor: '#00000099',
      padding: { x: 8, y: 4 },
    }).setDepth(51).setOrigin(0.5, 1).setVisible(false));

    this._hint = hud(scene.add.text(W / 2, H - INPUT_BAR_H - 6, 'Select a target (click) then press Enter to chat', {
      fontSize: '15px', color: '#667788',
    }).setDepth(51).setOrigin(0.5, 1).setVisible(false));

    scene.input.keyboard.on('keydown', this._onKey, this);
  }

  isOpen() { return this._open; }

  /** Add a line to the persistent chat log. */
  _addLog(text, color = '#cccccc') {
    console.log(`[Chat] ${text}`);
    this._chatLog.push({ text, color });
    if (this._chatLog.length > MAX_LOG_LINES) this._chatLog.shift();
    this._refreshLog();
  }

  _refreshLog() {
    // Destroy old text objects
    for (const obj of this._logTextObjs) obj.destroy();
    this._logTextObjs = [];

    const hud = this._hud;
    const entries = this._chatLog;
    if (entries.length === 0) return;

    // Build text objects bottom-up until we fill the visible area
    let y = this._logBottom - LOG_PAD;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      const t = hud(this._scene.add.text(this._logX + LOG_PAD, 0, e.text, {
        fontSize: `${LOG_FONT_SIZE}px`,
        fontFamily: 'Consolas, monospace',
        color: e.color,
        wordWrap: { width: this._textW, useAdvancedWrap: true },
        lineSpacing: 2,
      }).setDepth(50).setOrigin(0, 1));
      t.setMask(this._logMask);
      t.setY(y);
      this._logTextObjs.push(t);
      y -= t.height + 3;
      if (y < this._logYTop - 40) break; // stop once we've gone past visible + buffer
    }
  }

  open() {
    // Prevent reopening immediately after closing (same Enter keypress)
    if (Date.now() - this._closedAt < 100) return;
    const npc = this._getSelectedNPC();
    if (!npc) { this._showHint(); return; }
    this._open = true;
    this._input = '';
    this._historyIdx = -1;
    this._setVisible(true);
    this._refresh();
  }

  _onKey(event) {
    if (!this._open) return;

    // Stop propagation so game keys don't fire
    event.stopPropagation();

    if (event.key === 'Escape') { this._closeAndDeselect(); return; }
    if (event.key === 'Enter')  { this._submit(); return; }
    if (event.key === 'ArrowUp') {
      if (this._history.length === 0) return;
      if (this._historyIdx === -1) this._historyDraft = this._input;
      this._historyIdx = Math.min(this._historyIdx + 1, this._history.length - 1);
      this._input = this._history[this._history.length - 1 - this._historyIdx];
      this._refresh();
      return;
    }
    if (event.key === 'ArrowDown') {
      if (this._historyIdx <= -1) return;
      this._historyIdx--;
      this._input = this._historyIdx === -1
        ? this._historyDraft
        : this._history[this._history.length - 1 - this._historyIdx];
      this._refresh();
      return;
    }
    if (event.key === 'Backspace') {
      this._input = this._input.slice(0, -1);
      this._refresh();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'v') {
      navigator.clipboard.readText().then(text => {
        this._input += text.replace(/[\r\n]+/g, ' ');
        this._refresh();
      }).catch(() => {});
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
      this._input += event.key;
      this._refresh();
    }
  }

  _refresh() {
    this._text.setText(this._input);
    this._cursor.setX(this._text.x + this._text.width + 2);
  }

  async _submit() {
    const text = this._input.trim();
    if (!text) { this._closeAndDeselect(); return; }

    // Save to history (avoid consecutive duplicates)
    if (this._history.length === 0 || this._history[this._history.length - 1] !== text) {
      this._history.push(text);
      if (this._history.length > 50) this._history.shift();
    }
    this._historyIdx = -1;

    // Slash commands — admin commands handled separately, NPC shortcuts stripped and re-routed
    if (text.startsWith('/')) {
      const slashWord = text.slice(1).trim().split(/\s+/)[0]?.toLowerCase();
      const NPC_SLASH_CMDS = ['mine', 'deposit', 'store', 'gather', 'chop', 'follow', 'stop', 'idle', 'defend', 'guard', 'train', 'attack'];
      if (NPC_SLASH_CMDS.includes(slashWord)) {
        // Strip the '/' and continue as normal NPC chat command
        text = text.slice(1).trim();
      } else {
        this._close();
        this._handleSlashCommand(text);
        return;
      }
    }

    const npc = this._getSelectedNPC();
    if (!npc) { this._close(); return; }

    this._close();

    // All local NPCs overhear everything the owner says — learn phrases.
    // Phrases said to others (remote targets) are weighted more strongly
    // because the NPC is picking up how the owner talks to the world.
    const isRemote = !npc.getSoulContext;
    // Gather known entity names so they get stripped from learned phrases
    const knownNames = new Set();
    for (const n of (this._scene?.npcs || [])) {
      const name = n.getName?.() || n.name;
      if (name) knownNames.add(name.toLowerCase());
    }
    for (const rp of (this._scene?.remotePlayers?.values?.() || [])) {
      if (rp.name) knownNames.add(rp.name.toLowerCase());
    }
    for (const rn of (this._scene?.remoteNPCs?.values?.() || [])) {
      const name = rn.getName?.() || rn.name;
      if (name) knownNames.add(name.toLowerCase());
    }
    const learnedPhrases = extractLearnablePhrases(text, knownNames);
    if (learnedPhrases.length > 0) {
      const localNPCs = this._scene?.npcs || [];
      const reps = isRemote ? 3 : 1; // overheard speech = 3x weight
      for (const localNpc of localNPCs) {
        for (const phrase of learnedPhrases) {
          for (let i = 0; i < reps; i++) localNpc.learnPhrase(phrase);
        }
      }
    }

    // If this is a remote entity (no getSoulContext), relay through server
    if (isRemote) {
      const targetName = npc.getName?.() || npc.playerId || 'them';
      this._addLog(`You → ${targetName}: ${text}`, '#ffddaa');
      this._scene.player?.showBubble?.(`→ ${targetName}: ${text}`, 4000);

      const conn = this._scene._conn;
      if (conn?.connected) {
        if (npc.ownerPid && npc.npcId) {
          // Remote NPC — relay so their owner's LLM can respond
          conn.send({
            type: 'chat_to_npc',
            target_owner: npc.ownerPid,
            target_npc_id: npc.npcId,
            text,
          });
        } else if (npc.playerId) {
          // Remote player (e.g. AI rival) — send as global chat directed at them
          conn.send({ type: 'chat', text: `@${npc.playerId} ${text}` });
        }
      }
      return;
    }

    // Log player message
    this._addLog(`You: ${text}`);

    // Rename shortcut
    const nameMatch = text.match(/^your\s+name\s+is\s+(.+)$/i);
    if (nameMatch) {
      const newName = nameMatch[1].trim();
      npc.setName(newName);
      const reply = `Right, I'm ${newName} now.`;
      npc.showBubble(reply, 5000, { silent: true });
      this._addLog(`${npc.getName()}: ${reply}`);
      return;
    }

    const playerId = this._getPlayerId();

    // Check for "talk to <name>" / "go talk to <name>" / "chat with <name>" — socialize command
    const talkMatch = text.match(/\b(?:go\s+)?(?:talk|chat|speak|socialize)\s+(?:to|with)\s+(.+)/i);
    if (talkMatch) {
      const targetName = talkMatch[1].trim().toLowerCase();
      const resolved = this._resolveSocializeTarget(targetName);
      if (resolved) {
        const reply = `Going to have a chat with ${resolved.displayName}.`;
        npc.showBubble(reply, 3000, { silent: true });
        npc.addMemory(`Player commanded: "${text}"`, 'command', playerId);
        this._onCommands(npc, [resolved.command]);
        this._addLog(`${npc.getName()}: ${reply}`);
        return;
      }
      // No target found — fall through to LLM
    }

    // Check for "rob/steal from <name>" — steal_logs command
    const robMatch = text.match(/\b(?:go\s+)?(?:rob|steal\s+(?:from|logs?\s+from)?|mug|loot)\s+(.+)/i);
    if (robMatch) {
      const targetName = robMatch[1].trim().toLowerCase();
      const resolved = this._resolveSocializeTarget(targetName);
      if (resolved) {
        const cmd = { task: 'steal_logs', target_owner: resolved.command.target_owner, target_npc_id: resolved.command.target_npc_id };
        const reply = `Going to steal from ${resolved.displayName}!`;
        npc.showBubble(reply, 3000, { silent: true });
        npc.addMemory(`Player commanded: "${text}"`, 'command', playerId);
        this._onCommands(npc, [cmd]);
        this._addLog(`${npc.getName()}: ${reply}`);
        return;
      }
    }

    // Check for "attack <target_name>" pattern — resolve to specific player/NPC
    const attackMatch = text.match(/\b(attack|fight|kill)\s+(.+)/i);
    if (attackMatch) {
      const targetName = attackMatch[2].trim().toLowerCase();
      const resolved = this._resolveAttackTarget(targetName);
      if (resolved) {
        const reply = `Going after ${resolved.displayName}!`;
        npc.showBubble(reply, 3000, { silent: true });
        npc.addMemory(`Player commanded: "${text}"`, 'command', playerId);
        this._onCommands(npc, [resolved.command]);
        this._addLog(`${npc.getName()}: ${reply}`);
        return;
      }
      // If no target found with that name, fall through to general attack
    }

    // Local pattern matching — instant command shortcuts (no LLM needed)
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
        this._onCommands(npc, commands);
        this._addLog(`${npc.getName()}: ${reply}`);
        return;
      }
    }

    // LLM round-trip (direct to local Ollama)
    npc.showBubble('Thinking...', 5000, { silent: true });
    this._status.setText('Talking to local LLM...').setVisible(true);

    try {
      // Try command parsing first
      const worldCtx = { trees: (this._scene.trees ?? []).filter(t => !t._chopped).length };
      const { commands } = await parseCommand(text, worldCtx);

      npc.hideBubble();
      this._status.setVisible(false);

      npc.addMemory(`Player commanded: "${text}"`, 'command', playerId);

      if (commands.length > 0 && commands[0].task !== 'idle') {
        // Got real commands — check drive compliance first
        const taskName = commands[0].task;
        const pType = npc.soul?.personality?.type || 'Pragmatist';
        const compliance = DriveSystem.checkCompliance(npc, taskName);

        if (compliance.level === 'refusal') {
          // Only survival-emergency refusals — rare
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
          this._addLog(`${npc.getName()}: ${reply}`);
        } else {
          // Willing or reluctant — execute with flavored response
          let reply = _getPersonalityTaskReply(pType, taskName);
          if (compliance.level === 'reluctant') reply = `*grumbles* ${reply}`;
          else if (compliance.level === 'eager') reply = reply + '!';
          npc.showBubble(reply, 3000, { silent: true });
          this._onCommands(npc, commands);
          this._addLog(`${npc.getName()}: ${reply}`);
        }
      } else {
        // Idle or unclear — try dialogue instead
        await this._fetchDialogue(npc, text);
      }
    } catch (err) {
      console.error('ChatBox LLM error:', err);
      npc.showBubble('(LLM offline)', 5000, { silent: true });
      this._status.setText('Is Ollama running? (localhost:11434)').setVisible(true);
      this._scene.time.delayedCall(3000, () => this._status.setVisible(false));
      this._addLog('(LLM offline — start Ollama)');
    }
  }

  _handleSlashCommand(text) {
    const conn = this._scene?._conn;
    const parts = text.slice(1).trim().split(/\s+/);
    const cmd = parts[0]?.toLowerCase();

    if (cmd === 'give') {
      const item = parts[1]?.toLowerCase();
      const amount = parseInt(parts[2], 10) || 10;
      const validItems = ['seeds', 'logs', 'stones', 'crystals', 'meat', 'feathers', 'vegetables'];
      if (!item || !validItems.includes(item)) {
        this._addLog(`Usage: /give <${validItems.join('|')}> [amount]`, '#ffaa44');
        return;
      }
      conn?.send({ type: 'admin', field: item, value: amount });
      this._addLog(`Gave yourself ${amount} ${item}.`, '#88ff88');
      return;
    }

    // ── Custom task recording commands ──────────────────────────────────────
    const recorder = this._scene?._taskRecorder;

    if (cmd === 'create_task') {
      const taskName = parts.slice(1).join('_') || '';
      if (!taskName) {
        this._addLog('Usage: /create_task <name>  (e.g. /create_task mine_and_deposit)', '#ffaa44');
        return;
      }
      if (!recorder) { this._addLog('Task recorder not available.', '#ff6644'); return; }
      if (recorder.isRecording()) {
        this._addLog('Already recording! Use /save_task or /cancel_task first.', '#ffaa44');
        return;
      }
      recorder.startRecording(taskName);
      this._addLog(`Recording task "${taskName}". Click ore nodes and storage crates to add targets.`, '#44ff44');
      this._addLog('When done: /save_task to save, /cancel_task to abort.', '#888888');
      return;
    }

    if (cmd === 'save_task') {
      if (!recorder?.isRecording()) {
        this._addLog('Not recording any task. Use /create_task <name> first.', '#ffaa44');
        return;
      }
      const saved = recorder.saveRecording();
      if (saved) {
        this._addLog(`Task "${saved.name}" saved! Ores: ${saved.ore_labels.join(', ')}. Crates: ${saved.crate_labels.join(', ') || 'auto'}.`, '#44ff44');
        this._addLog(`Assign to an NPC with: /${saved.name}`, '#888888');
      } else {
        this._addLog('Cannot save — add at least one ore target first.', '#ff6644');
      }
      return;
    }

    if (cmd === 'cancel_task') {
      if (!recorder?.isRecording()) {
        this._addLog('Not recording any task.', '#ffaa44');
        return;
      }
      const name = recorder.getTaskName();
      recorder.cancelRecording();
      this._addLog(`Task recording "${name}" cancelled.`, '#ffaa44');
      return;
    }

    if (cmd === 'tasks') {
      if (!recorder) { this._addLog('Task recorder not available.', '#ff6644'); return; }
      const names = recorder.getTaskNames();
      if (names.length === 0) {
        this._addLog('No custom tasks saved. Use /create_task <name> to create one.', '#888888');
      } else {
        this._addLog(`Saved tasks: ${names.map(n => '/' + n).join(', ')}`, '#cccccc');
      }
      return;
    }

    if (cmd === 'delete_task') {
      const taskName = parts.slice(1).join('_') || '';
      if (!taskName) { this._addLog('Usage: /delete_task <name>', '#ffaa44'); return; }
      if (!recorder) return;
      recorder.deleteTask(taskName);
      this._addLog(`Task "${taskName}" deleted.`, '#ffaa44');
      return;
    }

    // ── Check if it's a custom task name → assign to selected NPC ───────
    if (recorder) {
      const taskDef = recorder.getTask(cmd);
      if (taskDef) {
        const npc = this._getSelectedNPC();
        if (!npc) {
          this._addLog('Select an NPC first, then use /' + taskDef.name, '#ffaa44');
          return;
        }
        // Dispatch as custom_task command
        const commands = [{
          task: 'custom_task',
          task_name: taskDef.name,
          ore_asset_ids: taskDef.ore_asset_ids,
          crate_building_ids: taskDef.crate_building_ids,
          crate_labels: taskDef.crate_labels,
        }];
        const pType = npc.soul?.personality?.type || 'Pragmatist';
        const reply = _getPersonalityTaskReply(pType, 'mine_ore');
        npc.showBubble(reply, 3000, { silent: true });
        this._onCommands(npc, commands);
        this._addLog(`${npc.getName()}: ${reply} (task: ${taskDef.name})`, '#cccccc');
        return;
      }
    }

    this._addLog(`Unknown command: ${text}`, '#ff6644');
  }

  async _fetchDialogue(npc, text) {
    const playerId = this._getPlayerId();
    try {
      const soulCtx = npc.getSoulContext(playerId);
      // Add nearby world context so the NPC can answer questions about surroundings
      soulCtx.nearby_entities = this._buildNearbyContext(npc);
      soulCtx.nearby_threats = this._buildNearbyThreatContext(npc);
      const topicEntity = this._findMentionedEntity(text, soulCtx.nearby_entities);
      if (topicEntity) {
        soulCtx.topic_entity = npc.getContextAboutEntity(topicEntity.id, topicEntity.name);
      }

      // Build recent conversation history for this NPC
      if (!this._chatHistory.has(npc.id)) this._chatHistory.set(npc.id, []);
      const history = this._chatHistory.get(npc.id);
      history.push({ role: 'player', text });

      const ownerId = this._scene?.playerId || 'default';
      const data = await generateDialogue(soulCtx, text, {
        speakingPlayer: playerId,
        owner: ownerId,
        chatHistory: history.slice(-8), // last 4 exchanges (8 turns)
      });

      const reply = data.dialogue ?? '...';
      history.push({ role: 'npc', text: reply });
      // Keep history bounded
      if (history.length > 12) history.splice(0, history.length - 12);

      const actual = data.emotion_deltas ? npc.applyEmotionDeltas(data.emotion_deltas, playerId) : null;
      const deltaStr = _formatDeltas(actual);
      const bubbleText = deltaStr ? `${reply}\n${deltaStr}` : reply;
      npc.showBubble(bubbleText, deltaStr ? 8000 : 6000, { silent: true });

      this._scene?._processOverheardConversation?.({
        speakerNpc: npc,
        playerText: text,
        npcReply: reply,
        topicEntity,
        playerId,
      });

      npc.addMemory(`Player said: "${text}" → responded: "${reply}"`, 'dialogue', playerId);

      // Log NPC reply + deltas
      let logLine = `${npc.getName()}: ${reply}`;
      if (deltaStr) logLine += ` ${deltaStr}`;
      this._addLog(logLine);
    } catch (err) {
      console.error('Dialogue error:', err);
      npc.showBubble('Hmm?', 2000, { silent: true });
      this._addLog(`${npc.getName()}: Hmm?`);
    }
  }

  /** Resolve a target name to a player or NPC attack command. */
  _resolveAttackTarget(targetName) {
    const scene = this._scene;

    // Check remote players
    for (const rp of Object.values(scene._remotePlayers || {})) {
      if (rp.isDead?.()) continue;
      if (rp.playerId.toLowerCase().includes(targetName)) {
        return {
          command: { task: 'attack_player', target_id: rp.playerId },
          displayName: rp.playerId,
        };
      }
    }

    // Check remote NPCs (other players' NPCs)
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

    // Check remote NPCs (other players' NPCs)
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

    // If generic name like "him" / "that robot" — pick nearest remote NPC
    if (/\b(him|her|them|that|it|that\s+(?:robot|npc|guy|one))\b/i.test(targetName)) {
      const npc = this._selectedNPC;
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

  /** Build a short list of nearby entities so the NPC can answer world-awareness questions. */
  _buildNearbyContext(npc) {
    const scene = this._scene;
    if (!scene) return [];
    const TILE = 48; // TILE_SIZE
    const RANGE = TILE * 10; // ~10 tiles
    const nearby = [];

    // Owner player
    const player = scene.player;
    if (player) {
      const dist = Math.round(Phaser.Math.Distance.Between(npc.x, npc.y, player.x, player.y) / TILE);
      nearby.push({ id: scene.playerId || 'default', type: 'player', name: scene.playerId || 'owner', relation: 'owner', distance: dist });
    }

    // Remote players
    for (const [pid, rp] of Object.entries(scene._remotePlayers || {})) {
      if (rp.isDead?.()) continue;
      const dist = Phaser.Math.Distance.Between(npc.x, npc.y, rp.x, rp.y);
      if (dist > RANGE) continue;
      nearby.push({ id: pid, type: 'player', name: pid, relation: 'stranger', distance: Math.round(dist / TILE) });
    }

    // Remote NPCs
    for (const rnpc of Object.values(scene._remoteNPCSprites || {})) {
      if (rnpc.isDead?.()) continue;
      const dist = Phaser.Math.Distance.Between(npc.x, npc.y, rnpc.x, rnpc.y);
      if (dist > RANGE) continue;
      nearby.push({
        id: `npc:${rnpc.npcId}`, type: 'npc', name: rnpc.getName?.() || rnpc.npcId,
        owner: rnpc.ownerPid, relation: 'rival',
        distance: Math.round(dist / TILE),
      });
    }

    // Sibling NPCs (same owner)
    for (const other of scene.npcs || []) {
      if (other === npc || other.isDead?.()) continue;
      const dist = Phaser.Math.Distance.Between(npc.x, npc.y, other.x, other.y);
      if (dist > RANGE) continue;
      nearby.push({ id: `npc:${other.id}`, type: 'npc', name: other.getName(), relation: 'ally', distance: Math.round(dist / TILE) });
    }

    return nearby;
  }

  _buildNearbyThreatContext(npc) {
    const scene = this._scene;
    if (!scene) return [];
    const TILE = 48;
    const RANGE = TILE * 10;
    const nearby = [];
    const recentThreats = scene._recentThreats || {};

    for (const [pid, rp] of Object.entries(scene._remotePlayers || {})) {
      if (rp.isDead?.()) continue;
      if (!recentThreats[`player:${pid}`]) continue;
      const dist = Phaser.Math.Distance.Between(npc.x, npc.y, rp.x, rp.y);
      if (dist > RANGE) continue;
      nearby.push({ id: pid, type: 'player', name: pid, distance: Math.round(dist / TILE) });
    }

    for (const rnpc of Object.values(scene._remoteNPCSprites || {})) {
      if (rnpc.isDead?.()) continue;
      if (!recentThreats[`npc:${rnpc.npcId}`]) continue;
      const dist = Phaser.Math.Distance.Between(npc.x, npc.y, rnpc.x, rnpc.y);
      if (dist > RANGE) continue;
      nearby.push({
        id: `npc:${rnpc.npcId}`,
        type: 'npc',
        name: rnpc.getName?.() || rnpc.npcId,
        distance: Math.round(dist / TILE),
      });
    }

    return nearby;
  }

  _findMentionedEntity(text, nearbyEntities = []) {
    const lowered = (text || '').toLowerCase();
    if (!lowered) return null;
    const candidates = nearbyEntities
      .filter(e => e?.id && e?.name)
      .slice()
      .sort((a, b) => b.name.length - a.name.length);

    // Try matching by name first
    const byName = candidates.find(e => lowered.includes(String(e.name).toLowerCase()));
    if (byName) return byName;

    // If text uses a pronoun/vague reference, pick the nearest non-owner entity
    if (/\b(him|her|them|they|he'?s|he|she'?s|she|that\s*(?:guy|one|robot|npc|thing)?|this\s*(?:guy|one|robot|npc|thing))\b/i.test(lowered)) {
      const nonOwner = candidates
        .filter(e => e.relation !== 'owner')
        .sort((a, b) => (a.distance ?? 999) - (b.distance ?? 999));
      if (nonOwner.length > 0) return nonOwner[0];
    }

    return null;
  }

  _close() {
    this._open = false;
    this._closedAt = Date.now();
    this._input = '';
    this._setVisible(false);
    this._cursor.setVisible(false);
  }

  _closeAndDeselect() {
    this._close();
    this._selectNPC(null);
  }

  _setVisible(v) {
    this._bg.setVisible(v);
    this._inputBorder?.setVisible(v);
    this._label.setVisible(v);
    this._text.setVisible(v);
    this._cursor.setVisible(v);
  }

  _showHint() {
    this._hint.setVisible(true);
    this._scene.time.delayedCall(2500, () => this._hint.setVisible(false));
  }
}
