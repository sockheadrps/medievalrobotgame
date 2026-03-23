# Map Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the map system into per-player home maps, a shared central map, and personal caves with instanced state management.

**Architecture:** Convert flat entity storage (trees, buildings, etc.) to per-map dicts. Add instance load/save via a new DB table. Build dynamic portal registry for player home entrances on the central map perimeter. Update broadcast layer to filter all entities by recipient map.

**Tech Stack:** Python/FastAPI server, SQLite DB, Phaser 3 client, WebSocket state sync

**Spec:** `docs/superpowers/specs/2026-03-22-map-architecture-design.md`

---

## File Structure

### New Files
- `auxserver/maps/home.json` — 50x50 home map template
- `auxserver/maps/home_collision.json` — collision tiles for home template
- `auxserver/maps/home_items.json` — portal items (cave entrance west, central exit east, spawn center)
- `auxserver/maps/central.json` — 150x150 shared central map
- `auxserver/maps/central_collision.json` — collision tiles for central map
- `auxserver/maps/central_items.json` — spawn point, resource zones
- `auxserver/services/instance_manager.py` — instance load/save/unload, tree init per map

### Modified Files
- `auxserver/services/game_state.py` — trees/rocks from flat list to `dict[str, list]`, tick iterates active maps
- `auxserver/services/world_data.py` — mutable `_player_portals`, `register_player_portal()`, `get_all_portals()`
- `auxserver/services/portals.py` — `check_portal()` uses `get_all_portals()` instead of static `PORTALS`
- `auxserver/services/player_manager.py` — `central_portal_col/row` fields, portal assignment algorithm
- `auxserver/services/database.py` — v3 migration: `instance_state` table
- `auxserver/api/ws.py` — remove `on_overworld` guard, per-map entity filtering, NPC recall on disconnect, welcome snapshot filtering
- `auxserver/services/map_service.py` — `map_file_path()` resolves `home_*` → `home.json`, `cave_*` → `cave_01.json`
- `auxserver/services/portals.py` — `get_spawn_point_for_map()` resolves instance names to template items files
- `auxserver/api/maps.py` — `wipe_map()` updated to use instance manager
- `src/systems/MapManager.js` — `cave_01` check → `startsWith('cave_')`, home template caching

---

## Task 1: DB Schema — `instance_state` Table

**Files:**
- Modify: `auxserver/services/database.py`

- [ ] **Step 1: Add v3 migration with `instance_state` table**

In `database.py`, after the v2 migration block, add:

```python
def _migrate_v3(conn):
    """Add instance_state table for per-map entity storage."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS instance_state (
            map_key TEXT PRIMARY KEY,
            state_json TEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
```

And in `init_db()`, after the v2 block:

```python
if current < 3:
    _migrate_v3(conn)
    conn.execute("INSERT OR REPLACE INTO schema_version VALUES (3)")
    current = 3
```

- [ ] **Step 2: Add save/load helpers for instance state**

```python
def save_instance_state(map_key: str, state: dict):
    conn = _get_conn()
    conn.execute(
        "INSERT OR REPLACE INTO instance_state (map_key, state_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
        (map_key, json.dumps(state))
    )
    conn.commit()

def load_instance_state(map_key: str) -> dict | None:
    conn = _get_conn()
    row = conn.execute("SELECT state_json FROM instance_state WHERE map_key = ?", (map_key,)).fetchone()
    if row:
        return json.loads(row[0])
    return None

def delete_instance_state(map_key: str):
    conn = _get_conn()
    conn.execute("DELETE FROM instance_state WHERE map_key = ?", (map_key,))
    conn.commit()
```

- [ ] **Step 3: Verify migration runs on server start**

Start the server. Check logs for schema version bump. Verify table exists:
```bash
sqlite3 auxserver/data/game.db ".tables" | grep instance_state
```

- [ ] **Step 4: Commit**

```
feat: add instance_state DB table (schema v3)
```

---

## Task 2: Instance Manager Service

**Files:**
- Create: `auxserver/services/instance_manager.py`
- Modify: `auxserver/services/game_state.py`

- [ ] **Step 1: Create instance_manager.py**

This service manages loading, saving, and unloading map instances. It wraps the per-map entity dicts.

