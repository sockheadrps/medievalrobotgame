# NPC Autonomy Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make human-player NPCs feel genuinely alive — pursuing their own drives, reacting to the world, interacting with each other, and continuing to work while the player is away.

**Architecture:** Four interlocking systems, all client-side except the background worker extension which is server-side. Each system is independently deployable. Drive decay feeds goal selection; goals feed background work; proximity events feed NPC-to-NPC interaction.

**Tech Stack:** JavaScript (Phaser 3, existing NPCBrain/DriveSystem/NPCTaskRunner), Python (FastAPI, existing npc_manager.py), Ollama (local LLM, existing prompt infrastructure).

---

## Files Touched

| File | Change |
|------|--------|
| `src/systems/DriveSystem.js` | Replace `TASK_DRIVE_AFFINITY` with multi-drive `DRIVE_TASK_SATISFACTION`; update `applyTaskDecay()` to loop over array |
| `src/systems/NPCBrain.js` | Goal persistence fields; `_reflexCheck()`; `_makeBackgroundGoal()`; proximity tracking; `_advanceGoal()` |
| `src/systems/npc/SocialTaskHandler.js` | New `doGreetNpc(cmd)` method |
| `src/systems/NPCTaskRunner.js` | Add `greet_npc` case to dispatch switch |
| `src/systems/npc/NPCBrainData.js` | Add `current_goal` to state packet |
| `src/scenes/GameScene.js` | Trigger background goal on map transition |
| `auxserver/api/ws.py` | Send `bg_npc_return` message in unregister handler |
| `auxserver/services/input_handler.py` | Accept `goal` field in `register_background_npc`; send return summary in unregister |
| `auxserver/services/npc_manager.py` | Goal step execution in `_tick_background_npcs`; `_advance_bg_goal()`; extended task support; activity tracking |

---

## Section 1: Drive Decay + Reflexive Actions

### Targeted Satisfaction Decay

**`TASK_DRIVE_AFFINITY` in `DriveSystem.js` (lines 31–54) must be replaced.** The existing mapping assigns one drive per task as a string. Replace it with `DRIVE_TASK_SATISFACTION` mapping tasks to an array of drives. Also update `applyTaskDecay()` (line 253) and `checkCompliance()` (line 272) which both call `TASK_DRIVE_AFFINITY`.

Semantic changes vs. the current mapping:
- `give_logs`, `give_materials`: was `'greed'`, now `['attachment']` — giving resources is an act of care, not greed
- `follow`: was not present, now `['attachment', 'survival']`
- `defend_player`: was not present, now `['aggression', 'attachment']`

```js
// DriveSystem.js — replaces TASK_DRIVE_AFFINITY
export const DRIVE_TASK_SATISFACTION = {
  gather:               ['greed'],
  gather_wood:          ['greed'],
  gather_stone:         ['greed'],
  gather_all:           ['greed'],
  mine_ore:             ['greed'],
  deposit_to_crate:     ['greed'],
  give_logs:            ['attachment'],
  give_materials:       ['attachment'],
  train:                ['ambition'],
  practice_ki:          ['ambition'],
  wander_explore:       ['curiosity'],
  follow:               ['attachment', 'survival'],
  stay_near_player:     ['attachment'],
  socialize_npc:        ['social'],
  greet_npc:            ['social'],
  attack_nearest_enemy: ['aggression'],
  attack_npc:           ['aggression'],
  defend_player:        ['aggression', 'attachment'],
  hold_position:        [],
  observe:              ['curiosity'],
};
```

Update `applyTaskDecay()` to iterate over the array:

```js
static applyTaskDecay(npc, taskName, deltaMs) {
  const drives = npc.soul?.drives;
  if (!drives) return;
  const satisfied = DRIVE_TASK_SATISFACTION[taskName];
  if (!satisfied?.length) return;
  const dt = Math.min(deltaMs / 1000, MAX_DT_SEC);
  for (const drive of satisfied) {
    drives[drive] = Math.max(0, (drives[drive] ?? 0) - TASK_DECAY_RATE * dt);
  }
}
```

