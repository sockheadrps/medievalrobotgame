// Enemy — hostile creature that chases the player (or nearby NPCs) and attacks in melee.
//
// Uses the chicken spritesheet (row 1) tinted red so no new asset is required.
// Multi-HP unlike chickens. Attacks every ATTACK_MS ms when adjacent.
// On death: drops random loot (Ore / Iron) as GroundItems.
//
// Lifecycle:
//   new Enemy(scene, x, y, { hp, damage, speed })
//   scene updates call enemy.update(delta)
//   Death emits 'enemy-died' — GameScene removes from array

import Phaser from 'phaser';
import { TILE_SIZE, CHICKEN_KEY, CHICKEN_WALK_ROW, worldToTile } from '../constants.js';
import { GroundItem } from './GroundItem.js';

const SCALE         = (TILE_SIZE * 0.85) / 32;  // slightly larger than a chicken
const ANIM_KEY      = 'enemy-walk';
const ARRIVE_D      = 6;    // px — close enough to waypoint
const AGGRO_RANGE   = TILE_SIZE * 8;   // px — enemy starts chasing within this range
const ATTACK_RANGE  = TILE_SIZE * 0.9; // px — melee contact distance
const ATTACK_MS     = 1800; // ms between attacks
const HP_BAR_W      = 28;
const HP_BAR_H      = 3;

