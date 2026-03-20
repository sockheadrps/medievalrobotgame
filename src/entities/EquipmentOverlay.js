import { TILE_SIZE, PLAYER_FRAME_H } from '../constants.js';

const SCALE = TILE_SIZE / PLAYER_FRAME_H; // same scale as baseplayer

/**
 * Create an equipment overlay sprite that composites on top of an actor.
 * Uses a frame remap table to map baseplayer frame → armor frame.
 *
 * @param {Phaser.Scene} scene
 * @param {Phaser.GameObjects.Sprite} owner - the actor sprite (Player, NPC, RemotePlayer, RemoteNPC)
 * @param {string} textureKey - the Phaser texture key for the equipment spritesheet
 * @param {Object} remapTable - { baseFrame: armorFrame } mapping
 * @returns {Phaser.GameObjects.Sprite}
 */
export function createEquipmentOverlay(scene, owner, textureKey, remapTable) {
  const overlay = scene.add.sprite(owner.x, owner.y, textureKey, 0);
  overlay.setOrigin(owner.originX ?? 0.5, owner.originY ?? 0.5);
  overlay.setDepth((owner.depth ?? 0) + 0.05);
  overlay.setScale(SCALE);
  overlay.setVisible(false);
  overlay._remapTable = remapTable || {};
  overlay._textureKey = textureKey;
  return overlay;
}

/**
 * Sync equipment overlay position/frame each tick.
 * Reads the owner's current animation frame and remaps it.
 *
 * @param {Phaser.GameObjects.Sprite} overlay
 * @param {Phaser.GameObjects.Sprite} owner
 */
export function syncEquipmentOverlay(overlay, owner) {
  if (!overlay || !owner) return;

  // Get the owner's current base frame index
  let baseFrame = null;
  if (owner.anims?.currentFrame) {
    // For animated sprites (Player, NPC) — frame name from the spritesheet
    const frameName = owner.anims.currentFrame.frame?.name;
    if (frameName != null) {
      baseFrame = Number(frameName);
    }
  }
  if (baseFrame == null && owner.frame) {
    // Fallback: static frame name
    const name = owner.frame.name;
    if (name != null) baseFrame = Number(name);
  }

  if (baseFrame == null || isNaN(baseFrame)) {
    overlay.setVisible(false);
    return;
  }

  const armorFrame = overlay._remapTable[baseFrame];
  if (armorFrame == null) {
    // No armor frame for this pose — hide overlay
    overlay.setVisible(false);
    return;
  }

  overlay.setVisible(owner.visible && owner.alpha > 0);
  overlay.setPosition(owner.x, owner.y);
  overlay.setDepth((owner.depth ?? 0) + 0.05);
  overlay.setFrame(armorFrame);
  overlay.setFlipX(owner.flipX);
  overlay.setAlpha(owner.alpha);
}
