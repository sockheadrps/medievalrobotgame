# Data-Driven Crafting Stations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hardcoded `furnace` and `log_cutter` building kinds with a generic `crafting_station` building kind driven by JSON asset files, so any station defined in the asset editor automatically works in-game with no new server code.

**Architecture:** Station definitions live in `assets/crafting_stations/*/station.json` and are loaded by `AssetRegistry` at startup. The server replaces the two hardcoded building tick branches with a single generic loop over the station's `recipes`, using `inputs`/`outputs`/`fuel_cost` dicts. Save migration in `load_buildings` transparently upgrades legacy `"furnace"` and `"log_cutter"` kind strings on load.

**Tech Stack:** Python/FastAPI (server), Pydantic v2 models, SQLite via custom db layer, Phaser 3 (client), plain JS ES modules

---

## File Map

**Create:**
- `assets/crafting_stations/bronze_furnace/station.json`
- `assets/crafting_stations/log_cutter/station.json`

**Modify:**
- `auxserver/schemas/assets.py` — migrate `StationRecipe` to `inputs`/`outputs`/`fuel_cost` dict shape
- `auxserver/services/asset_registry.py` — add `crafting_stations` dict, `get_crafting_station()`, scan on `load_all()`
- `auxserver/api/assets.py` — add `GET /api/assets/crafting_stations` endpoint
- `auxserver/services/building.py` — generic station tick, placement allowlist, conveyor push/pull
- `auxserver/services/database.py` — save migration in `load_buildings`
- `auxserver/static/asseteditor.js` — update station recipe UI to new `inputs`/`outputs`/`fuel_cost` shape
- `src/ui/InventoryController.js` — replace `place_furnace`/`place_log_cutter` hotbar with `place_crafting_station`

---

## Task 1: Migrate `StationRecipe` schema + create station JSON files

**Files:**
- Modify: `auxserver/schemas/assets.py:96-116`
- Create: `assets/crafting_stations/bronze_furnace/station.json`
- Create: `assets/crafting_stations/log_cutter/station.json`

Context: `StationRecipe` currently uses single-item fields (`input_item`, `input_qty`, `output_item`, `output_min`, `output_max`). The spec requires migration to `inputs: dict[str, int]`, `outputs: dict[str, int]`, `fuel_cost: int`. **This is a breaking change** — the asset editor JS and any existing `station.json` files must also be updated in this task.

- [ ] **Step 1: Write tests for the new schema shape**

Create `auxserver/tests/test_station_schema.py`:

```python
from schemas.assets import StationRecipe, CraftingStationDef

def test_station_recipe_new_shape():
    r = StationRecipe(inputs={"raw_copper": 2, "raw_tin": 1}, fuel_cost=1,
                      outputs={"bronze_bar": 1}, process_time=5.0)
    assert r.inputs == {"raw_copper": 2, "raw_tin": 1}
    assert r.outputs == {"bronze_bar": 1}
    assert r.fuel_cost == 1
    assert r.process_time == 5.0


def test_station_def_loads_from_json():
    import json
    raw = {
        "id": "bronze_furnace",
        "label": "Bronze Furnace",
        "station_type": "smelter",
        "speed_bonus": 1.0,
        "required_metallurgy": 0,
        "fuel_type": "planks",
        "build_recipe": {},
        "recipes": [{"inputs": {"raw_copper": 2, "raw_tin": 1},
                     "fuel_cost": 1, "outputs": {"bronze_bar": 1}, "process_time": 5.0}]
    }
    st = CraftingStationDef(**raw)
    assert st.recipes[0].inputs == {"raw_copper": 2, "raw_tin": 1}


def test_station_recipe_defaults():
    r = StationRecipe()
    assert r.inputs == {}
    assert r.outputs == {}
    assert r.fuel_cost == 0
    assert r.process_time == 5.0
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd auxserver && python -m pytest tests/test_station_schema.py -v
```
Expected: FAIL — `StationRecipe` has no `inputs`/`outputs`/`fuel_cost` fields yet.

- [ ] **Step 3: Replace `StationRecipe` in `auxserver/schemas/assets.py`**

Replace lines 98–104:
```python
class StationRecipe(BaseModel):
    input_item: str = ""                 # item id consumed
    input_qty: int = 1
    output_item: str = ""                # item id produced
    output_min: int = 1
    output_max: int = 1
    process_time: float = 5.0           # seconds per operation
```
With:
```python
class StationRecipe(BaseModel):
    inputs: dict[str, int] = {}      # item_id → quantity required
    outputs: dict[str, int] = {}     # item_id → quantity produced
    fuel_cost: int = 0               # units of station fuel_type consumed
    process_time: float = 5.0        # seconds per cycle
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd auxserver && python -m pytest tests/test_station_schema.py -v
```
Expected: 3 PASS

- [ ] **Step 5: Create the bronze_furnace station JSON**

Create `assets/crafting_stations/bronze_furnace/station.json`:
```json
{
  "id": "bronze_furnace",
  "label": "Bronze Furnace",
  "station_type": "smelter",
  "speed_bonus": 1.0,
  "required_metallurgy": 0,
  "fuel_type": "planks",
  "build_recipe": {},
  "recipes": [
    {
      "inputs": { "raw_copper": 2, "raw_tin": 1 },
      "fuel_cost": 1,
      "outputs": { "bronze_bar": 1 },
      "process_time": 5.0
    }
  ]
}
```

- [ ] **Step 6: Create the log_cutter station JSON**

Create `assets/crafting_stations/log_cutter/station.json`:
```json
{
  "id": "log_cutter",
  "label": "Log Cutter",
  "station_type": "workbench",
  "speed_bonus": 1.0,
  "required_metallurgy": 0,
  "fuel_type": "none",
  "build_recipe": {},
  "recipes": [
    {
      "inputs": { "Wood": 1 },
      "fuel_cost": 0,
      "outputs": { "planks": 3 },
      "process_time": 2.0
    }
  ]
}
```

- [ ] **Step 7: Commit**

```bash
git add auxserver/schemas/assets.py auxserver/tests/test_station_schema.py
git add assets/crafting_stations/
git commit -m "feat: migrate StationRecipe to inputs/outputs/fuel_cost dicts + add bronze_furnace + log_cutter JSON assets"
```

---

## Task 2: Load crafting stations in `AssetRegistry` + add API endpoint

**Files:**
- Modify: `auxserver/services/asset_registry.py`
- Modify: `auxserver/api/assets.py`

Context: `AssetRegistry` already loads `world_objects` and `equipment`. It imports `WorldObjectDef, EquipmentDef` from `schemas.assets` at line 14. Add `CraftingStationDef`. The `/api/assets/stations` endpoint exists for the asset editor (CRUD), but the client needs a separate read-only manifest endpoint `/api/assets/crafting_stations` that returns what the registry has loaded (live, hot-loaded from disk at startup). **Use the existing `STATIONS_DIR` path pattern**: `assets/crafting_stations/*/station.json`.

