// Door — a placeable door.
// Press E when close to open/close.
// Player and NPCs auto-open when walking through it.
// Enemies cannot open it; they attack it instead.
// When closed, occupies a grid tile and blocks movement via static physics body.
// When open, removed from grid — passable.

import Phaser from 'phaser';
import {
  SHEET_KEY, SHEET_TILE, TILE_SIZE, INTERACT_DIST,
  FRAME_DOOR_CLOSED, FRAME_DOOR_OPEN,
} from '../constants.js';
import { GroundItem } from './GroundItem.js';

const SCALE    = TILE_SIZE / SHEET_TILE;
const HP_BAR_W = 32;
const HP_BAR_H = 4;

export class Door extends Phaser.GameObjects.Image {
  constructor(scene, col, row) {
    const x = col * TILE_SIZE + TILE_SIZE / 2;
    const y = row * TILE_SIZE + TILE_SIZE / 2;
    super(scene, x, y, SHEET_KEY, FRAME_DOOR_CLOSED);
    scene.add.existing(this);
    this.setDepth(1).setScale(SCALE);

    this.col = col;
    this.row = row;

    this._open   = false;
    this._broken = false;

    this.maxHp = 30;
    this.hp    = this.maxHp;

    // HP bar
    const barBgY = y - TILE_SIZE / 2 - 6;
    this._hpBg   = scene.add.rectangle(x, barBgY, HP_BAR_W, HP_BAR_H, 0x330000)
      .setDepth(4).setOrigin(0.5, 0.5).setVisible(false);
    this._hpFill = scene.add.rectangle(x - HP_BAR_W / 2, barBgY, HP_BAR_W, HP_BAR_H, 0xff8844)
      .setDepth(5).setOrigin(0, 0.5).setVisible(false);

    this.setInteractive({ useHandCursor: true });
    this.on('pointerdown', (ptr) => {
      if (ptr.rightButtonDown()) {
        scene.events.emit('object-right-clicked', { type: 'door', obj: this, ptr });
      }
    });

    // Prompt label
    this._prompt = scene.add.text(x, y - TILE_SIZE / 2 - 18, '[E] Open', {
      fontSize: '10px', color: '#ffffff', align: 'center',
      backgroundColor: '#00000088', padding: { x: 3, y: 2 },
    }).setOrigin(0.5, 1).setDepth(3).setVisible(false);
  }

  isOpen()  { return this._open; }
  isDead()  { return this._broken; }

  open() {
    if (this._broken || this._open) return;
    this._open = true;
    this.setFrame(FRAME_DOOR_OPEN);
    this.setAlpha(0.6); // visually distinct when open

    const scene = this.scene;
    // Remove from grid (passable)
    scene?.grid?.remove(this.col, this.row);
    // Remove static body only — do NOT destroy the game object (false, false)
    scene?.structureGroup?.remove(this, false, false);
  }

  close() {
    if (this._broken || !this._open) return;
    this._open = false;
    this.setFrame(FRAME_DOOR_CLOSED);
    this.setAlpha(1);

    const scene = this.scene;
    // Re-register in grid
    scene?.grid?.place(this.col, this.row, this);
    // Re-add static body and refresh bounds
    if (scene?.structureGroup) {
      scene.structureGroup.add(this);
      scene.structureGroup.refresh();
    }
  }

  toggle() {
    if (this._broken) return;
    this._open ? this.close() : this.open();
  }

  takeDamage(amount) {
    if (this._broken) return;
    this.hp = Math.max(0, this.hp - amount);
    this._updateHPBar();
    if (this.hp <= 0) this._break();
  }

  updateProximity(playerX, playerY) {
    if (this._broken || !this._prompt) {
      this._prompt?.setVisible(false);
      return false;
    }
    const dist    = Phaser.Math.Distance.Between(playerX, playerY, this.x, this.y);
    const inRange = dist <= INTERACT_DIST;
    const show    = this.scene?.labelsVisible ?? true;
    this._prompt.setText(this._open ? '[E] Close' : '[E] Open');
    this._prompt.setVisible(inRange && show);
    return inRange;
  }

  refreshLabels(visible) {
    if (!visible) this._prompt.setVisible(false);
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
    this._open   = false;

    const scene = this.scene;
    scene.grid?.remove(this.col, this.row);
    scene.structureGroup?.remove(this, false, false);

    if (scene.doors) {
      const idx = scene.doors.indexOf(this);
      if (idx !== -1) scene.doors.splice(idx, 1);
    }

    // Small wood drop
    new GroundItem(scene, this.x, this.y, 'Wood', 2);

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
    this._prompt?.destroy();
    super.destroy(fromScene);
  }
}