```python
"""Instance manager — load/save/unload per-map entity state."""

import json
import logging
import time
from pathlib import Path

from services.database import save_instance_state, load_instance_state

logger = logging.getLogger(__name__)

MAPS_DIR = Path(__file__).resolve().parent.parent / "maps"
UNLOAD_DELAY = 60  # seconds with no players before unloading

class InstanceManager:
    def __init__(self):
        # map_key -> { trees: [], buildings: {}, dummies: {}, anvils: {}, campfires: {}, rocks: [] }
        self._instances: dict[str, dict] = {}
        # map_key -> timestamp of last player presence
        self._last_occupied: dict[str, float] = {}
        # map_key -> set of player IDs currently on this map
        self._occupants: dict[str, set] = {}
        # Always-loaded maps (never unloaded)
        self._persistent_maps: set[str] = set()

    def mark_persistent(self, map_key: str):
        """Mark a map as always-loaded (e.g. central)."""
        self._persistent_maps.add(map_key)

    def is_loaded(self, map_key: str) -> bool:
        return map_key in self._instances

    def get(self, map_key: str) -> dict | None:
        return self._instances.get(map_key)

    def get_trees(self, map_key: str) -> list:
        inst = self._instances.get(map_key)
        return inst["trees"] if inst else []

    def get_buildings(self, map_key: str) -> dict:
        inst = self._instances.get(map_key)
        return inst["buildings"] if inst else {}

    def get_dummies(self, map_key: str) -> dict:
        inst = self._instances.get(map_key)
        return inst["dummies"] if inst else {}

    def get_anvils(self, map_key: str) -> dict:
        inst = self._instances.get(map_key)
        return inst["anvils"] if inst else {}

    def get_campfires(self, map_key: str) -> dict:
        inst = self._instances.get(map_key)
        return inst["campfires"] if inst else {}

    def get_rocks(self, map_key: str) -> list:
        inst = self._instances.get(map_key)
        return inst["rocks"] if inst else []

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
        for map_key, inst in self._instances.items():
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
        template_path = MAPS_DIR / "home.json"
        trees = []
        rocks = []
        if template_path.exists():
            data = json.loads(template_path.read_text(encoding="utf-8"))
            from services.world_data import FRAME_TREE, FRAME_BARE, SHEET_COLS, TILE_SIZE
            for i, t in enumerate(data.get("tiles", [])):
                tx, ty = t.get("tileX"), t.get("tileY")
                if not isinstance(tx, int) or not isinstance(ty, int):
                    continue
                frame = tx + ty * SHEET_COLS
                x = t["x"]
                y = t["y"]
                if frame == FRAME_TREE:
                    trees.append({"id": f"{map_key}_t{i}", "x": x, "y": y, "chopped": False, "regrow_at": None})
                elif frame == FRAME_BARE:
                    rocks.append({"id": f"{map_key}_r{i}", "x": x, "y": y})
        self._instances[map_key] = {
            "trees": trees,
            "rocks": rocks,
            "buildings": {},
            "dummies": {},
            "anvils": {},
            "campfires": {},
        }
        self._save_instance(map_key)
        logger.info("Initialized home instance %s (%d trees)", map_key, len(trees))

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
            self._instances[map_key] = {
                "trees": [], "rocks": [], "buildings": {},
                "dummies": {}, "anvils": {}, "campfires": {},
            }
            logger.info("Created empty instance %s", map_key)

    def _save_instance(self, map_key: str):
        """Save instance state to DB."""
        inst = self._instances.get(map_key)
        if inst:
            save_instance_state(map_key, inst)
```

- [ ] **Step 2: Convert game_state.py tree storage to use instance manager**

In `game_state.py.__init__()`, replace `self.trees = []` with a reference to the instance manager:

```python
from services.instance_manager import InstanceManager

# In __init__:
self.instances = InstanceManager()
```

Remove `self.trees` as a flat list. Update `_init_trees()` to initialize the central map trees via instance manager instead of loading into a flat list:

```python
def _init_trees(self):
    """Load trees for the central map into the instance manager."""
    trees = []
    for i, (col, row) in enumerate(TREE_POSITIONS):
        x, y = tile_pos(col, row)
        trees.append({
            "id": f"central_t{i}",
            "x": x, "y": y,
            "chopped": False,
            "regrow_at": None,
        })
    # For backwards compat during migration, also load level_01 trees
    self.instances._instances.setdefault("level_01", {
        "trees": trees, "rocks": [], "buildings": {},
        "dummies": {}, "anvils": {}, "campfires": {},
    })
    self.instances.mark_persistent("level_01")
    # Central map will be added once central.json exists
```

