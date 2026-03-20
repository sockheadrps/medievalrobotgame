# Refactor Plan — Single-Player Focus

Structured instructions for refactoring the codebase. Each section is self-contained and can be implemented in order. Check off items as they are completed.

> **Scope:** Single-player only. Multiplayer sync (RemotePlayer, RemoteNPC, multi-client broadcasts) is deferred. AI rival player system is excluded (see AI_RIVAL_SYSTEM.md).

---

## Section 1: Server — Break Up game_state.py (4,239 lines)

`game_state.py` is a god object containing every game mechanic. Extract each system into its own service module under `auxserver/services/`.

### 1.1 Extract Combat System
- [ ] Create `auxserver/services/combat.py`
- [ ] Move PvP combat logic (melee attacks, damage calculation, knockouts, XP rewards, cooldowns)
- [ ] Move Ki blast handling (blast creation, collision detection, damage application)
- [ ] Move Ki barrier/absorption mechanics
- [ ] Keep a thin `handle_combat()` dispatcher in `game_state.py` that delegates to the new module
- [ ] Verify combat still works end-to-end after extraction

### 1.2 Extract Resource Gathering
- [ ] Create `auxserver/services/resources.py`
- [ ] Move tree harvesting logic (chop, drop logs, regrowth timers)
- [ ] Move rock mining logic (hit counter, resource drops, despawn)
- [ ] Move world object harvesting (copper ore, tin ore, etc.)
- [ ] Move ground item pickup logic
- [ ] Move ground item spawning/management

### 1.3 Extract Building System
- [ ] Create `auxserver/services/building.py`
- [ ] Move fence/gate construction (placement validation, HP tracking, destruction)
- [ ] Move anvil placement and crafting logic
- [ ] Move campfire/furnace placement
- [ ] Move conveyor belt creation and item transport tick
- [ ] Move minecart track placement and logic
- [ ] Move training dummy / ki target spawning

### 1.4 Extract NPC Management
- [ ] Create `auxserver/services/npc_manager.py`
- [ ] Move NPC spawning (position selection, personality assignment, stat initialization)
- [ ] Move NPC persistence (soul data save/load via database.py)
- [ ] Move NPC death/respawn handling
- [ ] Move NPC stat adjustment (admin commands for NPCs)
- [ ] Move NPC equipment management (equip from ground, equip from player inventory)

### 1.5 Extract Player Management
- [ ] Create `auxserver/services/player_manager.py`
- [ ] Move player initialization (default stats, spawn position)
- [ ] Move player stat adjustments (admin panel +/- buttons)
- [ ] Move inventory management (add/remove items, equipment equip/unequip)
- [ ] Move equipment crafting logic
- [ ] Move player death/respawn

### 1.6 Extract Portal & Map Transition System
- [ ] Create `auxserver/services/portals.py`
- [ ] Move portal detection logic (player steps on portal tile → map change)
- [ ] Move spawn point resolution per map
- [ ] Move map-specific initialization (cave mine grid creation, etc.)

### 1.7 Clean Up game_state.py
- [ ] `GameState` class should only contain: tick loop, player movement physics, message routing (`handle_input` dispatcher), and references to extracted services
- [ ] Remove dead code and unused imports
- [ ] Ensure all extracted services receive necessary state references (player dict, NPC list, etc.) via constructor injection or method parameters
- [ ] Target: `game_state.py` under 800 lines

---

## Section 2: Server — Shared Constants

Constants are duplicated between Python and JS (tile size, speeds, ranges, cooldowns). Create a single source of truth.

### 2.1 Create Shared Constants File
- [ ] Create `auxserver/data/constants.json` with all shared values (TILE_SIZE, MAP_COLS, MAP_ROWS, speeds, ranges, cooldowns, frame indices)
- [ ] Python: Create `auxserver/core/constants.py` that loads from the JSON
- [ ] JS: Create build-time import or fetch-on-load from `/api/constants` endpoint
- [ ] Replace hardcoded values in `game_state.py` with imported constants
- [ ] Replace hardcoded values in `src/constants.js` with imported constants
- [ ] Add API endpoint `GET /api/constants` that serves the JSON

---

## Section 3: Client — Break Up GameScene.js (2,840 lines)

`GameScene.js` is a god object mixing input, physics, entity management, and game logic. Extract into focused controllers.

### 3.1 Extract Input System
- [ ] Create `src/systems/InputController.js`
- [ ] Move keyboard input handling (movement keys, hotkeys, modifier keys)
- [ ] Move pointer/click handling (entity selection, tile clicking, mine clicking)
- [ ] Move right-click context actions
- [ ] GameScene delegates to `this._input.update()` in the update loop

