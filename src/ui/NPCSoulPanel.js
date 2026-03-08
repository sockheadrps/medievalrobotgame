// NPCSoulPanel - HUD tab panel displaying the selected NPC's soul data.
// Shows high-level behavior spectrums, relationship stage, memory log,
// and recent actions/choices (intent log).

const DEPTH = 52;

// Layout - mirrors NPCCommandPanel zone constants
const ZONE_X = 350;
const ZONE_Y = 754;
const ZONE_W = 916;
const ZONE_H = 194;

// Four-column layout
const COL_GAP = 10;
const COL1_W = 210; // behavior spectrum + relationship
const COL2_W = 220; // archetype + manual controls
const COL3_W = 230; // memory
const COL4_W = ZONE_W - COL1_W - COL2_W - COL3_W - COL_GAP * 3; // actions

const COL1_X = ZONE_X;
const COL2_X = COL1_X + COL1_W + COL_GAP;
const COL3_X = COL2_X + COL2_W + COL_GAP;
const COL4_X = COL3_X + COL3_W + COL_GAP;

const PAD = 10;
const ROW_H = 18;
const HEADER_H = 22;
const LOG_SCROLL_STEP = 2;
const TRAIT_STEP = 0.05;

const COL_HEADER = '#88ccff';
const COL_VALUE = '#ddeeff';
const COL_DIM = '#445566';
const COL_MEMORY = '#aabb99';
const COL_MEM_DIM = '#44553a';
const COL_ACTION = '#ffd58a';
const COL_ACTION_DIM = '#5a4b30';

const REL_COLOR = {
  hostile: '#ff4444',
  wary: '#ffaa44',
  neutral: '#aabbcc',
  allied: '#44ffaa',
  devoted: '#88eeff',
};

export class NPCSoulPanel {
  constructor(scene) {
    this._scene = scene;
    this._visible = false;
    this._npc = null;
    this._objects = [];
    this._logScroll = { memory: 0, actions: 0 };
    this._lastLogCounts = { memory: 0, actions: 0 };
    this._scrollNpcId = null;
    this._showManualAdjust = false;

    scene.time.addEvent({
      delay: 500,
      loop: true,
      callback: () => {
        if (this._visible && this._npc) this._rebuild();
      },
    });
    scene.input.on('wheel', this._onWheel, this);
  }

  show() {
    this._visible = true;
    this._rebuild();
  }

  hide() {
    this._visible = false;
    this._clear();
  }

  setNPC(npc) {
    const nextId = npc?.id ?? null;
    if (this._scrollNpcId !== nextId) {
      this._scrollNpcId = nextId;
      this._logScroll.memory = 0;
      this._logScroll.actions = 0;
      this._lastLogCounts.memory = 0;
      this._lastLogCounts.actions = 0;
    }
    this._npc = npc;
    if (this._visible) this._rebuild();
  }

  isOpen() { return this._visible; }

  _clear() {
    for (const o of this._objects) o.destroy();
    this._objects = [];
  }

