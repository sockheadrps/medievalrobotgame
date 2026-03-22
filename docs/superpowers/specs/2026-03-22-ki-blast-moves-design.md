# Ki Blast Moves System — Design Spec
**Date:** 2026-03-22
**Status:** Approved (rev 2)

---

## Overview

A system for defining named, effect-bearing ki blast moves drawn from a bank of 40 animated sprite variants. Players learn blasts through geode crystals and organic proximity observation. An in-game hotbar slot lets players equip and switch between known blasts. Every blast carries any combination of 21 effect fields (most zeroed out).

---

## 1. Data Model

### `auxserver/data/blast_moves.json`

Array of blast definition objects. One file, read at server startup, cached in a module-level dict keyed by `id`.

```json
[
  {
    "id": "glacial_spike",
    "displayName": "Glacial Spike",
    "sprite": "001_blastoozarou",
    "kiCost": 8,
    "effects": {
      "slow_pct": 60,
      "slow_duration": 3.0,
      "burn_dps": 0,
      "burn_duration": 0,
      "blind_duration": 0,
      "pushback": 0,
      "pull": 0,
      "siphon_pct": 0,
      "ki_drain": 0,
      "ki_silence_duration": 0,
      "expose_pct": 0,
      "expose_duration": 0,
      "stun_duration": 0,
      "ki_regen_suppress_duration": 0,
      "vampiric_pct": 0,
      "vampiric_duration": 0,
      "aftershock_dps": 0,
      "aftershock_radius": 0,
      "aftershock_duration": 0,
      "decay_def": 0,
      "decay_duration": 0
    }
  }
]
```

- `sprite` — matches the subfolder name in `assets/BlastsAscended/` (e.g. `"001_blastoozarou"`)
- `kiCost` — **absolute override** of the base ki cost for this blast; it replaces (not adds to) the value computed by `_calc_blast_for_actor`. Level-based scaling still applies on top.
- All 21 effect fields always present; zero means inactive.

### Effect Reference

| Field | Type | Behaviour |
|---|---|---|
| `slow_pct` | 0–100 | % speed reduction |
| `slow_duration` | seconds | duration of slow |
| `burn_dps` | damage/s | fire DoT, ticks once per second |
| `burn_duration` | seconds | fire DoT duration |
| `blind_duration` | seconds | reduces ki blast range to 20% of `KI_BLAST_RANGE` base (ignores bonuses while blinded) |
| `pushback` | pixels | instant displacement away from blast origin; suppresses client move input via `displaced_until` |
| `pull` | pixels | instant displacement toward blast origin; same suppression mechanism as pushback |
| `siphon_pct` | 0–100 | % of damage dealt healed to attacker **instantly on hit** (distinct from vampiric) |
| `ki_drain` | ki points | removed from target's current ki on hit |
| `ki_silence_duration` | seconds | target cannot use any ki move (blast, barrier, absorb) |
| `expose_pct` | 0–100 | target takes X% increased damage from all sources |
| `expose_duration` | seconds | duration of expose debuff |
| `stun_duration` | seconds | target velocity zeroed via `stunned_until` timestamp (does NOT reuse `punching` flag) |
| `ki_regen_suppress_duration` | seconds | pauses natural ki regen tick for target |
| `vampiric_pct` | 0–100 | attacker regens HP per second at X% of damage dealt for `vampiric_duration` seconds (distinct from siphon) |
| `vampiric_duration` | seconds | duration of vampiric regen on attacker |
| `aftershock_dps` | damage/s | lingering ground zone damage |
| `aftershock_radius` | pixels | radius of aftershock zone |
| `aftershock_duration` | seconds | how long zone persists |
| `decay_def` | def points | DEF reduction applied to target |
| `decay_duration` | seconds | duration of DEF reduction |

**Siphon vs Vampiric:** `siphon_pct` heals the attacker once, immediately when the blast lands. `vampiric_pct` starts a ticking regen on the attacker that lasts `vampiric_duration` seconds after the hit. They stack — a blast can have both.

---

## 2. Blast Editor (Web GUI)

A developer tool served by the existing FastAPI server. Same pattern as mapmaker/asseteditor.

**Routes** (registered in `auxserver/main.py` alongside existing admin routes):
- `GET /blasts` — serves `blastedit.html`
- `GET /api/blasts` — returns `blast_moves.json`
- `POST /api/blasts` — writes `blast_moves.json`

**Files:**
- `auxserver/templates/blastedit.html`
- `auxserver/static/blastedit.js`
- Route handlers added to `auxserver/api/admin.py`
- Route registered in `auxserver/main.py`

**Layout:**

