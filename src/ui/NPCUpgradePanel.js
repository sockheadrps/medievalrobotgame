// NPCUpgradePanel — shows available upgrades for a selected NPC.
// Opened from the NPC right-click context menu → "Upgrades".
// Costs are consumed from the scene's shared inventory.

const UPGRADES = [
  {
    id: 'speed_1',
    label: 'Speed Boost I',
    desc: '+20% movement speed',
    cost: { IronBar: 5, Feather: 2 },
    apply: (u) => { u.speedTier = Math.max(u.speedTier, 1); },
    locked: (u) => u.speedTier >= 1,
  },
  {
    id: 'speed_2',
    label: 'Speed Boost II',
    desc: '+40% movement speed',
    cost: { SteelBar: 10, Feather: 5 },
    apply: (u) => { u.speedTier = Math.max(u.speedTier, 2); },
    locked: (u) => u.speedTier >= 2,
  },
  {
    id: 'carry_1',
    label: 'Carry Capacity I',
    desc: '+5 carry limit (10 → 15)',
    cost: { IronBar: 5, Wood: 3 },
    apply: (u) => { u.carryCapacity = Math.max(u.carryCapacity, 15); },
    locked: (u) => u.carryCapacity >= 15,
  },
  {
    id: 'carry_2',
    label: 'Carry Capacity II',
    desc: '+15 carry limit (15 → 25)',
    cost: { SteelBar: 10 },
    apply: (u) => { u.carryCapacity = Math.max(u.carryCapacity, 25); },
    locked: (u) => u.carryCapacity >= 25,
  },
  {
    id: 'efficiency',
    label: 'Task Efficiency',
    desc: '-20% time on timed tasks',
    cost: { IronBar: 5, Cogwheel: 1 },
    apply: (u) => { u.taskEfficiency = Math.min(u.taskEfficiency, 0.8); },
    locked: (u) => u.taskEfficiency <= 0.8,
  },
  {
    id: 'combat',
    label: 'Combat Module',
    desc: 'NPC engages enemies autonomously',
    cost: { IronBar: 10, IronSword: 1 },
    apply: (u) => { u.combatEnabled = true; },
    locked: (u) => u.combatEnabled,
  },
];

const W     = 360;
const DEPTH = 25;
const COL_BG  = 0x0d0d1a;
const COL_STR = 0x88ccff;

