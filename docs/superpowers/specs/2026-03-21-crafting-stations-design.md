# Data-Driven Crafting Stations — Design Spec

**Date:** 2026-03-21

## Goal

Replace the hardcoded furnace and log_cutter buildings with a generic, data-driven crafting station system. Stations are defined in the asset editor and automatically work in-game — processing recipes, accepting conveyor input, and producing output — with no additional server code per station type.

---

## Scope

This spec covers three things:

1. **Asset registry** — load crafting station definitions from `assets/crafting_stations/`
2. **Server** — generic station tick, placement with `build_recipe` cost, conveyor integration, save migration
3. **Client** — station picker UI on placement, station viewer overlay on right-click

Metallurgy skill (gating stations by player level) is **out of scope** — separate spec.

---

## Section 1: Asset Registry

### New files authored in the asset editor

`assets/crafting_stations/bronze_furnace/station.json`:
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

`assets/crafting_stations/log_cutter/station.json`:
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

### `asset_registry.py` changes

- Add `crafting_stations: dict[str, CraftingStationDef] = {}` to `AssetRegistry`
- Add `get_crafting_station(station_id: str) -> Optional[CraftingStationDef]`
- In `load_all()`, scan `assets/crafting_stations/*/station.json` and parse each as `CraftingStationDef`
- Add `GET /api/assets/crafting_stations` endpoint returning the full manifest (id, label, build_recipe, sprite per station)

### `StationRecipe` schema migration (required)

The existing `StationRecipe` in `schemas/assets.py` uses single-item fields:
```python
input_item: str; input_qty: int; output_item: str; output_min: int; output_max: int
```

This must be migrated to support multi-input, multi-output recipes:
```python
class StationRecipe(BaseModel):
    inputs: dict[str, int] = {}      # item_id → quantity required
    outputs: dict[str, int] = {}     # item_id → quantity produced
    fuel_cost: int = 0               # units of station fuel_type consumed
    process_time: float = 5.0        # seconds per cycle
```

The asset editor's crafting stations tab must be updated to save/load this new shape. Any existing station JSON files using the old shape must be migrated.

---

## Section 2: Server

### Placement (`building.py` — `_place_building`)

- Add `"crafting_station"` to the allowlist
- After placing, read the station def's `build_recipe`; for each ingredient, check player inventory has enough and deduct it. If inventory is short, reject with a chat hint. Stations with empty `build_recipe` are free.
- Remove `"furnace"` and `"log_cutter"` from the allowlist (they are now station asset IDs, not building kinds). **Note:** the client-side hotbar replacement must be deployed in the same commit as the server allowlist change so no client sends the old kind names.

### Building tick (`building.py` — `_tick_buildings`)

Replace the hardcoded `elif kind == "furnace":` and `elif kind == "log_cutter":` blocks with:

```python
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
        if station_def.fuel_type != "none":
            stored[station_def.fuel_type] = stored.get(station_def.fuel_type, 0) - recipe.fuel_cost
        for r, qty in recipe.outputs.items():
            stored[r] = stored.get(r, 0) + qty
        break
```

### Conveyor integration (`building.py` — conveyor push/pull)

- Push destination check: `("crate", "furnace", "log_cutter")` → `("crate", "crafting_station")`
- Push logic: for `crafting_station`, accept resource if it appears as an input in any recipe (cap at 5 per resource), OR if it matches `fuel_type` (cap at 10 for fuel, matching existing furnace behavior)
- Pull logic: for `crafting_station`, pull any resource that appears as an output in any recipe (replaces hardcoded `["bronze_bar"]` / `["planks"]`)

### Save migration (`database.py` — `load_buildings`)

On load, remap legacy building kinds:
```python
if b.get("kind") == "furnace":
    b["kind"] = "crafting_station"
    b["asset_id"] = "bronze_furnace"
elif b.get("kind") == "log_cutter":
    b["kind"] = "crafting_station"
    b["asset_id"] = "log_cutter"
```

---

## Section 3: Client

### Placement UI (`InventoryController.js`)

- Replace `place_furnace` and `place_log_cutter` hotbar actions with a single `place_crafting_station` action
- On activate, fetch `/api/assets/crafting_stations` (cached) and show a small picker panel listing available station types with their labels
- Player selects a station type; client sends `place_building` with `{ kind: "crafting_station", asset_id: "<selected_id>", col, row }`
- If `build_recipe` is non-empty, show required materials in the picker so player knows the cost

### Station viewer overlay

- Right-click on a placed `crafting_station` building opens a viewer overlay (similar to the crate storage UI)
- Shows: station label, current `stored` contents (inputs, fuel, outputs grouped by recipe)
- Deposit button: move item from player inventory into station `stored`
- Withdraw button: move item from station `stored` into player inventory
- Send `update_building_stored` message (already exists) for both actions

---

## File Map

**Create:**
- `assets/crafting_stations/bronze_furnace/station.json`
- `assets/crafting_stations/log_cutter/station.json`

**Modify:**
- `auxserver/services/asset_registry.py` — load crafting stations, add `get_crafting_station()`
- `auxserver/schemas/assets.py` — migrate `StationRecipe` to `inputs/outputs/fuel_cost` dict shape
- `auxserver/static/asseteditor.js` — update crafting stations tab to save/load new recipe shape
- `auxserver/api/assets.py` (or equivalent) — add `/api/assets/crafting_stations` endpoint
- `auxserver/services/building.py` — generic station tick, updated placement + conveyor logic
- `auxserver/services/database.py` — save migration in `load_buildings`
- `src/ui/InventoryController.js` — replace place_furnace/log_cutter with station picker
- `src/systems/PlacementSystem.js` — handle `place_crafting_station` action

---

## Acceptance Criteria

- [ ] Existing furnace behavior preserved: raw_copper + raw_tin + planks fuel → bronze_bar, same timing
- [ ] Existing log_cutter behavior preserved: Wood → planks, same timing
- [ ] Existing save files load correctly (migration runs transparently)
- [ ] Conveyors feed into and pull from crafting stations as before
- [ ] A new station type defined only in the asset editor (no server code) works end-to-end
- [ ] Station viewer shows stored contents and allows deposit/withdraw
- [ ] `build_recipe` cost is deducted on placement if non-empty
