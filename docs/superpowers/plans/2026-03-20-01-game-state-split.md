# game_state.py Split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract six remaining systems from `game_state.py` into focused service modules, reducing it from 4,239 lines to under 800.

**Architecture:** Each system becomes a Python module in `auxserver/services/`. `GameState` receives service instances at init time and calls them via thin dispatcher methods. Services receive shared state (player dict, NPC list) via constructor injection or per-call parameters — no module-level globals.

**Tech Stack:** Python, FastAPI, SQLite (via `database.py`). No new dependencies.

**Spec:** `docs/superpowers/specs/refactor/01-game-state.md`

---

## File Map

**Create:**
- `auxserver/services/combat.py` — PvP melee, Ki blasts, Ki barriers
- `auxserver/services/resources.py` — tree/rock/ore harvesting, ground items
- `auxserver/services/building.py` — fences, anvils, campfires, conveyors, carts, dummies
- `auxserver/services/npc_manager.py` — NPC spawning, persistence, death, equipment
- `auxserver/services/player_manager.py` — player init, stats, inventory, crafting, death
- `auxserver/services/portals.py` — portal detection, spawn point resolution, map init
- `auxserver/tests/test_smoke.py` — import smoke tests (new)

**Modify:**
- `auxserver/services/game_state.py` — remove extracted logic, add service references, keep tick loop + movement + input dispatcher

---

### Task 1: Baseline smoke test

Establish that `game_state.py` currently imports cleanly. This test will catch import errors introduced during extraction.

**Files:**
- Create: `auxserver/tests/__init__.py`
- Create: `auxserver/tests/test_smoke.py`

- [ ] Create `auxserver/tests/__init__.py` (empty file)

- [ ] Create `auxserver/tests/test_smoke.py`:

```python
"""Smoke tests: verify service modules import and instantiate without error."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


def test_game_state_imports():
    from services.game_state import GameState
    assert GameState is not None


def test_database_imports():
    from services.database import init_db
    assert init_db is not None
```

- [ ] Run: `cd auxserver && python -m pytest tests/test_smoke.py -v`
  Expected: PASS (both tests green)

- [ ] Commit:
```bash
git add auxserver/tests/
git commit -m "test: add import smoke tests before game_state extraction"
```

---

### Task 2: Extract combat.py

**Files:**
- Create: `auxserver/services/combat.py`
- Modify: `auxserver/services/game_state.py`
- Modify: `auxserver/tests/test_smoke.py`

- [ ] In `game_state.py`, grep for combat-related handlers:
```bash
grep -n "def.*combat\|def.*attack\|def.*ki_blast\|def.*ki_barrier\|def.*knockout\|def.*melee\|def.*damage" auxserver/services/game_state.py
```
Note the line numbers.

- [ ] Add smoke test (will fail until combat.py exists):
```python
def test_combat_imports():
    from services.combat import CombatService
    assert CombatService is not None
```

- [ ] Run: `python -m pytest tests/test_smoke.py::test_combat_imports -v`
  Expected: FAIL with `ModuleNotFoundError`

- [ ] Create `auxserver/services/combat.py`:
```python
"""Combat system: PvP melee, Ki blasts, Ki barriers."""


class CombatService:
    def __init__(self, game_state):
        self.gs = game_state

    # Move methods here from game_state.py:
    # - melee attack handling
    # - damage calculation
    # - knockout / XP reward logic
    # - cooldown tracking
    # - Ki blast creation, collision detection, damage application
    # - Ki barrier / absorption mechanics
```
Move the identified combat methods from `game_state.py` into `CombatService`. Keep a thin dispatcher in `game_state.py`:
```python
def handle_combat(self, player, action, data):
    return self.combat.handle_combat(player, action, data)
```

- [ ] Add to `GameState.__init__`:
```python
from services.combat import CombatService
self.combat = CombatService(self)
```

- [ ] Run: `python -m pytest tests/test_smoke.py -v`
  Expected: all PASS

- [ ] Start server and verify combat works: `cd auxserver && uvicorn main:app --reload`
  Manual check: attack an NPC, Ki blast fires, Ki barrier absorbs.

- [ ] Commit:
```bash
git add auxserver/services/combat.py auxserver/services/game_state.py auxserver/tests/test_smoke.py
git commit -m "refactor: extract CombatService from game_state.py"
```

---

### Task 3: Extract resources.py

**Files:**
- Create: `auxserver/services/resources.py`
- Modify: `auxserver/services/game_state.py`
- Modify: `auxserver/tests/test_smoke.py`

- [ ] Grep for resource methods:
```bash
grep -n "def.*chop\|def.*harvest\|def.*mine\|def.*pickup\|def.*ground_item\|def.*rock\|def.*tree\|def.*ore" auxserver/services/game_state.py
```

