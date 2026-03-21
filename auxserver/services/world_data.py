# world_data.py — Map loading helpers extracted from game_state.py.
# Loads tree positions, portals, minecart portals, and world object instances
# from the maps directory at import time.

import json
import logging
import re
from pathlib import Path

logger = logging.getLogger(__name__)

from services.asset_registry import asset_registry
from core.constants import TILE_SIZE

# ── Tile-sheet constants (used only for map parsing) ─────────────────────────
SHEET_COLS = 57
FRAME_TREE = 531  # tileX=18, tileY=9
FRAME_BARE = 6    # tileX=6,  tileY=0 — bare ground (rock spawn tile)

FALLBACK_TREE_POSITIONS = [
    (3,3),(4,5),(6,2),(8,4),(10,3),(12,5),(14,2),(16,4),
    (5,8),(7,7),(9,9),(11,8),(13,7),(15,9),
    (3,12),(6,11),(8,13),(10,12),(12,14),(14,11),(16,13),
    (4,16),(7,15),(9,17),(11,16),(13,18),(15,15),
    (18,3),(20,5),(22,2),(24,4),(18,8),(20,7),
    (22,9),(24,8),(18,12),(20,14),(22,11),(24,13),
]


def _tile_pos(col, row):
    return (col * TILE_SIZE + TILE_SIZE / 2, row * TILE_SIZE + TILE_SIZE / 2)


def _load_map_positions():
    """Load tree, rock-spawn, and collision tile positions from level_01.json."""
    try:
        maps_dir = Path(__file__).resolve().parent.parent / "maps"
        map_path = maps_dir / "level_01.json"
        if not map_path.exists():
            return FALLBACK_TREE_POSITIONS, [], set(), 80, 50
        data = json.loads(map_path.read_text(encoding="utf-8"))
        width = data.get("width", 30)
        height = data.get("height", 30)
        trees = []
        rock_spawns = []
        for t in data.get("tiles", []):
            tile_x = t.get("tileX")
            tile_y = t.get("tileY")
            if not isinstance(tile_x, int) or not isinstance(tile_y, int):
                continue
            frame = tile_x + tile_y * SHEET_COLS
            if frame == FRAME_TREE:
                trees.append((t["x"], t["y"]))
            elif frame == FRAME_BARE:
                rock_spawns.append((t["x"], t["y"]))

        # Load collision tiles from the companion _collision.json file
        collision_set = set()
        col_path = maps_dir / "level_01_collision.json"
        if col_path.exists():
            col_data = json.loads(col_path.read_text(encoding="utf-8"))
            for ct in col_data.get("collisionTiles", []):
                collision_set.add((int(ct["x"]), int(ct["y"])))
            logger.info("Loaded %d collision tiles from level_01_collision.json", len(collision_set))

        if trees:
            logger.info("Loaded %d trees, %d rock spawn tiles from level_01.json (%dx%d)",
                        len(trees), len(rock_spawns), width, height)
            return trees, rock_spawns, collision_set, width, height
    except Exception as e:
        logger.warning("Failed to load map: %s", e)
    return FALLBACK_TREE_POSITIONS, [], set(), 80, 50


def _load_portals():
    """Load portal definitions from all *_items.json files in the maps directory.

    Portal label formats:
      portal:TARGET_MAP:COL:ROW  — explicit spawn tile
      portal:TARGET_MAP          — spawn tile taken from a 'spawn' item on the target map
    """
    try:
        maps_dir = Path(__file__).resolve().parent.parent / "maps"

        # Build a spawn-point lookup: map_name -> (col, row) from items labelled 'spawn'
        spawn_points = {}
        for items_file in maps_dir.glob("*_items.json"):
            map_name = items_file.stem.replace("_items", "")
            data = json.loads(items_file.read_text(encoding="utf-8"))
            for item in data.get("mapItems", []):
                if item.get("label", "").strip().lower() == "spawn":
                    spawn_points[map_name] = (int(item["tileCol"]), int(item["tileRow"]))
                    break  # only one spawn per map

        portals = []
        for items_file in maps_dir.glob("*_items.json"):
            map_name = items_file.stem.replace("_items", "")
            data = json.loads(items_file.read_text(encoding="utf-8"))
            for item in data.get("mapItems", []):
                label = item.get("label", "").strip()
                # Explicit coords: portal:TARGET:COL:ROW
                m = re.match(r"portal:([^:]+):(\d+):(\d+)", label)
                if m:
                    portals.append({
                        "from_map": map_name,
                        "tile_col": int(item["tileCol"]),
                        "tile_row": int(item["tileRow"]),
                        "to_map": m.group(1),
                        "spawn_col": int(m.group(2)),
                        "spawn_row": int(m.group(3)),
                    })
                    continue
                # Auto-spawn: portal:TARGET (looks up 'spawn' item on target map)
                m2 = re.match(r"portal:([^:]+)$", label)
                if m2:
                    target = m2.group(1)
                    if target in spawn_points:
                        sc, sr = spawn_points[target]
                        portals.append({
                            "from_map": map_name,
                            "tile_col": int(item["tileCol"]),
                            "tile_row": int(item["tileRow"]),
                            "to_map": target,
                            "spawn_col": sc,
                            "spawn_row": sr,
                        })
                    else:
                        logger.warning("Portal to '%s' has no 'spawn' item on that map — place one or use explicit coords", target)

        logger.info("Loaded %d portals, spawn points: %s", len(portals), spawn_points)
        return portals
    except Exception as e:
        logger.warning("Failed to load portals: %s", e)
        return []