*Left sidebar* — scrollable grid of all 40 blast thumbnails from `assets/BlastsAscended/`. Unconfigured blasts shown with dim overlay. Click to load into editor. Note: 8 of the 40 sprites use `dirs: 8` layout; the preview handles both 4-direction and 8-direction frame layouts by reading the companion JSON.

*Main panel:*
- **Preview** — canvas animating the blast sprite using frame layout from its companion JSON
- **Identity** — Display Name input, ID (auto-slugged, editable), Ki Cost input
- **Effects** — sliders/number inputs grouped by category:
  - *Movement:* Slow %, Slow Duration, Pushback, Pull, Stun Duration
  - *Damage over Time:* Burn DPS, Burn Duration, Aftershock DPS/Radius/Duration, Decay DEF, Decay Duration
  - *Ki Effects:* Ki Drain, Ki Silence Duration, Ki Regen Suppress Duration
  - *Utility:* Blind Duration, Expose %, Expose Duration
  - *Sustain:* Siphon %, Vampiric %, Vampiric Duration

*Save bar* — Save button writes to `blast_moves.json`; unsaved-changes indicator.

---

## 3. Effect System (Server-side)

### Effect Categories

**Instant (applied once on hit):**
- Pushback / Pull — displace target position away from/toward blast origin; set `target["displaced_until"] = now + 0.3` to suppress the move handler from overwriting the position with stale client input for 300ms
- Ki Drain — subtract from target's current ki
- Siphon — heal attacker for `siphon_pct`% of damage dealt, immediately

**Duration-based (timestamp fields stamped onto entity dict):**

New fields on entity dicts (players and NPCs):

| Field | Purpose |
|---|---|
| `slowed_until` | expiry timestamp |
| `slow_pct` | speed reduction % while slowed |
| `blinded_until` | expiry timestamp |
| `ki_silenced_until` | expiry timestamp |
| `exposed_until` | expiry timestamp |
| `exposed_pct` | damage increase % while exposed |
| `stunned_until` | expiry timestamp; move handler zeroes velocity (separate from `punching`) |
| `ki_regen_suppressed_until` | expiry timestamp |
| `vampiric_until` | expiry timestamp on **attacker** |
| `vampiric_pct` | HP regen % of last hit damage |
| `decay_def_until` | expiry timestamp |
| `decay_def_amount` | DEF reduction while active |
| `displaced_until` | expiry timestamp; move handler ignores input while set |

Checked at relevant action gates:
- **Slow** → move handler multiplies velocity by `(1 - slow_pct/100)`
- **Stun** → move handler zeroes velocity while `stunned_until > now`
- **Displaced** → move handler ignores client move input while `displaced_until > now`
- **Blind** → ki blast range clamped to `KI_BLAST_RANGE * 0.2` (base constant, not including bonuses)
- **Ki Silence** → gates `_ki_blast_player`, `_ki_blast_npc`, `_ki_blast_dummy`, `_activate_barrier`, absorb actions
- **Ki Regen Suppress** → skips natural ki regen tick for target
- **Expose** → incoming damage multiplied by `(1 + exposed_pct/100)` in `_calc_ki_damage_taken` and melee damage calc
- **Decay DEF** → subtracts `decay_def_amount` from effective DEF in damage calc
- **Vampiric** → attacker regens HP each second while `vampiric_until > now` in `_tick_status_effects`

**Tick-based DoT:**
- **Burn** — `burning_until`, `burn_dps`, `burn_last_tick` on entity; dealt once per second in `_tick_status_effects`
- **Aftershock** — stored in `game.aftershock_zones` list: `{x, y, map, radius, dps, expires_at, owner_pid}`; initialized in `GameState.__init__`, cleared in `GameState.reset()`; ticked in `_tick_status_effects` — damages all entities on same map within radius once per second

**New method:** `GameState._tick_status_effects(dt)` called from `GameState.tick()`.

**FX events:** `_queue_ki_blast_fx` in `combat_utils.py` must include `"blast_id"` in the emitted event payload so the client can render the correct sprite for replicated blasts (e.g. blasts fired by other players or NPCs that the local client sees).

**Blast definitions loading:** `combat_ki.py` loads `blast_moves.json` at import time into a module-level dict `BLAST_DEFS` keyed by `id`. The hit paths `_ki_blast_player`, `_ki_blast_npc`, `_ki_blast_dummy`, and `_ki_blast_ground_item` each look up the firing actor's `active_blast_id` in `BLAST_DEFS` and apply effects on hit.

**Persistence:** `active_blast_id` and `learned_blasts` are added to the `state_json` blob in `save_player` / `load_player`. No schema migration (`ALTER TABLE`) is required — both fields live inside the existing `state_json` TEXT column.

---

## 4. Hotbar Blast Slot + Selection UI

**Player state additions:**
- `active_blast_id` — string, persisted in `state_json`
- `learned_blasts` — list of blast IDs, persisted in `state_json`

