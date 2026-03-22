import { TILE_SIZE, PLAYER_FRAME_H } from '../constants.js';

const SCALE = TILE_SIZE / PLAYER_FRAME_H; // same scale as baseplayer

// Player base frame → hair frame
const PLAYER_HAIR_REMAP = {
  0: 0, 1: 1, 2: 2, 3: 3,
  4: 4, 5: 5, 6: 6, 7: 7,
  8: 8, 9: 9, 10: 10, 11: 11,
  12: 12, 13: 13, 14: 14, 15: 15,
  25: 25, 26: 22,
};

// NPC base frame → hair frame
const NPC_HAIR_REMAP = {
  0: 0, 1: 1, 2: 2, 3: 3,
  36: 4, 37: 5, 38: 6, 39: 7,
  54: 22, 55: 25,
};

// Fly frame by facing direction
const FLY_FRAME = { down: 28, up: 29, right: 30, left: 31 };

/**
 * Create a hair overlay sprite that composites on top of an actor.
 *
 * @param {Phaser.Scene} scene
 * @param {Phaser.GameObjects.Sprite} owner
 * @param {string} textureKey - Phaser texture key for the hair spritesheet
 * @param {boolean} isNPC - true if owner is an NPC (different frame layout)
 * @returns {Phaser.GameObjects.Sprite}
 */
export function createHairOverlay(scene, owner, textureKey, isNPC = false) {
  const overlay = scene.add.sprite(owner.x, owner.y, textureKey, 0);
  overlay.setOrigin(owner.originX ?? 0.5, owner.originY ?? 0.5);
  overlay.setDepth((owner.depth ?? 0) + 0.05);
  overlay.setScale(SCALE);
  overlay.setVisible(false);
  overlay._isNPC = !!isNPC;
  overlay._textureKey = textureKey;
  return overlay;
}

/**
 * Sync hair overlay position/frame each tick.
 *
 * @param {Phaser.GameObjects.Sprite} overlay
 * @param {Phaser.GameObjects.Sprite} owner
 */
export function syncHairOverlay(overlay, owner) {
  if (!overlay || !owner) return;

  // KO state
  if (owner._knockedOut) {
    overlay.setVisible(owner.visible && owner.alpha > 0);
    overlay.setPosition(owner.x, owner.y);
    overlay.setDepth((owner.depth ?? 0) + 0.05);
    overlay.setFrame(49);
    overlay.setFlipX(owner.flipX);
    overlay.setAlpha(owner.alpha);
    return;
  }

  // Meditating state
  if (owner._meditating) {
    overlay.setVisible(owner.visible && owner.alpha > 0);
    overlay.setPosition(owner.x, owner.y);
    overlay.setDepth((owner.depth ?? 0) + 0.05);
    overlay.setFrame(16);
    overlay.setFlipX(owner.flipX);
    overlay.setAlpha(owner.alpha);
    return;
  }

  // Flying state
  if (owner._flying) {
    const facing = owner._facing || 'down';
    const flyFrame = FLY_FRAME[facing] ?? FLY_FRAME.down;
    overlay.setVisible(owner.visible && owner.alpha > 0);
    overlay.setPosition(owner.x, owner.y);
    overlay.setDepth((owner.depth ?? 0) + 0.05);
    overlay.setFrame(flyFrame);
    overlay.setFlipX(owner.flipX);
    overlay.setAlpha(owner.alpha);
    return;
  }

  // Normal: remap current base frame to hair frame
  let baseFrame = null;
  if (owner.anims?.currentFrame) {
    const frameName = owner.anims.currentFrame.frame?.name;
    if (frameName != null) baseFrame = Number(frameName);
  }
  if (baseFrame == null && owner.frame) {
    const name = owner.frame.name;
    if (name != null) baseFrame = Number(name);
  }

  if (baseFrame == null || isNaN(baseFrame)) {
    overlay.setVisible(false);
    return;
  }

  const remap = overlay._isNPC ? NPC_HAIR_REMAP : PLAYER_HAIR_REMAP;
  const hairFrame = remap[baseFrame];
  if (hairFrame == null) {
    overlay.setVisible(false);
    return;
  }

  overlay.setVisible(owner.visible && owner.alpha > 0);
  overlay.setPosition(owner.x, owner.y);
  overlay.setDepth((owner.depth ?? 0) + 0.05);
  overlay.setFrame(hairFrame);
  overlay.setFlipX(owner.flipX);
  overlay.setAlpha(owner.alpha);
}
