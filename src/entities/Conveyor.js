import Phaser from 'phaser';
import {
  SHEET_KEY, SHEET_TILE, TILE_SIZE,
  DIR_DELTA, CONV_FRAME_LOOKUP, FRAME_CONV_H,
  CONVEYOR_TICK_MS, WOOD_PULP_CONVEYOR_TICK_MS, RESOURCE_FRAME,
  tilePos,
} from '../constants.js';
import { GroundItem } from './GroundItem.js';

const SCALE      = TILE_SIZE / SHEET_TILE;
const ITEM_SCALE = 1.4;

function beltFrame(inDir, outDir) {
  return CONV_FRAME_LOOKUP[`${inDir},${outDir}`] ?? FRAME_CONV_H;
}

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
    this.direction    = direction;
    this._outDir      = direction;
    this._serverOutDir = null;   // set by WorldSyncController from server out_direction
    this._grid        = grid;
    this._held        = null;
    this.conveyorType = conveyorType;
    this._tickMs = conveyorType === 'wood_pulp' ? WOOD_PULP_CONVEYOR_TICK_MS : CONVEYOR_TICK_MS;

    this._belt = scene.add.image(0, 0, SHEET_KEY, FRAME_CONV_H).setScale(SCALE);
    if (this.conveyorType === 'wood_pulp') this._belt.setTint(0xc79b66);
    this.add(this._belt);

    this._itemSprite = scene.add.image(0, 0, SHEET_KEY, 0)
      .setScale(ITEM_SCALE)
      .setVisible(false);
    this.add(this._itemSprite);

    // Server handles conveyor logic; client renders via applyServerHeld()

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

  hasHeldItem() { return !!this._held; }

  getHeldItem() { return this._held ? { ...this._held } : null; }

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

  setStraight() {
    this._outDir = this.direction;
    this._belt.setFrame(beltFrame(this.direction, this.direction));
  }

  refreshSprite() {
    this._refreshOwnSprite();
    const { dc, dr } = DIR_DELTA[this.direction];
    const inN  = this._grid.get(this.col - dc, this.row - dr);
    const outN = this._grid.get(this.col + dc, this.row + dr);
    if (inN  instanceof Conveyor) inN._refreshOwnSprite();
    if (outN instanceof Conveyor) outN._refreshOwnSprite();
  }

  _refreshOwnSprite(forceOutDir = null) {
    if (forceOutDir && forceOutDir !== this.direction) {
      this._outDir = forceOutDir;
      this._serverOutDir = forceOutDir;
      this._belt.setFrame(beltFrame(this.direction, this._outDir));
    } else if (this._serverOutDir && this._serverOutDir !== this.direction) {
      // Preserve server-set turn direction even when called without argument
      this._outDir = this._serverOutDir;
      this._belt.setFrame(beltFrame(this.direction, this._serverOutDir));
    } else {
      this._outDir = this.direction;
      this._belt.setFrame(beltFrame(this.direction, this.direction));
    }
  }

  /** Apply server-authoritative held item state */
  applyServerHeld(held) {
    if (held) {
      const hadItem = !!this._held;
      this._held = { resource: held.resource, amount: held.amount };
      const frame = RESOURCE_FRAME[held.resource] ?? 0;
      if (!hadItem) {
        // Item just arrived — slide from input edge to center
        if (this.scene) this.scene.tweens.killTweensOf(this._itemSprite);
        const { dc, dr } = DIR_DELTA[this.direction];
        const half = TILE_SIZE / 2;
        this._itemSprite.setFrame(frame).setPosition(-dc * half, -dr * half).setVisible(true);
        if (this.scene) {
          this.scene.tweens.add({
            targets: this._itemSprite,
            x: 0, y: 0,
            duration: this._tickMs * 0.45,
            ease: 'Linear',
          });
        }
      }
    } else if (this._held) {
      // Item removed — instantly hide (the next conveyor's slide-in handles the visual)
      this._held = null;
      if (this.scene) this.scene.tweens.killTweensOf(this._itemSprite);
      if (this._itemSprite?.scene) {
        this._itemSprite.setVisible(false);
        this._itemSprite.setPosition(0, 0);
      }
    }
  }

  _ejectItem() {
    const resource = this._held.resource;
    const amount   = this._held.amount;
    const out      = DIR_DELTA[this._outDir];
    const isHoriz  = out.dc !== 0;
    this._held = null;

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
    const out       = DIR_DELTA[this._outDir];
    const outEntity = this._grid.get(this.col + out.dc, this.row + out.dr);

    if (this._held) {
      if (outEntity instanceof Conveyor && !outEntity._held) {
        const next       = outEntity;
        const payload    = this._held;
        const sendingDir = this._outDir;
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
          // Notify server of the updated stored contents
          if (outEntity._serverId && this.scene?._conn) {
            this.scene._conn.send({ type: 'update_building_stored', building_id: outEntity._serverId, stored: outEntity.getStored() });
          }
        }
      } else if (!outEntity) {
        this._ejectItem();
      }
      return;
    }

    // Pull from input side
    const inn      = DIR_DELTA[this.direction];
    const inEntity = this._grid.get(this.col - inn.dc, this.row - inn.dr);

    if (inEntity && typeof inEntity.getStored === 'function'
        && !(inEntity instanceof Conveyor) && !inEntity.noConveyorPull) {
      const stored = inEntity.getStored();
      for (const [resource, amount] of Object.entries(stored)) {
        if (amount > 0) {
          inEntity.removeFromStorage(resource, 1);
          this._held = { resource, amount: 1 };
          this._showItemAt(RESOURCE_FRAME[resource] ?? 0);
          // Notify server of the reduced stored contents
          if (inEntity._serverId && this.scene?._conn) {
            this.scene._conn.send({ type: 'update_building_stored', building_id: inEntity._serverId, stored: inEntity.getStored() });
          }
          break;
        }
      }
    }
  }

  destroy(fromScene) {
    this._grid?.remove(this.col, this.row);
    super.destroy(fromScene);
  }
}
