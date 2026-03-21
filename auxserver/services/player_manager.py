"""Player management: init, stats, inventory, crafting, death/respawn.

Also contains handle_input(), the server-side message router for all
client actions. This is a temporary home; see handle_input docstring.
"""

import math
import random
import time

from services.asset_registry import asset_registry
from services.world_data import TILE_SIZE
from core.constants import PLAYER_SPEED, PLAYER_RUN_SPEED, KI_MAX_BASE, KI_MAX_PER_LEVEL
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
            "dead": False,
            "knocked_out": False,
            "knocked_until": None,
            "respawn_at": None,
            "last_hit_by_player": {},  # attacker_pid -> timestamp
            "npcs": {},  # npc_id -> { hp, maxHp, str, def, x, y, owner }
            "npc_ids": [],  # persistent list of owned NPC IDs
            "chatColor": "#cccccc",
            "map": "level_01",
            "equipment": {},   # slot -> item_id
            "inventory": {},   # item_id -> quantity (data-driven items)
            "combat_mode": "kill",  # "kill" or "ko" — determines NPC defeat behavior
        }
        self._ensure_default_ki_moves(self.gs.players[pid])
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
        elif field == "feathers":
            actor["feathers"] = actor.get("feathers", 0) + int(value)
        elif field == "blastLevel":
            actor["blastLevel"] = max(0, actor.get("blastLevel", 0) + int(value))
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

    # ── Input dispatch (moved from GameState) ────────────────────────────────

    def handle_input(self, pid: str, data: dict):
        """
        Full server-side message router — dispatches all client actions to the
        appropriate service (combat, resources, building, npc_manager, portals,
        player). Lives in PlayerManager for historical reasons; a future refactor
        may extract this to a dedicated InputDispatcher.
        """
        gs = self.gs
        p = gs.players.get(pid)
        if not p:
            return

        msg_type = data.get("type")

        # Block most actions while dead or knocked out.
        if (p.get("dead") or p.get("knocked_out")) and msg_type not in ("sync_npcs", "admin"):
            return

        if msg_type == "stop":
            p["vx"] = 0
            p["vy"] = 0
            p["anim"] = "idle"

        elif msg_type == "move":
            dx = data.get("dx", 0)
            dy = data.get("dy", 0)
            running = data.get("running", False)
            speed = PLAYER_RUN_SPEED if running else PLAYER_SPEED

            # Normalize diagonal
            if dx != 0 and dy != 0:
                dx /= math.sqrt(2)
                dy /= math.sqrt(2)

            p["vx"] = dx * speed
            p["vy"] = dy * speed

            # Update facing
            if dx < 0:
                p["facing"] = "left"
            elif dx > 0:
                p["facing"] = "right"
            elif dy < 0:
                p["facing"] = "up"
            elif dy > 0:
                p["facing"] = "down"

            moving = dx != 0 or dy != 0
            if moving:
                p["anim"] = "run" if running else "walk"
            else:
                p["anim"] = "idle"

        elif msg_type == "chop":
            gs.resources._try_chop(pid, data.get("tree_id"))

        elif msg_type == "mine_rock":
            gs.resources._try_mine_rock(pid, data.get("rock_id"))

        elif msg_type == "mine_tile":
            col = data.get("col")
            row = data.get("row")
            if col is not None and row is not None:
                gs.resources._try_mine_tile(pid, int(col), int(row))

        elif msg_type == "request_mine_tiles":
            tiles = gs.resources.get_mine_tiles_for_player(pid)
            if tiles is not None:
                gs.fx_events.append({
                    "type": "mine_update", "pid": pid,
                    "tiles": tiles,
                })

        elif msg_type == "attack_dummy":
            gs.combat._try_attack_dummy(pid, data.get("dummy_id"))

        elif msg_type == "build_dummy":
            gs.building._try_build_dummy(pid, data.get("logs", 10))

        elif msg_type == "delete_dummy":
            dummy_id = data.get("dummy_id")
            if dummy_id and dummy_id in gs.dummies:
                gs.dummies[dummy_id]["dead"] = True

        elif msg_type == "build_anvil":
            gs.building._try_build_anvil(pid)

        elif msg_type == "delete_anvil":
            anvil_id = data.get("anvil_id")
            if anvil_id and anvil_id in gs.anvils:
                gs.anvils[anvil_id]["dead"] = True

        elif msg_type == "place_building":
            gs.building._place_building(pid, data)

        elif msg_type == "attack_fence":
            gs.combat._try_attack_fence(pid, data.get("building_id"))

        elif msg_type == "remove_building":
            bid = data.get("building_id")
            if bid and bid in gs.buildings:
                if gs.buildings[bid].get("kind") == "etrainer":
                    gs.dummies.pop(bid, None)
                del gs.buildings[bid]

        elif msg_type == "update_building_stored":
            bid = data.get("building_id")
            stored = data.get("stored")
            if bid and bid in gs.buildings and isinstance(stored, dict):
                gs.buildings[bid]["stored"] = stored

        elif msg_type == "update_building_out_dir":
            bid = data.get("building_id")
            out_dir = data.get("out_direction", "")
            if bid and bid in gs.buildings:
                gs.buildings[bid]["out_direction"] = out_dir

        elif msg_type == "update_building_label":
            bid = data.get("building_id")
            label = data.get("label", "")
            if bid and bid in gs.buildings:
                gs.buildings[bid]["label"] = str(label)[:32]

        elif msg_type == "deduct_resource":
            resource = data.get("resource", "")
            amt = max(0, int(data.get("amount", 1)))
            if resource == "logs":
                p["logs"] = max(0, p.get("logs", 0) - amt)
            elif resource in ("stones", "crystals", "copper", "meat", "feathers", "vegetables", "seeds"):
                p[resource] = max(0, p.get(resource, 0) - amt)
            else:
                inv = p.setdefault("inventory", {})
                inv[resource] = max(0, inv.get(resource, 0) - amt)
                if inv[resource] <= 0:
                    inv.pop(resource, None)

        elif msg_type == "grant_resource":
            resource = data.get("resource", "")
            amt = max(0, int(data.get("amount", 1)))
            if resource == "logs":
                p["logs"] = p.get("logs", 0) + amt
            elif resource in ("stones", "crystals", "copper", "meat", "feathers", "vegetables", "seeds"):
                p[resource] = p.get(resource, 0) + amt
            else:
                inv = p.setdefault("inventory", {})
                inv[resource] = inv.get(resource, 0) + amt

        elif msg_type == "minecart_portal":
            gs.building._handle_minecart_portal(pid, data)

        elif msg_type == "refine_rock":
            gs.resources._try_refine_rock(pid, data.get("anvil_id"), data.get("npc_id"))

        elif msg_type == "punch":
            p["punching"] = True
            p["punch_until"] = time.time() + 0.3

        elif msg_type == "npc_chop":
            owner_id = data.get("owner_id", pid)
            gs.resources._npc_chop(data.get("tree_id"), owner_id, data.get("npc_id"))

        elif msg_type == "npc_pickup_stone":
            gs.resources._npc_pickup_stone(pid, data.get("npc_id"), data.get("item_id"))
        elif msg_type == "npc_mine_rock":
            gs.resources._npc_mine_rock(pid, data.get("npc_id"), data.get("rock_id"))
        elif msg_type == "npc_pickup_stone_tile":
            gs.resources._npc_pickup_stone_tile(pid, data.get("npc_id"), data.get("x"), data.get("y"))

        elif msg_type == "npc_refine_rock":
            gs.resources._npc_refine_rock(pid, data.get("npc_id"), data.get("anvil_id"))

        elif msg_type == "npc_give_materials":
            gs.resources._npc_give_materials(pid, data.get("npc_id"))

        elif msg_type == "npc_interact_world_object":
            gs.resources._npc_interact_world_object(pid, data.get("npc_id"), data.get("wo_id"))

        elif msg_type == "npc_deposit_to_crate":
            gs.resources._npc_deposit_to_crate(
                pid, data.get("npc_id"), data.get("building_id"),
                data.get("resource"), data.get("amount", 1))

        elif msg_type == "admin":
            self._handle_admin(p, data)

        elif msg_type == "npc_attack_dummy":
            npc_id = data.get("npc_id", "npc")
            gs.combat._npc_attack_dummy(pid, npc_id, data.get("dummy_id"), data.get("str", 1))

        elif msg_type == "attack_player":
            gs.combat._try_attack_player(pid, data.get("target_id"))

        elif msg_type == "attack_npc":
            gs.combat._try_attack_npc(pid, data.get("owner_id"), data.get("npc_id"))

        elif msg_type == "ki_blast_miss":
            cost, _dmg = gs.combat._calc_blast(p.get("blastLevel", 0))
            cost, _dmg = gs.combat._apply_blast_mode(cost, _dmg, data.get("blast_mode", ""))
            if gs.combat._try_ki_spend(p, cost):
                gs.combat._queue_ki_blast_fx(p)

        elif msg_type == "ki_blast_player":
            gs.combat._ki_blast_player(pid, data.get("target_id"), data.get("blast_mode", ""))

        elif msg_type == "ki_blast_npc":
            gs.combat._ki_blast_npc(pid, data.get("owner_id"), data.get("npc_id"), data.get("blast_mode", ""))
        elif msg_type == "ki_blast_dummy":
            gs.combat._ki_blast_dummy(pid, data.get("dummy_id"), data.get("blast_mode", ""))

        elif msg_type == "ki_blast_ground_item":
            gs.combat._ki_blast_ground_item(pid, data.get("item_id"), data.get("blast_mode", ""))

        elif msg_type == "absorb_npc":
            gs.combat._start_player_absorb(pid, data.get("owner_id"), data.get("npc_id"))

        elif msg_type == "npc_ki_blast_player":
            gs.combat._npc_ki_blast_player(pid, data.get("npc_id"), data.get("target_id"))

        elif msg_type == "npc_ki_blast_npc":
            gs.combat._npc_ki_blast_npc(pid, data.get("npc_id"), data.get("owner_id"), data.get("target_npc_id"))

        elif msg_type == "npc_ki_blast_ki_target":
            gs.combat._npc_ki_blast_ki_target(pid, data.get("npc_id"), data.get("target_id"))

        elif msg_type == "npc_absorb_npc":
            gs.combat._start_npc_absorb(pid, data.get("npc_id"), data.get("target_owner"), data.get("target_npc_id"))

        elif msg_type == "npc_attack_player":
            npc_id = data.get("npc_id", "npc")
            gs.combat._npc_attack_player(pid, data.get("target_id"), data.get("str", 1), npc_id)

        elif msg_type == "npc_attack_npc":
            npc_id = data.get("npc_id", "npc")
            gs.combat._npc_attack_npc(pid, npc_id, data.get("target_owner"), data.get("target_npc_id"), data.get("str", 1))

        elif msg_type == "npc_steal_logs":
            npc_id = data.get("npc_id", "npc")
            gs.combat._npc_steal_logs(pid, npc_id, data.get("target_owner"), data.get("target_npc_id"), data.get("str", 1), data.get("amount", 1))

        elif msg_type == "attack_animal":
            gs.combat._try_attack_animal(pid, data.get("animal_id"))

        elif msg_type == "harvest_crop":
            gs.resources._try_harvest_crop(pid, data.get("crop_id"))

        elif msg_type == "plant_seed":
            gs.resources._try_plant_seed(pid, data.get("x"), data.get("y"))

        elif msg_type == "drop_item":
            gs.resources._try_drop_item(pid, data)

        elif msg_type == "pickup_placed":
            gs.resources._try_pickup_placed(pid, data.get("item_id"))

        elif msg_type == "reset_blast_level":
            p["blastLevel"] = 0

        elif msg_type == "set_combat_mode":
            mode = data.get("mode", "kill")
            if mode in ("kill", "ko"):
                p["combat_mode"] = mode

        elif msg_type == "build_ki_target":
            gs.building._try_build_ki_target(pid, data.get("x"), data.get("y"))

        elif msg_type == "delete_ki_target":
            target_id = data.get("target_id")
            if target_id:
                gs.ground_items = [
                    item for item in gs.ground_items
                    if not (item.get("id") == target_id and item.get("resource") == "KiTarget")
                ]

        elif msg_type == "ki_blast_ki_target":
            gs.combat._ki_blast_ki_target(pid, data.get("target_id"), data.get("npc_id"))

        elif msg_type == "activate_barrier":
            gs.combat._activate_barrier(pid, data.get("npc_id"))

        elif msg_type == "chat":
            text = data.get("text", "")
            if text:
                gs.fx_events.append({
                    "type": "chat",
                    "pid": pid,
                    "text": text[:200],
                    "color": p.get("chatColor", "#cccccc"),
                })
                if "@__ai_rival__" in text:
                    from services.ai_player import ai_player
                    ai_player.receive_message(pid, text.replace("@__ai_rival__", "").strip())

        elif msg_type == "consume_crystal":
            gs.combat._consume_crystal(pid, data.get("npc_id"))

        elif msg_type == "build_npc":
            gs.npc_manager._try_build_npc(pid, data.get("name"))

        elif msg_type == "interact_world_object":
            gs.resources._try_interact_world_object(pid, data.get("wo_id"))

        elif msg_type == "craft_equipment":
            self._try_craft_equipment(pid, data.get("equipment_id"))

        elif msg_type == "equip_item":
            self._try_equip_item(pid, data.get("equipment_id"))
        elif msg_type == "unequip_item":
            self._try_unequip_item(pid, data.get("slot"))
        elif msg_type == "drop_equipment":
            self._try_drop_equipment(pid, data.get("equipment_id"))
        elif msg_type == "npc_pickup_equipment":
            gs.npc_manager._try_npc_pickup_equipment(pid, data.get("npc_id"), data.get("item_id"))

        elif msg_type == "give_npc_equipment":
            gs.npc_manager._try_give_npc_equipment(pid, data.get("npc_id"), data.get("equipment_id"))
        elif msg_type == "take_npc_equipment":
            gs.npc_manager._try_take_npc_equipment(pid, data.get("npc_id"), data.get("slot"))

        elif msg_type == "carry_npc":
            gs.npc_manager._try_carry_npc(pid, data.get("owner_id"), data.get("npc_id"))
        elif msg_type == "carry_own_npc":
            gs.npc_manager._try_carry_npc(pid, pid, data.get("npc_id"))
        elif msg_type == "carry_player":
            self._try_carry_player(pid, data.get("target_id"))
        elif msg_type == "drop_carried":
            self._drop_carried(pid)

        elif msg_type == "sync_npcs":
            gs.npc_manager._sync_player_npcs(pid, data.get("npcs", {}))

        elif msg_type == "register_background_npc":
            npc_id = data.get("npc_id")
            npc_map = data.get("map", "level_01")
            task = data.get("task", {})
            if npc_id and task:
                gs.background_npcs[npc_id] = {
                    "pid": pid,
                    "npc_id": npc_id,
                    "map": npc_map,
                    "task": task,
                    "last_tick": time.time(),
                }
                print(f"[bg] Registered background NPC {npc_id} on {npc_map}: {task.get('task', '?')}")

        elif msg_type == "unregister_background_npcs":
            target_map = data.get("map", "")
            removed = []
            for npc_id, bg in list(gs.background_npcs.items()):
                if bg["pid"] == pid and bg["map"] == target_map:
                    removed.append(npc_id)
                    del gs.background_npcs[npc_id]
            if removed:
                print(f"[bg] Unregistered background NPCs on {target_map}: {removed}")
