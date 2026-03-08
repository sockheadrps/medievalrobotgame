// NPCTaskPanel — bottom-right panel showing the selected NPC's active task list.
// Updates every 100ms while an NPC is selected and has tasks running.

const W         = 260;
const PAD       = 10;
const ROW_H     = 22;
const HEADER_H  = 28;
const FOOTER_H  = 8;
const MAX_ROWS  = 12; // safety cap on displayed rows
const DEPTH     = 20;

// Colour palette
const COL_HEADER   = '#88ddff';
const COL_ACTIVE   = '#ffffff';
const COL_INACTIVE = '#556677';
const COL_PROGRESS = '#88ffaa';
const COL_LABEL    = '#aabbcc';
const BG_NORMAL    = 0x0a1520;
const BG_ACTIVE    = 0x0d2a18;  // darker green tint for active row
const STROKE       = 0x336688;

export class NPCTaskPanel {
  constructor(scene) {
    this._scene      = scene;
    this._visible    = false;
    this._npc        = null;
    this._rowCount   = 0;

    const sw = scene.cameras.main.width;
    const sh = scene.cameras.main.height;

    // Anchor: bottom-right corner, grows upward
    this._right  = sw - 12;
    this._bottom = sh - 12;

    // We build rows dynamically in _rebuild(); all objects stored in _objects
    this._objects = [];

    // Poll every 100ms
    scene.time.addEvent({
      delay: 100,
      loop: true,
      callback: () => { if (this._visible && this._npc) this._refresh(); },
    });
  }

  /** Show panel for this NPC. Called when NPC is selected. */
  show(npc) {
    this._npc = npc;
    this._visible = true;
    this._rebuild();
  }

