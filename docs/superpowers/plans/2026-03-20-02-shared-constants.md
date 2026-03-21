# Shared Constants — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a single JSON source of truth for all shared constants and serve them to both Python and JavaScript, eliminating duplication.

**Architecture:** `auxserver/data/constants.json` is the canonical store. Python loads it via `auxserver/core/constants.py` at import time. A `GET /api/constants` endpoint serves it to the client. `src/constants.js` fetches from the API before Phaser initializes.

**Tech Stack:** Python (json stdlib), FastAPI, vanilla JS fetch. No new dependencies.

**Spec:** `docs/superpowers/specs/refactor/02-constants.md`

**Prerequisite:** Plan 01 (game_state split) should be complete or in progress so the new service modules exist as migration targets.

---

## File Map

**Create:**
- `auxserver/data/constants.json` — canonical values
- `auxserver/core/constants.py` — Python loader

**Modify:**
- `auxserver/main.py` — add `GET /api/constants` endpoint
- `auxserver/services/game_state.py` — replace hardcoded values with imports
- `auxserver/services/combat.py`, `resources.py`, `building.py`, `npc_manager.py`, `player_manager.py`, `portals.py` — replace hardcoded values
- `src/constants.js` — replace hardcoded values with API fetch
- `auxserver/tests/test_smoke.py` — add constants tests

---

### Task 1: Inventory current hardcoded constants

- [ ] Find all hardcoded values in Python:
```bash
grep -n "TILE_SIZE\|MAP_COLS\|MAP_ROWS\|TILE_WIDTH\|TILE_HEIGHT" auxserver/services/game_state.py
grep -rn "= 32\|= 64\|= 48\|= 16\|= 24" auxserver/services/game_state.py | head -30
```

- [ ] Find all hardcoded values in JS:
```bash
grep -n "TILE_SIZE\|MAP_COLS\|MAP_ROWS\|tileSize\|tileWidth" src/constants.js
```

- [ ] Write down all constants that appear in both Python and JS. This is your migration list.

---

### Task 2: Create constants.json

**Files:**
- Create: `auxserver/data/constants.json`

- [ ] Create `auxserver/data/constants.json` with all shared values found in Task 1. Minimum expected shape:

```json
{
  "TILE_SIZE": 32,
  "MAP_COLS": 80,
  "MAP_ROWS": 60,
  "PLAYER_SPEED": 160,
  "NPC_SPEED": 80,
  "MELEE_RANGE": 48,
  "KI_BLAST_SPEED": 400,
  "PICKUP_RANGE": 32,
  "PORTAL_DETECTION_RANGE": 16
}
```
Fill in the actual values from the grep output in Task 1. Add any additional shared values found.

- [ ] Commit:
```bash
git add auxserver/data/constants.json
git commit -m "feat: create constants.json as single source of truth"
```

---

### Task 3: Python constants loader

**Files:**
- Create: `auxserver/core/constants.py`
- Modify: `auxserver/tests/test_smoke.py`

- [ ] Add failing smoke test:
```python
def test_constants_loads():
    from core.constants import TILE_SIZE
    assert isinstance(TILE_SIZE, (int, float))
    assert TILE_SIZE > 0
```

- [ ] Run test — expect FAIL.

- [ ] Create `auxserver/core/constants.py`:
```python
"""Load shared constants from constants.json. No fallback hardcoded values."""
import json
from pathlib import Path

_path = Path(__file__).resolve().parent.parent / "data" / "constants.json"
_data = json.loads(_path.read_text())

# Expose all keys as module-level names
TILE_SIZE = _data["TILE_SIZE"]
MAP_COLS = _data["MAP_COLS"]
MAP_ROWS = _data["MAP_ROWS"]
PLAYER_SPEED = _data["PLAYER_SPEED"]
NPC_SPEED = _data["NPC_SPEED"]
MELEE_RANGE = _data["MELEE_RANGE"]
KI_BLAST_SPEED = _data["KI_BLAST_SPEED"]
PICKUP_RANGE = _data["PICKUP_RANGE"]
PORTAL_DETECTION_RANGE = _data["PORTAL_DETECTION_RANGE"]
# Add remaining constants from constants.json
```

