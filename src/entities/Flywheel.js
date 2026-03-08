// Flywheel — a momentum-driven power source for adjacent Quarry / OreCrusher.
//
// Place adjacent to a quarry or crusher. Player or NPC holds Space while
// standing next to it to crank it up. Momentum drains over time; the linked
// machine is only active while momentum > 0.
//
// Momentum: 0–100
// Charging:   +CHARGE_PER_TICK every CHARGE_TICK_MS while someone is cranking
// Decay:      -DECAY_PER_SEC * dt every frame when momentum > 0
// Full charge needed before machine activates: ACTIVATE_THRESHOLD

import Phaser from 'phaser';
import {
  SHEET_KEY,
  SHEET_TILE,
  TILE_SIZE,
  INTERACT_DIST,
  FRAME_FLYWHEEL,
  FRAME_WOODEN_FLYWHEEL,
  DIR_DELTA,
} from '../constants.js';

const SCALE = TILE_SIZE / SHEET_TILE;
const MAX_MOMENTUM = 100;
const ACTIVATE_THRESHOLD = 20; // must reach this before machine turns on
const DECAY_PER_SEC = 3; // momentum lost per second while idle
const CHARGE_PER_TICK = 6; // momentum gained per crank tick
const CHARGE_TICK_MS = 300; // how often a crank tick fires while held
const BAR_W = 44; // pixel width of full momentum bar
const BAR_H = 5;

const FLYWHEEL_VARIANTS = {
  regular: {
    frame: FRAME_FLYWHEEL,
    label: 'FLYWHEEL',
    labelColor: '#ffcc66',
    chargePerTick: CHARGE_PER_TICK,
    decayPerSec: DECAY_PER_SEC,
  },
  wooden: {
    frame: FRAME_WOODEN_FLYWHEEL,
    label: 'WOOD FLYWHEEL',
    labelColor: '#d8b073',
    chargePerTick: 4,  // slower spin-up than regular
    decayPerSec: 4,    // decays faster than regular
  },
};

export class Flywheel extends Phaser.GameObjects.Image {
  constructor(scene, col, row, variant = 'regular') {
    const cfg = FLYWHEEL_VARIANTS[variant] ?? FLYWHEEL_VARIANTS.regular;
    const x = col * TILE_SIZE + TILE_SIZE / 2;
    const y = row * TILE_SIZE + TILE_SIZE / 2;
    super(scene, x, y, SHEET_KEY, cfg.frame);
    scene.add.existing(this);
    this.setDepth(1).setScale(SCALE);

    this.col = col;
    this.row = row;
    this.flywheelType = variant;
    this._chargePerTick = cfg.chargePerTick;
    this._decayPerSec = cfg.decayPerSec;

    this._momentum = 0; // 0–100
    this._powered = false; // true when momentum > 0
    this._cranking = false; // true while someone is actively cranking
    this._grid = null;
    this._machine = null; // linked Quarry or OreCrusher
    this._crankTimer = null; // repeating timer while held

    // Rotation accumulator (degrees)
    this._angle = 0;

    // Ctrl+click to assign to selected NPC; right-click for context menu
    this.setInteractive();
    this.on('pointerdown', (ptr) => {
      if (ptr.event.ctrlKey)
        scene.events.emit('object-ctrl-clicked', {
          type: 'flywheel',
          obj: this,
        });
      else if (ptr.rightButtonDown())
        scene.events.emit('object-right-clicked', {
          type: 'flywheel',
          obj: this,
          ptr,
        });
    });

    // Labels
    this._label = scene.add
      .text(x, y - TILE_SIZE / 2 - 4, cfg.label, {
        fontSize: '10px',
        color: cfg.labelColor,
        align: 'center',
        backgroundColor: '#00000088',
        padding: { x: 3, y: 2 },
      })
      .setOrigin(0.5, 1)
      .setDepth(3)
      .setVisible(false);

    this._prompt = scene.add
      .text(x, y - TILE_SIZE / 2 - 18, '[SPACE] Crank', {
        fontSize: '10px',
        color: '#ffffff',
        align: 'center',
        backgroundColor: '#00000088',
        padding: { x: 3, y: 2 },
      })
      .setOrigin(0.5, 1)
      .setDepth(3)
      .setVisible(false);

    // Momentum bar background + fill
    const barX = x - BAR_W / 2;
    const barY = y + TILE_SIZE / 2 + 4;
    this._barBg = scene.add
      .rectangle(x, barY + BAR_H / 2, BAR_W, BAR_H, 0x222222)
      .setDepth(3)
      .setOrigin(0.5, 0.5);
    this._barFill = scene.add
      .rectangle(barX, barY + BAR_H / 2, 0, BAR_H, 0xffaa00)
      .setDepth(4)
      .setOrigin(0, 0.5);

    // Cranking indicator text
    this._crankLabel = scene.add
      .text(x, barY + BAR_H + 3, '', {
        fontSize: '9px',
        color: '#ffcc44',
        align: 'center',
        backgroundColor: '#00000099',
        padding: { x: 2, y: 1 },
      })
      .setOrigin(0.5, 0)
      .setDepth(4);

    this._updateBar();
  }

