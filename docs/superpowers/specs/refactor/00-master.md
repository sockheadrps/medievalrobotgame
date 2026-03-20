# Refactor Master Overview

Single-player focus. Multiplayer sync (RemotePlayer, RemoteNPC, multi-client broadcasts) and AI rival system are deferred. See REFACTOR_PLAN.md for full checklist.

---

## Current State Audit

### Server — `auxserver/services/`

| File | Status |
|------|--------|
| `soul_service.py` | ✅ Extracted |
| `animal_service.py` | ✅ Extracted |
| `command_service.py` | ✅ Extracted |
| `crop_service.py` | ✅ Extracted |
| `mine_state.py` | ✅ Extracted |
| `personality_types.py` | ✅ Extracted |
| `prompt_loader.py` | ✅ Extracted |
| `template_renderer.py` | ✅ Extracted |
| `decision_service.py` | ✅ Extracted |
| `ai_player.py` | ✅ Extracted |
| `accounts.py` | ✅ Extracted |
| `map_service.py` | ✅ Extracted |
| `asset_registry.py` | ✅ Extracted |
| `asset_service.py` | ✅ Extracted |
| `database.py` | ✅ Extracted |
| `llm_gateway.py` | ✅ Extracted |
| `combat.py` | ❌ Not yet extracted |
| `resources.py` | ❌ Not yet extracted |
| `building.py` | ❌ Not yet extracted |
| `npc_manager.py` | ❌ Not yet extracted |
| `player_manager.py` | ❌ Not yet extracted |
| `portals.py` | ❌ Not yet extracted |

`game_state.py` is 4,239 lines. Target: under 800 lines after all extractions.

### Client — `src/systems/`

| File | Status |
|------|--------|
| `NPCBrain.js` | ✅ Extracted |
| `NPCTaskRunner.js` | ✅ Extracted |
| `StateSyncController.js` | ✅ Extracted |
| `WorldSyncController.js` | ✅ Extracted |
| `CombatFxController.js` | ✅ Extracted |
| `DialogueController.js` | ✅ Extracted |
| `MineRenderer.js` | ✅ Extracted |
| `TilemapBuilder.js` | ✅ Extracted |
| `PlacementSystem.js` | ✅ Extracted |
| `SelectionController.js` | ✅ Extracted |
| `GridSystem.js` | ✅ Extracted |
| `DriveSystem.js` | ✅ Extracted |
| `TaskRecorder.js` | ✅ Extracted |
| `InputController.js` | ❌ Not yet extracted |
| `EntityManager.js` | ❌ Not yet extracted |
| `MovementController.js` | ❌ Not yet extracted |
| `MapManager.js` | ❌ Not yet extracted |

`GameScene.js` is 2,840 lines. Target: under 600 lines after all extractions.

---

## Execution Order

| # | Spec File | Rationale |
|---|-----------|-----------|
| 1 | `01-game-state.md` | Highest leverage. Audit already-extracted services, fill remaining six gaps. Unblocks all other server work. |
| 2 | `02-constants.md` | Best done while game_state.py is still being touched. Prevents constant duplication spreading into new modules. |
| 3 | `03-main-py.md` | Small, low-risk, quick win. Cleans up the entry point before client work begins. |
| 4 | `04-gamescene.md` | Highest client leverage. EntityManager is a prerequisite for specs 05 and 06. |
| 5 | `05-npc-system.md` | Depends on EntityManager from spec 04. Clarifies Brain/Runner/Personality boundaries. |
| 6 | `06-ui-layer.md` | Depends on EntityManager from spec 04. Standardizes panel lifecycle. |
| 7 | `07-llm.md` | Depends on specs 05 (NPCPersonality.js) and 03 (server routing). |
| 8 | `08-persistence.md` | Independent. Can be done any time after spec 01. |
| 9 | `09-tooling.md` | Low priority. Tools work. Light cleanup only. |
| 10 | `10-dead-code.md` | Do last. Only remove code after everything else is stable. |

---

## Dependency Map

```
01-game-state ──► 02-constants
                │
                └──► 03-main-py ──► 07-llm
                                        ▲
04-gamescene ──► 05-npc-system ─────────┘
             │
             └──► 06-ui-layer

08-persistence  (independent)
09-tooling      (independent)
10-dead-code    (last — depends on all others)
```

---

## Progress Tracker

- [ ] `01-game-state.md` — game_state.py split
- [ ] `02-constants.md` — shared constants
- [ ] `03-main-py.md` — main.py cleanup
- [ ] `04-gamescene.md` — GameScene.js split
- [ ] `05-npc-system.md` — NPC system consolidation
- [ ] `06-ui-layer.md` — UI layer cleanup
- [ ] `07-llm.md` — LLM integration cleanup
- [ ] `08-persistence.md` — data & persistence
- [ ] `09-tooling.md` — tooling
- [ ] `10-dead-code.md` — dead code & cleanup
