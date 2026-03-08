// Chicken — passive NPC that wanders near its spawn point.
//
// - 1 HP: one hit kills it
// - On death: drops 1–3 Feathers as a GroundItem
// - Wanders within WANDER_RADIUS tiles of spawn; pauses occasionally
// - Clickable: clicking selects it so player/NPCs can attack
// - Does not attack back

import Phaser from 'phaser';
import {
  CHICKEN_KEY, CHICKEN_FRAME_W, CHICKEN_FRAME_H, CHICKEN_WALK_ROW,
  TILE_SIZE,
} from '../constants.js';
import { GroundItem } from './GroundItem.js';

const SCALE         = (TILE_SIZE * 0.75) / CHICKEN_FRAME_H; // slightly smaller than a tile
const SPEED         = 55;           // px/s wander speed
const ARRIVE_D      = 6;            // px — close enough to next waypoint
const WANDER_RADIUS = TILE_SIZE * 4; // wander within 4 tiles of spawn
const PAUSE_MIN_MS  = 1500;
const PAUSE_MAX_MS  = 4000;
const WALK_MIN_MS   = 1500;
const WALK_MAX_MS   = 3500;
const ANIM_KEY      = 'chicken-walk';

export class Chicken extends Phaser.GameObjects.Container {
  /**
   * @param {Phaser.Scene} scene
   * @param {number} x  world px
   * @param {number} y  world px
   */
  constructor(scene, x, y) {
    super(scene, x, y);
    scene.add.existing(this);
    this.setDepth(2);

    this._spawnX = x;
    this._spawnY = y;
    this._dead   = false;
    this._selected = false;

    // Sprite — bottom row (row 3) of the chicken sheet
    this._sprite = scene.add.sprite(0, 0, CHICKEN_KEY, CHICKEN_WALK_ROW * 4);
    this._sprite.setScale(SCALE);
    this._sprite.setOrigin(0.5, 1);
    this.add(this._sprite);

    // Selection ring
    this._ring = scene.add.graphics();
    this._ring.lineStyle(2, 0xffff44, 1);
    this._ring.strokeCircle(0, -CHICKEN_FRAME_H * SCALE / 2, 14);
    this._ring.setVisible(false);
    this.add(this._ring);

    // Make clickable
    this._sprite.setInteractive({ useHandCursor: true });
    this._sprite.on('pointerdown', (ptr) => {
      if (!ptr.rightButtonDown()) {
        scene.events.emit('chicken-clicked', this);
      }
    });

    this._ensureAnim(scene);
    this._startWander();
  }

  // ── Selection ──────────────────────────────────────────────────────────────

  setSelected(selected) {
    this._selected = selected;
    this._ring.setVisible(selected && !this._dead);
  }

  isSelected() { return this._selected; }

  // ── Combat ─────────────────────────────────────────────────────────────────

  /**
   * Attack this chicken. Returns true if it dies.
   * @param {Phaser.Scene} scene
   * @param {(item:string, qty:number)=>void} [collector]  if provided, feathers go here instead of ground
   * @param {SkillSystem} [skillSystem]  who gets the combat XP (player or NPC)
   */
  hit(scene, collector, skillSystem) {
    if (this._dead) return false;
    this._dead = true;
    this._ring.setVisible(false);

    // Drop 1–3 Feathers — directly to collector (NPC) or as a ground item (player)
    const count = Phaser.Math.Between(1, 3);
    if (collector) {
      collector('Feather', count);
    } else {
      new GroundItem(scene, this.x, this.y, 'Feather', count);
    }

    // Award combat XP
    skillSystem?.awardXP('combat', 20, scene);

    // Death flash then destroy
    scene.tweens.add({
      targets: this,
      alpha: 0,
      duration: 300,
      onComplete: () => this.destroy(),
    });

    scene.events.emit('chicken-died', { chicken: this, spawnX: this._spawnX, spawnY: this._spawnY });
    return true;
  }

  isDead() { return this._dead; }

  // ── Wander AI ──────────────────────────────────────────────────────────────

  _startWander() {
    if (this._dead) return;
    // Randomly pause or pick a new walk target
    const doPause = Phaser.Math.Between(0, 2) === 0; // ~33% chance to pause
    if (doPause) {
      this._pauseMs(Phaser.Math.Between(PAUSE_MIN_MS, PAUSE_MAX_MS));
    } else {
      this._pickWaypoint();
    }
  }

  _pauseMs(ms) {
    if (this._dead) return;
    this._sprite.stop();
    this._sprite.setFrame(CHICKEN_WALK_ROW * 4 + 1); // idle frame (middle of walk)
    this.scene.time.delayedCall(ms, () => this._startWander());
  }

  _pickWaypoint() {
    if (this._dead) return;
    // Random point within WANDER_RADIUS of spawn
    const angle = Math.random() * Math.PI * 2;
    const dist  = Math.random() * WANDER_RADIUS;
    const tx    = this._spawnX + Math.cos(angle) * dist;
    const ty    = this._spawnY + Math.sin(angle) * dist;

    this._walkTo(tx, ty);
  }

  _walkTo(tx, ty) {
    if (this._dead) return;
    this._target = { x: tx, y: ty };

    // Face direction
    const dx = tx - this.x;
    this._sprite.setFlipX(dx > 0); // flip right; left is natural sprite direction

    // Play walk anim
    if (this._sprite.anims.currentAnim?.key !== ANIM_KEY) {
      this._sprite.play(ANIM_KEY);
    }

    // Schedule walk-step timer (re-evaluate each frame via update())
    // We'll handle movement in update(), set a max walk duration
    const walkMs = Phaser.Math.Between(WALK_MIN_MS, WALK_MAX_MS);
    if (this._walkTimer) this._walkTimer.remove();
    this._walkTimer = this.scene.time.delayedCall(walkMs, () => {
      this._target = null;
      this._startWander();
    });
  }

  // ── Update — called every frame by GameScene ──────────────────────────────

  update(delta) {
    if (this._dead || !this._target) return;

    const dx   = this._target.x - this.x;
    const dy   = this._target.y - this.y;
    const dist = Math.hypot(dx, dy);

    if (dist <= ARRIVE_D) {
      this.x = this._target.x;
      this.y = this._target.y;
      this._target = null;
      if (this._walkTimer) { this._walkTimer.remove(); this._walkTimer = null; }
      this._startWander();
      return;
    }

    const step = (SPEED * delta) / 1000;
    this.x += (dx / dist) * step;
    this.y += (dy / dist) * step;

    // Face direction
    this._sprite.setFlipX(dx > 0);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _ensureAnim(scene) {
    if (scene.anims.exists(ANIM_KEY)) return;
    scene.anims.create({
      key: ANIM_KEY,
      frames: scene.anims.generateFrameNumbers(CHICKEN_KEY, {
        start: CHICKEN_WALK_ROW * 4,
        end:   CHICKEN_WALK_ROW * 4 + 3,
      }),
      frameRate: 8,
      repeat: -1,
    });
  }

  destroy(fromScene) {
    if (this._walkTimer) this._walkTimer.remove();
    this._target = null;
    super.destroy(fromScene);
  }
}
