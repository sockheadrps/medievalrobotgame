"""Cave mining sub-service: mine grids, tile mining, refining, NPC stone ops."""

import logging
import random
import time

logger = logging.getLogger(__name__)

from services.game_state import (
    TILE_SIZE,
    ROCK_MINE_DIST,
    REFINE_STONE_COST,
    CRYSTAL_CHANCE,
    dist,
)
from services.asset_registry import asset_registry
from services.mine_state import MineGrid


class CaveMiningService:
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

            # Geode: 25% chance to also yield a blast_crystal
            if ore_type == "geode" and random.random() < 0.25:
                inv["blast_crystal"] = inv.get("blast_crystal", 0) + 1
                self.gs.fx_events.append({
                    "type": "chat_hint", "pid": pid,
                    "text": "+1 blast crystal! (Use it to learn a random ki blast technique)"
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
