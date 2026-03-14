export function initializeActorKiState(actor, { includeClairvoyance = false } = {}) {
  actor.kiDenominations = [];
  actor.kiKnownAugments = {};
  actor.kiEquippedAugments = {};
  actor.kiUpgrades = {};
  actor.meditating = false;
  actor.meditationStartedAt = 0;
  actor.meditationUntil = 0;
  actor.meditationTotalMs = 0;
  actor.meditationCrystalQuality = null;
  actor.charging = false;
  actor.chargePower = 0;
  if (includeClairvoyance) {
    actor.clairvoyanceActive = false;
    actor.clairvoyanceTargetType = null;
    actor.clairvoyanceTargetId = null;
    actor.clairvoyanceTargetOwner = null;
  }
  actor.barrierProcUntil = 0;
  actor.barrierProcFacing = 'down';
  actor.auraTint = 0x4fd6ff;
  actor.auraAlpha = 0.42;
}

export function applyActorMeditationState(actor, state = {}, onUpdate = null) {
  actor.meditating = !!state.meditating;
  actor.meditationStartedAt = Number(state.meditation_started_at || 0);
  actor.meditationUntil = Number(state.meditation_until || 0);
  actor.meditationTotalMs = Number(state.meditation_total_ms || 0);
  actor.meditationCrystalQuality = state.meditation_crystal_quality || null;
  onUpdate?.();
}

export function applyActorChargeState(actor, state = {}, { includeClairvoyance = false, facingFallback = 'down' } = {}) {
  actor.charging = !!state.charging;
  actor.chargePower = Number(state.charge_power || 0);
  if (includeClairvoyance) {
    actor.clairvoyanceActive = !!state.clairvoyance_active;
    actor.clairvoyanceTargetType = state.clairvoyance_target_type || null;
    actor.clairvoyanceTargetId = state.clairvoyance_target_id || null;
    actor.clairvoyanceTargetOwner = state.clairvoyance_target_owner || null;
  }
  actor.barrierProcUntil = Number(state.barrier_proc_until || 0);
  actor.barrierProcFacing = state.barrier_proc_facing || actor.barrierProcFacing || facingFallback;
  if (state.aura_tint != null) actor.auraTint = Number(state.aura_tint);
  if (state.aura_alpha != null) actor.auraAlpha = Number(state.aura_alpha);
}

export function hasActorKiMove(actor, moveId) {
  return (actor.kiMoves || []).includes(moveId);
}

export function hasActorKiDenomination(actor, denominationId) {
  return (actor.kiDenominations || []).includes(denominationId);
}

export function hasActorKiAugment(actor, moveId, augmentId) {
  return ((actor.kiKnownAugments?.[moveId] || []).includes(augmentId));
}

export function getEquippedActorKiAugment(actor, moveId) {
  return actor.kiEquippedAugments?.[moveId] || null;
}
