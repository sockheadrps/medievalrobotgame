// StoragePanel — two-column inventory swap UI
// Click → to move 1 item inv→crate, Shift+click to move all
// Click ← to move 1 item crate→inv, Shift+click to move all
// Scrollable with mouse wheel when the list doesn't fit the panel.

import { ITEMS } from '../data/items.js';

// All stackable resource/material types that can appear in storage
const RESOURCES = [
  'Ore', 'Iron', 'Coal', 'CopperOre', 'TinOre', 'GoldOre',
  'Wood', 'Stone', 'Feather',
  'IronBar', 'SteelBar', 'BronzeBar', 'GoldBar',
  'IronArrowhead', 'Arrow',
  'IronNail', 'WoodenFrame', 'ReinforcedBlock', 'Door', 'WoodenFlywheel',
  'WoodWall', 'WoodStorage', 'WoodCraftingTable', 'WoodPulpConveyor',
  'AnvilItem', 'WoodRobotChasisPod', 'Cogwheel',
];

// Human-readable label for each key
function resLabel(key) {
  return ITEMS[key]?.name ?? key;
}

const W        = 460;
const PANEL_H  = 500;
const ROW_H    = 36;
const HEADER_H = 60;
const FOOTER_H = 28;
const BODY_H   = PANEL_H - HEADER_H - FOOTER_H;
const DEPTH    = 25;