export class NPCUpgradePanel {
  constructor(scene, inventory) {
    this._scene     = scene;
    this._inventory = inventory;
    this._visible   = false;
    this._npc       = null;
    this._objects   = [];
    this._rows      = [];
    this._openTime  = 0;

    const cx = scene.cameras.main.width  / 2;
    const cy = scene.cameras.main.height / 2;
    this._cx = cx;
    this._cy = cy;

    const H = 60 + UPGRADES.length * 52;
    this._H = H;

    const push = (o) => { this._objects.push(o); return o; };

    // Background
    push(scene.add.rectangle(cx, cy, W, H, COL_BG, 0.97)
      .setStrokeStyle(2, COL_STR)
      .setScrollFactor(0).setDepth(DEPTH).setOrigin(0.5));

    // Title (dynamic — shows NPC id)
    this._titleText = push(scene.add.text(cx, cy - H / 2 + 20, 'NPC UPGRADES', {
      fontSize: '15px', color: '#88ccff', fontStyle: 'bold',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 1));

    // Divider
    push(scene.add.rectangle(cx, cy - H / 2 + 34, W - 20, 1, COL_STR, 0.3)
      .setScrollFactor(0).setDepth(DEPTH + 1).setOrigin(0.5, 0));

    // Result flash line
    this._resultText = push(scene.add.text(cx, cy + H / 2 - 16, '', {
      fontSize: '11px', color: '#88ff88',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 2));

    // Close hint
    push(scene.add.text(cx, cy + H / 2 - 4, 'Esc to close', {
      fontSize: '9px', color: '#334455',
    }).setOrigin(0.5, 1).setScrollFactor(0).setDepth(DEPTH + 1));

    // Outside click
    scene.input.on('pointerup', (ptr) => {
      if (!this._visible) return;
      if (scene.time.now - this._openTime < 200) return;
      const px = cx - W / 2, py = cy - H / 2;
      if (ptr.x < px || ptr.x > px + W || ptr.y < py || ptr.y > py + H) this.hide();
    });
    scene.input.keyboard.on('keydown-ESC', () => { if (this._visible) this.hide(); });

    this._setVisible(false);
  }

  // ── Public ────────────────────────────────────────────────────────────────

  open(npc) {
    this._npc      = npc;
    this._openTime = this._scene.time.now;
    this._titleText.setText(`Upgrades: ${npc.id}`);
    this._buildRows();
    this._setVisible(true);
    this._visible = true;
  }

  hide() {
    this._destroyRows();
    this._setVisible(false);
    this._visible = false;
    this._npc = null;
  }

  isOpen() { return this._visible; }

  // ── Private ───────────────────────────────────────────────────────────────

  _destroyRows() {
    for (const row of this._rows) row.forEach(o => o.destroy());
    this._rows = [];
  }

  _buildRows() {
    this._destroyRows();
    if (!this._npc) return;

    const scene = this._scene;
    const cx    = this._cx;
    const cy    = this._cy;
    const H     = this._H;
    const u     = this._npc.upgrades;

    UPGRADES.forEach((upg, i) => {
      const by       = cy - H / 2 + 46 + i * 52;
      const purchased = upg.locked(u);
      const costStr  = Object.entries(upg.cost).map(([k, v]) => `${v}× ${k}`).join(', ');
      const btnCol   = purchased ? 0x111122 : 0x0d1a2e;

      const btn = scene.add.rectangle(cx, by, W - 24, 44, btnCol, 1)
        .setStrokeStyle(1, purchased ? 0x223322 : 0x334466)
        .setScrollFactor(0).setDepth(DEPTH + 1)
        .setInteractive({ useHandCursor: !purchased });

      const lbl = scene.add.text(cx - (W / 2) + 16, by - 8, upg.label, {
        fontSize: '12px', color: purchased ? '#336633' : '#88ccff',
      }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(DEPTH + 2);

      const descText = scene.add.text(cx - (W / 2) + 16, by + 8, upg.desc, {
        fontSize: '10px', color: purchased ? '#334433' : '#667788',
      }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(DEPTH + 2);

      const costLabel = purchased
        ? '✓ Purchased'
        : this._canAfford(upg.cost) ? costStr : `${costStr} ✗`;
      const costText = scene.add.text(cx + (W / 2) - 16, by, costLabel, {
        fontSize: '10px',
        color: purchased ? '#336633' : this._canAfford(upg.cost) ? '#88ff88' : '#ff6666',
      }).setOrigin(1, 0.5).setScrollFactor(0).setDepth(DEPTH + 2);

      if (!purchased) {
        btn.on('pointerover', () => btn.setFillStyle(0x1a2a3a));
        btn.on('pointerout',  () => btn.setFillStyle(btnCol));
        btn.on('pointerdown', () => this._purchase(upg));
      }

      this._rows.push([btn, lbl, descText, costText]);
    });
  }

  _canAfford(cost) {
    return Object.entries(cost).every(([item, qty]) => this._inventory.get(item) >= qty);
  }

  _purchase(upg) {
    if (!this._npc) return;
    if (upg.locked(this._npc.upgrades)) return;
    if (!this._canAfford(upg.cost)) {
      this._flash('Not enough resources.', '#ff6666');
      return;
    }
    // Consume
    for (const [item, qty] of Object.entries(upg.cost)) {
      this._inventory.set(item, this._inventory.get(item) - qty);
    }
    // Apply
    upg.apply(this._npc.upgrades);
    this._flash(`${upg.label} applied!`, '#88ff88');
    // Rebuild rows to reflect new state
    this._buildRows();
  }

  _flash(msg, color) {
    this._resultText.setText(msg).setColor(color);
    this._scene.time.delayedCall(2000, () => { if (this._resultText) this._resultText.setText(''); });
  }

  _setVisible(v) {
    for (const o of this._objects) o.setVisible(v);
  }
}