def _load_minecart_portals():
    """Load minecart exit/entrance pairs from *_items.json files.

    Labels:
      minecart_exit:TARGET_MAP  — exit on source map, sends carts to target
      minecart_entrance         — entrance on target map, receives carts
    """
    try:
        maps_dir = Path(__file__).resolve().parent.parent / "maps"
        exits = []       # {from_map, col, row, to_map}
        entrances = {}   # map_name -> (col, row)

        for items_file in maps_dir.glob("*_items.json"):
            map_name = items_file.stem.replace("_items", "")
            data = json.loads(items_file.read_text(encoding="utf-8"))
            for item in data.get("mapItems", []):
                label = item.get("label", "").strip()
                m = re.match(r"minecart_exit:(.+)", label)
                if m:
                    exits.append({
                        "from_map": map_name,
                        "col": int(item["tileCol"]),
                        "row": int(item["tileRow"]),
                        "to_map": m.group(1),
                    })
                elif label == "minecart_entrance":
                    entrances[map_name] = (int(item["tileCol"]), int(item["tileRow"]))

        # Resolve exits to entrance coordinates
        portals = []
        for ex in exits:
            target = ex["to_map"]
            if target in entrances:
                ec, er = entrances[target]
                portals.append({
                    "from_map": ex["from_map"],
                    "tile_col": ex["col"],
                    "tile_row": ex["row"],
                    "to_map": target,
                    "entrance_col": ec,
                    "entrance_row": er,
                })
            else:
                logger.warning("Minecart exit to '%s' has no entrance — place a 'minecart_entrance' item on that map", target)

        logger.info("Loaded %d minecart portals, entrances: %s", len(portals), entrances)
        return portals
    except Exception as e:
        logger.warning("Failed to load minecart portals: %s", e)
        return []


def _load_world_objects():
    """Load world object placements from all *_items.json files.

    Items with labels like 'worldobj:copper_ore' create instances of that asset
    at the item's tile position on the corresponding map.
    """
    try:
        maps_dir = Path(__file__).resolve().parent.parent / "maps"
        instances = {}
        _next_wo_id = 0
        for items_file in maps_dir.glob("*_items.json"):
            map_name = items_file.stem.replace("_items", "")
            data = json.loads(items_file.read_text(encoding="utf-8"))
            for item in data.get("mapItems", []):
                label = item.get("label", "").strip()
                m = re.match(r"worldobj:(.+)", label)
                if not m:
                    continue
                asset_id = m.group(1)
                wo_def = asset_registry.get_world_object(asset_id)
                if not wo_def:
                    logger.warning("Unknown world object asset '%s' in %s", asset_id, items_file.name)
                    continue
                col = int(item["tileCol"])
                row = int(item["tileRow"])
                x, y = _tile_pos(col, row)
                wo_id = f"wo_{_next_wo_id}"
                _next_wo_id += 1
                instances[wo_id] = {
                    "id": wo_id,
                    "asset_id": asset_id,
                    "map": map_name,
                    "x": x, "y": y,
                    "col": col, "row": row,
                    "hp": wo_def.hp,
                    "maxHp": wo_def.hp,
                    "depleted": False,
                    "respawn_at": None,
                }
        if instances:
            logger.info("Loaded %d world object instances", len(instances))
        return instances
    except Exception as e:
        logger.warning("Failed to load world objects: %s", e)
        return {}


# ── Module-level data (populated at import time) ──────────────────────────────
TREE_POSITIONS, ROCK_SPAWN_POSITIONS, COLLISION_TILES, MAP_COLS, MAP_ROWS = _load_map_positions()
PORTALS = _load_portals()
MINECART_PORTALS = _load_minecart_portals()

WORLD_OBJECT_INSTANCES = {}  # populated by init_world_objects() after asset_registry loads


def init_world_objects():
    """Call after asset_registry.load_all() to populate world object instances."""
    WORLD_OBJECT_INSTANCES.update(_load_world_objects())
