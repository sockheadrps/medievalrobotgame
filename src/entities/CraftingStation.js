import Phaser from 'phaser';
import { SHEET_KEY, SHEET_TILE, TILE_SIZE, FRAME_FURNACE, SHEET_COLS, INTERACT_DIST } from '../constants.js';

const SCALE = TILE_SIZE / SHEET_TILE;

export class CraftingStation extends Phaser.GameObjects.Image {
  constructor(scene, x, y, assetId, label, initialStored = {}, spriteDef = null) {
    const frame = spriteDef?.tileCol != null
      ? spriteDef.tileCol + (spriteDef.tileRow ?? 0) * SHEET_COLS
      : FRAME_FURNACE;
    super(scene, x, y, SHEET_KEY, frame);
    scene.add.existing(this);
    this.setDepth(1).setScale(SCALE);
    this.col = Math.round((x - TILE_SIZE / 2) / TILE_SIZE);
    this.row = Math.round((y - TILE_SIZE / 2) / TILE_SIZE);
    this._assetId = assetId;
    this._stored = { ...initialStored };

    this.setInteractive({ useHandCursor: true });
    this.on('pointerdown', (ptr) => {
      if (ptr.rightButtonDown()) {
        scene.events.emit('object-right-clicked', { type: 'crafting_station', obj: this, ptr });
      }
    });

    this._label = scene.add.text(x, y - TILE_SIZE / 2 - 4, label || assetId, {
      fontSize: '10px', color: '#ff9944', align: 'center',
      backgroundColor: '#00000088', padding: { x: 3, y: 2 },
    }).setOrigin(0.5, 1).setDepth(3).setVisible(false);

    this._prompt = scene.add.text(x, y - TILE_SIZE / 2 - 18, '[E] Station', {
      fontSize: '10px', color: '#ffffff', align: 'center',
      backgroundColor: '#00000088', padding: { x: 3, y: 2 },
    }).setOrigin(0.5, 1).setDepth(3).setVisible(false);
  }

  updateProximity(playerX, playerY) {
    const d = Phaser.Math.Distance.Between(playerX, playerY, this.x, this.y);
    const inRange = d <= INTERACT_DIST;
    this._prompt.setVisible(inRange);
    this._label.setVisible(d <= TILE_SIZE * 2);
    return inRange;
  }

  getStored() { return { ...this._stored }; }

  addToStorage(resource, amount) {
    this._stored[resource] = (this._stored[resource] || 0) + amount;
    return true;
  }

  removeFromStorage(resource, amount) {
    if ((this._stored[resource] || 0) < amount) return false;
    this._stored[resource] -= amount;
    if (this._stored[resource] <= 0) delete this._stored[resource];
    return true;
  }

  applyServerStored(stored) { this._stored = { ...stored }; }

  // Alias for compatibility with syncBuildings _applyServerStored call pattern
  _applyServerStored(stored) { this.applyServerStored(stored); }

  setStored(stored) { this._stored = { ...stored }; }

  setGrid(grid) { this._grid = grid; }

  destroy(fromScene) {
    this._label?.destroy();
    this._prompt?.destroy();
    super.destroy(fromScene);
  }
}
