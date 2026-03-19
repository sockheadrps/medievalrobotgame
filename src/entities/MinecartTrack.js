import Phaser from 'phaser';
import {
  SHEET_KEY, SHEET_TILE, TILE_SIZE,
  DIR_DELTA, TRACK_FRAME_LOOKUP, FRAME_TRACK_H,
  FRAME_CART_H, FRAME_CART_V, RESOURCE_FRAME,
  TRACK_TICK_MS, tilePos,
} from '../constants.js';

const SCALE      = TILE_SIZE / SHEET_TILE;
const CART_SCALE = 1.6;

function trackFrame(inDir, outDir) {
  return TRACK_FRAME_LOOKUP[`${inDir},${outDir}`] ?? FRAME_TRACK_H;
}

function backOffset(dir) {
  const { dc, dr } = DIR_DELTA[dir];
  const half = TILE_SIZE / 2;
  return { ox: -dc * half, oy: -dr * half };
}

export class MinecartTrack extends Phaser.GameObjects.Container {
  constructor(scene, col, row, direction, grid) {
    const { x, y } = tilePos(col, row);
    super(scene, x, y);
    scene.add.existing(this);
    this.setDepth(1);

    this.col       = col;
    this.row       = row;
    this.direction = direction;
    this._outDir   = direction;
    this._grid     = grid;
    this._cart     = null; // { resource, amount } or null

    this._track = scene.add.image(0, 0, SHEET_KEY, FRAME_TRACK_H).setScale(SCALE);
    this.add(this._track);

    this._cartSprite = scene.add.image(0, 0, SHEET_KEY, FRAME_CART_H)
      .setScale(CART_SCALE)
      .setVisible(false);
    this.add(this._cartSprite);

    // Server handles track logic; client only renders cart state via applyServerCart()

    this._track.setInteractive({ useHandCursor: true });
    this._track.on('pointerdown', (ptr) => {
      if (ptr.rightButtonDown()) {
        scene.events.emit('object-right-clicked', { type: 'track', obj: this, ptr });
        return;
      }
    });

    this._refreshOwnSprite();
  }

  hasCart() { return !!this._cart; }

  getCart() { return this._cart ? { ...this._cart } : null; }

  /** Apply server-authoritative cart state */
  applyServerCart(cart) {
    if (cart) {
      const hadCart = !!this._cart;
      this._cart = { resource: cart.resource, amount: cart.amount };
      const isHoriz = this._outDir === 'left' || this._outDir === 'right';
      this._cartSprite.setFrame(isHoriz ? FRAME_CART_H : FRAME_CART_V);
      if (!hadCart) {
        // Cart just arrived — slide from input edge to center
        if (this.scene) this.scene.tweens.killTweensOf(this._cartSprite);
        const { dc, dr } = DIR_DELTA[this.direction];
        const half = TILE_SIZE / 2;
        this._cartSprite.setPosition(-dc * half, -dr * half).setVisible(true);
        if (this.scene) {
          this.scene.tweens.add({
            targets: this._cartSprite,
            x: 0, y: 0,
            duration: TRACK_TICK_MS * 0.45,
            ease: 'Linear',
          });
        }
      }
    } else if (this._cart) {
      // Cart removed — instantly hide (next track's slide-in handles the visual)
      this._cart = null;
      if (this.scene) this.scene.tweens.killTweensOf(this._cartSprite);
      if (this._cartSprite?.scene) {
        this._cartSprite.setVisible(false);
        this._cartSprite.setPosition(0, 0);
      }
    }
  }

  spawnCart(resource, amount) {
    if (this._cart) return false;
    this._cart = { resource, amount };
    const isHoriz = this._outDir === 'left' || this._outDir === 'right';
    const frame = isHoriz ? FRAME_CART_H : FRAME_CART_V;
    this._showCart(frame, this.direction);
    return true;
  }