### 3.2 Extract Entity Manager
- [ ] Create `src/systems/EntityManager.js`
- [ ] Move entity array management (trees, groundItems, npcs, dummies, animals, rocks, buildings, anvils, kiTargets, fences)
- [ ] Move entity creation/destruction helpers
- [ ] Move entity lookup methods (find nearest NPC, find entity at position)
- [ ] WorldSyncController and StateSyncController should interface with EntityManager instead of GameScene directly

### 3.3 Extract Physics / Movement Controller
- [ ] Create `src/systems/MovementController.js`
- [ ] Move player movement prediction (velocity application, client-side clamping)
- [ ] Move collision setup (player vs walls, player vs mine walls)
- [ ] Move pickup detection (overlap with ground items)
- [ ] Move portal detection (player position vs portal tiles)

### 3.4 Extract Map Manager
- [ ] Create `src/systems/MapManager.js`
- [ ] Move map loading (`_loadMap`, `_changeMap`)
- [ ] Move `_applyMapBounds` (camera + physics bounds per map)
- [ ] Move tilemap building (calls to TilemapBuilder)
- [ ] Move tile image array management (`_tileImages`)
- [ ] Move tree/rock spawn point tracking

### 3.5 Clean Up GameScene.js
- [ ] GameScene should only contain: `preload()`, `create()` (wiring controllers), `update()` (delegating to controllers), and WebSocket message routing
- [ ] All entity arrays live in EntityManager
- [ ] All input handling lives in InputController
- [ ] All movement/physics lives in MovementController
- [ ] Target: `GameScene.js` under 600 lines

---

## Section 4: Client — NPC System Consolidation

NPC AI logic is spread across 4 files (NPC.js, NPCBrain.js, NPCTaskRunner.js, ChatBox.js). Clarify responsibilities.

### 4.1 Clean Up NPC.js Entity
- [ ] NPC.js should be a pure entity class: sprite, stats, equipment overlays, animations
- [ ] Move personality/emotion/memory logic to a separate `src/systems/NPCPersonality.js` data class
- [ ] Move relationship tracking to the personality module
- [ ] NPC.js holds a reference to its personality data but doesn't contain the logic

### 4.2 Consolidate NPCBrain + NPCTaskRunner
- [ ] NPCBrain.js decides WHAT to do → produces a task
- [ ] NPCTaskRunner.js executes HOW to do it → runs the task
- [ ] Remove any decision-making logic from NPCTaskRunner (it should only execute)
- [ ] Remove any task execution logic from NPCBrain (it should only decide)
- [ ] Document the brain→runner pipeline clearly

