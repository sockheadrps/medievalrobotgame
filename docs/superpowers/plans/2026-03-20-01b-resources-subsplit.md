# Plan 01b: Resources Sub-split

`auxserver/services/resources.py` was created as part of Plan 01 Task 3 with 623 lines, exceeding the 600-line gate. This document specifies a follow-up sub-split into focused modules.

## Current ResourceService sections (by line range)

| Section | Lines | Methods |
|---------|-------|---------|
| Tree chopping | ~35 | `_npc_chop`, `_try_chop`, `_try_plant_seed`, `_try_harvest_crop` |
| Rock spawning & mining | ~45 | `_spawn_rocks`, `_try_mine_rock` |
| World Objects | ~70 | `_try_interact_world_object`, `_npc_interact_world_object` |
| Cave Mining | ~110 | `_get_or_create_mine`, `_try_mine_tile`, `get_mine_tiles_for_player` |
| NPC deposits | ~40 | `_npc_deposit_to_crate` |
| Anvil / Refining | ~55 | `_try_refine_rock`, `_npc_refine_rock` |
| NPC stone pickup | ~80 | `_npc_pickup_stone`, `_npc_mine_rock`, `_npc_pickup_stone_tile`, `_npc_give_materials` |
| Drop/Pickup helpers | ~130 | `_tile_key`, `_find_ground_item`, `_is_log_item`, `_is_stone_item`, `_try_drop_item`, `_try_pickup_placed` |

## Proposed sub-modules

### `auxserver/services/gathering.py`
- Tree chopping: `_npc_chop`, `_try_chop`
- Farming: `_try_plant_seed`, `_try_harvest_crop`
- Rock spawning: `_spawn_rocks`, `_try_mine_rock`
- World objects: `_try_interact_world_object`, `_npc_interact_world_object`

### `auxserver/services/cave_mining.py`
- Cave mining: `_get_or_create_mine`, `_try_mine_tile`, `get_mine_tiles_for_player`
- Refining: `_try_refine_rock`, `_npc_refine_rock`
- NPC stone: `_npc_pickup_stone`, `_npc_mine_rock`, `_npc_pickup_stone_tile`, `_npc_give_materials`, `_npc_deposit_to_crate`

### `auxserver/services/ground_items.py`
- Drop/pickup helpers: `_tile_key`, `_find_ground_item`, `_is_log_item`, `_is_stone_item`, `_try_drop_item`, `_try_pickup_placed`

## Wiring

`ResourceService` in `resources.py` becomes a thin facade delegating to the three sub-modules, similar to how `GameState` currently delegates to `ResourceService`.

## Estimated line counts after sub-split

- `gathering.py`: ~160 lines
- `cave_mining.py`: ~280 lines
- `ground_items.py`: ~130 lines
- `resources.py` (facade): ~80 lines

## Priority

Low — functional correctness is unchanged. Execute as part of a dedicated cleanup pass (after Tasks 4–8 are complete) to keep all service modules under 600 lines.
