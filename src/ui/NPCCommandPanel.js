// NPCCommandPanel — NPC job programming interface.
//
// Layout (fits the HUD right zone: x=350, y=754, w=916, h=194):
//
//  [Idle] [Follow] [Patrol] [Attack]          ← quick one-shot commands
//  ┌─ JOB STEPS (scrollable) ──────────────┬─ ASSIGNED TARGETS ──────────────┐
//  │ 1. Gather  [Wood]  Stop: off          │ Trees:     [oak_1] ×            │
//  │ 2. Deposit [Wood]                     │ Rocks:     none                 │
//  │ 3. Maintain furnace [5]               │ Crates:    [crate_A] ×          │
//  │ [+ Add Step ▼]  [▶ Apply]  [✕ Clear] │ Furnace:   [furnace_1] ×        │
//  └───────────────────────────────────────┴─────────────────────────────────┘
//
// Steps compile to a script_loop (or loop task for special presets like arrows).
// Quick commands apply instantly without touching the step list.

const DEPTH = 52;

// ── Zone layout ─────────────────────────────────────────────────────────────
const ZONE_X = 350;
const ZONE_Y = 754;
const ZONE_W = 916;
const ZONE_H = 194;

// Quick-command bar
const QC_Y    = ZONE_Y + 4;
const QC_H    = 22;

// Two-column split below the quick bar
const SPLIT_Y = QC_Y + QC_H + 4;
const SPLIT_H = ZONE_H - (SPLIT_Y - ZONE_Y) - 4;
const LEFT_W  = 570;
const RIGHT_X = ZONE_X + LEFT_W + 8;
const RIGHT_W = ZONE_W - LEFT_W - 12;

// Step rows
const STEP_H      = 28;
const FOOTER_H    = 26;

// ── Data constants ───────────────────────────────────────────────────────────
const GATHER_ITEMS   = ['wood', 'coal', 'copperore', 'tinore', 'goldore'];
const DEPOSIT_ITEMS  = ['Wood', 'Coal', 'CopperOre', 'TinOre', 'GoldOre',
                        'IronBar', 'SteelBar', 'BronzeBar', 'IronArrowhead', 'Arrow', 'Feather'];
const QTY_CHOICES    = [1, 5, 10, 20, 50];
const THRESH_CHOICES = [3, 5, 8, 10];
const FW_CHOICES     = [10, 20, 30, 40, 50];
const COND_KINDS     = ['inv_gte', 'target_lte', 'target_gte'];
const COND_LABELS    = { inv_gte: 'NPC has ≥', target_lte: 'Object ≤', target_gte: 'Object ≥' };

// Step action types
const STEP_TYPES = [
  { id: 'gather',    label: 'Gather' },
  { id: 'deposit',   label: 'Deposit' },
  { id: 'withdraw',  label: 'Withdraw' },
  { id: 'maintain',  label: 'Fuel furnace' },
  { id: 'flywheel',  label: 'Flywheels' },
  { id: 'smelt',     label: 'Wait/smelt' },
  { id: 'attack',    label: 'Attack enemies' },
  { id: 'follow',    label: 'Follow player' },
];

// Preset programs (each returns an array of step objects)
const PRESETS = [
  {
    label: 'Gather wood → deposit',
    steps: () => [
      makeStep('gather', { gatherItem: 'wood' }),
      makeStep('deposit', { itemKey: 'Wood' }),
    ],
  },
  {
    label: 'Fuel furnace loop',
    steps: () => [
      makeStep('maintain', { threshold: 5, reserveQty: 10 }),
      makeStep('gather', { gatherItem: 'wood' }),
    ],
  },
  {
    label: 'Keep flywheels charged',
    steps: () => [
      makeStep('flywheel', { flywheelMin: 20 }),
    ],
  },
  {
    label: 'Mine ore → deposit',
    steps: () => [
      makeStep('gather', { gatherItem: 'copperore' }),
      makeStep('deposit', { itemKey: 'CopperOre' }),
    ],
  },
  {
    label: 'Make arrows (full loop)',
    _isArrowLoop: true,
    steps: () => [],  // handled specially — emits a loop task
  },
  {
    label: 'Smelt loop (fill + wait)',
    steps: () => [
      makeStep('gather', { gatherItem: 'wood' }),
      makeStep('maintain', { threshold: 5, reserveQty: 10 }),
      makeStep('smelt', {}),
    ],
  },
];

