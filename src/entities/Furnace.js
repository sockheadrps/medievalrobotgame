import Phaser from 'phaser';
import {
  SHEET_KEY, SHEET_TILE, TILE_SIZE, INTERACT_DIST,
  FRAME_FURNACE, DIR_DELTA, RESOURCE_FRAME,
} from '../constants.js';
import { Conveyor } from './Conveyor.js';

const SCALE        = TILE_SIZE / SHEET_TILE;
const MAX_INPUT    = 5;    // max of each ore held
const MAX_BARS     = 20;   // max output bars
const MAX_FUEL     = 10;   // max planks in firebox
const SMELT_MS     = 5000; // ms per smelt cycle
const WOOD_BURN_MS = 8000; // ms one log burns

export class Furnace extends Phaser.GameObjects.Image {
  constructor(scene, x, y) {
    super(scene, x, y, SHEET_KEY, FRAME_FURNACE);
    scene.add.existing(this);
    this.setDepth(1).setScale(SCALE);

    this.col = Math.round((x - TILE_SIZE / 2) / TILE_SIZE);
    this.row = Math.round((y - TILE_SIZE / 2) / TILE_SIZE);

    // Slots
    this._copper   = 0;  // raw_copper input
    this._tin      = 0;  // raw_tin input
    this._fuel     = 0;  // planks fuel
    this._bars     = 0;  // bronze_bar output
    this._smelting = false;
    this._burning  = false;
    this._burnStart = 0;

    this.noConveyorPull = true; // conveyors only pull output via tick()

    this.setInteractive({ useHandCursor: true });
    this.on('pointerdown', (ptr) => {
      if (ptr.rightButtonDown()) {
        scene.events.emit('object-right-clicked', { type: 'furnace', obj: this, ptr });
      }
    });

    this._label = scene.add.text(x, y - TILE_SIZE / 2 - 4, 'FURNACE', {
      fontSize: '10px', color: '#ff9944', align: 'center',
      backgroundColor: '#00000088', padding: { x: 3, y: 2 },
    }).setOrigin(0.5, 1).setDepth(3).setVisible(false);

    this._prompt = scene.add.text(x, y - TILE_SIZE / 2 - 18, '[E] Open', {
      fontSize: '10px', color: '#ffffff', align: 'center',
      backgroundColor: '#00000088', padding: { x: 3, y: 2 },
    }).setOrigin(0.5, 1).setDepth(3).setVisible(false);

    this._statusLabel = scene.add.text(x, y + TILE_SIZE / 2 + 2, '', {
      fontSize: '9px', color: '#ffdd88', align: 'center',
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

  // ── Storage API (conveyors push into these) ────────────────────────────────

  addToStorage(resource, amount) {
    if (resource === 'raw_copper') {
      if (this._copper >= MAX_INPUT) return false;
      this._copper = Math.min(MAX_INPUT, this._copper + amount);
      this._updateLabel();
      this._tryStartSmelt();
      return true;
    }
    if (resource === 'raw_tin') {
      if (this._tin >= MAX_INPUT) return false;
      this._tin = Math.min(MAX_INPUT, this._tin + amount);
      this._updateLabel();
      this._tryStartSmelt();
      return true;
    }
    if (resource === 'planks') {
      if (this._fuel >= MAX_FUEL) return false;
      this._fuel = Math.min(MAX_FUEL, this._fuel + amount);
      this._updateLabel();
      this._tryBurn();
      this._tryStartSmelt();
      return true;
    }
    return false;
  }

  removeFromStorage(resource, amount) {
    if (resource === 'raw_copper') {
      this._copper = Math.max(0, this._copper - amount);
    } else if (resource === 'raw_tin') {
      this._tin = Math.max(0, this._tin - amount);
    } else if (resource === 'planks') {
      this._fuel = Math.max(0, this._fuel - amount);
    } else if (resource === 'bronze_bar') {
      this._bars = Math.max(0, this._bars - amount);
    }
    this._updateLabel();
  }

  getStored() {
    return {
      raw_copper: this._copper,
      raw_tin: this._tin,
      planks: this._fuel,
      bronze_bar: this._bars,
    };
  }

  _applyServerStored(stored) {
    const prevCopper = this._copper;
    const prevTin = this._tin;
    const prevFuel = this._fuel;
    this._copper = stored.raw_copper ?? 0;
    this._tin    = stored.raw_tin ?? 0;
    this._fuel   = stored.planks ?? 0;
    this._bars   = stored.bronze_bar ?? 0;
    this._updateLabel();
    // If new resources arrived, try to start smelting/burning
    if (this._copper > prevCopper || this._tin > prevTin || this._fuel > prevFuel) {
      if (!this._burning && this._fuel > 0) this._tryBurn();
      if (!this._smelting) this._tryStartSmelt();
    }
  }

  // ── Tick — push finished bars onto adjacent conveyors ─────────────────────

  tick() {
    if (this._bars <= 0 || !this._grid) return;
    const dirs = ['right', 'left', 'up', 'down'];
    for (const dir of dirs) {
      const { dc, dr } = DIR_DELTA[dir];
      const neighbour = this._grid.get(this.col + dc, this.row + dr);
      if (!(neighbour instanceof Conveyor)) continue;
      if (neighbour.direction !== dir) continue;
      if (neighbour._held) continue;

      const frame = RESOURCE_FRAME['bronze_bar'] ?? 795;
      neighbour._held = { resource: 'bronze_bar', amount: 1 };
      neighbour._showItemAt(frame, dir);
      this._bars--;
      this._updateLabel();
      return;
    }
  }

  setGrid(grid) { this._grid = grid; }

  // ── Fuel burn ──────────────────────────────────────────────────────────────

  _tryBurn() {
    if (this._burning) return;
    if (this._fuel <= 0) return;
    if (!this.scene) return;
    this._burning   = true;
    this._burnStart = this.scene.time.now;
    this._fuel--;
    this._updateLabel();
    this._burnTimer = this.scene.time.delayedCall(WOOD_BURN_MS, () => {
      if (!this.scene) return;
      this._burning = false;
      this._updateLabel();
      if (this._fuel > 0 && (this._smelting || this._canSmelt())) {
        this._tryBurn();
        if (!this._smelting) this._tryStartSmelt();
      }
    });
  }

  _canSmelt() {
    return this._copper >= 1 && this._tin >= 1 && this._bars < MAX_BARS;
  }

  _tryStartSmelt() {
    if (this._smelting) return;
    if (!this._canSmelt()) return;
    if (!this._burning && this._fuel <= 0) return;
    if (!this.scene) return;
    if (!this._burning) this._tryBurn();

    this._smelting = true;
    this._updateLabel();

    this._smeltTimer = this.scene.time.delayedCall(SMELT_MS, () => {
      if (!this.scene) return;
      this._copper = Math.max(0, this._copper - 1);
      this._tin    = Math.max(0, this._tin - 1);
      this._bars   = Math.min(MAX_BARS, this._bars + 1);
      this._smelting = false;
      this._updateLabel();
      this._tryStartSmelt();
    });
  }

  _updateLabel() {
    if (!this._statusLabel?.scene) return;
    const parts = [];
    if (this._smelting) parts.push('Smelting…');
    if (this._burning) parts.push('\uD83D\uDD25');
    if (this._copper > 0) parts.push(`Cu:${this._copper}`);
    if (this._tin > 0) parts.push(`Sn:${this._tin}`);
    if (this._fuel > 0 || this._burning) parts.push(`fuel:${this._fuel}`);
    if (this._bars > 0) parts.push(`bars:${this._bars}`);
    if (parts.length === 0 && !this._burning) parts.push('empty');
    this._statusLabel.setText(parts.join(' '));
  }

  destroy(fromScene) {
    if (this._burnTimer) { this._burnTimer.remove(false); this._burnTimer = null; }
    if (this._smeltTimer) { this._smeltTimer.remove(false); this._smeltTimer = null; }
    this._label?.destroy();
    this._prompt?.destroy();
    this._statusLabel?.destroy();
    super.destroy(fromScene);
  }
}
