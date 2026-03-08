import Phaser from 'phaser';
import {
  SHEET_KEY, SHEET_TILE, TILE_SIZE,
  DIR_DELTA, CONV_FRAME_LOOKUP, FRAME_CONV_H,
  CONVEYOR_TICK_MS, WOOD_PULP_CONVEYOR_TICK_MS, RESOURCE_FRAME,
  tilePos,
} from '../constants.js';
import { GroundItem } from './GroundItem.js';

const SCALE      = TILE_SIZE / SHEET_TILE; // 3
const ITEM_SCALE = 1.4; // item sprite scale (16px × 1.4 ≈ 22px, fits inside tile)

function beltFrame(inDir, outDir) {
  return CONV_FRAME_LOOKUP[`${inDir},${outDir}`] ?? FRAME_CONV_H;
}

// Pixel offset from tile center for the "back" (input) edge in a given direction
function backOffset(dir) {
  const { dc, dr } = DIR_DELTA[dir];
  const half = TILE_SIZE / 2;
  return { ox: -dc * half, oy: -dr * half };
}

export class Conveyor extends Phaser.GameObjects.Container {
  constructor(scene, col, row, direction, grid, conveyorType = 'regular') {
    const { x, y } = tilePos(col, row);
    super(scene, x, y);
    scene.add.existing(this);
    this.setDepth(1);

    this.col          = col;
    this.row          = row;
    this.direction    = direction;  // input direction (how items arrive)
    this._outDir      = direction;  // output direction (may differ for curves)
    this._grid        = grid;
    this._held        = null;
    this.conveyorType = conveyorType;
    this._tickMs = conveyorType === 'wood_pulp' ? WOOD_PULP_CONVEYOR_TICK_MS : CONVEYOR_TICK_MS;

    this._belt = scene.add.image(0, 0, SHEET_KEY, FRAME_CONV_H).setScale(SCALE);
    if (this.conveyorType === 'wood_pulp') this._belt.setTint(0xc79b66);
    this.add(this._belt);

    // Item sprite — hidden when no item is held
    this._itemSprite = scene.add.image(0, 0, SHEET_KEY, 0)
      .setScale(ITEM_SCALE)
      .setVisible(false);
    this.add(this._itemSprite);

    this._timer = scene.time.addEvent({
      delay: this._tickMs,
      loop: true,
      callback: this._tick,
      callbackScope: this,
    });

    // Right-click/menu hit target: use the visible belt sprite as the click target.
    // Container-level hit areas can be unreliable unless explicit bounds are set.
    this._belt.setInteractive({ useHandCursor: true });
    this._belt.on('pointerdown', (ptr) => {
      if (ptr.rightButtonDown()) {
        scene.events.emit('object-right-clicked', { type: 'conveyor', obj: this, ptr });
        return;
      }
      if (ptr.leftButtonDown() && ptr.event.shiftKey && this._held) {
        this.removeHeldItem(true);
      }
    });
  }

  hasHeldItem() {
    return !!this._held;
  }

  getHeldItem() {
    return this._held ? { ...this._held } : null;
  }

  removeHeldItem(dropToGround = false) {
    if (!this._held) return false;
    const { resource, amount } = this._held;
    this._held = null;
    this.scene.tweens.killTweensOf(this._itemSprite);
    this._itemSprite.setVisible(false);
    if (dropToGround) {
      new GroundItem(this.scene, this.x, this.y, resource, amount);
    }
    return true;
  }

  // Show item sprite arriving from arrivalDir, then tween it to center.
  // arrivalDir is the direction the item is travelling (same as the sending tile's _outDir).
  _showItemAt(frame, arrivalDir) {
    const dir = arrivalDir ?? this.direction;
    const { ox, oy } = backOffset(dir);
    this._itemSprite.setFrame(frame).setPosition(ox, oy).setVisible(true);
    this.scene.tweens.add({
      targets: this._itemSprite,
      x: 0, y: 0,
      duration: this._tickMs * 0.85,
      ease: 'Linear',
    });
  }

  // Tween item from center toward the front edge, then hide
  _animateOut(outDir, onComplete) {
    const { dc, dr } = DIR_DELTA[outDir];
    const half = TILE_SIZE / 2;
    this.scene.tweens.add({
      targets: this._itemSprite,
      x: dc * half, y: dr * half,
      duration: this._tickMs * 0.85,
      ease: 'Linear',
      onComplete,
    });
  }

