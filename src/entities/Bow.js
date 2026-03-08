// Bow — held by the player when equipped (X to toggle).
// Renders as a sprite that pivots around the player's centre,
// always pointing toward the mouse cursor.
// Call fire() to shoot an ArrowProjectile in that direction.

import Phaser from 'phaser';
import { ArrowProjectile } from './ArrowProjectile.js';
import { TILE_SIZE } from '../constants.js';

export const BOW_KEY   = 'bow';
export const BOW_PATH  = 'assets/bow.png';

// Distance (px) from player centre to bow pivot point
const HOLD_DIST  = 14;
// Cooldown between shots (ms)
const FIRE_CD_MS = 500;

export class Bow {
  /**
   * @param {Phaser.Scene} scene
   * @param {Phaser.GameObjects.Sprite} player  the player sprite
   * @param {Phaser.Cameras.Scene2D.Camera} camera  for world-space cursor conversion
   */
  constructor(scene, player, camera) {
    this._scene    = scene;
    this._player   = player;
    this._camera   = camera;
    this._equipped = false;
    this._lastFire = 0;

    // The bow image — originates from its left edge (tip of grip)
    // so rotation around player is natural
    this._sprite = scene.add.image(0, 0, BOW_KEY)
      .setDepth(3)
      .setOrigin(0.5, 0.5)
      .setVisible(false);

    // Scale bow to ~1.5 tiles tall
    const targetH = TILE_SIZE * 1.5;
    const scale   = targetH / this._sprite.height;
    this._sprite.setScale(scale);

    this._projectiles = []; // live ArrowProjectile instances
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  isEquipped() { return this._equipped; }

  equip() {
    this._equipped = true;
    this._sprite.setVisible(true);
  }

  unequip() {
    this._equipped = false;
    this._sprite.setVisible(false);
  }

  toggle() {
    this._equipped ? this.unequip() : this.equip();
  }

  /** Call every frame to track the cursor. */
  update() {
    if (!this._equipped) return;

    const px = this._player.x;
    const py = this._player.y - this._player.height * this._player.scaleY * 0.5; // mid-body

    // World-space cursor position
    const ptr    = this._scene.input.activePointer;
    const worldX = ptr.worldX;
    const worldY = ptr.worldY;

    const angle  = Phaser.Math.Angle.Between(px, py, worldX, worldY);

    // Position bow HOLD_DIST from player centre in the cursor direction
    this._sprite.setPosition(
      px + Math.cos(angle) * HOLD_DIST,
      py + Math.sin(angle) * HOLD_DIST,
    );

    // Bow sprite naturally points left — add PI to flip toward cursor
    this._sprite.setRotation(angle + Math.PI);

    // Update live projectiles
    for (let i = this._projectiles.length - 1; i >= 0; i--) {
      const proj = this._projectiles[i];
      if (!proj.active) {
        this._projectiles.splice(i, 1);
      } else {
        proj.update();
      }
    }
  }

  /**
   * Fire an arrow toward the cursor.
   * @param {Phaser.Inventory|object} inventory  player inventory (needs Arrow)
   * @param {ArrowProjectile[]} chickens  current live chickens to check collision
   * @param {SkillSystem} [skillSystem]  who gets combat XP on kill
   * @returns {boolean} true if fired
   */
  fire(inventory, chickens, skillSystem) {
    if (!this._equipped) return false;

    const now = this._scene.time.now;
    if (now - this._lastFire < FIRE_CD_MS) return false;

    // Consume 1 arrow from inventory
    const have = typeof inventory.get === 'function'
      ? inventory.get('Arrow')
      : (inventory['Arrow'] ?? 0);
    if (have <= 0) {
      // Flash sprite red briefly to signal no ammo
      this._sprite.setTint(0xff4444);
      this._scene.time.delayedCall(200, () => this._sprite.clearTint());
      return false;
    }
    if (typeof inventory.set === 'function') {
      inventory.set('Arrow', have - 1);
    } else {
      inventory['Arrow'] = have - 1;
    }

    const px = this._player.x;
    const py = this._player.y - this._player.height * this._player.scaleY * 0.5;

    const ptr    = this._scene.input.activePointer;
    const angle  = Phaser.Math.Angle.Between(px, py, ptr.worldX, ptr.worldY);

    const proj = new ArrowProjectile(this._scene, px, py, angle, chickens, skillSystem);
    this._projectiles.push(proj);
    this._lastFire = now;
    return true;
  }

  destroy() {
    this._sprite.destroy();
    for (const p of this._projectiles) p.destroy();
    this._projectiles = [];
  }
}