function makeStep(action, overrides = {}) {
  return {
    action,
    gatherItem:  overrides.gatherItem  ?? 'wood',
    itemKey:     overrides.itemKey     ?? 'Wood',
    qty:         overrides.qty         ?? 10,
    threshold:   overrides.threshold   ?? 5,
    reserveQty:  overrides.reserveQty  ?? 10,
    flywheelMin: overrides.flywheelMin ?? 20,
    // Stop-when condition
    stopEnabled: false,
    stopKind:    'inv_gte',
    stopItem:    'Wood',
    stopQty:     10,
  };
}

// ── Colour helpers ───────────────────────────────────────────────────────────
const C = {
  bg:          0x080e16,
  bgStep:      0x0c1824,
  bgStepHover: 0x102030,
  stroke:      0x1e3a52,
  strokeHi:    0x4080b0,
  btnFill:     0x0e1e30,
  btnStroke:   0x2a4a6a,
  btnText:     '#9ec8e8',
  btnGreen:    { fill: 0x0e2818, stroke: 0x2a6a40, text: '#8feea8' },
  btnRed:      { fill: 0x281010, stroke: 0x6a2a2a, text: '#ee8f8f' },
  btnBlue:     { fill: 0x0e1e40, stroke: 0x2a4aaa, text: '#8faaf0' },
  quickFill:   0x0a1828,
  quickStroke: 0x224466,
  quickText:   '#7aabcc',
  label:       '#5a7a96',
  labelHi:     '#9ec8e8',
  accent:      '#4a9fd4',
  dimText:     '#3a5568',
  tagFill:     0x0e2030,
  tagStroke:   0x2a5070,
  tagText:     '#7ab8d8',
  tagX:        '#c06060',
};

