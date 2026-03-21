# Plan 01e: PlayerManager Sub-split

`auxserver/services/player_manager.py` is 788 lines, exceeding the 600-line gate. The excess comes from `handle_input()` (~355 lines, lines 436–788), the full server-side message router, which was moved here from `game_state.py` during Task 8 to reduce that module's line count. The module docstring already flags this as a temporary home and recommends extracting it to a dedicated `InputDispatcher`.

---

## Goal

Split `player_manager.py` into two focused modules:

- `auxserver/services/player_manager.py` — pure player lifecycle (init, stats, XP, Ki, inventory, crafting, carry, death) — **~350–400 lines**
- `auxserver/services/input_handler.py` — the `handle_input` routing method extracted to its own `InputHandler` class — **~380–420 lines**

Both modules stay under the 600-line gate.

---

## File Map

**Modify:**
- `auxserver/services/player_manager.py` — remove `handle_input`; retain all player lifecycle and state management methods

**Create:**
- `auxserver/services/input_handler.py` — new `InputHandler` class containing `handle_input` and nothing else

---

## player_manager.py — Methods That Stay

**Module-level helpers**
- `tile_pos(col, row)`
- `dist(x1, y1, x2, y2)`
- `_gen_item_id()`

**Player lifecycle**
- `PlayerManager.__init__(self, game_state)`
- `add_player(self, pid)`
- `remove_player(self, pid)`

**Ki moves**
- `_ensure_default_ki_moves(self, actor)`

**Admin panel**
- `_handle_admin(self, p, data)`

**XP / Level**
- `_grant_xp(self, entity, amount)`
- `_level_based_max_ki(self, level)`
- `_ensure_level_based_ki(self, entity, refill=False)`
- `_grant_ki_skill_xp(self, entity, amount)`
- `_xp_scope_for_entity(self, entity)`
- `_scale_xp_gain(self, entity, amount)`

**AI alert queue**
- `_queue_ai_alert(self, pid, message, speech=None, source_pid=None, action=None)`

**Carry system**
- `_try_carry_player(self, pid, target_id)`
- `_drop_carried(self, pid)`

**Crafting**
- `_try_craft_equipment(self, pid, eq_id)`

**Equipment inventory**
- `_try_equip_item(self, pid, eq_id)`
- `_try_unequip_item(self, pid, slot)`
- `_try_drop_equipment(self, pid, eq_id)`

---

## input_handler.py — Methods That Move

**Full message router** (lines 436–788 of current `player_manager.py`)
- `InputHandler.__init__(self, game_state)`
- `handle_input(self, pid, data)`

`handle_input` dispatches all client `msg_type` values to the appropriate service:
- `stop`, `move` — velocity/facing/anim updates on player dict directly
- `chop`, `mine_rock`, `mine_tile`, `request_mine_tiles`, `refine_rock`, `npc_chop`, `npc_pickup_stone`, `npc_mine_rock`, `npc_pickup_stone_tile`, `npc_refine_rock`, `npc_give_materials`, `npc_interact_world_object`, `npc_deposit_to_crate`, `interact_world_object`, `harvest_crop`, `plant_seed`, `drop_item`, `pickup_placed` — delegate to `gs.resources`
- `attack_dummy`, `attack_fence`, `attack_player`, `attack_npc`, `attack_animal`, `npc_attack_dummy`, `npc_attack_player`, `npc_attack_npc`, `npc_steal_logs`, `ki_blast_miss`, `ki_blast_player`, `ki_blast_npc`, `ki_blast_dummy`, `ki_blast_ground_item`, `ki_blast_ki_target`, `absorb_npc`, `npc_ki_blast_player`, `npc_ki_blast_npc`, `npc_ki_blast_ki_target`, `npc_absorb_npc`, `activate_barrier`, `consume_crystal` — delegate to `gs.combat`
- `build_dummy`, `delete_dummy`, `build_anvil`, `delete_anvil`, `place_building`, `remove_building`, `update_building_stored`, `update_building_out_dir`, `update_building_label`, `build_ki_target`, `delete_ki_target`, `minecart_portal` — delegate to `gs.building`
- `build_npc`, `sync_npcs`, `carry_npc`, `carry_own_npc`, `npc_pickup_equipment`, `give_npc_equipment`, `take_npc_equipment` — delegate to `gs.npc_manager`
- `craft_equipment`, `equip_item`, `unequip_item`, `drop_equipment`, `carry_player`, `drop_carried`, `admin` — delegate to `self.gs.player_manager` (i.e., back to `PlayerManager`)
- `deduct_resource`, `grant_resource`, `punch`, `reset_blast_level`, `set_combat_mode`, `chat`, `register_background_npc`, `unregister_background_npcs` — handled inline

---

## Wiring Notes

`game_state.py` currently calls `self.player_manager.handle_input(pid, data)`. After the split, add an `input_handler` attribute to `GameState`:

```python
from services.input_handler import InputHandler
# in GameState.__init__:
self.input_handler = InputHandler(self)
```

Then update the call site in `game_state.py` (and any WebSocket handler) to:

```python
self.input_handler.handle_input(pid, data)
```

`InputHandler` receives `game_state` as `self.gs` and accesses `self.gs.player_manager` for the player lifecycle delegates (craft, equip, carry, admin), so no circular import is introduced — `input_handler.py` imports `PlayerManager` only at runtime through `self.gs`.

`PlayerManager` does not need to import `InputHandler` at all.

---

## Estimated Line Counts After Sub-split

| File | Lines |
|------|-------|
| `player_manager.py` | ~390 |
| `input_handler.py` | ~400 |

Both are comfortably under the 600-line gate.

---

## Priority

Medium — no functional change; purely a structural cleanup. Execute as a standalone pass once all Task 8 stabilisation is confirmed green.
