# combat.py — Combat service extracted from game_state.py
# Handles melee attacks, ki blasts, knockouts, barriers, absorbs, and damage calculation.

import time
import math
import random

from services.animal_service import animal_manager
from services.asset_registry import asset_registry

# Re-import constants from game_state (these are module-level in game_state.py)
from services.game_state import (
    TILE_SIZE,
    PVP_ATTACK_RANGE,
    PVP_COOLDOWN,
    PVP_XP_KILL,
    PLAYER_RESPAWN_TIME,
    KNOCKOUT_MIN_TIME,
    KNOCKOUT_MAX_TIME,
    AI_RIVAL_PID,
    KI_MAX_BASE,
    KI_MAX_PER_LEVEL,
    KI_BLAST_BASE_COST,
    KI_BLAST_BASE_DMG,
    KI_BLAST_SCALE,
    KI_DEF_REDUCTION_DIVISOR,
    KI_SKILL_RESIST_PER_LEVEL,
    KI_SKILL_RESIST_CAP,
    KI_BLAST_RANGE,
    KI_BLAST_COOLDOWN,
    ABSORB_DURATION,
    DEFAULT_KI_MOVES,
    BARRIER_BASE_PHYSICAL_REDUCTION,
    BARRIER_BASE_KI_REDUCTION,
    BARRIER_UPGRADE_CAP,
    BARRIER_PROC_KI_COST,
    BARRIER_PROC_DURATION,
    CRYSTAL_UPGRADE_CHANCE,
    CRYSTAL_UPGRADE_STATS,
    KI_TARGET_BREAK_CHANCE,
    KI_TARGET_LEARN_CHANCE,
    FENCE_BASE_HP,
    CAMPFIRE_DURATION,
    dist,
    tile_pos,
    _gen_item_id,
    _gen_campfire_id,
)


