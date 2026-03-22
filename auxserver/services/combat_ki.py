# combat_ki.py — Ki blast / absorb / ki target sub-service for CombatService.
# No __init__; self.gs is provided by CombatService (the facade).
# Cross-calls to melee helpers (e.g. _apply_barrier_reduction) go through self.

import logging
import time
import random

logger = logging.getLogger(__name__)

from services.game_state import (
    KI_MAX_BASE,
    KI_BLAST_RANGE,
    ABSORB_DURATION,
    KI_TARGET_BREAK_CHANCE,
    KI_TARGET_LEARN_CHANCE,
    CAMPFIRE_DURATION,
    PVP_XP_KILL,
    dist,
    _gen_campfire_id,
)

from services.combat_utils import CombatUtilsMixin

import json as _json
from pathlib import Path as _Path

_BLAST_MOVES_PATH = _Path(__file__).resolve().parent.parent / "data" / "blast_moves.json"
BLAST_DEFS: dict = {}


def _load_blast_defs():
    global BLAST_DEFS
    try:
        raw = _json.loads(_BLAST_MOVES_PATH.read_text(encoding="utf-8"))
        BLAST_DEFS = {b["id"]: b for b in raw if "id" in b}
        logger.info("Loaded %d blast definitions", len(BLAST_DEFS))
    except Exception as e:
        logger.warning("Failed to load blast_moves.json: %s", e)
        BLAST_DEFS = {}


def reload_blast_defs():
    """Called by admin API after saving blast_moves.json."""
    _load_blast_defs()


_load_blast_defs()


class CombatKiService(CombatUtilsMixin):
    """Ki blast, absorb, and ki-target combat."""

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
        logger.debug("%s lit a campfire (%d logs, %ss) at (%s, %s)", pid, log_count, duration, item['x'], item['y'])

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
                    logger.debug("NPC %s learned ki blast!", watching_npc_id)

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
