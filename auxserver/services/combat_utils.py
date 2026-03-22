# combat_utils.py — Shared ki blast math/FX helpers used by both
# CombatMeleeService and CombatKiService.
# No __init__; self.gs is provided by CombatService (the facade).

import time

from services.game_state import (
    TILE_SIZE,
    KI_MAX_BASE,
    KI_BLAST_BASE_COST,
    KI_BLAST_BASE_DMG,
    KI_BLAST_SCALE,
    KI_DEF_REDUCTION_DIVISOR,
    KI_SKILL_RESIST_PER_LEVEL,
    KI_SKILL_RESIST_CAP,
    KI_BLAST_RANGE,
    KI_BLAST_COOLDOWN,
    ABSORB_DURATION,
    BARRIER_PROC_KI_COST,
    BARRIER_PROC_DURATION,
)


class CombatUtilsMixin:
    """Shared ki blast math and FX helpers with no melee-specific logic."""

    # ── Ki upgrade helpers ────────────────────────────────────────────────────

    def _get_upgrade_map(self, actor):
        upgrades = actor.get("ki_upgrades")
        if not isinstance(upgrades, dict):
            upgrades = {}
            actor["ki_upgrades"] = upgrades
        return upgrades

    def _get_upgrade_value(self, actor, move_id, stat_id):
        upgrades = self._get_upgrade_map(actor)
        move_data = upgrades.get(move_id)
        if not isinstance(move_data, dict):
            return 0
        return max(0, int(move_data.get(stat_id, 0) or 0))

    def _get_blast_range(self, actor):
        import time as _t
        if actor.get("blinded_until", 0) > _t.time():
            return KI_BLAST_RANGE * 0.2
        bonuses = actor.get("ki_blast_bonuses") or {}
        bonus = int(bonuses.get("blast_range", 0) or 0)
        return KI_BLAST_RANGE + bonus * TILE_SIZE * 0.5 + TILE_SIZE

    def _get_blast_cooldown(self, actor):
        bonuses = actor.get("ki_blast_bonuses") or {}
        bonus = int(bonuses.get("blast_cooldown", 0) or 0)
        return max(0.15, KI_BLAST_COOLDOWN - bonus * 0.05)

    # ── Ki blast math helpers ─────────────────────────────────────────────────

    def _calc_blast(self, blast_level):
        """Return (cost, dmg) for a given blast level. 2% compound improvement per level."""
        cost = max(1, round(KI_BLAST_BASE_COST * (1 - KI_BLAST_SCALE) ** blast_level))
        dmg = max(1, round(KI_BLAST_BASE_DMG * (1 + KI_BLAST_SCALE) ** blast_level))
        return cost, dmg

    def _calc_blast_for_actor(self, actor):
        cost, dmg = self._calc_blast(actor.get("blastLevel", 0))
        bonuses = actor.get("ki_blast_bonuses") or {}
        blast_dmg_bonus = int(bonuses.get("blast_dmg", 0) or 0)
        # Ki skill level adds damage: +1 per 2 skill levels
        ki_skill_level = max(1, int(actor.get("kiSkillLevel", 1) or 1))
        ki_skill_bonus = ki_skill_level // 2
        return cost, max(1, dmg + blast_dmg_bonus + ki_skill_bonus)

    @staticmethod
    def _apply_blast_mode(cost, dmg, blast_mode):
        """Adjust cost and damage based on blast mode variant."""
        if blast_mode == "scatter_shot":
            return cost * 2, max(1, int(dmg * 0.6))  # 3 projectiles x 60% each ~ 180% total
        if blast_mode == "explosive_shot":
            return cost * 3, max(1, int(dmg * 2.0))   # AoE, 200% single-target damage
        return cost, dmg

    def _calc_ki_damage_taken(self, raw_dmg, target):
        base_dmg = max(1, int(raw_dmg or 0))
        effective_def = self._get_effective_def(target)
        after_def = max(1, base_dmg - max(0, effective_def) // KI_DEF_REDUCTION_DIVISOR)
        ki_skill_level = max(1, int(target.get("kiSkillLevel", 1) or 1))
        resist_pct = min(KI_SKILL_RESIST_CAP, max(0.0, (ki_skill_level - 1) * KI_SKILL_RESIST_PER_LEVEL))
        return max(1, round(after_def * (1.0 - resist_pct)))

    def _compute_blast_visual_impact(self, actor, target=None):
        start_x = float(actor.get("x", 0))
        start_y = float(actor.get("y", 0)) - TILE_SIZE * 0.4
        facing = actor.get("facing", "down")
        dir_map = {
            "down": (0.0, 1.0),
            "up": (0.0, -1.0),
            "left": (-1.0, 0.0),
            "right": (1.0, 0.0),
        }
        dx, dy = dir_map.get(facing, dir_map["down"])
        if target:
            end_x = float(target.get("x", start_x))
            end_y = float(target.get("y", start_y)) - TILE_SIZE * 0.4
        else:
            blast_range = self._get_blast_range(actor)
            end_x = start_x + dx * blast_range
            end_y = start_y + dy * blast_range
        return start_x, start_y, end_x, end_y

    def _queue_ki_blast_fx(self, actor, target=None, owner_pid=None, npc_id=None, blast_id=None):
        if not actor:
            return
        start_x, start_y, impact_x, impact_y = self._compute_blast_visual_impact(actor, target)
        self.gs.fx_events.append({
            "kind": "ki_blast",
            "owner_pid": owner_pid,
            "npc_id": npc_id,
            "blast_id": blast_id or actor.get("active_blast_id"),
            "start_x": start_x,
            "start_y": start_y,
            "impact_x": impact_x,
            "impact_y": impact_y,
            "facing": actor.get("facing", "down"),
        })

    def _queue_absorb_fx(self, actor, target, owner_pid=None, npc_id=None):
        if not actor or not target:
            return
        start_x = float(actor.get("x", 0))
        start_y = float(actor.get("y", 0)) - TILE_SIZE * 0.4
        impact_x = float(target.get("x", start_x))
        impact_y = float(target.get("y", start_y)) - TILE_SIZE * 0.4
        self.gs.fx_events.append({
            "kind": "absorb",
            "owner_pid": owner_pid,
            "npc_id": npc_id,
            "start_x": start_x,
            "start_y": start_y,
            "impact_x": impact_x,
            "impact_y": impact_y,
            "duration_ms": int(ABSORB_DURATION * 1000),
        })

    def _try_ki_spend(self, entity, cost):
        """Deduct ki from entity if enough. Returns True on success."""
        if entity.get("inf_ki"):
            entity["ki"] = entity.get("maxKi", KI_MAX_BASE)
            entity["blastLevel"] = entity.get("blastLevel", 0) + 1
            self.gs.player_manager._grant_ki_skill_xp(entity, 1)
            return True
        ki = entity.get("ki", 0)
        if ki < cost:
            return False
        entity["ki"] = ki - cost
        entity["blastLevel"] = entity.get("blastLevel", 0) + 1
        self.gs.player_manager._grant_ki_skill_xp(entity, 1)
        return True

    def _try_spend_plain_ki(self, actor, amount):
        """Spend plain ki (barrier cost helper). Returns True on success."""
        cost = max(0, int(amount or 0))
        if cost <= 0:
            return True
        if actor.get("inf_ki"):
            actor["ki"] = actor.get("maxKi", KI_MAX_BASE)
            return True
        ki = int(actor.get("ki", 0) or 0)
        if ki < cost:
            return False
        actor["ki"] = ki - cost
        return True