Update `checkCompliance()` (line 272) to use `DRIVE_TASK_SATISFACTION[commandTask]?.[0]` in place of `TASK_DRIVE_AFFINITY[commandTask]` — take the first drive in the array as the primary affinity for compliance checking.

### Environmental Reflex Layer

New `_reflexCheck(status, now)` method on NPCBrain, called every 2 seconds inside `update()` after the drive tick but before the drive commit lock check. Uses the same inline lock patterns as the existing code (lines 241–242):

```js
_reflexCheck(status, now) {
  const npc = this._npc;
  const drives = npc.soul?.drives || {};

  // Survival override — bypasses ALL locks including manual
  if ((npc.hp / npc.maxHp) < 0.25) {
    this._runner.setTasks([{ task: 'follow' }]);
    return true;
  }

  // Below this line: respect manual lock and commit lock
  const isManualLocked = npc._manualCommandUntil && now < npc._manualCommandUntil;
  const isCommitLocked = (drives._commitUntil ?? 0) > now;
  if (isManualLocked || isCommitLocked) return false;

  // Don't interrupt blocking tasks
  const blockingTasks = ['give_logs','socialize_npc','steal_logs','practice_ki',
                         'refine_stone','deposit_to_crate','custom_task','greet_npc'];
  if (status.tasks.some(t => blockingTasks.includes(t.task))) return false;

  // Ore nearby + greed
  if ((drives.greed ?? 0) > 0.45) {
    const nearestOre = this._scene?.getNearestOre?.(npc);
    if (nearestOre) {
      this._runner.setTasks([{ task: 'mine_ore' }]);
      return true;
    }
  }

  // Training dummy nearby + ambition
  if ((drives.ambition ?? 0) > 0.50) {
    const nearDummy = this._scene?.getNearestDummy?.(npc);
    if (nearDummy) {
      this._runner.setTasks([{ task: 'train' }]);
      return true;
    }
  }

  // Nearby friendly NPC + social — feeds greet_npc (Section 3)
  if ((drives.social ?? 0) > 0.45) {
    const friendlyNpc = this._nearbyFriendlyNpc();
    if (friendlyNpc) {
      this._runner.setTasks([{ task: 'greet_npc', target: friendlyNpc.id }]);
      return true;
    }
  }

  return false;
}
```

"Friendly NPC" definition for `_nearbyFriendlyNpc()`: any remote NPC sprite from `this._scene._remoteNPCSprites` within 6 tiles whose NPC ID is NOT in `this._scene._recentThreats`. Returns the nearest such NPC object or null.

Reflexes do not set `_ownerCommandTask` and do not modify `_manualCommandUntil`. They are overrideable by any player command.

**Call site in `update()`** — add after the drive tick / task decay block, throttled to every 2000ms:

```js
// After DriveSystem.tick() and applyTaskDecay():
if (now - this._lastReflexCheck > 2000) {
  this._lastReflexCheck = now;
  if (this._reflexCheck(status, now)) return; // reflex fired, skip rest of update
}
```

---

## Section 2: Goal Persistence

### Goal Object

Add to NPCBrain constructor:

```js
this._goal = null;
this._lastReflexCheck = 0;
// Goal shape:
// {
//   intent: string,         // human-readable: "mine copper seam near the crates"
//   steps: string[],        // task names, restricted to parameterless tasks (see below)
//   stepIndex: number,
//   repeat: boolean,        // loop back to step 0 when exhausted
//   startedAt: number,
//   maxMs: number,          // auto-expire (default: 120000)
// }
```

**Allowed step tasks** (parameterless — safe to call with `{ task: name }` only):
`mine_ore`, `gather`, `gather_stone`, `gather_all`, `deposit_to_crate`, `train`, `practice_ki`, `wander_explore`, `follow`, `observe`