- [ ] **Step 1: Write tests for registry loading**

Create `auxserver/tests/test_asset_registry_stations.py`:

```python
import json
from pathlib import Path
import tempfile
import pytest
from services.asset_registry import AssetRegistry

STATION_JSON = {
    "id": "test_smelter",
    "label": "Test Smelter",
    "station_type": "smelter",
    "speed_bonus": 1.0,
    "required_metallurgy": 0,
    "fuel_type": "coal",
    "build_recipe": {},
    "recipes": [{"inputs": {"ore": 1}, "fuel_cost": 1, "outputs": {"ingot": 1}, "process_time": 3.0}]
}


@pytest.fixture
def assets_dir(tmp_path):
    # Minimal assets dir with one crafting station
    cs_dir = tmp_path / "crafting_stations" / "test_smelter"
    cs_dir.mkdir(parents=True)
    (cs_dir / "station.json").write_text(json.dumps(STATION_JSON))
    # baseplayer.json required by _load_base_animations
    (tmp_path / "baseplayer.json").write_text('{"animations":{}}')
    return tmp_path


def test_load_all_scans_crafting_stations(assets_dir):
    reg = AssetRegistry()
    reg.load_all(assets_dir)
    assert "test_smelter" in reg.crafting_stations


def test_get_crafting_station_returns_def(assets_dir):
    reg = AssetRegistry()
    reg.load_all(assets_dir)
    st = reg.get_crafting_station("test_smelter")
    assert st is not None
    assert st.fuel_type == "coal"
    assert st.recipes[0].inputs == {"ore": 1}


def test_get_crafting_station_missing_returns_none(assets_dir):
    reg = AssetRegistry()
    reg.load_all(assets_dir)
    assert reg.get_crafting_station("nonexistent") is None
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd auxserver && python -m pytest tests/test_asset_registry_stations.py -v
```
Expected: FAIL — `AssetRegistry` has no `crafting_stations` attribute.

- [ ] **Step 3: Update `AssetRegistry` to scan crafting stations**

In `auxserver/services/asset_registry.py`:

Add to imports line 14:
```python
from schemas.assets import WorldObjectDef, EquipmentDef, CraftingStationDef
```

Add to `__init__` after `self._loaded`:
```python
self.crafting_stations: dict[str, CraftingStationDef] = {}
```

Add to `load_all()` after `self._scan_equipment(...)`:
```python
self._scan_crafting_stations(assets_dir / "crafting_stations")
```

Update the logger line:
```python
logger.info("Loaded %d world objects, %d equipment items, %d crafting stations",
            len(self.world_objects), len(self.equipment), len(self.crafting_stations))
```

Add new public method after `get_equipment`:
```python
def get_crafting_station(self, station_id: str) -> Optional[CraftingStationDef]:
    return self.crafting_stations.get(station_id)
```

Add new private method after `_scan_equipment`:
```python
def _scan_crafting_stations(self, cs_dir: Path):
    if not cs_dir.exists():
        return
    for folder in cs_dir.iterdir():
        if not folder.is_dir():
            continue
        cfg_path = folder / "station.json"
        if not cfg_path.exists():
            continue
        try:
            data = json.loads(cfg_path.read_text(encoding="utf-8-sig"))
            st = CraftingStationDef(**data)
            self.crafting_stations[st.id] = st
        except (json.JSONDecodeError, OSError) as e:
            logger.warning("Asset registry: skipping malformed file %s: %s", cfg_path, e)
        except Exception as e:
            logger.warning("Asset registry: error loading %s: %s", cfg_path, e)
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd auxserver && python -m pytest tests/test_asset_registry_stations.py -v
```
Expected: 3 PASS

- [ ] **Step 5: Add `GET /api/assets/crafting_stations` endpoint**

In `auxserver/api/assets.py`, add after the existing `/stations` routes:

```python
from services.asset_registry import asset_registry

@router.get("/crafting_stations")
async def get_crafting_stations_manifest():
    """Returns live-loaded crafting station definitions from the asset registry."""
    return {
        sid: st.model_dump()
        for sid, st in asset_registry.crafting_stations.items()
    }
```

- [ ] **Step 6: Smoke test the endpoint**

Start the server and run:
```bash
curl http://localhost:8000/api/assets/crafting_stations
```
Expected: JSON dict with `"bronze_furnace"` and `"log_cutter"` entries (if asset files were created in Task 1).

- [ ] **Step 7: Commit**

```bash
git add auxserver/services/asset_registry.py auxserver/api/assets.py
git add auxserver/tests/test_asset_registry_stations.py
git commit -m "feat: load crafting stations in AssetRegistry + add /api/assets/crafting_stations endpoint"
```

---

## Task 3: Server — save migration in `load_buildings`

**Files:**
- Modify: `auxserver/services/database.py:647-672`

Context: `load_buildings()` reads all building rows from SQLite. Legacy rows have `kind = "furnace"` or `kind = "log_cutter"`. After this task, loading will transparently remap them to `kind = "crafting_station"` plus `asset_id`. No schema change needed — `asset_id` is stored in a new key on the in-memory dict only (buildings are saved as JSON-serialized state, so `asset_id` will persist next time the building dict is saved).

Note: The buildings table `save_buildings()` serializes each building dict as-is into the `stored` JSON blob? No — looking at the code, building dicts are saved by individual columns. Check: `save_buildings` in `database.py` (around line 628-644). The `asset_id` needs to be persisted. Examine `save_buildings` first.

- [ ] **Step 1: Read `save_buildings` to understand persistence**

Read `auxserver/services/database.py` around lines 620-650. Confirm whether `asset_id` would be lost on next save. If it's only stored in certain columns (id, kind, col, row, map, owner, direction, label, stored), then `asset_id` needs to go into the `stored` JSON or as a new column. The safest approach: store `asset_id` in the building dict's `stored` field as a sentinel key — but that pollutes stored contents.

**Decision from spec**: On load, remap `kind` and set `asset_id` on the building dict. For persistence, add `asset_id` to the building's serialized state. Since the buildings table doesn't have an `asset_id` column, store it in the `label` field is wrong. The cleanest path: use a separate JSON blob. **Actual plan**: In `save_buildings`, serialize the full building dict extra fields (including `asset_id`) into the existing `stored` column alongside the inventory. Read on load.

**Simpler plan** (no schema change): Store `asset_id` in `b["stored"]["__asset_id__"]` as a sentinel. On save, it gets persisted in the `stored` JSON. On load, extract it back. This is a temporary design decision for this task — later a schema migration can clean it up.

Actually on re-reading `database.py:647-672`, `load_buildings` just reads from the `buildings` table. The saving (`save_buildings` at line ~628) writes `kind`, `col`, `row`, `map`, `owner`, `direction`, `stored`, `label`. So `asset_id` is not a table column. Use a special key in `stored`: `"_asset_id"`.

