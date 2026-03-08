import Phaser from 'phaser';
import {
  SHEET_KEY, SHEET_TILE, TILE_SIZE, INTERACT_DIST,
  FRAME_CRUSHER, DIR_DELTA,
} from '../constants.js';
import { Conveyor } from './Conveyor.js';

const SCALE        = TILE_SIZE / SHEET_TILE;
const MAX_ORE      = 20;   // max ore input storage
const CRUSH_BATCH  = 5;    // ore consumed per crush
const MAX_IRON     = 50;   // max iron output storage
const CRUSH_MS     = 4000; // crush duration

export class OreCrusher extends Phaser.GameObjects.Image {
  constructor(scene, col, row) {
    const x = col * TILE_SIZE + TILE_SIZE / 2;
    const y = row * TILE_SIZE + TILE_SIZE / 2;
    super(scene, x, y, SHEET_KEY, FRAME_CRUSHER);
    scene.add.existing(this);
    this.setDepth(1).setScale(SCALE);

    this.col = col;
    this.row = row;
    this.noConveyorPull = true; // iron output is push-only via tick()

    this._ore      = 0;     // 0–20 raw ore input
    this._iron     = 0;     // 0–50 iron output
    this._crushing = false;
    this._powered  = false; // true when an adjacent Flywheel has momentum
    this._grid     = null;
    this._panel    = null;

    // Ctrl+click to assign to selected NPC; right-click for context menu
    this.setInteractive();
    this.on('pointerdown', (ptr) => {
      if (ptr.event.ctrlKey) scene.events.emit('object-ctrl-clicked', { type: 'crusher', obj: this });
      else if (ptr.rightButtonDown()) scene.events.emit('object-right-clicked', { type: 'crusher', obj: this, ptr });
    });

    this._label = scene.add.text(x, y - TILE_SIZE / 2 - 4, 'CRUSHER', {
      fontSize: '10px', color: '#ffdd88', align: 'center',
      backgroundColor: '#00000088', padding: { x: 3, y: 2 },
    }).setOrigin(0.5, 1).setDepth(3).setVisible(false);

    this._statusLabel = scene.add.text(x, y + TILE_SIZE / 2 + 2, '', {
      fontSize: '9px', color: '#ffeeaa', align: 'center',
      backgroundColor: '#00000099', padding: { x: 3, y: 1 },
    }).setOrigin(0.5, 0).setDepth(3).setVisible(false);

    this._prompt = scene.add.text(x, y - TILE_SIZE / 2 - 18, '[E] Open', {
      fontSize: '10px', color: '#ffffff', align: 'center',
      backgroundColor: '#00000088', padding: { x: 3, y: 2 },
    }).setOrigin(0.5, 1).setDepth(3).setVisible(false);

    this._updateLabel();
  }

  setGrid(grid)   { this._grid  = grid;  }
  setPanel(panel) { this._panel = panel; }

  openPanel() {
    if (this._panel) this._panel.open(this);
  }

  // ── Storage API (input side — conveyors push ore IN) ────────────────────────

  // Returns true if ore was accepted; false backs up the conveyor.
  addToStorage(resource, amount) {
    if (resource !== 'Ore')          return false;
    if (this._ore >= MAX_ORE)        return false; // input full
    if (this._crushing)              return false; // busy
    const space  = MAX_ORE - this._ore;
    const added  = Math.min(amount, space);
    this._ore   += added;
    this._updateLabel();
    this._tryStartCrush();
    return added > 0;
  }

  removeFromStorage(resource, amount) {
    if (resource === 'Ore')  this._ore  = Math.max(0, this._ore  - amount);
    if (resource === 'Iron') this._iron = Math.max(0, this._iron - amount);
    this._updateLabel();
  }

  getStored() {
    return { Ore: this._ore, Iron: this._iron };
  }

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

  // ── Tick — push iron onto adjacent outgoing conveyors ───────────────────────

  tick() {
    if (this._iron <= 0 || !this._grid) return;

    const dirs = ['right', 'left', 'up', 'down'];
    for (const dir of dirs) {
      const { dc, dr } = DIR_DELTA[dir];
      const neighbour = this._grid.get(this.col + dc, this.row + dr);
      if (!(neighbour instanceof Conveyor)) continue;
      if (neighbour.direction !== dir) continue; // must flow away
      if (neighbour._held) continue;             // occupied

      neighbour._held = { resource: 'Iron', amount: 1 };
      const frame = 1594; // RESOURCE_FRAME.Iron
      neighbour._showItemAt(frame, dir);
      this._iron--;
      this._updateLabel();
      return;
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  _tryStartCrush() {
    if (!this._crushing && this._ore >= CRUSH_BATCH && this._powered) this._startCrush();
  }

  _startCrush() {
    this._crushing = true;
    this._updateLabel();
    this.scene.time.delayedCall(CRUSH_MS, () => {
      this._ore -= CRUSH_BATCH;

      // 100% chance 1 iron, 75% for 2nd, 50% for 3rd
      let iron = 1;
      if (Math.random() < 0.75) iron++;
      if (Math.random() < 0.50) iron++;
      this._iron = Math.min(MAX_IRON, this._iron + iron);

      this._crushing = false;
      this._updateLabel();

      // Emit mining XP for each iron produced
      this.scene.events.emit('ore-mined', { source: this, xp: 15 * iron });

      // Chain: if enough ore queued, start another batch immediately
      this._tryStartCrush();
    });
  }

  _updateLabel() {
    const powerStr = this._powered ? '' : ' [no power]';
    if (this._crushing) {
      this._statusLabel.setText(`Crushing… iron:${this._iron}`);
    } else if (this._iron >= MAX_IRON) {
      this._statusLabel.setText(`Iron FULL (${MAX_IRON})`);
    } else if (this._ore >= MAX_ORE) {
      this._statusLabel.setText(`Ore FULL — iron:${this._iron}${powerStr}`);
    } else {
      this._statusLabel.setText(`Ore:${this._ore}/${MAX_ORE} Iron:${this._iron}${powerStr}`);
    }
  }

  destroy(fromScene) {
    this._label?.destroy();
    this._statusLabel?.destroy();
    this._prompt?.destroy();
    super.destroy(fromScene);
  }
}
