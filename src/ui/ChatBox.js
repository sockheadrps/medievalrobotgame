// ChatBox — bottom-of-screen chat input + persistent chat log.
// Press Enter to open, type, Enter to send, Escape to cancel.
// LLM calls go directly to the player's local Ollama — no server round-trip.
//
// Responsibilities (UI only):
//   - Render the chat log and input bar
//   - Capture keyboard input
//   - Forward raw text to NPCBrain.handlePlayerCommand for local NPCs
//   - Relay messages to server for remote NPCs/players
//
// NPC command routing, vocabulary learning, personality replies, drive compliance,
// and target resolution all live in NPCBrain.handlePlayerCommand.

import Phaser from 'phaser';
import { generateDialogue } from '../net/LLMClient.js';
import { extractLearnablePhrases } from '../entities/NPC.js';

const MAX_LOG_LINES = 80;
const LOG_PAD = 12;
const LOG_FONT_SIZE = 18;

// Small inline table used only by the slash-command custom-task handler below.
// The full PERSONALITY_TASK_REPLIES table now lives in NPCBrain.js.
const _CUSTOM_TASK_REPLIES = {
  Guardian:   'Mining ore. Stay safe.',
  Scout:      'Ooh, shiny ore! On it!',
  Berserker:  'SMASHING ore!',
  Caretaker:  'I\'ll get some ore for us!',
  Paranoid:   'Mining... watching my back.',
  Pragmatist: 'Mining. Optimal route calculated.',
};
function _getCustomTaskReply(personalityType) {
  return _CUSTOM_TASK_REPLIES[personalityType] || _CUSTOM_TASK_REPLIES.Pragmatist;
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
    let text = this._input.trim();
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

    const isRemote = !npc.getSoulContext;

    // When speaking to a remote entity, local NPCs overhear the speech at 3x weight
    // (owner's outbound tone matters more than commands to their own NPC).
    // For local NPC commands, vocabulary learning is handled inside NPCBrain.handlePlayerCommand.
    if (isRemote) {
      const knownNames = new Set();
      for (const n of (this._scene?.npcs || [])) {
        const name = n.getName?.() || n.name;
        if (name) knownNames.add(name.toLowerCase());
      }
      const learnedPhrases = extractLearnablePhrases(text, knownNames);
      if (learnedPhrases.length > 0) {
        for (const localNpc of (this._scene?.npcs || [])) {
          for (const phrase of learnedPhrases) {
            localNpc.learnPhrase(phrase); // learnPhrase increments use count — call 3x for weight
            localNpc.learnPhrase(phrase);
            localNpc.learnPhrase(phrase);
          }
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

    // Delegate all command routing, vocabulary learning, and LLM calls to NPCBrain.
    const playerId = this._getPlayerId();
    const brain = this._scene._npcBrains?.get(npc.id);
    if (brain) {
      await brain.handlePlayerCommand(text, {
        playerId,
        addLog:        (msg, color) => this._addLog(msg, color),
        fetchDialogue: (n, t)       => this._fetchDialogue(n, t),
        statusShow:    (msg)        => this._status.setText(msg).setVisible(true),
        statusHide:    ()           => this._status.setVisible(false),
      });
    } else {
      // Fallback if brain not available — try dialogue directly
      await this._fetchDialogue(npc, text);
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
        const reply = _getCustomTaskReply(pType);
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