- [ ] **Step 3: Add per-map respawn timer constants and update tree regrowth tick**

The spec requires different respawn timers: 5 min for home maps, 10 min for central, 15 min for ore. Add constants and a helper to `instance_manager.py`:

```python
# Respawn timers (seconds)
TREE_RESPAWN_HOME = 300     # 5 minutes
TREE_RESPAWN_CENTRAL = 600  # 10 minutes
ORE_RESPAWN_CENTRAL = 900   # 15 minutes

def get_tree_respawn_time(map_key: str) -> int:
    """Return tree respawn time in seconds based on map type."""
    if map_key.startswith("home_"):
        return TREE_RESPAWN_HOME
    return TREE_RESPAWN_CENTRAL
```

In `game_state.py tick()`, replace the tree regrowth block (lines 700-704):

```python
# Tree regrowth — iterate all active instances
for map_key, inst in self.instances._instances.items():
    for tree in inst.get("trees", []):
        if tree["chopped"] and tree["regrow_at"] and now >= tree["regrow_at"]:
            tree["chopped"] = False
            tree["regrow_at"] = None
```

When trees are chopped (in `resources.py` or wherever `regrow_at` is set), use the map-specific timer:

```python
from services.instance_manager import get_tree_respawn_time
tree["regrow_at"] = time.time() + get_tree_respawn_time(player_map)
```

- [ ] **Step 4: Add world objects / ore nodes to instance scoping**

World objects (ore nodes, geode deposits) are currently loaded globally in `world_data.py` via `_load_world_objects()`. They already have a `map` field and are filtered per-map in the broadcast (line 264 of ws.py). For the central map, ore nodes need a 15-minute respawn timer:

```python
# In instance_manager.py, add ore respawn tracking:
def get_world_objects(self, map_key: str) -> list:
    """Return world objects for a map. Central map ore nodes get respawn tracking."""
    inst = self._instances.get(map_key)
    return inst.get("world_objects", []) if inst else []
```

World objects already have their own map-aware filtering in the broadcast. The key addition is that when an ore node is depleted on the central map, set `respawn_at = time.time() + ORE_RESPAWN_CENTRAL` (900 seconds). Add ore regrowth to the instance tick alongside tree regrowth:

```python
# In game_state.py tick(), alongside tree regrowth:
for map_key, inst in self.instances._instances.items():
    for wo in inst.get("world_objects", []):
        if wo.get("depleted") and wo.get("respawn_at") and now >= wo["respawn_at"]:
            wo["depleted"] = False
            wo["respawn_at"] = None
```

- [ ] **Step 5: Update snapshot() to not include flat trees**

In `snapshot()`, change `"trees": self.trees` to `"trees": []` (trees are now sent per-map in the broadcast loop, not in the snapshot).

- [ ] **Step 6: Update save_world() to save instances**

Add to `save_world()`:

```python
self.instances.save_all()
```

- [ ] **Step 7: Verify server starts and trees still work on level_01**

Start the server, connect a client, verify trees are visible and choppable.

- [ ] **Step 8: Commit**

```
feat: add InstanceManager, convert tree storage to per-map dicts
```

---

## Task 3: Broadcast Layer — Remove `on_overworld` Guard

**Files:**
- Modify: `auxserver/api/ws.py`

- [ ] **Step 1: Replace `on_overworld` tree/rock/animal/crop filtering with per-map lookup**

In `ws.py` game_loop broadcast (around line 250), remove the `on_overworld` variable entirely. Replace the state dict construction for **all** gated fields:

```python
# OLD (remove all of these):
#   on_overworld = recipient_map == "level_01"
#   "trees": game.trees if on_overworld else [],
#   "rocks": game.rocks if on_overworld else [],
#   "ground_items": [...] if on_overworld else [],
#   "animals": all_animals if on_overworld else [],
#   "crops": all_crops if on_overworld else [],

# NEW:
"trees": game.instances.get_trees(recipient_map),
"rocks": game.instances.get_rocks(recipient_map),
"ground_items": [gi for gi in game.ground_items
                 if gi.get("map", "level_01") == recipient_map],
"animals": [a for a in all_animals if a.get("map", "level_01") == recipient_map],
"crops": [c for c in all_crops if c.get("map", "level_01") == recipient_map],
```

