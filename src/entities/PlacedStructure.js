// PlacedStructure — a placed wall block (ReinforcedBlock or WoodFrame).
// Blocks player/NPC/enemy movement via Arcade static body.
// Has HP; when broken it drops partial materials and removes itself from the grid.

import Phaser from 'phaser';
import {
  SHEET_KEY, SHEET_TILE, TILE_SIZE,
  FRAME_CRAFTING_BENCH, FRAME_WOOD_FRAME_WALL, FRAME_WOOD_BUILDING,
} from '../constants.js';
import { GroundItem } from './GroundItem.js';

const SCALE = TILE_SIZE / SHEET_TILE;

const TYPE_CONFIG = {
  reinforced_block: {
    frame:   FRAME_CRAFTING_BENCH,  // frame 944
    maxHp:   60,
    dropItem:'Stone',
    dropQty: 5,
    label:   'Reinforced Block',
  },
  wood_frame: {
    frame:   FRAME_WOOD_FRAME_WALL, // frame 951
    maxHp:   25,
    dropItem:'Wood',
    dropQty: 2,
    label:   'Wood Frame',
  },
  wood_wall: {
    frame:   FRAME_WOOD_BUILDING,
    maxHp:   32,
    dropItem:'Wood',
    dropQty: 4,
    label:   'Wood Wall',
  },
};

const HP_BAR_W = 32;
const HP_BAR_H = 4;

export class PlacedStructure extends Phaser.GameObjects.Image {
  /**
   * @param {Phaser.Scene} scene
   * @param {number} col
   * @param {number} row
   * @param {'reinforced_block'|'wood_frame'} type
   */
  constructor(scene, col, row, type) {
    const cfg = TYPE_CONFIG[type] ?? TYPE_CONFIG.reinforced_block;
    const x = col * TILE_SIZE + TILE_SIZE / 2;
    const y = row * TILE_SIZE + TILE_SIZE / 2;
    super(scene, x, y, SHEET_KEY, cfg.frame);
    scene.add.existing(this);
    this.setDepth(1).setScale(SCALE);

    this.col  = col;
    this.row  = row;
    this.type = type;

    this.maxHp = cfg.maxHp;
    this.hp    = this.maxHp;
    this._cfg  = cfg;

    this._broken = false;

    this.setInteractive({ useHandCursor: true });
    this.on('pointerdown', (ptr) => {
      if (ptr.rightButtonDown()) {
        scene.events.emit('object-right-clicked', { type: 'structure', obj: this, ptr });
      }
    });

    // HP bar — only visible when damaged
    const barBgY = y - TILE_SIZE / 2 - 6;
    this._hpBg   = scene.add.rectangle(x, barBgY, HP_BAR_W, HP_BAR_H, 0x330000)
      .setDepth(4).setOrigin(0.5, 0.5).setVisible(false);
    this._hpFill = scene.add.rectangle(x - HP_BAR_W / 2, barBgY, HP_BAR_W, HP_BAR_H, 0xff4444)
      .setDepth(5).setOrigin(0, 0.5).setVisible(false);
  }

  isDead() { return this._broken; }

  /**
   * @param {number} amount
   */
  takeDamage(amount) {
    if (this._broken) return;
    this.hp = Math.max(0, this.hp - amount);
    this._updateHPBar();
    if (this.hp <= 0) this._break();
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  _updateHPBar() {
    const frac  = this.maxHp > 0 ? Math.max(0, this.hp / this.maxHp) : 0;
    const fillW = Math.round(HP_BAR_W * frac);
    this._hpFill.setDisplaySize(Math.max(0, fillW), HP_BAR_H);
    const col = frac > 0.5 ? 0xff8844 : frac > 0.25 ? 0xff6600 : 0xff2200;
    this._hpFill.setFillStyle(col);
    this._hpBg.setVisible(true);
    this._hpFill.setVisible(true);
  }

  _break() {
    this._broken = true;

    const scene = this.scene;

    // Remove from grid
    scene.grid?.remove(this.col, this.row);

    // Remove from structureGroup — body only, do NOT destroy (tween needs the object alive)
    scene.structureGroup?.remove(this, false, false);

    // Remove from scene.structures array
    if (scene.structures) {
      const idx = scene.structures.indexOf(this);
      if (idx !== -1) scene.structures.splice(idx, 1);
    }

    // Drop materials
    new GroundItem(scene, this.x, this.y, this._cfg.dropItem, this._cfg.dropQty);

    // Flash then destroy
    scene.tweens.add({
      targets: this,
      alpha: 0,
      duration: 200,
      onComplete: () => this.destroy(),
    });
  }

  destroy(fromScene) {
    this._hpBg?.destroy();
    this._hpFill?.destroy();
    super.destroy(fromScene);
  }
}