Tasks requiring target parameters (`socialize_npc`, `greet_npc`, `attack_npc`) must not appear in `steps[]` — they are triggered by drives/reflexes/events, not goals.

### Step Advancement

`_advanceGoal()` — called in `update()` when the runner goes idle and a goal is active:

```js
_advanceGoal(now) {
  if (!this._goal) return false;
  if (now - this._goal.startedAt > this._goal.maxMs) {
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
  this._runner.setTasks([{ task: this._goal.steps[this._goal.stepIndex] }]);
  return true;
}
```

**Call site in `update()`** — in the existing idle/not-busy branch, before the LLM decision trigger:

```js
// Existing pattern (around line 260):
const isBusy = status.running;
if (!isBusy) {
  if (this._advanceGoal(now)) return; // goal advanced, skip LLM
  // ... existing idle refresh / LLM call logic
}
```

### Drive Commit Lock Interaction

While `_goal` is non-null, skip the drive-based silent task switching block (lines 243–261 of NPCBrain.js). Goals take priority over drive switching. The reflex layer (Section 1) still fires because it runs before this check. Player commands still override via `_manualCommandUntil`.

```js
// In update(), after the drive/reflex block:
if (this._goal && !isManualLocked) {
  // Goal is active — don't let drive system reassign tasks
} else if (!isManualLocked && !isCommitLocked) {
  // Existing drive intent switching code
  const dominantDrive = DriveSystem.getDominantIntent(...);
  // ...
}
```

### LLM Integration

`NPCBrainData.buildStatePacket()` gains `current_goal`:

```js
current_goal: this._goal ? {
  intent: this._goal.intent,
  current_step: this._goal.steps[this._goal.stepIndex],
  steps_remaining: this._goal.steps.length - this._goal.stepIndex,
  age_ms: Date.now() - this._goal.startedAt,
} : null,
```

LLM response gains optional `goal` field. When present, NPCBrain stores it and starts executing from `stepIndex: 0`. When absent and a goal is active, NPCBrain leaves the goal unchanged (implicit continue). The LLM is consulted only when:
- No goal exists
- Goal has expired (maxMs elapsed)
- `_eventQueue` has a high-importance event (≥ 0.8)
- HP drops below 35%
- `_advanceGoal()` returns false (steps exhausted, non-repeating)

---

## Section 3: NPC-to-NPC Interaction

### Proximity Tracking

Add `_knownNearbyNpcIds = new Set()` to NPCBrain constructor. In `update()` after reflex check (throttled to every 2000ms, reuse `_lastReflexCheck` timing):

```js
// Check for NPCs entering/leaving range
const currentNearby = this._scene.getNearbyRemoteNpcs?.(npc, 6 * TILE_SIZE) ?? [];
const currentIds = new Set(currentNearby.map(n => n.id));
for (const n of currentNearby) {
  if (!this._knownNearbyNpcIds.has(n.id)) {
    const inCombat = this._scene._recentThreats?.[`npc:${n.id}`];
    this.pushEvent({
      type: inCombat ? 'npc_combat_nearby' : 'npc_nearby',
      text: `${n.name || n.id} is ${inCombat ? 'fighting' : 'nearby'}`,
      importance: inCombat ? 0.65 : 0.3,
    });
  }
}
this._knownNearbyNpcIds = currentIds;
```

### Greet Task

New `doGreetNpc(cmd)` in `SocialTaskHandler.js`:

1. If `!cmd.target` or target not found in `scene._remoteNPCSprites` → `tasks.shift(); return` (guard: target missing)
2. Move within 2 tiles of target NPC. If target leaves range (distance > 4 tiles after moving) → `tasks.shift(); return` (guard: target left)
3. Generate one greeting line via a stripped prompt (personality type + relationship label from `npc.soul.relationships["npc:${target.id}"]?.label ?? "stranger"`)
4. `npc.showBubble(line, 3000)` and `target.showBubble("...", 2000)` (target shows ellipsis, no LLM needed)
5. Apply ±0.05 trust delta to `npc.soul.relationships["npc:${target.id}"]` — positive if cooperation > 0.5, neutral otherwise
6. `npc.addMemory("greeted ${target.name}", "social", "npc:${target.id}")`
7. `tasks.shift()` — task complete

