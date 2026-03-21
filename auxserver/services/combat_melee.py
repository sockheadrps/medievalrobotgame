# combat_melee.py — Melee/barrier/pvp/knockout sub-service for CombatService.
# No __init__; self.gs is provided by CombatService (the facade).

import logging
import time
import math
import random

logger = logging.getLogger(__name__)

from services.animal_service import animal_manager
from services.asset_registry import asset_registry

from services.game_state import (
    TILE_SIZE,
    PVP_ATTACK_RANGE,
    PVP_COOLDOWN,
    PVP_XP_KILL,
    PLAYER_RESPAWN_TIME,
    KNOCKOUT_MIN_TIME,
    KNOCKOUT_MAX_TIME,
    BARRIER_BASE_PHYSICAL_REDUCTION,
    BARRIER_BASE_KI_REDUCTION,
    BARRIER_UPGRADE_CAP,
    BARRIER_PROC_KI_COST,
    BARRIER_PROC_DURATION,
    CRYSTAL_UPGRADE_CHANCE,
    CRYSTAL_UPGRADE_STATS,
    FENCE_BASE_HP,
    dist,
    tile_pos,
    _gen_item_id,
)

from services.combat_utils import CombatUtilsMixin


class CombatMeleeService(CombatUtilsMixin):
    """Melee, barrier, crystal, pvp, knockout, dummy, animal, and fence combat."""

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