  /** Hide and clear. Called when NPC is deselected. */
  hide() {
    this._visible = false;
    this._npc = null;
    this._clear();
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _clear() {
    for (const o of this._objects) o.destroy();
    this._objects = [];
    this._rowCount = 0;
  }

  /** Full rebuild — called when task structure may have changed. */
  _rebuild() {
    this._clear();
    if (!this._npc) return;

    const status = this._npc.taskRunner?.getStatus?.();
    if (!status?.running || status.tasks.length === 0) return;

    const task = status.tasks[0];
    const isGoalLoop = task.task === 'loop';
    const isScriptLoop = task.task === 'script_loop';
    const goals  = isGoalLoop ? (task.goals ?? []) : (isScriptLoop ? (task.lines ?? []) : null);

    // Count rows: 1 header + (goals or 1 task) + optional progress
    const dataRows = goals ? Math.min(goals.length, MAX_ROWS) : 1;
    const totalH   = HEADER_H + dataRows * ROW_H + FOOTER_H;

    const scene = this._scene;
    const right  = this._right;
    const bottom = this._bottom;
    const left   = right - W;
    const top    = bottom - totalH;
    const cx     = left + W / 2;

    const push = (o) => { this._objects.push(o); return o; };

    // Background
    push(scene.add.rectangle(cx, top + totalH / 2, W, totalH, BG_NORMAL, 0.92)
      .setStrokeStyle(1, STROKE)
      .setScrollFactor(0).setDepth(DEPTH).setOrigin(0.5));

    // Header: "LOOP" or task type
    const headerLabel = (isGoalLoop || isScriptLoop) ? '⟳  LOOP' : _taskLabel(task);
    push(scene.add.text(left + PAD, top + HEADER_H / 2, headerLabel, {
      fontSize: '12px', color: COL_HEADER, fontStyle: 'bold',
    }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(DEPTH + 1));

    // Divider line
    push(scene.add.rectangle(cx, top + HEADER_H, W, 1, STROKE, 0.8)
      .setScrollFactor(0).setDepth(DEPTH + 1).setOrigin(0.5, 0.5));

    if (goals) {
      // Goal rows
      for (let i = 0; i < Math.min(goals.length, MAX_ROWS); i++) {
        const g   = goals[i];
        const ry  = top + HEADER_H + i * ROW_H + ROW_H / 2;
        const isActive = i === status.activeGoalIndex;

        if (isActive) {
          push(scene.add.rectangle(cx, ry, W - 2, ROW_H - 2, BG_ACTIVE, 0.7)
            .setScrollFactor(0).setDepth(DEPTH).setOrigin(0.5));
        }

        const bullet = isActive ? '▶' : '·';
        const color  = isActive ? COL_ACTIVE : COL_INACTIVE;

        push(scene.add.text(left + PAD, ry, bullet, {
          fontSize: '11px', color,
        }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(DEPTH + 1));

        const labelStr = isScriptLoop ? _scriptLineLabel(g) : _goalLabel(g);
        push(scene.add.text(left + PAD + 14, ry, labelStr, {
          fontSize: '11px', color,
        }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(DEPTH + 1));

        // Progress text on active row (right-aligned)
        if (isActive && status.progress) {
          const p = status.progress;
          const progStr = p.need > 0 ? `${p.have}/${p.need}` : `${p.have}`;
          push(scene.add.text(right - PAD, ry, progStr, {
            fontSize: '10px', color: COL_PROGRESS,
          }).setOrigin(1, 0.5).setScrollFactor(0).setDepth(DEPTH + 1));
        }
      }
    } else {
      // Single one-shot task row
      const ry = top + HEADER_H + ROW_H / 2;
      push(scene.add.rectangle(cx, ry, W - 2, ROW_H - 2, BG_ACTIVE, 0.7)
        .setScrollFactor(0).setDepth(DEPTH).setOrigin(0.5));
      push(scene.add.text(left + PAD, ry, `▶  ${_taskLabel(task)}`, {
        fontSize: '11px', color: COL_ACTIVE,
      }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(DEPTH + 1));

      if (status.progress) {
        const p = status.progress;
        const progStr = p.need > 0 ? `${p.have}/${p.need}` : `${p.have}`;
        push(scene.add.text(right - PAD, ry, progStr, {
          fontSize: '10px', color: COL_PROGRESS,
        }).setOrigin(1, 0.5).setScrollFactor(0).setDepth(DEPTH + 1));
      }
    }

    this._rowCount = dataRows;
    this._lastGoalIndex = status.activeGoalIndex;
    this._lastTaskType  = task.task;
    this._lastGoalCount = goals ? goals.length : 0;
  }

  /** Light refresh — updates progress text on existing rows without full rebuild. */
  _refresh() {
    const status = this._npc?.taskRunner?.getStatus?.();

    if (!status?.running || status.tasks.length === 0) {
      if (this._objects.length > 0) this._clear();
      return;
    }

    const task = status.tasks[0];
    const goals = task.task === 'loop'
      ? (task.goals ?? [])
      : (task.task === 'script_loop' ? (task.lines ?? []) : null);
    const goalCount = goals ? goals.length : 0;

    // Full rebuild if structure changed (different task type, goal count, or active goal)
    if (task.task    !== this._lastTaskType ||
        goalCount    !== this._lastGoalCount ||
        status.activeGoalIndex !== this._lastGoalIndex) {
      this._rebuild();
    }
    // Otherwise nothing to update — the text objects were set during _rebuild
    // and progress values are embedded. Next structural change triggers rebuild.
  }
}

// ── Label helpers ──────────────────────────────────────────────────────────

function _goalLabel(g) {
  switch (g.goal) {
    case 'gather':              return `Gather ${_cap(g.item ?? 'wood')}`;
    case 'gather_wood_for_arrows': return `Gather wood (arrows)`;
    case 'hunt_for_feathers':   return `Hunt chickens → feathers`;
    case 'fill_furnace_wood':   return `Fuel furnace (wood)`;
    case 'deposit_extra':       return `Deposit extra ${_cap(g.item ?? 'wood')}`;
    case 'maintain_inventory':  return `Maintain ${_cap(g.item ?? 'wood')}`;
    case 'deposit_arrows':      return `Deposit arrows`;
    case 'crank_flywheel':      return `Crank flywheel`;
    case 'smith_arrowheads':    return `Smith arrowheads`;
    case 'fetch_arrowheads':    return `Fetch arrowheads`;
    case 'craft_arrows':        return `Craft arrows`;
    case 'fletch_arrow':        return `Fletch arrows`;
    case 'attack_chicken':      return `Attack chicken`;
    default:                    return g.goal ?? '?';
  }
}

function _taskLabel(task) {
  switch (task.task) {
    case 'gather':  return `Gather ${_cap(task.item ?? '')}`;
    case 'deposit': return `Deposit ${_cap(task.item ?? '')}`;
    case 'fill':    return `Fill ${task.target} with ${task.item}`;
    case 'smelt':   return `Smelt`;
    case 'follow':  return `Following player`;
    case 'crank':   return `Crank flywheel`;
    case 'idle':    return `Idle`;
    case 'loop':    return `Loop`;
    case 'script_loop': return `Script Loop`;
    default:        return task.task ?? '?';
  }
}

function _scriptLineLabel(line) {
  switch (line.action) {
    case 'gather': return `Gather ${_cap(line.item ?? 'wood')}`;
    case 'deposit': return `Deposit ${_cap(line.item ?? 'wood')}`;
    case 'withdraw': return `Withdraw ${line.qty ?? 1} ${_cap(line.item ?? 'wood')}`;
    case 'maintain': return `Maintain furnace >= ${line.threshold ?? 5} wood`;
    case 'maintain_flywheels': return `Keep flywheels >= ${line.low ?? 20}%`;
    case 'attack_nearest_enemy': return `Attack nearby enemies`;
    case 'follow': return `Follow player`;
    default: return line.action ?? '?';
  }
}

function _cap(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}