  _showCart(frame, arrivalDir) {
    if (!this.scene) return;
    const dir = arrivalDir ?? this.direction;
    const { ox, oy } = backOffset(dir);
    this._cartSprite.setFrame(frame).setPosition(ox, oy).setVisible(true);
    this.scene.tweens.add({
      targets: this._cartSprite,
      x: 0, y: 0,
      duration: TRACK_TICK_MS * 0.85,
      ease: 'Linear',
    });
  }

  _animateCartOut(outDir, onComplete) {
    const { dc, dr } = DIR_DELTA[outDir];
    const half = TILE_SIZE / 2;
    if (!this.scene) { onComplete?.(); return; }
    this.scene.tweens.add({
      targets: this._cartSprite,
      x: dc * half, y: dr * half,
      duration: TRACK_TICK_MS * 0.85,
      ease: 'Linear',
      onComplete: () => { if (this.scene) onComplete?.(); },
    });
  }

  setStraight() {
    this._outDir = this.direction;
    this._track.setFrame(trackFrame(this.direction, this.direction));
  }

  refreshSprite() {
    this._refreshOwnSprite();
    const { dc, dr } = DIR_DELTA[this.direction];
    const inN  = this._grid.get(this.col - dc, this.row - dr);
    const outN = this._grid.get(this.col + dc, this.row + dr);
    if (inN  instanceof MinecartTrack) inN._refreshOwnSprite();
    if (outN instanceof MinecartTrack) outN._refreshOwnSprite();
  }

  _refreshOwnSprite(forceOutDir = null) {
    if (forceOutDir && forceOutDir !== this.direction) {
      this._outDir = forceOutDir;
      this._track.setFrame(trackFrame(this.direction, this._outDir));
    } else if (!forceOutDir) {
      this._outDir = this.direction;
      this._track.setFrame(trackFrame(this.direction, this.direction));
    }
  }

  _tick() {
    if (!this._cart || !this.scene) return;

    const out       = DIR_DELTA[this._outDir];
    const outEntity = this._grid.get(this.col + out.dc, this.row + out.dr);

    // Transfer to next track
    if (outEntity instanceof MinecartTrack && !outEntity._cart) {
      const payload    = this._cart;
      const sendingDir = this._outDir;
      this._cart = null;
      this._animateCartOut(this._outDir, () => {
        if (this._cartSprite?.scene) this._cartSprite.setVisible(false);
        if (outEntity.active) {
          outEntity._cart = payload;
          const isHoriz = outEntity._outDir === 'left' || outEntity._outDir === 'right';
          outEntity._showCart(isHoriz ? FRAME_CART_H : FRAME_CART_V, sendingDir);
        }
      });
      return;
    }

    // Deposit into storage (crate, etc.)
    if (outEntity && typeof outEntity.addToStorage === 'function' && !(outEntity instanceof MinecartTrack)) {
      const accepted = outEntity.addToStorage(this._cart.resource, this._cart.amount);
      if (accepted) {
        this._cart = null;
        this._animateCartOut(this._outDir, () => { if (this._cartSprite?.scene) this._cartSprite.setVisible(false); });
      }
      return;
    }

    // Check for minecart exit portal
    const exitCol = this.col + out.dc;
    const exitRow = this.row + out.dr;
    const exitTiles = this.scene?._minecartExitTiles || [];
    const portal = exitTiles.find(p => p.col === exitCol && p.row === exitRow);
    if (portal) {
      const payload = this._cart;
      const conn = this.scene._conn; // capture before tween
      this._cart = null;
      this._animateCartOut(this._outDir, () => {
        if (this._cartSprite?.scene) this._cartSprite.setVisible(false);
        conn?.send({
          type: 'minecart_portal',
          col: exitCol,
          row: exitRow,
          resource: payload.resource,
          amount: payload.amount,
        });
      });
      return;
    }

    // No valid output — cart waits
  }

  destroy(fromScene) {
    if (this._hideTimer) { this._hideTimer.remove(false); this._hideTimer = null; }
    this._grid?.remove(this.col, this.row);
    super.destroy(fromScene);
  }
}
