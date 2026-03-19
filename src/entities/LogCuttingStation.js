import Phaser from 'phaser';
import {
  SHEET_KEY, SHEET_TILE, TILE_SIZE, INTERACT_DIST,
  FRAME_LOG_CUTTER,
} from '../constants.js';

const SCALE      = TILE_SIZE / SHEET_TILE;
const MAX_LOGS   = 5;

export class LogCuttingStation extends Phaser.GameObjects.Image {
  constructor(scene, x, y) {
    super(scene, x, y, SHEET_KEY, FRAME_LOG_CUTTER);
    scene.add.existing(this);
    this.setDepth(1).setScale(SCALE);

    this.col = Math.round((x - TILE_SIZE / 2) / TILE_SIZE);
    this.row = Math.round((y - TILE_SIZE / 2) / TILE_SIZE);

    // Slots
    this._logs   = 0;  // input
    this._planks = 0;  // output
    this._cutting = false;

    this.setInteractive({ useHandCursor: true });
    this.on('pointerdown', (ptr) => {
      if (ptr.rightButtonDown()) {
        scene.events.emit('object-right-clicked', { type: 'log_cutter', obj: this, ptr });
      }
    });

    this._label = scene.add.text(x, y - TILE_SIZE / 2 - 4, 'LOG CUTTER', {
      fontSize: '10px', color: '#ccaa44', align: 'center',
      backgroundColor: '#00000088', padding: { x: 3, y: 2 },
    }).setOrigin(0.5, 1).setDepth(3).setVisible(false);

    this._prompt = scene.add.text(x, y - TILE_SIZE / 2 - 18, '[E] Open', {
      fontSize: '10px', color: '#ffffff', align: 'center',
      backgroundColor: '#00000088', padding: { x: 3, y: 2 },
    }).setOrigin(0.5, 1).setDepth(3).setVisible(false);

    this._statusLabel = scene.add.text(x, y + TILE_SIZE / 2 + 2, '', {
      fontSize: '9px', color: '#ddcc88', align: 'center',
      backgroundColor: '#00000099', padding: { x: 3, y: 1 },
    }).setOrigin(0.5, 0).setDepth(3).setVisible(false);

    this._updateLabel();
  }

  // ── Proximity ──────────────────────────────────────────────────────────────

  updateProximity(playerX, playerY) {
    const dist = Phaser.Math.Distance.Between(playerX, playerY, this.x, this.y);
    const inRange  = dist <= INTERACT_DIST;
    const adjacent = dist <= TILE_SIZE * 2;
    this._prompt.setVisible(inRange);
    this._label.setVisible(adjacent);
    this._statusLabel.setVisible(adjacent);
    return inRange;
  }

  // ── Storage API ────────────────────────────────────────────────────────────

  addToStorage(resource, amount) {
    if (resource === 'Wood' || resource === 'logs') {
      if (this._logs >= MAX_LOGS) return false;
      this._logs = Math.min(MAX_LOGS, this._logs + amount);
      this._updateLabel();
      return true;
    }
    return false;
  }

  _applyServerStored(stored) {
    this._logs = stored.Wood ?? stored.logs ?? 0;
    this._planks = stored.planks ?? 0;
    this._updateLabel();
  }

  removeFromStorage(resource, amount) {
    if (resource === 'Wood' || resource === 'logs') {
      this._logs = Math.max(0, this._logs - amount);
    } else if (resource === 'planks') {
      this._planks = Math.max(0, this._planks - amount);
    }
    this._updateLabel();
  }

  getStored() {
    return {
      Wood: this._logs,
      planks: this._planks,
    };
  }

  // Server handles cutting and track pushing; client just renders state
  tick() {}

  setGrid(grid) { this._grid = grid; }

  /** Set the MinecartTrack class reference to avoid circular imports */
  setTrackClass(cls) { this._MinecartTrackClass = cls; }

  _updateLabel() {
    if (!this._statusLabel || !this._statusLabel.scene) return;
    const parts = [];
    if (this._logs > 0) parts.push('Cutting\u2026');
    if (this._logs > 0) parts.push(`logs:${this._logs}`);
    if (this._planks > 0) parts.push(`planks:${this._planks}`);
    if (parts.length === 0) parts.push('empty');
    this._statusLabel.setText(parts.join(' '));
  }

  destroy(fromScene) {
    this._label?.destroy();
    this._prompt?.destroy();
    this._statusLabel?.destroy();
    super.destroy(fromScene);
  }
}