Note: `animals` and `crops` are also gated by `on_overworld` (line 297-298 in current ws.py). They must be filtered per-map too, not just trees/rocks/ground_items.

Also update dummies, anvils, campfires to read from instances:

```python
"dummies": {did: d for did, d in game.instances.get_dummies(recipient_map).items()
            if not d.get("dead")},
"anvils": {aid: a for aid, a in game.instances.get_anvils(recipient_map).items()},
"campfires": {cid: c for cid, c in game.instances.get_campfires(recipient_map).items()},
```

- [ ] **Step 2: Update welcome snapshot to filter by player's map**

In `websocket_endpoint()` welcome block, filter the snapshot:

```python
player_map = player.get("map", "level_01")
snap = game.snapshot()
welcome = {
    "type": "welcome",
    "your_id": pid,
    "players": {pid_k: {**pv, "npcs": _clean_npcs(pv.get("npcs", {}))}
                 for pid_k, pv in snap["players"].items()},
    "trees": game.instances.get_trees(player_map),
    "ground_items": [gi for gi in game.ground_items
                     if gi.get("map", "level_01") == player_map],
    "dummies": game.instances.get_dummies(player_map),
    "anvils": game.instances.get_anvils(player_map),
    "npc_ids": player.get("npc_ids", []) if SPAWN_NPCS else [],
    "animals": [a for a in animal_manager.get_all()
                if a.get("map", "level_01") == player_map],
    "crops": [c for c in crop_manager.get_all()
              if c.get("map", "level_01") == player_map],
}
```

- [ ] **Step 3: Verify trees/buildings show correctly on level_01**

Start server, connect, verify trees and structures render. Verify chopping works.

- [ ] **Step 4: Commit**

```
feat: per-map entity filtering in broadcast, remove on_overworld guard
```

---

## Task 4: Dynamic Portal Registry

**Files:**
- Modify: `auxserver/services/world_data.py`
- Modify: `auxserver/services/portals.py`

- [ ] **Step 1: Add mutable player portal list to world_data.py**

After `PORTALS = _load_portals()`, add:

```python
_player_portals: list[dict] = []

def register_player_portal(player_id: str, col: int, row: int, spawn_col: int, spawn_row: int):
    """Register a player's home portal on the central map."""
    # Central → home
    _player_portals.append({
        "from_map": "central",
        "tile_col": col,
        "tile_row": row,
        "to_map": f"home_{player_id}",
        "spawn_col": spawn_col,
        "spawn_row": spawn_row,
    })
    logger.info("Registered portal for %s at central (%d, %d)", player_id, col, row)

def get_all_portals(map_name: str) -> list[dict]:
    """Return static + dynamic portals for a given source map."""
    result = [p for p in PORTALS if p["from_map"] == map_name]
    result.extend(p for p in _player_portals if p["from_map"] == map_name)
    return result

def get_player_portals() -> list[dict]:
    """Return all registered player portals (for central map rendering)."""
    return list(_player_portals)
```

- [ ] **Step 2: Update portals.py to use get_all_portals()**

Replace the static PORTALS import and usage:

```python
from services.world_data import get_all_portals, TILE_SIZE

class PortalService:
    def __init__(self, game_state):
        self.gs = game_state

    def check_portal(self, actor: dict):
        col = int(actor["x"] // TILE_SIZE)
        row = int(actor["y"] // TILE_SIZE)
        actor_map = actor.get("map", "level_01")
        for portal in get_all_portals(actor_map):
            if portal["tile_col"] == col and portal["tile_row"] == row:
                return portal
        return None
```

- [ ] **Step 3: Verify existing portals still work (level_01 ↔ cave_01)**

Start server, walk into a portal. Confirm transition still works.

- [ ] **Step 4: Commit**

```
feat: dynamic portal registry, portals.py uses get_all_portals()
```

---

## Task 5: Portal Assignment on Player Creation

**Files:**
- Modify: `auxserver/services/player_manager.py`
- Modify: `auxserver/services/world_data.py`

- [ ] **Step 1: Add portal assignment algorithm to player_manager.py**

Add helper function and call from `add_player()`:

```python
import random
import math
from services.world_data import register_player_portal, get_player_portals, get_map_dimensions

def _assign_central_portal(pid: str) -> tuple[int, int]:
    """Pick a random perimeter tile on the central map with >=15 tile spacing from existing portals."""
    cols, rows = get_map_dimensions("central")
    existing = [(p["tile_col"], p["tile_row"]) for p in get_player_portals()]
    min_dist = 15
    perimeter = []
    # North edge (row 0), South edge (row rows-1), West edge (col 0), East edge (col cols-1)
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
```

- [ ] **Step 2: Integrate into add_player()**

In `add_player()`, after creating the player dict, add:

```python
# Assign central map portal
portal_col, portal_row = _assign_central_portal(pid)
self.gs.players[pid]["central_portal_col"] = portal_col
self.gs.players[pid]["central_portal_row"] = portal_row
self.gs.players[pid]["map"] = f"home_{pid}"

# Register the portal
# Home east-edge spawn: col 49, row 25 (east edge, center height of 50x50 map)
register_player_portal(pid, portal_col, portal_row, spawn_col=49, spawn_row=25)
```

- [ ] **Step 3: Register existing player portals on server startup**

In `ws.py` or `game_state.py` initialization, after loading players from DB, register their portals:

```python
# After all players loaded from DB:
for pid, pdata in game.players.items():
    pcol = pdata.get("central_portal_col")
    prow = pdata.get("central_portal_row")
    if pcol is not None and prow is not None:
        register_player_portal(pid, pcol, prow, spawn_col=49, spawn_row=25)
```

- [ ] **Step 4: Add home→central portal for each player's home instance**

When a home instance loads, register the east-edge portal dynamically. In `instance_manager.py` `_load_instance()`, after loading:

```python
if map_key.startswith("home_"):
    pid = map_key.removeprefix("home_")
    player = None  # Will need to look up player for portal coords
    # The home→central portal is handled by registering it when the player logs in
```

Actually simpler: register home→central portals in `world_data.py` alongside the central→home portals:

In `register_player_portal()`, also add the reverse direction:

```python
def register_player_portal(player_id: str, col: int, row: int, spawn_col: int, spawn_row: int):
    """Register bidirectional portals: central ↔ home."""
    home_map = f"home_{player_id}"
    # Central → home
    _player_portals.append({
        "from_map": "central",
        "tile_col": col,
        "tile_row": row,
        "to_map": home_map,
        "spawn_col": spawn_col,
        "spawn_row": spawn_row,
    })
    # Home → central (east edge portal, fixed at col 49, row 25 in home template)
    _player_portals.append({
        "from_map": home_map,
        "tile_col": 49,
        "tile_row": 25,
        "to_map": "central",
        "spawn_col": col,
        "spawn_row": row,
    })
    logger.info("Registered bidirectional portal for %s at central (%d, %d)", player_id, col, row)
```

- [ ] **Step 5: Commit**

```
feat: portal assignment on player creation, bidirectional home↔central
```

---

## Task 6: NPC Recall on Disconnect

**Files:**
- Modify: `auxserver/api/ws.py`

- [ ] **Step 1: Add NPC recall before remove_player in disconnect handler**

In the `finally` block of `websocket_endpoint()`:

```python
finally:
    # Recall NPCs from shared maps before removing player
    player = game.players.get(pid)
    if player:
        home_map = f"home_{pid}"
        for npc_id, npc in player.get("npcs", {}).items():
            npc_map = npc.get("map", "level_01")
            if npc_map not in (home_map, f"cave_{pid}"):
                # NPC is on central or another player's home — recall
                npc["map"] = home_map
                npc["x"] = 25 * TILE_SIZE  # home center
                npc["y"] = 25 * TILE_SIZE
                npc["vx"] = 0
                npc["vy"] = 0
                npc.pop("punching", None)
                logger.info("Recalled NPC %s from %s to %s", npc_id, npc_map, home_map)

    _save_player_state(pid)
    clients.pop(pid, None)

    # Notify instance manager that this player left their map
    player_map = game.players.get(pid, {}).get("map", "level_01")
    game.instances.player_left(player_map, pid)

    game.remove_player(pid)
    logger.info("ws: Player %s disconnected and saved", pid)
```

- [ ] **Step 2: Track instance occupancy on map changes**

In the portal handling code in `game_state.py` (where player map is changed on portal transition), notify the instance manager:

```python
# When player transitions from old_map to new_map:
self.instances.player_left(old_map, pid)
self.instances.player_entered(new_map, pid)
```

- [ ] **Step 3: Track instance occupancy on login**

In `websocket_endpoint()` after login:

```python
player_map = player.get("map", "level_01")
game.instances.player_entered(player_map, pid)
```

- [ ] **Step 4: Commit**

```
feat: NPC recall on disconnect, instance occupancy tracking
```

---

## Task 7: Map Name Resolution — Template Lookup for Instanced Maps

**Files:**
- Modify: `auxserver/services/map_service.py` (where `map_file_path()` actually lives)
- Modify: `auxserver/services/portals.py` (`get_spawn_point_for_map()` reads items files by name)
- Modify: `auxserver/api/maps.py` (`wipe_map()` accesses flat entity lists that will be per-map)

- [ ] **Step 1: Add instance name resolution to `map_service.py`**

The actual `map_file_path()`, `collision_file_path()`, and `items_file_path()` functions are in `auxserver/services/map_service.py` (lines 36, 61, 66). Add a helper that resolves instance names to template names, and use it in all three:

```python
def _resolve_template_name(name: str) -> str:
    """Resolve instanced map names to their template names."""
    if name.startswith("home_"):
        return "home"
    if name.startswith("cave_") and name != "cave_01":
        return "cave_01"
    return name

def map_file_path(name: str) -> Path:
    map_name = _validated_map_name(_resolve_template_name(name))
    return MAPS_DIR / f"{map_name}.json"

def collision_file_path(name: str) -> Path:
    map_name = _validated_map_name(_resolve_template_name(name))
    return MAPS_DIR / f"{map_name}_collision.json"

def items_file_path(name: str) -> Path:
    map_name = _validated_map_name(_resolve_template_name(name))
    return MAPS_DIR / f"{map_name}_items.json"
```

- [ ] **Step 2: Fix `portals.py` `get_spawn_point_for_map()` to resolve instance names**

`get_spawn_point_for_map()` reads `{map_name}_items.json` directly from disk. For `home_test1`, it would look for `home_test1_items.json` which doesn't exist. Add the same resolution:

```python
def get_spawn_point_for_map(self, map_name: str):
    """Return (col, row) spawn point for a given map name from portal definitions, or None."""
    # Resolve instanced map names to template
    resolved = map_name
    if map_name.startswith("home_"):
        resolved = "home"
    elif map_name.startswith("cave_") and map_name != "cave_01":
        resolved = "cave_01"

    maps_dir = Path(__file__).resolve().parent.parent / "maps"
    items_file = maps_dir / f"{resolved}_items.json"
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
```

- [ ] **Step 3: Update `wipe_map()` in `maps.py` to work with instance manager**

`wipe_map()` currently accesses `game.buildings` and `game.ground_items` as flat structures. After migration these are per-map in the instance manager:

```python
@router.post("/wipe-map")
async def wipe_map(request: Request):
    import re
    from services.game_state import game
    from services.database import save_buildings, save_ground_items

    body = await request.json()
    name = (body.get("name") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]+", name):
        raise HTTPException(status_code=400, detail="Invalid map name.")

    # Clear instance data for this map
    inst = game.instances.get(name)
    if inst:
        inst["buildings"] = {}
        inst["dummies"] = {}
        inst["anvils"] = {}
        inst["campfires"] = {}
        inst["trees"] = []
        inst["rocks"] = []

    # Remove ground items on this map
    game.ground_items = [gi for gi in game.ground_items if gi.get("map", "level_01") != name]

    # Clear mine grids if this is a cave map
    if name.startswith("cave_"):
        game.mine_grids.clear()
        from services.database import delete_all_mine_states
        delete_all_mine_states()

    # Persist
    game.instances.save_all()
    save_ground_items(game.ground_items)
    return {"ok": True, "map": name}
```

- [ ] **Step 4: Verify endpoint returns home template for `home_test1`**

```bash
curl http://localhost:8001/load-map?name=home_test1
```

Should return the home.json content (once the template exists).

- [ ] **Step 5: Commit**

```
feat: map name resolution for instanced maps in map_service, portals, wipe_map
```

---

## Task 8: Client — MapManager Instance Support

**Files:**
- Modify: `src/systems/MapManager.js`

- [ ] **Step 1: Fix cave_01 hardcode to use prefix check**

In `changeMap()` (line 141), replace:

```javascript
if (newMap === 'cave_01') {
```

with:

```javascript
if (newMap.startsWith('cave_')) {
```

- [ ] **Step 2: Add home template caching**