export class NPCCommandPanel {
  constructor(scene, zone, getSelectedNPC) {
    this._scene          = scene;
    this._zone           = zone;           // kept for compat but we use fixed constants
    this._getSelectedNPC = getSelectedNPC;
    this._visible        = false;
    this._npc            = null;

    // Per-NPC state: { steps: [...], assigned: { trees, mine_rocks, crates, flywheels, furnace } }
    this._stateByNpc = new Map();

    this._objects      = [];
    this._presetOpen   = false;   // is the preset dropdown visible?
    this._stopOpen     = -1;      // which step index has stop-condition expanded (-1 = none)
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  show() {
    const npc = this._getSelectedNPC?.();
    if (!npc) { this.hide(); return; }
    this._npc     = npc;
    this._visible = true;
    this._ensureState(npc);
    this._render();
  }

  hide() {
    this._visible   = false;
    this._npc       = null;
    this._presetOpen = false;
    this._stopOpen   = -1;
    this._clear();
  }

  isOpen() { return this._visible; }

  /**
   * Called by GameScene when the player Ctrl+Clicks a world object while this
   * panel is open. Routes the object to the correct target bucket.
   * Returns true if consumed.
   */
  handleCtrlClicked(type, obj) {
    if (!this._visible || !this._npc) return false;
    const st = this._stateByNpc.get(this._npc.id);
    if (!st) return false;

    const a = st.assigned;
    if (type === 'tree') {
      if (!a.trees.includes(obj)) { a.trees.push(obj); this._npc.assignTarget('tree', obj); }
    } else if (type === 'mine_rock') {
      if (!a.mine_rocks.includes(obj)) { a.mine_rocks.push(obj); this._npc.assignTarget('mine_rock', obj); }
    } else if (type === 'crate') {
      if (!a.crates.includes(obj)) { a.crates.push(obj); this._npc.assignTarget('crate', obj); }
    } else if (type === 'furnace') {
      a.furnace = obj; this._npc.assignTarget('furnace', obj);
    } else if (type === 'flywheel') {
      if (!a.flywheels.includes(obj)) { a.flywheels.push(obj); this._npc.assignTarget('flywheel', obj); }
    } else {
      return false;
    }

    this._render();
    return true;
  }

  // ── State management ───────────────────────────────────────────────────────

  _ensureState(npc) {
    if (!this._stateByNpc.has(npc.id)) {
      // Seed assigned targets from whatever's already on the NPC
      const at = npc.assignedTargets ?? {};
      this._stateByNpc.set(npc.id, {
        steps: [makeStep('gather'), makeStep('deposit')],
        assigned: {
          trees:      [...(at.trees      ?? [])],
          mine_rocks: [...(at.mine_rocks ?? [])],
          crates:     [...(at.crates     ?? [])],
          flywheels:  [...(at.flywheels  ?? [])],
          furnace:    at.furnace ?? null,
        },
      });
    }
  }

  _getState() {
    return this._stateByNpc.get(this._npc?.id);
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  _clear() {
    for (const o of this._objects) o.destroy();
    this._objects = [];
  }

  _render() {
    this._clear();
    if (!this._visible || !this._npc) return;

    const st = this._getState();
    if (!st) return;

    // ── Header label ──
    this._text(ZONE_X + 4, ZONE_Y + 2, `NPC: ${this._npc.id}`, '#4a7a96', '10px');

    // ── Quick commands bar ──
    this._drawQuickBar();

    // ── Two-column layout ──
    this._drawStepsPanel(st);
    this._drawTargetsPanel(st);

    // ── Preset dropdown (on top of everything) ──
    if (this._presetOpen) this._drawPresetMenu(st);
  }

  // ── Quick commands ─────────────────────────────────────────────────────────

  _drawQuickBar() {
    const cmds = [
      { label: 'Idle',        action: () => this._quickCmd([{ task: 'idle' }]) },
      { label: 'Follow me',   action: () => this._quickCmd([{ task: 'follow' }]) },
      { label: 'Patrol here', action: () => this._quickCmd([{ task: 'patrol_area', x: this._npc.x, y: this._npc.y, range: 192 }]) },
      { label: 'Attack nearest', action: () => this._quickCmd([{ task: 'attack_nearest_enemy', range: 480 }]) },
      { label: 'Defend player',  action: () => this._quickCmd([{ task: 'defend_player', range: 192 }]) },
    ];

    let x = ZONE_X + 4;
    for (const cmd of cmds) {
      const w = cmd.label.length * 7 + 14;
      this._btn(x, QC_Y, w, QC_H, cmd.label, cmd.action,
        C.quickFill, C.quickStroke, C.quickText);
      x += w + 4;
    }
  }

  _quickCmd(tasks) {
    const npc = this._npc;
    if (!npc) return;
    npc.taskRunner?.setTasks(tasks);
    npc.showBubble(tasks[0].task === 'idle' ? 'Standing by.' :
                   tasks[0].task === 'follow' ? 'On your heels!' :
                   tasks[0].task === 'patrol_area' ? 'Patrolling…' :
                   tasks[0].task === 'attack_nearest_enemy' ? 'Engaging!' :
                   'Defending!');
  }

  // ── Steps panel (left column) ─────────────────────────────────────────────

  _drawStepsPanel(st) {
    const x  = ZONE_X + 2;
    const y  = SPLIT_Y;
    const w  = LEFT_W - 4;
    const h  = SPLIT_H;

    // Background
    this._rect(x, y, w, h, C.bg, C.stroke);

    const steps = st.steps;
    const areaBot = y + h - FOOTER_H - 2; // bottom edge available for step rows

    // Draw steps, tracking actual y cursor (expanded stop rows take 2× height)
    let cy = y + 2;
    let drawn = 0;
    for (let i = 0; i < steps.length; i++) {
      const rowH = (this._stopOpen === i && !steps[i]._isArrowLoop) ? STEP_H * 2 : STEP_H;
      if (cy + rowH > areaBot) break; // no room for this row
      this._drawStep(st, i, x + 2, cy, w - 4);
      cy += rowH;
      drawn++;
    }

    // Footer: Add / Presets / Apply / Clear
    const fy = y + h - FOOTER_H + 3;

    // + Add Step (blank)
    this._btn(x + 4, fy, 80, 20, '+ Blank', () => {
      st.steps.push(makeStep('gather'));
      this._stopOpen = -1;
      this._presetOpen = false;
      this._render();
    }, C.btnFill, C.btnStroke, C.btnText);

    // Presets dropdown toggle
    const presetActive = this._presetOpen;
    this._btn(x + 88, fy, 88, 20, '+ Preset ▾',
      () => { this._presetOpen = !this._presetOpen; this._render(); },
      presetActive ? 0x102040 : C.btnFill,
      presetActive ? 0x4070c0 : C.btnStroke,
      presetActive ? '#aad4ff' : C.btnText);

    // Apply
    this._btn(x + 184, fy, 70, 20, '▶ Apply', () => this._apply(st),
      C.btnGreen.fill, C.btnGreen.stroke, C.btnGreen.text);

    // Clear
    this._btn(x + 260, fy, 60, 20, '✕ Clear', () => {
      st.steps = [];
      this._stopOpen = -1;
      this._presetOpen = false;
      this._render();
    }, C.btnRed.fill, C.btnRed.stroke, C.btnRed.text);

    // Step count hint when some steps are hidden
    if (drawn < steps.length) {
      this._text(x + 330, fy + 10,
        `+${steps.length - drawn} more (scroll not yet supported)`,
        C.dimText, '9px');
    }
  }

  _drawStep(st, i, x, y, w) {
    const step = st.steps[i];

    // Special sentinel: arrow production loop (applied as a goal-based loop task)
    if (step._isArrowLoop) {
      this._rect(x, y, w, STEP_H - 2, 0x0e2010, 0x2a6a30);
      this._text(x + 4, y + STEP_H / 2, '⟳  Make arrows (full loop) — preset', '#7adfa0', '10px', 0, 0.5);
      return;
    }

    const stopExpanded = this._stopOpen === i;
    const rowH = stopExpanded ? STEP_H * 2 : STEP_H;

    // Row background
    this._rect(x, y, w, rowH - 2, C.bgStep, stopExpanded ? C.strokeHi : 0x0);

    // Step number
    this._text(x + 4, y + STEP_H / 2, `${i + 1}.`, C.label, '10px', 0, 0.5);

    let cx = x + 22;

    // Action type cycle button
    const actionDef = STEP_TYPES.find(s => s.id === step.action) ?? STEP_TYPES[0];
    const actionW = 82;
    this._btn(cx, y + 4, actionW, 20, actionDef.label, () => {
      const idx = STEP_TYPES.findIndex(s => s.id === step.action);
      step.action = STEP_TYPES[(idx + 1) % STEP_TYPES.length].id;
      this._render();
    });
    cx += actionW + 4;

    // Action-specific params
    cx = this._drawStepParams(step, i, x, y, cx, w);

    // Stop-when toggle (right side)
    const stopW = stopExpanded ? 76 : 60;
    const stopX = x + w - stopW - 2;
    this._btn(stopX, y + 4, stopW, 20,
      stopExpanded ? 'Stop ▲' : (step.stopEnabled ? 'Stop: on' : 'Stop: off'),
      () => {
        if (this._stopOpen === i) { this._stopOpen = -1; }
        else { this._stopOpen = i; }
        this._render();
      },
      step.stopEnabled ? 0x102820 : C.btnFill,
      step.stopEnabled ? 0x2a6a40 : C.btnStroke,
      step.stopEnabled ? '#8feea8' : C.btnText);

    // Delete button (x) — only if more than one step
    if (st.steps.length > 1) {
      this._btn(x + w - stopW - 26, y + 4, 20, 20, '×', () => {
        st.steps.splice(i, 1);
        if (this._stopOpen === i) this._stopOpen = -1;
        else if (this._stopOpen > i) this._stopOpen--;
        this._render();
      }, C.btnRed.fill, C.btnRed.stroke, C.btnRed.text);
    }

    // Stop-when condition row (expanded)
    if (stopExpanded) {
      this._drawStopCondition(step, x + 22, y + STEP_H, w - 24);
    }
  }

  _drawStepParams(step, _i, rowX, rowY, cx, rowW) {
    const y   = rowY + 4;
    // Right edge: leave room for stop toggle (60) + delete (20) + gaps
    const maxCx = rowX + rowW - 88;

    if (step.action === 'gather') {
      const w = 90;
      if (cx + w <= maxCx) {
        this._btn(cx, y, w, 20, _cap(step.gatherItem), () => {
          const idx = GATHER_ITEMS.indexOf(step.gatherItem);
          step.gatherItem = GATHER_ITEMS[(idx + 1) % GATHER_ITEMS.length];
          this._render();
        });
        cx += w + 4;
      }
    } else if (step.action === 'deposit' || step.action === 'withdraw') {
      const iw = 100;
      if (cx + iw <= maxCx) {
        this._btn(cx, y, iw, 20, step.itemKey, () => {
          const idx = DEPOSIT_ITEMS.indexOf(step.itemKey);
          step.itemKey = DEPOSIT_ITEMS[(idx + 1) % DEPOSIT_ITEMS.length];
          this._render();
        });
        cx += iw + 4;
      }
      if (step.action === 'withdraw') {
        const qw = 52;
        if (cx + qw <= maxCx) {
          this._btn(cx, y, qw, 20, `× ${step.qty}`, () => {
            const idx = QTY_CHOICES.indexOf(step.qty);
            step.qty = QTY_CHOICES[(idx + 1) % QTY_CHOICES.length];
            this._render();
          });
          cx += qw + 4;
        }
      }
    } else if (step.action === 'maintain') {
      const tw = 62;
      const rw = 62;
      if (cx + tw <= maxCx) {
        this._btn(cx, y, tw, 20, `Min: ${step.threshold}`, () => {
          const idx = THRESH_CHOICES.indexOf(step.threshold);
          step.threshold = THRESH_CHOICES[(idx + 1) % THRESH_CHOICES.length];
          this._render();
        });
        cx += tw + 4;
      }
      if (cx + rw <= maxCx) {
        this._btn(cx, y, rw, 20, `Carry: ${step.reserveQty}`, () => {
          const idx = QTY_CHOICES.indexOf(step.reserveQty);
          step.reserveQty = QTY_CHOICES[(idx + 1) % QTY_CHOICES.length];
          this._render();
        });
        cx += rw + 4;
      }
    } else if (step.action === 'flywheel') {
      const fw = 72;
      if (cx + fw <= maxCx) {
        this._btn(cx, y, fw, 20, `Min: ${step.flywheelMin}%`, () => {
          const idx = FW_CHOICES.indexOf(step.flywheelMin);
          step.flywheelMin = FW_CHOICES[(idx + 1) % FW_CHOICES.length];
          this._render();
        });
        cx += fw + 4;
      }
    }
    // smelt / attack / follow have no extra params

    return cx;
  }

  _drawStopCondition(step, x, y, _w) {
    // Enable toggle
    this._btn(x, y + 4, 56, 18, step.stopEnabled ? 'ON' : 'OFF', () => {
      step.stopEnabled = !step.stopEnabled;
      this._render();
    }, step.stopEnabled ? C.btnGreen.fill : C.btnFill,
       step.stopEnabled ? C.btnGreen.stroke : C.btnStroke,
       step.stopEnabled ? C.btnGreen.text : C.dimText);

    const disabled = !step.stopEnabled;
    const dimC = disabled ? C.dimText : C.btnText;

    // "Stop when:" label
    this._text(x + 62, y + 13, 'Stop when:', C.label, '9px', 0, 0.5);

    // Kind
    let cx = x + 122;
    const kindW = 80;
    this._btn(cx, y + 4, kindW, 18, COND_LABELS[step.stopKind] ?? step.stopKind, () => {
      if (disabled) return;
      const idx = COND_KINDS.indexOf(step.stopKind);
      step.stopKind = COND_KINDS[(idx + 1) % COND_KINDS.length];
      this._render();
    }, C.btnFill, disabled ? 0x111820 : C.btnStroke, dimC);
    cx += kindW + 4;

    // Item
    const itemW = 96;
    this._btn(cx, y + 4, itemW, 18, step.stopItem, () => {
      if (disabled) return;
      const idx = DEPOSIT_ITEMS.indexOf(step.stopItem);
      step.stopItem = DEPOSIT_ITEMS[(idx + 1) % DEPOSIT_ITEMS.length];
      this._render();
    }, C.btnFill, disabled ? 0x111820 : C.btnStroke, dimC);
    cx += itemW + 4;

    // Qty
    const qtyW = 44;
    this._btn(cx, y + 4, qtyW, 18, `${step.stopQty}`, () => {
      if (disabled) return;
      const idx = QTY_CHOICES.indexOf(step.stopQty);
      step.stopQty = QTY_CHOICES[(idx + 1) % QTY_CHOICES.length];
      this._render();
    }, C.btnFill, disabled ? 0x111820 : C.btnStroke, dimC);
  }

  // ── Preset dropdown ────────────────────────────────────────────────────────

  _drawPresetMenu(st) {
    const menuX = ZONE_X + 88 + 4;
    const menuY = SPLIT_Y + SPLIT_H - FOOTER_H - PRESETS.length * 22 - 4;
    const menuW = 200;
    const menuH = PRESETS.length * 22 + 6;

    // Backdrop
    this._rect(menuX, menuY, menuW, menuH, 0x06101a, C.strokeHi);

    for (let i = 0; i < PRESETS.length; i++) {
      const p = PRESETS[i];
      const py = menuY + 3 + i * 22;
      this._btn(menuX + 2, py, menuW - 4, 20, p.label, () => {
        this._applyPreset(st, p);
        this._presetOpen = false;
        this._render();
      }, 0x0a1824, 0x1a3a54, '#9ecce8');
    }
  }

  _applyPreset(st, preset) {
    if (preset._isArrowLoop) {
      // Special: the arrow production loop is a goal-based loop, applied directly.
      // We record it as a sentinel step so the UI can display it.
      st.steps = [{ action: '__arrow_loop__', _isArrowLoop: true }];
    } else {
      st.steps = preset.steps();
    }
    this._stopOpen = -1;
  }

  // ── Targets panel (right column) ──────────────────────────────────────────

  _drawTargetsPanel(st) {
    const x = RIGHT_X;
    const y = SPLIT_Y;
    const w = RIGHT_W;
    const h = SPLIT_H;

    this._rect(x, y, w, h, C.bg, C.stroke);
    this._text(x + 6, y + 8, 'ASSIGNED TARGETS', C.accent, '9px');
    this._text(x + 6, y + h - 8, 'Ctrl+Click world objects to assign', C.dimText, '9px', 0, 1);

    const a = st.assigned;
    const rows = [
      { label: 'Trees',    items: a.trees,      type: 'trees',      namer: o => o._cfg?.label ?? 'tree' },
      { label: 'Rocks',    items: a.mine_rocks,  type: 'mine_rocks', namer: o => o.rockType ?? 'rock' },
      { label: 'Crates',   items: a.crates,      type: 'crates',     namer: o => o._cfg?.label ?? 'crate' },
      { label: 'Flywheels',items: a.flywheels,   type: 'flywheels',  namer: o => o._cfg?.label ?? 'flywheel' },
      { label: 'Furnace',  items: a.furnace ? [a.furnace] : [], type: 'furnace', namer: o => o._cfg?.label ?? 'furnace' },
    ];

    const rowH = (h - 24 - 16) / rows.length;

    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri];
      const ry  = y + 18 + ri * rowH;

      // Label
      this._text(x + 6, ry + rowH / 2, `${row.label}:`, C.label, '9px', 0, 0.5);

      const labelW = 54;
      let tx = x + labelW;

      if (row.items.length === 0) {
        this._text(tx, ry + rowH / 2, 'none', C.dimText, '9px', 0, 0.5);
      } else {
        for (let ii = 0; ii < row.items.length; ii++) {
          const obj  = row.items[ii];
          const name = row.namer(obj);
          const tagW = Math.min(name.length * 6 + 18, 90);

          if (tx + tagW > x + w - 6) break; // no room

          // Tag background
          this._rect(tx, ry + 3, tagW, rowH - 6, C.tagFill, C.tagStroke);

          // Object name
          this._text(tx + 4, ry + rowH / 2, name, C.tagText, '8px', 0, 0.5);

          // × remove button
          const removeIdx = ii;
          const removeType = row.type;
          this._textBtn(tx + tagW - 12, ry + rowH / 2, '×', C.tagX, '10px',
            () => {
              if (removeType === 'furnace') {
                a.furnace = null;
              } else {
                a[removeType].splice(removeIdx, 1);
              }
              this._render();
            });

          tx += tagW + 3;
        }
      }
    }
  }

