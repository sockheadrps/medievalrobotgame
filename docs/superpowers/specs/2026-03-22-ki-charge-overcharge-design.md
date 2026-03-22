# Ki Charge & Overcharge System — Design Spec
**Date:** 2026-03-22
**Status:** Approved

---

## Overview

Two layered mechanics on top of the existing ki blast system:

1. **Charge** — holding spacebar charges the blast. Release fires it. Hold duration (0–1s) determines a charge ratio (0.0–1.0) that scales damage and blast effect magnitudes from 30% (instant) to 100% (full charge). Holding beyond 1s caps at full charge.

2. **Overcharge** — a learnable ki move. While charging, pressing the overcharge hotbar key activates overcharge. On release, all effect magnitudes and damage are multiplied by 1.75x on top of the charge scaling, at double the blast's ki cost (scaled by charge ratio).

---

## 1. Charge Mechanic

### Input Flow

- **Spacebar down** → record `_chargeStart = Date.now()` on the client; begin charge bar animation
- **Spacebar up** → compute `chargeRatio = Math.min(1.0, (Date.now() - _chargeStart) / 1000)` → fire blast with `charge_ratio` in server message
- If spacebar is already held (re-press), ignore

### Charge Ratio Formula

```
chargeRatio = clamp((holdMs / 1000), 0.0, 1.0)
```

Full charge reached after 1000ms. No penalty for holding beyond that.

### Server Scaling

`effective_mult` is computed from the charge ratio and applied to damage and **magnitude-only** effect fields (see list below). Duration fields are **not** scaled — a full-charge stun lasts the same duration as an instant-release stun, it just stuns harder (not longer).

```python
CHARGE_MIN = 0.3  # 30% power at instant release
effective_mult = CHARGE_MIN + (1.0 - CHARGE_MIN) * charge_ratio
# → 0.3 at chargeRatio=0, 1.0 at chargeRatio=1
```

**Magnitude fields scaled by `effective_mult`:**
`slow_pct`, `burn_dps`, `pushback`, `pull`, `siphon_pct`, `ki_drain`, `expose_pct`, `vampiric_pct`, `aftershock_dps`, `aftershock_radius`, `decay_def`

**Duration fields — NOT scaled (unchanged):**
`slow_duration`, `burn_duration`, `blind_duration`, `ki_silence_duration`, `expose_duration`, `ki_regen_suppress_duration`, `vampiric_duration`, `aftershock_duration`, `decay_duration`, `stun_duration`

**`blind_duration`** is a threshold effect (either blinded or not), so it is also not scaled.

Zero-value magnitude fields stay zero.

**Application point:** `effective_mult` is passed as a parameter to `_apply_blast_effects()` in `auxserver/services/combat_ki.py` (the method is defined there, not in `combat_utils.py`). It is also multiplied into the final damage value before dealing damage.

**No active blast equipped (`activeBlastId = None`):** charge ratio still scales the base damage from `_calc_blast_for_actor()` via `effective_mult`. There are no blast effects to scale. Overcharge is silently dropped.

### Charge Bar UI

- Thin bar (~80px wide, 6px tall) rendered above the blast hotbar slot in `HudController.js`
- Only visible while `scene._charging === true`
- Fills left→right over 1000ms
- Color: green (0–50%) → yellow (50–85%) → white (85–100%)
- Disappears immediately on spacebar release

---

## 2. Overcharge Skill

### Learning

`overcharge` is a new entry in the learnable ki moves pool. Learned the same way as `scatter_shot` and `explosive_shot` — via ki crystal consumption or the existing ki learning system. Stored in `player.ki_moves`.

### Hotbar Action

`overcharge` added to `HOTBAR_ACTIONS` in `InventoryController.js`. Assignable to any slot. When the slot key is pressed **while spacebar is held** (`scene._charging === true`), it activates overcharge for that blast. Pressing it when not charging does nothing.

### Activation Flow

1. Player holds spacebar → `scene._charging = true`, `_chargeStart = Date.now()`
2. Player presses overcharge hotbar key → `scene._overcharging = true`; charge bar turns purple/gold
3. Player releases spacebar → compute `chargeRatio`, fire blast with `charge_ratio` and `overcharge: true` in server message; clear `_charging`, `_overcharging`, `_chargeStart`
4. If player releases overcharge key before releasing spacebar → `scene._overcharging = false`, charge bar reverts to normal color

### Server — Cost

```python
OVERCHARGE_COST_MULT = 2.0
overcharge_ki_cost = blast_ki_cost * charge_ratio * OVERCHARGE_COST_MULT
```

