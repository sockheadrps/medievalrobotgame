import json
from pathlib import Path
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
    cs_dir = tmp_path / "crafting_stations" / "test_smelter"
    cs_dir.mkdir(parents=True)
    (cs_dir / "station.json").write_text(json.dumps(STATION_JSON))
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
