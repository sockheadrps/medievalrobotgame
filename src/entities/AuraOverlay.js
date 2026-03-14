import Phaser from 'phaser';
import { AURA_FRAMES, AURA_KEY, TILE_SIZE } from '../constants.js';

const AURA_SCALE = TILE_SIZE / 28;
const AURA_ALPHA = 0.42;
const AURA_TINT = 0x4fd6ff;
const AURA_ANIM_KEY = 'charge-aura-loop';

function getAuraAlpha(owner) {
  const alpha = Number(owner?.auraAlpha);
  return Number.isFinite(alpha) ? Phaser.Math.Clamp(alpha, 0, 1) : AURA_ALPHA;
}

function getAuraTint(owner) {
  const tint = Number(owner?.auraTint);
  return Number.isFinite(tint) ? tint : AURA_TINT;
}

function ensureAuraAnim(scene) {
  if (scene.anims.exists(AURA_ANIM_KEY)) return;
  scene.anims.create({
    key: AURA_ANIM_KEY,
    frames: scene.anims.generateFrameNumbers(AURA_KEY, { start: 0, end: AURA_FRAMES - 1 }),
    frameRate: 10,
    repeat: -1,
  });
}

export function createAuraOverlay(scene, owner) {
  ensureAuraAnim(scene);
  return scene.add.sprite(owner.x, owner.y, AURA_KEY, 0)
    .setOrigin(0.5, 1)
    .setDepth((owner?.depth ?? 0) + 0.05)
    .setScale(AURA_SCALE)
    .setTint(getAuraTint(owner))
    .setAlpha(0)
    .setVisible(false);
}

export function syncAuraOverlay(overlay, owner, active) {
  if (!overlay || !owner) return;
  const show = !!active && !!owner.visible && owner.alpha > 0;
  if (!show) {
    overlay.setVisible(false);
    overlay.stop();
    return;
  }
  overlay.setVisible(true);
  if (overlay.anims?.currentAnim?.key !== AURA_ANIM_KEY || !overlay.anims?.isPlaying) {
    overlay.play(AURA_ANIM_KEY);
  }
  overlay.setDepth((owner.depth ?? 0) + 0.05);
  overlay.setPosition(owner.x, owner.y + 6);
  overlay.setTint(getAuraTint(owner));
  const pulse = 0.94 + Math.sin(owner.scene.time.now / 110) * 0.06;
  overlay.setScale(AURA_SCALE * pulse);
  const baseAlpha = getAuraAlpha(owner);
  overlay.setAlpha(Phaser.Math.Clamp(baseAlpha + Math.sin(owner.scene.time.now / 140) * 0.08, 0, 1));
}
