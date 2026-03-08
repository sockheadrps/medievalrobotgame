// SocialChatPanel — unified persistent social chat log with two tabs.
//
// Sits above the HUD (bottom-left of viewport). Always visible.
// Enter with NPC selected  → DM: LLM dialogue, blue player text, green NPC reply
// Enter with no NPC nearby → Shout: white player text, nearby NPCs react via quip
// NPC autonomous lines pushed via addNpcLine() go to both Chat + NPCs tabs.
//
// Tab "Chat":     player messages + direct NPC replies
// Tab "NPCs":     autonomous quips, thoughts, encounter lines
//
// Colors:
//   Player DM     #88ccff   You→Name: ...
//   Player shout  #cccccc   You: ...
//   NPC direct    #aaffaa   Name: ...   (responding to player DM)
//   NPC overheard #667788   Name: ...   (reacting to shout or autonomous)

import Phaser from 'phaser';

const QUIP_URL     = 'http://127.0.0.1:8001/npc_quip';
const DIALOGUE_URL = 'http://127.0.0.1:8001/npc_dialogue';
const THOUGHT_URL  = 'http://127.0.0.1:8001/npc_thought';
const COMMAND_URL  = 'http://127.0.0.1:8001/parse_command';

const PANEL_W    = 420;
const LOG_ROWS   = 7;
const LINE_H     = 16;
const INPUT_H    = 28;
const TAB_H      = 18;
const LOG_H      = LOG_ROWS * LINE_H;
const PANEL_H    = TAB_H + LOG_H + INPUT_H + 4;
const DEPTH      = 55;
const MAX_LINES  = 60;
const SHOUT_DIST = 10 * 48;
const MAX_CHARS  = Math.floor(PANEL_W / 6.2);
const SCROLL_STEP = 3;

export class SocialChatPanel {
  constructor(scene, getSelectedNPC, getPlayer, getNpcs, selectNPC) {
    this._scene          = scene;
    this._getSelectedNPC = getSelectedNPC;
    this._getPlayer      = getPlayer  ?? (() => null);
    this._getNpcs        = getNpcs    ?? (() => []);
    this._selectNPC      = selectNPC  ?? (() => {});

    this._open  = false;
    this._input = '';
    this._busy  = false;

    // Two separate logs
    this._chatLog     = [];   // player messages + direct NPC replies
    this._activityLog = [];   // autonomous NPC lines

    // 'chat' | 'activity'
    this._activeTab = 'chat';
    this._scrollStart = { chat: 0, activity: 0 };

    const HUD_TOP = 720;
    this._px = 0;
    this._py = HUD_TOP - PANEL_H - 4;

    this._cursorVisible = true;
    scene.time.addEvent({ delay: 500, loop: true, callback: () => {
      this._cursorVisible = !this._cursorVisible;
      this._refreshCursor();
    }});

    this._build(scene);
    // Use keydown-ENTER so Phaser's key capture doesn't swallow it
    scene.input.keyboard.on('keydown-ENTER', (event) => {
      if (this._open) { event.stopPropagation?.(); this._submit(); }
      else if (!this._scene.chatBox?.isOpen()) this._openInput();
    }, this);
    scene.input.keyboard.on('keydown', this._onKeyTyping, this);
    scene.input.on('wheel', this._onWheel, this);
  }

  isOpen() { return this._open; }

  /** Push an NPC line from outside (quips, autonomous thoughts, encounter lines).
   *  direct=true  → goes to Chat tab (NPC is directly replying to player)
   *  direct=false → goes to NPCs tab (autonomous / background chatter)
   */
  addNpcLine(npcName, text, direct = false) {
    const line = `${npcName}: ${text}`;
    if (direct) {
      this._pushLine(line, '#aaffaa', false);
      return;
    }
    // Keep autonomous chatter in both logs so it appears in the main chat box too.
    this._pushLine(line, '#667788', false);
    this._pushLine(line, '#667788', true);
  }

  // ── Build ─────────────────────────────────────────────────────────────────