  _rebuild() {
    this._clear();
    if (!this._npc?.soul) return;

    this._npc.normalizeSoulState?.();

    const scene = this._scene;
    const push = (o) => { this._objects.push(o); return o; };
    const soul = this._npc.soul;
    const {
      personality = {},
      emotional_state = {},
      relationship = 'neutral',
      memory = [],
      intent_log = [],
    } = soul;
    const memoryEntries = memory.map((m) => (typeof m === 'string' ? m : (m?.event ?? ''))).filter(Boolean);
    const actionEntries = intent_log.map((i) => (typeof i === 'string' ? i : (i?.text ?? ''))).filter(Boolean);
    this._syncAutoScroll('memory', memoryEntries.length);
    this._syncAutoScroll('actions', actionEntries.length);

    const top = ZONE_Y + PAD;
    const bottom = ZONE_Y + ZONE_H - PAD;

    // Column 1 - two high-level behavior spectrums
    let y = top;
    push(scene.add.text(COL1_X + PAD, y, 'BEHAVIOR SPECTRUM', {
      fontSize: '10px', color: COL_HEADER, fontStyle: 'bold',
    }).setScrollFactor(0).setDepth(DEPTH));
    y += HEADER_H;

    const niceVsMean = this._niceVsMean(personality, emotional_state);
    const coopVsAggro = this._cooperateVsAggressive(personality, emotional_state);

    y = _drawSpectrumBar({
      scene,
      push,
      x: COL1_X + PAD,
      y,
      width: COL1_W - PAD * 2,
      leftLabel: 'Happy / Nice',
      rightLabel: 'Aggressive / Mean',
      value: niceVsMean,
      color: 0x66d0ff,
      onSet: (v) => this._setNiceVsMean(v),
    });

    y += 2;
    y = _drawSpectrumBar({
      scene,
      push,
      x: COL1_X + PAD,
      y,
      width: COL1_W - PAD * 2,
      leftLabel: 'Cooperative',
      rightLabel: 'Aggressive',
      value: coopVsAggro,
      color: 0xff8877,
      onSet: (v) => this._setCooperateVsAggressive(v),
    });

    y += 4;
    push(scene.add.text(COL1_X + PAD, y, 'RELATIONSHIP', {
      fontSize: '10px', color: COL_HEADER, fontStyle: 'bold',
    }).setScrollFactor(0).setDepth(DEPTH));
    y += HEADER_H - 4;

    push(scene.add.text(COL1_X + PAD, y, String(relationship).toUpperCase(), {
      fontSize: '14px', color: REL_COLOR[relationship] ?? '#aabbcc', fontStyle: 'bold',
    }).setScrollFactor(0).setDepth(DEPTH));

    // Column 2 - archetype + optional manual controls
    y = top;
    push(scene.add.text(COL2_X + PAD, y, 'SOUL PROFILE', {
      fontSize: '10px', color: COL_HEADER, fontStyle: 'bold',
    }).setScrollFactor(0).setDepth(DEPTH));
    const manualBtn = push(scene.add.text(COL2_X + COL2_W - PAD, y, this._showManualAdjust ? 'Hide +/-' : 'Manual +/-', {
      fontSize: '10px',
      color: '#88ccff',
      backgroundColor: '#102030',
      padding: { x: 4, y: 1 },
    }).setOrigin(1, 0).setScrollFactor(0).setDepth(DEPTH + 2));
    manualBtn.setInteractive({ useHandCursor: true });
    manualBtn.on('pointerdown', () => {
      this._showManualAdjust = !this._showManualAdjust;
      this._rebuild();
    });
    manualBtn.on('pointerover', () => manualBtn.setColor('#d6efff'));
    manualBtn.on('pointerout', () => manualBtn.setColor('#88ccff'));
    y += HEADER_H;

    push(scene.add.text(COL2_X + PAD, y, 'ARCHETYPE', {
      fontSize: '10px', color: COL_HEADER, fontStyle: 'bold',
    }).setScrollFactor(0).setDepth(DEPTH));
    y += HEADER_H - 4;

    push(scene.add.text(COL2_X + PAD, y, _inferArchetype(personality), {
      fontSize: '12px', color: '#ccddee', fontStyle: 'bold',
    }).setScrollFactor(0).setDepth(DEPTH));

    y += 24;
    if (!this._showManualAdjust) {
      push(scene.add.text(COL2_X + PAD, y, 'Click Manual +/- to fine tune traits and emotions.', {
        fontSize: '10px',
        color: '#557088',
        wordWrap: { width: COL2_W - PAD * 2 },
      }).setScrollFactor(0).setDepth(DEPTH));
    } else {
      const controls = [
        { label: 'Coop', type: 'personality', key: 'cooperation' },
        { label: 'Aggro', type: 'personality', key: 'aggression' },
        { label: 'Neuro', type: 'personality', key: 'neuroticism' },
        { label: 'Trust', type: 'emotion', key: 'trust' },
        { label: 'Fear', type: 'emotion', key: 'fear' },
        { label: 'Anger', type: 'emotion', key: 'anger' },
      ];
      for (const c of controls) {
        const val = c.type === 'personality'
          ? Number(personality?.[c.key] ?? 0)
          : Number(emotional_state?.[c.key] ?? 0);
        push(scene.add.text(COL2_X + PAD, y, c.label, {
          fontSize: '10px',
          color: COL_DIM,
        }).setScrollFactor(0).setDepth(DEPTH));
        push(scene.add.text(COL2_X + PAD + 54, y, `${Math.round(_clamp(val, 0, 1) * 100)}`, {
          fontSize: '10px',
          color: COL_VALUE,
        }).setScrollFactor(0).setDepth(DEPTH));
        if (c.type === 'personality') {
          this._addAdjustButtons(
            COL2_X + COL2_W - PAD - 20,
            y + Math.floor(ROW_H / 2),
            () => this._adjustPersonality(c.key, -TRAIT_STEP),
            () => this._adjustPersonality(c.key, TRAIT_STEP),
          );
        } else {
          this._addAdjustButtons(
            COL2_X + COL2_W - PAD - 20,
            y + Math.floor(ROW_H / 2),
            () => this._adjustEmotion(c.key, -TRAIT_STEP),
            () => this._adjustEmotion(c.key, TRAIT_STEP),
          );
        }
        y += ROW_H + 1;
      }
    }

    // Column 3 - memory
    y = top;
    _drawLogColumn({
      scene,
      push,
      x: COL3_X + PAD,
      y,
      bottom,
      width: COL3_W - PAD * 2,
      title: 'MEMORY',
      emptyText: 'No memories yet.',
      color: COL_MEMORY,
      dimColor: COL_MEM_DIM,
      entries: memoryEntries,
      scrollOffset: this._logScroll.memory,
    });

    // Column 4 - actions/choices
    y = top;
    _drawLogColumn({
      scene,
      push,
      x: COL4_X + PAD,
      y,
      bottom,
      width: COL4_W - PAD * 2,
      title: 'ACTIONS / CHOICES',
      emptyText: 'No actions logged yet.',
      color: COL_ACTION,
      dimColor: COL_ACTION_DIM,
      entries: actionEntries,
      scrollOffset: this._logScroll.actions,
    });
  }

