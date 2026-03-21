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
    import services.building as bmod
    svc = BuildingService(gs)
    mock_registry = MagicMock()
    mock_registry.get_crafting_station.return_value = station_def
    original = bmod.asset_registry
    bmod.asset_registry = mock_registry
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
    gs, _ = make_gs({"iron_ore": 1})
    stored = run_tick(gs, st_def, dt=5.0)
    assert stored.get("iron_bar", 0) == 0


def test_station_requires_fuel():
    st_def = make_station_def(
        inputs={"ore": 1}, fuel_type="coal", fuel_cost=1,
        outputs={"ingot": 1}, process_time=3.0
    )
    gs, _ = make_gs({"ore": 2})
    stored = run_tick(gs, st_def, dt=5.0)
    assert stored.get("ingot", 0) == 0


def test_station_consumes_fuel():
    st_def = make_station_def(
        inputs={"ore": 1}, fuel_type="coal", fuel_cost=1,
        outputs={"ingot": 1}, process_time=3.0
    )
    gs, _ = make_gs({"ore": 2, "coal": 3})
    stored = run_tick(gs, st_def, dt=3.0)
    assert stored.get("ingot", 0) == 1
    assert stored.get("coal", 0) == 2
