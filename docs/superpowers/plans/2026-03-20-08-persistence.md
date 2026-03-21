# Data & Persistence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove unused DB tables, ensure save/load symmetry, add indexes on hot columns, and cache the asset registry manifest so it only scans disk once at startup.

**Architecture:** All changes are in-place on `database.py` and `asset_registry.py`. Schema migration uses `ALTER TABLE` / `DROP TABLE IF EXISTS` guarded by a version check. Asset registry gets a module-level dict populated once in `startup()`.

**Tech Stack:** Python, SQLite (stdlib sqlite3). No new dependencies.

**Spec:** `docs/superpowers/specs/refactor/08-persistence.md`

**Prerequisite:** Plan 01 (game_state.py split) must be **complete** — the symmetric save/load audit depends on the six new service modules being the final shape of persistence.

---

## File Map

**Modify:**
- `auxserver/services/database.py` — remove unused tables, add indexes, add schema version guard
- `auxserver/services/asset_registry.py` — add manifest cache, graceful error handling, warning logs
- `auxserver/tests/test_smoke.py` — add DB and registry smoke tests

---

### Task 1: Audit database tables

- [ ] List all tables currently defined in `database.py`:
```bash
grep -n "CREATE TABLE\|DROP TABLE\|def init_db" auxserver/services/database.py
```

- [ ] List all tables actually used (save/load calls):
```bash
grep -rn "INSERT INTO\|SELECT.*FROM\|UPDATE.*SET\|DELETE FROM" auxserver/services/ | grep -v ".pyc" | grep -v test_
```

- [ ] Cross-reference: tables defined but never queried → candidates for removal.

- [ ] List entity types that are saved but have no load function, or loaded but have no save function (asymmetric pairs).

- [ ] Record findings before touching any code.

---

### Task 2: Add schema versioning and remove unused tables

**Files:**
- Modify: `auxserver/services/database.py`

- [ ] Add a schema version table if not present:
```python
def init_db():
    conn = get_conn()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER PRIMARY KEY
        )
    """)
    row = conn.execute("SELECT version FROM schema_version").fetchone()
    current = row[0] if row else 0

    if current < 1:
        _migrate_v1(conn)
        conn.execute("INSERT OR REPLACE INTO schema_version VALUES (1)")
    conn.commit()
    conn.close()


def _migrate_v1(conn):
    """Remove unused tables identified in the audit."""
    # Replace with actual unused table names found in Task 1:
    unused = []  # e.g. ['old_events', 'temp_sessions']
    for table in unused:
        conn.execute(f"DROP TABLE IF EXISTS {table}")
```

- [ ] **Back up game.db before running** (WAL mode — must back up all 3 files):
```bash
sqlite3 auxserver/data/game.db ".backup auxserver/data/game.db.bak"
```
  This is WAL-safe. Do NOT use `cp game.db game.db.bak` alone — `game.db-shm` and `game.db-wal` also exist and a partial copy produces a corrupt backup.

- [ ] Start server: `uvicorn main:app --reload`
  Check logs — DB init runs, no errors.

- [ ] Verify game still loads: open game, player appears, NPCs are present.

- [ ] Commit:
```bash
git add auxserver/services/database.py
git commit -m "refactor: add schema versioning, remove unused DB tables"
```

---

### Task 3: Fix asymmetric save/load pairs

For each entity type found in Task 1 audit that is saved but not loaded (or vice versa):

- [ ] Add the missing function. Pattern:
```python
def save_<entity>(conn, entity_data: dict) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO <table> (col1, col2) VALUES (?, ?)",
        (entity_data['col1'], entity_data['col2'])
    )

def load_<entity>(conn, entity_id: str) -> dict | None:
    row = conn.execute(
        "SELECT col1, col2 FROM <table> WHERE id = ?", (entity_id,)
    ).fetchone()
    if row is None:
        return None
    return {'col1': row[0], 'col2': row[1]}
```

- [ ] Add smoke tests:
```python
def test_db_save_load_symmetry():
    """Verify each saved entity type has a matching load function."""
    from services.database import (
        save_player, load_player,
        # add each pair found in audit
    )
    assert callable(save_player) and callable(load_player)
```

- [ ] Run: `python -m pytest tests/test_smoke.py -v` — PASS.

- [ ] Commit:
```bash
git add auxserver/services/database.py auxserver/tests/test_smoke.py
git commit -m "refactor: add missing load functions for asymmetric save/load pairs"
```

---

### Task 4: Add DB indexes

**Files:**
- Modify: `auxserver/services/database.py`

- [ ] Add indexes in `_migrate_v1` (or a new `_migrate_v2`) after table creation:
```python
def _migrate_v2(conn):
    """Add indexes on frequently-queried columns."""
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_players_name
        ON players(name)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_npcs_map
        ON npcs(map_name)
    """)
    # Add any other hot columns identified in audit
```

- [ ] Update schema version check to run v2 migration.

- [ ] Verify: `sqlite3 auxserver/data/game.db ".indexes"`
  Should list the new indexes.

- [ ] Commit:
```bash
git add auxserver/services/database.py
git commit -m "perf: add DB indexes on player name and NPC map position"
```

---

### Task 5: Cache asset registry manifest

**Files:**
- Modify: `auxserver/services/asset_registry.py`

- [ ] Check current behavior:
```bash
grep -n "def load_all\|def scan\|os.walk\|glob\|listdir" auxserver/services/asset_registry.py
```

- [ ] Add a cached flag so `load_all()` is a no-op on subsequent calls:
```python
class AssetRegistry:
    def __init__(self):
        self._cache = {}
        self._loaded = False

    def load_all(self, assets_dir: str) -> None:
        if self._loaded:
            return  # already scanned at startup
        # existing scan logic...
        self._loaded = True

    def get_all(self) -> dict:
        return self._cache
```

- [ ] Add smoke test:
```python
def test_asset_registry_caches():
    from services.asset_registry import asset_registry
    # load_all should be a no-op if called twice
    assert hasattr(asset_registry, '_loaded')
```

- [ ] Run: `python -m pytest tests/test_smoke.py -v` — PASS.

- [ ] Commit:
```bash
git add auxserver/services/asset_registry.py auxserver/tests/test_smoke.py
git commit -m "perf: asset registry caches manifest, skips re-scan on subsequent calls"
```

---

### Task 6: Graceful error handling for missing/malformed assets

**Files:**
- Modify: `auxserver/services/asset_registry.py`

- [ ] Wrap the per-file parse in a try/except that logs and skips:
```python
import logging
logger = logging.getLogger(__name__)

# Inside the scan loop:
try:
    data = json.loads(path.read_text())
    self._cache[asset_id] = data
except (json.JSONDecodeError, OSError) as e:
    logger.warning("Asset registry: skipping malformed file %s: %s", path, e)
```

- [ ] Similarly, in equipment frame remap building, add warnings for missing sprite files:
```python
if not sprite_path.exists():
    logger.warning("Equipment frame remap: missing sprite file %s for %s", sprite_path, asset_id)
```

- [ ] Test: temporarily corrupt a test asset JSON file, start server — should log warning and continue, not crash.

- [ ] Restore the test file.

- [ ] Commit:
```bash
git add auxserver/services/asset_registry.py
git commit -m "fix: asset registry logs warnings for malformed files, does not crash"
```
