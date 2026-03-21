# NPC Autonomy Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make human-player NPCs feel genuinely alive — pursuing their own drives, reacting to the world, interacting with each other, and continuing to work while the player is away.

**Architecture:** Four interlocking systems, all client-side except the background worker extension which is server-side. Each system is independently deployable. Drive decay feeds goal selection; goals feed background work; proximity events feed NPC-to-NPC interaction.

**Tech Stack:** JavaScript (Phaser 3, existing NPCBrain/DriveSystem/NPCTaskRunner), Python (FastAPI, existing npc_manager.py), Ollama (local LLM, existing prompt infrastructure).

---

## Files Touched

| File | Change |
|------|--------|
| `src/systems/DriveSystem.js` | Targeted satisfaction decay; reflex check method |
| `src/systems/NPCBrain.js` | Goal persistence fields; `_reflexCheck()`; `_makeBackgroundGoal()`; proximity event push; background handoff |
| `src/systems/npc/SocialTaskHandler.js` | New `doGreetNpc()` task |
| `src/systems/NPCTaskRunner.js` | Wire up `greet_npc` task type |
| `src/systems/npc/NPCBrainData.js` | Add `current_goal` to state packet |
| `src/scenes/GameScene.js` | Trigger background goal on map transition |
| `auxserver/api/ws.py` | Accept `goal` + `drives` in `register_background_npc` message |
| `auxserver/services/npc_manager.py` | Goal step execution; extended task support; return briefing |

---

## Section 1: Drive Decay + Reflexive Actions

### Problem

Drive decay currently applies to whichever drive is affiliated with the active task at a flat 6%/s — but the affiliation is coarse. A Pragmatist mining ore still decays all drives equally. NPCs never feel like they've satisfied one need and moved on to the next.

### Targeted Satisfaction Decay

Replace the blanket task-affinity decay with a mapping from task → drive(s) it satisfies. Only those drives decay while the task runs.

```js
// DriveSystem.js — DRIVE_TASK_SATISFACTION
const DRIVE_TASK_SATISFACTION = {
  gather:          ['greed'],
  gather_stone:    ['greed'],
  gather_all:      ['greed'],
  mine_ore:        ['greed'],
  deposit_to_crate:['greed'],
  give_logs:       ['attachment'],
  give_materials:  ['attachment'],
  train:           ['ambition'],
  practice_ki:     ['ambition'],
  wander_explore:  ['curiosity'],
  follow:          ['attachment', 'survival'],
  socialize_npc:   ['social'],
  greet_npc:       ['social'],
  attack_nearest_enemy: ['aggression'],
  defend_player:   ['aggression', 'attachment'],
  hold_position:   [],
  observe:         ['curiosity'],
};
```

Decay rate stays 6%/s per satisfied drive. Unsatisfied drives continue to build. This creates natural cycling: a Caretaker gathers wood (satisfying greed), then attachment peaks so it gives logs to the player (satisfying attachment), then social climbs so it greets a nearby NPC.

### Environmental Reflex Layer

New `_reflexCheck(currentTask)` method on NPCBrain, called every 2 seconds from `update()`. Fires before the drive threshold system. Returns a task descriptor or null.

```js
_reflexCheck(currentTask) {
  const npc = this._npc;
  const soul = npc.soul || {};
  const drives = soul.drives || {};

  // 1. Survival override — always fires regardless of manual lock
  if ((npc.hp / npc.maxHp) < 0.25) {
    return { task: 'follow' };
  }

  // Below this line: blocked by manual lock and sticky owner task
  if (this._isManuallyLocked() || this._isOwnerStickyRunning()) return null;

  // 2. Ore nearby + greed
  if ((drives.greed || 0) > 0.45 && this._nearbyOreCount() > 0) {
    return { task: 'mine_ore' };
  }

  // 3. Dummy nearby + ambition
  if ((drives.ambition || 0) > 0.50 && this._nearbyDummyCount() > 0) {
    return { task: 'train' };
  }

  // 4. Nearby NPC + social (feeds greet_npc — see Section 3)
  if ((drives.social || 0) > 0.45 && this._nearbyFriendlyNpc()) {
    return { task: 'greet_npc', target: this._nearbyFriendlyNpc().id };
  }

  return null;
}
```