  // Force straight sprite — used when placing a new run (curves handled separately).
  setStraight() {
    this._outDir = this.direction;
    this._belt.setFrame(beltFrame(this.direction, this.direction));
  }

  // Call after placement so neighbors are in the grid.
  refreshSprite() {
    this._refreshOwnSprite();
    // Notify immediate in/out neighbors — they may also need to update
    const { dc, dr } = DIR_DELTA[this.direction];
    const inN  = this._grid.get(this.col - dc, this.row - dr);
    const outN = this._grid.get(this.col + dc, this.row + dr);
    if (inN  instanceof Conveyor) inN._refreshOwnSprite();
    if (outN instanceof Conveyor) outN._refreshOwnSprite();
  }

  // forceOutDir: optionally override the output direction (used when a perpendicular run is appended)
  _refreshOwnSprite(forceOutDir = null) {
    const { dc, dr } = DIR_DELTA[this.direction];
    const inNeighbor  = this._grid.get(this.col - dc, this.row - dr);

    if (forceOutDir && forceOutDir !== this.direction) {
      // Caller knows the new output direction (e.g. a perpendicular run was just placed)
      this._outDir = forceOutDir;
      this._belt.setFrame(beltFrame(this.direction, this._outDir));
    } else {
      // No explicit output override — keep straight
      this._outDir = this.direction;
      this._belt.setFrame(beltFrame(this.direction, this.direction));
    }
  }

  _ejectItem() {
    const resource = this._held.resource;
    const amount   = this._held.amount;
    const out      = DIR_DELTA[this._outDir];
    const isHoriz  = out.dc !== 0;

    this._held = null;

    // Animate sprite out, then spawn GroundItem and hide sprite
    this._animateOut(this._outDir, () => {
      this._itemSprite.setVisible(false);
      const fwd = (1 + Math.random()) * TILE_SIZE;
      const lat = (Math.random() - 0.5) * TILE_SIZE;
      const ex  = this.x + out.dc * fwd + (isHoriz ? 0 : lat);
      const ey  = this.y + out.dr * fwd + (isHoriz ? lat : 0);
      if (this.scene) new GroundItem(this.scene, ex, ey, resource, amount);
    });
  }

  _tick() {
    // Use _outDir for pushing (may differ from direction on a corner tile)
    const out       = DIR_DELTA[this._outDir];
    const outEntity = this._grid.get(this.col + out.dc, this.row + out.dr);

    if (this._held) {
      const frame = RESOURCE_FRAME[this._held.resource];

      if (outEntity instanceof Conveyor && !outEntity._held) {
        // Hand off — animate out of this tile, then trigger receive on next tile
        const next       = outEntity;
        const payload    = this._held;
        const sendingDir = this._outDir; // direction item is travelling into the next tile
        this._held = null;
        this._animateOut(this._outDir, () => {
          this._itemSprite.setVisible(false);
          if (next.active) {
            next._held = payload;
            next._showItemAt(RESOURCE_FRAME[payload.resource] ?? 0, sendingDir);
          }
        });
      } else if (outEntity && typeof outEntity.addToStorage === 'function') {
        const accepted = outEntity.addToStorage(this._held.resource, this._held.amount);
        if (accepted) {
          this._held = null;
          this._animateOut(this._outDir, () => this._itemSprite.setVisible(false));
        }
        // If not accepted, item stays on this tile — backpressure propagates upstream
      } else if (!outEntity) {
        this._ejectItem();
      }
      // If outEntity exists but is blocked (full conveyor), item waits — no animation
      return;
    }

    // Pull from input side (always the back of this.direction)
    const inn      = DIR_DELTA[this.direction];
    const inEntity = this._grid.get(this.col - inn.dc, this.row - inn.dr);

    // Don't pull from a conveyor (they push) or from an active machine (furnace pushes via tick)
    if (inEntity && typeof inEntity.getStored === 'function'
        && !(inEntity instanceof Conveyor) && !inEntity.noConveyorPull) {
      const stored = inEntity.getStored();
      for (const [resource, amount] of Object.entries(stored)) {
        if (amount > 0) {
          inEntity.removeFromStorage(resource, 1);
          this._held = { resource, amount: 1 };
          this._showItemAt(RESOURCE_FRAME[resource] ?? 0);
          break;
        }
      }
    }
  }

  destroy(fromScene) {
    this._timer?.remove();
    this._grid.remove(this.col, this.row);
    super.destroy(fromScene);
  }
}