  _build(scene) {
    const x = this._px, y = this._py;

    // Tab bar background
    this._tabBg = scene.add.rectangle(x, y, PANEL_W, TAB_H, 0x020609, 0.9)
      .setScrollFactor(0).setDepth(DEPTH).setOrigin(0, 0)
      .setStrokeStyle(1, 0x1a2a3a);

    // Tab buttons
    const TAB_W = 70;
    this._tabChat = scene.add.text(x + 8, y + TAB_H / 2, 'Chat', {
      fontSize: '10px', color: '#aaccff',
    }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(DEPTH + 1)
      .setInteractive({ useHandCursor: true });
    this._tabChat.on('pointerdown', () => this._switchTab('chat'));

    this._tabActivity = scene.add.text(x + 8 + TAB_W, y + TAB_H / 2, 'NPCs', {
      fontSize: '10px', color: '#445566',
    }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(DEPTH + 1)
      .setInteractive({ useHandCursor: true });
    this._tabActivity.on('pointerdown', () => this._switchTab('activity'));

    // Active tab underline indicator
    this._tabIndicator = scene.add.rectangle(x + 6, y + TAB_H - 2, 30, 2, 0x88aaff, 1)
      .setScrollFactor(0).setDepth(DEPTH + 1).setOrigin(0, 0);

    // Log area (sits below tab bar)
    const ly = y + TAB_H;
    this._logBg = scene.add.rectangle(x, ly, PANEL_W, LOG_H, 0x040810, 0.82)
      .setScrollFactor(0).setDepth(DEPTH).setOrigin(0, 0)
      .setStrokeStyle(1, 0x1a2a3a);

    this._inputBg = scene.add.rectangle(x, ly + LOG_H + 2, PANEL_W, INPUT_H, 0x080e18, 0.92)
      .setScrollFactor(0).setDepth(DEPTH).setOrigin(0, 0)
      .setStrokeStyle(1, 0x1a2a3a);

    this._promptLabel = scene.add.text(x + 8, ly + LOG_H + 2 + INPUT_H / 2, 'Say:', {
      fontSize: '10px', color: '#445566',
    }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(DEPTH + 1);

    this._inputText = scene.add.text(x + 38, ly + LOG_H + 2 + INPUT_H / 2, '', {
      fontSize: '11px', color: '#ffffff',
    }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(DEPTH + 1).setVisible(false);

    this._cursorText = scene.add.text(x + 38, ly + LOG_H + 2 + INPUT_H / 2, '|', {
      fontSize: '11px', color: '#aaccff',
    }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(DEPTH + 1).setVisible(false);

    this._hintText = scene.add.text(x + 8, ly + LOG_H + 2 + INPUT_H / 2,
      'Press Enter to speak', { fontSize: '10px', color: '#334455' },
    ).setOrigin(0, 0.5).setScrollFactor(0).setDepth(DEPTH + 1);

    this._lineObjs = [];
    for (let i = 0; i < LOG_ROWS; i++) {
      this._lineObjs.push(
        scene.add.text(x + 6, ly + i * LINE_H + 3, '', {
          fontSize: '10px', color: '#667788',
        }).setOrigin(0, 0).setScrollFactor(0).setDepth(DEPTH + 1)
      );
    }

    this._refreshTabVisuals();
    this._refreshLog();
  }

  // ── Tabs ──────────────────────────────────────────────────────────────────

  _switchTab(tab) {
    this._activeTab = tab;
    this._refreshTabVisuals();
    this._refreshLog();
  }

  _refreshTabVisuals() {
    const isChat = this._activeTab === 'chat';
    this._tabChat.setColor(isChat ? '#aaccff' : '#445566');
    this._tabActivity.setColor(isChat ? '#445566' : '#aaccff');
    // Move indicator under active tab
    const TAB_W = 70;
    this._tabIndicator.setX(isChat ? this._px + 6 : this._px + 6 + TAB_W);
  }

  // ── Keyboard ──────────────────────────────────────────────────────────────

  _onKeyTyping(event) {
    if (!this._open) return;

    if (event.key === 'Escape') { this._closeInput(); return; }

    if (event.key === 'Enter') return; // handled by keydown-ENTER listener

    if (event.key === 'Backspace') {
      this._input = this._input.slice(0, -1);
      this._refreshInput();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key === 'v') {
      navigator.clipboard.readText().then(t => {
        this._input += t.replace(/[\r\n]+/g, ' ');
        this._refreshInput();
      }).catch(() => {});
      return;
    }

    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
      this._input += event.key;
      this._refreshInput();
    }
  }

  _openInput() {
    this._open  = true;
    this._input = '';
    this._hintText.setVisible(false);
    this._inputText.setVisible(true).setText('');
    this._promptLabel.setColor('#6699aa');
    this._refreshCursor();
  }

  _closeInput() {
    this._open = false;
    this._input = '';
    this._hintText.setVisible(true);
    this._inputText.setVisible(false);
    this._cursorText.setVisible(false);
    this._promptLabel.setColor('#445566');
  }

  // ── Submit ────────────────────────────────────────────────────────────────

  async _submit() {
    const text = this._input.trim();
    if (!text) { this._closeInput(); return; }

    this._busy = true;
    this._closeInput();

    const npc    = this._getSelectedNPC();
    const player = this._getPlayer();

    if (npc) {
      // DM mode — always goes to Chat tab
      const name = npc._nameLabel?.text ?? npc.id;
      this._pushLine(`You\u2192${name}: ${text}`, '#88ccff', false);
      if (player?.showBubble) player.showBubble(text, 5000);
      npc.recordSocialStimulus?.({
        sourceId: 'player',
        sourceName: 'player',
        text,
        tags: _inferSocialTags(text),
        intensity: _inferIntensity(text),
        targeted: true,
      });
      triggerNPCThought(npc, `direct message from player: "${_short(text)}"`);

      const newName = _matchNameCommand(text);
      if (newName) {
        npc.setName?.(newName);
        this._scene.hud?.showContextTab?.('npc', npc.getName?.() ?? newName);
        const replies = [
          `Oh shit, yeah I almost forgot I'm ${newName}`,
          `Goddammit I thought my name was sunshine, I'm ${newName}`,
          `Yeah, I'm ${newName}, no shit sherlock`,
        ];
        const reply = replies[Math.floor(Math.random() * replies.length)];
        npc.showBubble?.(reply, 6000, true);
        this._busy = false;
        return;
      }

      // Command path: if this reads like an order, try applying parsed tasks first.
      if (_isLikelyCommand(text)) {
        const applied = await _tryApplyCommand(npc, text, this._scene);
        if (applied) {
          npc.showBubble?.('On it.', 3200, true);
          this._busy = false;
          return;
        }
      }

      try {
        const res = await fetch(DIALOGUE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            npc_id: npc.id,
            soul:   npc.getSoulContext?.() ?? {},
            player_message: text,
            world_context: this._worldCtx(),
          }),
        });
        if (!res.ok) throw new Error();
        const data = await res.json();
        const reply = data.dialogue ?? '...';
        npc.applyEmotionDeltas?.(data.emotion_deltas ?? {});
        if (data.memory_tag) npc.addMemory?.(data.memory_tag);
        const action = data.action ?? {};
        if (action.type === 'rename_self') {
          const requested = String(action.params?.new_name ?? '').trim();
          if (requested) {
            npc.setName?.(requested);
            this._scene.hud?.showContextTab?.('npc', npc.getName?.() ?? requested);
          }
        }
        // direct=true so the reply goes to the Chat tab, not Activity
        npc.showBubble?.(reply, 6000, true);
      } catch {
        this._pushLine('(no response)', '#445566', false);
      }

    } else {
      // Shout mode — player line goes to Chat; NPC reactions go to Activity
      this._pushLine(`You: ${text}`, '#cccccc', false);
      if (player?.showBubble) player.showBubble(text, 5000);

      if (player) {
        const nearby = this._getNpcs().filter(n =>
          !n._dead &&
          Phaser.Math.Distance.Between(player.x, player.y, n.x, n.y) <= SHOUT_DIST
        );
        const groupAttackSuggested = _isGroupAttackSuggestion(text);
        const rallyTarget = groupAttackSuggested
          ? _chooseGroupAttackTarget(this._scene, player)
          : null;
        for (let i = 0; i < nearby.length; i++) {
          const n = nearby[i];
          const directed = _isDirectedAtNpc(text, n);
          const commandish = _isLikelyCommand(text);
          const regularNpc = String(n?.faction ?? '') !== 'rival';

          if (directed) {
            n.recordSocialStimulus?.({
              sourceId: 'player',
              sourceName: 'player',
              text,
              tags: _inferSocialTags(text),
              intensity: _inferIntensity(text),
              targeted: true,
            });
            triggerNPCThought(n, `player addressed me directly in a shout: "${_short(text)}"`);
          }

          if (groupAttackSuggested && rallyTarget && regularNpc && n !== rallyTarget) {
            const joinChance = _calcGroupFightJoinChance(n);
            if (Math.random() < joinChance) {
              this._scene.time.delayedCall(i * 200, () => {
                if (n._dead || rallyTarget?._dead) return;
                n.addIntent?.(`Player rallied us. Moving to attack ${rallyTarget.getName?.() ?? rallyTarget.id ?? 'target'}.`);
                n.taskRunner?.pushTask?.({
                  task: 'attack_nearest_enemy',
                  target: rallyTarget,
                  range: SHOUT_DIST,
                });
                n.showBubble('Alright, I am in.', 2600);
              });
              continue;
            }
          }

          if (directed && commandish && regularNpc) {
            const obeyChance = _calcCommandObeyChance(n);
            if (Math.random() < obeyChance) {
              this._scene.time.delayedCall(i * 250, async () => {
                if (n._dead) return;
                const applied = await _tryApplyCommand(n, text, this._scene);
                if (applied && !n._dead) {
                  n.showBubble('On it.', 3200);
                }
              });
              continue;
            }
          }

          this._scene.time.delayedCall(i * 900, () => {
            if (n._dead) return;
            fetch(QUIP_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                npc_id:      n.id,
                soul:        n.getSoulContext?.() ?? {},
                situation:   'heard_player',
                other_name:  'the player',
                player_said: text,
              }),
            }).then(r => r.json()).then(d => {
              if (d.quip && !n._dead) {
                n.showBubble(d.quip, 5000);
                // NPC.showBubble calls addNpcLine(name, quip, false) → Chat + NPCs tabs
              }
            }).catch(() => {});
          });
        }
      }
    }

    this._busy = false;
  }

  // ── Log ───────────────────────────────────────────────────────────────────

  /** Push a line to chat or activity log.
   *  toActivity=false → _chatLog, toActivity=true → _activityLog
   */
  _pushLine(text, color, toActivity = false) {
    const log = toActivity ? this._activityLog : this._chatLog;
    const tabKey = toActivity ? 'activity' : 'chat';
    const maxStartBefore = Math.max(0, log.length - LOG_ROWS);
    const atBottom = (this._scrollStart[tabKey] ?? 0) >= maxStartBefore;

    const words = text.split(' ');
    let cur = '';
    const wrapped = [];
    for (const w of words) {
      const cand = cur ? `${cur} ${w}` : w;
      if (cand.length <= MAX_CHARS) { cur = cand; }
      else { if (cur) wrapped.push(cur); cur = w; }
    }
    if (cur) wrapped.push(cur);
    for (const line of wrapped) log.push({ text: line, color });
    if (log.length > MAX_LINES) log.splice(0, log.length - MAX_LINES);
    const maxStartAfter = Math.max(0, log.length - LOG_ROWS);
    if (atBottom) this._scrollStart[tabKey] = maxStartAfter;
    else this._scrollStart[tabKey] = Math.min(this._scrollStart[tabKey] ?? 0, maxStartAfter);

    // Only re-render if this line's tab is currently visible
    const isVisible = toActivity
      ? this._activeTab === 'activity'
      : this._activeTab === 'chat';
    if (isVisible) this._refreshLog();
  }

  _refreshLog() {
    const log = this._activeTab === 'activity' ? this._activityLog : this._chatLog;
    const tabKey = this._activeTab === 'activity' ? 'activity' : 'chat';
    const maxStart = Math.max(0, log.length - LOG_ROWS);
    const start = Phaser.Math.Clamp(this._scrollStart[tabKey] ?? maxStart, 0, maxStart);
    this._scrollStart[tabKey] = start;
    for (let i = 0; i < LOG_ROWS; i++) {
      const entry = log[start + i];
      if (entry) {
        this._lineObjs[i].setText(entry.text).setColor(entry.color).setVisible(true);
      } else {
        this._lineObjs[i].setText('').setVisible(false);
      }
    }
  }

  _refreshInput() {
    this._inputText.setText(this._input);
    this._cursorText.setX(this._px + 38 + this._inputText.width + 2);
  }

  _refreshCursor() {
    if (!this._open || this._busy) { this._cursorText.setVisible(false); return; }
    this._cursorText.setVisible(this._cursorVisible);
  }

  _worldCtx() {
    const s = this._scene;
    return {
      trees:    (s.trees    ?? []).filter(t => !t._chopped).length,
      furnaces: (s.furnaces ?? []).length,
      crates:   (s.crates   ?? []).length,
    };
  }

  _onWheel(pointer, _gameObjects, _dx, dy) {
    const ly = this._py + TAB_H;
    const inLog =
      pointer.x >= this._px &&
      pointer.x <= this._px + PANEL_W &&
      pointer.y >= ly &&
      pointer.y <= ly + LOG_H;
    if (!inLog) return;

    const tabKey = this._activeTab === 'activity' ? 'activity' : 'chat';
    const log = this._activeTab === 'activity' ? this._activityLog : this._chatLog;
    const maxStart = Math.max(0, log.length - LOG_ROWS);
    if (maxStart <= 0) return;

    const dir = dy > 0 ? 1 : -1;
    this._scrollStart[tabKey] = Phaser.Math.Clamp(
      (this._scrollStart[tabKey] ?? maxStart) + dir * SCROLL_STEP,
      0,
      maxStart
    );
    this._refreshLog();
  }
}