**Hotbar slot:**
A dedicated slot (left of existing ki slots) shows the equipped blast's first directional frame. Placeholder "?" if no blast known. Spacebar fires it as before.

**Right-click picker:**
Popup panel above the slot showing a scrollable grid of all learned blasts — animated sprite preview + display name. Clicking one sends `set_active_blast` to server:

```json
{ "type": "set_active_blast", "blast_id": "glacial_spike" }
```

Server validates that `blast_id` is in the player's `learned_blasts` before accepting. Rejects silently if not known.

**Sprite loading:**
Blast definitions are fetched synchronously via `XMLHttpRequest` early in `GameScene.preload()` (before other `load.spritesheet` calls). All 40 `BlastsAscended` sprite sheets are then queued in the same `preload()` pass. `CombatFxController` uses the `blast_id` from the player's active blast (or from the FX event payload for remote blasts) to select the correct sprite key when animating the projectile.

**Server:** `_ki_blast_player`, `_ki_blast_npc`, `_ki_blast_dummy`, and `_ki_blast_ground_item` each look up the actor's `active_blast_id` in `BLAST_DEFS` and apply that blast's effects alongside normal damage.

---

## 5. Learning System

### Geode Crystals

Geodes (existing cave mineable) gain a new rare drop: item ID `blast_crystal` (~25% chance per geode). Granted directly to player inventory (same path as other ore drops). Sits in inventory as a consumable.

**Using a blast crystal** — input message: `{ "type": "use_blast_crystal" }`
- Server consumes one `blast_crystal` from player inventory
- If player's `learned_blasts` covers all defined blasts → awards ki XP instead
- Otherwise → selects one random blast ID not in `learned_blasts`, appends it, sends confirmation chat hint

### Proximity Learning

After any ki blast fires (in `_ki_blast_player`, `_ki_blast_npc`, etc.), the server checks all entities **on the same map** within ~200px of the blast origin.

For each entity that does **not** know the fired blast:
1. Check per-entity `last_blast_observe_at` timestamp — skip if `< now - 1.0` (1-second per-entity cooldown prevents the same entity from rolling twice for two simultaneous blasts in the same tick)
2. Roll 0.2% chance
3. On success: add blast ID to entity's `learned_blasts`; update `last_blast_observe_at`
4. Players receive chat hint: *"Watching carefully... you learned [Blast Name]!"*

NPCs (including AI rival) participate in proximity learning — their `learned_blasts` grows from watching combat. **NPC active blast selection:** when an NPC has one or more learned blasts, it uses the most recently learned one as `active_blast_id`. The AI rival follows the same rule; future LLM prompting can expose blast selection as a decision point.

**New entity field:** `last_blast_observe_at` (float timestamp, not persisted — resets to 0 each session).

---

## File Summary

| File | Change |
|---|---|
| `auxserver/data/blast_moves.json` | New — blast definitions |
| `auxserver/templates/blastedit.html` | New — editor page |
| `auxserver/static/blastedit.js` | New — editor logic |
| `auxserver/api/admin.py` | Add `/blasts` route + `/api/blasts` GET/POST handlers |
| `auxserver/main.py` | Register new `/blasts` routes |
| `auxserver/services/combat_ki.py` | Load `BLAST_DEFS`; apply effects in all 4 hit paths; proximity learning roll; include `blast_id` in FX event via `_queue_ki_blast_fx` |
| `auxserver/services/combat_utils.py` | Add `blast_id` field to `_queue_ki_blast_fx` payload |
| `auxserver/services/game_state.py` | Add `aftershock_zones` list; add `_tick_status_effects()`; check `stunned_until`, `displaced_until`, `slowed_until` in move handler; check `ki_silenced_until` before ki actions; check `ki_regen_suppressed_until` in regen tick |
| `auxserver/services/player_manager.py` | Add `active_blast_id`, `learned_blasts`, `last_blast_observe_at` to player state |
| `auxserver/services/database.py` | Add `active_blast_id`, `learned_blasts` to `state_json` in `save_player` / `load_player` |
| `auxserver/services/input_handler.py` | Handle `set_active_blast` (validate against `learned_blasts`); handle `use_blast_crystal` |
| `auxserver/services/npc_manager.py` | Add `learned_blasts`, `last_blast_observe_at` to NPC state; set `active_blast_id` to most recently learned blast |
| `src/systems/CombatFxController.js` | Fetch blast defs in `GameScene.preload()`; use `blast_id` for sprite selection on fire and on replicated FX events |
| `src/ui/InventoryController.js` | New hotbar slot; right-click blast picker popup; send `set_active_blast` |
| `src/constants.js` | Blast sprite keys for all 40 variants |