- [ ] **Step 2: Write tests for save migration**

Create `auxserver/tests/test_building_migration.py`:

```python
import json
import sqlite3
import threading
import pytest
import services.database as db_mod


def _make_test_db(tmp_path, buildings: list[dict]):
    """Create a minimal buildings table with the given building rows."""
    db_path = tmp_path / "game.db"
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("""
        CREATE TABLE buildings (
            id TEXT PRIMARY KEY, kind TEXT, col INTEGER, row INTEGER,
            map TEXT, owner TEXT, direction TEXT, stored TEXT, label TEXT
        )
    """)
    for b in buildings:
        conn.execute(
            "INSERT INTO buildings VALUES (?,?,?,?,?,?,?,?,?)",
            (b["id"], b["kind"], b.get("col", 0), b.get("row", 0),
             b.get("map", "level_01"), b.get("owner", "p1"),
             b.get("direction", ""), json.dumps(b.get("stored", {})), b.get("label", ""))
        )
    conn.commit()
    conn.close()
    return db_path


@pytest.fixture(autouse=True)
def patch_db(monkeypatch, tmp_path):
    """Redirect database module to a temp DB and reset thread-local connection."""
    db_path = tmp_path / "game.db"
    monkeypatch.setattr(db_mod, "DB_PATH", db_path)
    # Reset thread-local connection so _get_conn() creates a fresh one
    if hasattr(db_mod._local, "conn") and db_mod._local.conn:
        try:
            db_mod._local.conn.close()
        except Exception:
            pass
    db_mod._local.conn = None
    yield
    if hasattr(db_mod._local, "conn") and db_mod._local.conn:
        try:
            db_mod._local.conn.close()
        except Exception:
            pass
    db_mod._local.conn = None


def test_legacy_furnace_migrated(tmp_path):
    _make_test_db(tmp_path, [{"id": "b1", "kind": "furnace", "stored": {"planks": 2}}])
    result = db_mod.load_buildings()
    assert result["b1"]["kind"] == "crafting_station"
    assert result["b1"].get("asset_id") == "bronze_furnace"
    assert result["b1"]["stored"].get("planks") == 2   # original contents preserved
    assert "_asset_id" not in result["b1"]["stored"]   # sentinel popped after extraction


def test_legacy_log_cutter_migrated(tmp_path):
    _make_test_db(tmp_path, [{"id": "b2", "kind": "log_cutter", "stored": {"Wood": 1}}])
    result = db_mod.load_buildings()
    assert result["b2"]["kind"] == "crafting_station"
    assert result["b2"].get("asset_id") == "log_cutter"
    assert result["b2"]["stored"].get("Wood") == 1


def test_modern_crafting_station_unchanged(tmp_path):
    _make_test_db(tmp_path, [
        {"id": "b3", "kind": "crafting_station",
         "stored": {"_asset_id": "bronze_furnace", "bronze_bar": 3}},
    ])
    result = db_mod.load_buildings()
    assert result["b3"]["kind"] == "crafting_station"
    assert result["b3"].get("asset_id") == "bronze_furnace"
    assert result["b3"]["stored"].get("bronze_bar") == 3
    assert "_asset_id" not in result["b3"]["stored"]
```

Note: `database.py` uses module-level `DB_PATH` (not `_DB_PATH`) and `threading.local()` via `_local` (not `_conn_cache`). The fixture above patches both correctly.

- [ ] **Step 3: Run tests to confirm they fail**

```bash
cd auxserver && python -m pytest tests/test_building_migration.py -v
```
Expected: FAIL — no migration in `load_buildings`.

- [ ] **Step 4: Add migration to `load_buildings`**

In `auxserver/services/database.py`, after building the result dict entry (inside the for loop, after the `result[r["id"]] = {...}` line, around line 664-671), add:

```python
    # Save migration: remap legacy kind strings to generic crafting_station
    b = result[r["id"]]
    if b["kind"] == "furnace":
        b["kind"] = "crafting_station"
        b["stored"]["_asset_id"] = "bronze_furnace"
    elif b["kind"] == "log_cutter":
        b["kind"] = "crafting_station"
        b["stored"]["_asset_id"] = "log_cutter"
    # Restore asset_id from stored sentinel for modern crafting_station rows
    if b["kind"] == "crafting_station" and "_asset_id" in b["stored"]:
        b["asset_id"] = b["stored"].pop("_asset_id")
```

Also update `_place_building` in `building.py` (Task 4) and `save_buildings` to persist `asset_id` in `stored` on save. For now, in `save_buildings`, before inserting, re-inject `_asset_id` into the stored dict if `asset_id` is present:

Find `save_buildings` in `database.py` (around line 628) and inside the loop that saves each building, before the `conn.execute(...)` call, add:

```python
    stored = dict(b.get("stored", {}))
    if b.get("asset_id"):
        stored["_asset_id"] = b["asset_id"]
```

Then use `stored` (not `b.get("stored", {})`) in the JSON serialization.

- [ ] **Step 5: Run tests to confirm they pass**

```bash
cd auxserver && python -m pytest tests/test_building_migration.py -v
```
Expected: 3 PASS

- [ ] **Step 6: Commit**

```bash
git add auxserver/services/database.py auxserver/tests/test_building_migration.py
git commit -m "feat: save migration — remap legacy furnace/log_cutter to crafting_station on load"
```

---

## Task 4: Server — generic station tick + placement + conveyor

**Files:**
- Modify: `auxserver/services/building.py:118-175` (placement)
- Modify: `auxserver/services/building.py:238-394` (tick, conveyor)

Context: The `_tick_buildings` method has hardcoded `elif kind == "furnace":` and `elif kind == "log_cutter":` branches. The `_place_building` method has an allowlist and hardcoded gate/fence cost logic. The conveyor push logic checks `nb["kind"] in ("crate", "furnace", "log_cutter")`. All three must be updated atomically — the server allowlist change and client hotbar change (Task 6) should land in the same commit to prevent clients sending old kind names.

**Important**: `asset_id` on a building is stored in `b["asset_id"]`, extracted from `b["stored"]["_asset_id"]` during `load_buildings`. For a newly placed station it's passed directly in the placement message.

- [ ] **Step 1: Write tests for generic station tick**

Create `auxserver/tests/test_station_tick.py`:

```python
import pytest
from unittest.mock import MagicMock
from schemas.assets import CraftingStationDef, StationRecipe


def make_station_def(inputs, fuel_type, fuel_cost, outputs, process_time=5.0):
    recipe = StationRecipe(inputs=inputs, fuel_cost=fuel_cost,
                           outputs=outputs, process_time=process_time)
    return CraftingStationDef(
        id="test_st", label="Test", station_type="smelter",
        speed_bonus=1.0, fuel_type=fuel_type,
        recipes=[recipe], build_recipe={}
    )


def make_gs(building_stored):
    gs = MagicMock()
    b = {"kind": "crafting_station", "asset_id": "test_st",
         "stored": dict(building_stored), "col": 0, "row": 0, "map": "level_01"}
    gs.buildings = {"b1": b}
    return gs, b


def run_tick(gs, station_def, dt=1.0):
    from services.building import BuildingService
    svc = BuildingService(gs)
    gs.asset_registry = MagicMock()
    gs.asset_registry.get_crafting_station.return_value = station_def

    # Inject into module-level asset_registry used by building.py
    import services.building as bmod
    original = bmod.asset_registry
    bmod.asset_registry = gs.asset_registry
    try:
        svc._tick_buildings(dt, 0.0)
    finally:
        bmod.asset_registry = original
    return gs.buildings["b1"]["stored"]


def test_station_fires_when_inputs_met():
    st_def = make_station_def(
        inputs={"iron_ore": 2}, fuel_type="none", fuel_cost=0,
        outputs={"iron_bar": 1}, process_time=3.0
    )
    gs, _ = make_gs({"iron_ore": 4})
    stored = run_tick(gs, st_def, dt=3.0)
    assert stored.get("iron_bar", 0) == 1
    assert stored.get("iron_ore", 0) == 2


def test_station_does_not_fire_when_input_missing():
    st_def = make_station_def(
        inputs={"iron_ore": 2}, fuel_type="none", fuel_cost=0,
        outputs={"iron_bar": 1}, process_time=3.0
    )
    gs, _ = make_gs({"iron_ore": 1})  # only 1, need 2
    stored = run_tick(gs, st_def, dt=5.0)
    assert stored.get("iron_bar", 0) == 0


def test_station_requires_fuel():
    st_def = make_station_def(
        inputs={"ore": 1}, fuel_type="coal", fuel_cost=1,
        outputs={"ingot": 1}, process_time=3.0
    )
    gs, _ = make_gs({"ore": 2})  # no fuel
    stored = run_tick(gs, st_def, dt=5.0)
    assert stored.get("ingot", 0) == 0  # no fuel → no output


def test_station_consumes_fuel():
    st_def = make_station_def(
        inputs={"ore": 1}, fuel_type="coal", fuel_cost=1,
        outputs={"ingot": 1}, process_time=3.0
    )
    gs, _ = make_gs({"ore": 2, "coal": 3})
    stored = run_tick(gs, st_def, dt=3.0)
    assert stored.get("ingot", 0) == 1
    assert stored.get("coal", 0) == 2  # consumed 1
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd auxserver && python -m pytest tests/test_station_tick.py -v
```
Expected: FAIL — no `crafting_station` branch in `_tick_buildings` yet.

- [ ] **Step 3: Replace hardcoded tick branches with generic station tick**

In `auxserver/services/building.py`, replace the `elif kind == "log_cutter":` block (lines ~397-424) and the `elif kind == "furnace":` block (lines ~427-468) with:

```python
            # ── Generic Crafting Station ───────────────────────────
            elif kind == "crafting_station":
                asset_id = b.get("asset_id", "")
                station_def = asset_registry.get_crafting_station(asset_id)
                if not station_def:
                    continue
                for recipe in station_def.recipes:
                    # Check all inputs present
                    if not all(stored.get(r, 0) >= qty for r, qty in recipe.inputs.items()):
                        continue
                    # Check fuel if needed
                    if station_def.fuel_type != "none" and stored.get(station_def.fuel_type, 0) < recipe.fuel_cost:
                        continue
                    # Accumulate time
                    accum = b.get("_accum", 0.0) + dt
                    process_time = recipe.process_time / station_def.speed_bonus
                    if accum < process_time:
                        b["_accum"] = accum
                        break
                    # Fire: consume inputs + fuel, add outputs
                    b["_accum"] = 0.0
                    for r, qty in recipe.inputs.items():
                        stored[r] = stored.get(r, 0) - qty
                        if stored[r] <= 0:
                            del stored[r]
                    if station_def.fuel_type != "none":
                        stored[station_def.fuel_type] = stored.get(station_def.fuel_type, 0) - recipe.fuel_cost
                        if stored.get(station_def.fuel_type, 0) <= 0:
                            stored.pop(station_def.fuel_type, None)
                    for r, qty in recipe.outputs.items():
                        stored[r] = stored.get(r, 0) + qty
                    break
```

- [ ] **Step 4: Update `_place_building` to accept `crafting_station`**

In `_place_building`, replace the allowlist line (line ~121):
```python
if kind not in ("conveyor", "crate", "furnace", "log_cutter", "etrainer", "track", "gate", "fence"):
```
With:
```python
if kind not in ("conveyor", "crate", "crafting_station", "etrainer", "track", "gate", "fence"):
```

After the `player_map` line, add asset_id handling for crafting stations:
```python
        # Crafting station: read asset_id from placement data
        asset_id = ""
        if kind == "crafting_station":
            asset_id = data.get("asset_id", "")
            if not asset_id:
                logger.warning("_place_building: crafting_station missing asset_id")
                return
            # Check build_recipe cost
            station_def = asset_registry.get_crafting_station(asset_id)
            if station_def:
                inv = p.setdefault("inventory", {})
                for item_id, qty in station_def.build_recipe.items():
                    if inv.get(item_id, 0) < qty:
                        self.gs.fx_events.append({"type": "chat_hint", "pid": pid,
                                                   "text": f"Need {qty}x {item_id} to build this."})
                        return
                for item_id, qty in station_def.build_recipe.items():
                    inv[item_id] = inv.get(item_id, 0) - qty
                    if inv[item_id] <= 0:
                        del inv[item_id]
```

Add `asset_id` to the building dict (after the `bld = {...}` block):
```python
        if asset_id:
            bld["asset_id"] = asset_id
```

- [ ] **Step 5: Update conveyor push/pull to use `crafting_station`**

In `_tick_buildings`, the conveyor push check around line 320:
```python
                    if nb and nb["kind"] in ("crate", "furnace", "log_cutter"):
```
Change to:
```python
                    if nb and nb["kind"] in ("crate", "crafting_station"):
```

Replace the furnace/log_cutter push branches (`elif nb["kind"] == "log_cutter":` and `elif nb["kind"] == "furnace":`) with a single crafting_station branch:
```python
                        elif nb["kind"] == "crafting_station":
                            nb_asset_id = nb.get("asset_id", "")
                            nb_def = asset_registry.get_crafting_station(nb_asset_id)
                            if nb_def:
                                # Accept if resource is an input in any recipe
                                is_input = any(resource in r.inputs for r in nb_def.recipes)
                                is_fuel = (nb_def.fuel_type != "none" and resource == nb_def.fuel_type)
                                if is_input:
                                    cap = 5
                                    cur = nb_stored.get(resource, 0)
                                    if cur < cap:
                                        nb_stored[resource] = min(cap, cur + amount)
                                        accepted = True
                                elif is_fuel:
                                    cur = nb_stored.get(resource, 0)
                                    if cur < 10:
                                        nb_stored[resource] = min(10, cur + amount)
                                        accepted = True
```