function _matchNameCommand(text) {
  const m = text.match(/^your\s+name\s+is\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// ── Autonomous thought trigger (used by GameScene) ────────────────────────────
export async function triggerNPCThought(npc, event) {
  if (!npc?.soul) return;
  try {
    const res = await fetch(THOUGHT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ npc_id: npc.id, soul: npc.getSoulContext?.() ?? {}, event }),
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.thought) {
      npc.addIntent?.(data.thought);
      npc.showBubble?.(data.thought, 4000);
    }
    npc.applyEmotionDeltas?.(data.emotion_deltas ?? {});
  } catch { /* server offline */ }
}

function _isDirectedAtNpc(text, npc) {
  const msg = String(text ?? '').toLowerCase();
  const name = String(npc?.getName?.() ?? npc?.id ?? '').trim().toLowerCase();
  if (!msg || !name) return false;
  return msg.includes(name);
}

function _isLikelyCommand(text) {
  const msg = String(text ?? '').toLowerCase();
  if (!msg) return false;
  return /\b(go|come|follow|gather|mine|chop|cut|deposit|store|smelt|craft|build|attack|defend|guard|patrol|stop|idle|do)\b/.test(msg);
}

function _isGroupAttackSuggestion(text) {
  const msg = String(text ?? '').toLowerCase();
  if (!msg) return false;
  return /\b(let'?s|lets|everyone|all of us|we)\b/.test(msg)
    && /\b(beat|jump|attack|fight|get|rush|dogpile|gank)\b/.test(msg)
    && /\b(him|her|them|this guy|that guy|target)\b/.test(msg);
}

function _chooseGroupAttackTarget(scene, player) {
  const rivals = (scene?.npNPCs ?? []).filter(n => n && !n._dead);
  const enemies = (scene?.enemies ?? []).filter(e => e && !e._dead);
  const candidates = [...rivals, ...enemies];
  if (!player || candidates.length === 0) return null;

  let best = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = Phaser.Math.Distance.Between(player.x, player.y, c.x, c.y);
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  if (!best) return null;
  return bestDist <= (SHOUT_DIST * 1.5) ? best : null;
}

function _calcGroupFightJoinChance(npc) {
  const em = npc?.soul?.emotional_state ?? {};
  const p = npc?.soul?.personality ?? {};
  const anger = Number(em.anger ?? 0.1);
  const trust = Number(em.trust ?? 0.6);
  const aggression = Number(p.aggression ?? 0.3);
  const neuroticism = Number(p.neuroticism ?? 0.3);
  const relationship = String(npc?.soul?.relationship ?? 'neutral');

  // Moderate aggression/anger gives roughly ~1/3 odds.
  let chance = 0.08 + (aggression * 0.35) + (anger * 0.45) + (neuroticism * 0.08) - (trust * 0.2);
  if (relationship === 'allied' || relationship === 'devoted') chance += 0.04;
  if (relationship === 'hostile') chance -= 0.2;
  return Phaser.Math.Clamp(chance, 0.05, 0.8);
}

function _calcCommandObeyChance(npc) {
  const trust = Number(npc?.soul?.emotional_state?.trust ?? 0.6);
  const anger = Number(npc?.soul?.emotional_state?.anger ?? 0.1);
  return Phaser.Math.Clamp(0.7 + trust * 0.25 - anger * 0.2, 0.5, 0.95);
}

async function _tryApplyCommand(npc, text, scene) {
  try {
    const res = await fetch(COMMAND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        npc_id: npc.id,
        world_context: {
          trees: (scene.trees ?? []).filter(t => !t._chopped).length,
          furnaces: (scene.furnaces ?? []).length,
          crates: (scene.crates ?? []).length,
          quarries: (scene.quarries ?? []).length,
          crushers: (scene.crushers ?? []).length,
        },
        npc_context: {
          inventory: { ...(npc._inventory ?? {}) },
          assigned: _buildAssignedContext(npc),
        },
      }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    const commands = Array.isArray(data?.commands) ? data.commands : [];
    if (commands.length === 0) return false;
    npc.taskRunner?.setTasks?.(commands);
    scene.npcTaskPanel?.show?.(npc);
    return true;
  } catch {
    return false;
  }
}

function _buildAssignedContext(npc) {
  const out = {};
  const assigned = npc?.assignedTargets ?? {};
  for (const [key, val] of Object.entries(assigned)) {
    if (!val) continue;
    if (Array.isArray(val)) {
      if (val.length > 0) out[key] = val.map(o => _targetPos(o));
    } else if (typeof val === 'object') {
      out[key] = _targetPos(val);
    }
  }
  return out;
}

function _targetPos(obj) {
  if (!obj) return null;
  const pos = {
    col: obj.col ?? Math.round((obj.x ?? 0) / 32),
    row: obj.row ?? Math.round((obj.y ?? 0) / 32),
  };
  if (obj.rockType) pos.rockType = obj.rockType;
  return pos;
}

function _short(text, max = 80) {
  const msg = String(text ?? '').replace(/\s+/g, ' ').trim();
  return msg.length > max ? `${msg.slice(0, max - 3)}...` : msg;
}

function _inferSocialTags(text) {
  const msg = String(text ?? '').toLowerCase();
  const tags = [];
  if (/\b(stupid|idiot|dumb|hate|useless|moron|screw you|shut up)\b/.test(msg)) tags.push('insult');
  if (/\b(kill|destroy|smash|attack you|hurt you)\b/.test(msg)) tags.push('threat');
  if (/\b(thanks|thank you|good job|nice|great|awesome)\b/.test(msg)) tags.push('praise');
  if (/\b(sorry|my bad|apolog)\b/.test(msg)) tags.push('apology');
  if (/\b(do this|go to|gather|deposit|follow|attack|build|mine)\b/.test(msg)) tags.push('order');
  if (tags.length === 0) tags.push('neutral');
  return tags;
}

function _inferIntensity(text) {
  const msg = String(text ?? '');
  let score = 0.3;
  if (/[!?]{2,}/.test(msg)) score += 0.15;
  if (/\b(really|very|extremely|absolutely|now)\b/i.test(msg)) score += 0.1;
  if (msg === msg.toUpperCase() && /[A-Z]/.test(msg)) score += 0.2;
  return Phaser.Math.Clamp(score, 0.15, 1);
}

