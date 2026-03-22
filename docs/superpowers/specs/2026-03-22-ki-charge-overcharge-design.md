# Ki Charge & Overcharge System — Design Spec
**Date:** 2026-03-22
**Status:** Approved

---

## Overview

Two layered mechanics on top of the existing ki blast system:

1. **Charge** — holding spacebar charges the blast. Release fires it. Hold duration (0–1s) determines a charge ratio (0.0–1.0) that scales damage and all blast effects from 30% (instant) to 100% (full charge). Holding beyond 1s caps at full charge.

2. **Overcharge** — a learnable ki move. While charging, pressing the overcharge hotbar key activates overcharge. On release, all effects and damage are multiplied by 1.75x on top of the charge scaling, at double the blast's ki cost (scaled by charge ratio).

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

Charge ratio scales both damage and every active blast effect:

```python
CHARGE_MIN = 0.3  # 30% power at instant release
effective_mult = CHARGE_MIN + (1.0 - CHARGE_MIN) * charge_ratio
# → 0.3 at chargeRatio=0, 1.0 at chargeRatio=1
```

Applied to:
- Final damage
- All 21 `effects` fields in the blast definition (slow_pct, burn_dps, pushback, pull, etc.)

Zero-value effects stay zero (no effect created from nothing).

### Charge Bar UI

- Thin bar (~80px wide, 6px tall) rendered above the blast hotbar slot
- Only visible while spacebar is held
- Fills left→right over 1000ms
- Color: green (0–50%) → yellow (50–85%) → white (85–100%)
- Disappears on release

---

## 2. Overcharge Skill

### Learning

`overcharge` is a new entry in the learnable ki moves pool. Learned the same way as `scatter_shot` and `explosive_shot` — via ki crystal consumption or the existing ki learning system. Stored in `player.ki_moves`.

### Hotbar Action

`overcharge` added to `HOTBAR_ACTIONS` in `InventoryController.js`. Assignable to any slot. When the slot key is pressed **while spacebar is held** (charging), it activates overcharge for that blast.

### Activation Flow

1. Player holds spacebar → charging starts
2. Player presses overcharge hotbar key → `_overcharging = true`; charge bar turns purple/gold
3. Player releases spacebar → blast fires with `overcharge: true` in server message
4. If player releases overcharge key before releasing spacebar → `_overcharging = false`, reverts to normal charge

### Server — Cost

```python
OVERCHARGE_COST_MULT = 2.0
overcharge_ki_cost = blast_ki_cost * charge_ratio * OVERCHARGE_COST_MULT
```

If the player's current ki is insufficient for the overcharge cost at release time, the `overcharge` flag is silently dropped — the blast fires at normal charged power with no overcharge bonus. No penalty beyond the normal blast cost.

Server also validates that the player has `"overcharge"` in their `ki_moves`. If not, the flag is silently dropped.

### Server — Effect Amplification

```python
OVERCHARGE_MULT = 1.75
```

Applied on top of `effective_mult` (charge scaling):

```python
total_mult = effective_mult * OVERCHARGE_MULT  # e.g. 1.0 * 1.75 = 1.75 at full charge
```

Applied to damage and all 21 blast effect values. Combined with charge scaling, range is 0.525x (0% charge + overcharge) to 1.75x (full charge + overcharge).

---

## 3. File Changes

| File | Change |
|---|---|
| `src/systems/InputController.js` | Spacebar down sets `_chargeStart`; spacebar up computes ratio, calls `firePlayerKiBlast(chargeRatio, overcharging)`; overcharge hotbar slot sets/clears `_overcharging` while charging |
| `src/systems/CombatFxController.js` | `firePlayerKiBlast(chargeRatio, overcharge)` — passes both in server message; scales client-side projectile visually (scale/alpha by chargeRatio) |
| `src/ui/HudController.js` | Charge bar drawn above blast slot — visible while `scene._charging`, color-coded, clears on release |
| `src/ui/InventoryController.js` | Add `overcharge` to `HOTBAR_ACTIONS`; `useHotbarSlot` sets `scene._overcharging = true` when called during active charge |
| `src/entities/Player.js` | Add `'overcharge'` to learnable ki moves list |
| `auxserver/services/combat_ki.py` | Read `charge_ratio` and `overcharge` from message data; compute `effective_mult`; apply to damage and all blast effects; deduct overcharge ki cost; validate `overcharge` in `ki_moves` |
| `auxserver/services/combat_utils.py` | `_apply_blast_effects()` accepts `mult` param (default 1.0); multiplies all effect values by `mult` before applying |
| `auxserver/services/input_handler.py` | Extract `charge_ratio` (clamp 0–1) and `overcharge` (bool) from incoming blast messages; pass to combat handlers |

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

- **No active blast equipped** (`activeBlastId = null`): charge and overcharge still work — charge ratio scales the base blast damage, overcharge is silently dropped (no blast def to amplify effects from)
- **Scatter shot / explosive shot modes**: charge ratio and overcharge apply on top of existing mode multipliers, same as normal
- **Ki silence debuff**: if `ki_silenced_until > now`, server rejects the blast entirely regardless of charge or overcharge
- **NPC blasts**: NPCs do not use the charge system — they fire instantly as before
