// NPCDialoguePanel — conversational chat UI for talking to NPCs.
// Opens with Enter when standing near an NPC (and no job panel is active).
// Calls /npc_dialogue on the auxserver; NPC responds in character based on soul.
// The NPC's emotional state and memory are updated in-game after each exchange.

import Phaser from 'phaser';

const SERVER_URL  = 'http://127.0.0.1:8001/npc_dialogue';
const THOUGHT_URL = 'http://127.0.0.1:8001/npc_thought';

const W          = 480;   // panel width
const H_MAX      = 320;   // max panel height (grows with history)
const MSG_PAD    = 10;
const MSG_W      = W - MSG_PAD * 2;
const LINE_H     = 18;
const INPUT_H    = 32;
const HEADER_H   = 28;
const DEPTH      = 60;
const MAX_MSGS   = 8;     // scrollback kept in memory (older drop off top)
const TILE_SIZE  = 32;
const AUTO_CLOSE_MS = 30_000; // close after 30s of inactivity

export class NPCDialoguePanel {
  /**
   * @param {Phaser.Scene} scene
   * @param {() => NPC|null}  getSelectedNPC
   * @param {() => {x,y}|null} getPlayer
   * @param {() => NPC[]}      getNpcs
   * @param {(npc:NPC)=>void}  selectNPC
   */
  constructor(scene, getSelectedNPC, getPlayer, getNpcs, selectNPC) {
    this._scene          = scene;
    this._getSelectedNPC = getSelectedNPC;
    this._getPlayer      = getPlayer  ?? (() => null);
    this._getNpcs        = getNpcs    ?? (() => []);
    this._selectNPC      = selectNPC  ?? (() => {});

    this._open    = false;
    this._npc     = null;
    this._input   = '';
    this._busy    = false;
    this._history = [];   // { speaker: 'player'|'npc', text: string }[]
    this._closeTimer = null;

    const sw = scene.cameras.main.width;
    const sh = scene.cameras.main.height;

    // Position: bottom-centre of the game viewport (above HUD)
    this._cx = sw / 2;
    this._by = 710;   // bottom y of panel (sits just above HUD zone at 720)

    // All Phaser objects pooled here, rebuilt on each open/message
    this._objects = [];

    // Cursor blink
    this._cursorVisible = true;
    scene.time.addEvent({
      delay: 500, loop: true,
      callback: () => { this._cursorVisible = !this._cursorVisible; this._refreshCursor(); },
    });

    // Keyboard
    scene.input.keyboard.on('keydown', this._onKey, this);
  }

  isOpen() { return this._open; }

  // ── Public ─────────────────────────────────────────────────────────────────

  /** Called externally to try opening the panel (e.g. from Enter key handler). */
  tryOpen() {
    if (this._open) return true;

    // Resolve NPC target
    let npc = this._getSelectedNPC();
    if (!npc) {
      const player = this._getPlayer();
      if (player) {
        const maxDist = TILE_SIZE * 4;
        let best = null, bestDist = Infinity;
        for (const n of this._getNpcs()) {
          const d = Phaser.Math.Distance.Between(player.x, player.y, n.x, n.y);
          if (d < maxDist && d < bestDist) { bestDist = d; best = n; }
        }
        if (best) { this._selectNPC(best); npc = best; }
      }
    }
    if (!npc) return false;

    this._npc     = npc;
    this._open    = true;
    this._input   = '';
    this._history = [];
    this._rebuild();
    this._resetCloseTimer();
    return true;
  }

  close() {
    if (!this._open) return;
    this._open = false;
    this._npc  = null;
    this._input = '';
    this._busy = false;
    this._clearObjects();
    if (this._closeTimer) { this._closeTimer.remove(); this._closeTimer = null; }
  }

  // ── Keyboard ───────────────────────────────────────────────────────────────

