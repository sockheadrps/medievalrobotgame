# game_state.py — Server-authoritative world state for multiplayer.
# Holds all players, trees, ground items, NPCs, dummies.
# Ticked at ~20Hz by the WebSocket broadcast loop.

import json
import re
import time
import math
import random
from pathlib import Path

from services.database import (
    load_ground_items, save_ground_items,
    load_dummies, save_dummies,
    load_anvils, save_anvils,
    load_campfires, save_campfires,
    load_buildings, save_buildings,
)
from services.animal_service import animal_manager
from services.crop_service import crop_manager
from services.asset_registry import asset_registry
from services.mine_state import MineGrid

TILE_SIZE = 48
PLAYER_SPEED = 160
PLAYER_RUN_SPEED = 280
NPC_SPEED = 120
TREE_CHOP_DIST = 80
TREE_REGROW_MIN = 15.0
TREE_REGROW_MAX = 30.0
PICKUP_DIST = TILE_SIZE * 0.6
PVP_ATTACK_RANGE = TILE_SIZE * 2.0  # slightly more generous than client (1.5 tiles) to account for sync lag
PVP_COOLDOWN = 0.6
PLAYER_RESPAWN_TIME = 5.0
KNOCKOUT_MIN_TIME = 10.0
KNOCKOUT_MAX_TIME = 20.0
PVP_XP_KILL = 25
AI_RIVAL_PID = "__ai_rival__"

# Ki / blast constants
KI_MAX_BASE = 20
KI_MAX_PER_LEVEL = 2
KI_BLAST_BASE_COST = 8
KI_BLAST_BASE_DMG = 2
KI_BLAST_SCALE = 0.02  # 2% improvement per blast level
KI_DEF_REDUCTION_DIVISOR = 2
KI_SKILL_RESIST_PER_LEVEL = 0.01
KI_SKILL_RESIST_CAP = 0.50
KI_BLAST_RANGE = TILE_SIZE * 4  # longer range than melee
KI_BLAST_COOLDOWN = 1.2  # seconds between blasts
ABSORB_DURATION = 2.0
DEFAULT_KI_MOVES = ["absorb"]

SHEET_COLS = 57
FRAME_TREE = 531  # tileX=18, tileY=9
FRAME_BARE = 6    # tileX=6,  tileY=0 — bare ground (rock spawn tile)

# Rock spawning
ROCK_SPAWN_INTERVAL = 45.0    # seconds
ROCK_SPAWN_CHANCE = 0.45      # 45% per tile per interval
ROCK_LIFESPAN = 60.0          # seconds — despawns if not mined
ROCK_HITS = 5                 # clicks to mine
ROCK_MINE_DIST = 80           # px

# Barrier constants
BARRIER_BASE_PHYSICAL_REDUCTION = 10
BARRIER_BASE_KI_REDUCTION = 10
BARRIER_UPGRADE_CAP = 30
BARRIER_PROC_KI_COST = 3
BARRIER_PROC_DURATION = 0.22

# Anvil constants
ANVIL_STONE_COST = 5        # stones to place an anvil
REFINE_STONE_COST = 1       # stones consumed per refine attempt

# Crystal constants (simplified refining)
CRYSTAL_CHANCE = 0.30
CRYSTAL_UPGRADE_CHANCE = 0.50
CRYSTAL_UPGRADE_STATS = ["blast_speed", "blast_range", "blast_dmg", "blast_cooldown", "barrier_duration", "barrier_cooldown"]

# Gate & Fence constants
GATE_LOG_COST = 3
FENCE_LOG_COST = 2
FENCE_BASE_HP = 50

# Ki Target constants
KI_TARGET_HP = 5          # hits before it breaks
KI_TARGET_BREAK_CHANCE = 0.40  # 40% chance to break per blast hit
KI_TARGET_LOG_COST = 5
KI_TARGET_LEARN_CHANCE = 1.0 / 25.0  # 1/25 chance NPC learns per hit

# Fallback tree positions if map fails to load
FALLBACK_TREE_POSITIONS = [
    (3,3),(4,5),(6,2),(8,4),(10,3),(12,5),(14,2),(16,4),
    (5,8),(7,7),(9,9),(11,8),(13,7),(15,9),
    (3,12),(6,11),(8,13),(10,12),(12,14),(14,11),(16,13),
    (4,16),(7,15),(9,17),(11,16),(13,18),(15,15),
    (18,3),(20,5),(22,2),(24,4),(18,8),(20,7),
    (22,9),(24,8),(18,12),(20,14),(22,11),(24,13),
]


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
            print(f"[game_state] Loaded {len(collision_set)} collision tiles from level_01_collision.json")

        if trees:
            print(f"[game_state] Loaded {len(trees)} trees, {len(rock_spawns)} rock spawn tiles from level_01.json ({width}x{height})")
            return trees, rock_spawns, collision_set, width, height
    except Exception as e:
        print(f"[game_state] Failed to load map: {e}")
    return FALLBACK_TREE_POSITIONS, [], set(), 80, 50


TREE_POSITIONS, ROCK_SPAWN_POSITIONS, COLLISION_TILES, MAP_COLS, MAP_ROWS = _load_map_positions()


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
                        print(f"[game_state] Portal to '{target}' has no 'spawn' item on that map — place one or use explicit coords")

        print(f"[game_state] Loaded {len(portals)} portals, spawn points: {spawn_points}")
        return portals
    except Exception as e:
        print(f"[game_state] Failed to load portals: {e}")
        return []


PORTALS = _load_portals()


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
                print(f"[game_state] Minecart exit to '{target}' has no entrance — place a 'minecart_entrance' item on that map")

        print(f"[game_state] Loaded {len(portals)} minecart portals, entrances: {entrances}")
        return portals
    except Exception as e:
        print(f"[game_state] Failed to load minecart portals: {e}")
        return []


MINECART_PORTALS = _load_minecart_portals()

# World object interaction
WORLD_OBJ_MINE_DIST = 80  # px


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
                    print(f"[game_state] Unknown world object asset '{asset_id}' in {items_file.name}")
                    continue
                col = int(item["tileCol"])
                row = int(item["tileRow"])
                x, y = tile_pos(col, row)
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
            print(f"[game_state] Loaded {len(instances)} world object instances")
        return instances
    except Exception as e:
        print(f"[game_state] Failed to load world objects: {e}")
        return {}


WORLD_OBJECT_INSTANCES = {}  # populated by init_world_objects() after asset_registry loads


def init_world_objects():
    """Call after asset_registry.load_all() to populate world object instances."""
    WORLD_OBJECT_INSTANCES.update(_load_world_objects())


