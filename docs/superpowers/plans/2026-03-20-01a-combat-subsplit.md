# combat.py Sub-Split Plan

**Goal:** Split `auxserver/services/combat.py` (1,212 lines) into two focused modules and a thin facade, satisfying the 600-line gate.

---

## File Map

**Create:**
- `auxserver/services/combat_melee.py` (~580 lines) — stat helpers, melee combat, barriers, crystal defense, Ki blast helpers, NPC combat, PvP, knockout, dummy/animal/fence attacks
- `auxserver/services/combat_ki.py` (~400 lines) — Ki Blast Combat (full Ki blast system), Absorb mechanic, Ki Target system

**Modify:**
- `auxserver/services/combat.py` → thin `CombatService` facade that imports both sub-modules and delegates all public methods

---

## combat_melee.py — Methods

**Stat helpers**
- `_get_effective_str(actor)`
- `_get_effective_def(actor)`
- `_equipment_stat_bonus(actor, stat_key)`

**Ki upgrade helpers**
- `_get_upgrade_map(actor)`
- `_get_upgrade_value(actor, move_id, stat_id)`
- `_get_blast_range(actor)`
- `_get_blast_cooldown(actor)`

**Melee damage**
- `_calc_melee_damage(attacker, defender)`

**Barrier**
- `_get_barrier_stats(actor)`
- `_apply_barrier_reduction(target, damage_type, raw_damage)`
- `_try_spend_plain_ki(actor, amount)`
- `_activate_barrier(pid, npc_id=None)`

**Crystal defense**
- `_consume_crystal(pid, npc_id=None)`

**Ki blast helpers** (cost/dmg math only — no combat execution)
- `_calc_blast(blast_level)`
- `_calc_blast_for_actor(actor)`
- `_apply_blast_mode(cost, dmg, blast_mode)` (static)
- `_calc_ki_damage_taken(raw_dmg, target)`
- `_compute_blast_visual_impact(actor, target=None)`
- `_queue_ki_blast_fx(actor, target=None, owner_pid=None, npc_id=None)`
- `_queue_absorb_fx(actor, target, owner_pid=None, npc_id=None)`
- `_try_ki_spend(entity, cost)`

**NPC combat helpers**
- `_npc_attack_dummy(owner_pid, npc_id, dummy_id, npc_str)`

**PvP Combat**
- `_try_attack_player(attacker_pid, target_pid)`
- `_try_attack_npc(attacker_pid, target_owner_pid, target_npc_id)`
- `_npc_attack_player(owner_pid, target_pid, npc_str, npc_id)`
- `_npc_attack_npc(owner_pid, attacker_npc_id, target_owner_pid, target_npc_id, npc_str)`
- `_npc_steal_logs(owner_pid, attacker_npc_id, target_owner_pid, target_npc_id, npc_str, steal_amount)`

**Knockout / Respawn**
- `_knockout_duration()`
- `_drop_player_resource(target, resource_key, resource_name)`
- `_apply_player_knockout_penalty(target)`
- `_knock_out_player(target)`
- `_knock_out_npc(npc_state, attacker_pid=None)`
- `_kill_player(target, killer=None)`

**Dummy / Animal / Fence attacks**
- `_try_attack_dummy(pid, dummy_id)`
- `_try_attack_animal(pid, animal_id)`
- `_try_attack_fence(pid, bid)`

---

## combat_ki.py — Methods

**Ki Blast Combat**
- `_ki_blast_player(attacker_pid, target_pid, blast_mode="")`
- `_ki_blast_npc(attacker_pid, target_owner_pid, target_npc_id, blast_mode="")`
- `_ki_blast_dummy(pid, dummy_id, blast_mode="")`
- `_ki_blast_ground_item(pid, item_id, blast_mode="")`
- `_npc_ki_blast_player(owner_pid, npc_id, target_pid)`
- `_npc_ki_blast_npc(owner_pid, attacker_npc_id, target_owner_pid, target_npc_id)`

**Absorb mechanic**
- `_get_actor_for_absorb(actor_pid, actor_npc_id=None)`
- `_start_player_absorb(attacker_pid, target_owner_pid, target_npc_id)`
- `_start_npc_absorb(owner_pid, npc_id, target_owner_pid, target_npc_id)`
- `_start_absorb(actor_pid, actor_npc_id, target_owner_pid, target_npc_id)`
- `_resolve_pending_absorb(absorb)`

**Ki Target system**
- `_ki_blast_ki_target(pid, target_id, watching_npc_id=None)`
- `_npc_ki_blast_ki_target(owner_pid, npc_id, target_id)`

---

## Facade combat.py

After the split, `combat.py` will contain only `CombatService`:

```python
from services.combat_melee import CombatMeleeService
from services.combat_ki import CombatKiService


class CombatService(CombatMeleeService, CombatKiService):
    """Thin facade: combines CombatMeleeService and CombatKiService."""

    def __init__(self, game_state):
        self.gs = game_state
```

Both sub-modules receive `self.gs` via the shared `__init__`, so no wiring changes are needed in `game_state.py`.

---

## Execution Notes

- Both sub-modules import constants from `game_state.py` the same way `combat.py` does today.
- `combat_melee.py` and `combat_ki.py` do NOT import each other — cross-calls go through `self` (the combined `CombatService` instance).
- Run smoke tests after the split: `cd auxserver && python -m pytest tests/test_smoke.py -v`
- Line count targets: `combat_melee.py` < 600, `combat_ki.py` < 450, `combat.py` < 20.
