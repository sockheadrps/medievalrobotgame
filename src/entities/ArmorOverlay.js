import {
  ARMOR_ELITE_KEY,
  ARMOR_ELITE_META_KEY,
  PFRAME_FACE_DOWN,
  PFRAME_FACE_UP,
  PFRAME_FACE_RIGHT,
  PFRAME_FACE_LEFT,
  PFRAME_WALK1_DOWN,
  PFRAME_WALK1_UP,
  PFRAME_WALK1_RIGHT,
  PFRAME_WALK1_LEFT,
  PFRAME_STAND_DOWN,
  PFRAME_STAND_UP,
  PFRAME_STAND_RIGHT,
  PFRAME_STAND_LEFT,
  PFRAME_WALK2_DOWN,
  PFRAME_WALK2_UP,
  PFRAME_WALK2_RIGHT,
  PFRAME_WALK2_LEFT,
  PFRAME_PUNCH_LEFT,
  PFRAME_PUNCH_RIGHT,
} from '../constants.js';

const DEFAULT_ARMOR_FRAMES = {
  face_down: 0,
  face_up: 1,
  face_right: 2,
  face_left: 3,
  walk_1_down: 4,
  walk_1_up: 5,
  walk_1_right: 6,
  walk_1_left: 7,
  stand_directional_down: 8,
  stand_directional_up: 9,
  stand_directional_right: 10,
  stand_directional_left: 11,
  walk_2_down: 12,
  walk_2_up: 13,
  walk_2_right: 14,
  walk_2_left: 15,
  punch_sequence_2_right: 18,
  punch_sequence_2_left: 19,
  knocked_out_directional_down: 20,
  knocked_out_final: 50,
  knocked_out_directional_up: 52,
  knocked_out_directional_right: 53,
};

const PLAYER_FRAME_TO_ARMOR_NAME = {
  [PFRAME_FACE_DOWN]: 'face_down',
  [PFRAME_FACE_UP]: 'face_up',
  [PFRAME_FACE_RIGHT]: 'face_right',
  [PFRAME_FACE_LEFT]: 'face_left',
  [PFRAME_WALK1_DOWN]: 'walk_1_down',
  [PFRAME_WALK1_UP]: 'walk_1_up',
  [PFRAME_WALK1_RIGHT]: 'walk_1_right',
  [PFRAME_WALK1_LEFT]: 'walk_1_left',
  [PFRAME_STAND_DOWN]: 'stand_directional_down',
  [PFRAME_STAND_UP]: 'stand_directional_up',
  [PFRAME_STAND_RIGHT]: 'stand_directional_right',
  [PFRAME_STAND_LEFT]: 'stand_directional_left',
  [PFRAME_WALK2_DOWN]: 'walk_2_down',
  [PFRAME_WALK2_UP]: 'walk_2_up',
  [PFRAME_WALK2_RIGHT]: 'walk_2_right',
  [PFRAME_WALK2_LEFT]: 'walk_2_left',
  [PFRAME_PUNCH_LEFT]: 'punch_sequence_2_left',
  [PFRAME_PUNCH_RIGHT]: 'punch_sequence_2_right',
};

function getArmorFrameMap(scene) {
  if (!scene?._armorEliteFrameMap) {
    const meta = scene?.cache?.json?.get(ARMOR_ELITE_META_KEY) || {};
    const frameMap = { ...DEFAULT_ARMOR_FRAMES };
    for (const [index, name] of Object.entries(meta.namedFrames || {})) {
      if (typeof name === 'string') frameMap[name] = Number(index);
    }
    scene._armorEliteFrameMap = frameMap;
  }
  return scene._armorEliteFrameMap;
}

function armorFrameForName(scene, name) {
  const frames = getArmorFrameMap(scene);
  return frames[name] ?? frames.face_down ?? 0;
}

export function createArmorOverlay(scene, owner) {
  const overlay = scene.add.sprite(owner.x, owner.y, ARMOR_ELITE_KEY, armorFrameForName(scene, 'face_down'));
  overlay.setOrigin(owner.originX ?? 0.5, owner.originY ?? 1);
  overlay.setScale(owner.scaleX ?? 1, owner.scaleY ?? 1);
  overlay.setDepth((owner.depth ?? 0) + 0.05);
  overlay.setVisible(false);
  return overlay;
}

export function syncArmorOverlay(overlay, owner, frameName, visible) {
  if (!overlay || !owner) return;
  overlay.setPosition(owner.x, owner.y);
  overlay.setOrigin(owner.originX ?? 0.5, owner.originY ?? 1);
  overlay.setScale(owner.scaleX ?? 1, owner.scaleY ?? 1);
  overlay.setDepth((owner.depth ?? 0) + 0.05);
  overlay.setFlipX(owner.flipX ?? false);
  overlay.setAlpha(owner.alpha ?? 1);
  if (owner.tintTopLeft != null && owner.tintTopLeft !== 0xffffff) {
    overlay.setTint(owner.tintTopLeft);
  } else {
    overlay.clearTint();
  }
  overlay.setVisible(!!visible);
  if (visible) overlay.setFrame(armorFrameForName(owner.scene, frameName));
}

export function getPlayerArmorFrameName(owner) {
  if (owner?._knockedOut) {
    if (owner._facing === 'up') return 'knocked_out_directional_up';
    if (owner._facing === 'left' || owner._facing === 'right') return 'knocked_out_directional_right';
    return 'knocked_out_directional_down';
  }
  const frameIndex = Number(owner?.frame?.name ?? owner?.frame?.index ?? PFRAME_FACE_DOWN);
  return PLAYER_FRAME_TO_ARMOR_NAME[frameIndex] || `face_${owner?._facing || 'down'}`;
}

export function getNpcArmorFrameName(owner, moving = false, walkToggle = false) {
  if (owner?._knockedOut) {
    if (owner._facing === 'up') return 'knocked_out_directional_up';
    if (owner._facing === 'left' || owner._facing === 'right') return 'knocked_out_directional_right';
    return 'knocked_out_directional_down';
  }
  if (owner?._punching) {
    return owner._facing === 'left' ? 'punch_sequence_2_left' : 'punch_sequence_2_right';
  }
  if (moving) {
    return `${walkToggle ? 'walk_1' : 'face'}_${owner?._facing || 'down'}`;
  }
  return `face_${owner?._facing || 'down'}`;
}