### 4.3 Extract NPC Chat from ChatBox
- [ ] ChatBox.js currently handles NPC command routing, vocabulary learning, and dialogue generation
- [ ] Move NPC command routing to NPCBrain.js (it's a decision, not a UI concern)
- [ ] Move vocabulary learning to NPCPersonality.js
- [ ] ChatBox should only: display messages, capture input, forward commands to the brain

---

## Section 5: Client — UI Layer Cleanup

### 5.1 Standardize UI Component Pattern
- [ ] All UI panels should follow the same lifecycle: `constructor(scene)`, `show(data)`, `hide()`, `destroy()`
- [ ] Audit: ChatBox, HudController, NPCDetailPanel, PlayerDetailPanel, InspectPanel, InventoryController, AdminPanelController
- [ ] Ensure all panels properly clean up DOM elements in `destroy()`
- [ ] Ensure panels don't directly mutate game entities — they should emit events or call scene methods

### 5.2 Clean Up PlayerDetailPanel (Admin/Cheat Panel)
- [ ] Rename to `AdminPanel.js` or `CheatPanel.js` — it's not really a "player detail" panel
- [ ] Group Give Items by category (resources, crafting materials, equipment)
- [ ] Auto-generate Give Items rows from asset registry instead of hardcoding each item
- [ ] Auto-generate crafting buttons from equipment manifest (already partially done)

### 5.3 HUD Improvements
- [ ] HudController should read from a player state object, not directly from the Player entity
- [ ] This decouples HUD from Phaser entity lifecycle

---

## Section 6: Server — Clean Up main.py

### 6.1 Extract Route Handlers
- [ ] Move AI player dashboard HTML to a template file in `auxserver/templates/`
- [ ] Move Ollama proxy endpoints to a separate router `auxserver/api/ollama.py`
- [ ] Move legacy LLM proxy to the ollama router
- [ ] `main.py` should only: create FastAPI app, register routers, handle startup/shutdown

### 6.2 Simplify Startup
- [ ] Database init, asset registry scan, and state loading should be in a single `startup()` function
- [ ] Shutdown save should be in a single `shutdown()` function
- [ ] Remove any inline HTML from main.py

---

## Section 7: Tooling (Asset Editor, Map Maker, Playground)

The web tools at `http://127.0.0.1:8001/` are large single-file JS apps. Light cleanup only — they work and are rarely modified.

### 7.1 Asset Editor
- [ ] `asseteditor.js` — split tab logic into separate functions/modules if it exceeds 2000 lines
- [ ] Ensure all asset types (world objects, equipment, items, crafting stations) use consistent save/load patterns
- [ ] Add validation feedback when saving (currently silent)

### 7.2 Map Maker
- [ ] `mapmaker.js` — no structural changes needed, but add undo/redo if missing
- [ ] Ensure collision tile editing works correctly with the cave_01 mine overlay system

### 7.3 Playground
- [ ] `playground.js` — no changes needed, it's a testing tool

---

## Section 8: LLM Integration Cleanup

### 8.1 Consolidate Prompt Management
- [ ] All prompts should live in `auxserver/prompts/` as `.txt` templates
- [ ] Client-side prompts (currently hardcoded in LLMClient.js) should be moved to template files served from the server
- [ ] Add a `GET /api/prompts/{name}` endpoint that returns rendered prompt templates
- [ ] LLMClient.js should fetch prompt templates from server, not contain them inline

### 8.2 Clean Up LLMClient.js
- [ ] LLMClient.js (796 lines) mixes prompt building, personality data, vocabulary management, and HTTP calls
- [ ] Extract personality type metadata to a shared data file (it's duplicated between NPC.js and LLMClient.js)
- [ ] Extract vocabulary/phrase learning to NPCPersonality.js (from Section 4)
- [ ] LLMClient.js should only: make HTTP calls to Ollama, return raw responses

### 8.3 Server-Side LLM Gateway
- [ ] `llm_gateway.py` is only 25 lines — expand with retry logic and timeout handling
- [ ] Add request logging for debugging LLM call patterns
- [ ] Standardize error responses when LLM is unreachable

---

## Section 9: Data & Persistence

### 9.1 Database Schema Review
- [ ] Audit `database.py` tables — remove any unused tables
- [ ] Ensure all entity types saved to DB have matching load functions
- [ ] Add indexes on frequently-queried columns (player name, NPC map position)

### 9.2 Asset Loading
- [ ] `asset_registry.py` scans `assets/` at startup — verify it handles missing/malformed files gracefully
- [ ] Add a manifest cache so the registry doesn't re-scan on every request
- [ ] Equipment frame remap building should log warnings for missing sprite files

---

## Section 10: Dead Code & Cleanup

### 10.1 Remove Unused Files
- [ ] Audit for files that are imported nowhere (check with grep)
- [ ] Remove any commented-out code blocks longer than 5 lines
- [ ] Remove implementation docs (impl1.md, impl2.md, impl3.md) if they're outdated

### 10.2 Remove Multiplayer-Only Code (Defer, Don't Delete)
- [ ] Flag (don't remove) RemotePlayer.js, RemoteNPC.js as multiplayer-only
- [ ] Flag multi-client broadcast logic in ws.py
- [ ] Add `// MULTIPLAYER` comments to code that only matters for multi-client scenarios
- [ ] Ensure single-player path works without any multiplayer systems running

### 10.3 Console Logging
- [ ] Audit `console.log` / `console.warn` calls in client code
- [ ] Remove noisy debug logs, keep error/warning logs
- [ ] Server-side: audit `print()` statements, convert to proper logging module

---

## Execution Order Recommendation

For minimal breakage, implement in this order:

1. **Section 2** (shared constants) — foundational, low risk
2. **Section 1** (server game_state split) — biggest win, enables all other server work
3. **Section 6** (main.py cleanup) — small, quick win
4. **Section 3** (client GameScene split) — biggest client win
5. **Section 4** (NPC consolidation) — depends on Section 3 entity manager
6. **Section 5** (UI cleanup) — depends on Section 3
7. **Section 8** (LLM cleanup) — depends on Sections 4 and 6
8. **Section 9** (data/persistence) — independent, can be done anytime
9. **Section 7** (tooling) — low priority, tools work fine
10. **Section 10** (dead code) — do last, after everything else is stable