  // ── Apply ─────────────────────────────────────────────────────────────────

  _apply(st) {
    const npc = this._getSelectedNPC?.();
    if (!npc) return;

    // Push assigned targets onto the NPC
    npc.assignedTargets.trees      = [...st.assigned.trees];
    npc.assignedTargets.mine_rocks = [...st.assigned.mine_rocks];
    npc.assignedTargets.crates     = [...st.assigned.crates];
    npc.assignedTargets.flywheels  = [...st.assigned.flywheels];
    npc.assignedTargets.furnace    = st.assigned.furnace;
    npc._drawAssignmentLinks?.();

    // Check for the arrow-loop sentinel
    if (st.steps.length === 1 && st.steps[0]._isArrowLoop) {
      npc.taskRunner?.setTasks([{
        task: 'loop',
        goals: [
          { goal: 'hunt_for_feathers',      targetQty: 10 },
          { goal: 'gather_wood_for_arrows', targetQty: 10 },
          { goal: 'smith_arrowheads',       arrowheadQty: 10, ironQty: 10, targetHeads: 30 },
          { goal: 'fetch_arrowheads',       qty: 10 },
          { goal: 'craft_arrows',           qty: 10 },
          { goal: 'deposit_arrows' },
        ],
      }]);
      npc.showBubble('Arrow loop started!');
      return;
    }

    // Compile steps → script_loop lines
    const lines = st.steps
      .map(s => this._compileLine(s))
      .filter(Boolean);

    const commands = lines.length > 0
      ? [{ task: 'script_loop', lines }]
      : [{ task: 'idle' }];

    npc.taskRunner?.setTasks(commands);
    npc.showBubble(lines.length > 0 ? `Script: ${lines.length} step(s)` : 'No steps — idling.');
  }

