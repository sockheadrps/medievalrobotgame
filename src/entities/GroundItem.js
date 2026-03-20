import Phaser from 'phaser';
import {
  TILE_SIZE, SHEET_KEY, RESOURCE_FRAME, LOG1_KEY, LOG2_KEY, LOG3_KEY,
} from '../constants.js';

const LOG_KEYS = [null, LOG1_KEY, LOG2_KEY, LOG3_KEY]; // index by amount (1-3)

// A resource item sitting on the ground.
// If placed=true (intentionally dropped), sits flat on the ground.
// If placed=false (loot drop), bobs to indicate pickup.
export class GroundItem extends Phaser.GameObjects.Container {
  constructor(scene, x, y, resource, amount = 1, placed = false, isEquipment = false) {
    super(scene, x, y);
    scene.add.existing(this);
    this.setDepth(placed ? 1 : 2); // placed items below player, loot above

    this.resource = resource;
    this.amount   = amount;
    this._placed  = placed;
    this._isEquipment = isEquipment;

    // Register with scene so update() can check for pickup
    if (scene.groundItems) scene.groundItems.push(this);

    // Use custom log sprites for Wood/log, fallback to spritesheet
    const isLog = resource === 'Wood' || resource === 'log';
    const logKey = isLog ? (LOG_KEYS[Math.min(amount, 3)] || LOG1_KEY) : null;

    let sprite;
    if (isEquipment) {
      // Equipment items: use a shield icon (frame 795) with a gold tint
      sprite = scene.add.image(0, 0, SHEET_KEY, 795).setScale(1.4);
      sprite.setTint(0xffdd88);
    } else if (logKey && scene.textures.exists(logKey)) {
      sprite = scene.add.image(0, 0, logKey).setScale(TILE_SIZE / 16);
    } else {
      const frame = RESOURCE_FRAME[resource] ?? 0;
      sprite = scene.add.image(0, 0, SHEET_KEY, frame).setScale(1.2);
    }
    this._sprite = sprite;
    this.add(sprite);

    // Only bob for loot drops, not placed items
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

    // Placed items can be left-clicked to pick up (but not ki targets)
    if (placed && resource !== 'KiTarget') {
      this.setSize(TILE_SIZE, TILE_SIZE);
      this.setInteractive({ useHandCursor: true });
      this.on('pointerdown', (ptr) => this._onPickupClick(ptr));
      this.on('pointerover', () => sprite.setTint(0xffee88));
      this.on('pointerout', () => sprite.clearTint());
    }
  }

  _onPickupClick(ptr = null) {
    const scene = this.scene;
    if (!scene) return;
    const player = scene.player;
    if (!player || scene._playerDead) return;

    // Right-click on equipment items: show NPC pickup context menu
    if (ptr?.rightButtonDown() || ptr?.button === 2) {
      if (this._isEquipment) {
        this._showEquipContextMenu(ptr);
      }
      return;
    }

    const d = Phaser.Math.Distance.Between(player.x, player.y, this.x, this.y);
    if (d > TILE_SIZE * 1.5) {
      const text = scene.add.text(this.x, this.y - TILE_SIZE / 2, 'Too far!', {
        fontSize: '10px', color: '#ff4444', backgroundColor: '#00000088',
        padding: { x: 3, y: 2 },
      }).setOrigin(0.5, 1).setDepth(20);
      scene.time.delayedCall(1000, () => text.destroy());
      return;
    }

    if (this.resource === 'KiShrine') {
      scene._tryUseKiShrine?.(this);
      return;
    }

    const conn = scene._conn;
    if (conn?.connected && this._serverId) {
      conn.send({ type: 'pickup_placed', item_id: this._serverId });
    }
  }

  _showEquipContextMenu(ptr) {
    const scene = this.scene;
    if (!scene) return;
    scene._openContextMenu(this, ptr);
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
}
