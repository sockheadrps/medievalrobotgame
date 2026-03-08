// CrateFilterPanel — lets the player set which items a crate will accept.
// Right-click a crate → "Set Filter" → this panel opens.
// Click items to toggle them in/out of the filter.
// "Accept All" clears the filter. "Confirm" saves and closes.

import { ITEMS } from '../data/items.js';

const ALL_ITEMS = Object.entries(ITEMS)
  .filter(([, v]) => v.stackable && (v.type === 'resource' || v.type === 'building_material' || v.type === 'ammo' || v.type === 'misc'))
  .map(([key, v]) => ({ key, name: v.name }));

const W        = 340;
const PANEL_H  = 480;
const ROW_H    = 34;
const HEADER_H = 50;
const FOOTER_H = 50;
const BODY_H   = PANEL_H - HEADER_H - FOOTER_H;
const DEPTH    = 60;  // above everything else

export class CrateFilterPanel {
  constructor(scene) {
    this._scene    = scene;
    this._crate    = null;
    this._visible  = false;
    this._selected = new Set(); // keys currently toggled on
    this._scroll   = 0;
    this._rowObjs  = [];
    this._staticObjs = [];

    const cx = scene.cameras.main.width  / 2;
    const cy = scene.cameras.main.height / 2;
    this._cx = cx;
    this._cy = cy;

    const bodyTop = cy - PANEL_H / 2 + HEADER_H;
    const bodyBot = cy + PANEL_H / 2 - FOOTER_H;
    this._bodyTop = bodyTop;
    this._bodyBot = bodyBot;

    const push = (o) => { this._staticObjs.push(o); return o; };

    this._bg = push(scene.add.rectangle(cx, cy, W, PANEL_H, 0x0a1018, 0.98)
      .setStrokeStyle(2, 0xffcc44)
      .setScrollFactor(0).setDepth(DEPTH).setVisible(false));

    push(scene.add.text(cx, cy - PANEL_H / 2 + 16, 'SET CRATE FILTER', {
      fontSize: '13px', color: '#ffcc44', align: 'center',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 1).setVisible(false));

    push(scene.add.text(cx, cy - PANEL_H / 2 + 34, 'Click items to allow · scroll ↕', {
      fontSize: '10px', color: '#556677', align: 'center',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 1).setVisible(false));

    // Footer buttons
    const btnY = cy + PANEL_H / 2 - FOOTER_H / 2;

    const acceptAll = push(scene.add.text(cx - 70, btnY, 'Accept All', {
      fontSize: '12px', color: '#aaaaaa',
      backgroundColor: '#1a2230', padding: { x: 10, y: 6 },
    }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 1).setVisible(false)
      .setInteractive({ useHandCursor: true }));
    acceptAll.on('pointerover', () => acceptAll.setStyle({ backgroundColor: '#223344' }));
    acceptAll.on('pointerout',  () => acceptAll.setStyle({ backgroundColor: '#1a2230' }));
    acceptAll.on('pointerdown', () => { this._selected.clear(); this._buildRows(); });

    const confirm = push(scene.add.text(cx + 60, btnY, 'Confirm', {
      fontSize: '12px', color: '#44ff88',
      backgroundColor: '#0a2218', padding: { x: 10, y: 6 },
    }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 1).setVisible(false)
      .setInteractive({ useHandCursor: true }));
    confirm.on('pointerover', () => confirm.setStyle({ backgroundColor: '#114422' }));
    confirm.on('pointerout',  () => confirm.setStyle({ backgroundColor: '#0a2218' }));
    confirm.on('pointerdown', () => this._confirm());

    // Clip mask for scrollable body
    const maskGfx = scene.add.graphics().setScrollFactor(0);
    maskGfx.fillRect(cx - W / 2 + 4, bodyTop, W - 8, bodyBot - bodyTop);
    this._mask = maskGfx.createGeometryMask();
    maskGfx.setVisible(false);

    // Scroll
    scene.input.on('wheel', (_ptr, _objs, _dx, dy) => {
      if (!this._visible) return;
      const maxScroll = Math.max(0, ALL_ITEMS.length * ROW_H - BODY_H);
      this._scroll = Math.max(0, Math.min(maxScroll, this._scroll + (dy > 0 ? ROW_H * 2 : -ROW_H * 2)));
      this._buildRows();
    });

    // ESC to close without saving
    scene.input.keyboard.on('keydown-ESC', () => { if (this._visible) this.hide(); });
  }

  open(crate) {
    this._crate    = crate;
    this._scroll   = 0;
    // Pre-populate selection from existing filter
    const existing = crate.getAcceptList();
    this._selected = existing ? new Set(existing) : new Set();
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

  _confirm() {
    if (!this._crate) { this.hide(); return; }
    const list = this._selected.size > 0 ? [...this._selected] : null;
    this._crate.setAcceptList(list);
    this.hide();
  }

  _destroyRows() {
    for (const o of this._rowObjs) o.destroy();
    this._rowObjs = [];
  }

  _buildRows() {
    this._destroyRows();

    const scene   = this._scene;
    const cx      = this._cx;
    const bodyTop = this._bodyTop;
    const bodyBot = this._bodyBot;
    const visH    = bodyBot - bodyTop;

    const push = (o) => { this._rowObjs.push(o); return o; };

    const firstIdx = Math.floor(this._scroll / ROW_H);
    const lastIdx  = Math.min(ALL_ITEMS.length - 1, Math.ceil((this._scroll + visH) / ROW_H));

    for (let i = firstIdx; i <= lastIdx; i++) {
      const { key, name } = ALL_ITEMS[i];
      const ry = bodyTop + (i * ROW_H - this._scroll) + ROW_H / 2;
      if (ry < bodyTop - ROW_H || ry > bodyBot + ROW_H) continue;

      const on = this._selected.has(key);

      // Row bg — highlighted when selected
      const rowBg = push(scene.add.rectangle(cx, ry, W - 8, ROW_H - 2,
        on ? 0x1a3322 : (i % 2 === 0 ? 0x0a1218 : 0x0d1520), 1)
        .setStrokeStyle(on ? 1 : 0, 0x44ff88)
        .setScrollFactor(0).setDepth(DEPTH + 1).setMask(this._mask)
        .setInteractive({ useHandCursor: true }));

      push(scene.add.text(cx - W / 2 + 14, ry, name, {
        fontSize: '12px', color: on ? '#44ff88' : '#889aaa',
      }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(DEPTH + 2).setMask(this._mask));

      // Checkmark
      push(scene.add.text(cx + W / 2 - 18, ry, on ? '✓' : '', {
        fontSize: '14px', color: '#44ff88',
      }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 2).setMask(this._mask));

      rowBg.on('pointerover', () => rowBg.setFillStyle(on ? 0x224433 : 0x111a22));
      rowBg.on('pointerout',  () => rowBg.setFillStyle(on ? 0x1a3322 : (i % 2 === 0 ? 0x0a1218 : 0x0d1520)));
      rowBg.on('pointerdown', () => {
        if (this._selected.has(key)) this._selected.delete(key);
        else this._selected.add(key);
        this._buildRows();
      });
    }
  }
}