  _syncAutoScroll(key, count) {
    const prev = this._lastLogCounts[key] ?? 0;
    if (count > prev) this._logScroll[key] = 0;
    this._lastLogCounts[key] = count;
  }

  _adjustPersonality(key, delta) {
    if (!this._npc?.soul) return;
    const cur = Number(this._npc.soul?.personality?.[key] ?? 0);
    const next = _clamp(cur + delta, 0, 1);
    if (typeof this._npc.setSoulPersonality === 'function') {
      this._npc.setSoulPersonality(key, next);
    } else {
      this._npc.soul.personality[key] = next;
    }
    this._rebuild();
  }

  _adjustEmotion(key, delta) {
    if (!this._npc?.soul) return;
    const cur = Number(this._npc.soul?.emotional_state?.[key] ?? 0);
    const next = _clamp(cur + delta, 0, 1);
    if (typeof this._npc.setSoulEmotion === 'function') {
      this._npc.setSoulEmotion(key, next);
    } else {
      this._npc.soul.emotional_state[key] = next;
    }
    this._rebuild();
  }

  _niceVsMean(personality, emotionalState) {
    const trust = _clamp(Number(emotionalState?.trust ?? 0), 0, 1);
    const anger = _clamp(Number(emotionalState?.anger ?? 0), 0, 1);
    const fear = _clamp(Number(emotionalState?.fear ?? 0), 0, 1);
    // Emotion-only axis so this slider is independent from personality slider.
    const nice = _clamp((trust * 0.75) + ((1 - fear) * 0.25), 0, 1);
    const mean = _clamp((anger * 0.8) + ((1 - trust) * 0.2), 0, 1);
    return _clamp(0.5 + (mean - nice) * 0.5, 0, 1);
  }

  _cooperateVsAggressive(personality, emotionalState) {
    const cooperation = _clamp(Number(personality?.cooperation ?? 0), 0, 1);
    const aggression = _clamp(Number(personality?.aggression ?? 0), 0, 1);
    const neuroticism = _clamp(Number(personality?.neuroticism ?? 0), 0, 1);
    // Personality-only axis so this slider is independent from emotion slider.
    const cooperative = _clamp((cooperation * 0.8) + ((1 - neuroticism) * 0.2), 0, 1);
    const aggressive = _clamp((aggression * 0.85) + (neuroticism * 0.15), 0, 1);
    return _clamp(0.5 + (aggressive - cooperative) * 0.5, 0, 1);
  }

