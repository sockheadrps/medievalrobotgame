// ChatBox — bottom-of-screen chat input + persistent chat log.
// Press Enter to open, type, Enter to send, Escape to cancel.
// LLM calls go directly to the player's local Ollama — no server round-trip.

import Phaser from 'phaser';
import { parseCommand, generateDialogue } from '../net/LLMClient.js';
import { extractLearnablePhrases } from '../entities/NPC.js';

const MAX_LOG_LINES = 80;
const LOG_PAD = 12;
const LOG_FONT_SIZE = 18;

// Simple local patterns to avoid LLM round-trips
const LOCAL_PATTERNS = [
  { re: /\b(chop|get|gather|collect|fetch)\b.*\b(wood|logs?|trees?)\b/i, commands: [{ task: 'gather', item: 'wood' }], reply: 'On it, chopping wood!' },
  { re: /\b(follow|come\s+with|come\s+here|stay\s+close)\b/i, commands: [{ task: 'follow' }], reply: 'Right behind you, boss.' },
  { re: /\b(stop|idle|wait|stand|stay)\b/i, commands: [{ task: 'idle' }], reply: 'Alright, taking a break.' },
  { re: /\b(train|practice|spar)\b/i, commands: [{ task: 'train' }], reply: 'Time to train! Heading to the dummy.' },
  { re: /\b(guard|defend|protect)\s*(me|us)?\b/i, commands: [{ task: 'defend_player' }], reply: 'I\'ll keep you safe.' },
  { re: /\b(give|hand|drop|deliver|bring)\b.*\b(wood|logs?|inventory|stuff)\b/i, commands: [{ task: 'give_logs' }], reply: 'Coming to drop off logs!' },
  { re: /\b(give|hand\s+over|drop\s+off|bring)\b.*\b(me|here)\b/i, commands: [{ task: 'give_logs' }], reply: 'On my way with the goods!' },
  // "attack" with no target name → attack nearest enemy (players/NPCs/dummies)
  // "attack <name>" → handled dynamically in _submit via _resolveAttackTarget
  { re: /^(attack|fight|kill)$/i, commands: [{ task: 'attack_nearest_enemy' }], reply: 'Looking for enemies!' },
  { re: /\b(build|make|construct)\b.*\b(fences?|walls?|barriers?)\b/i, commands: [{ task: 'build_fence' }], reply: 'Building fences from nearby logs!' },
];

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
    const text = this._input.trim();
    if (!text) { this._closeAndDeselect(); return; }

    // Save to history (avoid consecutive duplicates)
    if (this._history.length === 0 || this._history[this._history.length - 1] !== text) {
      this._history.push(text);
      if (this._history.length > 50) this._history.shift();
    }
    this._historyIdx = -1;

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

      // If it's a remote NPC, send chat relay so their owner's LLM can respond
      const conn = this._scene._conn;
      if (conn?.connected && npc.ownerPid && npc.npcId) {
        conn.send({
          type: 'chat_to_npc',
          target_owner: npc.ownerPid,
          target_npc_id: npc.npcId,
          text,
        });
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

    const carryMatch = text.match(/\b(carry|drag|haul|take)\b(.+?)\b(away|off|with you|over there)?\b/i);
    if (carryMatch) {
      const resolved = this._resolveCarryTarget((carryMatch[2] || '').trim().toLowerCase());
      if (resolved) {
        const reply = `I'll haul ${resolved.displayName} away.`;
        npc.showBubble(reply, 3200, { silent: true });
        npc.addMemory(`Player commanded: "${text}"`, 'command', playerId);
        this._onCommands(npc, [resolved.command]);
        this._addLog(`${npc.getName()}: ${reply}`);
        return;
      }
    }

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

    // Try local pattern matching first
    for (const pat of LOCAL_PATTERNS) {
      if (pat.re.test(text)) {
        npc.showBubble(pat.reply, 3000, { silent: true });
        npc.addMemory(`Player commanded: "${text}"`, 'command', playerId);
        this._onCommands(npc, pat.commands);
        this._addLog(`${npc.getName()}: ${pat.reply}`);
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
        // Got real commands — execute them
        const taskName = commands[0].task;
        const replies = {
          gather: 'On it!',
          follow: 'Following you!',
          attack_nearest_enemy: 'Looking for a fight!',
          attack_player: 'Going after them!',
          attack_npc: 'Targeting their NPC!',
          defend_player: 'I\'ll guard you!',
          train: 'Time to train!',
        };
        const reply = replies[taskName] ?? 'Got it!';
        npc.showBubble(reply, 3000, { silent: true });
        this._onCommands(npc, commands);
        this._addLog(`${npc.getName()}: ${reply}`);
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

  async _fetchDialogue(npc, text) {
    const playerId = this._getPlayerId();
    try {
      const soulCtx = npc.getSoulContext(playerId);
      // Add nearby world context so the NPC can answer questions about surroundings
      soulCtx.nearby_entities = this._buildNearbyContext(npc);
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

  _resolveCarryTarget(targetName) {
    const scene = this._scene;
    const knocked = [];

    for (const rp of Object.values(scene._remotePlayers || {})) {
      if (rp.isDead?.() || !rp.isKnockedOut?.()) continue;
      knocked.push({
        entity: rp,
        displayName: rp.playerId,
        command: { task: 'carry_away_player', target_id: rp.playerId, target_name: rp.playerId },
      });
    }

    for (const rnpc of Object.values(scene._remoteNPCSprites || {})) {
      if (rnpc.isDead?.() || !rnpc.isKnockedOut?.()) continue;
      const name = rnpc.getName?.() || rnpc.npcId || 'them';
      knocked.push({
        entity: rnpc,
        displayName: name,
        command: {
          task: 'carry_away_npc',
          target_owner: rnpc.ownerPid,
          target_npc_id: rnpc.npcId,
          target_name: name,
        },
      });
    }

    if (knocked.length === 0) return null;
    const generic = !targetName || /\b(body|them|him|her|that|target|one)\b/.test(targetName);
    if (generic && knocked.length === 1) return knocked[0];
    return knocked.find(entry => entry.displayName.toLowerCase().includes(targetName)) || null;
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
