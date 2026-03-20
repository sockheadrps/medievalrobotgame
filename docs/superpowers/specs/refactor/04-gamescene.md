# Spec 04: GameScene.js Split

## Goal
Reduce `GameScene.js` from 2,840 lines to under 600 by extracting four missing controllers. `GameScene` becomes a wiring layer: `preload()`, `create()` (wires controllers), `update()` (delegates to controllers), and WebSocket message routing.

## Current State Audit

**Already extracted** from `GameScene.js` (these are done):
`NPCBrain.js`, `NPCTaskRunner.js`, `StateSyncController.js`, `WorldSyncController.js`, `CombatFxController.js`, `DialogueController.js`, `MineRenderer.js`, `TilemapBuilder.js`, `PlacementSystem.js`, `SelectionController.js`, `GridSystem.js`, `DriveSystem.js`, `TaskRecorder.js`

**Not yet extracted** (four gaps):
- Input handling (keyboard, pointer, right-click)
- Entity array management (trees, rocks, NPCs, ground items, buildings, etc.)
- Movement/physics (player prediction, collision setup, pickup detection, portal detection)
- Map loading/transition (loadMap, changeMap, bounds, tilemap building calls)

`GameScene.js` still mixes all four concerns with the WebSocket routing and Phaser lifecycle.

## Gaps to Fill

- [ ] Create `src/systems/InputController.js` — keyboard input (movement keys, hotkeys, modifiers), pointer/click (entity selection, tile clicking, mine clicking), right-click context actions. `GameScene` calls `this._input.update()` in `update()`.
- [ ] Create `src/systems/EntityManager.js` — entity arrays (trees, groundItems, npcs, dummies, animals, rocks, buildings, anvils, kiTargets, fences), creation/destruction helpers, lookup methods (nearest NPC, entity at position). `WorldSyncController` and `StateSyncController` interface with `EntityManager` instead of `GameScene` directly.
- [ ] Create `src/systems/MovementController.js` — player movement prediction (velocity application, client-side clamping), collision setup (player vs walls, player vs mine walls), pickup detection (overlap with ground items), portal detection (player position vs portal tiles).
- [ ] Create `src/systems/MapManager.js` — `_loadMap`, `_changeMap`, `_applyMapBounds` (camera + physics bounds), tilemap building (calls to `TilemapBuilder`), tile image array management (`_tileImages`), tree/rock spawn point tracking.
- [ ] Update `WorldSyncController` and `StateSyncController` to use `EntityManager` instead of accessing `GameScene` entity arrays directly
- [ ] `GameScene` retains only: `preload()`, `create()` (instantiating and wiring controllers), `update()` (delegating to each controller), WebSocket message routing

## Acceptance Criteria

- `GameScene.js` is under 600 lines
- `InputController.js`, `EntityManager.js`, `MovementController.js`, `MapManager.js` all exist in `src/systems/`
- Entity arrays live in `EntityManager`, not on the `GameScene` instance
- All existing input, movement, and map behaviors work correctly after extraction
- `WorldSyncController` and `StateSyncController` no longer directly reference `GameScene` entity arrays

## Risks & Notes

- **EntityManager is the critical dependency** for specs 05 and 06 — complete it before starting NPC or UI work.
- **Phaser scene context**: some systems need the Phaser scene reference for physics, camera, and object factories. Pass `scene` at construction time, not stored globally.
- **InputController and update loop**: Phaser's input is event-driven, but some keys require polling in `update()`. `InputController.update()` should handle both.
- **Order of operations in `create()`**: controllers may depend on each other at init time (e.g., `MovementController` needs the player object created by an earlier step). Document the init order.
- **`Connection.js`** (`src/net/Connection.js`): audit this file before starting the WebSocket routing cleanup. If it exposes methods that `GameScene` calls directly for message routing, note any interface changes required. If its interface is unchanged by this refactor, confirm explicitly so it can be excluded from the changeset.
