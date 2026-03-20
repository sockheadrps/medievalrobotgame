# Spec 01: game_state.py Split

## Goal
Reduce `game_state.py` from 4,239 lines to under 800 by extracting six remaining systems into focused service modules, following the pattern already established by the existing extracted services.

## Current State Audit

**Already extracted** (these are done — do not re-extract):
`soul_service.py`, `animal_service.py`, `command_service.py`, `crop_service.py`, `mine_state.py`, `decision_service.py`, `accounts.py`, `map_service.py`, `asset_registry.py`, `asset_service.py`, `database.py`, `llm_gateway.py`, `personality_types.py`, `prompt_loader.py`, `template_renderer.py`

**Not yet extracted** (the six gaps):
- Combat system (PvP melee, Ki blasts, Ki barriers)
- Resource gathering (trees, rocks, ore, ground items)
- Building system (fences, anvils, campfires, conveyors, mine carts, dummies)
- NPC management (spawning, persistence, death/respawn, equipment)
- Player management (initialization, stats, inventory, crafting, death/respawn)
- Portal & map transition

`game_state.py` currently handles all of the above inline alongside the tick loop and message router.

## Gaps to Fill

- [ ] Create `auxserver/services/combat.py` — PvP melee attacks, damage calc, knockouts, XP, cooldowns, Ki blast creation/collision/damage, Ki barrier/absorption
- [ ] Create `auxserver/services/resources.py` — tree harvesting, rock mining, ore harvesting, ground item pickup, ground item spawn/management
- [ ] Create `auxserver/services/building.py` — fence/gate placement/HP/destruction, anvil placement/crafting, campfire/furnace placement, conveyor belt creation/tick, minecart track, training dummy/ki target spawning
- [ ] Create `auxserver/services/npc_manager.py` — NPC spawning (position, personality, stats), persistence (soul data via database.py), death/respawn, stat adjustments, equipment management
- [ ] Create `auxserver/services/player_manager.py` — player init (default stats, spawn pos), stat adjustments, inventory management, equipment crafting, death/respawn
- [ ] Create `auxserver/services/portals.py` — portal detection, spawn point resolution per map, map-specific init (cave mine grid, etc.)
- [ ] Keep a thin dispatcher in `game_state.py` for each extracted system
- [ ] `GameState` should only contain: tick loop, player movement physics, `handle_input` dispatcher, and references to services
- [ ] Remove dead code and unused imports from `game_state.py`
- [ ] Services receive state references (player dict, NPC list, etc.) via constructor injection or method parameters

## Acceptance Criteria

- `game_state.py` is under 800 lines
- All six new service files exist in `auxserver/services/`
- Each new service file is under 600 lines (if larger, it needs its own sub-split)
- No logic is duplicated between `game_state.py` and new modules
- Combat, resource gathering, building, NPC management, player management, and portal transitions all work correctly after extraction (manual smoke test)

## Risks & Notes

- **Import cycles**: services may need to import from each other (e.g., combat imports player_manager for death handling). Use method parameters instead of cross-service imports where possible.
- **State references**: most services need access to the shared player dict and NPC list. Pass these at construction time or per-call. Do not store mutable shared state as module-level globals.
- **Existing services**: audit whether `command_service.py`, `decision_service.py`, etc. already handle any of the six gaps partially — don't duplicate their work.