In `changeMap()`, before the fetch call, add template caching:

```javascript
// Resolve instance map names to template for caching
let fetchName = newMap;
if (newMap.startsWith('home_')) fetchName = 'home_template';
else if (newMap.startsWith('cave_') && newMap !== 'cave_01') fetchName = 'cave_01';

// Check cache
if (!this._mapCache) this._mapCache = {};
let mapData;
if (this._mapCache[fetchName]) {
    mapData = this._mapCache[fetchName];
} else {
    const mapNameParam = newMap.startsWith('home_') ? newMap : fetchName;
    const res = await fetch(`${API_BASE}/load-map?name=${mapNameParam}`);
    if (!res.ok) throw new Error(`Map load failed: ${res.status}`);
    mapData = await res.json();
    // Cache templates (not unique maps like central)
    if (fetchName === 'home_template' || fetchName === 'cave_01') {
        this._mapCache[fetchName] = mapData;
    }
}
```

Then use `mapData` for the rest of the function instead of fetching inline.

- [ ] **Step 3: Update initial loadMap() to respect player's saved map**

Currently `loadMap()` hardcodes `level_01`. It should load whatever map the player is on. This will be handled by the server sending the player's map in the welcome message — the `StateSyncController` already detects map changes and calls `changeMap()`. No change needed in `loadMap()` for now — it loads `level_01` as a fallback and the first state tick triggers the real map.

- [ ] **Step 4: Commit**

```
feat: client MapManager supports instanced map names
```

---

## Task 9: Create Map Template Files

**Files:**
- Create: `auxserver/maps/home.json`
- Create: `auxserver/maps/home_collision.json`
- Create: `auxserver/maps/home_items.json`
- Create: `auxserver/maps/central.json`
- Create: `auxserver/maps/central_collision.json`
- Create: `auxserver/maps/central_items.json`

- [ ] **Step 1: Create home.json — 50x50 tile template**

Generate a basic 50x50 grass map with ~15 trees scattered and a few rock spawns. Use the same tile format as `level_01.json`. This can be created with the mapmaker tool or generated programmatically.

Minimal structure:
```json
{
    "name": "home",
    "width": 50,
    "height": 50,
    "tiles": [ ... grass tiles with ~15 tree frames and ~5 rock frames ... ],
    "customSprites": []
}
```

- [ ] **Step 2: Create home_items.json with portals and spawn**

```json
{
    "mapItems": [
        { "label": "spawn", "tileCol": 25, "tileRow": 25 },
        { "label": "portal:central:DYNAMIC", "tileCol": 49, "tileRow": 25 },
        { "label": "portal:cave_01", "tileCol": 0, "tileRow": 25 }
    ]
}
```

