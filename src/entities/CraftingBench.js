// CraftingBench — a construction crafting station.
// E to open the panel when adjacent.
// Space while adjacent starts a craft using the selected recipe.
//
// Recipes:
//   10 Stone  →  1 ReinforcedBlock (2 s)
//    5 Wood   →  1 WoodenFrame     (1.5 s)

import Phaser from 'phaser';
import {
  SHEET_KEY, SHEET_TILE, TILE_SIZE, INTERACT_DIST,
  FRAME_CRAFTING_BENCH,
} from '../constants.js';

const SCALE = TILE_SIZE / SHEET_TILE;

export const BENCH_RECIPES = [
  {
    id:         'reinforced_block',
    label:      'Reinforced Block',
    inputItem:  'Stone',
    inputQty:   10,
    outputItem: 'ReinforcedBlock',
    outputQty:  1,
    craftMs:    2000,
  },
  {
    id:         'wood_frame',
    label:      'Wood Frame',
    inputItem:  'Wood',
    inputQty:   5,
    outputItem: 'WoodenFrame',
    outputQty:  1,
    craftMs:    1500,
  },
];

export class CraftingBench extends Phaser.GameObjects.Image {
  constructor(scene, col, row) {
    const x = col * TILE_SIZE + TILE_SIZE / 2;
    const y = row * TILE_SIZE + TILE_SIZE / 2;
    super(scene, x, y, SHEET_KEY, FRAME_CRAFTING_BENCH);
    scene.add.existing(this);
    this.setDepth(1).setScale(SCALE);

    this.col = col;
    this.row = row;

    this._crafting     = false;
    this._craftStart   = 0;
    this._craftMs      = 0;
    this._panel        = null;
    this._activeRecipe = BENCH_RECIPES[0];

    // Progress bar
    const BAR_W = TILE_SIZE - 4;
    const BAR_H = 4;
    const barY  = y + TILE_SIZE / 2 + 14;
    this._craftBarBg   = scene.add.rectangle(x, barY, BAR_W, BAR_H, 0x222233).setDepth(3).setOrigin(0.5, 0).setVisible(false);
    this._craftBarFill = scene.add.rectangle(x - BAR_W / 2, barY, 0, BAR_H, 0xbbaa66).setDepth(4).setOrigin(0, 0).setVisible(false);

    scene.time.addEvent({
      delay: 80,
      loop: true,
      callback: () => {
        if (!this._crafting) {
          this._craftBarBg.setVisible(false);
          this._craftBarFill.setVisible(false);
          return;
        }
        const p = this.getCraftProgress();
        this._craftBarBg.setVisible(true);
        this._craftBarFill.setDisplaySize(Math.round(BAR_W * p), BAR_H).setVisible(true);
      },
    });

    this.setInteractive({ useHandCursor: true });
    this.on('pointerdown', (ptr) => {
      if (ptr.event.ctrlKey) {
        scene.events.emit('object-ctrl-clicked', { type: 'crafting_bench', obj: this });
      } else if (ptr.rightButtonDown()) {
        scene.events.emit('object-right-clicked', { type: 'crafting_bench', obj: this, ptr });
      } else {
        scene.events.emit('crafting-bench-clicked', this);
      }
    });

    // Labels
    this._label = scene.add.text(x, y - TILE_SIZE / 2 - 4, 'CRAFTING BENCH', {
      fontSize: '10px', color: '#ccbb88', align: 'center',
      backgroundColor: '#00000088', padding: { x: 3, y: 2 },
    }).setOrigin(0.5, 1).setDepth(3).setVisible(false);

    this._prompt = scene.add.text(x, y - TILE_SIZE / 2 - 18, '[E] Craft', {
      fontSize: '10px', color: '#ffffff', align: 'center',
      backgroundColor: '#00000088', padding: { x: 3, y: 2 },
    }).setOrigin(0.5, 1).setDepth(3).setVisible(false);

    this._statusLabel = scene.add.text(x, y + TILE_SIZE / 2 + 2, '', {
      fontSize: '9px', color: '#ccbb88', align: 'center',
      backgroundColor: '#00000099', padding: { x: 3, y: 1 },
    }).setOrigin(0.5, 0).setDepth(3).setVisible(false);
  }

  setPanel(panel) { this._panel = panel; }

  openPanel() {
    if (this._panel) this._panel.open(this);
  }

  // ── Proximity ───────────────────────────────────────────────────────────────

  updateProximity(playerX, playerY) {
    const dist     = Phaser.Math.Distance.Between(playerX, playerY, this.x, this.y);
    const inRange  = dist <= INTERACT_DIST;
    const adjacent = dist <= TILE_SIZE * 1.5;
    const show     = this.scene?.labelsVisible ?? true;
    this._prompt.setVisible(inRange && !this._crafting && show);
    this._label.setVisible(adjacent && show);
    this._statusLabel.setVisible(adjacent && show);
    return inRange;
  }

  refreshLabels(visible) {
    if (!visible) {
      this._label.setVisible(false);
      this._statusLabel.setVisible(false);
      this._prompt.setVisible(false);
    }
  }

  // ── Crafting API ────────────────────────────────────────────────────────────

  startCraft(inventory, onComplete) {
    if (this._crafting) return false;
    const recipe = this._activeRecipe;
    if (!recipe) return false;

    const have = this._invGet(inventory, recipe.inputItem);
    if (have < recipe.inputQty) return false;

    this._invSet(inventory, recipe.inputItem, have - recipe.inputQty);

    this._crafting   = true;
    this._craftStart = this.scene.time.now;
    this._craftMs    = recipe.craftMs;
    this._updateStatus();

    this.scene.time.delayedCall(recipe.craftMs, () => {
      this._crafting   = false;
      this._craftStart = 0;
      this._updateStatus();

      if (typeof inventory.add === 'function') {
        inventory.add(recipe.outputItem, recipe.outputQty);
      } else {
        inventory[recipe.outputItem] = (inventory[recipe.outputItem] ?? 0) + recipe.outputQty;
      }

      if (onComplete) onComplete({ outputItem: recipe.outputItem, outputQty: recipe.outputQty });
      if (this._panel?.isOpen()) this._panel._refresh();
    });

    return true;
  }

  isCrafting() { return this._crafting; }

  setActiveRecipe(recipe) {
    this._activeRecipe = recipe;
    this._updateStatus();
  }

  getCraftProgress() {
    if (!this._crafting || !this._craftMs) return 0;
    return Math.min(1, (this.scene.time.now - this._craftStart) / this._craftMs);
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  _updateStatus() {
    if (this._crafting) {
      this._statusLabel.setText('Crafting…');
    } else if (this._activeRecipe) {
      this._statusLabel.setText(this._activeRecipe.label);
    } else {
      this._statusLabel.setText('');
    }
  }

  _invGet(inv, key) {
    return typeof inv.get === 'function' ? inv.get(key) : (inv[key] ?? 0);
  }

  _invSet(inv, key, value) {
    if (typeof inv.set === 'function') {
      inv.set(key, value);
    } else {
      inv[key] = value;
    }
  }

  destroy(fromScene) {
    this._label?.destroy();
    this._prompt?.destroy();
    this._statusLabel?.destroy();
    this._craftBarBg?.destroy();
    this._craftBarFill?.destroy();
    super.destroy(fromScene);
  }
}