def _check_portal(actor: dict):
    """Return matching portal if actor is standing on one, else None."""
    col = int(actor["x"] // TILE_SIZE)
    row = int(actor["y"] // TILE_SIZE)
    actor_map = actor.get("map", "level_01")
    for portal in PORTALS:
        if portal["from_map"] == actor_map and portal["tile_col"] == col and portal["tile_row"] == row:
            return portal
    return None


def _is_collision_tile(x: float, y: float) -> bool:
    """Return True if pixel position (x,y) falls inside a collision tile."""
    col = int(x // TILE_SIZE)
    row = int(y // TILE_SIZE)
    return (col, row) in COLLISION_TILES


def tile_pos(col, row):
    return (col * TILE_SIZE + TILE_SIZE / 2, row * TILE_SIZE + TILE_SIZE / 2)


def dist(x1, y1, x2, y2):
    return math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2)


_next_item_id = 0
_next_dummy_id = 0
_next_anvil_id = 0
_next_campfire_id = 0
_next_building_id = 0

# Campfire constants
CAMPFIRE_RADIUS = TILE_SIZE * 2      # 2 tile radius for regen aura
CAMPFIRE_HP_REGEN = 0.5              # HP per second while near campfire
CAMPFIRE_KI_REGEN_MULT = 2.0        # Ki regen multiplier near campfire
CAMPFIRE_DURATION = {1: 20.0, 2: 40.0, 3: 60.0}  # seconds by log count


def _gen_item_id():
    global _next_item_id
    _next_item_id += 1
    return f"item_{_next_item_id}"


def _gen_dummy_id():
    global _next_dummy_id
    _next_dummy_id += 1
    return f"dummy_{_next_dummy_id}"


def _gen_anvil_id():
    global _next_anvil_id
    _next_anvil_id += 1
    return f"anvil_{_next_anvil_id}"


def _gen_campfire_id():
    global _next_campfire_id
    _next_campfire_id += 1
    return f"campfire_{_next_campfire_id}"


def _gen_building_id():
    global _next_building_id
    _next_building_id += 1
    return f"bld_{_next_building_id}"


class GameState:
    def __init__(self):
        self.players = {}       # pid -> PlayerState
        self.trees = []         # list of TreeState
        self.rocks = []         # list of RockState (dynamically spawned)
        self.ground_items = []  # list of ItemState
        self.npcs = {}          # npc_id -> dict (managed client-side for now)
        self.dummies = {}       # dummy_id -> DummyState
        self.anvils = {}        # anvil_id -> AnvilState
        self.campfires = {}     # campfire_id -> CampfireState
        self.buildings = {}     # building_id -> {id, kind, col, row, map, owner, direction, stored}
        self.pending_carts = [] # [{map, col, row, resource, amount}] — carts arriving via portal
        self.fx_events = []     # transient replicated visual effects
        self.pending_absorbs = []
        self.background_npcs = {}  # npc_id -> {pid, npc_id, map, task, last_tick}
        self.mine_grids = {}       # pid -> MineGrid (loaded on cave entry)
        self.xp_multipliers = {
            "player": 1.0,
            "npc": 1.0,
            "ai_player": 1.0,
            "ai_npc": 1.0,
        }
        self._last_save = 0     # timestamp of last DB save
        self._last_rock_spawn = time.time()  # last rock spawn check
        self._next_rock_id = 0
        self._init_trees()
        self._load_persisted()

        from services.combat import CombatService
        self.combat = CombatService(self)

        from services.resources import ResourceService
        self.resources = ResourceService(self)

        from services.building import BuildingService
        self.building = BuildingService(self)

    def _init_trees(self):
        for i, (col, row) in enumerate(TREE_POSITIONS):
            x, y = tile_pos(col, row)
            self.trees.append({
                "id": i,
                "x": x, "y": y,
                "chopped": False,
                "regrow_at": None,
            })

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

    def _load_persisted(self):
        """Load ground items, dummies, anvils, campfires, and buildings from the database."""
        global _next_item_id, _next_dummy_id, _next_anvil_id, _next_campfire_id, _next_building_id
        try:
            self.ground_items = load_ground_items()
            self.dummies = load_dummies()
            self.anvils = load_anvils()
            self.campfires = load_campfires()
            self.buildings = load_buildings()
            # Restore ID counters so new IDs don't collide
            for item in self.ground_items:
                n = int(item["id"].split("_", 1)[1])
                if n >= _next_item_id:
                    _next_item_id = n
            for did in self.dummies:
                n = int(did.split("_", 1)[1])
                if n >= _next_dummy_id:
                    _next_dummy_id = n
            for aid in self.anvils:
                n = int(aid.split("_", 1)[1])
                if n >= _next_anvil_id:
                    _next_anvil_id = n
            for cid in self.campfires:
                n = int(cid.split("_", 1)[1])
                if n >= _next_campfire_id:
                    _next_campfire_id = n
            for bid in self.buildings:
                n = int(bid.split("_", 1)[1])
                if n >= _next_building_id:
                    _next_building_id = n
            ct = len(self.ground_items) + len(self.dummies) + len(self.anvils) + len(self.campfires) + len(self.buildings)
            if ct > 0:
                print(f"[game_state] Restored {len(self.ground_items)} ground items, "
                      f"{len(self.dummies)} dummies, {len(self.anvils)} anvils, "
                      f"{len(self.campfires)} campfires, {len(self.buildings)} buildings from DB")
        except Exception as e:
            print(f"[game_state] Failed to load persisted state: {e}")

    def reset(self):
        """Reset all in-memory state to fresh. Called after DB reset."""
        global _next_item_id, _next_dummy_id, _next_anvil_id, _next_campfire_id, _next_building_id
        self.players.clear()
        self.ground_items.clear()
        self.dummies.clear()
        self.anvils.clear()
        self.campfires.clear()
        self.buildings.clear()
        self.fx_events.clear()
        self.pending_absorbs.clear()
        self.rocks.clear()
        self.xp_multipliers = {
            "player": 1.0,
            "npc": 1.0,
            "ai_player": 1.0,
            "ai_npc": 1.0,
        }
        _next_item_id = 0
        _next_dummy_id = 0
        _next_anvil_id = 0
        _next_campfire_id = 0
        _next_building_id = 0
        # Re-init trees (all unchopped)
        self.trees.clear()
        self._init_trees()
        self._last_rock_spawn = time.time()
        self._spawn_rocks()
        print("[game_state] In-memory state reset")

    def save_world(self):
        """Persist ground items, dummies, anvils, campfires, buildings, and mine grids to the database."""
        try:
            save_ground_items(self.ground_items)
            save_dummies(self.dummies)
            save_anvils(self.anvils)
            save_campfires(self.campfires)
            save_buildings(self.buildings)
            # Save mine grids
            from services.database import save_mine_state
            for pid, mg in self.mine_grids.items():
                save_mine_state(pid, mg.to_json())
        except Exception as e:
            print(f"[game_state] Failed to save world state: {e}")

    def add_player(self, pid: str):
        # Spawn near center with slight random offset
        sx, sy = tile_pos(10, 10)
        sx += random.randint(-48, 48)
        sy += random.randint(-48, 48)
        self.players[pid] = {
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
        self._ensure_default_ki_moves(self.players[pid])
        return self.players[pid]

    def remove_player(self, pid: str):
        self.players.pop(pid, None)

    def handle_input(self, pid: str, data: dict):
        """Process input from a client."""
        p = self.players.get(pid)
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
            tree_id = data.get("tree_id")
            self._try_chop(pid, tree_id)

        elif msg_type == "mine_rock":
            rock_id = data.get("rock_id")
            self._try_mine_rock(pid, rock_id)

        elif msg_type == "mine_tile":
            col = data.get("col")
            row = data.get("row")
            if col is not None and row is not None:
                self._try_mine_tile(pid, int(col), int(row))

        elif msg_type == "request_mine_tiles":
            tiles = self.get_mine_tiles_for_player(pid)
            if tiles is not None:
                self.fx_events.append({
                    "type": "mine_update", "pid": pid,
                    "tiles": tiles,
                })

        elif msg_type == "attack_dummy":
            dummy_id = data.get("dummy_id")
            self._try_attack_dummy(pid, dummy_id)

        elif msg_type == "build_dummy":
            self._try_build_dummy(pid, data.get("logs", 10))

        elif msg_type == "delete_dummy":
            dummy_id = data.get("dummy_id")
            if dummy_id and dummy_id in self.dummies:
                self.dummies[dummy_id]["dead"] = True

        elif msg_type == "build_anvil":
            self._try_build_anvil(pid)

        elif msg_type == "delete_anvil":
            anvil_id = data.get("anvil_id")
            if anvil_id and anvil_id in self.anvils:
                self.anvils[anvil_id]["dead"] = True

        elif msg_type == "place_building":
            self._place_building(pid, data)

        elif msg_type == "attack_fence":
            self._try_attack_fence(pid, data.get("building_id"))

        elif msg_type == "remove_building":
            bid = data.get("building_id")
            if bid and bid in self.buildings:
                # If it's an etrainer, also remove the dummy entry
                if self.buildings[bid].get("kind") == "etrainer":
                    self.dummies.pop(bid, None)
                del self.buildings[bid]

        elif msg_type == "update_building_stored":
            bid = data.get("building_id")
            stored = data.get("stored")
            if bid and bid in self.buildings and isinstance(stored, dict):
                self.buildings[bid]["stored"] = stored

        elif msg_type == "update_building_out_dir":
            bid = data.get("building_id")
            out_dir = data.get("out_direction", "")
            if bid and bid in self.buildings:
                self.buildings[bid]["out_direction"] = out_dir

        elif msg_type == "update_building_label":
            bid = data.get("building_id")
            label = data.get("label", "")
            if bid and bid in self.buildings:
                self.buildings[bid]["label"] = str(label)[:32]

        elif msg_type == "deduct_resource":
            resource = data.get("resource", "")
            amt = max(0, int(data.get("amount", 1)))
            if resource == "logs":
                p["logs"] = max(0, p.get("logs", 0) - amt)
            elif resource in ("stones", "crystals", "copper", "meat", "feathers", "vegetables", "seeds"):
                p[resource] = max(0, p.get(resource, 0) - amt)
            else:
                # Inventory items
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
            self._handle_minecart_portal(pid, data)

        elif msg_type == "refine_rock":
            anvil_id = data.get("anvil_id")
            npc_id = data.get("npc_id")
            self._try_refine_rock(pid, anvil_id, npc_id)

        elif msg_type == "punch":
            p["punching"] = True
            p["punch_until"] = time.time() + 0.3

        elif msg_type == "npc_chop":
            tree_id = data.get("tree_id")
            owner_id = data.get("owner_id", pid)
            self._npc_chop(tree_id, owner_id, data.get("npc_id"))

        elif msg_type == "npc_pickup_stone":
            item_id = data.get("item_id")
            npc_id = data.get("npc_id")
            self._npc_pickup_stone(pid, npc_id, item_id)
        elif msg_type == "npc_mine_rock":
            npc_id = data.get("npc_id")
            rock_id = data.get("rock_id")
            self._npc_mine_rock(pid, npc_id, rock_id)
        elif msg_type == "npc_pickup_stone_tile":
            npc_id = data.get("npc_id")
            self._npc_pickup_stone_tile(pid, npc_id, data.get("x"), data.get("y"))

        elif msg_type == "npc_refine_rock":
            anvil_id = data.get("anvil_id")
            npc_id = data.get("npc_id")
            self._npc_refine_rock(pid, npc_id, anvil_id)

        elif msg_type == "npc_give_materials":
            npc_id = data.get("npc_id")
            self._npc_give_materials(pid, npc_id)

        elif msg_type == "npc_interact_world_object":
            npc_id = data.get("npc_id")
            wo_id = data.get("wo_id")
            self._npc_interact_world_object(pid, npc_id, wo_id)

        elif msg_type == "npc_deposit_to_crate":
            npc_id = data.get("npc_id")
            building_id = data.get("building_id")
            resource = data.get("resource")
            amount = data.get("amount", 1)
            self._npc_deposit_to_crate(pid, npc_id, building_id, resource, amount)

        elif msg_type == "admin":
            self._handle_admin(p, data)

        elif msg_type == "npc_attack_dummy":
            dummy_id = data.get("dummy_id")
            npc_str = data.get("str", 1)
            npc_id = data.get("npc_id", "npc")
            self._npc_attack_dummy(pid, npc_id, dummy_id, npc_str)

        elif msg_type == "attack_player":
            target_pid = data.get("target_id")
            self._try_attack_player(pid, target_pid)

        elif msg_type == "attack_npc":
            target_owner = data.get("owner_id")
            target_npc_id = data.get("npc_id")
            self._try_attack_npc(pid, target_owner, target_npc_id)

        elif msg_type == "ki_blast_miss":
            # Fired with no target — still costs ki
            cost, _dmg = self._calc_blast(p.get("blastLevel", 0))
            cost, _dmg = self._apply_blast_mode(cost, _dmg, data.get("blast_mode", ""))
            if self._try_ki_spend(p, cost):
                self._queue_ki_blast_fx(p)

        elif msg_type == "ki_blast_player":
            target_pid = data.get("target_id")
            self._ki_blast_player(pid, target_pid, data.get("blast_mode", ""))

        elif msg_type == "ki_blast_npc":
            target_owner = data.get("owner_id")
            target_npc_id = data.get("npc_id")
            self._ki_blast_npc(pid, target_owner, target_npc_id, data.get("blast_mode", ""))
        elif msg_type == "ki_blast_dummy":
            dummy_id = data.get("dummy_id")
            self._ki_blast_dummy(pid, dummy_id, data.get("blast_mode", ""))

        elif msg_type == "ki_blast_ground_item":
            item_id = data.get("item_id")
            self._ki_blast_ground_item(pid, item_id, data.get("blast_mode", ""))

        elif msg_type == "absorb_npc":
            target_owner = data.get("owner_id")
            target_npc_id = data.get("npc_id")
            self._start_player_absorb(pid, target_owner, target_npc_id)

        elif msg_type == "npc_ki_blast_player":
            npc_id = data.get("npc_id")
            target_pid = data.get("target_id")
            self._npc_ki_blast_player(pid, npc_id, target_pid)

        elif msg_type == "npc_ki_blast_npc":
            npc_id = data.get("npc_id")
            target_owner = data.get("owner_id")
            target_npc_id = data.get("target_npc_id")
            self._npc_ki_blast_npc(pid, npc_id, target_owner, target_npc_id)

        elif msg_type == "npc_ki_blast_ki_target":
            npc_id = data.get("npc_id")
            target_id = data.get("target_id")
            self._npc_ki_blast_ki_target(pid, npc_id, target_id)

        elif msg_type == "npc_absorb_npc":
            npc_id = data.get("npc_id")
            target_owner = data.get("target_owner")
            target_npc_id = data.get("target_npc_id")
            self._start_npc_absorb(pid, npc_id, target_owner, target_npc_id)

        elif msg_type == "npc_attack_player":
            target_pid = data.get("target_id")
            npc_str = data.get("str", 1)
            npc_id = data.get("npc_id", "npc")
            self._npc_attack_player(pid, target_pid, npc_str, npc_id)

        elif msg_type == "npc_attack_npc":
            target_owner = data.get("target_owner")
            target_npc_id = data.get("target_npc_id")
            npc_str = data.get("str", 1)
            npc_id = data.get("npc_id", "npc")
            self._npc_attack_npc(pid, npc_id, target_owner, target_npc_id, npc_str)

        elif msg_type == "npc_steal_logs":
            target_owner = data.get("target_owner")
            target_npc_id = data.get("target_npc_id")
            npc_id = data.get("npc_id", "npc")
            npc_str = data.get("str", 1)
            steal_amount = data.get("amount", 1)
            self._npc_steal_logs(pid, npc_id, target_owner, target_npc_id, npc_str, steal_amount)

        elif msg_type == "attack_animal":
            self._try_attack_animal(pid, data.get("animal_id"))

        elif msg_type == "harvest_crop":
            self._try_harvest_crop(pid, data.get("crop_id"))

        elif msg_type == "plant_seed":
            self._try_plant_seed(pid, data.get("x"), data.get("y"))

        elif msg_type == "drop_item":
            self._try_drop_item(pid, data)

        elif msg_type == "pickup_placed":
            self._try_pickup_placed(pid, data.get("item_id"))

        elif msg_type == "reset_blast_level":
            p["blastLevel"] = 0

        elif msg_type == "set_combat_mode":
            mode = data.get("mode", "kill")
            if mode in ("kill", "ko"):
                p["combat_mode"] = mode

        elif msg_type == "build_ki_target":
            self._try_build_ki_target(pid, data.get("x"), data.get("y"))

        elif msg_type == "delete_ki_target":
            target_id = data.get("target_id")
            if target_id:
                self.ground_items = [
                    item for item in self.ground_items
                    if not (item.get("id") == target_id and item.get("resource") == "KiTarget")
                ]

        elif msg_type == "ki_blast_ki_target":
            target_id = data.get("target_id")
            npc_id = data.get("npc_id")  # which NPC is watching (for learning)
            self._ki_blast_ki_target(pid, target_id, npc_id)

        elif msg_type == "activate_barrier":
            self._activate_barrier(pid, data.get("npc_id"))

        elif msg_type == "chat":
            text = data.get("text", "")
            if text:
                self.fx_events.append({
                    "type": "chat",
                    "pid": pid,
                    "text": text[:200],
                    "color": p.get("chatColor", "#cccccc"),
                })
                # Route messages directed at AI rival
                if "@__ai_rival__" in text:
                    from services.ai_player import ai_player
                    clean_text = text.replace("@__ai_rival__", "").strip()
                    ai_player.receive_message(pid, clean_text)

        elif msg_type == "consume_crystal":
            self._consume_crystal(pid, data.get("npc_id"))

        elif msg_type == "build_npc":
            self._try_build_npc(pid, data.get("name"))

        elif msg_type == "interact_world_object":
            wo_id = data.get("wo_id")
            self._try_interact_world_object(pid, wo_id)

        elif msg_type == "craft_equipment":
            eq_id = data.get("equipment_id")
            self._try_craft_equipment(pid, eq_id)

        elif msg_type == "equip_item":
            self._try_equip_item(pid, data.get("equipment_id"))
        elif msg_type == "unequip_item":
            self._try_unequip_item(pid, data.get("slot"))
        elif msg_type == "drop_equipment":
            self._try_drop_equipment(pid, data.get("equipment_id"))
        elif msg_type == "npc_pickup_equipment":
            self._try_npc_pickup_equipment(pid, data.get("npc_id"), data.get("item_id"))

        elif msg_type == "give_npc_equipment":
            self._try_give_npc_equipment(pid, data.get("npc_id"), data.get("equipment_id"))
        elif msg_type == "take_npc_equipment":
            self._try_take_npc_equipment(pid, data.get("npc_id"), data.get("slot"))

        elif msg_type == "carry_npc":
            self._try_carry_npc(pid, data.get("owner_id"), data.get("npc_id"))
        elif msg_type == "carry_own_npc":
            self._try_carry_npc(pid, pid, data.get("npc_id"))
        elif msg_type == "carry_player":
            self._try_carry_player(pid, data.get("target_id"))
        elif msg_type == "drop_carried":
            self._drop_carried(pid)

        elif msg_type == "sync_npcs":
            npcs = data.get("npcs", {})
            self._sync_player_npcs(pid, npcs)

        elif msg_type == "register_background_npc":
            npc_id = data.get("npc_id")
            npc_map = data.get("map", "level_01")
            task = data.get("task", {})
            if npc_id and task:
                self.background_npcs[npc_id] = {
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
            for npc_id, bg in list(self.background_npcs.items()):
                if bg["pid"] == pid and bg["map"] == target_map:
                    removed.append(npc_id)
                    del self.background_npcs[npc_id]
            if removed:
                print(f"[bg] Unregistered background NPCs on {target_map}: {removed}")

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
            if scope in self.xp_multipliers:
                try:
                    new_value = float(data.get("multiplier", value))
                except (TypeError, ValueError):
                    new_value = self.xp_multipliers[scope]
                self.xp_multipliers[scope] = max(0.0, min(100.0, round(new_value, 2)))
        elif field.startswith("inv:"):
            # Inventory items: field = "inv:raw_copper", etc.
            item_id = field[4:]
            inv = actor.setdefault("inventory", {})
            inv[item_id] = max(0, inv.get(item_id, 0) + int(value))
            if inv[item_id] <= 0:
                inv.pop(item_id, None)

    # ── Helpers ────────────────────────────────────────────────────────────────

    def _calc_melee_damage(self, attacker, defender):
        return self.combat._calc_melee_damage(attacker, defender)

    def _get_effective_str(self, actor):
        return self.combat._get_effective_str(actor)

    def _get_effective_def(self, actor):
        return self.combat._get_effective_def(actor)

    def _equipment_stat_bonus(self, actor, stat_key):
        return self.combat._equipment_stat_bonus(actor, stat_key)

    def _get_upgrade_map(self, actor):
        return self.combat._get_upgrade_map(actor)

    def _get_upgrade_value(self, actor, move_id, stat_id):
        return self.combat._get_upgrade_value(actor, move_id, stat_id)

    def _get_blast_range(self, actor):
        return self.combat._get_blast_range(actor)

    def _get_blast_cooldown(self, actor):
        return self.combat._get_blast_cooldown(actor)

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
        mult = float(self.xp_multipliers.get(scope, 1.0) or 0.0)
        return max(0, int(round(base * max(0.0, mult))))

    # ── Barrier ────────────────────────────────────────────────────────────────

    def _get_barrier_stats(self, actor):
        return self.combat._get_barrier_stats(actor)

    def _apply_barrier_reduction(self, target, damage_type, raw_damage):
        return self.combat._apply_barrier_reduction(target, damage_type, raw_damage)

    def _try_spend_plain_ki(self, actor, amount):
        return self.combat._try_spend_plain_ki(actor, amount)

    def _queue_ai_alert(self, pid, message, speech=None, source_pid=None, action=None):
        player = self.players.get(pid)
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

    def _activate_barrier(self, pid, npc_id=None):
        return self.combat._activate_barrier(pid, npc_id)

    # ── Crystal consume ────────────────────────────────────────────────────────

    def _consume_crystal(self, pid, npc_id=None):
        return self.combat._consume_crystal(pid, npc_id)

    # ── Build NPC ──────────────────────────────────────────────────────────────

    def _try_build_npc(self, pid, name=None):
        """Deduct 10 logs and create a basic NPC dict for the player."""
        p = self.players.get(pid)
        if not p or p.get("dead"):
            return
        if p.get("logs", 0) < 10:
            return
        p["logs"] -= 10

        npc_id = f"{pid}_npc_{len(p.get('npc_ids', []))}"
        npc_name = name or npc_id

        col = int(p["x"] / TILE_SIZE) + 2
        row = int(p["y"] / TILE_SIZE)
        nx, ny = tile_pos(col, row)

        npc_state = {
            "id": npc_id,
            "name": npc_name,
            "x": nx, "y": ny,
            "hp": 20, "maxHp": 20,
            "ki": 20, "maxKi": 20,
            "str": 1, "def": 1,
            "level": 1, "xp": 0,
            "logs": 0, "maxLogs": 10,
            "stones": 0,
            "crystals": 0,
            "ki_blast_bonuses": {s: 0 for s in CRYSTAL_UPGRADE_STATS},
            "ki_moves": list(DEFAULT_KI_MOVES),
            "blastLevel": 0,
            "kiSkillLevel": 1,
            "kiSkillXp": 0,
            "barrier_proc_until": 0.0,
            "barrier_proc_facing": "down",
            "knocked_out": False,
            "dead": False,
            "owner": pid,
            "inf_ki": False,
            "map": p.get("map", "level_01"),
        }
        self._ensure_default_ki_moves(npc_state)
        p.setdefault("npcs", {})[npc_id] = npc_state
        p.setdefault("npc_ids", []).append(npc_id)
        print(f"[game_state] {pid} built NPC {npc_id} at ({nx:.0f}, {ny:.0f})")

    # ── NPC sync ───────────────────────────────────────────────────────────────

    def _sync_player_npcs(self, pid, npcs):
        """Sync NPC positions/stats from a client so other clients can see them."""
        p = self.players.get(pid)
        if not p:
            return
        now = time.time()
        for npc_id, npc_data in npcs.items():
            existing = p.get("npcs", {}).get(npc_id)
            if existing and existing.get("hp", 0) != npc_data.get("hp", 0):
                # NPC HP is server-authoritative so combat damage sticks.
                npc_data["hp"] = existing["hp"]
            if existing and not existing.get("knocked_out") and existing.get("hp", 0) > 0 and npc_data.get("hp", 0) <= 0:
                npc_data["hp"] = existing["hp"]
            if existing:
                # Preserve server-authoritative fields
                for field in ("maxHp", "str", "def", "level", "xp", "maxLogs", "ki", "maxKi", "blastLevel",
                             "stones", "crystals", "ki_blast_bonuses", "ki_moves", "inf_ki",
                             "kiSkillLevel", "kiSkillXp", "barrier_proc_until", "barrier_proc_facing",
                             "inventory", "equipment"):
                    if field in existing:
                        npc_data[field] = existing[field]
                if existing.get("has_ki_blast"):
                    npc_data["has_ki_blast"] = True
                # Logs stolen by another NPC — only protect if steal happened recently
                steal_ts = existing.get("_logs_stolen_at", 0)
                if steal_ts and now - steal_ts < 2.0 and existing.get("logs", 0) < npc_data.get("logs", 0):
                    npc_data["logs"] = existing["logs"]
            # Restore has_ki_blast from client stats if server doesn't have it yet
            if not npc_data.get("has_ki_blast") and npc_data.get("hasKiBlast"):
                npc_data["has_ki_blast"] = True
            if existing and existing.get("dead"):
                npc_data["dead"] = True
            if existing and existing.get("knocked_out"):
                npc_data["knocked_out"] = True
                npc_data["knocked_until"] = existing.get("knocked_until")
                npc_data["hp"] = existing.get("hp", 0)
            self._ensure_default_ki_moves(npc_data)
            self._ensure_level_based_ki(npc_data)
            npc_data["owner"] = pid
            p.setdefault("npcs", {})[npc_id] = npc_data

    # ── NPC combat helpers (delegated to CombatService) ─────────────────────

    def _npc_attack_dummy(self, owner_pid, npc_id, dummy_id, npc_str):
        return self.combat._npc_attack_dummy(owner_pid, npc_id, dummy_id, npc_str)

    def _try_attack_player(self, attacker_pid, target_pid):
        return self.combat._try_attack_player(attacker_pid, target_pid)

    def _try_attack_npc(self, attacker_pid, target_owner_pid, target_npc_id):
        return self.combat._try_attack_npc(attacker_pid, target_owner_pid, target_npc_id)

    def _npc_attack_player(self, owner_pid, target_pid, npc_str, npc_id):
        return self.combat._npc_attack_player(owner_pid, target_pid, npc_str, npc_id)

    def _npc_attack_npc(self, owner_pid, attacker_npc_id, target_owner_pid, target_npc_id, npc_str):
        return self.combat._npc_attack_npc(owner_pid, attacker_npc_id, target_owner_pid, target_npc_id, npc_str)

    def _npc_steal_logs(self, owner_pid, attacker_npc_id, target_owner_pid, target_npc_id, npc_str, steal_amount):
        return self.combat._npc_steal_logs(owner_pid, attacker_npc_id, target_owner_pid, target_npc_id, npc_str, steal_amount)

    # ── Ki Blast Combat (delegated to CombatService) ────────────────────────

    def _calc_blast(self, blast_level):
        return self.combat._calc_blast(blast_level)

    def _calc_blast_for_actor(self, actor):
        return self.combat._calc_blast_for_actor(actor)

    def _apply_blast_mode(self, cost, dmg, blast_mode):
        return self.combat._apply_blast_mode(cost, dmg, blast_mode)

    def _calc_ki_damage_taken(self, raw_dmg, target):
        return self.combat._calc_ki_damage_taken(raw_dmg, target)

    def _compute_blast_visual_impact(self, actor, target=None):
        return self.combat._compute_blast_visual_impact(actor, target)

    def _queue_ki_blast_fx(self, actor, target=None, owner_pid=None, npc_id=None):
        return self.combat._queue_ki_blast_fx(actor, target, owner_pid, npc_id)

    def _queue_absorb_fx(self, actor, target, owner_pid=None, npc_id=None):
        return self.combat._queue_absorb_fx(actor, target, owner_pid, npc_id)

    def _try_ki_spend(self, entity, cost):
        return self.combat._try_ki_spend(entity, cost)

    def _get_actor_for_absorb(self, actor_pid, actor_npc_id=None):
        return self.combat._get_actor_for_absorb(actor_pid, actor_npc_id)

    def _start_player_absorb(self, attacker_pid, target_owner_pid, target_npc_id):
        return self.combat._start_player_absorb(attacker_pid, target_owner_pid, target_npc_id)

    def _start_npc_absorb(self, owner_pid, npc_id, target_owner_pid, target_npc_id):
        return self.combat._start_npc_absorb(owner_pid, npc_id, target_owner_pid, target_npc_id)

    def _start_absorb(self, actor_pid, actor_npc_id, target_owner_pid, target_npc_id):
        return self.combat._start_absorb(actor_pid, actor_npc_id, target_owner_pid, target_npc_id)

    def _resolve_pending_absorb(self, absorb):
        return self.combat._resolve_pending_absorb(absorb)

    def _ki_blast_player(self, attacker_pid, target_pid, blast_mode=""):
        return self.combat._ki_blast_player(attacker_pid, target_pid, blast_mode)

    def _ki_blast_npc(self, attacker_pid, target_owner_pid, target_npc_id, blast_mode=""):
        return self.combat._ki_blast_npc(attacker_pid, target_owner_pid, target_npc_id, blast_mode)

    def _ki_blast_dummy(self, pid, dummy_id, blast_mode=""):
        return self.combat._ki_blast_dummy(pid, dummy_id, blast_mode)

    def _ki_blast_ground_item(self, pid, item_id, blast_mode=""):
        return self.combat._ki_blast_ground_item(pid, item_id, blast_mode)

    def _npc_ki_blast_player(self, owner_pid, npc_id, target_pid):
        return self.combat._npc_ki_blast_player(owner_pid, npc_id, target_pid)

    def _npc_ki_blast_npc(self, owner_pid, attacker_npc_id, target_owner_pid, target_npc_id):
        return self.combat._npc_ki_blast_npc(owner_pid, attacker_npc_id, target_owner_pid, target_npc_id)

    # ── Knockout / Respawn (delegated to CombatService) ───────────────────────

    def _knockout_duration(self):
        return self.combat._knockout_duration()

    def _drop_player_resource(self, target, resource_key, resource_name):
        return self.combat._drop_player_resource(target, resource_key, resource_name)

    def _apply_player_knockout_penalty(self, target):
        return self.combat._apply_player_knockout_penalty(target)

    def _knock_out_player(self, target):
        return self.combat._knock_out_player(target)

    def _knock_out_npc(self, npc_state, attacker_pid=None):
        return self.combat._knock_out_npc(npc_state, attacker_pid)

    def _kill_player(self, target, killer=None):
        return self.combat._kill_player(target, killer)

    # ── Tree chopping (delegated to ResourceService) ──────────────────────────

    def _npc_chop(self, tree_id, owner_id, npc_id=None):
        return self.resources._npc_chop(tree_id, owner_id, npc_id)

    def _try_attack_animal(self, pid, animal_id):
        return self.combat._try_attack_animal(pid, animal_id)

    def _try_plant_seed(self, pid, x, y):
        return self.resources._try_plant_seed(pid, x, y)

    def _try_harvest_crop(self, pid, crop_id):
        return self.resources._try_harvest_crop(pid, crop_id)

    def _try_chop(self, pid, tree_id):
        return self.resources._try_chop(pid, tree_id)

    # ── Rock spawning & mining (delegated to ResourceService) ─────────────────

    def _spawn_rocks(self):
        return self.resources._spawn_rocks()

    def _try_mine_rock(self, pid, rock_id):
        return self.resources._try_mine_rock(pid, rock_id)

    # ── World Objects (delegated to ResourceService) ───────────────────────────

    def _try_interact_world_object(self, pid, wo_id):
        return self.resources._try_interact_world_object(pid, wo_id)

    def _npc_interact_world_object(self, pid, npc_id, wo_id):
        return self.resources._npc_interact_world_object(pid, npc_id, wo_id)

    # ── Cave Mining (delegated to ResourceService) ────────────────────────────

    def _get_or_create_mine(self, pid: str):
        return self.resources._get_or_create_mine(pid)

    def _try_mine_tile(self, pid: str, col: int, row: int):
        return self.resources._try_mine_tile(pid, col, row)

    def get_mine_tiles_for_player(self, pid: str):
        return self.resources.get_mine_tiles_for_player(pid)

    def _npc_deposit_to_crate(self, pid, npc_id, building_id, resource, amount):
        return self.resources._npc_deposit_to_crate(pid, npc_id, building_id, resource, amount)

    # ── Carry System ────────────────────────────────────────────────────────────

    def _try_carry_npc(self, pid, owner_id, npc_id):
        """Player picks up a knocked-out NPC."""
        p = self.players.get(pid)
        if not p or p.get("dead") or p.get("knocked_out"):
            return
        if p.get("_carrying"):
            return  # already carrying something
        owner = self.players.get(owner_id)
        if not owner:
            return
        npc = owner.get("npcs", {}).get(npc_id)
        if not npc or not npc.get("knocked_out"):
            return
        # Range check
        if dist(p["x"], p["y"], npc["x"], npc["y"]) > TILE_SIZE * 2:
            return
        p["_carrying"] = {"type": "npc", "owner_id": owner_id, "npc_id": npc_id}
        npc["carried_by"] = pid

    def _try_carry_player(self, pid, target_id):
        """Player picks up a knocked-out player."""
        p = self.players.get(pid)
        if not p or p.get("dead") or p.get("knocked_out"):
            return
        if p.get("_carrying"):
            return
        target = self.players.get(target_id)
        if not target or not target.get("knocked_out"):
            return
        if dist(p["x"], p["y"], target["x"], target["y"]) > TILE_SIZE * 2:
            return
        p["_carrying"] = {"type": "player", "target_id": target_id}
        target["carried_by"] = pid

    def _drop_carried(self, pid):
        """Drop whatever the player is carrying."""
        p = self.players.get(pid)
        if not p:
            return
        carrying = p.pop("_carrying", None)
        if not carrying:
            return
        if carrying["type"] == "npc":
            owner = self.players.get(carrying["owner_id"])
            if owner:
                npc = owner.get("npcs", {}).get(carrying["npc_id"])
                if npc:
                    npc.pop("carried_by", None)
        elif carrying["type"] == "player":
            target = self.players.get(carrying["target_id"])
            if target:
                target.pop("carried_by", None)

    def _try_craft_equipment(self, pid, eq_id):
        """Attempt to craft and equip a piece of equipment at an anvil."""
        p = self.players.get(pid)
        if not p or not eq_id:
            return
        eq_def = asset_registry.get_equipment(eq_id)
        if not eq_def:
            return
        # Must be near an anvil
        near_anvil = False
        for anvil in self.anvils.values():
            if anvil.get("dead"):
                continue
            if dist(p["x"], p["y"], anvil["x"], anvil["y"]) <= TILE_SIZE * 2:
                near_anvil = True
                break
        if not near_anvil:
            self.fx_events.append({"type": "chat_hint", "pid": pid,
                                   "text": "Must be near an anvil to craft."})
            return
        # Level check
        if p.get("level", 1) < eq_def.recipe.required_level:
            self.fx_events.append({"type": "chat_hint", "pid": pid,
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
                self.fx_events.append({"type": "chat_hint", "pid": pid,
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
        self.fx_events.append({"type": "chat_hint", "pid": pid,
                               "text": f"Crafted {eq_def.label}! (added to inventory)"})

    # ── Equipment inventory ────────────────────────────────────────────────────

    def _try_equip_item(self, pid, eq_id):
        """Equip an equipment item from player inventory."""
        p = self.players.get(pid)
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
        self.fx_events.append({"type": "chat_hint", "pid": pid,
                               "text": f"Equipped {eq_def.label}."})

    def _try_unequip_item(self, pid, slot):
        """Unequip an item from a slot back to inventory."""
        p = self.players.get(pid)
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
        self.fx_events.append({"type": "chat_hint", "pid": pid,
                               "text": f"Unequipped {label}."})

    def _try_drop_equipment(self, pid, eq_id):
        """Drop an equipment item from inventory onto the ground."""
        p = self.players.get(pid)
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
        self.ground_items.append({
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
        self.fx_events.append({"type": "chat_hint", "pid": pid,
                               "text": f"Dropped {label}."})

    def _try_npc_pickup_equipment(self, pid, npc_id, item_id):
        """Have an owned NPC pick up a dropped equipment item and equip it."""
        p = self.players.get(pid)
        if not p or not npc_id or not item_id:
            return
        npc = p.get("npcs", {}).get(npc_id)
        if not npc or npc.get("dead") or npc.get("knocked_out"):
            return
        # Find the ground item
        gi = None
        for item in self.ground_items:
            if item["id"] == item_id and item.get("_equipment"):
                gi = item
                break
        if not gi:
            return
        # Range check
        if dist(npc["x"], npc["y"], gi["x"], gi["y"]) > TILE_SIZE * 2.5:
            self.fx_events.append({"type": "chat_hint", "pid": pid,
                                   "text": "NPC is too far from the item."})
            return
        eq_id = gi["resource"]
        eq_def = asset_registry.get_equipment(eq_id)
        if not eq_def:
            return
        # Remove ground item
        self.ground_items = [i for i in self.ground_items if i["id"] != item_id]
        # Equip on NPC (swap old if needed)
        npc_eq = npc.setdefault("equipment", {})
        old_eq = npc_eq.get(eq_def.slot)
        if old_eq:
            # Drop old equipment on ground
            old_def = asset_registry.get_equipment(old_eq)
            col = int(npc["x"] // TILE_SIZE)
            row = int(npc["y"] // TILE_SIZE)
            tx, ty = tile_pos(col, row)
            self.ground_items.append({
                "id": _gen_item_id(),
                "x": tx, "y": ty,
                "resource": old_eq,
                "amount": 1,
                "_placed": True,
                "_equipment": True,
                "map": p.get("map", "level_01"),
            })
        npc_eq[eq_def.slot] = eq_id
        label = eq_def.label if eq_def else eq_id
        self.fx_events.append({"type": "chat_hint", "pid": pid,
                               "text": f"NPC equipped {label}."})

    def _try_give_npc_equipment(self, pid, npc_id, eq_id):
        """Player gives equipment from their inventory to an owned NPC."""
        p = self.players.get(pid)
        if not p or not npc_id or not eq_id or p.get("dead"):
            return
        npc = p.get("npcs", {}).get(npc_id)
        if not npc or npc.get("dead") or npc.get("knocked_out"):
            return
        inv = p.get("inventory", {})
        if inv.get(eq_id, 0) < 1:
            self.fx_events.append({"type": "chat_hint", "pid": pid,
                                   "text": "You don't have that item."})
            return
        eq_def = asset_registry.get_equipment(eq_id)
        if not eq_def:
            return
        # Remove from player inventory
        inv[eq_id] = inv.get(eq_id, 0) - 1
        if inv[eq_id] <= 0:
            del inv[eq_id]
        # Equip on NPC (swap old to player inventory)
        npc_eq = npc.setdefault("equipment", {})
        old_eq = npc_eq.get(eq_def.slot)
        if old_eq:
            inv[old_eq] = inv.get(old_eq, 0) + 1
        npc_eq[eq_def.slot] = eq_id
        label = eq_def.label if eq_def else eq_id
        self.fx_events.append({"type": "chat_hint", "pid": pid,
                               "text": f"Gave {label} to NPC."})

    def _try_take_npc_equipment(self, pid, npc_id, slot):
        """Player takes equipment back from an owned NPC."""
        p = self.players.get(pid)
        if not p or not npc_id or not slot or p.get("dead"):
            return
        npc = p.get("npcs", {}).get(npc_id)
        if not npc:
            return
        npc_eq = npc.get("equipment", {})
        eq_id = npc_eq.get(slot)
        if not eq_id:
            return
        del npc_eq[slot]
        inv = p.setdefault("inventory", {})
        inv[eq_id] = inv.get(eq_id, 0) + 1
        eq_def = asset_registry.get_equipment(eq_id)
        label = eq_def.label if eq_def else eq_id
        self.fx_events.append({"type": "chat_hint", "pid": pid,
                               "text": f"Took {label} from NPC."})

    # ── Dummy ──────────────────────────────────────────────────────────────────

    def _try_attack_dummy(self, pid, dummy_id):
        return self.combat._try_attack_dummy(pid, dummy_id)

    def _try_build_dummy(self, pid, logs_used):
        return self.building._try_build_dummy(pid, logs_used)

    # ── Ki Targets ─────────────────────────────────────────────────────────────

    def _try_build_ki_target(self, pid, x=None, y=None):
        return self.building._try_build_ki_target(pid, x, y)

    def _ki_blast_ki_target(self, pid, target_id, watching_npc_id=None):
        return self.combat._ki_blast_ki_target(pid, target_id, watching_npc_id)

    def _npc_ki_blast_ki_target(self, owner_pid, npc_id, target_id):
        return self.combat._npc_ki_blast_ki_target(owner_pid, npc_id, target_id)

    # ── Minecart Portal ────────────────────────────────────────────────────────

    def _handle_minecart_portal(self, pid, data):
        return self.building._handle_minecart_portal(pid, data)

    # ── Anvil / Refining ───────────────────────────────────────────────────────

    def _place_building(self, pid, data):
        return self.building._place_building(pid, data)

    def _is_barrier_tile(self, x, y, pid):
        return self.building._is_barrier_tile(x, y, pid)

    def _try_attack_fence(self, pid, bid):
        return self.combat._try_attack_fence(pid, bid)

    def _try_build_anvil(self, pid):
        return self.building._try_build_anvil(pid)

    # ── Anvil / Refining (delegated to ResourceService) ────────────────────────

    def _try_refine_rock(self, pid, anvil_id, npc_id=None):
        return self.resources._try_refine_rock(pid, anvil_id, npc_id)

    def _npc_refine_rock(self, pid, npc_id, anvil_id):
        return self.resources._npc_refine_rock(pid, npc_id, anvil_id)

    # ── NPC stone pickup (delegated to ResourceService) ────────────────────────

    def _npc_pickup_stone(self, pid, npc_id, item_id):
        return self.resources._npc_pickup_stone(pid, npc_id, item_id)

    def _npc_mine_rock(self, pid, npc_id, rock_id):
        return self.resources._npc_mine_rock(pid, npc_id, rock_id)

    def _npc_pickup_stone_tile(self, pid, npc_id, x, y):
        return self.resources._npc_pickup_stone_tile(pid, npc_id, x, y)

    def _npc_give_materials(self, pid, npc_id):
        return self.resources._npc_give_materials(pid, npc_id)

    # ── Drop / Pickup Helpers (delegated to ResourceService) ──────────────────

    def _tile_key(self, x, y):
        return self.resources._tile_key(x, y)

    def _find_ground_item(self, item_id):
        return self.resources._find_ground_item(item_id)

    def _is_log_item(self, item):
        return self.resources._is_log_item(item)

    def _is_stone_item(self, item):
        return self.resources._is_stone_item(item)

    def _try_drop_item(self, pid, data):
        return self.resources._try_drop_item(pid, data)

    def _try_pickup_placed(self, pid, item_id):
        return self.resources._try_pickup_placed(pid, item_id)

    # ── Building processing (delegated to BuildingService) ──────────────────

    def _building_at(self, col, row, map_name):
        return self.building._building_at(col, row, map_name)

    def _tick_buildings(self, dt, now):
        return self.building._tick_buildings(dt, now)


    # ── Background NPC worker simulation ──────────────────────────────────────

    BG_NPC_MINE_INTERVAL = 3.0   # seconds between mine actions
    BG_NPC_MAX_INVENTORY = 10    # max items before depositing

    def _tick_background_npcs(self, now):
        """Simulate NPC tasks while the player is on a different map."""
        for npc_id, bg in list(self.background_npcs.items()):
            elapsed = now - bg["last_tick"]
            if elapsed < self.BG_NPC_MINE_INTERVAL:
                continue
            bg["last_tick"] = now

            pid = bg["pid"]
            p = self.players.get(pid)
            if not p:
                continue
            npc_state = p.get("npcs", {}).get(npc_id)
            if not npc_state or npc_state.get("dead") or npc_state.get("knocked_out"):
                continue

            task = bg["task"]
            task_type = task.get("task", "")
            npc_map = bg["map"]
            npc_inv = npc_state.setdefault("inventory", {})
            total_inv = sum(npc_inv.values())

            if task_type in ("custom_task", "mine_ore"):
                # Phase: deposit if full
                if total_inv >= self.BG_NPC_MAX_INVENTORY:
                    self._bg_npc_deposit(npc_state, npc_inv, task, npc_map)
                    continue

                # Phase: mine — find a non-depleted world object on this map
                ore_asset_ids = task.get("ore_asset_ids", [])
                mined = False
                for wo_id, wo in WORLD_OBJECT_INSTANCES.items():
                    if wo["depleted"]:
                        continue
                    if wo["map"] != npc_map:
                        continue
                    if ore_asset_ids and wo["asset_id"] not in ore_asset_ids:
                        continue
                    # Mine it
                    wo_def = asset_registry.get_world_object(wo["asset_id"])
                    if not wo_def:
                        continue
                    wo["hp"] -= 1
                    for drop in wo_def.drops:
                        amount = random.randint(drop.min, drop.max)
                        npc_inv[drop.resource] = npc_inv.get(drop.resource, 0) + amount
                    if wo["hp"] <= 0:
                        wo["depleted"] = True
                        respawn_secs = random.uniform(wo_def.respawn_min, wo_def.respawn_max)
                        wo["respawn_at"] = now + respawn_secs
                    mined = True
                    break
                # If nothing to mine, just wait (ores will respawn)

    def _bg_npc_deposit(self, npc_state, npc_inv, task, npc_map):
        """Background NPC deposits inventory into matching crates."""
        crate_bids = task.get("crate_building_ids", [])
        crate_labels = task.get("crate_labels", [])

        for resource, qty in list(npc_inv.items()):
            if qty <= 0:
                continue
            deposited = False

            # Try specified crates first
            for i, bid in enumerate(crate_bids):
                b = self.buildings.get(bid)
                if not b or b.get("map", "level_01") != npc_map:
                    continue
                lbl = (crate_labels[i] if i < len(crate_labels) else "") or b.get("label", "")
                label_key = "Wood" if lbl == "logs" else lbl
                if lbl and resource.lower() != label_key.lower():
                    continue
                stored = b.setdefault("stored", {})
                stored[resource] = stored.get(resource, 0) + qty
                npc_inv[resource] = 0
                deposited = True
                break

            # Fallback: find any crate on this map with matching label
            if not deposited:
                for bid, b in self.buildings.items():
                    if b["kind"] != "crate" or b.get("map", "level_01") != npc_map:
                        continue
                    lbl = b.get("label", "")
                    label_key = "Wood" if lbl == "logs" else lbl
                    if lbl and resource.lower() != label_key.lower():
                        continue
                    stored = b.setdefault("stored", {})
                    stored[resource] = stored.get(resource, 0) + qty
                    npc_inv[resource] = 0
                    break

        # Clean empty entries
        for k in list(npc_inv.keys()):
            if npc_inv[k] <= 0:
                del npc_inv[k]

    # ── Tick ───────────────────────────────────────────────────────────────────

    def tick(self, dt: float):
        """Advance simulation by dt seconds."""
        now = time.time()
        animal_manager.tick(dt)
        crop_manager.tick(dt)

        # Respawn dead players
        for p in self.players.values():
            if p.get("dead") and p.get("respawn_at") and now >= p["respawn_at"]:
                p["dead"] = False
                p["hp"] = p["maxHp"]
                p["ki"] = p.get("maxKi", KI_MAX_BASE)
                p["respawn_at"] = None
                # Respawn at center
                sx, sy = tile_pos(10, 10)
                p["x"] = sx + random.randint(-48, 48)
                p["y"] = sy + random.randint(-48, 48)

        # Knockout recovery — players
        for p in self.players.values():
            if p.get("knocked_out") and p.get("knocked_until") and now >= p["knocked_until"]:
                p["knocked_out"] = False
                p["knocked_until"] = None
                p["hp"] = max(1, p["maxHp"] // 2)
                # Auto-drop if being carried
                if p.get("carried_by"):
                    carrier = self.players.get(p["carried_by"])
                    if carrier:
                        carrier.pop("_carrying", None)
                    p.pop("carried_by", None)

        # Knockout recovery — NPCs
        for owner in self.players.values():
            for npc in owner.get("npcs", {}).values():
                if npc.get("knocked_out") and npc.get("knocked_until") and now >= npc["knocked_until"]:
                    npc["knocked_out"] = False
                    npc["knocked_until"] = None
                    npc["hp"] = max(1, npc.get("maxHp", 1) // 2)
                    # Auto-drop if being carried
                    if npc.get("carried_by"):
                        carrier = self.players.get(npc["carried_by"])
                        if carrier:
                            carrier.pop("_carrying", None)
                        npc.pop("carried_by", None)

        # Carry position sync — carried entities follow their carrier
        for carry_pid, p in self.players.items():
            carrying = p.get("_carrying")
            if not carrying:
                continue
            if carrying["type"] == "npc":
                owner = self.players.get(carrying["owner_id"])
                target = owner.get("npcs", {}).get(carrying["npc_id"]) if owner else None
            elif carrying["type"] == "player":
                target = self.players.get(carrying["target_id"])
            else:
                target = None
            if not target:
                p.pop("_carrying", None)
                continue
            # If target woke up, drop them
            if not target.get("knocked_out"):
                target.pop("carried_by", None)
                p.pop("_carrying", None)
                continue
            # Move carried entity to carrier position (offset slightly)
            target["x"] = p["x"]
            target["y"] = p["y"] - 10

        # Ki regen — scales with level.
        if self.pending_absorbs:
            remaining_absorbs = []
            for absorb in self.pending_absorbs:
                if now >= absorb.get("resolve_at", 0):
                    self._resolve_pending_absorb(absorb)
                else:
                    remaining_absorbs.append(absorb)
            self.pending_absorbs = remaining_absorbs

        KI_REGEN_BASE = 1.0 / 15.0
        KI_REGEN_LEVEL_SCALE = 1.08

        for p in self.players.values():
            if p.get("dead") or p.get("knocked_out"):
                continue
            ki = p.get("ki", 0)
            maxKi = p.get("maxKi", KI_MAX_BASE)
            if ki < maxKi:
                level = max(1, p.get("level", 1))
                ki_level = max(1, int(p.get("kiSkillLevel", 1) or 1))
                rate = KI_REGEN_BASE * (KI_REGEN_LEVEL_SCALE ** (level - 1)) * (1 + (ki_level - 1) * 0.15)
                p["_ki_regen_accum"] = p.get("_ki_regen_accum", 0.0) + rate * dt
                if p["_ki_regen_accum"] >= 1.0:
                    regen = min(int(p["_ki_regen_accum"]), maxKi - ki)
                    p["ki"] = ki + regen
                    p["_ki_regen_accum"] -= regen
            else:
                p["_ki_regen_accum"] = 0.0

        for owner in self.players.values():
            for npc in owner.get("npcs", {}).values():
                if npc.get("dead") or npc.get("knocked_out"):
                    continue
                ki = npc.get("ki", 0)
                maxKi = npc.get("maxKi", KI_MAX_BASE)
                if ki < maxKi:
                    level = max(1, npc.get("level", 1))
                    ki_level = max(1, int(npc.get("kiSkillLevel", 1) or 1))
                    rate = KI_REGEN_BASE * (KI_REGEN_LEVEL_SCALE ** (level - 1)) * (1 + (ki_level - 1) * 0.15)
                    npc["_ki_regen_accum"] = npc.get("_ki_regen_accum", 0.0) + rate * dt
                    if npc["_ki_regen_accum"] >= 1.0:
                        regen = min(int(npc["_ki_regen_accum"]), maxKi - ki)
                        npc["ki"] = ki + regen
                        npc["_ki_regen_accum"] -= regen
                else:
                    npc["_ki_regen_accum"] = 0.0

        # Campfire aura — bonus HP regen + boosted ki regen for nearby actors
        expired_campfires = []
        for cid, cf in self.campfires.items():
            if cf.get("dead"):
                expired_campfires.append(cid)
                continue
            elapsed = now - cf["lit_at"]
            if elapsed >= cf["duration"]:
                cf["dead"] = True
                expired_campfires.append(cid)
                continue
            # Apply regen aura to nearby players and NPCs
            cx, cy = cf["x"], cf["y"]
            for p in self.players.values():
                if p.get("dead") or p.get("knocked_out"):
                    continue
                d = dist(p["x"], p["y"], cx, cy)
                if d <= CAMPFIRE_RADIUS:
                    # Bonus HP regen
                    hp = p.get("hp", 0)
                    maxHp = p.get("maxHp", 20)
                    if hp < maxHp:
                        p["_campfire_hp_accum"] = p.get("_campfire_hp_accum", 0.0) + CAMPFIRE_HP_REGEN * dt
                        if p["_campfire_hp_accum"] >= 1.0:
                            heal = min(int(p["_campfire_hp_accum"]), maxHp - hp)
                            p["hp"] = hp + heal
                            p["_campfire_hp_accum"] -= heal
                    # Bonus ki regen (extra tick on top of normal regen)
                    ki = p.get("ki", 0)
                    maxKi = p.get("maxKi", KI_MAX_BASE)
                    if ki < maxKi:
                        level = max(1, p.get("level", 1))
                        bonus_rate = KI_REGEN_BASE * (KI_REGEN_LEVEL_SCALE ** (level - 1))
                        p["_ki_regen_accum"] = p.get("_ki_regen_accum", 0.0) + bonus_rate * dt
                # NPC aura
                for npc in p.get("npcs", {}).values():
                    if npc.get("dead") or npc.get("knocked_out"):
                        continue
                    nd = dist(npc.get("x", 0), npc.get("y", 0), cx, cy)
                    if nd <= CAMPFIRE_RADIUS:
                        nhp = npc.get("hp", 0)
                        nmaxHp = npc.get("maxHp", 20)
                        if nhp < nmaxHp:
                            npc["_campfire_hp_accum"] = npc.get("_campfire_hp_accum", 0.0) + CAMPFIRE_HP_REGEN * dt
                            if npc["_campfire_hp_accum"] >= 1.0:
                                heal = min(int(npc["_campfire_hp_accum"]), nmaxHp - nhp)
                                npc["hp"] = nhp + heal
                                npc["_campfire_hp_accum"] -= heal
                        nki = npc.get("ki", 0)
                        nmaxKi = npc.get("maxKi", KI_MAX_BASE)
                        if nki < nmaxKi:
                            nlevel = max(1, npc.get("level", 1))
                            bonus_rate = KI_REGEN_BASE * (KI_REGEN_LEVEL_SCALE ** (nlevel - 1))
                            npc["_ki_regen_accum"] = npc.get("_ki_regen_accum", 0.0) + bonus_rate * dt
        for cid in expired_campfires:
            del self.campfires[cid]

        # Move players
        world_w = MAP_COLS * TILE_SIZE
        world_h = MAP_ROWS * TILE_SIZE
        for move_pid, p in self.players.items():
            if p.get("dead") or p.get("knocked_out"):
                p["vx"] = 0
                p["vy"] = 0
                continue
            if p.get("punching"):
                if now >= p.get("punch_until", 0):
                    p["punching"] = False
                p["vx"] = 0
                p["vy"] = 0
            else:
                new_x = p["x"] + p["vx"] * dt
                new_y = p["y"] + p["vy"] * dt

                player_map = p.get("map", "level_01")
                if player_map == "cave_01":
                    # Cave: expanded bounds for mine grid (-15..55 tiles)
                    from services.mine_state import GRID_MIN, GRID_MAX
                    mine_min = GRID_MIN * TILE_SIZE
                    mine_max = GRID_MAX * TILE_SIZE
                    new_x = max(mine_min, min(mine_max, new_x))
                    new_y = max(mine_min, min(mine_max, new_y))
                    # Mine wall collision
                    mg = self.mine_grids.get(move_pid)
                    if mg:
                        dest_col = int(new_x // TILE_SIZE)
                        dest_row = int(new_y // TILE_SIZE)
                        if not mg.is_tile_open(dest_col, dest_row):
                            cur_col = int(p["x"] // TILE_SIZE)
                            cur_row = int(p["y"] // TILE_SIZE)
                            # Only block if we're currently on an open tile
                            # (prevents getting permanently stuck)
                            if mg.is_tile_open(cur_col, cur_row):
                                # Try sliding along X (keep new_x, revert Y)
                                if mg.is_tile_open(dest_col, cur_row):
                                    new_y = p["y"]
                                # Try sliding along Y (revert X, keep new_y)
                                elif mg.is_tile_open(cur_col, dest_row):
                                    new_x = p["x"]
                                # Fully blocked
                                else:
                                    new_x = p["x"]
                                    new_y = p["y"]
                else:
                    new_x = max(0, min(world_w, new_x))
                    new_y = max(0, min(world_h, new_y))
                    # Collision tile check with axis sliding
                    if COLLISION_TILES and _is_collision_tile(new_x, new_y):
                        # Try sliding along X only
                        if not _is_collision_tile(new_x, p["y"]):
                            new_y = p["y"]
                        # Try sliding along Y only
                        elif not _is_collision_tile(p["x"], new_y):
                            new_x = p["x"]
                        # Fully blocked
                        else:
                            new_x = p["x"]
                            new_y = p["y"]
                # Fence/gate collision with axis sliding
                if self._is_barrier_tile(new_x, new_y, move_pid):
                    if not self._is_barrier_tile(new_x, p["y"], move_pid):
                        new_y = p["y"]
                    elif not self._is_barrier_tile(p["x"], new_y, move_pid):
                        new_x = p["x"]
                    else:
                        new_x = p["x"]
                        new_y = p["y"]
                p["x"] = new_x
                p["y"] = new_y
                # Portal check
                portal = _check_portal(p)
                if portal:
                    tx, ty = tile_pos(portal["spawn_col"], portal["spawn_row"])
                    p["x"] = tx
                    p["y"] = ty
                    p["map"] = portal["to_map"]
                    p["vx"] = 0
                    p["vy"] = 0

        # Move NPCs with _move_target (server-side NPC movement for AI-owned NPCs)
        for npc_owner_pid, owner in self.players.items():
            for npc in owner.get("npcs", {}).values():
                if npc.get("dead") or npc.get("knocked_out"):
                    continue
                mt = npc.get("_move_target")
                if not mt:
                    continue
                tx, ty = mt
                dx_npc = tx - npc["x"]
                dy_npc = ty - npc["y"]
                d = (dx_npc * dx_npc + dy_npc * dy_npc) ** 0.5
                if d < 20:  # arrival threshold
                    npc["x"] = tx
                    npc["y"] = ty
                    npc.pop("_move_target", None)
                    # Fire on_arrive callback
                    cb = npc.pop("_on_arrive", None)
                    if cb:
                        cb()
                else:
                    speed = NPC_SPEED * dt
                    new_nx = npc["x"] + (dx_npc / d) * speed
                    new_ny = npc["y"] + (dy_npc / d) * speed
                    # Fence/gate collision for NPCs (owner's gates let them through)
                    if self._is_barrier_tile(new_nx, new_ny, npc_owner_pid):
                        if not self._is_barrier_tile(new_nx, npc["y"], npc_owner_pid):
                            new_ny = npc["y"]
                        elif not self._is_barrier_tile(npc["x"], new_ny, npc_owner_pid):
                            new_nx = npc["x"]
                        else:
                            new_nx = npc["x"]
                            new_ny = npc["y"]
                    npc["x"] = new_nx
                    npc["y"] = new_ny
                npc.setdefault("map", "level_01")
                portal = _check_portal(npc)
                if portal:
                    tx2, ty2 = tile_pos(portal["spawn_col"], portal["spawn_row"])
                    npc["x"] = tx2
                    npc["y"] = ty2
                    npc["map"] = portal["to_map"]
                    npc.pop("_move_target", None)

        # Pickup ground items (skip dead or knocked-out players)
        now = time.time()
        for p in self.players.values():
            if p.get("dead") or p.get("knocked_out"):
                continue
            remaining = []
            for item in self.ground_items:
                if item.get("_placed"):
                    remaining.append(item)
                    continue
                if item.get("_drop_immunity") and now < item["_drop_immunity"]:
                    remaining.append(item)
                    continue
                d = dist(p["x"], p["y"], item["x"], item["y"])
                if d <= PICKUP_DIST:
                    if item.get("resource") == "Stone":
                        p["stones"] = p.get("stones", 0) + item.get("amount", 1)
                    else:
                        p["logs"] += item.get("amount", 1)
                else:
                    remaining.append(item)
            self.ground_items = remaining

        # Tree regrowth
        for tree in self.trees:
            if tree["chopped"] and tree["regrow_at"] and now >= tree["regrow_at"]:
                tree["chopped"] = False
                tree["regrow_at"] = None

        # Rock despawn (unmined rocks past their lifespan)
        self.rocks = [r for r in self.rocks if not (not r["mined"] and now >= r["despawn_at"])]
        self.rocks = [r for r in self.rocks if not r["mined"]]

        # Rock spawn check (every ROCK_SPAWN_INTERVAL seconds)
        if now - self._last_rock_spawn >= ROCK_SPAWN_INTERVAL:
            self._spawn_rocks()

        # World object respawn
        for wo in WORLD_OBJECT_INSTANCES.values():
            if wo["depleted"] and wo["respawn_at"] and now >= wo["respawn_at"]:
                wo_def = asset_registry.get_world_object(wo["asset_id"])
                wo["depleted"] = False
                wo["hp"] = wo_def.hp if wo_def else wo["maxHp"]
                wo["respawn_at"] = None

        # Clean up dead dummies
        to_remove = [did for did, d in self.dummies.items() if d["dead"]]
        for did in to_remove:
            del self.dummies[did]

        # Clean up dead anvils
        to_remove = [aid for aid, a in self.anvils.items() if a.get("dead")]
        for aid in to_remove:
            del self.anvils[aid]

        # ── Server-side building processing (log cutters, tracks) ─────────
        self._tick_buildings(dt, now)

        # ── Background NPC workers (mine/deposit while player is on another map) ──
        self._tick_background_npcs(now)

        # Periodic save to DB (every 30 seconds)
        if now - self._last_save >= 30:
            self._last_save = now
            self.save_world()

    def snapshot(self):
        """Full world state for a joining player."""
        return {
            "type": "snapshot",
            "players": self.players,
            "trees": self.trees,
            "rocks": self.rocks,
            "ground_items": self.ground_items,
            "dummies": self.dummies,
            "anvils": self.anvils,
            "campfires": self.campfires,
            "animals": animal_manager.get_all(),
            "crops": crop_manager.get_all(),
        }

    def delta(self):
        """Compact state sent every tick."""
        return {
            "type": "state",
            "players": self.players,
            "trees": [t for t in self.trees if t["chopped"] or t.get("_just_regrew")],
            "rocks": self.rocks,
            "ground_items": self.ground_items,
            "dummies": self.dummies,
            "anvils": self.anvils,
            "campfires": self.campfires,
            "animals": animal_manager.get_all(),
            "crops": crop_manager.get_all(),
        }


# Singleton
game = GameState()