Note: The `portal:central:DYNAMIC` label is just documentation — the actual portal is registered dynamically via `register_player_portal()`. The static portal loader will skip it (doesn't match either regex pattern). The cave portal uses auto-spawn lookup.

- [ ] **Step 3: Create home_collision.json**

```json
{ "collisionTiles": [] }
```

Empty for now — homes have no collision tiles.

- [ ] **Step 4: Create central.json — 150x150 tile template**

Generate a 150x150 map with dense trees (~200-300), ore node markers, and varied terrain. This is the main content design task — start with a basic grass map with many trees and refine later.

```json
{
    "name": "central",
    "width": 150,
    "height": 150,
    "tiles": [ ... ],
    "customSprites": []
}
```

- [ ] **Step 5: Create central_items.json with spawn**

```json
{
    "mapItems": [
        { "label": "spawn", "tileCol": 75, "tileRow": 75 }
    ]
}
```

Player portals on the perimeter are registered dynamically, not in this file.

- [ ] **Step 6: Create central_collision.json**

```json
{ "collisionTiles": [] }
```

- [ ] **Step 7: Commit**

```
feat: add home and central map template files
```

---

## Task 10: Integration — Wire Everything Together

**Files:**
- Modify: `auxserver/services/game_state.py`
- Modify: `auxserver/api/ws.py`
- Modify: `auxserver/services/player_manager.py`

- [ ] **Step 1: Update game_state.py to initialize central map instance**

In `__init__()` or a startup method, after `_init_trees()`:

```python
# Initialize central map as persistent
self.instances.mark_persistent("central")
# Load central map trees from template if not already in DB
if not self.instances.is_loaded("central"):
    self.instances.player_entered("central", "__system__")
```

- [ ] **Step 2a: Migrate `resources.py` tree operations to use instances**

In `resources.py`, every reference to `self.gs.trees` changes to `self.gs.instances.get_trees(player_map)` where `player_map` is resolved from the player/NPC's current map. The tree chopping code also needs to set `regrow_at` using the map-specific timer:

```python
player_map = actor.get("map", "level_01")
trees = self.gs.instances.get_trees(player_map)
# ... find tree in trees list, chop it ...
tree["regrow_at"] = time.time() + get_tree_respawn_time(player_map)
```

- [ ] **Step 2b: Migrate `building.py` building placement to use instances**

In `building.py`, `self.gs.buildings`, `self.gs.dummies`, `self.gs.anvils`, `self.gs.campfires` all change to `self.gs.instances.get_buildings(player_map)` etc. When placing a new building, add it to the instance dict for the player's current map.

- [ ] **Step 2c: Migrate `combat_ki.py` dummy/target lookups to use instances**

In `combat_ki.py`, dummy damage lookups change from `self.gs.dummies` to `self.gs.instances.get_dummies(player_map)`.

- [ ] **Step 2d: Migrate `gathering.py` rock mining to use instances**

In `gathering.py`, rock lookups change from `self.gs.rocks` to `self.gs.instances.get_rocks(player_map)`.

- [ ] **Step 2e: Verify all entity operations work on level_01**

Start server, connect. Verify: chop tree, place building, hit dummy, mine rock. All should still work on level_01.

- [ ] **Step 3: Update new player flow to start on home map**

In `add_player()`, set `map` to `home_{pid}` and trigger home instance creation:

```python
self.gs.players[pid]["map"] = f"home_{pid}"
self.gs.instances.init_home(f"home_{pid}")
```

- [ ] **Step 4: Add instance tick_unload to save cycle**

In `ws.py` game_loop, alongside the auto-save:

```python
if now - _last_save >= SAVE_INTERVAL:
    _save_all_players()
    game.instances.save_all()
    game.instances.tick_unload()
    _last_save = now
```

- [ ] **Step 5: End-to-end test**

1. Start fresh server (delete game.db to test clean startup)
2. Login as new player — should spawn on `home_{pid}` map
3. Verify trees are visible on home map
4. Walk to east edge — should portal to central map
5. Walk back into home portal on central perimeter — should return home
6. Walk to west edge — should portal to cave
7. Disconnect and reconnect — should restore to last map

- [ ] **Step 6: Commit**

```
feat: wire up instance system, new players start on home maps
```

---

## Task 11: Instance Unload & Save Cycle

**Files:**
- Modify: `auxserver/api/ws.py`
- Modify: `auxserver/services/instance_manager.py`

- [ ] **Step 1: Verify unload timer works**

1. Login, go to home map (it loads)
2. Portal to central map (home should stay loaded)
3. Wait 60+ seconds
4. Check server logs — home instance should unload
5. Portal back to home — instance should reload from DB

- [ ] **Step 2: Verify save cycle persists buildings across restart**

1. Login, build an anvil on home map
2. Restart server
3. Login — anvil should still be there

- [ ] **Step 3: Commit (if any fixes needed)**

```
fix: instance lifecycle adjustments
```

---

## Implementation Order & Dependencies

```
Task 1 (DB schema) ─────────────────────────────┐
Task 9 (Map template files) ───────────────────→│ independent, but needed before Task 2's init_home()
Task 2 (Instance manager + tree conversion) ────→│ depends on Task 1, Task 9
Task 3 (Broadcast layer) ──────────────────────→│ depends on Task 2
Task 4 (Dynamic portal registry) ──────────────→│ independent
Task 5 (Portal assignment) ────────────────────→│ depends on Task 4
Task 6 (NPC recall) ──────────────────────────→│ depends on Task 2
Task 7 (Map name resolution) ──────────────────→│ independent
Task 8 (Client MapManager) ───────────────────→│ independent
Task 10 (Integration) ────────────────────────→│ depends on all above
Task 11 (Verification) ───────────────────────→│ depends on Task 10
```

Tasks 1, 4, 7, 8, 9 can be done in parallel. Task 9 should be completed before Task 2 (since `init_home()` reads `home.json`). Tasks 2, 3, 5, 6 build sequentially. Task 10 wires everything together. Task 11 verifies the full flow.
