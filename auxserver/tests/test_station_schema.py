from schemas.assets import StationRecipe, CraftingStationDef


def test_station_recipe_new_shape():
    r = StationRecipe(inputs={"raw_copper": 2, "raw_tin": 1}, fuel_cost=1,
                      outputs={"bronze_bar": 1}, process_time=5.0)
    assert r.inputs == {"raw_copper": 2, "raw_tin": 1}
    assert r.outputs == {"bronze_bar": 1}
    assert r.fuel_cost == 1
    assert r.process_time == 5.0


def test_station_def_loads_from_json():
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