For the pull side (around line 375):
```python
                    if nb and nb["kind"] in ("crate", "furnace", "log_cutter"):
```
Change to:
```python
                    if nb and nb["kind"] in ("crate", "crafting_station"):
```

Replace the hardcoded furnace/log_cutter pull key logic:
```python
                        # Furnaces: only pull output (bronze_bar)
                        if nb["kind"] == "furnace":
                            pull_keys = ["bronze_bar"]
                        # Log cutters: only pull output (planks)
                        elif nb["kind"] == "log_cutter":
                            pull_keys = ["planks"]
                        else:
                            pull_keys = list(nb_stored.keys())
```
With:
```python
                        if nb["kind"] == "crafting_station":
                            nb_asset_id = nb.get("asset_id", "")
                            nb_def = asset_registry.get_crafting_station(nb_asset_id)
                            if nb_def:
                                # Only pull items that are recipe outputs
                                output_keys = {k for r in nb_def.recipes for k in r.outputs}
                                pull_keys = [k for k in nb_stored if k in output_keys]
                            else:
                                pull_keys = []
                        else:
                            pull_keys = list(nb_stored.keys())
```

- [ ] **Step 6: Run station tick tests to confirm they pass**

```bash
cd auxserver && python -m pytest tests/test_station_tick.py -v
```
Expected: 4 PASS

- [ ] **Step 7: Commit**

```bash
git add auxserver/services/building.py auxserver/tests/test_station_tick.py
git commit -m "feat: generic crafting_station tick, placement, conveyor push/pull in building.py"
```

---

## Task 5: Update asset editor JS to use new `inputs`/`outputs`/`fuel_cost` recipe shape

**Files:**
- Modify: `auxserver/static/asseteditor.js:1281-1350` (station recipe rendering and saving)

Context: The existing station recipe UI uses `input_item`, `input_qty`, `output_item`, `output_min`, `output_max` fields (old schema). It must be updated to use `inputs: dict`, `outputs: dict`, `fuel_cost: int`. The UI should show multiple input rows and multiple output rows per recipe. This is a pure JS/HTML change — no Python tests.

**How the new recipe card should look:**
- Inputs section: dynamic rows (item → qty pairs), "Add Input" button
- Outputs section: dynamic rows (item → qty pairs), "Add Output" button
- Fuel Cost: single number field
- Process Time: single number field

- [ ] **Step 1: Replace `addSTRecipe` default object shape**

In `asseteditor.js`, find `addSTRecipe()` (around line 1326) and change the pushed recipe object from:
```js
  selectedST.recipes.push({
    input_item: defaultItem, input_qty: 10,
    output_item: defaultItem, output_min: 2, output_max: 5,
    process_time: 5.0,
  });
```
To:
```js
  selectedST.recipes.push({
    inputs: {},
    outputs: {},
    fuel_cost: 0,
    process_time: 5.0,
  });
```

- [ ] **Step 2: Replace `renderSTRecipes()` to render the new shape**

Find `renderSTRecipes()` (starts around line 1283) and replace the entire function body with:

```js
function renderSTRecipes() {
  const container = document.getElementById('stRecipes');
  if (!container) return;
  container.innerHTML = '';
  const recipes = selectedST.recipes || [];
  for (let i = 0; i < recipes.length; i++) {
    const r = recipes[i];
    const card = document.createElement('div');
    card.className = 'recipe-card';

    // Build inputs rows HTML
    const inputRows = Object.entries(r.inputs || {}).map(([res, qty], j) =>
      `<div class="ing-row" data-ri="${i}" data-side="inputs" data-j="${j}">
        <input class="ing-res" value="${res}" oninput="updateSTRecipeDict(this, ${i}, 'inputs', ${j})" />
        <input class="ing-amt" type="number" value="${qty}" min="1" oninput="updateSTRecipeDictQty(this, ${i}, 'inputs', ${j})" />
        <button onclick="removeSTRecipeDictRow(${i}, 'inputs', '${res}')">x</button>
      </div>`
    ).join('');

    // Build outputs rows HTML
    const outputRows = Object.entries(r.outputs || {}).map(([res, qty], j) =>
      `<div class="ing-row" data-ri="${i}" data-side="outputs" data-j="${j}">
        <input class="ing-res" value="${res}" oninput="updateSTRecipeDict(this, ${i}, 'outputs', ${j})" />
        <input class="ing-amt" type="number" value="${qty}" min="1" oninput="updateSTRecipeDictQty(this, ${i}, 'outputs', ${j})" />
        <button onclick="removeSTRecipeDictRow(${i}, 'outputs', '${res}')">x</button>
      </div>`
    ).join('');

    card.innerHTML = `
      <div class="recipe-card-header">
        <span>Recipe ${i + 1}</span>
        <button onclick="removeSTRecipe(${i})">x</button>
      </div>
      <div class="section-label">Inputs</div>
      <div id="stRecipeInputs_${i}">${inputRows}</div>
      <button class="btn-add-row" onclick="addSTRecipeDictRow(${i}, 'inputs')">+ Input</button>
      <div class="section-label">Outputs</div>
      <div id="stRecipeOutputs_${i}">${outputRows}</div>
      <button class="btn-add-row" onclick="addSTRecipeDictRow(${i}, 'outputs')">+ Output</button>
      <div class="form-row">
        <div class="form-group"><label>Fuel Cost</label>
          <input type="number" value="${r.fuel_cost ?? 0}" min="0" data-i="${i}" data-f="fuel_cost" onchange="updateSTRecipeScalar(this)" />
        </div>
        <div class="form-group"><label>Process Time (s)</label>
          <input type="number" value="${r.process_time ?? 5}" min="0.5" step="0.5" data-i="${i}" data-f="process_time" onchange="updateSTRecipeScalar(this)" />
        </div>
      </div>
    `;
    container.appendChild(card);
  }
}
```

- [ ] **Step 3: Add helper functions for dict row management**

Replace `updateSTRecipeField` with the new set of helpers (add after `updateSTRecipeField` or replace it):