- [ ] Add failing smoke test:
```python
def test_resources_imports():
    from services.resources import ResourceService
    assert ResourceService is not None
```

- [ ] Run test — expect FAIL.

- [ ] Create `auxserver/services/resources.py`:
```python
"""Resource gathering: trees, rocks, ores, ground items."""


class ResourceService:
    def __init__(self, game_state):
        self.gs = game_state

    # Move from game_state.py:
    # - tree harvesting (chop, log drops, regrowth timers)
    # - rock mining (hit counter, resource drops, despawn)
    # - world object harvesting (copper ore, tin ore, etc.)
    # - ground item pickup logic
    # - ground item spawn / management
```

- [ ] Wire in `GameState.__init__`:
```python
from services.resources import ResourceService
self.resources = ResourceService(self)
```

- [ ] Run all smoke tests — expect PASS.

- [ ] Manual check: chop a tree, mine a rock, pick up a ground item.

- [ ] Commit:
```bash
git add auxserver/services/resources.py auxserver/services/game_state.py auxserver/tests/test_smoke.py
git commit -m "refactor: extract ResourceService from game_state.py"
```

---

### Task 4: Extract building.py

**Files:**
- Create: `auxserver/services/building.py`
- Modify: `auxserver/services/game_state.py`
- Modify: `auxserver/tests/test_smoke.py`

- [ ] Grep for building methods:
```bash
grep -n "def.*fence\|def.*gate\|def.*anvil\|def.*campfire\|def.*furnace\|def.*conveyor\|def.*minecart\|def.*dummy\|def.*ki_target" auxserver/services/game_state.py
```

- [ ] Add failing smoke test:
```python
def test_building_imports():
    from services.building import BuildingService
    assert BuildingService is not None
```

- [ ] Run test — expect FAIL.

- [ ] Create `auxserver/services/building.py`:
```python
"""Building system: fences, anvils, campfires, conveyors, carts, dummies."""


class BuildingService:
    def __init__(self, game_state):
        self.gs = game_state

    # Move from game_state.py:
    # - fence/gate placement, HP tracking, destruction
    # - anvil placement and crafting
    # - campfire/furnace placement
    # - conveyor belt creation and item transport tick
    # - minecart track placement and logic
    # - training dummy / ki target spawning
```

- [ ] Wire in `GameState.__init__`, add thin dispatcher.

- [ ] Run smoke tests — PASS.

- [ ] Manual check: place a fence, craft at anvil, place a campfire.

- [ ] If `building.py` exceeds 600 lines, **stop and create a sub-split plan** before committing.

- [ ] Commit:
```bash
git add auxserver/services/building.py auxserver/services/game_state.py auxserver/tests/test_smoke.py
git commit -m "refactor: extract BuildingService from game_state.py"
```

---

### Task 5: Extract npc_manager.py

**Files:**
- Create: `auxserver/services/npc_manager.py`
- Modify: `auxserver/services/game_state.py`
- Modify: `auxserver/tests/test_smoke.py`

- [ ] Grep for NPC management methods:
```bash
grep -n "def.*spawn_npc\|def.*npc_death\|def.*npc_respawn\|def.*npc_equip\|def.*npc_stat\|def.*npc_persist\|def.*save_npc\|def.*load_npc" auxserver/services/game_state.py
```

- [ ] Add failing smoke test:
```python
def test_npc_manager_imports():
    from services.npc_manager import NPCManager
    assert NPCManager is not None
```

- [ ] Run test — expect FAIL.

- [ ] Create `auxserver/services/npc_manager.py`:
```python
"""NPC management: spawning, persistence, death/respawn, equipment."""


class NPCManager:
    def __init__(self, game_state):
        self.gs = game_state

    # Move from game_state.py:
    # - NPC spawning (position selection, personality assignment, stat init)
    # - NPC persistence (soul data save/load via database.py)
    # - NPC death/respawn handling
    # - NPC stat adjustment (admin commands)
    # - NPC equipment management (equip from ground, equip from player inventory)
```
Note: `soul_service.py` already handles soul data — import from it rather than duplicating.

- [ ] Wire in `GameState.__init__`, add thin dispatcher.

- [ ] Run smoke tests — PASS.

- [ ] Manual check: NPCs spawn on world load, NPC dies and respawns, NPC equips an item.

- [ ] Commit:
```bash
git add auxserver/services/npc_manager.py auxserver/services/game_state.py auxserver/tests/test_smoke.py
git commit -m "refactor: extract NPCManager from game_state.py"
```

---

### Task 6: Extract player_manager.py

**Files:**
- Create: `auxserver/services/player_manager.py`
- Modify: `auxserver/services/game_state.py`
- Modify: `auxserver/tests/test_smoke.py`

