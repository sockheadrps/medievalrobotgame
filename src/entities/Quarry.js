import Phaser from 'phaser';
import {
  SHEET_KEY, SHEET_TILE, TILE_SIZE, INTERACT_DIST,
  FRAME_QUARRY, DIR_DELTA,
} from '../constants.js';
import { Conveyor } from './Conveyor.js';

const SCALE       = TILE_SIZE / SHEET_TILE;
const MAX_STORED  = 50;
const MINE_MS     = 1000;   // interval
const MINE_CHANCE = 0.60;   // 60% per tick

export class Quarry extends Phaser.GameObjects.Image {
  constructor(scene, col, row) {
    const x = col * TILE_SIZE + TILE_SIZE / 2;
    const y = row * TILE_SIZE + TILE_SIZE / 2;
    super(scene, x, y, SHEET_KEY, FRAME_QUARRY);
    scene.add.existing(this);
    this.setDepth(1).setScale(SCALE);

    this.col = col;
    this.row = row;
    this.noConveyorPull = true; // output is push-only via tick()

    this._ore     = 0;    // 0–50 raw ore in storage
    this._grid    = null;
    this._powered = false; // true when an adjacent Flywheel has momentum

    // Ctrl+click to assign to selected NPC; right-click for context menu
    this.setInteractive();
    this.on('pointerdown', (ptr) => {
      if (ptr.event.ctrlKey) scene.events.emit('object-ctrl-clicked', { type: 'quarry', obj: this });
      else if (ptr.rightButtonDown()) scene.events.emit('object-right-clicked', { type: 'quarry', obj: this, ptr });
    });

    this._label = scene.add.text(x, y - TILE_SIZE / 2 - 4, 'QUARRY', {
      fontSize: '10px', color: '#aaffaa', align: 'center',
      backgroundColor: '#00000088', padding: { x: 3, y: 2 },
    }).setOrigin(0.5, 1).setDepth(3).setVisible(false);

    this._statusLabel = scene.add.text(x, y + TILE_SIZE / 2 + 2, '', {
      fontSize: '9px', color: '#ccffcc', align: 'center',
      backgroundColor: '#00000099', padding: { x: 3, y: 1 },
    }).setOrigin(0.5, 0).setDepth(3).setVisible(false);

    this._prompt = scene.add.text(x, y - TILE_SIZE / 2 - 18, '[E] Open', {
      fontSize: '10px', color: '#ffffff', align: 'center',
      backgroundColor: '#00000088', padding: { x: 3, y: 2 },
    }).setOrigin(0.5, 1).setDepth(3).setVisible(false);

    // Mining timer
    scene.time.addEvent({
      delay: MINE_MS,
      loop: true,
      callback: this._mine,
      callbackScope: this,
    });

    this._updateLabel();
  }

  setGrid(grid) { this._grid = grid; }

  // ── Storage API ─────────────────────────────────────────────────────────────

  // Conveyors must not pull directly — output goes through tick()
  getStored()              { return { Ore: this._ore }; }
  addToStorage()           { return false; }             // quarry doesn't accept input
  removeFromStorage(r, n)  { if (r === 'Ore') this._ore = Math.max(0, this._ore - n); this._updateLabel(); }

  // ── Proximity ───────────────────────────────────────────────────────────────

  updateProximity(playerX, playerY) {
    const dist = Phaser.Math.Distance.Between(playerX, playerY, this.x, this.y);
    const inRange  = dist <= INTERACT_DIST;
    const adjacent = dist <= TILE_SIZE * 1.5;
    const show     = this.scene.labelsVisible ?? true;
    this._prompt.setVisible(inRange && show);
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

  // ── Tick — push ore onto adjacent outgoing conveyors ────────────────────────

  tick() {
    if (this._ore <= 0 || !this._grid || !this._powered) return;

    const dirs = ['right', 'left', 'up', 'down'];
    for (const dir of dirs) {
      const { dc, dr } = DIR_DELTA[dir];
      const neighbour = this._grid.get(this.col + dc, this.row + dr);
      if (!(neighbour instanceof Conveyor)) continue;
      if (neighbour.direction !== dir) continue; // must flow away from quarry
      if (neighbour._held) continue;             // occupied

      neighbour._held = { resource: 'Ore', amount: 1 };
      neighbour._showItemAt(614 /* RESOURCE_FRAME.Ore */, dir);
      this._ore--;
      this._updateLabel();
      return;
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  _mine() {
    if (!this._powered) return;
    if (this._ore >= MAX_STORED) return;
    if (Math.random() < MINE_CHANCE) {
      this._ore++;
      this._updateLabel();
      // Emit mining XP — GameScene credits the assigned NPC or player
      this.scene.events.emit('ore-mined', { source: this, xp: 10 });
    }
  }

  _updateLabel() {
    const powerStr = this._powered ? '' : ' [no power]';
    if (this._ore >= MAX_STORED) {
      this._statusLabel.setText(`FULL (${MAX_STORED})${powerStr}`);
    } else {
      this._statusLabel.setText(`Ore: ${this._ore}/${MAX_STORED}${powerStr}`);
    }
  }

  destroy(fromScene) {
    this._label?.destroy();
    this._statusLabel?.destroy();
    this._prompt?.destroy();
    super.destroy(fromScene);
  }
}