class CombatService:
    """Handles all combat: melee, ki blasts, knockouts, barriers, absorbs."""

    def __init__(self, game_state):
        self.gs = game_state

    # ── Stat helpers ──────────────────────────────────────────────────────────

    def _get_effective_str(self, actor):
        base = max(1, int(actor.get("str", 1) or 1))
        return base + self._equipment_stat_bonus(actor, "str_bonus")

    def _get_effective_def(self, actor):
        base = max(1, int(actor.get("def", 1) or 1))
        return base + self._equipment_stat_bonus(actor, "def_bonus")

    def _equipment_stat_bonus(self, actor, stat_key):
        """Sum a stat bonus across all equipped items."""
        total = 0
        for slot, eq_id in actor.get("equipment", {}).items():
            eq_def = asset_registry.get_equipment(eq_id)
            if eq_def:
                total += getattr(eq_def.stats, stat_key, 0)
        return total

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
        bonuses = actor.get("ki_blast_bonuses") or {}
        bonus = int(bonuses.get("blast_range", 0) or 0)
        # Add generous buffer (1 tile) to account for position sync lag
        return KI_BLAST_RANGE + bonus * TILE_SIZE * 0.5 + TILE_SIZE

    def _get_blast_cooldown(self, actor):
        bonuses = actor.get("ki_blast_bonuses") or {}
        bonus = int(bonuses.get("blast_cooldown", 0) or 0)
        return max(0.15, KI_BLAST_COOLDOWN - bonus * 0.05)

    # ── Melee damage ──────────────────────────────────────────────────────────

    def _calc_melee_damage(self, attacker, defender):
        """Calculate melee damage: str + level bonus, reduced by target def."""
        s = self._get_effective_str(attacker)
        d = self._get_effective_def(defender)
        level = max(1, int(attacker.get("level", 1) or 1))
        # Base: str * 1.5 + level bonus + variance, reduced by def
        base = int(s * 1.5) + level // 2
        variance = random.randint(0, max(1, s))
        reduction = d // 3
        return max(1, base + variance - reduction)

    # ── Barrier ───────────────────────────────────────────────────────────────

    def _get_barrier_stats(self, actor):
        physical_bonus = min(BARRIER_UPGRADE_CAP, self._get_upgrade_value(actor, "barrier", "physical_block"))
        ki_bonus = min(BARRIER_UPGRADE_CAP, self._get_upgrade_value(actor, "barrier", "ki_block"))
        return {
            "has_barrier": True,
            "has_ki_guard": True,
            "physical_pct": BARRIER_BASE_PHYSICAL_REDUCTION + physical_bonus,
            "ki_pct": BARRIER_BASE_KI_REDUCTION + ki_bonus,
        }

    def _apply_barrier_reduction(self, target, damage_type, raw_damage):
        incoming = max(1, int(raw_damage or 0))
        stats = self._get_barrier_stats(target)
        reduction_pct = stats["physical_pct"] if damage_type == "physical" else stats["ki_pct"]
        if reduction_pct <= 0:
            return incoming
        if not self._try_spend_plain_ki(target, BARRIER_PROC_KI_COST):
            return incoming
        target["barrier_proc_until"] = time.time() + BARRIER_PROC_DURATION
        target["barrier_proc_facing"] = target.get("facing", "down")
        return max(1, round(incoming * (1.0 - reduction_pct * 0.01)))

    def _try_spend_plain_ki(self, actor, amount):
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

    def _activate_barrier(self, pid, npc_id=None):
        """Manually activate barrier proc for player or NPC."""
        owner = self.gs.players.get(pid)
        if not owner:
            return
        actor = owner.get("npcs", {}).get(npc_id) if npc_id else owner
        if not actor or actor.get("dead") or actor.get("knocked_out"):
            return
        if not self._try_spend_plain_ki(actor, BARRIER_PROC_KI_COST):
            return
        actor["barrier_proc_until"] = time.time() + BARRIER_PROC_DURATION
        actor["barrier_proc_facing"] = actor.get("facing", "down")

    # ── Crystal consume ───────────────────────────────────────────────────────

    def _consume_crystal(self, pid, npc_id=None):
        """Consume 1 crystal from actor. 50% chance to upgrade a random ki_blast_bonuses stat."""
        owner = self.gs.players.get(pid)
        if not owner:
            return
        actor = owner.get("npcs", {}).get(npc_id) if npc_id else owner
        if not actor or actor.get("dead") or actor.get("knocked_out"):
            return
        if int(actor.get("crystals", 0) or 0) <= 0:
            return
        actor["crystals"] = int(actor.get("crystals", 0) or 0) - 1

        result = {"consumed": True, "upgraded": False, "stat": None}
        if random.random() < CRYSTAL_UPGRADE_CHANCE:
            stat = random.choice(CRYSTAL_UPGRADE_STATS)
            bonuses = actor.get("ki_blast_bonuses")
            if not isinstance(bonuses, dict):
                bonuses = {s: 0 for s in CRYSTAL_UPGRADE_STATS}
                actor["ki_blast_bonuses"] = bonuses
            bonuses[stat] = int(bonuses.get(stat, 0) or 0) + 1
            result["upgraded"] = True
            result["stat"] = stat

        owner["_crystal_result"] = result

    # ── Ki Blast helpers ──────────────────────────────────────────────────────

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

    def _queue_ki_blast_fx(self, actor, target=None, owner_pid=None, npc_id=None):
        if not actor:
            return
        start_x, start_y, impact_x, impact_y = self._compute_blast_visual_impact(actor, target)
        self.gs.fx_events.append({
            "kind": "ki_blast",
            "owner_pid": owner_pid,
            "npc_id": npc_id,
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

    # ── NPC combat helpers ────────────────────────────────────────────────────

    def _npc_attack_dummy(self, owner_pid, npc_id, dummy_id, npc_str):
        if not dummy_id:
            return
        owner = self.gs.players.get(owner_pid)
        npc_state = owner.get("npcs", {}).get(npc_id) if owner else None
        if not npc_state or npc_state.get("dead") or npc_state.get("knocked_out"):
            return
        dummy = self.gs.dummies.get(dummy_id)
        if not dummy or dummy["dead"]:
            return
        now = time.time()
        cooldown_key = f"npc_{owner_pid}_{npc_id}"
        last = dummy.get("last_hit_by", {}).get(cooldown_key, 0)
        if now - last < 0.8:
            return
        dummy.setdefault("last_hit_by", {})[cooldown_key] = now
        try:
            npc_power = int(npc_str if npc_str is not None else npc_state.get("str", 1))
        except (TypeError, ValueError):
            npc_power = 1
        npc_power = max(1, npc_power)
        try:
            dummy_hp = int(dummy.get("hp", 0))
        except (TypeError, ValueError):
            dummy_hp = 0
        dmg = max(1, npc_power + random.randint(0, max(1, npc_power // 2)))
        if not dummy.get("_etrainer"):
            dummy["hp"] = max(0, dummy_hp - dmg)
        if dummy.get("owner") and dummy.get("owner") != owner_pid:
            npc_name = npc_state.get("name", npc_id)
            self.gs.player_manager._queue_ai_alert(dummy.get("owner"), f"{owner_pid}'s NPC {npc_name} hit my training dummy.", f"{owner_pid}'s NPC is hitting my dummy.", source_pid=owner_pid, action="hit_my_dummy")
        self.gs.player_manager._grant_xp(npc_state, 5)
        if dummy["hp"] <= 0 and not dummy.get("_etrainer"):
            if dummy.get("owner") and dummy.get("owner") != owner_pid:
                npc_name = npc_state.get("name", npc_id)
                self.gs.player_manager._queue_ai_alert(dummy.get("owner"), f"{owner_pid}'s NPC {npc_name} destroyed my training dummy.", f"{owner_pid}'s NPC broke my dummy.", source_pid=owner_pid, action="hit_my_dummy")
            dummy["dead"] = True

    # ── PvP Combat ────────────────────────────────────────────────────────────

    def _try_attack_player(self, attacker_pid, target_pid):
        """Player attacks another player."""
        if attacker_pid == target_pid:
            return
        attacker = self.gs.players.get(attacker_pid)
        target = self.gs.players.get(target_pid)
        if not attacker or not target:
            return
        if attacker.get("dead") or attacker.get("knocked_out") or target.get("dead") or target.get("knocked_out"):
            return
        if attacker.get("map", "level_01") != target.get("map", "level_01"):
            return

        d = dist(attacker["x"], attacker["y"], target["x"], target["y"])
        if d > PVP_ATTACK_RANGE:
            return

        # Cooldown
        now = time.time()
        last = attacker.get("last_hit_by_player", {}).get(f"atk_{target_pid}", 0)
        if now - last < PVP_COOLDOWN:
            return
        attacker.setdefault("last_hit_by_player", {})[f"atk_{target_pid}"] = now

        # Damage: attacker STR vs target DEF
        dmg = self._calc_melee_damage(attacker, target)
        dmg = self._apply_barrier_reduction(target, "physical", dmg)
        target["hp"] = max(0, target["hp"] - dmg)
        self.gs.player_manager._queue_ai_alert(target_pid, f"{attacker_pid} hit me for {dmg} damage.", f"{attacker_pid} struck me.", source_pid=attacker_pid, action="attack_me")

        # Punch anim
        attacker["punching"] = True
        attacker["punch_until"] = now + 0.3

        # XP for hitting a player
        self.gs.player_manager._grant_xp(attacker, 8)

        if target["hp"] <= 0:
            self.gs.player_manager._queue_ai_alert(target_pid, f"{attacker_pid} knocked me out.", f"{attacker_pid} put me down.", source_pid=attacker_pid, action="knockout_me")
            self._knock_out_player(target)

    def _try_attack_npc(self, attacker_pid, target_owner_pid, target_npc_id):
        """Player attacks another player's NPC."""
        attacker = self.gs.players.get(attacker_pid)
        owner = self.gs.players.get(target_owner_pid)
        if not attacker or not owner:
            return
        if attacker.get("dead") or attacker.get("knocked_out"):
            return

        npc_state = owner.get("npcs", {}).get(target_npc_id)
        if not npc_state or npc_state.get("dead") or npc_state.get("knocked_out"):
            return

        d = dist(attacker["x"], attacker["y"], npc_state["x"], npc_state["y"])
        if d > PVP_ATTACK_RANGE:
            return

        # Cooldown
        now = time.time()
        cooldown_key = f"atk_npc_{target_npc_id}"
        last = attacker.get("last_hit_by_player", {}).get(cooldown_key, 0)
        if now - last < PVP_COOLDOWN:
            return
        attacker.setdefault("last_hit_by_player", {})[cooldown_key] = now

        dmg = self._calc_melee_damage(attacker, npc_state)
        dmg = self._apply_barrier_reduction(npc_state, "physical", dmg)
        npc_state["hp"] = max(0, npc_state["hp"] - dmg)
        npc_state["_last_attacked_by"] = {"type": "player", "id": attacker_pid}
        npc_name = npc_state.get("name", target_npc_id)
        self.gs.player_manager._queue_ai_alert(target_owner_pid, f"{attacker_pid} hit my NPC {npc_name} for {dmg} damage.", f"Hands off {npc_name}.", source_pid=attacker_pid, action="attack_my_npc")

        attacker["punching"] = True
        attacker["punch_until"] = now + 0.3

        # XP
        self.gs.player_manager._grant_xp(attacker, 5)

        if npc_state["hp"] <= 0:
            self.gs.player_manager._queue_ai_alert(target_owner_pid, f"{attacker_pid} knocked out my NPC {npc_name}.", f"You dropped {npc_name}.", source_pid=attacker_pid, action="kill_or_drop_my_npc")
            self._knock_out_npc(npc_state, attacker_pid=attacker_pid)

    def _npc_attack_player(self, owner_pid, target_pid, npc_str, npc_id):
        """An NPC (owned by owner_pid) attacks a player."""
        if owner_pid == target_pid:
            return  # NPCs don't attack their own owner
        owner = self.gs.players.get(owner_pid)
        npc_state = owner.get("npcs", {}).get(npc_id) if owner else None
        if not npc_state or npc_state.get("dead") or npc_state.get("knocked_out"):
            return
        target = self.gs.players.get(target_pid)
        if not target or target.get("dead") or target.get("knocked_out"):
            return
        # Must be on same map
        if npc_state.get("map", "level_01") != target.get("map", "level_01"):
            return

        # Cooldown
        now = time.time()
        cooldown_key = f"npc_{npc_id}"
        last = target.get("last_hit_by_player", {}).get(cooldown_key, 0)
        if now - last < PVP_COOLDOWN:
            return
        target.setdefault("last_hit_by_player", {})[cooldown_key] = now

        dmg = self._calc_melee_damage(npc_state, target)
        dmg = self._apply_barrier_reduction(target, "physical", dmg)
        target["hp"] = max(0, target["hp"] - dmg)
        attacker_name = npc_state.get("name", npc_id)
        self.gs.player_manager._queue_ai_alert(target_pid, f"{attacker_name} hit me for {dmg} damage.", f"{attacker_name} is on me.", source_pid=owner_pid, action="attack_me")
        self.gs.player_manager._grant_xp(npc_state, 8)

        if target["hp"] <= 0:
            # Credit kill XP to the NPC's owner
            if owner:
                self.gs.player_manager._grant_xp(owner, PVP_XP_KILL)
            self._knock_out_player(target)

    def _npc_attack_npc(self, owner_pid, attacker_npc_id, target_owner_pid, target_npc_id, npc_str):
        """An NPC attacks another player's NPC."""
        if owner_pid == target_owner_pid:
            return  # Don't attack own NPCs
        owner = self.gs.players.get(owner_pid)
        attacker_npc = owner.get("npcs", {}).get(attacker_npc_id) if owner else None
        if not attacker_npc or attacker_npc.get("dead") or attacker_npc.get("knocked_out"):
            return
        target_owner = self.gs.players.get(target_owner_pid)
        if not target_owner:
            return
        npc_state = target_owner.get("npcs", {}).get(target_npc_id)
        if not npc_state or npc_state.get("dead") or npc_state.get("knocked_out"):
            return
        # Must be on same map
        if attacker_npc.get("map", "level_01") != npc_state.get("map", "level_01"):
            return

        now = time.time()
        cooldown_key = f"npc_{attacker_npc_id}_vs_{target_npc_id}"
        last = npc_state.get("last_hit", {}).get(cooldown_key, 0)
        if now - last < PVP_COOLDOWN:
            return
        npc_state.setdefault("last_hit", {})[cooldown_key] = now

        dmg = self._calc_melee_damage(attacker_npc, npc_state)
        dmg = self._apply_barrier_reduction(npc_state, "physical", dmg)
        npc_state["hp"] = max(0, npc_state["hp"] - dmg)
        npc_state["_last_attacked_by"] = {"type": "npc", "id": attacker_npc_id, "owner": owner_pid}
        npc_name = npc_state.get("name", target_npc_id)
        attacker_name = attacker_npc.get("name", attacker_npc_id)
        self.gs.player_manager._queue_ai_alert(target_owner_pid, f"{attacker_name} hit my NPC {npc_name} for {dmg} damage.", f"{attacker_name} is hitting {npc_name}.", source_pid=owner_pid, action="attack_my_npc")
        self.gs.player_manager._grant_xp(attacker_npc, 5)

        if npc_state["hp"] <= 0:
            self.gs.player_manager._queue_ai_alert(target_owner_pid, f"{attacker_name} knocked out my NPC {npc_name}.", f"{attacker_name} dropped {npc_name}.", source_pid=owner_pid, action="kill_or_drop_my_npc")
            self._knock_out_npc(npc_state, attacker_pid=owner_pid)

    def _npc_steal_logs(self, owner_pid, attacker_npc_id, target_owner_pid, target_npc_id, npc_str, steal_amount):
        """An NPC smacks another player's NPC and steals logs from it."""
        if owner_pid == target_owner_pid:
            return  # Don't steal from own NPCs
        target_owner = self.gs.players.get(target_owner_pid)
        if not target_owner:
            return
        npc_state = target_owner.get("npcs", {}).get(target_npc_id)
        if not npc_state or npc_state.get("dead") or npc_state.get("knocked_out"):
            return
        owner = self.gs.players.get(owner_pid)
        attacker_npc = owner.get("npcs", {}).get(attacker_npc_id) if owner else None
        if attacker_npc and attacker_npc.get("map", "level_01") != npc_state.get("map", "level_01"):
            return

        # Cooldown — use same mechanism as npc_attack_npc
        now = time.time()
        cooldown_key = f"steal_{attacker_npc_id}_vs_{target_npc_id}"
        last = npc_state.get("last_hit", {}).get(cooldown_key, 0)
        if now - last < PVP_COOLDOWN * 2:  # longer cooldown for stealing
            return
        npc_state.setdefault("last_hit", {})[cooldown_key] = now

        # Light smack damage (half of normal attack)
        npc_def = self._get_effective_def(npc_state)
        dmg = max(1, (npc_str + random.randint(0, max(1, npc_str // 2))) // 2 - npc_def // 2)
        dmg = self._apply_barrier_reduction(npc_state, "physical", dmg)
        npc_state["hp"] = max(0, npc_state["hp"] - dmg)
        npc_name = npc_state.get("name", target_npc_id)

        # Steal logs from the target's synced data
        target_logs = npc_state.get("logs", 0)
        stolen = min(steal_amount, target_logs)
        if stolen > 0:
            npc_state["logs"] = target_logs - stolen
            npc_state["_logs_stolen_at"] = now
            npc_state["_last_robbed_by"] = {
                "npc_id": attacker_npc_id,
                "owner": owner_pid,
                "amount": stolen,
                "at": now,
            }
            self.gs.player_manager._queue_ai_alert(target_owner_pid, f"My NPC {npc_name} was jumped and lost {stolen} logs.", f"They robbed {npc_name}.", source_pid=owner_pid, action="attack_my_npc")

        if npc_state["hp"] <= 0:
            self._knock_out_npc(npc_state, attacker_pid=owner_pid)

    # ── Ki Blast Combat ───────────────────────────────────────────────────────

    def _ki_blast_player(self, attacker_pid, target_pid, blast_mode=""):
        """Player ki-blasts another player."""
        if attacker_pid == target_pid:
            return
        attacker = self.gs.players.get(attacker_pid)
        target = self.gs.players.get(target_pid)
        if not attacker or not target:
            return
        if attacker.get("dead") or attacker.get("knocked_out") or target.get("dead") or target.get("knocked_out"):
            return
        if attacker.get("map", "level_01") != target.get("map", "level_01"):
            return

        d = dist(attacker["x"], attacker["y"], target["x"], target["y"])
        if d > self._get_blast_range(attacker):
            return

        now = time.time()
        cooldown_key = f"kb_{target_pid}"
        last = attacker.get("last_hit_by_player", {}).get(cooldown_key, 0)
        if now - last < self._get_blast_cooldown(attacker):
            return

        cost, dmg = self._calc_blast_for_actor(attacker)
        cost, dmg = self._apply_blast_mode(cost, dmg, blast_mode)
        if not self._try_ki_spend(attacker, cost):
            return
        self.gs.player_manager._grant_ki_skill_xp(attacker, 1)
        self._queue_ki_blast_fx(attacker, target=target)

        attacker.setdefault("last_hit_by_player", {})[cooldown_key] = now

        final_dmg = self._apply_barrier_reduction(target, "ki", self._calc_ki_damage_taken(dmg, target))
        target["hp"] = max(0, target["hp"] - final_dmg)
        self.gs.player_manager._queue_ai_alert(target_pid, f"{attacker_pid} hit me with a ki blast for {final_dmg} damage.", f"{attacker_pid} blasted me.", source_pid=attacker_pid, action="attack_me")

        self.gs.player_manager._grant_xp(attacker, 8)

        if target["hp"] <= 0:
            self.gs.player_manager._queue_ai_alert(target_pid, f"{attacker_pid} knocked me out with a ki blast.", f"{attacker_pid} blasted me down.", source_pid=attacker_pid, action="knockout_me")
            self._knock_out_player(target)

    def _ki_blast_npc(self, attacker_pid, target_owner_pid, target_npc_id, blast_mode=""):
        """Player ki-blasts another player's NPC."""
        attacker = self.gs.players.get(attacker_pid)
        owner = self.gs.players.get(target_owner_pid)
        if not attacker or not owner:
            return
        if attacker.get("dead") or attacker.get("knocked_out"):
            return

        npc_state = owner.get("npcs", {}).get(target_npc_id)
        if not npc_state or npc_state.get("dead") or npc_state.get("knocked_out"):
            return
        if attacker.get("map", "level_01") != npc_state.get("map", "level_01"):
            return

        d = dist(attacker["x"], attacker["y"], npc_state["x"], npc_state["y"])
        if d > self._get_blast_range(attacker):
            return

        now = time.time()
        cooldown_key = f"kb_npc_{target_npc_id}"
        last = attacker.get("last_hit_by_player", {}).get(cooldown_key, 0)
        if now - last < self._get_blast_cooldown(attacker):
            return

        cost, dmg = self._calc_blast_for_actor(attacker)
        cost, dmg = self._apply_blast_mode(cost, dmg, blast_mode)
        if not self._try_ki_spend(attacker, cost):
            return
        self.gs.player_manager._grant_ki_skill_xp(attacker, 1)
        self._queue_ki_blast_fx(attacker, target=npc_state)

        attacker.setdefault("last_hit_by_player", {})[cooldown_key] = now

        final_dmg = self._apply_barrier_reduction(npc_state, "ki", self._calc_ki_damage_taken(dmg, npc_state))
        npc_state["hp"] = max(0, npc_state["hp"] - final_dmg)
        npc_state["_last_attacked_by"] = {"type": "player", "id": attacker_pid}
        npc_name = npc_state.get("name", target_npc_id)
        self.gs.player_manager._queue_ai_alert(target_owner_pid, f"{attacker_pid} blasted my NPC {npc_name} for {final_dmg} damage.", f"{attacker_pid} blasted {npc_name}.", source_pid=attacker_pid, action="attack_my_npc")

        self.gs.player_manager._grant_xp(attacker, 5)

        if npc_state["hp"] <= 0:
            self.gs.player_manager._queue_ai_alert(target_owner_pid, f"{attacker_pid} knocked out my NPC {npc_name} with a ki blast.", f"{attacker_pid} blasted {npc_name} down.", source_pid=attacker_pid, action="kill_or_drop_my_npc")
            self._knock_out_npc(npc_state, attacker_pid=attacker_pid)

    def _ki_blast_dummy(self, pid, dummy_id, blast_mode=""):
        """Player ki-blasts a training dummy."""
        p = self.gs.players.get(pid)
        if not p or not dummy_id:
            return
        dummy = self.gs.dummies.get(dummy_id)
        if not dummy or dummy.get("dead"):
            return
        if p.get("dead") or p.get("knocked_out"):
            return

        d = dist(p["x"], p["y"], dummy["x"], dummy["y"])
        if d > self._get_blast_range(p):
            return

        now = time.time()
        cooldown_key = f"kb_dummy_{dummy_id}"
        last = p.get("last_hit_by_player", {}).get(cooldown_key, 0)
        if now - last < self._get_blast_cooldown(p):
            return

        cost, dmg = self._calc_blast_for_actor(p)
        cost, dmg = self._apply_blast_mode(cost, dmg, blast_mode)
        if not self._try_ki_spend(p, cost):
            return
        self.gs.player_manager._grant_ki_skill_xp(p, 2)
        p.setdefault("last_hit_by_player", {})[cooldown_key] = now

        dummy["hp"] = max(0, dummy["hp"] - max(1, dmg))
        if dummy.get("owner"):
            self.gs.player_manager._queue_ai_alert(dummy.get("owner"), f"{pid} hit my training dummy with a ki blast.", f"{pid} is hitting my dummy.", source_pid=pid, action="hit_my_dummy")
        self.gs.player_manager._grant_xp(p, 3)
        if dummy["hp"] <= 0:
            if dummy.get("owner"):
                self.gs.player_manager._queue_ai_alert(dummy.get("owner"), f"{pid} destroyed my training dummy.", f"{pid} broke my dummy.", source_pid=pid, action="hit_my_dummy")
            dummy["dead"] = True

    def _ki_blast_ground_item(self, pid, item_id, blast_mode=""):
        """Player ki-blasts a ground log pile — ignites it into a campfire."""
        p = self.gs.players.get(pid)
        if not p or not item_id:
            return
        if p.get("dead") or p.get("knocked_out"):
            return

        # Find the ground item
        item = None
        for gi in self.gs.ground_items:
            if gi["id"] == item_id:
                item = gi
                break
        if not item:
            return
        # Only wood can be ignited
        if item.get("resource") not in ("Wood", "log"):
            return

        d = dist(p["x"], p["y"], item["x"], item["y"])
        if d > self._get_blast_range(p):
            return

        # Ki blast cost (still costs ki)
        cost, _dmg = self._calc_blast_for_actor(p)
        if not self._try_ki_spend(p, cost):
            return
        self._queue_ki_blast_fx(p)

        # Convert log pile to campfire
        log_count = min(item.get("amount", 1), 3)
        duration = CAMPFIRE_DURATION.get(log_count, 20.0)
        cid = _gen_campfire_id()
        self.gs.campfires[cid] = {
            "id": cid,
            "x": item["x"],
            "y": item["y"],
            "logs": log_count,
            "lit_at": time.time(),
            "duration": duration,
            "owner": pid,
            "dead": False,
        }
        # Remove the ground item
        self.gs.ground_items = [gi for gi in self.gs.ground_items if gi["id"] != item_id]
        print(f"[game_state] {pid} lit a campfire ({log_count} logs, {duration}s) at ({item['x']}, {item['y']})")

    def _npc_ki_blast_player(self, owner_pid, npc_id, target_pid):
        """An NPC ki-blasts a player."""
        if owner_pid == target_pid:
            return
        owner = self.gs.players.get(owner_pid)
        npc_state = owner.get("npcs", {}).get(npc_id) if owner else None
        if not npc_state or npc_state.get("dead") or npc_state.get("knocked_out"):
            return
        target = self.gs.players.get(target_pid)
        if not target or target.get("dead") or target.get("knocked_out"):
            return
        if npc_state.get("map", "level_01") != target.get("map", "level_01"):
            return

        now = time.time()
        cooldown_key = f"nkb_{npc_id}"
        last = target.get("last_hit_by_player", {}).get(cooldown_key, 0)
        if now - last < self._get_blast_cooldown(npc_state):
            return

        cost, dmg = self._calc_blast_for_actor(npc_state)
        if npc_state.get("inf_ki"):
            npc_state["ki"] = npc_state.get("maxKi", KI_MAX_BASE)
            npc_state["blastLevel"] = npc_state.get("blastLevel", 0) + 1
            self.gs.player_manager._grant_ki_skill_xp(npc_state, 2)
        else:
            ki = npc_state.get("ki", 0)
            if ki < cost:
                return
            npc_state["ki"] = ki - cost
            npc_state["blastLevel"] = npc_state.get("blastLevel", 0) + 1
            self.gs.player_manager._grant_ki_skill_xp(npc_state, 2)
        self._queue_ki_blast_fx(npc_state, target=target, owner_pid=owner_pid, npc_id=npc_id)

        target.setdefault("last_hit_by_player", {})[cooldown_key] = now

        final_dmg = self._apply_barrier_reduction(target, "ki", self._calc_ki_damage_taken(dmg, target))
        target["hp"] = max(0, target["hp"] - final_dmg)
        attacker_name = npc_state.get("name", npc_id)
        self.gs.player_manager._queue_ai_alert(target_pid, f"{attacker_name} hit me with a ki blast for {final_dmg} damage.", f"{attacker_name} blasted me.", source_pid=owner_pid, action="attack_me")
        self.gs.player_manager._grant_xp(npc_state, 8)

        if target["hp"] <= 0:
            if owner:
                self.gs.player_manager._grant_xp(owner, PVP_XP_KILL)
            self.gs.player_manager._queue_ai_alert(target_pid, f"{attacker_name} knocked me out with a ki blast.", f"{attacker_name} blasted me down.", source_pid=owner_pid, action="knockout_me")
            self._knock_out_player(target)

    def _npc_ki_blast_npc(self, owner_pid, attacker_npc_id, target_owner_pid, target_npc_id):
        """An NPC ki-blasts another player's NPC."""
        if owner_pid == target_owner_pid:
            return
        owner = self.gs.players.get(owner_pid)
        attacker_npc = owner.get("npcs", {}).get(attacker_npc_id) if owner else None
        if not attacker_npc or attacker_npc.get("dead") or attacker_npc.get("knocked_out"):
            return
        target_owner = self.gs.players.get(target_owner_pid)
        if not target_owner:
            return
        npc_state = target_owner.get("npcs", {}).get(target_npc_id)
        if not npc_state or npc_state.get("dead") or npc_state.get("knocked_out"):
            return
        if attacker_npc.get("map", "level_01") != npc_state.get("map", "level_01"):
            return

        now = time.time()
        cooldown_key = f"nkb_{attacker_npc_id}_vs_{target_npc_id}"
        last = npc_state.get("last_hit", {}).get(cooldown_key, 0)
        if now - last < self._get_blast_cooldown(attacker_npc):
            return

        cost, dmg = self._calc_blast_for_actor(attacker_npc)
        if attacker_npc.get("inf_ki"):
            attacker_npc["ki"] = attacker_npc.get("maxKi", KI_MAX_BASE)
            attacker_npc["blastLevel"] = attacker_npc.get("blastLevel", 0) + 1
            self.gs.player_manager._grant_ki_skill_xp(attacker_npc, 2)
        else:
            ki = attacker_npc.get("ki", 0)
            if ki < cost:
                return
            attacker_npc["ki"] = ki - cost
            attacker_npc["blastLevel"] = attacker_npc.get("blastLevel", 0) + 1
            self.gs.player_manager._grant_ki_skill_xp(attacker_npc, 2)
        self._queue_ki_blast_fx(attacker_npc, target=npc_state, owner_pid=owner_pid, npc_id=attacker_npc_id)

        npc_state.setdefault("last_hit", {})[cooldown_key] = now

        final_dmg = self._apply_barrier_reduction(npc_state, "ki", self._calc_ki_damage_taken(dmg, npc_state))
        npc_state["hp"] = max(0, npc_state["hp"] - final_dmg)
        npc_state["_last_attacked_by"] = {"type": "npc", "id": attacker_npc_id, "owner": owner_pid}
        npc_name = npc_state.get("name", target_npc_id)
        attacker_name = attacker_npc.get("name", attacker_npc_id)
        self.gs.player_manager._queue_ai_alert(target_owner_pid, f"{attacker_name} blasted my NPC {npc_name} for {final_dmg} damage.", f"{attacker_name} blasted {npc_name}.", source_pid=owner_pid, action="attack_my_npc")
        self.gs.player_manager._grant_xp(attacker_npc, 5)

        if npc_state["hp"] <= 0:
            self.gs.player_manager._queue_ai_alert(target_owner_pid, f"{attacker_name} knocked out my NPC {npc_name} with a ki blast.", f"{attacker_name} blasted {npc_name} down.", source_pid=owner_pid, action="kill_or_drop_my_npc")
            self._knock_out_npc(npc_state, attacker_pid=owner_pid)

    # ── Knockout / Respawn ────────────────────────────────────────────────────

    def _knockout_duration(self):
        return random.uniform(KNOCKOUT_MIN_TIME, KNOCKOUT_MAX_TIME)

    def _drop_player_resource(self, target, resource_key, resource_name):
        amount = int(target.get(resource_key, 0) or 0)
        if amount <= 0:
            return
        item_id = _gen_item_id()
        self.gs.ground_items.append({
            "id": item_id,
            "x": target["x"],
            "y": target["y"] + TILE_SIZE * 0.4,
            "resource": resource_name,
            "amount": amount,
        })
        target[resource_key] = 0

    def _apply_player_knockout_penalty(self, target):
        target["level"] = max(1, int(math.floor(max(1, int(target.get("level", 1))) * 0.9)))
        target["kiSkillLevel"] = max(1, int(math.floor(max(1, int(target.get("kiSkillLevel", 1))) * 0.9)))
        target["blastLevel"] = max(0, int(math.floor(max(0, int(target.get("blastLevel", 0))) * 0.9)))
        target["xp"] = min(int(target.get("xp", 0) or 0), max(0, target["level"] * 20 - 1))
        target["kiSkillXp"] = min(int(target.get("kiSkillXp", 0) or 0), max(0, target["kiSkillLevel"] * 20 - 1))
        self.gs.player_manager._ensure_level_based_ki(target, refill=False)
        target["hp"] = min(int(target.get("hp", 0) or 0), int(target.get("maxHp", 20) or 20))

    def _knock_out_player(self, target):
        target["dead"] = False
        target["hp"] = 0
        target["vx"] = 0
        target["vy"] = 0
        target["punching"] = False
        target["knocked_out"] = True
        target["knocked_until"] = time.time() + self._knockout_duration()
        self._apply_player_knockout_penalty(target)
        self._drop_player_resource(target, "logs", "Wood")
        self._drop_player_resource(target, "stones", "Stone")
        self._drop_player_resource(target, "crystals", "Crystal")

    def _knock_out_npc(self, npc_state, attacker_pid=None):
        """Defeat an NPC. If the attacker's combat_mode is 'ko', knock out instead of kill."""
        attacker = self.gs.players.get(attacker_pid) if attacker_pid else None
        mode = attacker.get("combat_mode", "kill") if attacker else "kill"

        npc_state["hp"] = 0
        npc_state.pop("_move_target", None)
        npc_state.pop("_on_arrive", None)

        if mode == "ko":
            npc_state["dead"] = False
            npc_state["knocked_out"] = True
            npc_state["knocked_until"] = time.time() + self._knockout_duration()
            npc_state["_task"] = None
        else:
            npc_state["dead"] = True
            npc_state["knocked_out"] = False
            npc_state["knocked_until"] = None
            npc_state["_task"] = "dead"

    def _kill_player(self, target, killer=None):
        """Handle player death — drop all logs as ground items."""
        target["dead"] = True
        target["knocked_out"] = False
        target["knocked_until"] = None
        target["hp"] = 0
        target["vx"] = 0
        target["vy"] = 0
        target["respawn_at"] = time.time() + PLAYER_RESPAWN_TIME

        # Drop logs as ground items at death location
        if target["logs"] > 0:
            item_id = _gen_item_id()
            self.gs.ground_items.append({
                "id": item_id,
                "x": target["x"],
                "y": target["y"] + TILE_SIZE * 0.4,
                "resource": "Wood",
                "amount": target["logs"],
            })
            target["logs"] = 0

    # ── Absorb ────────────────────────────────────────────────────────────────

    def _get_actor_for_absorb(self, actor_pid, actor_npc_id=None):
        if actor_npc_id:
            owner = self.gs.players.get(actor_pid)
            return owner.get("npcs", {}).get(actor_npc_id) if owner else None
        return self.gs.players.get(actor_pid)

    def _start_player_absorb(self, attacker_pid, target_owner_pid, target_npc_id):
        attacker = self.gs.players.get(attacker_pid)
        if not attacker or attacker.get("dead") or attacker.get("knocked_out"):
            return
        self.gs.player_manager._ensure_default_ki_moves(attacker)
        if "absorb" not in attacker.get("ki_moves", []):
            return
        self._start_absorb(attacker_pid, None, target_owner_pid, target_npc_id)

    def _start_npc_absorb(self, owner_pid, npc_id, target_owner_pid, target_npc_id):
        owner = self.gs.players.get(owner_pid)
        npc_state = owner.get("npcs", {}).get(npc_id) if owner else None
        if not npc_state or npc_state.get("dead") or npc_state.get("knocked_out"):
            return
        self.gs.player_manager._ensure_default_ki_moves(npc_state)
        if "absorb" not in npc_state.get("ki_moves", []):
            return
        self._start_absorb(owner_pid, npc_id, target_owner_pid, target_npc_id)

    def _start_absorb(self, actor_pid, actor_npc_id, target_owner_pid, target_npc_id):
        actor = self._get_actor_for_absorb(actor_pid, actor_npc_id)
        target_owner = self.gs.players.get(target_owner_pid)
        target = target_owner.get("npcs", {}).get(target_npc_id) if target_owner else None
        if not actor or not target:
            return
        if target.get("dead") or not target.get("knocked_out"):
            return
        if actor.get("map", "level_01") != target.get("map", "level_01"):
            return
        if dist(actor.get("x", 0), actor.get("y", 0), target.get("x", 0), target.get("y", 0)) > self._get_blast_range(actor):
            return
        cooldown_key = f"absorb_{target_owner_pid}_{target_npc_id}"
        now = time.time()
        last = actor.get("last_hit_by_player", {}).get(cooldown_key, 0)
        if now - last < ABSORB_DURATION:
            return
        cost, _dmg = self._calc_blast_for_actor(actor)
        if not self._try_ki_spend(actor, cost):
            return
        actor.setdefault("last_hit_by_player", {})[cooldown_key] = now
        self._queue_absorb_fx(actor, target, owner_pid=actor_pid, npc_id=actor_npc_id)
        self.gs.pending_absorbs.append({
            "resolve_at": now + ABSORB_DURATION,
            "actor_pid": actor_pid,
            "actor_npc_id": actor_npc_id,
            "target_owner_pid": target_owner_pid,
            "target_npc_id": target_npc_id,
        })

    def _resolve_pending_absorb(self, absorb):
        actor = self._get_actor_for_absorb(absorb.get("actor_pid"), absorb.get("actor_npc_id"))
        target_owner = self.gs.players.get(absorb.get("target_owner_pid"))
        target = target_owner.get("npcs", {}).get(absorb.get("target_npc_id")) if target_owner else None
        if not actor or not target:
            return
        if actor.get("dead") or actor.get("knocked_out"):
            return
        if target.get("dead") or not target.get("knocked_out"):
            return
        if actor.get("map", "level_01") != target.get("map", "level_01"):
            return
        if dist(actor.get("x", 0), actor.get("y", 0), target.get("x", 0), target.get("y", 0)) > self._get_blast_range(actor):
            return

        str_gain = max(1, int(target.get("str", 1) or 1) // 2)
        def_gain = max(1, int(target.get("def", 1) or 1) // 2)
        ki_gain = max(1, int(target.get("kiSkillLevel", 1) or 1) // 2)
        actor["str"] = int(actor.get("str", 1) or 1) + str_gain
        actor["def"] = int(actor.get("def", 1) or 1) + def_gain
        actor["kiSkillLevel"] = int(actor.get("kiSkillLevel", 1) or 1) + ki_gain
        actor["kiSkillXp"] = min(int(actor.get("kiSkillXp", 0) or 0), max(0, actor["kiSkillLevel"] * 20 - 1))

        target["hp"] = 0
        target["dead"] = True
        target["knocked_out"] = False
        target["knocked_until"] = None
        target["_task"] = "dead"
        target.pop("_move_target", None)
        target.pop("_on_arrive", None)

    # ── Attack dummy (player) ─────────────────────────────────────────────────

    def _try_attack_dummy(self, pid, dummy_id):
        p = self.gs.players.get(pid)
        if not p or not dummy_id:
            return
        dummy = self.gs.dummies.get(dummy_id)
        if not dummy or dummy["dead"]:
            return
        d = dist(p["x"], p["y"], dummy["x"], dummy["y"])
        if d > TILE_SIZE * 1.5:
            return

        # Facing check
        dx = dummy["x"] - p["x"]
        dy = dummy["y"] - p["y"]
        facing = p["facing"]
        if abs(dx) > abs(dy):
            if not ((dx > 0 and facing == "right") or (dx < 0 and facing == "left")):
                return
        else:
            if not ((dy > 0 and facing == "down") or (dy < 0 and facing == "up")):
                return

        # Cooldown check
        now = time.time()
        last = dummy.get("last_hit_by", {}).get(pid, 0)
        if now - last < 0.8:
            return
        dummy.setdefault("last_hit_by", {})[pid] = now

        # Damage
        s = p["str"]
        dmg = max(1, s + random.randint(0, max(1, s // 2)))
        if not dummy.get("_etrainer"):
            dummy["hp"] = max(0, dummy["hp"] - dmg)

        # Punch anim
        p["punching"] = True
        p["punch_until"] = now + 0.3

        # XP
        self.gs.player_manager._grant_xp(p, 5)

        if dummy["hp"] <= 0 and not dummy.get("_etrainer"):
            dummy["dead"] = True

    # ── Attack animal ─────────────────────────────────────────────────────────

    def _try_attack_animal(self, pid, animal_id):
        if not animal_id:
            return
        p = self.gs.players.get(pid)
        if not p:
            return
        result = animal_manager.handle_attack(animal_id, pid, damage=5)
        if result:
            # Animal died — give loot to attacker
            for drop in result.get("drops", []):
                item = drop["item"]
                qty  = drop["quantity"]
                if item == "meat":
                    p["meat"] = p.get("meat", 0) + qty
                elif item == "feather":
                    p["feathers"] = p.get("feathers", 0) + qty
                else:
                    # Generic ground item drop at animal position
                    animal = next((a for a in animal_manager.get_all() if a["id"] == animal_id), None)
                    if animal:
                        self.gs.ground_items.append({
                            "id": _gen_item_id(),
                            "x":  animal["x"],
                            "y":  animal["y"],
                            "resource": item,
                            "amount": qty,
                        })
            self.gs.fx_events.append({
                "type":   "animal_kill",
                "animal_id": animal_id,
                "killer": pid,
                "drops":  result.get("drops", []),
            })

    # ── Ki Target combat ──────────────────────────────────────────────────────

    def _ki_blast_ki_target(self, pid, target_id, watching_npc_id=None):
        """Player ki-blasts a ki target. 40% chance to break. 1/25 chance watching NPC learns."""
        p = self.gs.players.get(pid)
        if not p:
            return

        # Find ki target in ground items
        kt = None
        for item in self.gs.ground_items:
            if item.get("id") == target_id and item.get("resource") == "KiTarget":
                kt = item
                break
        if not kt:
            return

        d = dist(p["x"], p["y"], kt["x"], kt["y"])
        if d > KI_BLAST_RANGE:
            return

        cost, _dmg = self._calc_blast(p.get("blastLevel", 0))
        if not self._try_ki_spend(p, cost):
            return
        self.gs.player_manager._grant_ki_skill_xp(p, 2)
        self.gs.player_manager._grant_xp(p, 3)

        # Check if NPC learns (1/25 chance)
        npc_learned = False
        if watching_npc_id:
            npc_state = p.get("npcs", {}).get(watching_npc_id)
            if npc_state and not npc_state.get("has_ki_blast"):
                if random.random() < KI_TARGET_LEARN_CHANCE:
                    npc_state["has_ki_blast"] = True
                    npc_state["blastLevel"] = 0
                    npc_state["ki"] = npc_state.get("ki", 20)
                    npc_state["maxKi"] = npc_state.get("maxKi", 20)
                    npc_learned = True
                    print(f"[game_state] NPC {watching_npc_id} learned ki blast!")

        # 40% chance target breaks
        broke = random.random() < KI_TARGET_BREAK_CHANCE
        if broke:
            self.gs.ground_items = [item for item in self.gs.ground_items if item.get("id") != target_id]

        p.setdefault("_ki_target_result", {})
        p["_ki_target_result"] = {
            "target_id": target_id,
            "broke": broke,
            "npc_learned": npc_learned,
            "npc_id": watching_npc_id,
        }

    def _npc_ki_blast_ki_target(self, owner_pid, npc_id, target_id):
        """An NPC ki-blasts a ki target (practice_ki task)."""
        owner = self.gs.players.get(owner_pid)
        if not owner:
            return
        npc_state = owner.get("npcs", {}).get(npc_id)
        if not npc_state or npc_state.get("dead") or npc_state.get("knocked_out"):
            return
        if not npc_state.get("has_ki_blast"):
            return

        # Find ki target in ground items
        kt = None
        for item in self.gs.ground_items:
            if item.get("id") == target_id and item.get("resource") == "KiTarget":
                kt = item
                break
        if not kt:
            return

        cost, _dmg = self._calc_blast(npc_state.get("blastLevel", 0))
        if npc_state.get("inf_ki"):
            npc_state["ki"] = npc_state.get("maxKi", KI_MAX_BASE)
            npc_state["blastLevel"] = npc_state.get("blastLevel", 0) + 1
            self.gs.player_manager._grant_ki_skill_xp(npc_state, 3)
        else:
            ki = npc_state.get("ki", 0)
            if ki < cost:
                return
            npc_state["ki"] = ki - cost
            npc_state["blastLevel"] = npc_state.get("blastLevel", 0) + 1
            self.gs.player_manager._grant_ki_skill_xp(npc_state, 3)
        self.gs.player_manager._grant_xp(npc_state, 3)

        # 40% chance target breaks
        broke = random.random() < KI_TARGET_BREAK_CHANCE
        if broke:
            self.gs.ground_items = [item for item in self.gs.ground_items if item.get("id") != target_id]

        owner.setdefault("_ki_target_result", {})
        owner["_ki_target_result"] = {
            "target_id": target_id,
            "broke": broke,
            "npc_learned": False,
            "npc_id": npc_id,
        }

    # ── Attack fence ──────────────────────────────────────────────────────────

    def _try_attack_fence(self, pid, bid):
        """Player punches a fence. STR-based damage."""
        p = self.gs.players.get(pid)
        if not p or p.get("dead"):
            return
        if not bid or bid not in self.gs.buildings:
            return
        bld = self.gs.buildings[bid]
        if bld.get("kind") != "fence":
            return
        # Must be on same map
        if p.get("map", "level_01") != bld.get("map", "level_01"):
            return
        # Range check
        bx, by = tile_pos(bld["col"], bld["row"])
        d = dist(p["x"], p["y"], bx, by)
        if d > TILE_SIZE * 2.0:
            return
        # Cooldown — reuse punch cooldown
        now = time.time()
        if now - p.get("_last_fence_hit", 0) < 0.5:
            return
        p["_last_fence_hit"] = now
        # Punch anim
        p["punching"] = True
        p["punch_until"] = now + 0.3
        # Damage = STR + random(0..STR/2)
        s = max(1, int(p.get("str", 1)))
        dmg = s + random.randint(0, max(1, s // 2))
        bld["hp"] = max(0, bld.get("hp", FENCE_BASE_HP) - dmg)
        # Destroy fence if HP <= 0
        if bld["hp"] <= 0:
            del self.gs.buildings[bid]