export class Enemy extends Phaser.GameObjects.Container {
  /**
   * @param {Phaser.Scene} scene
   * @param {number} x  world px
   * @param {number} y  world px
   * @param {object} [opts]
   * @param {number} [opts.hp=10]     max HP
   * @param {number} [opts.damage=2]  damage per hit
   * @param {number} [opts.speed=70]  movement px/s
   */
  constructor(scene, x, y, opts = {}) {
    super(scene, x, y);
    scene.add.existing(this);
    this.setDepth(2);

    this.maxHp  = opts.hp     ?? 10;
    this.hp     = this.maxHp;
    this.damage = opts.damage ?? 2;
    this._speed = opts.speed  ?? 70;

    this._dead          = false;
    this._attackCooldown = 0;  // ms remaining until next attack
    this._target        = null; // current chase target (player or NPC ref)

    // Sprite — use chicken sheet row 1, tinted red
    this._sprite = scene.add.sprite(0, 0, CHICKEN_KEY, 1 * 4);
    this._sprite.setScale(SCALE);
    this._sprite.setOrigin(0.5, 1);
    this._sprite.setTint(0xff3333);
    this.add(this._sprite);

    // HP bar
    this._hpBg   = scene.add.rectangle(0, -TILE_SIZE - 10, HP_BAR_W, HP_BAR_H, 0x330000)
      .setDepth(3).setOrigin(0.5, 0.5);
    this._hpFill = scene.add.rectangle(-HP_BAR_W / 2, -TILE_SIZE - 10, HP_BAR_W, HP_BAR_H, 0xff2222)
      .setDepth(4).setOrigin(0, 0.5);
    this.add(this._hpBg);
    this.add(this._hpFill);

    this._ensureAnim(scene);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  isDead() { return this._dead; }

  /**
   * Deal damage to this enemy. Returns true if it died.
   * @param {number} amount
   */
  takeDamage(amount) {
    if (this._dead) return false;
    this.hp = Math.max(0, this.hp - amount);
    this._updateHPBar();
    if (this.hp <= 0) {
      this._die();
      return true;
    }
    // Brief white flash on hit
    this._sprite.setTint(0xffffff);
    this.scene.time.delayedCall(80, () => {
      if (!this._dead) this._sprite.setTint(0xff3333);
    });
    return false;
  }

  // ── Update — called every frame by GameScene ──────────────────────────────

  update(delta) {
    if (this._dead) return;

    // Tick attack cooldown
    if (this._attackCooldown > 0) this._attackCooldown -= delta;

    // Pick nearest valid target
    this._pickTarget();

    if (!this._target) {
      this._sprite.stop();
      return;
    }

    const tx   = this._target.x;
    const ty   = this._target.y;
    const dx   = tx - this.x;
    const dy   = ty - this.y;
    const dist = Math.hypot(dx, dy);

    // Attack if in range
    if (dist <= ATTACK_RANGE) {
      this._sprite.stop();
      this._tryAttack();
      return;
    }

    // Chase — check if next step is blocked by a closed door or wall
    const step   = (this._speed * delta) / 1000;
    const nextX  = this.x + (dx / dist) * step;
    const nextY  = this.y + (dy / dist) * step;
    const nTile  = worldToTile(nextX, nextY);
    const atTile = this.scene.grid?.get(nTile.col, nTile.row);

    if (atTile && atTile !== this._target) {
      // Door: attack it instead of walking through
      if (typeof atTile.isOpen === 'function' && !atTile.isOpen() && !atTile.isDead()) {
        if (this._attackCooldown <= 0) {
          atTile.takeDamage(this.damage);
          this._attackCooldown = ATTACK_MS;
        }
        return;
      }
      // PlacedStructure wall (has .type + .takeDamage + not broken)
      if (atTile.type && typeof atTile.takeDamage === 'function' && !atTile.isDead()) {
        if (this._attackCooldown <= 0) {
          atTile.takeDamage(this.damage);
          this._attackCooldown = ATTACK_MS;
        }
        return;
      }
    }

    this.x = nextX;
    this.y = nextY;

    // Flip sprite to face direction
    this._sprite.setFlipX(dx > 0);

    // Play walk anim
    if (!this._sprite.anims.isPlaying) this._sprite.play(ANIM_KEY);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _pickTarget() {
    const scene = this.scene;
    let closest = null;
    let minDist = AGGRO_RANGE;

    // Consider player
    if (scene.player) {
      const d = Phaser.Math.Distance.Between(this.x, this.y, scene.player.x, scene.player.y);
      if (d < minDist) { minDist = d; closest = scene.player; }
    }

    // Consider friendly NPCs
    if (scene.npcs) {
      for (const npc of scene.npcs) {
        if (npc.isDead?.()) continue;
        const d = Phaser.Math.Distance.Between(this.x, this.y, npc.x, npc.y);
        if (d < minDist) { minDist = d; closest = npc; }
      }
    }

    this._target = closest;
  }

  _tryAttack() {
    if (this._attackCooldown > 0) return;
    this._attackCooldown = ATTACK_MS;

    const target = this._target;
    if (!target) return;

    // Player
    if (target === this.scene.player) {
      const died = target.takeDamage(this.damage);
      if (died) {
        this.scene.combatSystem?.handlePlayerDeath();
      }
      return;
    }

    // NPC
    target.takeDamage?.(this.damage);
  }

  _die() {
    this._dead = true;

    // Loot drop
    const scene = this.scene;
    const lootTable = [
      { item: 'Ore',    min: 1, max: 3, chance: 0.7 },
      { item: 'Iron',   min: 1, max: 2, chance: 0.4 },
      { item: 'Feather',min: 1, max: 2, chance: 0.2 },
    ];
    for (const entry of lootTable) {
      if (Math.random() < entry.chance) {
        const qty = Phaser.Math.Between(entry.min, entry.max);
        new GroundItem(scene, this.x, this.y, entry.item, qty);
      }
    }

    // Death animation — red flash then fade
    this._sprite.setTint(0xff0000);
    scene.tweens.add({
      targets: this,
      alpha: 0,
      duration: 350,
      onComplete: () => {
        scene.events.emit('enemy-died', this);
        this.destroy();
      },
    });
  }

  _updateHPBar() {
    const frac  = this.maxHp > 0 ? Math.max(0, this.hp / this.maxHp) : 0;
    const fillW = Math.round(HP_BAR_W * frac);
    this._hpFill.setDisplaySize(Math.max(0, fillW), HP_BAR_H);
    const col = frac > 0.5 ? 0xff4444 : frac > 0.25 ? 0xff8800 : 0xff0000;
    this._hpFill.setFillStyle(col);
  }

  _ensureAnim(scene) {
    if (scene.anims.exists(ANIM_KEY)) return;
    // Row 1 of the chicken sheet (frames 4-7)
    scene.anims.create({
      key: ANIM_KEY,
      frames: scene.anims.generateFrameNumbers(CHICKEN_KEY, { start: 4, end: 7 }),
      frameRate: 10,
      repeat: -1,
    });
  }

  destroy(fromScene) {
    super.destroy(fromScene);
  }
}