  _onKey(event) {
    if (!this._open) return;

    if (event.key === 'Escape') {
      this.close();
      return;
    }

    if (event.key === 'Enter') {
      event.stopPropagation?.();
      this._submit();
      return;
    }

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

  // ── Submit ─────────────────────────────────────────────────────────────────

  async _submit() {
    const text = this._input.trim();
    if (!text || this._busy || !this._npc) return;

    this._input = '';
    this._busy  = true;
    this._history.push({ speaker: 'player', text });
    if (this._history.length > MAX_MSGS) this._history.shift();
    this._rebuild();

    // Show player speech bubble
    this._getPlayer()?.showBubble?.(text, 5000);

    // Show thinking indicator
    this._setStatus('…');

    const npc = this._npc;
    try {
      const soulCtx = npc.getSoulContext?.() ?? {};
      const body = {
        npc_id: npc.id,
        soul: soulCtx,
        player_message: text,
        world_context: this._worldCtx(),
      };

      const res = await fetch(SERVER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      const dialogue   = data.dialogue   ?? '…';
      const deltas     = data.emotion_deltas ?? {};
      const memoryTag  = data.memory_tag ?? null;
      const action     = data.action ?? {};

      // Apply soul changes
      npc.applyEmotionDeltas?.(deltas);
      if (memoryTag) npc.addMemory?.(memoryTag);
      if (action.type === 'rename_self') {
        const requested = String(action.params?.new_name ?? '').trim();
        if (requested) {
          npc.setName?.(requested);
          this._scene.hud?.showContextTab?.('npc', npc.getName?.() ?? requested);
        }
      }

      // Show speech bubble briefly
      npc.showBubble?.(dialogue);

      this._history.push({ speaker: 'npc', text: dialogue });
      if (this._history.length > MAX_MSGS) this._history.shift();

    } catch (err) {
      console.warn('[NPCDialoguePanel] fetch error:', err);
      this._history.push({ speaker: 'npc', text: '(no response)' });
    }

    this._busy = false;
    this._rebuild();
    this._resetCloseTimer();
  }

  // ── Build / refresh UI ─────────────────────────────────────────────────────

  _rebuild() {
    this._clearObjects();
    if (!this._open || !this._npc) return;

    const scene = this._scene;
    const push  = (o) => { this._objects.push(o); return o; };

    // Measure message heights (wrapping)
    const lines = this._history.map(msg => {
      const prefix = msg.speaker === 'player' ? 'You: ' : `${this._npc._nameLabel?.text ?? 'NPC'}: `;
      const full   = prefix + msg.text;
      const wrapped = _wrapText(full, MSG_W, 11);
      return { ...msg, wrapped };
    });

    const msgAreaH = lines.reduce((sum, l) => sum + l.wrapped.length * LINE_H + 4, 0);
    const totalH   = HEADER_H + Math.min(msgAreaH, H_MAX - HEADER_H - INPUT_H) + INPUT_H + 4;

    const left = this._cx - W / 2;
    const top  = this._by - totalH;

    // Background
    push(scene.add.rectangle(this._cx, this._by - totalH / 2, W, totalH, 0x080c14, 0.94)
      .setStrokeStyle(1, 0x3366aa)
      .setScrollFactor(0).setDepth(DEPTH).setOrigin(0.5));

    // Header
    const npcName = this._npc._nameLabel?.text ?? 'NPC';
    push(scene.add.text(left + MSG_PAD, top + HEADER_H / 2, `💬  ${npcName}`, {
      fontSize: '12px', color: '#88ccff', fontStyle: 'bold',
    }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(DEPTH + 1));

    // Close hint
    push(scene.add.text(left + W - MSG_PAD, top + HEADER_H / 2, '[Esc]', {
      fontSize: '10px', color: '#556677',
    }).setOrigin(1, 0.5).setScrollFactor(0).setDepth(DEPTH + 1));

    // Divider
    push(scene.add.rectangle(this._cx, top + HEADER_H, W, 1, 0x3366aa, 0.6)
      .setScrollFactor(0).setDepth(DEPTH + 1).setOrigin(0.5, 0));

    // Messages (bottom-up within the message area)
    let cy = top + HEADER_H + 4;
    const msgAreaBot = this._by - INPUT_H - 4;
    const visibleLines = [];

    // Collect all wrapped lines first, then clip to visible area from bottom
    const allLines = [];
    for (const msg of lines) {
      const color = msg.speaker === 'player' ? '#aaddff' : '#eeeebb';
      for (const line of msg.wrapped) {
        allLines.push({ line, color });
      }
    }
    // Show as many as fit (from the bottom)
    const maxFit = Math.floor((msgAreaBot - cy) / LINE_H);
    const startIdx = Math.max(0, allLines.length - maxFit);
    for (let i = startIdx; i < allLines.length; i++) {
      visibleLines.push(allLines[i]);
    }

    for (const { line, color } of visibleLines) {
      if (cy + LINE_H > msgAreaBot) break;
      push(scene.add.text(left + MSG_PAD, cy, line, {
        fontSize: '11px', color,
      }).setOrigin(0, 0).setScrollFactor(0).setDepth(DEPTH + 1));
      cy += LINE_H;
    }

    // Input bar background
    const inputY = this._by - INPUT_H / 2;
    push(scene.add.rectangle(this._cx, inputY, W, INPUT_H, 0x0d1a28, 1)
      .setScrollFactor(0).setDepth(DEPTH).setOrigin(0.5));
    push(scene.add.rectangle(this._cx, this._by - INPUT_H, W, 1, 0x3366aa, 0.4)
      .setScrollFactor(0).setDepth(DEPTH + 1).setOrigin(0.5, 0));

    // Prompt label
    push(scene.add.text(left + MSG_PAD, inputY, 'You:', {
      fontSize: '11px', color: '#668899',
    }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(DEPTH + 1));

    // Input text
    const inputText = this._busy ? '(waiting…)' : this._input;
    const inputColor = this._busy ? '#556677' : '#ffffff';
    this._inputObj = push(scene.add.text(left + 38, inputY, inputText, {
      fontSize: '11px', color: inputColor,
    }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(DEPTH + 1));

    // Cursor
    this._cursorObj = push(scene.add.text(
      left + 38 + this._inputObj.width + 2, inputY, '|', {
        fontSize: '11px', color: '#aaccff',
      },
    ).setOrigin(0, 0.5).setScrollFactor(0).setDepth(DEPTH + 1)
      .setVisible(!this._busy && this._cursorVisible));

    // Status (thinking indicator) — overlays input area
    this._statusObj = push(scene.add.text(this._cx, inputY, '', {
      fontSize: '10px', color: '#ffcc44', backgroundColor: '#00000088',
      padding: { x: 4, y: 2 },
    }).setOrigin(0.5, 0.5).setScrollFactor(0).setDepth(DEPTH + 2).setVisible(false));
  }

  _setStatus(msg) {
    if (this._statusObj) {
      this._statusObj.setText(msg).setVisible(!!msg);
    }
  }

  _refreshInput() {
    if (!this._inputObj) return;
    this._inputObj.setText(this._busy ? '(waiting…)' : this._input);
    if (this._cursorObj) {
      this._cursorObj.setX(this._inputObj.x + this._inputObj.width + 2);
    }
  }

  _refreshCursor() {
    if (!this._open || !this._cursorObj) return;
    this._cursorObj.setVisible(!this._busy && this._cursorVisible);
  }

  _clearObjects() {
    for (const o of this._objects) o.destroy();
    this._objects = [];
    this._inputObj   = null;
    this._cursorObj  = null;
    this._statusObj  = null;
  }

  _resetCloseTimer() {
    if (this._closeTimer) this._closeTimer.remove();
    this._closeTimer = this._scene.time.delayedCall(AUTO_CLOSE_MS, () => this.close());
  }

  _worldCtx() {
    const scene = this._scene;
    return {
      trees:    (scene.trees    ?? []).filter(t => !t._chopped).length,
      furnaces: (scene.furnaces ?? []).length,
      crates:   (scene.crates   ?? []).length,
    };
  }
}

// ── Autonomous thought trigger ─────────────────────────────────────────────────

/**
 * Fire-and-forget: ask the server to generate a thought for an NPC in response
 * to a world event, then show it as a bubble and apply emotion deltas.
 *
 * @param {NPC}    npc    — the NPC to think
 * @param {string} event  — human-readable event description
 */
export async function triggerNPCThought(npc, event) {
  if (!npc?.soul) return;
  try {
    const body = {
      npc_id: npc.id,
      soul:   npc.getSoulContext?.() ?? {},
      event,
    };
    const res = await fetch(THOUGHT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return;
    const data = await res.json();
    const thought = data.thought ?? '';
    const deltas  = data.emotion_deltas ?? {};
    if (thought) npc.showBubble?.(thought, 4000);
    npc.applyEmotionDeltas?.(deltas);
  } catch {
    // server offline or timed out — silently ignore
  }
}

// ── Text wrap helper ────────────────────────────────────────────────────────────

/**
 * Naively wrap text to fit within pixelWidth at fontSize 11px.
 * Assumes ~6.5px per character (close enough for monospace-ish fonts).
 */
function _wrapText(text, pixelWidth, _fontSize = 11) {
  const CHARS_PER_PX = 1 / 6.5;
  const maxChars     = Math.floor(pixelWidth * CHARS_PER_PX);
  const words        = text.split(' ');
  const lines        = [];
  let   current      = '';

  for (const word of words) {
    if ((current + (current ? ' ' : '') + word).length <= maxChars) {
      current = current ? `${current} ${word}` : word;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}