  _setNiceVsMean(value) {
    if (!this._npc?.soul) return;
    const v = _clamp(Number(value ?? 0.5), 0, 1);
    // Emotion-only writes.
    this._setSoulEmotionValue('trust', _clamp(0.95 - (v * 0.9), 0, 1));
    this._setSoulEmotionValue('anger', _clamp(v * 0.95, 0, 1));
    this._setSoulEmotionValue('fear', _clamp(0.15 + (v * 0.35), 0, 1));
    this._rebuild();
  }

  _setCooperateVsAggressive(value) {
    if (!this._npc?.soul) return;
    const v = _clamp(Number(value ?? 0.5), 0, 1);
    // Personality-only writes.
    this._setSoulPersonalityValue('cooperation', _clamp(1 - v, 0, 1));
    this._setSoulPersonalityValue('aggression', _clamp(v, 0, 1));
    this._setSoulPersonalityValue('neuroticism', _clamp(0.2 + (v * 0.55), 0, 1));
    this._rebuild();
  }

  _setSoulPersonalityValue(key, value) {
    if (!this._npc?.soul) return;
    const next = _clamp(Number(value ?? 0), 0, 1);
    if (typeof this._npc.setSoulPersonality === 'function') {
      this._npc.setSoulPersonality(key, next);
    } else {
      this._npc.soul.personality[key] = next;
    }
  }

  _setSoulEmotionValue(key, value) {
    if (!this._npc?.soul) return;
    const next = _clamp(Number(value ?? 0), 0, 1);
    if (typeof this._npc.setSoulEmotion === 'function') {
      this._npc.setSoulEmotion(key, next);
    } else {
      this._npc.soul.emotional_state[key] = next;
    }
  }

  _addAdjustButtons(xRight, yMid, onDec, onInc) {
    const scene = this._scene;
    const push = (o) => { this._objects.push(o); return o; };
    const mkBtn = (x, label, onClick) => {
      const btn = push(scene.add.text(x, yMid, label, {
        fontSize: '11px',
        color: '#aaccff',
        backgroundColor: '#101a24',
        padding: { x: 2, y: 0 },
      }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 2));
      btn.setInteractive({ useHandCursor: true });
      btn.on('pointerdown', onClick);
      btn.on('pointerover', () => btn.setColor('#ffffff'));
      btn.on('pointerout', () => btn.setColor('#aaccff'));
    };
    mkBtn(xRight - 12, '-', onDec);
    mkBtn(xRight + 4, '+', onInc);
  }

  _onWheel(pointer, _gameObjects, _dx, dy) {
    if (!this._visible || !this._npc?.soul) return;
    const colY = ZONE_Y + PAD + HEADER_H;
    const colBottom = ZONE_Y + ZONE_H - PAD;
    if (pointer.y < colY || pointer.y > colBottom) return;

    const memoryX = COL3_X + PAD;
    const memoryW = COL3_W - PAD * 2;
    const actionsX = COL4_X + PAD;
    const actionsW = COL4_W - PAD * 2;

    let key = null;
    let count = 0;
    if (pointer.x >= memoryX && pointer.x <= memoryX + memoryW) {
      key = 'memory';
      count = (this._npc.soul.memory ?? []).filter((m) => (typeof m === 'string' ? m : m?.event)).length;
    } else if (pointer.x >= actionsX && pointer.x <= actionsX + actionsW) {
      key = 'actions';
      count = (this._npc.soul.intent_log ?? []).filter((i) => (typeof i === 'string' ? i : i?.text)).length;
    }
    if (!key) return;

    const rowsVisible = Math.max(1, Math.floor((colBottom - colY) / ROW_H));
    const maxOffset = Math.max(0, count - rowsVisible);
    if (maxOffset <= 0) return;

    const dir = dy > 0 ? 1 : -1;
    this._logScroll[key] = _clamp((this._logScroll[key] ?? 0) + dir * LOG_SCROLL_STEP, 0, maxOffset);
    this._rebuild();
  }
}