Reflexes do not set `_ownerCommandTask` and do not extend `_manualCommandUntil`. They are overrideable by the next player command or drive decision.

---

## Section 2: Goal Persistence

### Problem

Each LLM decision is stateless. The NPC can pivot from mining to following to socializing every 15 seconds. There is no coherent thread of intent.

### Goal Object

NPCBrain gains a `_goal` field:

```js
this._goal = null;
// Shape:
// {
//   intent: string,         // human-readable: "mine copper seam near the crates"
//   steps: string[],        // task names: ["mine_ore", "deposit_to_crate"]
//   stepIndex: number,      // current position in steps
//   repeat: boolean,        // loop back to step 0 when exhausted
//   startedAt: number,      // Date.now()
//   maxMs: number,          // auto-expire (default: 120000)
// }
```

### Step Advancement

When the task runner signals completion of the current step (task queue empties), NPCBrain checks `_goal`:

```js
_advanceGoal() {
  if (!this._goal) return false;
  if (Date.now() - this._goal.startedAt > this._goal.maxMs) {
    this._goal = null;
    return false;
  }
  this._goal.stepIndex++;
  if (this._goal.stepIndex >= this._goal.steps.length) {
    if (this._goal.repeat) {
      this._goal.stepIndex = 0;
    } else {
      this._goal = null;
      return false;
    }
  }
  const nextTask = this._goal.steps[this._goal.stepIndex];
  this._runner.setTasks([{ task: nextTask }]);
  return true;
}
```

No LLM call between steps. Steps advance automatically until the goal expires or an interrupting event fires.

### LLM Integration

`NPCBrainData.buildStatePacket()` gains a `current_goal` field:

```js
current_goal: this._goal ? {
  intent: this._goal.intent,
  step: this._goal.steps[this._goal.stepIndex],
  steps_remaining: this._goal.steps.length - this._goal.stepIndex,
  age_ms: Date.now() - this._goal.startedAt,
} : null,
```

LLM response gains optional `goal` field. When present, NPCBrain stores it and starts executing from step 0. When absent and a goal is active, treat as `continue_goal` — do nothing. The LLM only overrides the goal when it explicitly sets a new one.

### Reconsideration Triggers

The LLM is consulted (and may replace the goal) only when:
- No goal exists
- Goal has expired
- `_eventQueue` has a high-importance event (≥ 0.8)
- HP drops below 35% threshold
- Goal step completes and `_advanceGoal()` returns false (exhausted, non-repeating)

This reduces LLM call frequency significantly for NPCs with stable goals.

---

## Section 3: NPC-to-NPC Interaction

### Proximity Events

