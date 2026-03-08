import Phaser from 'phaser';
import {
  SHEET_KEY, SHEET_TILE, TILE_SIZE, INTERACT_DIST,
  FRAME_FURNACE, DIR_DELTA,
} from '../constants.js';
import { Conveyor } from './Conveyor.js';

const SCALE          = TILE_SIZE / SHEET_TILE;
const MAX_INPUT      = 5;    // slots for each ore/metal input
const MAX_BARS       = 20;   // finished bar slots
const MAX_WOOD       = 10;   // logs in firebox (iron/bronze)
const MAX_COAL       = 10;   // coal in firebox (steel)
const SMELT_MS       = 5000; // smelt cycle duration
const WOOD_BURN_MS   = 8000; // ms one log burns

// Per-type config
const FURNACE_CFG = {
  plain: {
    label:       'FURNACE',
    tint:        null,
    input1Key:   'Iron',
    input1Label: 'Iron (raw)',
    input1Max:   MAX_INPUT,
    input2Key:   null,
    input2Label: null,
    input2Max:   0,
    fuelKey:     'Wood',            // wood-fired only
    fuelMax:     MAX_WOOD,
    outputKey:   'IronBar',
    outputLabel: 'Iron Bar',
    // recipe: 5 iron → 1 IronBar (same as iron furnace, no coal needed)
    input1Req:   5,
    input2Req:   0,
    labelColor:  '#ddbb88',
    spriteTint:  0xddbb88,
  },
  iron: {
    label:       'IRON FURNACE',
    tint:        null,              // default orange label
    input1Key:   'Iron',
    input1Label: 'Iron (raw)',
    input1Max:   MAX_INPUT,
    input2Key:   null,
    input2Label: null,
    input2Max:   0,
    fuelKey:     'Wood',            // wood-fired
    fuelMax:     MAX_WOOD,
    outputKey:   'IronBar',
    outputLabel: 'Iron Bar',
    // recipe: 5 iron → 1 IronBar
    input1Req:   5,
    input2Req:   0,
    labelColor:  '#ff9944',
    spriteTint:  null,
  },
  steel: {
    label:       'STEEL FURNACE',
    tint:        0xaabbcc,
    input1Key:   'IronBar',
    input1Label: 'Iron Bar',
    input1Max:   MAX_INPUT,
    input2Key:   'Coal',
    input2Label: 'Coal',
    input2Max:   MAX_COAL,
    fuelKey:     null,              // coal is both fuel AND reagent (coal slot IS the fuel)
    fuelMax:     0,
    outputKey:   'SteelBar',
    outputLabel: 'Steel Bar',
    // recipe: 1 IronBar + 2 Coal → 1 SteelBar
    input1Req:   1,
    input2Req:   2,
    labelColor:  '#aabbdd',
    spriteTint:  0xaabbcc,
  },
  bronze: {
    label:       'BRONZE FURNACE',
    tint:        0xddaa55,
    input1Key:   'CopperOre',
    input1Label: 'Copper Ore',
    input1Max:   MAX_INPUT,
    input2Key:   'TinOre',
    input2Label: 'Tin Ore',
    input2Max:   MAX_INPUT,
    fuelKey:     'Wood',            // wood-fired like iron
    fuelMax:     MAX_WOOD,
    outputKey:   'BronzeBar',
    outputLabel: 'Bronze Bar',
    // recipe: 1 CopperOre + 1 TinOre → 1 BronzeBar
    input1Req:   1,
    input2Req:   1,
    labelColor:  '#ddaa55',
    spriteTint:  0xddaa66,
  },
};