  _compileLine(step) {
    let line = null;

    if (step.action === 'gather') {
      line = { action: 'gather', item: step.gatherItem };
    } else if (step.action === 'deposit') {
      line = { action: 'deposit', item: step.itemKey };
    } else if (step.action === 'withdraw') {
      line = { action: 'withdraw', item: step.itemKey, qty: step.qty };
    } else if (step.action === 'maintain') {
      line = { action: 'maintain', threshold: step.threshold, reserveQty: step.reserveQty };
    } else if (step.action === 'flywheel') {
      line = { action: 'maintain_flywheels', low: step.flywheelMin };
    } else if (step.action === 'smelt') {
      line = { action: 'smelt' };
    } else if (step.action === 'attack') {
      line = { action: 'attack_nearest_enemy', range: 480 };
    } else if (step.action === 'follow') {
      line = { action: 'follow' };
    } else if (step._isArrowLoop) {
      return null;
    }

    if (!line) return null;

    if (step.stopEnabled) {
      line.until = {
        enabled: true,
        op: 'and',
        conditions: [{
          kind:       step.stopKind,
          item:       step.stopItem,
          qty:        step.stopQty,
          targetType: 'crate',
        }],
      };
    }

    return line;
  }

  // ── Primitive draw helpers ─────────────────────────────────────────────────

