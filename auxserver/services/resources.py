"""Resource gathering: trees, rocks, ores, ground items, farming, cave mining."""

import logging
import random
import time

logger = logging.getLogger(__name__)

from services.game_state import (
    TILE_SIZE,
    TREE_REGROW_MIN,
    TREE_REGROW_MAX,
    ROCK_SPAWN_POSITIONS,
    ROCK_SPAWN_CHANCE,
    ROCK_HITS,
    ROCK_LIFESPAN,
    ROCK_MINE_DIST,
    WORLD_OBJECT_INSTANCES,
    WORLD_OBJ_MINE_DIST,
    REFINE_STONE_COST,
    CRYSTAL_CHANCE,
    tile_pos,
    dist,
    _gen_item_id,
)
from services.crop_service import crop_manager
from services.asset_registry import asset_registry
from services.mine_state import MineGrid


class ResourceService:
    def __init__(self, game_state):
        self.gs = game_state

    # ── Tree chopping ──────────────────────────────────────────────────────────

    def _npc_chop(self, tree_id, owner_id, npc_id=None):
        """NPC chops a tree. If npc_id given, credit logs directly to that NPC."""
        if tree_id is None:
            return
        if tree_id < 0 or tree_id >= len(self.gs.trees):
            return
        tree = self.gs.trees[tree_id]
        if tree["chopped"]:
            return
        tree["chopped"] = True
        tree["regrow_at"] = time.time() + random.uniform(TREE_REGROW_MIN, TREE_REGROW_MAX)

        # Credit logs directly to the NPC if specified (for AI-owned NPCs with no client)
        if npc_id and owner_id:
            owner = self.gs.players.get(owner_id)
            if owner:
                npc = owner.get("npcs", {}).get(npc_id)
                if npc:
                    npc["logs"] = npc.get("logs", 0) + 1
                    return
        # Fallback: drop ground item like _try_chop
        item_id = _gen_item_id()
        self.gs.ground_items.append({
            "id": item_id,
            "x": tree["x"],
            "y": tree["y"] + TILE_SIZE * 0.4,
            "resource": "Wood",
            "amount": 1,
        })

    def _try_plant_seed(self, pid, x, y):
        if x is None or y is None:
            return
        p = self.gs.players.get(pid)
        if not p:
            return
        if p.get("seeds", 0) < 1:
            return
        result = crop_manager.try_plant(float(x), float(y), pid)
        if result == "planted":
            p["seeds"] = p.get("seeds", 0) - 1
        elif result == "not_soil":
            self.gs.fx_events.append({"type": "chat_hint", "pid": pid, "text": "Can only plant on fertile soil tiles."})
        elif result == "occupied":
            self.gs.fx_events.append({"type": "chat_hint", "pid": pid, "text": "Something is already growing there."})

    def _try_harvest_crop(self, pid, crop_id):
        if not crop_id:
            return
        p = self.gs.players.get(pid)
        if not p:
            return
        result = crop_manager.try_harvest(crop_id, pid)
        if result:
            p["vegetables"] = p.get("vegetables", 0) + 1
            self.gs.fx_events.append({"type": "crop_harvested", "crop_id": crop_id, "harvester": pid})

    def _try_chop(self, pid, tree_id):
        if tree_id is None:
            return
        if tree_id < 0 or tree_id >= len(self.gs.trees):
            return
        tree = self.gs.trees[tree_id]
        if tree["chopped"]:
            return
        tree["chopped"] = True
        tree["regrow_at"] = time.time() + random.uniform(TREE_REGROW_MIN, TREE_REGROW_MAX)

        # Drop ground item
        item_id = _gen_item_id()
        self.gs.ground_items.append({
            "id": item_id,
            "x": tree["x"],
            "y": tree["y"] + TILE_SIZE * 0.4,
            "resource": "Wood",
            "amount": 1,
        })

    # ── Rock spawning & mining ──────────────────────────────────────────────

    def _spawn_rocks(self):
        """Roll for rock spawns on bare ground tiles. Called every ROCK_SPAWN_INTERVAL."""
        now = time.time()
        for col, row in ROCK_SPAWN_POSITIONS:
            x, y = tile_pos(col, row)
            already = any(r for r in self.gs.rocks if r["col"] == col and r["row"] == row and not r["mined"])
            if already:
                continue
            if random.random() < ROCK_SPAWN_CHANCE:
                rock_id = self.gs._next_rock_id
                self.gs._next_rock_id += 1
                self.gs.rocks.append({
                    "id": rock_id,
                    "col": col, "row": row,
                    "x": x, "y": y,
                    "hits_left": ROCK_HITS,
                    "mined": False,
                    "spawned_at": now,
                    "despawn_at": now + ROCK_LIFESPAN,
                })
        self.gs._last_rock_spawn = now

    def _try_mine_rock(self, pid, rock_id):
        p = self.gs.players.get(pid)
        if not p or rock_id is None:
            return
        rock = None
        for r in self.gs.rocks:
            if r["id"] == rock_id and not r["mined"]:
                rock = r
                break
        if not rock:
            return

        d = dist(p["x"], p["y"], rock["x"], rock["y"])
        if d > ROCK_MINE_DIST:
            return

        rock["hits_left"] -= 1
        p["stones"] = p.get("stones", 0) + 1
        if rock["hits_left"] <= 0:
            rock["mined"] = True

    # ── World Objects ─────────────────────────────────────────────────────────

    def _try_interact_world_object(self, pid, wo_id):
        """Player interacts with (mines) a world object."""
        p = self.gs.players.get(pid)
        if not p or not wo_id:
            return
        wo = WORLD_OBJECT_INSTANCES.get(wo_id)
        if not wo or wo["depleted"]:
            return
        # Must be on same map
        if wo["map"] != p.get("map", "level_01"):
            return
        # Distance check
        d = dist(p["x"], p["y"], wo["x"], wo["y"])
        if d > WORLD_OBJ_MINE_DIST:
            return
        # Level check
        wo_def = asset_registry.get_world_object(wo["asset_id"])
        if not wo_def:
            return
        if p.get("level", 1) < wo_def.required_level:
            self.gs.fx_events.append({"type": "chat_hint", "pid": pid,
                                      "text": f"Need level {wo_def.required_level} to interact."})
            return
        # Decrement HP
        wo["hp"] -= 1
        # Award drops on each hit
        inv = p.setdefault("inventory", {})
        for drop in wo_def.drops:
            amount = random.randint(drop.min, drop.max)
            inv[drop.resource] = inv.get(drop.resource, 0) + amount
        # Depleted?
        if wo["hp"] <= 0:
            wo["depleted"] = True
            respawn_secs = random.uniform(wo_def.respawn_min, wo_def.respawn_max)
            wo["respawn_at"] = time.time() + respawn_secs

    def _npc_interact_world_object(self, pid, npc_id, wo_id):
        """NPC mines a world object — drops go into NPC's inventory dict."""
        p = self.gs.players.get(pid)
        if not p or not npc_id or not wo_id:
            return
        npc_state = p.get("npcs", {}).get(npc_id)
        if not npc_state or npc_state.get("dead") or npc_state.get("knocked_out"):
            return
        wo = WORLD_OBJECT_INSTANCES.get(wo_id)
        if not wo or wo["depleted"]:
            return
        if wo["map"] != npc_state.get("map", p.get("map", "level_01")):
            return
        d = dist(npc_state["x"], npc_state["y"], wo["x"], wo["y"])
        if d > WORLD_OBJ_MINE_DIST:
            return
        wo_def = asset_registry.get_world_object(wo["asset_id"])
        if not wo_def:
            return
        wo["hp"] -= 1
        npc_inv = npc_state.setdefault("inventory", {})
        for drop in wo_def.drops:
            amount = random.randint(drop.min, drop.max)
            res = str(drop.resource or "").lower()
            if res in ("stone", "stones"):
                npc_state["stones"] = int(npc_state.get("stones", 0) or 0) + amount
            elif res in ("crystal", "crystals"):
                npc_state["crystals"] = int(npc_state.get("crystals", 0) or 0) + amount
            else:
                npc_inv[drop.resource] = npc_inv.get(drop.resource, 0) + amount
        if wo["hp"] <= 0:
            wo["depleted"] = True
            respawn_secs = random.uniform(wo_def.respawn_min, wo_def.respawn_max)
            wo["respawn_at"] = time.time() + respawn_secs
        logger.debug("NPC %s mined world object %s, inv=%s", npc_id, wo_id, npc_inv)

    # ── Cave Mining ───────────────────────────────────────────────────────

    def _get_or_create_mine(self, pid: str) -> MineGrid:
        """Get existing mine grid for player, or create + initialize one."""
        if pid in self.gs.mine_grids:
            return self.gs.mine_grids[pid]
        # Try loading from DB
        from services.database import load_mine_state, save_mine_state
        saved = load_mine_state(pid)
        if saved:
            mg = MineGrid.from_json(pid, saved)
        else:
            mg = MineGrid(pid)
            mg.initialize()
            save_mine_state(pid, mg.to_json())
        self.gs.mine_grids[pid] = mg
        return mg

    def _try_mine_tile(self, pid: str, col: int, row: int):
        """Player attempts to mine a wall tile in the cave."""
        p = self.gs.players.get(pid)
        if not p:
            return
        # Must be on cave_01
        if p.get("map", "level_01") != "cave_01":
            return

        mg = self._get_or_create_mine(pid)

        # Check tile is mineable
        if not mg.is_tile_mineable(col, row):
            return

        # Check adjacency (player must be within ~1.5 tiles)
        px_col = int(p["x"] // TILE_SIZE)
        px_row = int(p["y"] // TILE_SIZE)
        if abs(px_col - col) > 1 or abs(px_row - row) > 1:
            return

        # Check pickaxe and hardwall permission
        tile = mg.grid.get((col, row))
        if not tile:
            return

        # Get equipped pickaxe stats
        equipment = p.get("equipment", {})
        tool = equipment.get("tool")
        can_hardwall = False
        if tool:
            # Look up equipment definition for mining stats
            eq_def = asset_registry.get_equipment(tool) if hasattr(asset_registry, 'get_equipment') else None
            if eq_def and hasattr(eq_def, 'stats'):
                can_hardwall = getattr(eq_def.stats, 'can_mine_hardwall', False)
        else:
            # Default bronze pickaxe (everyone starts with one)
            can_hardwall = False

        if tile["type"] == "hardwall" and not can_hardwall:
            self.gs.fx_events.append({
                "type": "chat_hint", "pid": pid,
                "text": "This rock is too dense for your pickaxe."
            })
            return

        # Mine it!
        drop = mg.mine_tile(col, row, can_mine_hardwall=can_hardwall)
        if not drop:
            return

        # Award resources to player inventory
        ore_type = drop.get("ore_type")
        ore_amount = drop.get("ore_amount", 0)
        if ore_type and ore_amount > 0:
            inv = p.setdefault("inventory", {})
            if ore_type == "stone":
                p["stones"] = p.get("stones", 0) + ore_amount
            else:
                inv[ore_type] = inv.get(ore_type, 0) + ore_amount

            self.gs.fx_events.append({
                "type": "chat_hint", "pid": pid,
                "text": f"+{ore_amount} {ore_type.replace('_', ' ')}"
            })

        # Send updated mine tiles to player
        self.gs.fx_events.append({
            "type": "mine_update", "pid": pid,
            "tiles": mg.get_known_tiles(),
        })

    def get_mine_tiles_for_player(self, pid: str):
        """Get mine tile data for a player on cave_01. Returns None if not in cave."""
        p = self.gs.players.get(pid)
        if not p or p.get("map", "level_01") != "cave_01":
            return None
        mg = self._get_or_create_mine(pid)
        return mg.get_known_tiles()

    def _npc_deposit_to_crate(self, pid, npc_id, building_id, resource, amount):
        """NPC deposits a resource into a crate/furnace building."""
        p = self.gs.players.get(pid)
        if not p or not npc_id or not building_id or not resource:
            return
        npc_state = p.get("npcs", {}).get(npc_id)
        if not npc_state:
            return
        building = self.gs.buildings.get(building_id)
        if not building:
            return
        # Logs and stones are top-level NPC fields, not in inventory dict
        if resource == "logs":
            have = int(npc_state.get("logs", 0) or 0)
            transfer = min(have, max(1, int(amount)))
            if transfer <= 0:
                return
            npc_state["logs"] = have - transfer
        elif resource == "stones":
            have = int(npc_state.get("stones", 0) or 0)
            transfer = min(have, max(1, int(amount)))
            if transfer <= 0:
                return
            npc_state["stones"] = have - transfer
        else:
            npc_inv = npc_state.get("inventory", {})
            have = npc_inv.get(resource, 0)
            transfer = min(have, max(1, int(amount)))
            if transfer <= 0:
                return
            npc_inv[resource] = have - transfer
            if npc_inv[resource] <= 0:
                npc_inv.pop(resource, None)
        stored = building.setdefault("stored", {})
        stored[resource] = stored.get(resource, 0) + transfer
        logger.debug("NPC %s deposited %dx %s into %s", npc_id, transfer, resource, building_id)

    # ── Anvil / Refining ───────────────────────────────────────────────────────

    def _try_refine_rock(self, pid, anvil_id, npc_id=None):
        """Refine a rock at an anvil. Consumes 1 stone, rolls for a crystal."""
        p = self.gs.players.get(pid)
        if not p or p.get("dead"):
            return

        actor = p
        if npc_id:
            npc_state = p.get("npcs", {}).get(npc_id)
            if npc_state and not npc_state.get("dead"):
                actor = npc_state
            else:
                return

        stones = actor.get("stones", 0)
        if stones < REFINE_STONE_COST:
            return

        anvil = self.gs.anvils.get(anvil_id)
        if not anvil or anvil.get("dead"):
            return
        d = dist(actor["x"], actor["y"], anvil["x"], anvil["y"])
        if d > TILE_SIZE * 1.5:
            return

        actor["stones"] = stones - REFINE_STONE_COST

        results = []
        if random.random() < CRYSTAL_CHANCE:
            actor["crystals"] = int(actor.get("crystals", 0) or 0) + 1
            results.append("Crystal")

        who = npc_id or pid
        p["_refine_result"] = {
            "who": who,
            "results": results,
        }
        logger.debug("%s refined rock at %s: %s", who, anvil_id, results or 'nothing')

    def _npc_refine_rock(self, pid, npc_id, anvil_id):
        """NPC refines 1 stone at an anvil."""
        self._try_refine_rock(pid, anvil_id, npc_id)

    # ── NPC stone pickup ───────────────────────────────────────────────────────

    def _npc_pickup_stone(self, pid, npc_id, item_id):
        """NPC picks up ALL stone from a ground item stack."""
        p = self.gs.players.get(pid)
        if not p or not npc_id or not item_id:
            return
        npc_state = p.get("npcs", {}).get(npc_id)
        if not npc_state or npc_state.get("dead"):
            return

        for item in self.gs.ground_items:
            if item["id"] == item_id and item.get("_placed") and item.get("resource") == "Stone":
                d = dist(npc_state["x"], npc_state["y"], item["x"], item["y"])
                if d > TILE_SIZE * 1.5:
                    return
                amount = item.get("amount", 1)
                npc_state["stones"] = npc_state.get("stones", 0) + amount
                self.gs.ground_items.remove(item)
                logger.debug("NPC %s picked up %d stone", npc_id, amount)
                return

    def _npc_mine_rock(self, pid, npc_id, rock_id):
        """NPC mines a rock and gains 1 stone per hit."""
        p = self.gs.players.get(pid)
        if not p or not npc_id or rock_id is None:
            return
        npc_state = p.get("npcs", {}).get(npc_id)
        if not npc_state or npc_state.get("dead") or npc_state.get("knocked_out"):
            return

        rock = None
        for r in self.gs.rocks:
            if r["id"] == rock_id and not r["mined"]:
                rock = r
                break
        if not rock:
            return

        d = dist(npc_state["x"], npc_state["y"], rock["x"], rock["y"])
        if d > ROCK_MINE_DIST:
            return

        rock["hits_left"] -= 1
        npc_state["stones"] = int(npc_state.get("stones", 0) or 0) + 1
        if rock["hits_left"] <= 0:
            rock["mined"] = True
        logger.debug("NPC %s mined rock %s, stones=%s", npc_id, rock_id, npc_state['stones'])

    def _npc_pickup_stone_tile(self, pid, npc_id, x, y):
        """NPC picks up all placed stone items from the targeted tile."""
        p = self.gs.players.get(pid)
        if not p or not npc_id or x is None or y is None:
            return
        npc_state = p.get("npcs", {}).get(npc_id)
        if not npc_state or npc_state.get("dead"):
            return

        tile = self._tile_key(float(x), float(y))
        total = 0
        remaining = []
        for item in self.gs.ground_items:
            same_tile = self._tile_key(item["x"], item["y"]) == tile
            if item.get("_placed") and item.get("resource") == "Stone" and same_tile:
                d = dist(npc_state["x"], npc_state["y"], item["x"], item["y"])
                if d <= TILE_SIZE * 1.5:
                    total += item.get("amount", 1)
                    continue
            remaining.append(item)

        if total <= 0:
            return

        npc_state["stones"] = npc_state.get("stones", 0) + total
        self.gs.ground_items = remaining
        logger.debug("NPC %s picked up %d stone from tile %s", npc_id, total, tile)

    def _npc_give_materials(self, pid, npc_id):
        """NPC transfers all refined materials to the player."""
        p = self.gs.players.get(pid)
        if not p or not npc_id:
            return
        npc_state = p.get("npcs", {}).get(npc_id)
        if not npc_state or npc_state.get("dead"):
            return

        # Transfer crystals
        amt = npc_state.get("crystals", 0)
        if amt > 0:
            p["crystals"] = int(p.get("crystals", 0) or 0) + amt
            npc_state["crystals"] = 0

        # Transfer any remaining stones too
        amt = npc_state.get("stones", 0)
        if amt > 0:
            p["stones"] = p.get("stones", 0) + amt
            npc_state["stones"] = 0

    # ── Drop / Pickup Helpers ──────────────────────────────────────────────────

    def _tile_key(self, x, y):
        """Return (col, row) grid key for a world position."""
        return (int(x // TILE_SIZE), int(y // TILE_SIZE))

    def _find_ground_item(self, item_id):
        if not item_id:
            return None
        for item in self.gs.ground_items:
            if item.get("id") == item_id:
                return item
        return None

    def _is_log_item(self, item):
        return item and item.get("resource") in ("Wood", "log")

    def _is_stone_item(self, item):
        return item and item.get("resource") == "Stone"

    def _try_drop_item(self, pid, data):
        """Drop logs or stone."""
        p = self.gs.players.get(pid)
        if not p or p.get("dead"):
            return

        item_type = data.get("item", "log")
        amount = min(int(data.get("amount", 1)), 3)

        # Stone drops
        if item_type == "stone":
            if p.get("stones", 0) < 1:
                return
            p["stones"] -= 1
            col = int(p["x"] // TILE_SIZE)
            row = int(p["y"] // TILE_SIZE)
            tx, ty = tile_pos(col, row)
            item_id = _gen_item_id()
            self.gs.ground_items.append({
                "id": item_id,
                "x": tx, "y": ty,
                "resource": "Stone",
                "amount": 1,
                "_placed": True,
            })
            return

        # Log drops
        if "x" in data and "y" in data:
            drop_x, drop_y = float(data["x"]), float(data["y"])
        else:
            if p["logs"] < 1:
                return
            drop_x, drop_y = p["x"], p["y"]

        col = int(drop_x // TILE_SIZE)
        row = int(drop_y // TILE_SIZE)
        tx, ty = tile_pos(col, row)

        if "x" not in data:
            amount = 1
            p["logs"] -= 1

        # Check if there's already a log stack on this tile
        for item in self.gs.ground_items:
            if (item["resource"] in ("Wood", "log") and
                    self._tile_key(item["x"], item["y"]) == (col, row)):
                item["amount"] = min(item["amount"] + amount, 3)
                if "x" not in data:
                    item["_placed"] = True
                return

        # No existing stack — create new
        item_id = _gen_item_id()
        self.gs.ground_items.append({
            "id": item_id,
            "x": tx,
            "y": ty,
            "resource": "Wood",
            "amount": min(amount, 3),
            "_placed": True,
        })

    def _try_pickup_placed(self, pid, item_id):
        """Player picks up 1 resource from a placed stack by clicking it."""
        p = self.gs.players.get(pid)
        if not p or p.get("dead") or not item_id:
            return

        for item in self.gs.ground_items:
            if item["id"] == item_id and item.get("_placed"):
                if item.get("lit"):
                    return
                d = dist(p["x"], p["y"], item["x"], item["y"])
                if d > TILE_SIZE * 1.5:
                    return
                # Equipment items go to inventory
                if item.get("_equipment"):
                    eq_id = item["resource"]
                    inv = p.setdefault("inventory", {})
                    inv[eq_id] = inv.get(eq_id, 0) + 1
                    self.gs.ground_items.remove(item)
                    eq_def = asset_registry.get_equipment(eq_id)
                    label = eq_def.label if eq_def else eq_id
                    self.gs.fx_events.append({"type": "chat_hint", "pid": pid,
                                              "text": f"Picked up {label}."})
                    return
                if item["resource"] == "Stone":
                    p["stones"] = p.get("stones", 0) + 1
                else:
                    p["logs"] += 1
                item["amount"] -= 1
                if item["amount"] <= 0:
                    self.gs.ground_items.remove(item)
                return