export class Furnace extends Phaser.GameObjects.Image {
  /**
   * @param {Phaser.Scene} scene
   * @param {number} col
   * @param {number} row
   * @param {string} [furnaceType='iron']  'iron' | 'steel' | 'bronze'
   */
  constructor(scene, col, row, furnaceType = 'iron') {
    const x = col * TILE_SIZE + TILE_SIZE / 2;
    const y = row * TILE_SIZE + TILE_SIZE / 2;
    super(scene, x, y, SHEET_KEY, FRAME_FURNACE);
    scene.add.existing(this);
    this.setDepth(1).setScale(SCALE);

    this.col = col;
    this.row = row;
    this.furnaceType = furnaceType;
    this._cfg = FURNACE_CFG[furnaceType] ?? FURNACE_CFG.iron;

    // Apply tint to distinguish furnace types
    if (this._cfg.spriteTint) this.setTint(this._cfg.spriteTint);

    // ── Input/output slots ────────────────────────────────────────────────────
    this._input1    = 0;   // primary input (iron / ironbar / copper)
    this._input2    = 0;   // secondary input (coal for steel / tin for bronze)
    this._bars      = 0;   // output bars
    this._wood      = 0;   // wood fuel (iron/bronze only)
    this._smelting  = false;
    this._burning   = false;  // active wood burn (iron/bronze) or coal-consuming (steel)
    this._burnStart = 0;

    this._panel = null;
    this._grid  = null;
    this.noConveyorPull = true;

    // Ctrl+click / right-click
    this.setInteractive();
    this.on('pointerdown', (ptr) => {
      if (ptr.event.ctrlKey) scene.events.emit('object-ctrl-clicked', { type: 'furnace', obj: this });
      else if (ptr.rightButtonDown()) scene.events.emit('object-right-clicked', { type: 'furnace', obj: this, ptr });
    });

    const cfg = this._cfg;
    this._label = scene.add.text(x, y - TILE_SIZE / 2 - 4, cfg.label, {
      fontSize: '10px', color: cfg.labelColor, align: 'center',
      backgroundColor: '#00000088', padding: { x: 3, y: 2 },
    }).setOrigin(0.5, 1).setDepth(3).setVisible(false);

    this._statusLabel = scene.add.text(x, y + TILE_SIZE / 2 + 2, '', {
      fontSize: '9px', color: '#ffdd88', align: 'center',
      backgroundColor: '#00000099', padding: { x: 3, y: 1 },
    }).setOrigin(0.5, 0).setDepth(3).setVisible(false);

    this._prompt = scene.add.text(x, y - TILE_SIZE / 2 - 18, '[E] Open', {
      fontSize: '10px', color: '#ffffff', align: 'center',
      backgroundColor: '#00000088', padding: { x: 3, y: 2 },
    }).setOrigin(0.5, 1).setDepth(3).setVisible(false);

    this._updateLabel();
  }

  setPanel(panel) { this._panel = panel; }
  setGrid(grid)   { this._grid  = grid;  }

  // ── Storage API ────────────────────────────────────────────────────────────

  addToStorage(resource, amount) {
    const cfg = this._cfg;

    if (resource === cfg.input1Key) {
      if (this._bars >= MAX_BARS) return false;
      if (this._smelting)         return false;
      if (this._input1 >= cfg.input1Max) return false;
      const added = Math.min(amount, cfg.input1Max - this._input1);
      this._input1 += added;
      this._updateLabel();
      this._tryStartSmelt();
      return added > 0;
    }

    if (cfg.input2Key && resource === cfg.input2Key) {
      if (this._input2 >= cfg.input2Max) return false;
      const added = Math.min(amount, cfg.input2Max - this._input2);
      this._input2 += added;
      this._updateLabel();
      // For steel, coal is the fuel — try to start burn and smelt
      if (this.furnaceType === 'steel') {
        this._tryBurn();
        this._tryStartSmelt();
      } else {
        this._tryStartSmelt();
      }
      return added > 0;
    }

    if (cfg.fuelKey && resource === cfg.fuelKey) {
      if (this._wood >= cfg.fuelMax) return false;
      const added = Math.min(amount, cfg.fuelMax - this._wood);
      this._wood += added;
      this._updateLabel();
      this._tryBurn();
      this._tryStartSmelt();
      return added > 0;
    }

    return false;
  }

  removeFromStorage(resource, amount) {
    const cfg = this._cfg;
    if (resource === cfg.input1Key) {
      this._input1 = Math.max(0, this._input1 - amount);
    } else if (cfg.input2Key && resource === cfg.input2Key) {
      this._input2 = Math.max(0, this._input2 - amount);
    } else if (cfg.fuelKey && resource === cfg.fuelKey) {
      this._wood = Math.max(0, this._wood - amount);
    } else if (resource === cfg.outputKey) {
      this._bars = Math.max(0, this._bars - amount);
    }
    this._updateLabel();
  }

  getStored() {
    const cfg = this._cfg;
    const result = {
      [cfg.input1Key]: this._input1,
      [cfg.outputKey]: this._bars,
    };
    if (cfg.input2Key) result[cfg.input2Key] = this._input2;
    if (cfg.fuelKey)   result[cfg.fuelKey]   = this._wood;
    return result;
  }

  // ── Proximity / interaction ────────────────────────────────────────────────

