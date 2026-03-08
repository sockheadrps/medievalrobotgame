// HUD — persistent bottom bar occupying canvas y=720–960 (below the 720px game viewport).
//
// Layout:
//   TOP STRIP  (y=720–750):  HP bar, Tier badge, Tab buttons, Weight display
//   LEFT ZONE  (x=14-340, y=752-958): Inventory grid (5x4 = 20 slots, always visible)
//   RIGHT ZONE (x=350-1266, y=752-958): Tab content area (panels render here)
//   Skills are shown via the Skills tab.
//
// Canvas is 1280×960; camera viewport is 0,0,1280,720.
// All HUD objects live at y≥720, setScrollFactor(0), setDepth(50+).

import Phaser from 'phaser';
import { SKILL_DEFS } from '../data/skills.js';
import { getItem } from '../data/items.js';

// ── Layout constants ────────────────────────────────────────────────────────
// Vertical positions are derived downward from CANVAS_H so the HUD is always
// flush with the canvas bottom regardless of game viewport height.
const CANVAS_W = 1280;
const CANVAS_H = 960;
const DEPTH    = 50;
const PAD      = 14;

const HUD_H    = 240;
const BAR_Y    = CANVAS_H - HUD_H;        // 720 — top of HUD / divider line

// Top strip
const TOP_Y    = BAR_Y;                   // 720
const TOP_H    = 32;
const TOP_MID  = TOP_Y + TOP_H / 2;      // 736

// Main content area — bottom edge is flush with canvas
const CONTENT_Y   = TOP_Y + TOP_H + 2;   // 754
const CONTENT_BOT = CANVAS_H - 6;        // 954
const CONTENT_H   = CONTENT_BOT - CONTENT_Y; // 200

// Left zone — inventory grid
const GRID_X   = PAD;
const GRID_COLS = 5;
const GRID_ROWS = 4;
const CELL_W   = 62;
const CELL_H   = 38;
const CELL_GAP = 3;

// Right zone — tab content
const TAB_X    = 350;
const TAB_W    = CANVAS_W - TAB_X - PAD; // 916
const TAB_H    = CONTENT_H;
const CHIP_H   = 24;

// HP bar
const HP_X = PAD + 22;
const HP_W = 180;
const HP_H = 10;

const HUD_BG_NORMAL = 0x060c12;
const HUD_BG_NPC    = 0x142a44;

// Per-skill accent colours
const SKILL_STYLE = {
  woodcutting:  { short: 'WC',  bg: 0x0d1f0d, stroke: 0x44bb44, text: '#77ee77' },
  mining:       { short: 'Min', bg: 0x10101e, stroke: 0x5555cc, text: '#8899ee' },
  smithing:     { short: 'Smt', bg: 0x1e1608, stroke: 0xbb8822, text: '#ffcc55' },
  fletching:    { short: 'Flt', bg: 0x081518, stroke: 0x22aacc, text: '#55ccee' },
  attack:       { short: 'Atk', bg: 0x1e0b08, stroke: 0xcc4422, text: '#ff7755' },
  strength:     { short: 'Str', bg: 0x1e0808, stroke: 0xcc2222, text: '#ff5555' },
  defence:      { short: 'Def', bg: 0x08101e, stroke: 0x2255cc, text: '#5588ff' },
  archery:      { short: 'Arc', bg: 0x1e1b08, stroke: 0xccbb22, text: '#ffee55' },
  constitution: { short: 'Con', bg: 0x1e0810, stroke: 0xcc2266, text: '#ff66aa' },
  athletics:    { short: 'Ath', bg: 0x081e18, stroke: 0x22cc88, text: '#55eebb' },
};

// Tab definitions
const PERMANENT_TABS = [
  { id: 'skills', label: 'Skills', hotkey: 'C' },
  { id: 'build',  label: 'Build',  hotkey: 'B' },
];