function _drawLogColumn({ scene, push, x, y, bottom, width, title, emptyText, color, dimColor, entries, scrollOffset = 0 }) {
  push(scene.add.text(x, y, title, {
    fontSize: '10px', color: COL_HEADER, fontStyle: 'bold',
  }).setScrollFactor(0).setDepth(DEPTH));
  y += HEADER_H;

  const clean = entries.filter(Boolean);
  if (clean.length === 0) {
    push(scene.add.text(x, y, emptyText, {
      fontSize: '10px', color: dimColor,
    }).setScrollFactor(0).setDepth(DEPTH));
    return;
  }

  const rowsVisible = Math.max(1, Math.floor((bottom - y) / ROW_H));
  const maxOffset = Math.max(0, clean.length - rowsVisible);
  const appliedOffset = _clamp(scrollOffset, 0, maxOffset);
  const start = Math.max(0, clean.length - rowsVisible - appliedOffset);
  const end = Math.min(clean.length, start + rowsVisible);
  const maxChars = Math.max(12, Math.floor(width / 6));
  for (let idx = start; idx < end; idx++) {
    if (y + ROW_H > bottom) break;
    const entry = clean[idx];
    const text = String(entry).trim();
    const clipped = text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
    push(scene.add.text(x, y, `- ${clipped}`, {
      fontSize: '10px', color,
    }).setScrollFactor(0).setDepth(DEPTH));
    y += ROW_H;
  }
}

function _drawSpectrumBar({ scene, push, x, y, width, leftLabel, rightLabel, value, color, onSet = null }) {
  push(scene.add.text(x, y, leftLabel, { fontSize: '9px', color: '#6699aa' })
    .setScrollFactor(0).setDepth(DEPTH));
  push(scene.add.text(x + width, y, rightLabel, { fontSize: '9px', color: '#aa7766' })
    .setOrigin(1, 0).setScrollFactor(0).setDepth(DEPTH));
  y += 11;

  const trackY = y + 4;
  const trackH = 10;
  push(scene.add.rectangle(x + width / 2, trackY, width, trackH, 0x0a1018, 1)
    .setStrokeStyle(1, 0x1a2a3a)
    .setScrollFactor(0).setDepth(DEPTH).setOrigin(0.5));
  push(scene.add.rectangle(x + width / 2, trackY, 1, trackH + 2, 0x244055, 1)
    .setScrollFactor(0).setDepth(DEPTH + 1).setOrigin(0.5));

  const pos = x + _clamp(value, 0, 1) * width;
  push(scene.add.circle(pos, trackY, 5, color, 1)
    .setStrokeStyle(1, 0x031018)
    .setScrollFactor(0).setDepth(DEPTH + 2).setOrigin(0.5));
  push(scene.add.text(x + width + 6, y - 1, `${Math.round(_clamp(value, 0, 1) * 100)}`, {
    fontSize: '10px', color: COL_VALUE,
  }).setScrollFactor(0).setDepth(DEPTH));

  if (typeof onSet === 'function') {
    const hit = push(scene.add.rectangle(x + width / 2, trackY, width + 10, trackH + 8, 0x000000, 0)
      .setScrollFactor(0).setDepth(DEPTH + 3).setOrigin(0.5));
    hit.setInteractive({ useHandCursor: true });
    const apply = (pointer) => {
      const px = Number(pointer?.x ?? x);
      const v = _clamp((px - x) / width, 0, 1);
      onSet(v);
    };
    hit.on('pointerdown', apply);
    hit.on('pointermove', (pointer) => {
      if (!pointer?.isDown) return;
      apply(pointer);
    });
  }
  return y + 14;
}

function _inferArchetype(p) {
  if (!p) return 'Unknown';
  const { cooperation = 0.5, aggression = 0.5, neuroticism = 0.5 } = p;
  if (cooperation >= 0.7 && aggression < 0.4) return 'Friendly';
  if (aggression >= 0.7 && neuroticism >= 0.6) return 'Volatile';
  if (aggression >= 0.7 && neuroticism < 0.4) return 'Aggressive';
  if (neuroticism >= 0.7 && cooperation < 0.5) return 'Anxious';
  if (neuroticism < 0.3 && aggression < 0.4) return 'Stoic';
  return 'Balanced';
}

function _clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
