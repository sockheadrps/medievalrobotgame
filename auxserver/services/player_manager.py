"""Player management: init, stats, inventory, crafting, death/respawn.

Also contains handle_input(), the server-side message router for all
client actions. This is a temporary home; see handle_input docstring.
"""

import logging
import math
import random
import time

from services.asset_registry import asset_registry
from services.world_data import TILE_SIZE, register_player_portal, get_player_portals, get_map_dimensions
from core.constants import PLAYER_SPEED, PLAYER_RUN_SPEED, KI_MAX_BASE, KI_MAX_PER_LEVEL

logger = logging.getLogger(__name__)

DEFAULT_KI_MOVES = ["absorb"]
AI_RIVAL_PID = "__ai_rival__"


def tile_pos(col, row):
    return (col * TILE_SIZE + TILE_SIZE / 2, row * TILE_SIZE + TILE_SIZE / 2)


def dist(x1, y1, x2, y2):
    return math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2)


def _gen_item_id():
    """Delegate to game_state module-level generator so IDs don't collide."""
    from services.game_state import _gen_item_id as _gs_gen
    return _gs_gen()


def _assign_central_portal(pid: str) -> tuple[int, int]:
    """Pick a random perimeter tile on the central map with >=15 tile spacing."""
    cols, rows = get_map_dimensions("central")
    existing = [(p["tile_col"], p["tile_row"]) for p in get_player_portals()
                if p["from_map"] == "central"]
    min_dist = 15
    # Build perimeter tile list
    perimeter = []
    for c in range(cols):
        perimeter.append((c, 0))
        perimeter.append((c, rows - 1))
    for r in range(1, rows - 1):
        perimeter.append((0, r))
        perimeter.append((cols - 1, r))
    random.shuffle(perimeter)

    best = None
    best_min_d = -1
    for attempt, (c, r) in enumerate(perimeter):
        if attempt >= 50 and best:
            break
        if not existing:
            best = (c, r)
            break
        d = min(math.hypot(c - ec, r - er) for ec, er in existing)
        if d >= min_dist:
            best = (c, r)
            break
        if d > best_min_d:
            best_min_d = d
            best = (c, r)
    return best or (1, 0)


