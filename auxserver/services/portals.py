"""Portal & map transition: detection, spawn resolution, map init."""

import json
import logging
from pathlib import Path

from services.game_state import PORTALS, TILE_SIZE

logger = logging.getLogger(__name__)


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
            logger.warning("Failed to read spawn point for %s: %s", map_name, e)
        return None