export class HUD extends Phaser.Events.EventEmitter {
  constructor(scene) {
    super();
    this._scene = scene;
    this._activeTab = null;
    this._contextTabs = [];  // dynamic context tabs
    this._tabButtons = {};   // id → { bg, text }
    this._panels = {};       // id -> panel instance (set via registerPanel)
    this._buildTabVisible = true;
    this._inventorySource = null;
    this._skillSource = null;

    // ── Bar background — anchored at top of HUD, fills to canvas bottom ─────
    this._bg = scene.add.rectangle(CANVAS_W / 2, BAR_Y, CANVAS_W, HUD_H, HUD_BG_NORMAL, 1)
      .setScrollFactor(0).setDepth(DEPTH).setOrigin(0.5, 0);

    // Top divider — bright accent line
    scene.add.rectangle(CANVAS_W / 2, BAR_Y, CANVAS_W, 2, 0x2255aa, 1)
      .setScrollFactor(0).setDepth(DEPTH + 1).setOrigin(0.5, 0);

    // Content dividers
    scene.add.rectangle(CANVAS_W / 2, TOP_Y + TOP_H, CANVAS_W, 1, 0x1a2a3a, 1)
      .setScrollFactor(0).setDepth(DEPTH + 1).setOrigin(0.5, 0);
    scene.add.rectangle(CANVAS_W / 2, CONTENT_BOT, CANVAS_W, 1, 0x1a2a3a, 1)
      .setScrollFactor(0).setDepth(DEPTH + 1).setOrigin(0.5, 0);

    // Vertical divider between grid and tab content
    scene.add.rectangle(TAB_X - 6, CONTENT_Y + CONTENT_H / 2, 1, CONTENT_H, 0x1a2a3a, 1)
      .setScrollFactor(0).setDepth(DEPTH + 1).setOrigin(0.5);

    // ── Save notification (top-right, inside game viewport) ─────────────────
    this._saveNotice = scene.add.text(CANVAS_W - 12, 10, 'Game Saved', {
      fontSize: '12px', color: '#88ffaa', backgroundColor: '#00000099',
      padding: { x: 8, y: 4 },
    }).setOrigin(1, 0).setScrollFactor(0).setDepth(DEPTH + 5).setAlpha(0);

    scene.events.on('game-saved', () => {
      scene.tweens.killTweensOf(this._saveNotice);
      this._saveNotice.setAlpha(1);
      scene.tweens.add({ targets: this._saveNotice, alpha: 0, delay: 1500, duration: 600 });
    });

    // ── TOP STRIP — HP + Tier + Tabs + Weight ───────────────────────────────

    // "HP" label
    scene.add.text(PAD, TOP_MID, 'HP', {
      fontSize: '10px', color: '#445566', fontStyle: 'bold',
    }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(DEPTH + 2);

    // HP track
    scene.add.rectangle(HP_X + HP_W / 2, TOP_MID, HP_W, HP_H, 0x0d0d0d, 1)
      .setStrokeStyle(1, 0x1a2a3a)
      .setScrollFactor(0).setDepth(DEPTH + 1).setOrigin(0.5);

    // HP fill
    this._hpFill = scene.add.rectangle(HP_X, TOP_MID, HP_W, HP_H, 0x33cc44, 1)
      .setScrollFactor(0).setDepth(DEPTH + 2).setOrigin(0, 0.5);

    // HP count
    this._hpText = scene.add.text(HP_X + HP_W + 8, TOP_MID, '15 / 15', {
      fontSize: '11px', color: '#aaddaa',
    }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(DEPTH + 2);

    // Tier badge
    const tierX = HP_X + HP_W + 80;
    scene.add.rectangle(tierX + 50, TOP_MID, 100, 22, 0x0d1408, 1)
      .setStrokeStyle(1, 0x446622)
      .setScrollFactor(0).setDepth(DEPTH + 1).setOrigin(0.5);
    this._tierText = scene.add.text(tierX + 50, TOP_MID, 'Tier I', {
      fontSize: '10px', color: '#aacc44',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 2);

    // Weight display (right side)
    this._weightText = scene.add.text(CANVAS_W - PAD, TOP_MID, 'Wt 0/100', {
      fontSize: '10px', color: '#668888',
    }).setOrigin(1, 0.5).setScrollFactor(0).setDepth(DEPTH + 2);

    // Tab buttons — start after tier badge
    this._buildTabButtons(scene);

    // ── LEFT ZONE — Inventory Grid ──────────────────────────────────────────
    this._gridCells = [];  // { bg, nameText, qtyText, slotIdx }
    this._buildInventoryGrid(scene);

    // Grid weight summary
    this._gridWeightText = scene.add.text(GRID_X, CONTENT_BOT - 4, 'Weight: 0 / 100', {
      fontSize: '9px', color: '#446666',
    }).setOrigin(0, 1).setScrollFactor(0).setDepth(DEPTH + 2);
//   Skills are shown via the Skills tab.
    this._skillChips = [];
  }

  // ── Tab button management ─────────────────────────────────────────────────

  _buildTabButtons(scene) {
    // Destroy existing tab buttons
    for (const btn of Object.values(this._tabButtons)) {
      btn.bg.destroy();
      btn.text.destroy();
    }
    this._tabButtons = {};

    const permanentTabs = this._buildTabVisible
      ? PERMANENT_TABS
      : PERMANENT_TABS.filter(t => t.id !== 'build');
    const allTabs = [...permanentTabs, ...this._contextTabs];
    const startX = HP_X + HP_W + 190;
    const btnH   = 22;
    let x = startX;

    for (const tab of allTabs) {
      const label = tab.hotkey ? `${tab.label} [${tab.hotkey}]` : tab.label;
      const btnW  = Math.max(60, label.length * 7 + 16);
      const cx    = x + btnW / 2;

      const isActive = this._activeTab === tab.id;
      const bg = scene.add.rectangle(cx, TOP_MID, btnW, btnH,
        isActive ? 0x112244 : 0x081018, 1)
        .setStrokeStyle(1, isActive ? 0x4488cc : 0x1a2a3a)
        .setScrollFactor(0).setDepth(DEPTH + 1).setOrigin(0.5)
        .setInteractive({ useHandCursor: true });

      const text = scene.add.text(cx, TOP_MID, label, {
        fontSize: '10px', color: isActive ? '#88ccff' : '#556677',
      }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 2);

      bg.on('pointerover', () => {
        if (this._activeTab !== tab.id) bg.setFillStyle(0x0d1a2a);
      });
      bg.on('pointerout', () => {
        if (this._activeTab !== tab.id) bg.setFillStyle(0x081018);
      });
      bg.on('pointerdown', () => {
        this.setActiveTab(this._activeTab === tab.id ? null : tab.id);
      });

      this._tabButtons[tab.id] = { bg, text, tab };
      x += btnW + 4;
    }
  }

  _refreshTabHighlights() {
    for (const [id, btn] of Object.entries(this._tabButtons)) {
      const isActive = this._activeTab === id;
      btn.bg.setFillStyle(isActive ? 0x112244 : 0x081018);
      btn.bg.setStrokeStyle(1, isActive ? 0x4488cc : 0x1a2a3a);
      btn.text.setColor(isActive ? '#88ccff' : '#556677');
    }
  }

  // ── Inventory grid ────────────────────────────────────────────────────────

  _buildInventoryGrid(scene) {
    for (let row = 0; row < GRID_ROWS; row++) {
      for (let col = 0; col < GRID_COLS; col++) {
        const idx = row * GRID_COLS + col;
        const cx = GRID_X + col * (CELL_W + CELL_GAP) + CELL_W / 2;
        const cy = CONTENT_Y + 4 + row * (CELL_H + CELL_GAP) + CELL_H / 2;

        const bg = scene.add.rectangle(cx, cy, CELL_W, CELL_H, 0x080e18, 1)
          .setStrokeStyle(1, 0x1a2a3a)
          .setScrollFactor(0).setDepth(DEPTH + 1).setOrigin(0.5);
        bg.setInteractive({ useHandCursor: true });
        bg.on('pointerdown', (pointer) => {
          if (pointer.rightButtonDown()) {
            pointer.event?.preventDefault?.();
            this.emit('inventory-slot-right-clicked', idx, !!pointer.event?.shiftKey);
            return;
          }
          this.emit('inventory-slot-clicked', idx);
        });

        const nameText = scene.add.text(cx, cy - 8, '', {
          fontSize: '8px', color: '#6688aa',
        }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 2);

        const qtyText = scene.add.text(cx, cy + 8, '', {
          fontSize: '12px', color: '#cce8ff', fontStyle: 'bold',
        }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 2);

        this._gridCells.push({ bg, nameText, qtyText, slotIdx: idx });
      }
    }
  }

  // ── Skill chips ───────────────────────────────────────────────────────────

  _buildSkillChips(scene) {
    const skills = SKILL_DEFS;
    const chipW  = Math.floor((CANVAS_W - PAD * 2) / skills.length);
    const cy     = CONTENT_BOT + 4 + CHIP_H / 2;

    for (let i = 0; i < skills.length; i++) {
      const sk = skills[i];
      const st = SKILL_STYLE[sk.id] ?? { bg: 0x0d1a0d, stroke: 0x336633, text: '#aaffaa', short: sk.id.slice(0, 3).toUpperCase() };
      const cx = PAD + i * chipW + chipW / 2;

      const bg = scene.add.rectangle(cx, cy, chipW - 4, CHIP_H - 4, st.bg, 1)
        .setStrokeStyle(1, st.stroke)
        .setScrollFactor(0).setDepth(DEPTH + 1).setOrigin(0.5);

      const label = scene.add.text(cx - 12, cy, st.short, {
        fontSize: '9px', color: st.text, fontStyle: 'bold',
      }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 2).setAlpha(0.7);

      const lvl = scene.add.text(cx + 12, cy, '1', {
        fontSize: '12px', color: st.text, fontStyle: 'bold',
      }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 2);

      this._skillChips.push({ bg, label, lvl, id: sk.id, style: st });
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Register a panel instance to a tab id. */
  registerPanel(tabId, panel) {
    this._panels[tabId] = panel;
  }

  /** Returns the tab content zone coordinates for panels to render into. */
  getTabZone() {
    return { x: TAB_X, y: CONTENT_Y, w: TAB_W, h: TAB_H };
  }

  getActiveTab() { return this._activeTab; }

  setActiveTab(tabId) {
    const prev = this._activeTab;
    if (prev === tabId) return;

    // Hide previous panel
    if (prev && this._panels[prev]) {
      this._panels[prev].hide();
    }

    this._activeTab = tabId;

    // Show new panel
    if (tabId && this._panels[tabId]) {
      this._panels[tabId].show();
    }

    this._refreshTabHighlights();
    this._bg.setFillStyle((tabId === 'npc' || tabId === 'command' || tabId === 'soul') ? HUD_BG_NPC : HUD_BG_NORMAL);
    this.emit('tab-changed', tabId, prev);
  }

  /** Add a context tab (shown temporarily, e.g. when near an entity). */
  showContextTab(id, label) {
    const existing = this._contextTabs.find(t => t.id === id);
    if (existing) {
      if (existing.label !== label) {
        existing.label = label;
        this._buildTabButtons(this._scene);
      }
      return;
    }
    this._contextTabs.push({ id, label, hotkey: null, context: true });
    this._buildTabButtons(this._scene);
  }

  /** Remove a context tab. */
  hideContextTab(id) {
    this._contextTabs = this._contextTabs.filter(t => t.id !== id);
    if (this._activeTab === id) {
      this._activeTab = null;
      if (this._panels[id]) this._panels[id].hide();
    }
    this._buildTabButtons(this._scene);
  }

  setBuildTabVisible(visible) {
    const next = !!visible;
    if (this._buildTabVisible === next) return;
    this._buildTabVisible = next;
    if (!next && this._activeTab === 'build') this.setActiveTab(null);
    this._buildTabButtons(this._scene);
  }

  hasTab(tabId) {
    const permanentTabs = this._buildTabVisible
      ? PERMANENT_TABS
      : PERMANENT_TABS.filter(t => t.id !== 'build');
    const allTabs = [...permanentTabs, ...this._contextTabs];
    return allTabs.some(t => t.id === tabId);
  }

  setDataSources({ inventory, skillSystem }) {
    this._inventorySource = inventory ?? null;
    this._skillSource = skillSystem ?? null;
    if (this._inventorySource) this.updateInventoryGrid(this._inventorySource);
    if (this._skillSource) this.updateSkills(this._skillSource);
  }

  refreshData() {
    if (this._inventorySource) this.updateInventoryGrid(this._inventorySource);
    if (this._skillSource) this.updateSkills(this._skillSource);
  }

  /** Called every frame. */
  updateHP(hp, maxHp) {
    const frac  = maxHp > 0 ? hp / maxHp : 0;
    const fillW = Math.max(1, Math.round(HP_W * frac));
    this._hpFill.setDisplaySize(fillW, HP_H);
    const col = frac > 0.5 ? 0x33cc44 : frac > 0.25 ? 0xeeaa22 : 0xdd2222;
    this._hpFill.setFillStyle(col);
    this._hpText.setText(`${Math.ceil(hp)} / ${maxHp}`);
    const textCol = frac > 0.5 ? '#99ddaa' : frac > 0.25 ? '#eecc88' : '#ee8888';
    this._hpText.setStyle({ color: textCol });
  }

  /** Called after machine tier upgrade. */
  updateTier(tier) {
    const labels = { 1: 'Tier I', 2: 'Tier II', 3: 'Tier III', 4: 'Tier IV' };
    this._tierText.setText(labels[tier] ?? `Tier ${tier}`);
    const col = tier >= 3 ? '#ffdd44' : tier >= 2 ? '#ccee44' : '#aacc44';
    this._tierText.setStyle({ color: col });
  }

  /** Called on skillSystem 'xp-gained'. */
  updateSkills(skillSystem) {
    for (const chip of this._skillChips) {
      const lv = skillSystem.getLevel(chip.id);
      chip.lvl.setText(String(lv));
    }
  }

  /** Called on inventory 'change'. Updates grid cells. */
  updateInventoryGrid(inventory) {
    if (!inventory) return;
    const hasSlotApi = typeof inventory.getSlots === 'function' && typeof inventory.getUnlockedSlots === 'function';
    const slots = hasSlotApi ? inventory.getSlots() : [];
    const unlocked = hasSlotApi ? inventory.getUnlockedSlots() : GRID_COLS * GRID_ROWS;
    const npcEntries = !hasSlotApi
      ? Object.entries(inventory).filter(([, qty]) => qty > 0)
      : [];

    for (const cell of this._gridCells) {
      const i = cell.slotIdx;
      if (i >= unlocked) {
        cell.bg.setFillStyle(0x040608);
        cell.bg.setStrokeStyle(1, 0x0d1218);
        cell.nameText.setText('');
        cell.qtyText.setText('');
        continue;
      }

      const slot = hasSlotApi ? slots[i] : null;
      const npcItem = !hasSlotApi ? npcEntries[i] : null;
      if (!slot && !npcItem) {
        cell.bg.setFillStyle(0x080e18);
        cell.bg.setStrokeStyle(1, 0x1a2a3a);
        cell.nameText.setText('');
        cell.qtyText.setText('');
      } else {
        const itemKey = hasSlotApi ? slot.itemKey : npcItem[0];
        const qty = hasSlotApi ? slot.qty : npcItem[1];
        const def = getItem(itemKey);
        const name = (def.name ?? itemKey);
        const abbr = name.length > 8 ? name.slice(0, 7) + '...' : name;
        cell.bg.setFillStyle(0x0c1420);
        cell.bg.setStrokeStyle(1, 0x2a4a5a);
        cell.nameText.setText(abbr);
        cell.qtyText.setText(qty > 1 ? `x${qty}` : '1');
      }
    }

    if (hasSlotApi) {
      const weight = inventory.getTotalWeight();
      const capacity = inventory.getWeightCapacity();
      const wRound = Math.round(weight * 10) / 10;
      this._gridWeightText.setText(`Weight: ${wRound} / ${capacity}`);

      const ratio = capacity > 0 ? weight / capacity : 0;
      const wCol = ratio > 0.9 ? '#ff5555' : ratio > 0.7 ? '#eeaa22' : '#446666';
      this._gridWeightText.setColor(wCol);
      this._weightText.setText(`Wt ${wRound}/${capacity}`);
      this._weightText.setColor(wCol);
    } else {
      const totalQty = npcEntries.reduce((acc, [, qty]) => acc + qty, 0);
      this._gridWeightText.setText(`Items: ${totalQty}`);
      this._gridWeightText.setColor('#446666');
      this._weightText.setText(`NPC ${totalQty}`);
      this._weightText.setColor('#446666');
    }
  }

  // Legacy — no longer used but keep for compat
  updateInventory(inventory) {
    this.updateInventoryGrid(inventory);
  }
}