class PlayerManager:
    def __init__(self, game_state):
        self.gs = game_state

    # ── Player lifecycle ───────────────────────────────────────────────────────

    def add_player(self, pid: str):
        # Spawn near center with slight random offset
        sx, sy = tile_pos(10, 10)
        sx += random.randint(-48, 48)
        sy += random.randint(-48, 48)
        self.gs.players[pid] = {
            "id": pid,
            "x": sx, "y": sy,
            "vx": 0, "vy": 0,
            "facing": "down",
            "anim": "idle",
            "punching": False,
            "hp": 20, "maxHp": 20,
            "ki": 20, "maxKi": 20,
            "inf_ki": False,
            "blastLevel": 0,
            "kiSkillLevel": 1,
            "kiSkillXp": 0,
            "barrier_proc_until": 0.0,
            "barrier_proc_facing": "down",
            "str": 1, "def": 1,
            "level": 1, "xp": 0,
            "logs": 0,
            "stones": 0,
            "crystals": 0,
            "copper": 0,
            "ki_blast_bonuses": {
                "blast_speed": 0,
                "blast_range": 0,
                "blast_dmg": 0,
                "blast_cooldown": 0,
                "barrier_duration": 0,
                "barrier_cooldown": 0,
            },
            "ki_moves": list(DEFAULT_KI_MOVES),
            "active_blast_id": None,
            "learned_blasts": [],
            "last_blast_observe_at": 0.0,
            "dead": False,
            "knocked_out": False,
            "knocked_until": None,
            "respawn_at": None,
            "last_hit_by_player": {},  # attacker_pid -> timestamp
            "npcs": {},  # npc_id -> { hp, maxHp, str, def, x, y, owner }
            "npc_ids": [],  # persistent list of owned NPC IDs
            "chatColor": "#cccccc",
            "map": f"home_{pid}",
            "equipment": {},   # slot -> item_id
            "inventory": {},   # item_id -> quantity (data-driven items)
            "combat_mode": "kill",  # "kill" or "ko" — determines NPC defeat behavior
        }
        self._ensure_default_ki_moves(self.gs.players[pid])

        # Assign central map portal for new player
        portal_col, portal_row = _assign_central_portal(pid)
        self.gs.players[pid]["central_portal_col"] = portal_col
        self.gs.players[pid]["central_portal_row"] = portal_row
        register_player_portal(pid, portal_col, portal_row, spawn_col=25, spawn_row=25)

        # Initialize home instance
        self.gs.instances.init_home(f"home_{pid}")

        return self.gs.players[pid]

    def remove_player(self, pid: str):
        self.gs.players.pop(pid, None)

    # ── Ki moves ───────────────────────────────────────────────────────────────

    def _ensure_default_ki_moves(self, actor):
        if not actor:
            return
        moves = actor.get("ki_moves")
        if not isinstance(moves, list):
            moves = []
        for move_id in DEFAULT_KI_MOVES:
            if move_id not in moves:
                moves.append(move_id)
        actor["ki_moves"] = moves

    # ── Admin panel ────────────────────────────────────────────────────────────

    def _handle_admin(self, p, data):
        field = data.get("field")
        value = data.get("value", 0)
        target_npc_id = data.get("target_npc_id")
        actor = p.get("npcs", {}).get(target_npc_id) if target_npc_id else p
        if actor is None:
            actor = p
        if field == "logs":
            actor["logs"] = actor.get("logs", 0) + int(value)
        elif field == "stones":
            actor["stones"] = actor.get("stones", 0) + int(value)
        elif field == "crystals":
            actor["crystals"] = max(0, int(actor.get("crystals", 0) or 0) + int(value))
        elif field == "copper":
            actor["copper"] = actor.get("copper", 0) + int(value)
        elif field == "seeds":
            actor["seeds"] = actor.get("seeds", 0) + int(value)
        elif field == "meat":
            actor["meat"] = actor.get("meat", 0) + int(value)
        elif field == "vegetables":
            actor["vegetables"] = actor.get("vegetables", 0) + int(value)
        elif field == "full_hp":
            actor["hp"] = actor.get("maxHp", actor.get("hp", 1))
        elif field == "_dmg10":
            actor["hp"] = max(0, actor.get("hp", 1) - 10)
        elif field == "maxHp":
            actor["maxHp"] = actor.get("maxHp", 20) + int(value)
            actor["hp"] = actor["maxHp"]
        elif field == "str":
            actor["str"] = actor.get("str", 1) + int(value)
        elif field == "def":
            actor["def"] = actor.get("def", 1) + int(value)
        elif field == "full_ki":
            actor["ki"] = actor.get("maxKi", KI_MAX_BASE)
        elif field == "inf_ki":
            actor["inf_ki"] = not bool(actor.get("inf_ki", False))
            if actor["inf_ki"]:
                actor["ki"] = actor.get("maxKi", KI_MAX_BASE)
        elif field == "maxKi":
            actor["maxKi"] = actor.get("maxKi", KI_MAX_BASE) + int(value)
            actor["ki"] = actor["maxKi"]
        elif field == "ki_level":
            actor["kiSkillLevel"] = max(1, int(actor.get("kiSkillLevel", 1))) + int(value)
            actor["kiSkillXp"] = 0
        elif field == "ki_move_toggle":
            move_id = data.get("move_id")
            if move_id:
                moves = actor.get("ki_moves", [])
                if move_id in moves:
                    moves.remove(move_id)
                else:
                    moves.append(move_id)
                actor["ki_moves"] = moves
        elif field == "has_ki_blast_toggle":
            actor["has_ki_blast"] = not actor.get("has_ki_blast", False)
        elif field == "feathers":
            actor["feathers"] = actor.get("feathers", 0) + int(value)
        elif field == "blastLevel":
            actor["blastLevel"] = max(0, actor.get("blastLevel", 0) + int(value))
        elif field == "tp_map":
            target_map = str(data.get("target_map", "level_01"))
            actor["map"] = target_map
            actor["x"] = 480
            actor["y"] = 480
        elif field == "xp_multiplier_set":
            scope = str(data.get("scope", "") or "")
            if scope in self.gs.xp_multipliers:
                try:
                    new_value = float(data.get("multiplier", value))
                except (TypeError, ValueError):
                    new_value = self.gs.xp_multipliers[scope]
                self.gs.xp_multipliers[scope] = max(0.0, min(100.0, round(new_value, 2)))
        elif field.startswith("inv:"):
            # Inventory items: field = "inv:raw_copper", etc.
            item_id = field[4:]
            inv = actor.setdefault("inventory", {})
            inv[item_id] = max(0, inv.get(item_id, 0) + int(value))
            if inv[item_id] <= 0:
                inv.pop(item_id, None)

    # ── XP / Level ─────────────────────────────────────────────────────────────

    def _grant_xp(self, entity, amount):
        xp = self._scale_xp_gain(entity, amount)
        if xp <= 0 or not entity:
            return False
        entity["xp"] = int(entity.get("xp", 0)) + xp
        leveled = False
        while entity["xp"] >= max(1, int(entity.get("level", 1))) * 20:
            needed = max(1, int(entity.get("level", 1))) * 20
            entity["xp"] -= needed
            entity["level"] = int(entity.get("level", 1)) + 1
            entity["maxHp"] = int(entity.get("maxHp", 1)) + 2
            entity["hp"] = entity["maxHp"]
            entity["str"] = int(entity.get("str", 1)) + 1
            entity["def"] = int(entity.get("def", 1)) + 1
            leveled = True
        if leveled:
            self._ensure_level_based_ki(entity, refill=True)
        return leveled

    def _level_based_max_ki(self, level):
        lvl = max(1, int(level or 1))
        return KI_MAX_BASE + max(0, lvl - 1) * KI_MAX_PER_LEVEL

    def _ensure_level_based_ki(self, entity, refill=False):
        if not entity:
            return
        current_max = int(entity.get("maxKi", KI_MAX_BASE))
        target_max = max(current_max, self._level_based_max_ki(entity.get("level", 1)))
        current_ki = int(entity.get("ki", target_max))
        if target_max > current_max:
            entity["maxKi"] = target_max
            entity["ki"] = target_max if refill else min(target_max, current_ki + (target_max - current_max))
            return
        entity["ki"] = min(current_ki, current_max)

    def _grant_ki_skill_xp(self, entity, amount):
        xp = self._scale_xp_gain(entity, amount)
        if xp <= 0 or not entity:
            return False
        entity["kiSkillXp"] = int(entity.get("kiSkillXp", 0)) + xp
        entity["kiSkillLevel"] = max(1, int(entity.get("kiSkillLevel", 1)))
        leveled = False
        while entity["kiSkillXp"] >= max(1, int(entity.get("kiSkillLevel", 1))) * 20:
            needed = max(1, int(entity.get("kiSkillLevel", 1))) * 20
            entity["kiSkillXp"] -= needed
            entity["kiSkillLevel"] = int(entity.get("kiSkillLevel", 1)) + 1
            leveled = True
        return leveled

    def _xp_scope_for_entity(self, entity):
        if not entity:
            return "player"
        owner_id = entity.get("owner")
        if owner_id:
            return "ai_npc" if owner_id == AI_RIVAL_PID else "npc"
        return "ai_player" if entity.get("id") == AI_RIVAL_PID else "player"

    def _scale_xp_gain(self, entity, amount):
        base = max(0.0, float(amount or 0))
        if base <= 0 or not entity:
            return 0
        scope = self._xp_scope_for_entity(entity)
        mult = float(self.gs.xp_multipliers.get(scope, 1.0) or 0.0)
        return max(0, int(round(base * max(0.0, mult))))

    # ── AI alert queue ─────────────────────────────────────────────────────────

    def _queue_ai_alert(self, pid, message, speech=None, source_pid=None, action=None):
        player = self.gs.players.get(pid)
        if not player:
            return
        alerts = player.setdefault("_ai_alerts", [])
        alerts.append({
            "message": str(message or "")[:200],
            "speech": str(speech or "")[:120] if speech else None,
            "source_pid": str(source_pid or "")[:64] if source_pid else None,
            "action": str(action or "")[:64] if action else None,
        })
        if len(alerts) > 20:
            del alerts[:-20]

    # ── Carry system ───────────────────────────────────────────────────────────

    def _try_carry_player(self, pid, target_id):
        """Player picks up a knocked-out player."""
        p = self.gs.players.get(pid)
        if not p or p.get("dead") or p.get("knocked_out"):
            return
        if p.get("_carrying"):
            return
        target = self.gs.players.get(target_id)
        if not target or not target.get("knocked_out"):
            return
        if dist(p["x"], p["y"], target["x"], target["y"]) > TILE_SIZE * 2:
            return
        p["_carrying"] = {"type": "player", "target_id": target_id}
        target["carried_by"] = pid

    def _drop_carried(self, pid):
        """Drop whatever the player is carrying."""
        p = self.gs.players.get(pid)
        if not p:
            return
        carrying = p.pop("_carrying", None)
        if not carrying:
            return
        if carrying["type"] == "npc":
            owner = self.gs.players.get(carrying["owner_id"])
            if owner:
                npc = owner.get("npcs", {}).get(carrying["npc_id"])
                if npc:
                    npc.pop("carried_by", None)
        elif carrying["type"] == "player":
            target = self.gs.players.get(carrying["target_id"])
            if target:
                target.pop("carried_by", None)

    # ── Crafting ───────────────────────────────────────────────────────────────

    def _try_craft_equipment(self, pid, eq_id):
        """Attempt to craft and equip a piece of equipment at an anvil."""
        p = self.gs.players.get(pid)
        if not p or not eq_id:
            return
        eq_def = asset_registry.get_equipment(eq_id)
        if not eq_def:
            return
        # Must be near an anvil
        near_anvil = False
        for anvil in self.gs.anvils.values():
            if anvil.get("dead"):
                continue
            if dist(p["x"], p["y"], anvil["x"], anvil["y"]) <= TILE_SIZE * 2:
                near_anvil = True
                break
        if not near_anvil:
            self.gs.fx_events.append({"type": "chat_hint", "pid": pid,
                                      "text": "Must be near an anvil to craft."})
            return
        # Level check
        if p.get("level", 1) < eq_def.recipe.required_level:
            self.gs.fx_events.append({"type": "chat_hint", "pid": pid,
                                      "text": f"Need level {eq_def.recipe.required_level} to craft {eq_def.label}."})
            return
        # Ingredient check — resources may be top-level (logs, stones) or in inventory
        top_level = {"logs", "stones", "crystals", "copper", "meat", "feathers", "vegetables", "seeds"}
        for resource, needed in eq_def.recipe.ingredients.items():
            if resource in top_level:
                have = p.get(resource, 0)
            else:
                have = p.get("inventory", {}).get(resource, 0)
            if have < needed:
                self.gs.fx_events.append({"type": "chat_hint", "pid": pid,
                                          "text": f"Not enough {resource} (need {needed}, have {have})."})
                return
        # Deduct ingredients
        for resource, needed in eq_def.recipe.ingredients.items():
            if resource in top_level:
                p[resource] = p.get(resource, 0) - needed
            else:
                inv = p.setdefault("inventory", {})
                inv[resource] = inv.get(resource, 0) - needed
        # Add to inventory (not auto-equip)
        inv = p.setdefault("inventory", {})
        inv[eq_id] = inv.get(eq_id, 0) + 1
        self.gs.fx_events.append({"type": "chat_hint", "pid": pid,
                                  "text": f"Crafted {eq_def.label}! (added to inventory)"})

    # ── Equipment inventory ────────────────────────────────────────────────────

    def _try_equip_item(self, pid, eq_id):
        """Equip an equipment item from player inventory."""
        p = self.gs.players.get(pid)
        if not p or not eq_id or p.get("dead"):
            return
        eq_def = asset_registry.get_equipment(eq_id)
        if not eq_def:
            return
        inv = p.get("inventory", {})
        if inv.get(eq_id, 0) < 1:
            return
        # If something is already in that slot, swap it back to inventory
        old_eq = p["equipment"].get(eq_def.slot)
        if old_eq:
            # Remove old equipment stat bonuses
            old_def = asset_registry.get_equipment(old_eq)
            if old_def and old_def.stats.hp_bonus > 0:
                p["maxHp"] = max(1, p.get("maxHp", 20) - old_def.stats.hp_bonus)
                p["hp"] = min(p["hp"], p["maxHp"])
            inv[old_eq] = inv.get(old_eq, 0) + 1
        # Equip new item
        inv[eq_id] = inv.get(eq_id, 0) - 1
        if inv[eq_id] <= 0:
            del inv[eq_id]
        p["equipment"][eq_def.slot] = eq_id
        # Apply hp_bonus
        if eq_def.stats.hp_bonus > 0:
            p["maxHp"] = p.get("maxHp", 20) + eq_def.stats.hp_bonus
            p["hp"] = min(p["hp"] + eq_def.stats.hp_bonus, p["maxHp"])
        self.gs.fx_events.append({"type": "chat_hint", "pid": pid,
                                  "text": f"Equipped {eq_def.label}."})

    def _try_unequip_item(self, pid, slot):
        """Unequip an item from a slot back to inventory."""
        p = self.gs.players.get(pid)
        if not p or not slot or p.get("dead"):
            return
        eq_id = p["equipment"].get(slot)
        if not eq_id:
            return
        eq_def = asset_registry.get_equipment(eq_id)
        # Remove stat bonuses
        if eq_def and eq_def.stats.hp_bonus > 0:
            p["maxHp"] = max(1, p.get("maxHp", 20) - eq_def.stats.hp_bonus)
            p["hp"] = min(p["hp"], p["maxHp"])
        del p["equipment"][slot]
        inv = p.setdefault("inventory", {})
        inv[eq_id] = inv.get(eq_id, 0) + 1
        label = eq_def.label if eq_def else eq_id
        self.gs.fx_events.append({"type": "chat_hint", "pid": pid,
                                  "text": f"Unequipped {label}."})

    def _try_drop_equipment(self, pid, eq_id):
        """Drop an equipment item from inventory onto the ground."""
        p = self.gs.players.get(pid)
        if not p or not eq_id or p.get("dead"):
            return
        inv = p.get("inventory", {})
        if inv.get(eq_id, 0) < 1:
            return
        inv[eq_id] = inv.get(eq_id, 0) - 1
        if inv[eq_id] <= 0:
            del inv[eq_id]
        col = int(p["x"] // TILE_SIZE)
        row = int(p["y"] // TILE_SIZE)
        tx, ty = tile_pos(col, row)
        item_id = _gen_item_id()
        self.gs.ground_items.append({
            "id": item_id,
            "x": tx, "y": ty,
            "resource": eq_id,
            "amount": 1,
            "_placed": True,
            "_equipment": True,
            "map": p.get("map", "level_01"),
        })
        eq_def = asset_registry.get_equipment(eq_id)
        label = eq_def.label if eq_def else eq_id
        self.gs.fx_events.append({"type": "chat_hint", "pid": pid,
                                  "text": f"Dropped {label}."})

    # handle_input has been moved to InputHandler (services/input_handler.py)

