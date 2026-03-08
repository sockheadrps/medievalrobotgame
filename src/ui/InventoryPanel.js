// InventoryPanel — press I to open/close.
// Shows every item in ITEMS that the player holds > 0 of, grouped by type.
// Dynamically rebuilt each time it's opened so new items always appear.

import { ITEMS } from '../data/items.js';

// Display order: type groups, then alphabetical within group
const TYPE_ORDER = ['resource', 'ammo', 'building_material', 'misc', 'weapon', 'armor', 'consumable'];
const TYPE_LABEL = {
  resource:          'Resources',
  ammo:              'Ammo',
  building_material: 'Materials',
  misc:              'Misc',
  weapon:            'Weapons',
  armor:             'Armor',
  consumable:        'Consumables',
};
const TYPE_COLOR = {
  resource:          '#aaddff',
  ammo:              '#ffdd88',
  building_material: '#ccbbaa',
  misc:              '#aaffaa',
  weapon:            '#ff9988',
  armor:             '#ddaaff',
  consumable:        '#88ffcc',
};

const W       = 220;
const ROW_H   = 22;
const HDR_H   = 20;
const PAD     = 12;
const DEPTH   = 25;
const MAX_H   = 520; // panel never grows taller than this

export class InventoryPanel {
  constructor(scene, inventory) {
    this._scene     = scene;
    this._inventory = inventory;
    this._visible   = false;
    this._objects   = [];

    // Position: right side of screen
    this._cx = scene.cameras.main.width - W / 2 - 12;

    // Re-render whenever inventory changes (while open)
    inventory.on('change', () => { if (this._visible) this._rebuild(); });
  }

  toggle() { this._visible ? this.hide() : this.show(); }

  show() {
    this._rebuild();
    this._visible = true;
  }

  hide() {
    this._destroyObjects();
    this._visible = false;
  }

  isOpen() { return this._visible; }

  // ── Private ────────────────────────────────────────────────────────────────

  _destroyObjects() {
    for (const o of this._objects) o.destroy();
    this._objects = [];
  }

  _rebuild() {
    this._destroyObjects();

    const scene = this._scene;
    const inv   = this._inventory;
    const cx    = this._cx;

    // Collect non-zero items grouped by type
    const groups = {};
    for (const [key, def] of Object.entries(ITEMS)) {
      const qty = inv.get(key);
      if (qty <= 0) continue;
      const t = def.type ?? 'misc';
      if (!groups[t]) groups[t] = [];
      groups[t].push({ key, label: def.name ?? key, qty });
    }

    // Build ordered row list: [header, item, item, ...]
    const rows = []; // { type: 'header'|'item', label, qty?, color }
    for (const t of TYPE_ORDER) {
      if (!groups[t] || groups[t].length === 0) continue;
      rows.push({ type: 'header', label: TYPE_LABEL[t] ?? t, color: TYPE_COLOR[t] ?? '#ffffff' });
      for (const entry of groups[t].sort((a, b) => a.label.localeCompare(b.label))) {
        rows.push({ type: 'item', label: entry.label, qty: entry.qty });
      }
    }

    if (rows.length === 0) {
      rows.push({ type: 'item', label: '(empty)', qty: null });
    }

    // Calculate height — cap at MAX_H
    const totalH = Math.min(
      PAD * 2 + 24 + rows.reduce((h, r) => h + (r.type === 'header' ? HDR_H : ROW_H), 0),
      MAX_H
    );

    const cy = scene.cameras.main.height / 2;
    const push = (o) => { this._objects.push(o); return o; };

    push(scene.add.rectangle(cx, cy, W, totalH, 0x0d1b2a, 0.95)
      .setStrokeStyle(2, 0x4488cc)
      .setScrollFactor(0).setDepth(DEPTH));

    push(scene.add.text(cx, cy - totalH / 2 + 10, 'INVENTORY', {
      fontSize: '13px', color: '#88ccff', fontStyle: 'bold',
    }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(DEPTH + 1));

    let y = cy - totalH / 2 + PAD + 22;
    const yBottom = cy + totalH / 2 - PAD;

    for (const row of rows) {
      if (y > yBottom) break; // clipped

      if (row.type === 'header') {
        push(scene.add.text(cx - W / 2 + PAD, y, row.label, {
          fontSize: '10px', color: row.color, fontStyle: 'bold',
        }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(DEPTH + 1));
        y += HDR_H;
      } else {
        push(scene.add.text(cx - W / 2 + PAD + 6, y, row.label, {
          fontSize: '12px', color: '#cccccc',
        }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(DEPTH + 1));

        if (row.qty !== null) {
          push(scene.add.text(cx + W / 2 - PAD, y, String(row.qty), {
            fontSize: '12px', color: '#ffffff',
          }).setOrigin(1, 0.5).setScrollFactor(0).setDepth(DEPTH + 1));
        }
        y += ROW_H;
      }
    }

    // "I to close" hint
    push(scene.add.text(cx, cy + totalH / 2 - 5, 'I to close', {
      fontSize: '9px', color: '#334455',
    }).setOrigin(0.5, 1).setScrollFactor(0).setDepth(DEPTH + 1));
  }
}
