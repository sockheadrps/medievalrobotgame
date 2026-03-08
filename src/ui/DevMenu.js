// DEV MENU — press Q to toggle. Add any resource to inventory.
// Full item list from ITEMS registry, scrollable with mouse wheel.
// Remove or strip before any release build.

import { ITEMS } from '../data/items.js';

// Items displayed in DevMenu — all keys from ITEMS, sorted by type then name.
// We generate this list at module load time from the registry.
function _buildItemList() {
  const TYPE_ORDER = [
    'resource', 'ammo', 'building_material', 'misc', 'weapon', 'armor', 'consumable',
  ];
  const all = Object.entries(ITEMS).map(([key, def]) => ({
    key,
    label: def.name ?? key,
    type: def.type ?? 'misc',
  }));
  all.sort((a, b) => {
    const ti = TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type);
    return ti !== 0 ? ti : a.label.localeCompare(b.label);
  });
  return all;
}

const ALL_ITEMS   = _buildItemList();
const ADD_AMOUNTS = [1, 10, 100];

// Panel geometry
const W        = 340;
const PANEL_H  = 480;   // visible height of the panel
const ROW_H    = 32;
const BTN_H    = 40;    // spawn + machine buttons at bottom
const BODY_H   = PANEL_H - 56 - BTN_H; // scrollable body height
const DEPTH    = 50;

