"""Gathering sub-service: tree chopping, farming, rock spawning/mining, world objects."""

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
    tile_pos,
    dist,
    _gen_item_id,
)
from services.crop_service import crop_manager
from services.asset_registry import asset_registry
from services.instance_manager import get_tree_respawn_time


class GatheringService:
    # ── Tree chopping ──────────────────────────────────────────────────────────

    def _get_trees_for_map(self, map_name: str) -> list:
        """Return tree list for the given map from instance manager."""
        return self.gs.instances.get_trees(map_name)

    def _npc_chop(self, tree_id, owner_id, npc_id=None):
        """NPC chops a tree. If npc_id given, credit logs directly to that NPC."""
        if tree_id is None:
            return
        # Determine which map the NPC/owner is on
        player_map = "level_01"
        if owner_id:
            owner = self.gs.players.get(owner_id)
            if owner and npc_id:
                npc_data = owner.get("npcs", {}).get(npc_id)
                if npc_data:
                    player_map = npc_data.get("map", owner.get("map", "level_01"))
            elif owner:
                player_map = owner.get("map", "level_01")
        trees = self._get_trees_for_map(player_map)
        if tree_id < 0 or tree_id >= len(trees):
            return
        tree = trees[tree_id]
        if tree["chopped"]:
            return
        tree["chopped"] = True
        tree["regrow_at"] = time.time() + get_tree_respawn_time(player_map)

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
            "map": player_map,
        })

    def _try_chop(self, pid, tree_id):
        if tree_id is None:
            return
        player_map = self.gs.players.get(pid, {}).get("map", "level_01")
        trees = self._get_trees_for_map(player_map)
        if tree_id < 0 or tree_id >= len(trees):
            return
        tree = trees[tree_id]
        if tree["chopped"]:
            return
        tree["chopped"] = True
        tree["regrow_at"] = time.time() + get_tree_respawn_time(player_map)

        # Drop ground item
        item_id = _gen_item_id()
        self.gs.ground_items.append({
            "id": item_id,
            "x": tree["x"],
            "y": tree["y"] + TILE_SIZE * 0.4,
            "resource": "Wood",
            "amount": 1,
            "map": player_map,
        })

    # ── Farming ────────────────────────────────────────────────────────────────

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
        for drop in wo_def.drops:
            amount = random.randint(drop.min, drop.max)
            res = str(drop.resource or "").lower()
            if res in ("log", "logs"):
                p["logs"] = int(p.get("logs", 0) or 0) + amount
            elif res in ("stone", "stones"):
                p["stones"] = int(p.get("stones", 0) or 0) + amount
            elif res in ("crystal", "crystals"):
                p["crystals"] = int(p.get("crystals", 0) or 0) + amount
            else:
                inv = p.setdefault("inventory", {})
                inv[res] = inv.get(res, 0) + amount
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
