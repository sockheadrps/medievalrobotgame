import json
import sqlite3
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
    assert result["b1"]["stored"].get("planks") == 2
    assert "_asset_id" not in result["b1"]["stored"]


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
