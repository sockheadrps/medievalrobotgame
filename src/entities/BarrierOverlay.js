import Phaser from 'phaser';
import { BARRIER_KEY, TILE_SIZE } from '../constants.js';

const BARRIER_SCALE = TILE_SIZE / 22;
const FRAME_BY_FACING = {
  down: [0, 4],
  up: [1, 5],
  right: [2, 6],
  left: [3, 7],
};

function getBarrierTint(owner) {
  const tint = Number(owner?.auraTint);
  return Number.isFinite(tint) ? tint : 0x4fd6ff;
}

function getBarrierFacing(owner) {
  return owner?.barrierProcFacing || owner?._facing || owner?.facing || 'down';
}

export function createBarrierOverlay(scene, owner) {
  return scene.add.sprite(owner.x, owner.y, BARRIER_KEY, 0)
    .setOrigin(0.5, 1)
    .setDepth((owner?.depth ?? 0) + 0.08)
    .setScale(BARRIER_SCALE)
    .setTint(getBarrierTint(owner))
    .setAlpha(0)
    .setVisible(false);
}

export function syncBarrierOverlay(overlay, owner) {
  if (!overlay || !owner) return;
  const until = Number(owner?.barrierProcUntil || 0);
  const nowSec = Date.now() / 1000;
  const active = until > nowSec && !!owner.visible && owner.alpha > 0;
  if (!active) {
    overlay.setVisible(false);
    return;
  }
  const frames = FRAME_BY_FACING[getBarrierFacing(owner)] || FRAME_BY_FACING.down;
  const phase = Math.floor(owner.scene.time.now / 75) % 2;
  overlay.setVisible(true);
  overlay.setPosition(owner.x, owner.y + 6);
  overlay.setDepth((owner.depth ?? 0) + 0.08);
  overlay.setTint(getBarrierTint(owner));
  overlay.setFrame(frames[phase]);
  overlay.setScale(BARRIER_SCALE * (1.02 + Math.sin(owner.scene.time.now / 90) * 0.04));
  overlay.setAlpha(Phaser.Math.Clamp(0.72 + Math.sin(owner.scene.time.now / 110) * 0.12, 0, 1));
}