NPCBrain gains a `_knownNearbyNpcs` Set tracking which NPC IDs are currently within 6 tiles. In `update()`, compare current nearby NPCs (from the scene's NPC list) against `_knownNearbyNpcs`:

- NPC enters range → `pushEvent({ type: 'npc_nearby', text: '${name} is nearby', importance: 0.3 })`
- NPC enters range during combat → `pushEvent({ type: 'npc_combat_nearby', text: '${name} is fighting', importance: 0.65 })`

The `npc_nearby` event feeds the reflex check (social drive). The `npc_combat_nearby` event is high enough to trigger an LLM decision on the next cooldown.

### Greet Task

New `doGreetNpc(target)` in SocialTaskHandler. Lighter than `socialize_npc`:

- Move within 2 tiles of target NPC
- Generate one line of dialogue via a stripped prompt (personality type + relationship label only, no full soul context)
- Show speech bubble on both NPCs
- Apply ±0.05 relationship delta (trust up if cooperation high, neutral otherwise)
- Store one memory entry: `"greeted ${name}"`
- Task completes in ~3 seconds total

The greet task is intentionally cheap. It fires from the reflex layer multiple times per session to create the sense that NPCs have an ongoing social life. Full `socialize_npc` remains for when social drive is properly high (≥ 0.7 via drive system).

### Combat Reactions

`npc_combat_nearby` event triggers an LLM decision. The state packet already includes `nearby_threats` and `npc_relationships`. The LLM can respond with:

- `attack_npc` (join the fight) — likely for Berserker, high-aggression NPCs
- `defend_player` or `follow` (retreat) — likely for Paranoid, high-survival NPCs
- `observe` (watch) — likely for Scout, neutral NPCs

No new code needed beyond the event push — the existing decision machinery handles the rest.

---

## Section 4: Unsupervised Background Work

### Client-Side Handoff

When the player transitions maps (detected in GameScene.js map change handler), before calling `register_background_npc` for each NPC:

1. Call `npcBrain.makeBackgroundGoal()` — lightweight LLM request
2. Prompt includes: personality type, current drives, current map's available resources (ore, trees, crates), NPC level/inventory
3. LLM returns a goal object (same shape as Section 2)
4. On failure/timeout (5s max): fall back to highest-drive deterministic selection

```js
_driveToBackgroundTask(drives) {
  const ranked = Object.entries(drives)
    .filter(([k]) => !k.startsWith('_'))
    .sort(([,a],[,b]) => b - a);
  const driveTaskMap = {
    greed: 'mine_ore', ambition: 'train',
    curiosity: 'wander_explore', social: 'wander_explore',
    attachment: 'wander_explore', survival: 'wander_explore',
    aggression: 'train',
  };
  for (const [drive] of ranked) {
    if (driveTaskMap[drive]) return driveTaskMap[drive];
  }
  return 'wander_explore';
}
```

### Updated register_background_npc Message

```js
{
  type: 'register_background_npc',
  npc_id: npc.id,
  map: currentMap,
  goal: {
    intent: "mine the copper seam and deposit when full",
    steps: ["mine_ore", "deposit_to_crate"],
    repeat: true,
    maxMs: 600000,  // 10 min max background duration
  },
  drives: { ...drives },  // snapshot at handoff time
  task: steps[0],         // backward compat field
}
```

### Server-Side Goal Execution

`npc_manager.py` stores the goal in `background_npcs[npc_id]["goal"]` alongside the existing `task` field.

`_tick_background_npcs` already dispatches on `task`. Extend it to advance through goal steps:

```python
def _advance_bg_goal(self, bg):
    goal = bg.get("goal")
    if not goal:
        return
    steps = goal.get("steps", [])
    idx = bg.get("_goal_step", 0)
    # current step matches bg["task"] — advance when tick signals completion
    idx = (idx + 1) % len(steps) if goal.get("repeat") else idx + 1
    if idx >= len(steps):
        bg["task"] = None
        return
    bg["_goal_step"] = idx
    bg["task"] = steps[idx]
```

Extended task support beyond `mine_ore`:

| Task | Server Simulation |
|------|-------------------|
| `mine_ore` | Already implemented — decrement ore HP, add drops |
| `gather` | Same pattern using tree instances |
| `deposit_to_crate` | Already implemented |
| `train` | Add `level * 2` XP to NPC stats per tick interval |
| `wander_explore` | No-op tick — just advances time, logs "explored" |

### Return Briefing

When the player re-enters the map and `unregister_background_npcs` fires, server includes an activity summary in the response:

```python
{
  "type": "bg_npc_return",
  "npc_id": npc_id,
  "summary": {
    "goal_intent": bg.get("goal", {}).get("intent"),
    "ticks": bg.get("_tick_count", 0),
    "gathered": bg.get("_gathered", {}),  # resource -> count
    "xp_gained": bg.get("_xp_gained", 0),
  }
}
```

Client receives this and pushes a `background_return` event to NPCBrain with importance 0.4. The NPC's next dialogue or decision will naturally incorporate what it did — the memory is in the event log.

---

## Integration Notes

- All four features are independently deployable. Drive decay (S1) has no dependency on goal persistence (S2). Background work (S4) degrades gracefully if LLM fails (falls back to drive-based deterministic selection).
- `_reflexCheck()` runs before the drive threshold system in NPCBrain.update(), so reflexes get first pick. Manual lock and sticky tasks block reflexes (except survival override).
- Goal persistence reduces LLM call frequency — NPCs with stable goals may go 2+ minutes between LLM calls. This is intentional and improves Ollama performance.
- The `greet_npc` task uses a stripped prompt. It must not exceed ~300 tokens total to stay cheap.
- Background goal LLM call has a 5-second timeout. GameScene must not block the map transition waiting for it — fire-and-forget with fallback.
