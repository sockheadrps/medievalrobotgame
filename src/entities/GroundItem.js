import Phaser from 'phaser';
import { TILE_SIZE, SHEET_KEY, RESOURCE_FRAME } from '../constants.js';

// A resource item sitting on the ground, ejected from the end of a conveyor.
// The player can walk over it to pick it up (proximity-based, checked each frame).
export class GroundItem extends Phaser.GameObjects.Container {
  constructor(scene, x, y, resource, amount = 1) {
    super(scene, x, y);
    scene.add.existing(this);
    this.setDepth(2);

    this.resource = resource;
    this.amount   = amount;

    // Register with scene so update() can check for pickup
    if (scene.groundItems) scene.groundItems.push(this);

    // Use the actual spritesheet frame for the resource
    const frame = RESOURCE_FRAME[resource] ?? 0;
    const sprite = scene.add.image(0, 0, SHEET_KEY, frame).setScale(1.2);
    this.add(sprite);

    // Subtle bob tween so it's obvious on the ground
    scene.tweens.add({
      targets: sprite,
      y: -3,
      duration: 600,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
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
    super.destroy(fromScene);
  }
}