```js
function updateSTRecipeScalar(el) {
  const i = Number(el.dataset.i);
  const f = el.dataset.f;
  selectedST.recipes[i][f] = Number(el.value);
}

function addSTRecipeDictRow(i, side) {
  if (!selectedST.recipes[i][side]) selectedST.recipes[i][side] = {};
  selectedST.recipes[i][side][''] = 1;
  renderSTRecipes();
}

function removeSTRecipeDictRow(i, side, res) {
  delete selectedST.recipes[i][side][res];
  renderSTRecipes();
}

function updateSTRecipeDict(el, i, side, j) {
  // Rename a key in the dict (user changed the resource name)
  const dict = selectedST.recipes[i][side];
  const keys = Object.keys(dict);
  if (keys[j] !== undefined) {
    const oldKey = keys[j];
    const val = dict[oldKey];
    delete dict[oldKey];
    dict[el.value] = val;
  }
}

function updateSTRecipeDictQty(el, i, side, j) {
  const dict = selectedST.recipes[i][side];
  const keys = Object.keys(dict);
  if (keys[j] !== undefined) {
    dict[keys[j]] = Number(el.value);
  }
}
```

- [ ] **Step 4: Remove the old `updateSTRecipeField` function**

Delete the old `updateSTRecipeField` function (around line 1342-1350):
```js
function updateSTRecipeField(el) {
  const i = Number(el.dataset.i);
  const f = el.dataset.f;
  if (f === 'input_item' || f === 'output_item') {
    selectedST.recipes[i][f] = el.value;
  } else {
    selectedST.recipes[i][f] = Number(el.value);
  }
}
```

- [ ] **Step 5: Test in browser**

Open `/api/assets/editor` → Crafting Stations tab. Add a new station, add a recipe, verify inputs/outputs/fuel_cost fields appear correctly. Save and reload to confirm roundtrip.

- [ ] **Step 6: Commit**

```bash
git add auxserver/static/asseteditor.js
git commit -m "feat: update asset editor station recipe UI to use inputs/outputs/fuel_cost dict shape"
```

---

## Task 6: Client — replace hotbar `place_furnace`/`place_log_cutter` with `place_crafting_station` picker

**Files:**
- Modify: `src/ui/InventoryController.js`

Context: The hotbar currently has two separate entries: `place_furnace` and `place_log_cutter`. These send `place_building` with `kind: "furnace"` or `kind: "log_cutter"`. After Task 4, the server no longer accepts those kind names. This task replaces both with a single `place_crafting_station` hotbar button that fetches `/api/assets/crafting_stations` and shows a picker panel. The player selects a station type; the client calls `scene._placement.startPlacing('crafting_station')` and augments the final `place_building` message with `asset_id`.

**How placement works today**: `PlacementSystem._sendPlaceBuilding(kind, col, row, direction)` sends `{ type: 'place_building', kind, col, row, direction }`. For crafting stations it needs to also include `asset_id`. The cleanest approach: add an optional `extraData` param to `_sendPlaceBuilding` and pass `{ asset_id }`.

- [ ] **Step 1: Update `HOTBAR_ACTIONS` — replace two entries with one**

In `InventoryController.js` around lines 34-35, replace:
```js
  place_furnace: { id: 'place_furnace', label: 'Furnace', frame: FRAME_FURNACE },
  place_log_cutter: { id: 'place_log_cutter', label: 'Log Cutter', frame: FRAME_LOG_CUTTER },
```
With:
```js
  place_crafting_station: { id: 'place_crafting_station', label: 'Station', frame: FRAME_FURNACE },
```

- [ ] **Step 2: Update the hotbar default array**

Around lines 148-149, replace:
```js
      HOTBAR_ACTIONS.place_furnace,
      HOTBAR_ACTIONS.place_log_cutter,
```
With:
```js
      HOTBAR_ACTIONS.place_crafting_station,
```

- [ ] **Step 3: Update the activate handler**

Around lines 229-230, replace:
```js
    else if (item.id === 'place_furnace') this.toggleFurnacePlacement();
    else if (item.id === 'place_log_cutter') this.toggleLogCutterPlacement();
```
With:
```js
    else if (item.id === 'place_crafting_station') this.toggleCraftingStationPicker();
```

- [ ] **Step 4: Add `toggleCraftingStationPicker()` and `_showStationPicker()`**

Add after `toggleCratePlacement()` (around line 255):

```js
  async toggleCraftingStationPicker() {
    const scene = this._scene;
    if (!scene._placement) return;
    if (scene._placement.isActive()) {
      scene._placement.cancel();
      return;
    }
    await this._showStationPicker();
  }

  async _showStationPicker() {
    const scene = this._scene;
    // Fetch station manifest (cached after first call)
    if (!this._stationManifest) {
      try {
        const resp = await fetch('/api/assets/crafting_stations');
        this._stationManifest = await resp.json();
      } catch (e) {
        console.warn('Failed to fetch crafting stations:', e);
        return;
      }
    }
    const stations = Object.values(this._stationManifest);
    if (stations.length === 0) return;

    // Remove existing picker if any
    document.getElementById('_stationPickerPanel')?.remove();

    const panel = document.createElement('div');
    panel.id = '_stationPickerPanel';
    panel.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#222;border:1px solid #555;border-radius:6px;padding:12px;z-index:9999;min-width:200px;';
    panel.innerHTML = '<div style="color:#eee;font-size:13px;margin-bottom:8px;">Select Station</div>';

    for (const st of stations) {
      const btn = document.createElement('button');
      btn.style.cssText = 'display:block;width:100%;margin-bottom:4px;padding:6px 10px;background:#333;color:#eee;border:1px solid #666;border-radius:4px;cursor:pointer;text-align:left;';
      const cost = Object.entries(st.build_recipe || {}).map(([k, v]) => `${v}x ${k}`).join(', ');
      btn.innerHTML = `<b>${st.label}</b>${cost ? `<span style="color:#aaa;font-size:11px;margin-left:6px;">(${cost})</span>` : ''}`;
      btn.onclick = () => {
        panel.remove();
        this._selectedStationAssetId = st.id;
        scene._placement.startPlacing('crafting_station');
      };
      panel.appendChild(btn);
    }

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'display:block;width:100%;padding:6px;background:#444;color:#aaa;border:1px solid #555;border-radius:4px;cursor:pointer;margin-top:4px;';
    cancelBtn.onclick = () => panel.remove();
    panel.appendChild(cancelBtn);

    document.body.appendChild(panel);
  }
```

- [ ] **Step 5: Update `PlacementSystem` to include `asset_id` in the message**

In `src/systems/PlacementSystem.js`, update `_sendPlaceBuilding`:
```js
  _sendPlaceBuilding(kind, col, row, direction = '', extraData = {}) {
    this._scene._conn?.send({
      type: 'place_building', kind, col, row, direction, ...extraData,
    });
  }
```

And wherever `_sendPlaceBuilding` is called for non-conveyor/track kinds (single tile placements), pass `extraData` if `kind === 'crafting_station'`. Find the single-tile placement confirmation code (look for `this._sendPlaceBuilding(this._buildType` for single types) and update to:

```js
    const extra = this._buildType === 'crafting_station'
      ? { asset_id: this._scene._inventoryController?._selectedStationAssetId || '' }
      : {};
    this._sendPlaceBuilding(this._buildType, col, row, dir, extra);
```