export class StoragePanel {
  constructor(scene, inventory) {
    this._scene     = scene;
    this._inventory = inventory;
    this._crate     = null;
    this._visible   = false;
    this._scroll    = 0;
    this._rowObjs   = [];
    this._staticObjs = [];

    const cx = scene.cameras.main.width  / 2;
    const cy = scene.cameras.main.height / 2;
    this._cx = cx;
    this._cy = cy;

    const bodyTop = cy - PANEL_H / 2 + HEADER_H;
    const bodyBot = cy + PANEL_H / 2 - FOOTER_H;
    this._bodyTop = bodyTop;
    this._bodyBot = bodyBot;
    this._maxScroll = Math.max(0, RESOURCES.length * ROW_H - BODY_H);

    const push = (o) => { this._staticObjs.push(o); return o; };

    this._bg = push(scene.add.rectangle(cx, cy, W, PANEL_H, 0x0d1b2a, 0.97)
      .setStrokeStyle(2, 0x4488cc)
      .setScrollFactor(0).setDepth(DEPTH).setVisible(false));

    push(scene.add.text(cx, cy - PANEL_H / 2 + 18, 'STORAGE', {
      fontSize: '15px', color: '#88ccff', align: 'center',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 1).setVisible(false));

    push(scene.add.text(cx - 160, cy - PANEL_H / 2 + 42, 'INVENTORY', {
      fontSize: '11px', color: '#aaaaaa',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 1).setVisible(false));

    push(scene.add.text(cx + 160, cy - PANEL_H / 2 + 42, 'CRATE', {
      fontSize: '11px', color: '#aaaaaa',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 1).setVisible(false));

    push(scene.add.text(cx, cy + PANEL_H / 2 - 12,
      'Click: move 1  |  Shift+click: move all  |  E / click outside: close', {
      fontSize: '10px', color: '#445566', align: 'center',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 1).setVisible(false));

    // Clip mask for scrollable body
    const maskGfx = scene.add.graphics().setScrollFactor(0);
    maskGfx.fillRect(cx - W / 2 + 4, bodyTop, W - 8, bodyBot - bodyTop);
    this._mask = maskGfx.createGeometryMask();
    maskGfx.setVisible(false);

    // Mouse wheel scrolling
    scene.input.on('wheel', (_ptr, _objs, _dx, dy) => {
      if (!this._visible) return;
      this._scrollBy(dy > 0 ? ROW_H * 2 : -ROW_H * 2);
    });

    // Close on click outside panel
    scene.input.on('pointerdown', (pointer) => {
      if (!this._visible) return;
      const left = cx - W / 2, top = cy - PANEL_H / 2;
      if (pointer.x < left || pointer.x > left + W ||
          pointer.y < top  || pointer.y > top  + PANEL_H) {
        this.hide();
      }
    });

    inventory.on('change', () => { if (this._visible) this._buildRows(); });
  }

  open(crate) {
    this._crate  = crate;
    this._scroll = 0;
    this._staticObjs.forEach(o => o.setVisible(true));
    this._visible = true;
    this._buildRows();
  }

  hide() {
    this._destroyRows();
    this._staticObjs.forEach(o => o.setVisible(false));
    this._visible = false;
    this._crate   = null;
  }

  isOpen() { return this._visible; }

  // ── Private ───────────────────────────────────────────────────────────────

  _scrollBy(delta) {
    this._scroll = Math.max(0, Math.min(this._maxScroll, this._scroll + delta));
    this._buildRows();
  }

  _destroyRows() {
    for (const o of this._rowObjs) o.destroy();
    this._rowObjs = [];
  }

  _buildRows() {
    this._destroyRows();
    if (!this._crate) return;

    const scene   = this._scene;
    const cx      = this._cx;
    const stored  = this._crate.getStored();
    const bodyTop = this._bodyTop;
    const bodyBot = this._bodyBot;
    const visH    = bodyBot - bodyTop;

    const push = (o) => { this._rowObjs.push(o); return o; };

    // Only show resources that are present in the crate OR in the player inventory
    const active = RESOURCES.filter(res => (stored[res] ?? 0) > 0 || this._inventory.get(res) > 0);
    this._maxScroll = Math.max(0, active.length * ROW_H - visH);
    this._scroll    = Math.min(this._scroll, this._maxScroll);

    if (active.length === 0) {
      push(scene.add.text(cx, bodyTop + visH / 2, 'Empty', {
        fontSize: '13px', color: '#445566',
      }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 2).setMask(this._mask));
      return;
    }

    const firstIdx = Math.floor(this._scroll / ROW_H);
    const lastIdx  = Math.min(active.length - 1, Math.ceil((this._scroll + visH) / ROW_H));

    for (let i = firstIdx; i <= lastIdx; i++) {
      const res = active[i];
      const ry  = bodyTop + (i * ROW_H - this._scroll) + ROW_H / 2;
      if (ry < bodyTop - ROW_H || ry > bodyBot + ROW_H) continue;

      const invAmt   = this._inventory.get(res);
      const crateAmt = stored[res] ?? 0;

      // Row background (subtle stripe)
      push(scene.add.rectangle(cx, ry, W - 8, ROW_H - 2, i % 2 === 0 ? 0x0a1520 : 0x0d1b2a, 1)
        .setScrollFactor(0).setDepth(DEPTH + 1).setMask(this._mask));

      // Label
      push(scene.add.text(cx - W / 2 + 12, ry, resLabel(res), {
        fontSize: '12px', color: '#cccccc',
      }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(DEPTH + 2).setMask(this._mask));

      // Inventory count
      push(scene.add.text(cx - 80, ry, String(invAmt), {
        fontSize: '12px', color: '#ffffff',
      }).setOrigin(1, 0.5).setScrollFactor(0).setDepth(DEPTH + 2).setMask(this._mask));

      // → button (inv → crate), greyed if player has none
      const toBtn = push(scene.add.text(cx - 42, ry, '→', {
        fontSize: '14px', color: invAmt > 0 ? '#44ff88' : '#334433',
        backgroundColor: '#1a3322', padding: { x: 6, y: 2 },
      }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 2).setMask(this._mask)
        .setInteractive({ useHandCursor: invAmt > 0 }));
      if (invAmt > 0) {
        toBtn.on('pointerover', () => toBtn.setStyle({ backgroundColor: '#225533' }));
        toBtn.on('pointerout',  () => toBtn.setStyle({ backgroundColor: '#1a3322' }));
        toBtn.on('pointerdown', (ptr) => {
          this._moveToStorage(res, ptr.event.shiftKey ? Infinity : 1);
        });
      }

      // ← button (crate → inv), greyed if crate has none
      const fromBtn = push(scene.add.text(cx + 42, ry, '←', {
        fontSize: '14px', color: crateAmt > 0 ? '#ff8844' : '#443322',
        backgroundColor: '#331a11', padding: { x: 6, y: 2 },
      }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 2).setMask(this._mask)
        .setInteractive({ useHandCursor: crateAmt > 0 }));
      if (crateAmt > 0) {
        fromBtn.on('pointerover', () => fromBtn.setStyle({ backgroundColor: '#442211' }));
        fromBtn.on('pointerout',  () => fromBtn.setStyle({ backgroundColor: '#331a11' }));
        fromBtn.on('pointerdown', (ptr) => {
          this._moveToInventory(res, ptr.event.shiftKey ? Infinity : 1);
        });
      }

      // Crate count
      push(scene.add.text(cx + 80, ry, String(crateAmt), {
        fontSize: '12px', color: '#aaaaff',
      }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(DEPTH + 2).setMask(this._mask));
    }
  }

  _moveToStorage(res, amount) {
    if (!this._crate) return;
    const have = this._inventory.get(res);
    if (have <= 0) return;
    const moving = Math.min(have, amount);
    this._inventory.remove(res, moving);
    this._crate.addToStorage(res, moving);
    this._buildRows();
  }

  _moveToInventory(res, amount) {
    if (!this._crate) return;
    const stored = this._crate.getStored();
    const have   = stored[res] ?? 0;
    if (have <= 0) return;
    const moving = Math.min(have, amount);
    this._crate.removeFromStorage(res, moving);
    this._inventory.add(res, moving);
    this._buildRows();
  }
}