- [ ] Run test — expect PASS.

- [ ] Commit:
```bash
git add auxserver/core/constants.py auxserver/tests/test_smoke.py
git commit -m "feat: Python constants loader from constants.json"
```

---

### Task 4: Add GET /api/constants endpoint

**Files:**
- Modify: `auxserver/main.py`

- [ ] Add the endpoint to `main.py`:
```python
from pathlib import Path
import json

@app.get("/api/constants")
async def get_constants():
    path = Path(__file__).resolve().parent / "data" / "constants.json"
    return json.loads(path.read_text())
```

- [ ] Start server and test: `curl http://127.0.0.1:8001/api/constants`
  Expected: JSON object with all constants.

- [ ] Commit:
```bash
git add auxserver/main.py
git commit -m "feat: add GET /api/constants endpoint"
```

---

### Task 5: Replace Python hardcoded values

**Files:**
- Modify: `auxserver/services/game_state.py` and all new service files from plan 01

- [ ] In each server file, replace hardcoded constant values with imports:
```python
from core.constants import TILE_SIZE, MAP_COLS, MAP_ROWS, MELEE_RANGE, ...
```

- [ ] Grep by constant name (not raw number — too many false positives):
```bash
grep -rn "TILE_SIZE\|MAP_COLS\|MAP_ROWS\|PLAYER_SPEED\|MELEE_RANGE\|KI_BLAST_SPEED" auxserver/services/ | grep -v "import\|from core"
```
  Any hit that isn't an import line is a hardcoded value — replace it.

- [ ] Run smoke tests: `python -m pytest tests/test_smoke.py -v` — all PASS.

- [ ] Commit:
```bash
git add auxserver/services/
git commit -m "refactor: replace hardcoded constants with core.constants imports in server"
```

---

### Task 6: Keep JS constants in sync with constants.json

**Important:** `src/constants.js` uses static named exports (`export const TILE_SIZE = 48`) and is imported statically by many client files. Do NOT replace it with an async fetch — that would require changing every import site and break Phaser boot order. Instead:

- The server-side `constants.json` is the canonical documentation and source for Python.
- `src/constants.js` stays as static named exports — it IS the client source of truth.
- The `GET /api/constants` endpoint serves the values for tooling and non-JS consumers.
- Shared values must be kept in sync manually (or via the validation script below).

**Files:**
- Modify: `src/constants.js` — update values to match `constants.json` where they differ

- [ ] Compare values:
```bash
# Print Python constants
python3 -c "import json; d=json.load(open('auxserver/data/constants.json')); [print(k,v) for k,v in d.items()]"
# Print JS constants
grep "^export const" src/constants.js
```

- [ ] Update any values in `src/constants.js` that differ from `constants.json`.

- [ ] Add a comment block at the top of `src/constants.js`:
```javascript
// Shared constants — must match auxserver/data/constants.json.
// To verify sync: compare with GET /api/constants.
// Do NOT replace with an async fetch — static imports are required at Phaser init time.
```

- [ ] Manual check: game boots, tiles render correctly.

- [ ] Commit:
```bash
git add src/constants.js
git commit -m "docs: add sync comment to constants.js, align values with constants.json"
```

---

### Task 7: Verification

- [ ] Start the full stack and play-test:
  - Server: `uvicorn main:app --reload`
  - Client: open browser
  - Verify: tiles render, player moves, NPC moves, combat ranges feel correct.

- [ ] Verify API endpoint still works:
```bash
curl http://127.0.0.1:8001/api/constants
```

- [ ] Commit any remaining cleanup:
```bash
git add -p
git commit -m "refactor: shared constants cleanup complete"
```
