// ArrowProjectile — a fired arrow that travels in a straight line.
// Rotates to match its travel direction.
// On hitting a chicken, kills it and destroys itself.
// Self-destructs after MAX_DIST pixels or leaving world bounds.

import Phaser from 'phaser';
import { TILE_SIZE } from '../constants.js';

export const ARROW_PROJ_KEY  = 'arrow_proj';
export const ARROW_PROJ_PATH = 'assets/arrow.png';

const SPEED    = 600;          // px/s
const MAX_DIST = TILE_SIZE * 18; // auto-destroy after this distance
const HIT_R    = TILE_SIZE * 0.6; // collision radius

export class ArrowProjectile {
  /**
   * @param {Phaser.Scene} scene
   * @param {number} x  spawn x (world space)
   * @param {number} y  spawn y (world space)
   * @param {number} angle  radians, 0 = right
   * @param {Array}  chickens  live array reference (checked each update)
   */
  constructor(scene, x, y, angle, chickens, skillSystem) {
    this._scene       = scene;
    this._chickens    = chickens;
    this._skillSystem = skillSystem ?? null;
    this._angle    = angle;
    this._vx       = Math.cos(angle) * SPEED;
    this._vy       = Math.sin(angle) * SPEED;
    this._distTravelled = 0;
    this.active    = true;

    this._sprite = scene.add.image(x, y, ARROW_PROJ_KEY)
      .setDepth(3)
      .setOrigin(0.5, 0.5);

    // Scale arrow — target ~0.6 tiles tall
    const targetH = TILE_SIZE * 0.9;
    const scale   = targetH / this._sprite.height;
    this._sprite.setScale(scale);

    // Arrow sprite is painted pointing UP — rotate -90° to align with travel dir
    this._sprite.setRotation(angle - Math.PI / 2);
  }

  get active() { return this._active; }
  set active(v) { this._active = v; }

  /** Call every frame from Bow.update() */
  update() {
    if (!this._active) return;

    const dt = this._scene.game.loop.delta / 1000; // seconds since last frame
    const dx = this._vx * dt;
    const dy = this._vy * dt;

    this._sprite.x += dx;
    this._sprite.y += dy;
    this._distTravelled += Math.hypot(dx, dy);

    // Self-destruct if travelled too far
    if (this._distTravelled >= MAX_DIST) {
      this.destroy();
      return;
    }

    // Collision with chickens
    for (const chicken of this._chickens) {
      if (chicken.isDead()) continue;
      const dist = Phaser.Math.Distance.Between(
        this._sprite.x, this._sprite.y, chicken.x, chicken.y
      );
      if (dist <= HIT_R) {
        chicken.hit(this._scene, null, this._skillSystem);
        this._skillSystem?.awardXP('archery', 15, this._scene);
        this.destroy();
        return;
      }
    }

    // Collision with enemies
    const enemies = this._scene.enemies;
    if (enemies) {
      for (const enemy of enemies) {
        if (enemy.isDead()) continue;
        const dist = Phaser.Math.Distance.Between(
          this._sprite.x, this._sprite.y, enemy.x, enemy.y
        );
        if (dist <= HIT_R) {
          // Archery damage: level-scaled, same formula as melee but using archery level
          const archLvl = this._skillSystem ? this._scene.skillSystem?.getLevel('archery') ?? 1 : 1;
          const damage  = Math.floor(archLvl * 1.2) + Phaser.Math.Between(1, 3);
          enemy.takeDamage(damage);
          this._skillSystem?.awardXP('archery', 20, this._scene);
          this.destroy();
          return;
        }
      }
    }

    // Collision with rival NPCs
    const rivals = this._scene.npNPCs;
    if (rivals) {
      for (const rival of rivals) {
        if (rival.isDead()) continue;
        const dist = Phaser.Math.Distance.Between(
          this._sprite.x, this._sprite.y, rival.x, rival.y
        );
        if (dist <= HIT_R) {
          const archLvl = this._skillSystem ? this._scene.skillSystem?.getLevel('archery') ?? 1 : 1;
          const damage  = Math.floor(archLvl * 1.2) + Phaser.Math.Between(1, 3);
          rival.takeDamage(damage);
          // Hitting a rival tanks faction trust
          rival.adjustFactionTrust?.(-0.15);
          this._skillSystem?.awardXP('archery', 20, this._scene);
          this.destroy();
          return;
        }
      }
    }
  }

  destroy() {
    if (!this._active) return;
    this._active = false;
    // Small fade-out
    this._scene.tweens.add({
      targets: this._sprite,
      alpha: 0,
      duration: 120,
      onComplete: () => this._sprite.destroy(),
    });
  }
}
