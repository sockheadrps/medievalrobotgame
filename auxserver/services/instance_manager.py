"""Instance manager — load/save/unload per-map entity state.

Each map instance holds: trees, rocks, buildings, dummies, anvils, campfires.
Central map is always loaded. Home maps load on demand, unload after 60s idle.
"""

import json
import logging
import time
from pathlib import Path

from services.database import save_instance_state, load_instance_state

logger = logging.getLogger(__name__)

MAPS_DIR = Path(__file__).resolve().parent.parent / "maps"
UNLOAD_DELAY = 60  # seconds with no players before unloading

# Respawn timers (seconds)
TREE_RESPAWN_HOME = 300     # 5 minutes
TREE_RESPAWN_CENTRAL = 600  # 10 minutes
ORE_RESPAWN_CENTRAL = 900   # 15 minutes


def get_tree_respawn_time(map_key: str) -> int:
    """Return tree respawn time in seconds based on map type."""
    if map_key.startswith("home_"):
        return TREE_RESPAWN_HOME
    return TREE_RESPAWN_CENTRAL


def _empty_instance() -> dict:
    return {
        "trees": [],
        "rocks": [],
        "buildings": {},
        "dummies": {},
        "anvils": {},
        "campfires": {},
        "world_objects": [],
    }


class InstanceManager:
    def __init__(self):
        # map_key -> instance dict
        self._instances: dict[str, dict] = {}
        # map_key -> timestamp of last player presence
        self._last_occupied: dict[str, float] = {}
        # map_key -> set of player IDs currently on this map
        self._occupants: dict[str, set] = {}
        # Always-loaded maps (never unloaded)
        self._persistent_maps: set[str] = set()

    def mark_persistent(self, map_key: str):
        """Mark a map as always-loaded (e.g. central, level_01)."""
        self._persistent_maps.add(map_key)

    def is_loaded(self, map_key: str) -> bool:
        return map_key in self._instances

    def get(self, map_key: str) -> dict | None:
        return self._instances.get(map_key)

    def ensure_loaded(self, map_key: str) -> dict:
        """Load instance if not already loaded, return it."""
        if map_key not in self._instances:
            self._load_instance(map_key)
        return self._instances[map_key]

    def get_trees(self, map_key: str) -> list:
        inst = self._instances.get(map_key)
        return inst["trees"] if inst else []

    def get_buildings(self, map_key: str) -> dict:
        inst = self._instances.get(map_key)
        return inst.get("buildings", {}) if inst else {}

    def get_dummies(self, map_key: str) -> dict:
        inst = self._instances.get(map_key)
        return inst.get("dummies", {}) if inst else {}

    def get_anvils(self, map_key: str) -> dict:
        inst = self._instances.get(map_key)
        return inst.get("anvils", {}) if inst else {}

    def get_campfires(self, map_key: str) -> dict:
        inst = self._instances.get(map_key)
        return inst.get("campfires", {}) if inst else {}

    def get_rocks(self, map_key: str) -> list:
        inst = self._instances.get(map_key)
        return inst.get("rocks", []) if inst else []

    def get_world_objects(self, map_key: str) -> list:
        inst = self._instances.get(map_key)
        return inst.get("world_objects", []) if inst else []

    def player_entered(self, map_key: str, pid: str):
        """Called when a player enters a map. Loads instance if needed."""
        if map_key not in self._instances:
            self._load_instance(map_key)
        self._occupants.setdefault(map_key, set()).add(pid)
        self._last_occupied[map_key] = time.time()

    def player_left(self, map_key: str, pid: str):
        """Called when a player leaves a map."""
        occ = self._occupants.get(map_key, set())
        occ.discard(pid)
        if not occ:
            self._last_occupied[map_key] = time.time()

    def tick_unload(self):
        """Check for instances that should be unloaded. Call once per save cycle."""
        now = time.time()
        to_unload = []
        for map_key in list(self._instances):
            if map_key in self._persistent_maps:
                continue
            occ = self._occupants.get(map_key, set())
            if not occ and now - self._last_occupied.get(map_key, 0) > UNLOAD_DELAY:
                to_unload.append(map_key)
        for map_key in to_unload:
            self._save_instance(map_key)
            del self._instances[map_key]
            self._occupants.pop(map_key, None)
            self._last_occupied.pop(map_key, None)
            logger.info("Unloaded instance %s", map_key)

    def save_all(self):
        """Save all loaded instances to DB. Call on auto-save cycle."""
        for map_key in list(self._instances):
            self._save_instance(map_key)

    def init_home(self, map_key: str):
        """Initialize a fresh home instance from the home.json template."""
        from services.world_data import FRAME_TREE, FRAME_BARE, SHEET_COLS
        from core.constants import TILE_SIZE

        template_path = MAPS_DIR / "home.json"
        trees = []
        rocks = []
        if template_path.exists():
            data = json.loads(template_path.read_text(encoding="utf-8"))
            for i, t in enumerate(data.get("tiles", [])):
                tx, ty = t.get("tileX"), t.get("tileY")
                if not isinstance(tx, int) or not isinstance(ty, int):
                    continue
                frame = tx + ty * SHEET_COLS
                x = t["x"] * TILE_SIZE + TILE_SIZE // 2
                y = t["y"] * TILE_SIZE + TILE_SIZE // 2
                if frame == FRAME_TREE:
                    trees.append({
                        "id": f"{map_key}_t{i}",
                        "x": x, "y": y,
                        "chopped": False,
                        "regrow_at": None,
                    })
                elif frame == FRAME_BARE:
                    rocks.append({"id": f"{map_key}_r{i}", "x": x, "y": y})

        inst = _empty_instance()
        inst["trees"] = trees
        inst["rocks"] = rocks
        self._instances[map_key] = inst
        self._save_instance(map_key)
        logger.info("Initialized home instance %s (%d trees, %d rocks)", map_key, len(trees), len(rocks))

    def init_central(self, tree_positions: list, rock_spawn_positions: list):
        """Initialize central map from parsed level data (or template)."""
        from core.constants import TILE_SIZE

        # If already loaded from DB, don't re-init
        if "central" in self._instances:
            return

        saved = load_instance_state("central")
        if saved:
            self._instances["central"] = saved
            logger.info("Loaded central instance from DB")
            return

        # Build from template
        template_path = MAPS_DIR / "central.json"
        trees = []
        rocks = []
        if template_path.exists():
            from services.world_data import FRAME_TREE, FRAME_BARE, SHEET_COLS
            data = json.loads(template_path.read_text(encoding="utf-8"))
            for i, t in enumerate(data.get("tiles", [])):
                tx, ty = t.get("tileX"), t.get("tileY")
                if not isinstance(tx, int) or not isinstance(ty, int):
                    continue
                frame = tx + ty * SHEET_COLS
                x = t["x"] * TILE_SIZE + TILE_SIZE // 2
                y = t["y"] * TILE_SIZE + TILE_SIZE // 2
                if frame == FRAME_TREE:
                    trees.append({
                        "id": f"central_t{i}",
                        "x": x, "y": y,
                        "chopped": False,
                        "regrow_at": None,
                    })
                elif frame == FRAME_BARE:
                    rocks.append({"id": f"central_r{i}", "x": x, "y": y})

        inst = _empty_instance()
        inst["trees"] = trees
        inst["rocks"] = rocks
        self._instances["central"] = inst
        self._save_instance("central")
        logger.info("Initialized central instance (%d trees, %d rocks)", len(trees), len(rocks))

    def _load_instance(self, map_key: str):
        """Load instance from DB, or initialize if new."""
        saved = load_instance_state(map_key)
        if saved:
            self._instances[map_key] = saved
            logger.info("Loaded instance %s from DB", map_key)
        elif map_key.startswith("home_"):
            self.init_home(map_key)
        else:
            # Unknown map — create empty instance
            self._instances[map_key] = _empty_instance()
            logger.info("Created empty instance %s", map_key)

    def _save_instance(self, map_key: str):
        """Save instance state to DB."""
        inst = self._instances.get(map_key)
        if inst:
            save_instance_state(map_key, inst)
