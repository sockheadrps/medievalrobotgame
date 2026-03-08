// WoodRobotChasisPod
// Charges from an adjacent flywheel when momentum is high enough.

import Phaser from 'phaser';
import {
  SHEET_KEY,
  SHEET_TILE,
  TILE_SIZE,
  INTERACT_DIST,
  FRAME_WOOD_ROBOT_POD,
  DIR_DELTA,
} from '../constants.js';

const SCALE = TILE_SIZE / SHEET_TILE;
const CHARGE_REQUIRED = 100;
const CHARGE_PER_SEC = 1.6;
const MIN_FLYWHEEL_MOMENTUM = 75;
const HATCH_REQUIRED_SEC = 30;
const HATCH_PER_SEC = 1;
const BAR_W = TILE_SIZE - 4;
const BAR_H = 5;

export class WoodRobotChasisPod extends Phaser.GameObjects.Image {
  constructor(scene, col, row) {
    const x = col * TILE_SIZE + TILE_SIZE / 2;
    const y = row * TILE_SIZE + TILE_SIZE / 2;
    super(scene, x, y, SHEET_KEY, FRAME_WOOD_ROBOT_POD);
    scene.add.existing(this);
    this.setDepth(1).setScale(SCALE).setTint(0xb88a55);

    this.col = col;
    this.row = row;
    this.charge = 0;
    this.chargeRequired = CHARGE_REQUIRED;
    this.hatch = 0;
    this.hatchRequired = HATCH_REQUIRED_SEC;
    this._hatched = false;

    this.setInteractive();
    this.on('pointerdown', (ptr) => {
      if (ptr.rightButtonDown()) {
        scene.events.emit('object-right-clicked', { type: 'wood_robot_pod', obj: this, ptr });
      }
    });

    this._label = scene.add.text(x, y - TILE_SIZE / 2 - 4, 'WOOD POD', {
      fontSize: '10px', color: '#d9b37a', align: 'center',
      backgroundColor: '#00000088', padding: { x: 3, y: 2 },
    }).setOrigin(0.5, 1).setDepth(3).setVisible(false);

    this._status = scene.add.text(x, y + TILE_SIZE / 2 + 2, '', {
      fontSize: '9px', color: '#d9b37a', align: 'center',
      backgroundColor: '#00000099', padding: { x: 3, y: 1 },
    }).setOrigin(0.5, 0).setDepth(3).setVisible(false);

    const barY = y + TILE_SIZE / 2 + 14;
    this._barBg = scene.add.rectangle(x, barY, BAR_W, BAR_H, 0x222233).setDepth(3).setOrigin(0.5, 0).setVisible(false);
    this._barFill = scene.add.rectangle(x - BAR_W / 2, barY, 0, BAR_H, 0xd9b37a).setDepth(4).setOrigin(0, 0).setVisible(false);
  }

  update(delta) {
    if (this._hatched || !this.active) return;

    if (this.charge < this.chargeRequired) {
      if (this._canChargeFromAdjacentFlywheel()) {
        this.charge = Math.min(this.chargeRequired, this.charge + (CHARGE_PER_SEC * delta) / 1000);
      }
    } else {
      this.hatch = Math.min(this.hatchRequired, this.hatch + (HATCH_PER_SEC * delta) / 1000);
      if (this.hatch >= this.hatchRequired) {
        this._hatched = true;
        this.scene.events.emit('wood-pod-hatched', { pod: this });
        return;
      }
    }
    this._updateStatus();
  }

  updateProximity(playerX, playerY) {
    const dist = Phaser.Math.Distance.Between(playerX, playerY, this.x, this.y);
    const adjacent = dist <= TILE_SIZE * 1.5;
    const show = this.scene.labelsVisible ?? true;
    this._label.setVisible(adjacent && show);
    this._status.setVisible(adjacent && show);
    // Keep progress bar visible while labels are enabled so pod state is readable.
    this._barBg.setVisible(show);
    this._barFill.setVisible(show);
    return dist <= INTERACT_DIST;
  }

  refreshLabels(visible) {
    if (!visible) {
      this._label.setVisible(false);
      this._status.setVisible(false);
      this._barBg.setVisible(false);
      this._barFill.setVisible(false);
    }
  }

  _canChargeFromAdjacentFlywheel() {
    const grid = this.scene.grid;
    if (!grid) return false;
    for (const dir of ['right', 'left', 'up', 'down']) {
      const { dc, dr } = DIR_DELTA[dir];
      const e = grid.get(this.col + dc, this.row + dr);
      if (!e || typeof e.getMomentum !== 'function') continue;
      if (e.getMomentum() >= MIN_FLYWHEEL_MOMENTUM) return true;
    }
    return false;
  }

  _updateStatus() {
    if (!this._status || !this._barFill || !this.active) return;

    if (this.charge < this.chargeRequired) {
      const pct = Math.round((this.charge / this.chargeRequired) * 100);
      this._status.setText(`Charge ${pct}%`);
      this._barFill.setFillStyle(0xd9b37a);
      this._barFill.setDisplaySize(Math.round(BAR_W * (this.charge / this.chargeRequired)), BAR_H);
      return;
    }

    const hatchPct = Math.round((this.hatch / this.hatchRequired) * 100);
    this._status.setText(this._hatched ? 'Online' : `Boot ${hatchPct}%`);
    this._barFill.setFillStyle(0x89d4a0);
    this._barFill.setDisplaySize(Math.round(BAR_W * (this.hatch / this.hatchRequired)), BAR_H);
  }

  destroy(fromScene) {
    this._label?.destroy();
    this._status?.destroy();
    this._barBg?.destroy();
    this._barFill?.destroy();
    super.destroy(fromScene);
  }
}