Note: at `charge_ratio = 0` (instant tap + overcharge), overcharge ki cost is 0. This is intentional — an instant-release overcharge provides very little benefit (30% power × 1.75 = 52.5%) and wastes the overcharge skill slot, so zero extra cost is acceptable.

If the player's current ki is insufficient for the overcharge cost at release time, the `overcharge` flag is silently dropped — the blast fires at normal charged power with no overcharge bonus. No penalty beyond the normal blast cost.

Server validates that the player has `"overcharge"` in their `ki_moves`. If not, the flag is silently dropped.

### Server — Effect Amplification

```python
OVERCHARGE_MULT = 1.75
```

Applied on top of `effective_mult` (charge scaling):

```python
total_mult = effective_mult * OVERCHARGE_MULT  # e.g. 1.0 * 1.75 = 1.75 at full charge
```

`total_mult` replaces `effective_mult` when overcharge is active. Applied identically — magnitude fields only, same exclusions as charge scaling. Combined range: 0.525x (instant release + overcharge) to 1.75x (full charge + overcharge).

---

## 3. File Changes

| File | Change |
|---|---|
| `src/systems/InputController.js` | Spacebar down sets `scene._charging = true`, `scene._chargeStart = Date.now()`; spacebar up computes `chargeRatio`, calls `scene._combatFx.firePlayerKiBlast(chargeRatio, scene._overcharging)`, clears `_charging/_overcharging/_chargeStart` |
| `src/systems/CombatFxController.js` | `firePlayerKiBlast(chargeRatio=1, overcharge=false)` — passes `charge_ratio` and `overcharge` in all 6 server message types (`ki_blast_player`, `ki_blast_npc`, `ki_blast_dummy`, `ki_blast_ground_item`, `ki_blast_ki_target`, `ki_blast_miss`); scales client projectile visually (`proj.setScale(1.5 * (0.5 + 0.5 * chargeRatio))`) |
| `src/ui/HudController.js` | Charge bar drawn above blast slot — visible while `scene._charging`, color-coded by ratio, clears on release |
| `src/ui/InventoryController.js` | Add `overcharge` to `HOTBAR_ACTIONS`; in `useHotbarSlot`, if action is `overcharge` and `scene._charging`, set `scene._overcharging = true` |
| `src/entities/Player.js` | Add `'overcharge'` to learnable ki moves list (alongside `scatter_shot`, `explosive_shot`) |
| `auxserver/services/combat_ki.py` | In all hit paths (`_ki_blast_player`, `_ki_blast_npc`, `_ki_blast_dummy`, `_ki_blast_ki_target`): read `charge_ratio` (clamp 0–1, default 1.0) and `overcharge` (bool, default False) from `data`; compute `effective_mult`; apply `total_mult` to damage; pass `total_mult` to `_apply_blast_effects()`; deduct overcharge ki cost; validate `overcharge` in `ki_moves` |
| `auxserver/services/combat_ki.py` | `_apply_blast_effects(attacker, target, final_dmg, mult=1.0)` — multiply each magnitude field by `mult` before applying; duration fields unchanged |
| `auxserver/services/input_handler.py` | No change needed — `charge_ratio` and `overcharge` are read directly from `data` inside the combat handlers |

---

## 4. Constants

| Constant | Value | Location |
|---|---|---|
| `CHARGE_TIME_MS` | 1000 | Client (`InputController.js`) |
| `CHARGE_MIN` | 0.3 | Server (`combat_ki.py`) |
| `OVERCHARGE_MULT` | 1.75 | Server (`combat_ki.py`) |
| `OVERCHARGE_COST_MULT` | 2.0 | Server (`combat_ki.py`) |

---

## 5. Edge Cases

- **No active blast equipped** (`activeBlastId = None`): charge scales base damage from `_calc_blast_for_actor()` via `effective_mult`; no effects to scale; overcharge silently dropped
- **`ki_blast_ki_target`**: included in all charge/overcharge handling same as other hit paths
- **Scatter shot / explosive shot modes**: charge ratio and overcharge apply on top of existing mode multipliers
- **Ki silence debuff**: server rejects blast entirely if `ki_silenced_until > now`, regardless of charge or overcharge
- **NPC blasts**: NPCs do not use the charge system — they fire instantly, `charge_ratio` defaults to 1.0 on their paths
- **Instant tap + overcharge at zero cost**: intentional — 52.5% power is weak, no exploit concern