  updateProximity(playerX, playerY) {
    const dist    = Phaser.Math.Distance.Between(playerX, playerY, this.x, this.y);
    const inRange  = dist <= INTERACT_DIST;
    const adjacent = dist <= TILE_SIZE * 1.5;
    const show     = this.scene?.labelsVisible ?? true;
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

  openPanel() {
    if (this._panel) this._panel.open(this);
  }

  // ── Tick — push finished bars onto outgoing conveyors ─────────────────────

  tick() {
    if (this._bars <= 0 || !this._grid) return;

    const cfg  = this._cfg;
    const dirs = ['right', 'left', 'up', 'down'];
    for (const dir of dirs) {
      const { dc, dr } = DIR_DELTA[dir];
      const neighbour = this._grid.get(this.col + dc, this.row + dr);
      if (!(neighbour instanceof Conveyor)) continue;
      if (neighbour.direction !== dir) continue;
      if (neighbour._held) continue;

      const frame = _barFrame(cfg.outputKey);
      neighbour._held = { resource: cfg.outputKey, amount: 1 };
      neighbour._showItemAt(frame, dir);
      this._bars--;
      this._updateLabel();
      return;
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /** Light the fire — consumes one log (wood-fired) or one coal (steel). */
  _tryBurn() {
    if (this._burning) return;
    const cfg = this._cfg;

    if (this.furnaceType === 'steel') {
      // Coal is fuel; consume 1 coal per burn cycle
      if (this._input2 <= 0) return;
      this._burning   = true;
      this._burnStart = this.scene.time.now;
      // Don't consume coal here — it's consumed as a reagent during smelt
      this._updateLabel();
      this.scene.time.delayedCall(WOOD_BURN_MS, () => {
        this._burning = false;
        this._updateLabel();
        if (this._smelting && this._input2 > 0) this._tryBurn();
        else if (!this._smelting && this._input2 >= cfg.input2Req && this._input1 >= cfg.input1Req) {
          this._tryBurn();
          this._tryStartSmelt();
        }
      });
    } else {
      // Wood-fired (iron/bronze)
      if (this._wood <= 0) return;
      this._burning   = true;
      this._burnStart = this.scene.time.now;
      this._wood--;
      this._updateLabel();
      this.scene.time.delayedCall(WOOD_BURN_MS, () => {
        this._burning = false;
        this._updateLabel();
        if (this._smelting && this._wood > 0) this._tryBurn();
        else if (!this._smelting && this._wood > 0 &&
                 this._input1 >= cfg.input1Req &&
                 (!cfg.input2Key || this._input2 >= cfg.input2Req)) {
          this._tryBurn();
          this._tryStartSmelt();
        }
      });
    }
  }

  /** Start a smelt cycle — requires all inputs and fuel to be ready. */
  _tryStartSmelt() {
    if (this._smelting) return;
    const cfg = this._cfg;
    if (this._bars >= MAX_BARS) return;
    if (this._input1 < cfg.input1Req) return;
    if (cfg.input2Key && this._input2 < cfg.input2Req) return;

    // Check fuel
    const hasFuel = this.furnaceType === 'steel'
      ? (this._burning || this._input2 >= cfg.input2Req)  // coal doubles as fuel
      : (this._burning || this._wood > 0);

    if (!hasFuel) return;

    if (!this._burning) this._tryBurn();

    this._smelting = true;
    this._updateLabel();

    this.scene.time.delayedCall(SMELT_MS, () => {
      // Consume inputs
      this._input1 = Math.max(0, this._input1 - cfg.input1Req);
      if (cfg.input2Key) this._input2 = Math.max(0, this._input2 - cfg.input2Req);
      this._bars   = Math.min(MAX_BARS, this._bars + 1);
      this._smelting = false;
      this._updateLabel();
      this._tryStartSmelt();
    });
  }

  _updateLabel() {
    const cfg = this._cfg;
    let fuelStr;
    if (this.furnaceType === 'steel') {
      fuelStr = this._burning ? `🔥coal:${this._input2}` : `coal:${this._input2}`;
    } else {
      fuelStr = this._burning
        ? `🔥${this._wood}`
        : (this._wood > 0 ? `wood:${this._wood}` : 'no fuel');
    }

    const in1 = `${cfg.input1Key.replace('Ore','').replace('Bar','')}:${this._input1}`;
    const in2 = cfg.input2Key ? ` ${cfg.input2Key.replace('Ore','').replace('Bar','')}:${this._input2}` : '';

    if (this._smelting) {
      this._statusLabel.setText(`Smelting… ${fuelStr} bars:${this._bars}`);
    } else if (this._bars >= MAX_BARS) {
      this._statusLabel.setText(`FULL (${MAX_BARS} bars)`);
    } else if (this._bars > 0) {
      this._statusLabel.setText(`Bars:${this._bars} ${in1}${in2} ${fuelStr}`);
    } else if (this._input1 > 0 || this._input2 > 0) {
      this._statusLabel.setText(`${in1}${in2} ${fuelStr}`);
    } else {
      this._statusLabel.setText(fuelStr.includes('no fuel') ? '' : fuelStr);
    }
  }

  destroy(fromScene) {
    this._label?.destroy();
    this._statusLabel?.destroy();
    this._prompt?.destroy();
    super.destroy(fromScene);
  }
}

// Returns conveyor-display frame for output resource
function _barFrame(outputKey) {
  const frames = { IronBar: 795, SteelBar: 795, BronzeBar: 795 };
  return frames[outputKey] ?? 795;
}