- [ ] **Step 6: Remove old `toggleFurnacePlacement` and `toggleLogCutterPlacement` methods**

Delete the two methods (lines ~257-275 in `InventoryController.js`).

- [ ] **Step 7: Test in browser**

1. Click the "Station" hotbar button — picker should appear listing Bronze Furnace and Log Cutter
2. Select Bronze Furnace — placement ghost appears
3. Click to place — furnace should appear on the map
4. Log out/in — building should persist as `crafting_station` with `asset_id: "bronze_furnace"`

- [ ] **Step 8: Commit (must be atomic with server allowlist change from Task 4)**

```bash
git add src/ui/InventoryController.js src/systems/PlacementSystem.js
git commit -m "feat: replace place_furnace/log_cutter hotbar with generic crafting_station picker"
```

---

## Task 7: Station viewer overlay (right-click deposit/withdraw UI)

**Files:**
- Modify: `src/scenes/GameScene.js` (right-click handler, ~line 172)
- Create: `src/ui/StationViewerPanel.js`

Context: Right-clicking a crate opens a storage UI. Right-clicking a `crafting_station` should open a similar panel showing stored contents (inputs, fuel, outputs) with deposit/withdraw buttons. The `update_building_stored` message already exists for mutations. The station def (fetched at login via `/api/assets/crafting_stations`) is needed to label which items are inputs vs outputs.

- [ ] **Step 1: Create `StationViewerPanel.js`**

Create `src/ui/StationViewerPanel.js`:

```js
/**
 * StationViewerPanel — right-click overlay for crafting_station buildings.
 * Shows current stored contents with deposit/withdraw buttons.
 */
export class StationViewerPanel {
  constructor(scene) {
    this._scene = scene;
    this._el = null;
  }

  open(building, stationDef) {
    this.close();
    const stored = building.getStored ? building.getStored() : (building.stored || {});
    const bid = building._serverId || building.id;
    const label = stationDef?.label || bid;

    const panel = document.createElement('div');
    panel.id = '_stationViewerPanel';
    panel.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#1a1a2e;border:2px solid #666;border-radius:8px;padding:16px;z-index:9999;min-width:280px;color:#eee;font-family:monospace;';

    let html = `<div style="font-size:15px;font-weight:bold;margin-bottom:12px;">${label}</div>`;
    html += '<div style="font-size:12px;color:#aaa;margin-bottom:8px;">Stored Contents</div>';

    const entries = Object.entries(stored);
    if (entries.length === 0) {
      html += '<div style="color:#666;font-size:12px;">Empty</div>';
    } else {
      for (const [item, qty] of entries) {
        if (qty <= 0) continue;
        html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;padding:4px 8px;background:#2a2a3e;border-radius:4px;">
          <span>${item}: <b>${qty}</b></span>
          <span>
            <button onclick="window._stationViewer?.withdraw('${item}',1,'${bid}')" style="background:#334;border:1px solid #556;color:#eee;padding:2px 8px;cursor:pointer;border-radius:3px;margin-right:4px;">-1</button>
            <button onclick="window._stationViewer?.deposit('${item}',1,'${bid}')" style="background:#334;border:1px solid #556;color:#eee;padding:2px 8px;cursor:pointer;border-radius:3px;">+1</button>
          </span>
        </div>`;
      }
    }

    html += `<div style="margin-top:12px;">
      <button onclick="window._stationViewer?.close()" style="background:#333;border:1px solid #555;color:#aaa;padding:6px 16px;cursor:pointer;border-radius:4px;">Close</button>
    </div>`;

    panel.innerHTML = html;
    document.body.appendChild(panel);
    this._el = panel;
    this._building = building;
    this._bid = bid;

    window._stationViewer = this;
  }

  deposit(item, qty, bid) {
    const scene = this._scene;
    const p = scene.player;
    if (!p) return;
    // Deduct from player inventory
    const inv = scene._playerInventory || {};
    if ((inv[item] || 0) < qty) return;
    inv[item] = (inv[item] || 0) - qty;
    if (inv[item] <= 0) delete inv[item];
    // Add to building stored
    const stored = this._building.getStored ? this._building.getStored() : {};
    stored[item] = (stored[item] || 0) + qty;
    if (this._building.setStored) this._building.setStored(stored);
    // Notify server
    scene._conn?.send({ type: 'update_building_stored', building_id: bid, stored });
    this.open(this._building, this._stationDef);
  }

  withdraw(item, qty, bid) {
    const scene = this._scene;
    const stored = this._building.getStored ? this._building.getStored() : {};
    if ((stored[item] || 0) < qty) return;
    stored[item] = (stored[item] || 0) - qty;
    if (stored[item] <= 0) delete stored[item];
    if (this._building.setStored) this._building.setStored(stored);
    // Add to player inventory
    const inv = scene._playerInventory || {};
    inv[item] = (inv[item] || 0) + qty;
    // Notify server
    scene._conn?.send({ type: 'update_building_stored', building_id: bid, stored });
    this.open(this._building, this._stationDef);
  }

  close() {
    this._el?.remove();
    this._el = null;
    window._stationViewer = null;
  }
}
```

- [ ] **Step 2: Wire into GameScene right-click handler**

In `GameScene.js`, find the `object-right-clicked` handler around line 171:
```js
      if (type === 'conveyor' || type === 'crate' || type === 'furnace' || type === 'log_cutter' || type === 'track' || type === 'gate' || type === 'fence') {
```
Update to:
```js
      if (type === 'conveyor' || type === 'crate' || type === 'crafting_station' || type === 'track' || type === 'gate' || type === 'fence') {
```

After the `this._openBuildingContextMenu(bid, type, ptr, obj)` line, add special handling for crafting stations — right-click on a `crafting_station` opens the viewer panel instead of (or in addition to) the remove context menu:

```js
        if (type === 'crafting_station') {
          const stationDef = this._craftingStationManifest?.[obj._assetId];
          this._stationViewer?.open(obj, stationDef);
          return;
        }
```

Import `StationViewerPanel` at the top of `GameScene.js` and initialize in `create()`:
```js
import { StationViewerPanel } from '../ui/StationViewerPanel.js';
// in create():
this._stationViewer = new StationViewerPanel(this);
```

Also ensure `_craftingStationManifest` is populated from the manifest fetch. In `_fetchAssetManifest()`, add a fetch for crafting stations:
```js
    const stResp = await fetch('/api/assets/crafting_stations');
    this._craftingStationManifest = await stResp.json();
```

And when spawning a crafting_station building, set `_assetId` on the sprite:
```js
    // wherever furnaces/log_cutters were spawned, add crafting_station case:
    // buildingSprite._assetId = bldData.asset_id;
```

- [ ] **Step 3: Test in browser**

1. Place a crafting station
2. Right-click it — station viewer should open
3. Deposit an item — stored contents update and message sent to server
4. Withdraw an item — inverse

- [ ] **Step 4: Commit**

```bash
git add src/ui/StationViewerPanel.js src/scenes/GameScene.js
git commit -m "feat: station viewer overlay — right-click deposit/withdraw UI for crafting stations"
```

---

## Task 8: Wire crafting_station building spawning in GameScene

**Files:**
- Modify: `src/scenes/GameScene.js` (building spawn handler, look for where `furnace`/`log_cutter` buildings are created)

Context: When the server sends building data, `GameScene.js` creates client-side entity objects for each building. Currently it has specific branches for `furnace` and `log_cutter`. These must be replaced with a `crafting_station` branch that creates an appropriate sprite/entity and registers it for proximity updates.

- [ ] **Step 1: Find the building spawn code**

Search `GameScene.js` for `kind === 'furnace'` or where `this._furnaces.push(...)` occurs. Understand the building entity class used (likely `Furnace` or similar). Note how it's added to `this._furnaces` and `this._buildingSprites`.

**Important:** `Furnace.js` is fully hardcoded for bronze furnace (`addToStorage` only accepts `raw_copper`/`raw_tin`/`planks`, `getStored` only returns those four keys). It cannot be reused. Create a new generic `CraftingStation.js` entity.

- [ ] **Step 2: Create `src/entities/CraftingStation.js`**

```js
import Phaser from 'phaser';
import { SHEET_KEY, SHEET_TILE, TILE_SIZE, FRAME_FURNACE, INTERACT_DIST } from '../constants.js';

const SCALE = TILE_SIZE / SHEET_TILE;

export class CraftingStation extends Phaser.GameObjects.Image {
  constructor(scene, x, y, assetId, label, initialStored = {}) {
    super(scene, x, y, SHEET_KEY, FRAME_FURNACE);
    scene.add.existing(this);
    this.setDepth(1).setScale(SCALE);
    this.col = Math.round((x - TILE_SIZE / 2) / TILE_SIZE);
    this.row = Math.round((y - TILE_SIZE / 2) / TILE_SIZE);
    this._assetId = assetId;
    this._stored = { ...initialStored };

    this.setInteractive({ useHandCursor: true });
    this.on('pointerdown', (ptr) => {
      if (ptr.rightButtonDown()) {
        scene.events.emit('object-right-clicked', { type: 'crafting_station', obj: this, ptr });
      }
    });

    this._label = scene.add.text(x, y - TILE_SIZE / 2 - 4, label || assetId, {
      fontSize: '10px', color: '#ff9944', align: 'center',
      backgroundColor: '#00000088', padding: { x: 3, y: 2 },
    }).setOrigin(0.5, 1).setDepth(3).setVisible(false);

    this._prompt = scene.add.text(x, y - TILE_SIZE / 2 - 18, '[E] Station', {
      fontSize: '10px', color: '#ffffff', align: 'center',
      backgroundColor: '#00000088', padding: { x: 3, y: 2 },
    }).setOrigin(0.5, 1).setDepth(3).setVisible(false);
  }

  updateProximity(playerX, playerY) {
    const d = Phaser.Math.Distance.Between(playerX, playerY, this.x, this.y);
    this._prompt.setVisible(d <= INTERACT_DIST);
    this._label.setVisible(d <= TILE_SIZE * 2);
  }

  getStored() { return { ...this._stored }; }

  addToStorage(resource, amount) {
    this._stored[resource] = (this._stored[resource] || 0) + amount;
    return true;
  }

  removeFromStorage(resource, amount) {
    if ((this._stored[resource] || 0) < amount) return false;
    this._stored[resource] -= amount;
    if (this._stored[resource] <= 0) delete this._stored[resource];
    return true;
  }

  applyServerStored(stored) { this._stored = { ...stored }; }

  setGrid(grid) { this._grid = grid; }

  destroy(fromScene) {
    this._label?.destroy();
    this._prompt?.destroy();
    super.destroy(fromScene);
  }
}
```

- [ ] **Step 3: Wire into GameScene building spawn**

Add import at top of `GameScene.js`:
```js
import { CraftingStation } from '../entities/CraftingStation.js';
```

In the building spawn loop (find where `kind === 'furnace'` spawns), add:
```js
} else if (bldData.kind === 'crafting_station') {
    const stDef = this._craftingStationManifest?.[bldData.asset_id];
    const entity = new CraftingStation(
        this,
        bldData.col * TILE_SIZE + TILE_SIZE / 2,
        bldData.row * TILE_SIZE + TILE_SIZE / 2,
        bldData.asset_id || '',
        stDef?.label || bldData.asset_id,
        bldData.stored || {}
    );
    entity._serverId = bldData.id;
    entity.setGrid(this.grid);
    this._craftingStations = this._craftingStations || [];
    this._craftingStations.push(entity);
    this._buildingSprites[bldData.id] = entity;
}
```

In `GameScene.update()`, after the furnace proximity loop, add:
```js
    for (const station of (this._craftingStations || [])) {
      station.updateProximity(this.player.x, this.player.y);
    }
```

- [ ] **Step 4: Remove old `furnace`/`log_cutter` spawn branches**

Since save migration converts them on load, the server will never send `kind: "furnace"` or `kind: "log_cutter"` to clients. Remove those spawn branches and the `this._furnaces` / `this._logCutters` arrays if they become unused.

- [ ] **Step 5: Test in browser**

Start the server with existing save data. Verify:
- Existing furnaces appear on the map as `CraftingStation` entities (migration ran on load)
- Bronze furnace processes `raw_copper×2 + raw_tin×1 → bronze_bar` (server-driven)
- Log cutter processes `Wood×1 → planks×3` (server-driven)
- Conveyors feed into and pull from both station types

- [ ] **Step 6: Commit**

```bash
git add src/entities/CraftingStation.js src/scenes/GameScene.js
git commit -m "feat: generic CraftingStation entity + spawn in GameScene, remove hardcoded Furnace/LogCuttingStation spawns"
```

---

## Acceptance Criteria Verification

Before calling this complete, verify all items from the spec:

- [ ] Existing furnace behavior preserved: `raw_copper×2 + raw_tin×1 + planks (fuel) → bronze_bar`, 5s cycle
- [ ] Existing log_cutter behavior preserved: `Wood×1 → planks×3`, 2s cycle
- [ ] Existing save files load correctly (migration runs transparently, no data loss)
- [ ] Conveyors feed inputs into crafting stations (cap 5 per input resource, 10 for fuel)
- [ ] Conveyors pull outputs from crafting stations
- [ ] A new station defined only in the asset editor (no server code) works end-to-end
- [ ] Station viewer opens on right-click, shows stored contents, deposit/withdraw work
- [ ] `build_recipe` cost deducted from player inventory on placement (if non-empty)
- [ ] Run full server test suite: `cd auxserver && python -m pytest tests/ -v`