- [ ] Grep for player management methods:
```bash
grep -n "def.*player_init\|def.*player_stat\|def.*inventory\|def.*equip\|def.*craft\|def.*player_death\|def.*player_respawn\|def.*spawn_player" auxserver/services/game_state.py
```

- [ ] Add failing smoke test:
```python
def test_player_manager_imports():
    from services.player_manager import PlayerManager
    assert PlayerManager is not None
```

- [ ] Run test — expect FAIL.

- [ ] Create `auxserver/services/player_manager.py`:
```python
"""Player management: init, stats, inventory, crafting, death/respawn."""


class PlayerManager:
    def __init__(self, game_state):
        self.gs = game_state

    # Move from game_state.py:
    # - player initialization (default stats, spawn position)
    # - player stat adjustments (admin panel +/- buttons)
    # - inventory management (add/remove items, equip/unequip)
    # - equipment crafting logic
    # - player death/respawn
```

- [ ] Wire in `GameState.__init__`, add thin dispatcher.

- [ ] Run smoke tests — PASS.

- [ ] Manual check: log in as player, adjust a stat from admin panel, craft an item, die and respawn.

- [ ] Commit:
```bash
git add auxserver/services/player_manager.py auxserver/services/game_state.py auxserver/tests/test_smoke.py
git commit -m "refactor: extract PlayerManager from game_state.py"
```

---

### Task 7: Extract portals.py

**Files:**
- Create: `auxserver/services/portals.py`
- Modify: `auxserver/services/game_state.py`
- Modify: `auxserver/tests/test_smoke.py`

- [ ] Grep for portal/map transition methods:
```bash
grep -n "def.*portal\|def.*map_change\|def.*spawn_point\|def.*transition\|def.*cave_mine\|def.*mine_grid" auxserver/services/game_state.py
```

- [ ] Add failing smoke test:
```python
def test_portals_imports():
    from services.portals import PortalService
    assert PortalService is not None
```

- [ ] Run test — expect FAIL.

- [ ] Create `auxserver/services/portals.py`:
```python
"""Portal & map transition: detection, spawn resolution, map init."""


class PortalService:
    def __init__(self, game_state):
        self.gs = game_state

    # Move from game_state.py:
    # - portal detection (player steps on portal tile → map change)
    # - spawn point resolution per map
    # - map-specific initialization (cave mine grid creation, etc.)
```

- [ ] Wire in `GameState.__init__`, add thin dispatcher.

- [ ] Run smoke tests — PASS.

- [ ] Manual check: walk into a portal, arrive in the cave mine, walk back out.

- [ ] Commit:
```bash
git add auxserver/services/portals.py auxserver/services/game_state.py auxserver/tests/test_smoke.py
git commit -m "refactor: extract PortalService from game_state.py"
```

---

### Task 8: Clean up game_state.py

**Files:**
- Modify: `auxserver/services/game_state.py`

- [ ] Check current line count: `wc -l auxserver/services/game_state.py`

- [ ] Remove dead code: any methods that are now fully delegated to services and no longer have a body. Remove unused imports.

- [ ] Verify `GameState` contains only:
  - `__init__` (wiring services)
  - tick loop
  - player movement physics
  - `handle_input` dispatcher
  - service references

- [ ] Check line count again — must be under 800:
```bash
wc -l auxserver/services/game_state.py
```
  If over 800: grep for remaining large method blocks and either move them to the appropriate service or flag them for a follow-up.

- [ ] Run all smoke tests: `python -m pytest tests/test_smoke.py -v`
  Expected: all PASS

- [ ] Start server end-to-end: `uvicorn main:app --reload`
  Manual check: server starts, player logs in, can move, combat works, resources harvestable, NPCs alive, portals work.

- [ ] Commit:
```bash
git add auxserver/services/game_state.py
git commit -m "refactor: clean up game_state.py — under 800 lines"
```

---

### Task 9: Add service smoke tests to CI check

- [ ] Add a full import test for all six new services:
```python
def test_all_services_import():
    from services.combat import CombatService
    from services.resources import ResourceService
    from services.building import BuildingService
    from services.npc_manager import NPCManager
    from services.player_manager import PlayerManager
    from services.portals import PortalService
    # all imported without error
    assert True
```

- [ ] Run: `python -m pytest tests/test_smoke.py -v` — all PASS.

- [ ] Final line count check:
```bash
wc -l auxserver/services/game_state.py auxserver/services/combat.py auxserver/services/resources.py auxserver/services/building.py auxserver/services/npc_manager.py auxserver/services/player_manager.py auxserver/services/portals.py
```
  `game_state.py` < 800. Each service < 600 (if any is over, document a sub-split plan before merging).

- [ ] Commit:
```bash
git add auxserver/tests/test_smoke.py
git commit -m "test: full service import coverage after game_state.py split"
```