export class DevMenu {
  constructor(scene, inventory) {
    this._scene     = scene;
    this._inventory = inventory;
    this._visible   = false;
    this._objects   = [];  // persistent frame objects (bg, title, hint, buttons)
    this._rowObjs   = [];  // scrollable row objects, rebuilt on scroll
    this._scroll    = 0;   // pixel scroll offset (0 = top)

    const cx = scene.cameras.main.width  / 2;
    const cy = scene.cameras.main.height / 2;
    this._cx = cx;
    this._cy = cy;

    // ── Total content height ────────────────────────────────────────────────
    this._contentH = ALL_ITEMS.length * ROW_H;
    this._maxScroll = Math.max(0, this._contentH - BODY_H);

    const push = (o) => { this._objects.push(o); return o; };

    // Background
    push(scene.add.rectangle(cx, cy, W, PANEL_H, 0x0a0a1a, 0.97)
      .setStrokeStyle(2, 0x00ff88)
      .setScrollFactor(0).setDepth(DEPTH).setVisible(false));

    // Title
    push(scene.add.text(cx, cy - PANEL_H / 2 + 14, '⚙ DEV MENU  (Q to close)', {
      fontSize: '13px', color: '#00ff88',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 1).setVisible(false));

    // Column headers
    push(scene.add.text(cx - W / 2 + 12, cy - PANEL_H / 2 + 32, 'Item', {
      fontSize: '10px', color: '#667766',
    }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(DEPTH + 1).setVisible(false));
    push(scene.add.text(cx + 8,  cy - PANEL_H / 2 + 32, '+1', {
      fontSize: '10px', color: '#667766',
    }).setOrigin(0.5, 0.5).setScrollFactor(0).setDepth(DEPTH + 1).setVisible(false));
    push(scene.add.text(cx + 56, cy - PANEL_H / 2 + 32, '+10', {
      fontSize: '10px', color: '#667766',
    }).setOrigin(0.5, 0.5).setScrollFactor(0).setDepth(DEPTH + 1).setVisible(false));
    push(scene.add.text(cx + 110, cy - PANEL_H / 2 + 32, '+100', {
      fontSize: '10px', color: '#667766',
    }).setOrigin(0.5, 0.5).setScrollFactor(0).setDepth(DEPTH + 1).setVisible(false));

    // Divider under header
    push(scene.add.rectangle(cx, cy - PANEL_H / 2 + 41, W - 16, 1, 0x224422, 1)
      .setOrigin(0.5, 0).setScrollFactor(0).setDepth(DEPTH + 1).setVisible(false));

    // Scroll hint
    this._scrollHint = push(scene.add.text(cx, cy + PANEL_H / 2 - BTN_H - 6, '', {
      fontSize: '9px', color: '#445544',
    }).setOrigin(0.5, 1).setScrollFactor(0).setDepth(DEPTH + 1).setVisible(false));

    // ── Bottom action buttons ────────────────────────────────────────────────
    const btnY = cy + PANEL_H / 2 - BTN_H / 2 - 2;

    // Spawn NPC
    const spawnBtn = push(scene.add.text(cx - 120, btnY, '+ NPC', {
      fontSize: '12px', color: '#88ccff', backgroundColor: '#112233',
      padding: { x: 8, y: 5 },
    }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 1).setVisible(false)
      .setInteractive({ useHandCursor: true }));
    spawnBtn.on('pointerover', () => spawnBtn.setStyle({ backgroundColor: '#1a3a55' }));
    spawnBtn.on('pointerout',  () => spawnBtn.setStyle({ backgroundColor: '#112233' }));
    spawnBtn.on('pointerdown', () => {
      scene._spawnNPC((scene.player?.x ?? 300) + 48, scene.player?.y ?? 300);
      _flash(spawnBtn, '#0055aa', '#112233', scene);
    });

    // Spawn Rival
    const rivalBtn = push(scene.add.text(cx - 30, btnY, '+ Rival', {
      fontSize: '12px', color: '#ff9977', backgroundColor: '#221100',
      padding: { x: 8, y: 5 },
    }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 1).setVisible(false)
      .setInteractive({ useHandCursor: true }));
    rivalBtn.on('pointerover', () => rivalBtn.setStyle({ backgroundColor: '#441a00' }));
    rivalBtn.on('pointerout',  () => rivalBtn.setStyle({ backgroundColor: '#221100' }));
    rivalBtn.on('pointerdown', () => {
      scene._spawnNpNPC((scene.player?.x ?? 300) + 64, scene.player?.y ?? 300);
      _flash(rivalBtn, '#aa3300', '#221100', scene);
    });

    // Spawn Enemy
    const enemyBtn = push(scene.add.text(cx + 60, btnY, '+ Enemy', {
      fontSize: '12px', color: '#ff8888', backgroundColor: '#330a0a',
      padding: { x: 8, y: 5 },
    }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 1).setVisible(false)
      .setInteractive({ useHandCursor: true }));
    enemyBtn.on('pointerover', () => enemyBtn.setStyle({ backgroundColor: '#551515' }));
    enemyBtn.on('pointerout',  () => enemyBtn.setStyle({ backgroundColor: '#330a0a' }));
    enemyBtn.on('pointerdown', () => {
      const angle = Math.random() * Math.PI * 2;
      const px = scene.player?.x ?? 300, py = scene.player?.y ?? 300;
      scene.spawnEnemy(px + Math.cos(angle) * 144, py + Math.sin(angle) * 144);
      _flash(enemyBtn, '#771111', '#330a0a', scene);
    });

    // Machine tier up
    const tierBtn = push(scene.add.text(cx + 150, btnY, '⬆ Tier', {
      fontSize: '12px', color: '#ffaa00', backgroundColor: '#221500',
      padding: { x: 8, y: 5 },
    }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 1).setVisible(false)
      .setInteractive({ useHandCursor: true }));
    tierBtn.on('pointerover', () => tierBtn.setStyle({ backgroundColor: '#443000' }));
    tierBtn.on('pointerout',  () => tierBtn.setStyle({ backgroundColor: '#221500' }));
    tierBtn.on('pointerdown', () => {
      const machine = scene.machine;
      if (!machine || machine.tier >= 4) return;
      machine.setTier(machine.tier + 1);
      scene.motherMachineTier = machine.tier;
      scene.hud?.updateTier(machine.tier);
      _flash(tierBtn, '#664400', '#221500', scene);
    });

    // ── Scroll via mouse wheel ───────────────────────────────────────────────
    scene.input.on('wheel', (_ptr, _objs, _dx, dy) => {
      if (!this._visible) return;
      this._scrollBy(dy > 0 ? ROW_H * 3 : -ROW_H * 3);
    });

    // ── Clip mask — hides rows outside the body area ─────────────────────────
    // Using a Graphics mask so rows outside the viewport are invisible.
    const bodyTop  = cy - PANEL_H / 2 + 44;
    const bodyBot  = cy + PANEL_H / 2 - BTN_H - 8;
    this._bodyTop  = bodyTop;
    this._bodyBot  = bodyBot;
    const maskGfx  = scene.add.graphics().setScrollFactor(0);
    maskGfx.fillRect(cx - W / 2 + 4, bodyTop, W - 8, bodyBot - bodyTop);
    this._mask = maskGfx.createGeometryMask();
    maskGfx.setVisible(false); // the mask shape doesn't need to be visible
    this._maskGfx = maskGfx;

    // Q key
    scene.input.keyboard.on('keydown-Q', () => {
      if (scene.chatBox?.isOpen()) return;
      this.toggle();
    });
  }

  // ── Public ─────────────────────────────────────────────────────────────────

  show() {
    this._objects.forEach(o => o.setVisible(true));
    this._scroll = 0;
    this._buildRows();
    this._visible = true;
  }

  hide() {
    this._objects.forEach(o => o.setVisible(false));
    this._destroyRows();
    this._visible = false;
  }

  toggle() { this._visible ? this.hide() : this.show(); }
  isOpen()  { return this._visible; }

  // ── Private ────────────────────────────────────────────────────────────────

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

    const scene    = this._scene;
    const cx       = this._cx;
    const bodyTop  = this._bodyTop;
    const bodyBot  = this._bodyBot;
    const visH     = bodyBot - bodyTop;

    // Which rows are in the visible window?
    const firstIdx = Math.floor(this._scroll / ROW_H);
    const lastIdx  = Math.min(ALL_ITEMS.length - 1, Math.ceil((this._scroll + visH) / ROW_H));

    const push = (o) => { this._rowObjs.push(o); return o; };

    for (let i = firstIdx; i <= lastIdx; i++) {
      const item = ALL_ITEMS[i];
      const ry   = bodyTop + (i * ROW_H - this._scroll) + ROW_H / 2;

      if (ry < bodyTop - ROW_H || ry > bodyBot + ROW_H) continue;

      // Label
      push(scene.add.text(cx - W / 2 + 18, ry, item.label, {
        fontSize: '11px', color: '#cccccc',
      }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(DEPTH + 2).setMask(this._mask));

      // +1 / +10 / +100 buttons
      const offsets = [8, 56, 110];
      ADD_AMOUNTS.forEach((amt, j) => {
        const btn = push(scene.add.text(cx + offsets[j], ry, `+${amt}`, {
          fontSize: '11px', color: '#aaffaa', backgroundColor: '#1a3322',
          padding: { x: 5, y: 2 },
        }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 2)
          .setMask(this._mask)
          .setInteractive({ useHandCursor: true }));

        btn.on('pointerover',  () => btn.setStyle({ backgroundColor: '#2a5533' }));
        btn.on('pointerout',   () => btn.setStyle({ backgroundColor: '#1a3322' }));
        btn.on('pointerdown',  () => {
          this._inventory.add(item.key, amt);
          btn.setStyle({ backgroundColor: '#00aa44' });
          scene.time.delayedCall(120, () => { if (btn.active) btn.setStyle({ backgroundColor: '#1a3322' }); });
        });
      });
    }

    // Update scroll hint
    const pct = this._maxScroll > 0 ? Math.round((this._scroll / this._maxScroll) * 100) : 0;
    this._scrollHint?.setText(
      this._maxScroll > 0 ? `scroll ↕ (${pct}%)  [${firstIdx + 1}–${lastIdx + 1} / ${ALL_ITEMS.length}]` : ''
    );
  }
}

function _flash(btn, activeColor, restColor, scene) {
  btn.setStyle({ backgroundColor: activeColor });
  scene.time.delayedCall(150, () => { if (btn.active) btn.setStyle({ backgroundColor: restColor }); });
}