  setGrid(grid) {
    this._grid = grid;
    this._findMachine();
  }

  /** Called every frame by GameScene.update() */
  update(delta) {
    // Decay momentum
    if (this._momentum > 0 && !this._cranking) {
      this._momentum = Math.max(
        0,
        this._momentum - (this._decayPerSec * delta) / 1000
      );
      this._updateBar();
      this._updatePowered();
    }

    // Spin the wheel — speed proportional to momentum
    if (this._momentum > 0) {
      const rpm = (this._momentum / MAX_MOMENTUM) * 360; // degrees/sec
      this._angle = (this._angle + (rpm * delta) / 1000) % 360;
      this.setAngle(this._angle);
    }
  }

  // ── Proximity ───────────────────────────────────────────────────────────────

  updateProximity(px, py) {
    const dist = Phaser.Math.Distance.Between(px, py, this.x, this.y);
    const inRange  = dist <= INTERACT_DIST;
    const adjacent = dist <= TILE_SIZE * 1.5;
    const show     = this.scene.labelsVisible ?? true;
    this._prompt.setVisible(inRange && !this._cranking && show);
    this._label.setVisible(adjacent && show);
    return inRange;
  }

  refreshLabels(visible) {
    if (!visible) {
      this._label.setVisible(false);
      this._prompt.setVisible(false);
    }
  }

  // ── Cranking API (called by GameScene / NPCTaskRunner) ──────────────────────

  /** Start cranking — fires repeated ticks while held. */
  startCrank() {
    if (this._cranking) return;
    this._cranking = true;
    this._prompt.setVisible(false);
    this._crankTick(); // immediate first tick
    this._crankTimer = this.scene.time.addEvent({
      delay: CHARGE_TICK_MS,
      loop: true,
      callback: this._crankTick,
      callbackScope: this,
    });
    this._updateBar();
  }

  /** Stop cranking (key released / NPC stepped away). */
  stopCrank() {
    if (!this._cranking) return;
    this._cranking = false;
    if (this._crankTimer) {
      this._crankTimer.remove();
      this._crankTimer = null;
    }
    this._updateBar();
  }

  isPowered() {
    return this._powered;
  }
  getMomentum() {
    return this._momentum;
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  _crankTick() {
    this._momentum = Math.min(MAX_MOMENTUM, this._momentum + this._chargePerTick);
    this._updateBar();
    this._updatePowered();
  }

  _updatePowered() {
    const wasPowered = this._powered;

    if (!this._powered && this._momentum >= ACTIVATE_THRESHOLD) {
      this._powered = true;
    } else if (this._powered && this._momentum <= 0) {
      this._powered = false;
    }

    if (this._powered !== wasPowered && this._machine) {
      this._machine._powered = this._powered;
      this._machine._updateLabel?.();
      // If we just powered on and the machine has work queued, kick it off
      if (this._powered) this._machine._tryStartCrush?.();
    }
  }

  _findMachine() {
    if (!this._grid) return;
    for (const dir of ['right', 'left', 'up', 'down']) {
      const { dc, dr } = DIR_DELTA[dir];
      const neighbour = this._grid.get(this.col + dc, this.row + dr);
      if (
        neighbour &&
        (neighbour.constructor.name === 'Quarry' ||
          neighbour.constructor.name === 'OreCrusher')
      ) {
        this._machine = neighbour;
        return;
      }
    }
  }

  _updateBar() {
    const frac = this._momentum / MAX_MOMENTUM;
    const fillW = BAR_W * frac;
    this._barFill.setSize(fillW, BAR_H);

    // Colour: green when high, yellow mid, red low
    const color = frac > 0.5 ? 0x44ff88 : frac > 0.25 ? 0xffaa00 : 0xff4444;
    this._barFill.setFillStyle(color);

    if (this._cranking) {
      this._crankLabel.setText('cranking…');
    } else if (this._momentum <= 0) {
      this._crankLabel.setText('no power');
    } else {
      this._crankLabel.setText(`${Math.round(this._momentum)}%`);
    }
  }

  destroy(fromScene) {
    this._crankTimer?.remove();
    this._label?.destroy();
    this._prompt?.destroy();
    this._barBg?.destroy();
    this._barFill?.destroy();
    this._crankLabel?.destroy();
    super.destroy(fromScene);
  }
}
