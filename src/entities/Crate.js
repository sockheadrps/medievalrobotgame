import Phaser from 'phaser';
import {
  SHEET_KEY, FRAME_CHEST, TILE_SIZE, SHEET_TILE, INTERACT_DIST,
} from '../constants.js';

const SCALE = TILE_SIZE / SHEET_TILE;

export class Crate extends Phaser.GameObjects.Image {
  constructor(scene, x, y) {
    super(scene, x, y, SHEET_KEY, FRAME_CHEST);
    scene.add.existing(this);
    this.setDepth(1);
    this.setScale(SCALE);

    this._stored = {};
    this.crateLabel = '';  // user-defined label (e.g. "raw_copper", "logs")

    this.col = Math.round((x - TILE_SIZE / 2) / TILE_SIZE);
    this.row = Math.round((y - TILE_SIZE / 2) / TILE_SIZE);

    this.setInteractive({ useHandCursor: true });
    this.on('pointerdown', (ptr) => {
      // Task recording mode — add this crate as a deposit target
      if (ptr.leftButtonDown() && scene._taskRecorder?.isRecording()) {
        const added = scene._taskRecorder.addCrateTarget(this);
        if (added) {
          scene._chatBox?._addLog(`[Task] Added crate: ${this.crateLabel || 'unlabeled'}`, '#4488ff');
          scene._chatBox?._addLog(`[Task] ${scene._taskRecorder.getRecordingSummary()}`, '#888888');
        } else {
          scene._chatBox?._addLog(`[Task] Crate already added.`, '#ffaa44');
        }
        return;
      }
      if (ptr.rightButtonDown()) {
        scene.events.emit('object-right-clicked', { type: 'crate', obj: this, ptr });
      }
    });

    this._nameText = scene.add.text(x, y - TILE_SIZE / 2 - 4, 'STORAGE', {
      fontSize: '10px', color: '#ccccff', align: 'center',
      backgroundColor: '#00000088', padding: { x: 3, y: 2 },
    }).setOrigin(0.5, 1).setDepth(3).setVisible(false);

    this._prompt = scene.add.text(x, y - TILE_SIZE / 2 - 18, '[E] Open', {
      fontSize: '10px', color: '#ffffff', align: 'center',
      backgroundColor: '#00000088', padding: { x: 3, y: 2 },
    }).setOrigin(0.5, 1).setDepth(3).setVisible(false);

    this._contentsLabel = scene.add.text(x, y + TILE_SIZE / 2 + 2, '', {
      fontSize: '9px', color: '#aaccee', align: 'center',
      backgroundColor: '#00000088', padding: { x: 2, y: 1 },
    }).setOrigin(0.5, 0).setDepth(3).setVisible(false);
  }

  // ── Label ─────────────────────────────────────────────────────────────────

  setLabel(label) {
    this.crateLabel = label || '';
    this._nameText.setText(this.crateLabel || 'STORAGE');
    if (this.crateLabel) {
      this._nameText.setColor('#ffdd66');
    } else {
      this._nameText.setColor('#ccccff');
    }
  }

  getLabel() { return this.crateLabel; }

  // ── Proximity — call from scene update() ─────────────────────────────────

  updateProximity(playerX, playerY) {
    const dist = Phaser.Math.Distance.Between(playerX, playerY, this.x, this.y);
    const inRange  = dist <= INTERACT_DIST;
    const adjacent = dist <= TILE_SIZE * 2;
    this._prompt.setVisible(inRange);
    this._nameText.setVisible(adjacent);
    this._updateContentsLabel(adjacent);
    return inRange;
  }

  _updateContentsLabel(visible) {
    const entries = Object.entries(this._stored).filter(([, q]) => q > 0);
    if (!visible || entries.length === 0) {
      this._contentsLabel.setVisible(false);
      return;
    }
    const text = entries.map(([k, v]) => `${k}: ${v}`).join('  ');
    this._contentsLabel.setText(text).setVisible(true);
  }

  // ── Storage API — used by conveyors ──────────────────────────────────────

  getStored() {
    return { ...this._stored };
  }

  addToStorage(resource, amount) {
    // If a label is set, only accept matching items
    if (this.crateLabel) {
      const labelKey = this.crateLabel === 'logs' ? 'Wood' : this.crateLabel;
      if (resource !== labelKey) return false;
    }
    this._stored[resource] = (this._stored[resource] ?? 0) + amount;
    return true;
  }

  _applyServerStored(stored) {
    this._stored = { ...stored };
  }

  removeFromStorage(resource, amount) {
    this._stored[resource] = Math.max(0, (this._stored[resource] ?? 0) - amount);
    if (this._stored[resource] === 0) delete this._stored[resource];
  }

  destroy(fromScene) {
    this._nameText?.destroy();
    this._prompt?.destroy();
    this._contentsLabel?.destroy();
    super.destroy(fromScene);
  }
}
