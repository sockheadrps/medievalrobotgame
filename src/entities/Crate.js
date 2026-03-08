import Phaser from 'phaser';
import {
  SHEET_KEY, FRAME_CHEST, FRAME_WOOD_STORAGE, TILE_SIZE, SHEET_TILE, INTERACT_DIST,
} from '../constants.js';

const SCALE = TILE_SIZE / SHEET_TILE;
const VARIANT_CONFIG = {
  storage: {
    frame: FRAME_CHEST,
    label: 'STORAGE',
    color: '#ccccff',
    tint: null,
  },
  wood_storage: {
    frame: FRAME_WOOD_STORAGE,
    label: 'WOOD STORAGE',
    color: '#d8b070',
    tint: null,
  },
};

export class Crate extends Phaser.GameObjects.Image {
  constructor(scene, x, y, opts = {}) {
    const variant = opts.variant ?? 'storage';
    const cfg = VARIANT_CONFIG[variant] ?? VARIANT_CONFIG.storage;
    super(scene, x, y, SHEET_KEY, cfg.frame);
    scene.add.existing(this);
    this.setDepth(1);
    this.setScale(SCALE);
    if (cfg.tint != null) this.setTint(cfg.tint);

    this._stored     = {};
    this._panel      = null;   // StoragePanel injected after construction
    this._acceptList = null;   // null = accept all; string[] = whitelist
    this._variant    = variant;

    this.col = Math.round((x - TILE_SIZE / 2) / TILE_SIZE);
    this.row = Math.round((y - TILE_SIZE / 2) / TILE_SIZE);

    // Ctrl+click to assign to selected NPC; right-click for context menu
    this.setInteractive();
    this.on('pointerdown', (ptr) => {
      if (ptr.event.ctrlKey) scene.events.emit('object-ctrl-clicked', { type: 'crate', obj: this });
      else if (ptr.rightButtonDown()) scene.events.emit('object-right-clicked', { type: 'crate', obj: this, ptr });
    });

    this._label = scene.add.text(x, y - TILE_SIZE / 2 - 4, cfg.label, {
      fontSize: '10px', color: cfg.color, align: 'center',
      backgroundColor: '#00000088', padding: { x: 3, y: 2 }
    }).setOrigin(0.5, 1).setDepth(3).setVisible(false);
    this._filterLabel = scene.add.text(x, y - TILE_SIZE / 2 - 18, '', {
      fontSize: '9px', color: '#ffcc66', align: 'center',
      backgroundColor: '#00000099', padding: { x: 3, y: 1 }
    }).setOrigin(0.5, 1).setDepth(3).setVisible(false);

    this._prompt = scene.add.text(x, y - TILE_SIZE / 2 - 18, '[E] Open', {
      fontSize: '10px', color: '#ffffff', align: 'center',
      backgroundColor: '#00000088', padding: { x: 3, y: 2 }
    }).setOrigin(0.5, 1).setDepth(3).setVisible(false);
  }

  // Inject the StoragePanel after both are constructed
  setPanel(panel) {
    this._panel = panel;
  }

  // ── Accept-list filter ────────────────────────────────────────────────────

  /** Set which item keys this crate accepts. Pass null to accept everything. */
  setAcceptList(list) {
    this._acceptList = list && list.length > 0 ? [...list] : null;
    this._updateFilterLabel();
  }

  getAcceptList() { return this._acceptList ? [...this._acceptList] : null; }

  /** Returns true if this crate will accept the given resource key. */
  acceptsItem(resKey) {
    if (!this._acceptList) return true;
    return this._acceptList.includes(resKey);
  }

  _updateFilterLabel() {
    if (!this._filterLabel) return;
    if (!this._acceptList) {
      this._filterLabel.setText('').setVisible(false);
    } else {
      const names = this._acceptList.join(', ');
      this._filterLabel.setText(`[${names}]`);
    }
  }

  // ── Proximity ─────────────────────────────────────────────────────────────

  // Called every frame from GameScene.update()
  updateProximity(playerX, playerY) {
    const dist = Phaser.Math.Distance.Between(playerX, playerY, this.x, this.y);
    const inRange  = dist <= INTERACT_DIST;
    const adjacent = dist <= TILE_SIZE * 1.5;
    const show     = this.scene.labelsVisible ?? true;
    this._prompt.setVisible(inRange && show);
    this._label.setVisible(adjacent && show);
    this._filterLabel?.setVisible(adjacent && show && !!this._acceptList);
    return inRange;
  }

  refreshLabels(visible) {
    if (!visible) {
      this._label.setVisible(false);
      this._prompt.setVisible(false);
      this._filterLabel?.setVisible(false);
    }
  }

  // Called by GameScene._handleInteract()
  openPanel() {
    if (this._panel) this._panel.open(this);
  }
  getVariant() { return this._variant; }

  // --- Storage API used by StoragePanel ---
  getStored() {
    return { ...this._stored };
  }

  addToStorage(resource, amount) {
    if (!this.acceptsItem(resource)) return false;
    this._stored[resource] = (this._stored[resource] ?? 0) + amount;
    return true;
  }

  removeFromStorage(resource, amount) {
    this._stored[resource] = Math.max(0, (this._stored[resource] ?? 0) - amount);
  }

  destroy(fromScene) {
    this._label?.destroy();
    this._prompt?.destroy();
    this._filterLabel?.destroy();
    super.destroy(fromScene);
  }
}
