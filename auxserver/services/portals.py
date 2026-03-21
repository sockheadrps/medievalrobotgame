"""Portal & map transition: detection, spawn resolution, map init."""

import json
import re
from pathlib import Path

from services.game_state import PORTALS, MINECART_PORTALS, TILE_SIZE, tile_pos


class PortalService:
    def __init__(self, game_state):
        self.gs = game_state

    def check_portal(self, actor: dict):
        """Return matching portal if actor is standing on one, else None."""
        col = int(actor["x"] // TILE_SIZE)
        row = int(actor["y"] // TILE_SIZE)
        actor_map = actor.get("map", "level_01")
        for portal in PORTALS:
            if portal["from_map"] == actor_map and portal["tile_col"] == col and portal["tile_row"] == row:
                return portal
        return None

    def handle_minecart_portal(self, pid, data):
        """Cart reached a minecart_exit tile — route it to the entrance on another map."""
        p = self.gs.players.get(pid)
        if not p:
            return
        player_map = p.get("map", "level_01")
        col = data.get("col")
        row = data.get("row")
        resource = data.get("resource", "planks")
        amount = int(data.get("amount", 1))
        if col is None or row is None:
            return

        for portal in MINECART_PORTALS:
            if (portal["from_map"] == player_map
                    and portal["tile_col"] == col
                    and portal["tile_row"] == row):
                self.gs.pending_carts.append({
                    "map": portal["to_map"],
                    "col": portal["entrance_col"],
                    "row": portal["entrance_row"],
                    "resource": resource,
                    "amount": amount,
                })
                return

    def get_spawn_point_for_map(self, map_name: str):
        """Return (col, row) spawn point for a given map name from portal definitions, or None."""
        maps_dir = Path(__file__).resolve().parent.parent / "maps"
        items_file = maps_dir / f"{map_name}_items.json"
        if not items_file.exists():
            return None
        try:
            data = json.loads(items_file.read_text(encoding="utf-8"))
            for item in data.get("mapItems", []):
                if item.get("label", "").strip().lower() == "spawn":
                    return (int(item["tileCol"]), int(item["tileRow"]))
        except Exception as e:
            print(f"[portals] Failed to read spawn point for {map_name}: {e}")
        return None