**NPCTaskRunner.js dispatch** — add to the switch statement:

```js
case 'greet_npc':
  this._social.doGreetNpc(cmd);
  break;
```

`cmd` is `tasks[0]` (the current task descriptor with `target` field). `SocialTaskHandler` already accesses `tasks[0]` directly for other methods — same pattern here.

### Combat Reactions

`npc_combat_nearby` (importance 0.65) triggers an LLM decision on the next cooldown. The state packet already includes `nearby_threats` and `npc_relationships`. No new logic needed — the existing event-triggered decision path handles it. Personality-appropriate responses (Berserker → attack, Paranoid → flee, Scout → observe) emerge naturally from the LLM with the existing prompt.

Note: `observe` maps to `{ task: 'idle' }` in `INTENT_TO_TASK` — the NPC will complete the idle step instantly and follow its next drive/goal. This is intentional: an NPC choosing to observe briefly pauses, then decides what to do next on its own initiative.

---

## Section 4: Unsupervised Background Work

### Client-Side Handoff

In `GameScene.js` map transition handler, before `register_background_npc` messages are sent:

```js
async _handoffNpcsToBackground(targetMap) {
  for (const [npcId, brain] of this._npcBrains) {
    const goal = await Promise.race([
      brain.makeBackgroundGoal(),
      new Promise(r => setTimeout(() => r(null), 5000)), // 5s timeout
    ]);
    const effectiveGoal = goal ?? brain._driveToBackgroundGoal();
    this._conn.send({
      type: 'register_background_npc',
      npc_id: npcId,
      map: this._currentMap,
      task: { task: effectiveGoal.steps[0] }, // backward compat — dict shape required by server
      goal: effectiveGoal,
      drives: { ...brain._npc.soul?.drives },
    });
  }
}
```

`_driveToBackgroundGoal()` (deterministic fallback on NPCBrain):

```js
_driveToBackgroundGoal() {
  const drives = this._npc.soul?.drives || {};
  const ranked = Object.entries(drives)
    .filter(([k]) => !k.startsWith('_'))
    .sort(([,a],[,b]) => b - a);
  const driveTaskMap = {
    greed: { intent: 'gather resources', steps: ['mine_ore', 'deposit_to_crate'], repeat: true },
    ambition: { intent: 'train skills', steps: ['train'], repeat: true },
    aggression: { intent: 'train combat', steps: ['train'], repeat: true },
  };
  for (const [drive] of ranked) {
    if (driveTaskMap[drive]) return { ...driveTaskMap[drive], startedAt: Date.now(), maxMs: 600000 };
  }
  return { intent: 'rest', steps: ['wander_explore'], repeat: false, startedAt: Date.now(), maxMs: 60000 };
}
```

**Note:** The existing `register_background_npc` handler checks `if npc_id and task` where `task` must be a dict with a `task` key (see input_handler.py line 353). The `task` field must always be sent as `{ task: steps[0] }` (a dict), not a bare string.

### Server-Side Changes

**`input_handler.py` — register handler** (add `goal` storage):

```python
elif msg_type == "register_background_npc":
    npc_id = data.get("npc_id")
    npc_map = data.get("map", "level_01")
    task = data.get("task", {})
    goal = data.get("goal")  # new field
    if npc_id and task:
        gs.background_npcs[npc_id] = {
            "pid": pid,
            "npc_id": npc_id,
            "map": npc_map,
            "task": task,
            "goal": goal,
            "_goal_step": 0,
            "_tick_count": 0,
            "_gathered": {},
            "_xp_gained": 0,
            "last_tick": time.time(),
        }
```