  _push(o) { this._objects.push(o); return o; }

  _rect(x, y, w, h, fill, stroke) {
    return this._push(
      this._scene.add.rectangle(x + w / 2, y + h / 2, w, h, fill, 1)
        .setStrokeStyle(stroke ? 1 : 0, stroke ?? 0)
        .setScrollFactor(0).setDepth(DEPTH)
    );
  }

  _text(x, y, str, color, size = '10px', ox = 0, oy = 0) {
    return this._push(
      this._scene.add.text(x, y, str, { fontSize: size, color })
        .setOrigin(ox, oy).setScrollFactor(0).setDepth(DEPTH + 1)
    );
  }

  _btn(x, y, w, h, label, onDown,
       fill   = C.btnFill,
       stroke = C.btnStroke,
       color  = C.btnText) {
    const bg = this._push(
      this._scene.add.rectangle(x + w / 2, y + h / 2, w, h, fill, 1)
        .setStrokeStyle(1, stroke).setScrollFactor(0).setDepth(DEPTH + 1)
        .setInteractive({ useHandCursor: true })
    );
    this._push(
      this._scene.add.text(x + w / 2, y + h / 2, label, { fontSize: '10px', color })
        .setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 2)
    );
    bg.on('pointerdown', onDown);
    return bg;
  }

  // Clickable text (no background box)
  _textBtn(x, y, str, color, size, onDown) {
    const t = this._push(
      this._scene.add.text(x, y, str, { fontSize: size, color })
        .setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 2)
        .setInteractive({ useHandCursor: true })
    );
    t.on('pointerdown', onDown);
    return t;
  }
}

// ── Module-level helpers ─────────────────────────────────────────────────────

function _cap(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}
