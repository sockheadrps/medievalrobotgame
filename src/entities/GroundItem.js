import Phaser from 'phaser';
import {
  TILE_SIZE, SHEET_KEY, RESOURCE_FRAME, LOG1_KEY, LOG2_KEY, LOG3_KEY,
  FIRE_KEY, FIRE_TOTAL_FRAMES, ARMOR_ELITE_KEY,
} from '../constants.js';

const LOG_KEYS = [null, LOG1_KEY, LOG2_KEY, LOG3_KEY]; // index by amount (1-3)
const FIRE_ANIM_KEY = 'campfire-burn';

// A resource item sitting on the ground.
// If placed=true (intentionally dropped for fence building), sits flat on the ground.
// If placed=false (loot drop), bobs to indicate pickup.
export class GroundItem extends Phaser.GameObjects.Container {
  constructor(scene, x, y, resource, amount = 1, placed = false) {
    super(scene, x, y);
    scene.add.existing(this);
    this.setDepth(placed ? 1 : 2); // placed items below player, loot above

    this.resource = resource;
    this.amount   = amount;
    this._placed  = placed;
    this._lit = false;
    this._burnUntil = 0;

    // Register with scene so update() can check for pickup
    if (scene.groundItems) scene.groundItems.push(this);

    // Use custom log sprites for Wood/log, fallback to spritesheet
    const isLog = resource === 'Wood' || resource === 'log';
    const logKey = isLog ? (LOG_KEYS[Math.min(amount, 3)] || LOG1_KEY) : null;

    let sprite;
    if (resource === 'ArmorElite' && scene.textures.exists(ARMOR_ELITE_KEY)) {
      sprite = scene.add.image(0, 0, ARMOR_ELITE_KEY, 0).setScale(TILE_SIZE / 32);
    } else if (logKey && scene.textures.exists(logKey)) {
      sprite = scene.add.image(0, 0, logKey).setScale(TILE_SIZE / 16);
    } else {
      const frame = RESOURCE_FRAME[resource] ?? 0;
      sprite = scene.add.image(0, 0, SHEET_KEY, frame).setScale(1.2);
    }
    this._sprite = sprite;
    this.add(sprite);

    this._glow = scene.add.circle(0, 0, TILE_SIZE * 0.28, 0xff8833, 0.28).setVisible(false);
    this._glow.setDepth(-1);
    this.addAt(this._glow, 0);

    this._ensureFireAnim(scene);
    this._fireSprite = scene.add.sprite(0, -TILE_SIZE * 0.12, FIRE_KEY, 0)
      .setScale((TILE_SIZE / 32) * 1.05)
      .setVisible(false);
    this.add(this._fireSprite);

    this._fireLabel = scene.add.text(0, -TILE_SIZE * 0.42, '', {
      fontSize: '9px', color: '#ffcc66', backgroundColor: '#00000088',
      padding: { x: 3, y: 1 },
    }).setOrigin(0.5, 1).setDepth(3).setVisible(false);
    this.add(this._fireLabel);

    // Only bob for loot drops, not placed logs
    if (!placed) {
      scene.tweens.add({
        targets: sprite,
        y: -3,
        duration: 600,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    }

    // Placed logs can be left-clicked to pick up 1 at a time
    if (placed) {
      this.setSize(TILE_SIZE, TILE_SIZE);
      this.setInteractive({ useHandCursor: true });
      this.on('pointerdown', (ptr) => this._onPickupClick(ptr));
      this.on('pointerover', () => sprite.setTint(this._lit ? 0xffdd88 : 0xffee88));
      this.on('pointerout', () => {
        if (this._lit) sprite.setTint(0xffbb66);
        else sprite.clearTint();
      });
    }
  }

  _ensureFireAnim(scene) {
    if (!scene?.anims || scene.anims.exists(FIRE_ANIM_KEY) || !scene.textures.exists(FIRE_KEY)) return;
    scene.anims.create({
      key: FIRE_ANIM_KEY,
      frames: scene.anims.generateFrameNumbers(FIRE_KEY, {
        start: 0,
        end: FIRE_TOTAL_FRAMES - 1,
      }),
      frameRate: 12,
      repeat: -1,
    });
  }

  _onPickupClick(ptr = null) {
    const scene = this.scene;
    if (!scene) return;
    const player = scene.player;
    if (!player || scene._playerDead) return;

    const d = Phaser.Math.Distance.Between(player.x, player.y, this.x, this.y);
    if (d > TILE_SIZE * 1.5) {
      const text = scene.add.text(this.x, this.y - TILE_SIZE / 2, 'Too far!', {
        fontSize: '10px', color: '#ff4444', backgroundColor: '#00000088',
        padding: { x: 3, y: 2 },
      }).setOrigin(0.5, 1).setDepth(20);
      scene.time.delayedCall(1000, () => text.destroy());
      return;
    }

    if (this._lit) return;

    if (this.resource === 'KiShrine') {
      if (ptr?.rightButtonDown()) return;
      scene._tryUseKiShrine?.(this);
      return;
    }

    if (scene._canLightCampfire?.(this)) {
      scene._tryLightCampfire?.(this);
      return;
    }

    const conn = scene._conn;
    if (conn?.connected && this._serverId) {
      conn.send({ type: 'pickup_placed', item_id: this._serverId });
    }
  }

  /** Update the visual when the amount changes (log stacking). */
  updateAmount(newAmount) {
    if (newAmount === this.amount) return;
    this.amount = newAmount;

    const isLog = this.resource === 'Wood' || this.resource === 'log';
    const logKey = isLog ? (LOG_KEYS[Math.min(newAmount, 3)] || LOG1_KEY) : null;

    if (logKey && this.scene?.textures.exists(logKey)) {
      this._sprite?.setTexture(logKey);
    }
  }

  applyState(state = {}) {
    if (typeof state.amount === 'number') this.updateAmount(state.amount);
    this._lit = !!state.lit;
    this._burnUntil = Number(state.burn_until || 0);

    if (this._lit) {
      this._glow?.setVisible(true);
      this._sprite?.setTint(0xffbb66);
      this._fireSprite?.setVisible(true);
      if (this._fireSprite?.anims?.currentAnim?.key !== FIRE_ANIM_KEY) {
        this._fireSprite?.play(FIRE_ANIM_KEY);
      }
      const secs = Math.max(0, Math.ceil(this._burnUntil - Date.now() / 1000));
      this._fireLabel?.setText(`FIRE ${secs}s`).setVisible(true);
      const pulse = 1 + Math.sin((this.scene?.time.now || 0) / 120) * 0.12;
      this._glow?.setScale(pulse);
    } else {
      this._glow?.setVisible(false);
      this._fireSprite?.setVisible(false);
      this._fireSprite?.stop();
      this._fireLabel?.setVisible(false);
      this._sprite?.clearTint();
      this._glow?.setScale(1);
    }
  }

  // Returns { resource, amount } if player is close enough, and destroys self. Otherwise null.
  tryPickup(playerX, playerY, pickupRadius = TILE_SIZE * 0.6) {
    if (Phaser.Math.Distance.Between(playerX, playerY, this.x, this.y) <= pickupRadius) {
      const r = this.resource;
      const a = this.amount;
      this.destroy();
      return { resource: r, amount: a };
    }
    return null;
  }

  destroy(fromScene) {
    this._glow?.destroy();
    this._fireSprite?.destroy();
    this._fireLabel?.destroy();
    super.destroy(fromScene);
  }
}