**`input_handler.py` — unregister handler** (add return briefing):

```python
elif msg_type == "unregister_background_npcs":
    target_map = data.get("map", "")
    removed = []
    for npc_id, bg in list(gs.background_npcs.items()):
        if bg["pid"] == pid and bg["map"] == target_map:
            removed.append(npc_id)
            del gs.background_npcs[npc_id]
            # Send return briefing to player's WebSocket
            ws = clients.get(pid)
            if ws and (bg.get("_gathered") or bg.get("_xp_gained")):
                import asyncio, json
                asyncio.ensure_future(ws.send_text(json.dumps({
                    "type": "bg_npc_return",
                    "npc_id": npc_id,
                    "summary": {
                        "goal_intent": bg.get("goal", {}).get("intent") if bg.get("goal") else None,
                        "ticks": bg.get("_tick_count", 0),
                        "gathered": bg.get("_gathered", {}),
                        "xp_gained": bg.get("_xp_gained", 0),
                    }
                })))
```

**Client receives `bg_npc_return`** in `GameScene.js` — add a `bg_npc_return` case alongside the existing `welcome` / `state` cases in the WebSocket `_onMessage()` handler. On receipt: look up the NPCBrain by `data.npc_id` from `this._npcBrains` and call `brain.pushEvent({ type: 'background_return', text: summarize(summary), importance: 0.4 })`.

### `_tick_background_npcs` Changes (npc_manager.py)

Add `_advance_bg_goal()` and call it when the current step completes:

```python
def _advance_bg_goal(self, bg):
    goal = bg.get("goal")
    if not goal:
        return False
    steps = goal.get("steps", [])
    if not steps:
        return False
    idx = bg.get("_goal_step", 0) + 1
    if idx >= len(steps):
        if goal.get("repeat"):
            idx = 0
        else:
            bg["task"] = None
            return False
    bg["_goal_step"] = idx
    bg["task"] = {"task": steps[idx]}
    return True
```

**Modified `_tick_background_npcs` dispatch** — call `_advance_bg_goal` when a task step finishes (inventory full triggers deposit → advance; mine finishes ore → advance):

```python
# After deposit completes or ore depleted:
if not self._advance_bg_goal(bg):
    pass  # goal exhausted, bg["task"] is now None — NPC idles until player returns
bg["_tick_count"] = bg.get("_tick_count", 0) + 1
```

### Extended Task Support

| Task | Server Simulation |
|------|-------------------|
| `mine_ore` | Already implemented |
| `deposit_to_crate` | Already implemented |
| `train` | `npc_stats["xp"] += npc_stats.get("level", 1) * 2` per tick; track in `bg["_xp_gained"]` |
| `wander_explore` | No-op tick — advances tick count only |
| `gather` | **Deferred** — tree instance access differs from ore. Implement in follow-up. |

`gather` is deferred because server-side tree state uses a different data structure than `WORLD_OBJECT_INSTANCES` used for ore. The goal fallback map uses `mine_ore` for greed-drive NPCs, so this does not block the feature.

---

## Integration Notes

- Drive decay (S1) is independently deployable — update DriveSystem.js and change the `applyTaskDecay` call in NPCBrain.js.
- Goal persistence (S2) is independently deployable — no dependency on S1 or S3.
- NPC-to-NPC interaction (S3) depends only on the `greet_npc` task being wired up, which is self-contained.
- Background work (S4) degrades gracefully: if the LLM call times out, `_driveToBackgroundGoal()` provides a fallback. If the goal field is absent from the server message, existing behavior (flat `task` field) is preserved.
- Goal persistence reduces LLM call frequency. NPCs with stable repeating goals may go 2+ minutes between LLM calls — this is intentional and improves Ollama performance.
- The `greet_npc` prompt must stay under ~300 tokens total to remain cheap. Personality type + relationship label only — no memories, no drives.
