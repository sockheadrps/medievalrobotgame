# NPC Autonomy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make human-player NPCs feel alive — pursuing drives, reacting to environment, greeting each other, and working unsupervised while the player is away.

**Architecture:** Four independently deployable systems. Task 1 (drive decay) feeds Task 2 (reflex layer) which feeds Task 3 (goal persistence). Task 4 (background work) is server-side and standalone. All client-side changes are in NPCBrain/DriveSystem/TaskRunner. No external dependencies added.

**Tech Stack:** JavaScript (Phaser 3, ES modules), Python (FastAPI), existing Ollama prompt infrastructure.

---

## File Map

| File | Change |
|------|--------|
| `src/systems/DriveSystem.js` | Replace `TASK_DRIVE_AFFINITY` export with `DRIVE_TASK_SATISFACTION`; update `applyTaskDecay()` and `checkCompliance()` |
| `src/systems/NPCBrain.js` | Add `_goal`, `_lastReflexCheck`, `_knownNearbyNpcIds` to constructor; add `_reflexCheck()`, `_nearbyFriendlyNpc()`, `_advanceGoal()`, `_driveToBackgroundGoal()`, `makeBackgroundGoal()`; update `update()` and `_applyDecision()` |
| `src/systems/npc/NPCBrainData.js` | Add `current_goal` field to `buildStatePacket()` return value |
| `src/systems/npc/SocialTaskHandler.js` | Add `doGreetNpc(cmd)` method |
| `src/systems/NPCTaskRunner.js` | Add `greet_npc` case to switch; fix import from DriveSystem |
| `src/scenes/GameScene.js` | Replace `_registerBackgroundNPCs` body with async handoff; add `_onMessage` case for `bg_npc_return`; add `getNearestOre()`, `getNearestDummy()`, `getNearbyRemoteNpcs()` helpers |
| `auxserver/services/input_handler.py` | Add `goal` field to `register_background_npc` handler; add return briefing to `unregister_background_npcs` handler |
| `auxserver/services/npc_manager.py` | Add `_advance_bg_goal()`; update `_tick_background_npcs()` for `train`/`wander_explore` and goal advancement; add activity tracking |

---

## Task 1: Drive Decay — Replace TASK_DRIVE_AFFINITY

**Files:**
- Modify: `src/systems/DriveSystem.js:31-54` (TASK_DRIVE_AFFINITY constant)
- Modify: `src/systems/DriveSystem.js:253-262` (applyTaskDecay)
- Modify: `src/systems/DriveSystem.js:272` (checkCompliance)
- Modify: `src/systems/NPCBrain.js:13` (import)

- [ ] **Step 1: Replace the constant in DriveSystem.js**

In `src/systems/DriveSystem.js`, replace lines 31–54:

```js
// OLD:
export const TASK_DRIVE_AFFINITY = {
  gather:               'greed',
  // ... (entire block)
};

// NEW:
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

- [ ] **Step 2: Update applyTaskDecay() to iterate over the array**

Replace lines 253–262 in `src/systems/DriveSystem.js`:

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

- [ ] **Step 3: Update checkCompliance() to use first drive in array**

In `checkCompliance()` (line ~272), replace:
```js
const commandDrive = TASK_DRIVE_AFFINITY[commandTask];
```
With:
```js
const commandDrive = DRIVE_TASK_SATISFACTION[commandTask]?.[0] ?? null;
```

- [ ] **Step 4: Update NPCBrain.js import**

In `src/systems/NPCBrain.js` line 13, replace:
```js
import { DriveSystem, TASK_DRIVE_AFFINITY } from './DriveSystem.js';
```
With:
```js
import { DriveSystem, DRIVE_TASK_SATISFACTION } from './DriveSystem.js';
```

Then find any remaining uses of `TASK_DRIVE_AFFINITY` in NPCBrain.js and replace with `DRIVE_TASK_SATISFACTION[key]?.[0]`.

- [ ] **Step 5: Verify no broken references**

Search for remaining uses of `TASK_DRIVE_AFFINITY`:
```bash
grep -r "TASK_DRIVE_AFFINITY" src/
```
Expected: no matches (all references now use `DRIVE_TASK_SATISFACTION`).

- [ ] **Step 6: Manual test — load game, watch NPC mine ore**

Start the dev server. Load a save with an NPC near ore. Open DevTools console and watch for drive decay. After 10 seconds of mining, `drives.greed` should be decreasing. Open `/npc` dashboard and confirm drives panel shows decay.

- [ ] **Step 7: Commit**

```bash
git add src/systems/DriveSystem.js src/systems/NPCBrain.js
git commit -m "feat: replace TASK_DRIVE_AFFINITY with multi-drive DRIVE_TASK_SATISFACTION"
```

---

## Task 2: Scene Helpers for Reflex Layer

**Files:**
- Modify: `src/scenes/GameScene.js` (add helper methods)

These helpers are needed before the reflex layer can be wired into NPCBrain.

- [ ] **Step 1: Add getNearestOre() to GameScene**

Add this method to `GameScene.js` (near other entity-query helpers):

```js
/** Returns the nearest non-depleted world-object sprite within range, or null. */
getNearestOre(npc, rangeTiles = 8) {
  let best = null, bestDist = rangeTiles * TILE_SIZE;
  for (const [, wo] of Object.entries(this._worldObjSprites || {})) {
    if (!wo || wo._depleted) continue;
    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, wo.x, wo.y);
    if (dist < bestDist) { bestDist = dist; best = wo; }
  }
  return best;
}
```

- [ ] **Step 2: Add getNearestDummy() to GameScene**

```js
/** Returns the nearest living training dummy within range, or null. */
getNearestDummy(npc, rangeTiles = 8) {
  let best = null, bestDist = rangeTiles * TILE_SIZE;
  for (const dummy of (this.dummies ?? [])) {
    if (dummy.isDead?.()) continue;
    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, dummy.x, dummy.y);
    if (dist < bestDist) { bestDist = dist; best = dummy; }
  }
  return best;
}
```

- [ ] **Step 3: Add getNearbyRemoteNpcs() to GameScene**

```js
/** Returns array of remote NPC sprite entries within rangeTiles of npc. */
getNearbyRemoteNpcs(npc, rangePixels) {
  const result = [];
  for (const [, entry] of Object.entries(this._remoteNPCSprites || {})) {
    if (!entry?.sprite) continue;
    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, entry.sprite.x, entry.sprite.y);
    if (dist <= rangePixels) result.push(entry);
  }
  return result;
}
```

- [ ] **Step 4: Verify the helpers are callable**

Check that `this._worldObjSprites`, `this.dummies`, and `this._remoteNPCSprites` exist on GameScene.

```bash
grep -n "_worldObjSprites\|this\.dummies\|_remoteNPCSprites" src/scenes/GameScene.js | head -20
```

Adjust the property names in the helpers if they differ.

- [ ] **Step 5: Commit**

```bash
git add src/scenes/GameScene.js
git commit -m "feat: add getNearestOre/Dummy/NearbyRemoteNpcs helpers to GameScene"
```

---

## Task 3: Reflex Layer

**Files:**
- Modify: `src/systems/NPCBrain.js`

- [ ] **Step 1: Add fields to NPCBrain constructor**

In `NPCBrain.constructor()` (after `this._lastDriveIntent = null;` around line 87), add:
```js
this._lastReflexCheck = 0;
this._goal = null;          // goal persistence (Section 2 — initialized here, used in Task 4)
this._knownNearbyNpcIds = new Set(); // proximity tracking (Section 3 — initialized here)
```

- [ ] **Step 2: Add _nearbyFriendlyNpc() method**

Add this method to NPCBrain (after `_checkEmotionReactions`):

```js
/** Returns the nearest friendly remote NPC within 6 tiles, or null. */
_nearbyFriendlyNpc() {
  const npc = this._npc;
  const entries = this._scene.getNearbyRemoteNpcs?.(npc, 6 * TILE_SIZE) ?? [];
  let best = null, bestDist = Infinity;
  for (const entry of entries) {
    const sprite = entry.sprite;
    if (!sprite) continue;
    const threatKey = `npc:${entry.npcId}`;
    if (this._scene._recentThreats?.[threatKey]) continue;
    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, sprite.x, sprite.y);
    if (dist < bestDist) { bestDist = dist; best = entry; }
  }
  return best ? { id: `${best.ownerPid}_${best.npcId}`, sprite: best.sprite } : null;
}
```

- [ ] **Step 3: Add _reflexCheck() method**

Add after `_nearbyFriendlyNpc()`:

```js
/**
 * Check environmental triggers and fire a task if conditions match.
 * Returns true if a reflex fired (caller should skip rest of update).
 */
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

  // Ore nearby + high greed
  if ((drives.greed ?? 0) > 0.45) {
    const nearestOre = this._scene.getNearestOre?.(npc);
    if (nearestOre) {
      this._runner.setTasks([{ task: 'mine_ore' }]);
      return true;
    }
  }

  // Training dummy nearby + high ambition
  if ((drives.ambition ?? 0) > 0.50) {
    const nearDummy = this._scene.getNearestDummy?.(npc);
    if (nearDummy) {
      this._runner.setTasks([{ task: 'train' }]);
      return true;
    }
  }

  // Friendly NPC nearby + high social
  if ((drives.social ?? 0) > 0.45) {
    const friendly = this._nearbyFriendlyNpc();
    if (friendly) {
      this._runner.setTasks([{ task: 'greet_npc', target: friendly.id }]);
      return true;
    }
  }

  return false;
}
```

- [ ] **Step 4: Wire _reflexCheck into update()**

In `update()`, after the task decay block (after `DriveSystem.applyTaskDecay(...)`) and before the emotion reaction block, add:

```js
// ── Environmental reflex (throttled 2s) ──
if (now - this._lastReflexCheck > 2000) {
  this._lastReflexCheck = now;
  if (this._reflexCheck(status, now)) return;
}
```

- [ ] **Step 5: Manual test — verify survival reflex fires**

Load game with an NPC. Use DevTools to set `npc.hp = 5` on a low-max-hp NPC (or set it through the soul editor). The NPC should immediately switch to `follow` task. Confirm in console that `setTasks([{task:'follow'}])` is called.

- [ ] **Step 6: Manual test — verify ore reflex fires**

Stand near ore. Set `npc.soul.drives.greed = 0.8` in DevTools. Within 2 seconds the NPC should start `mine_ore`. Confirm drive value decays while mining.

- [ ] **Step 7: Commit**

```bash
git add src/systems/NPCBrain.js
git commit -m "feat: add environmental reflex layer to NPCBrain"
```

---

## Task 4: Goal Persistence

**Files:**
- Modify: `src/systems/NPCBrain.js`
- Modify: `src/systems/npc/NPCBrainData.js`

- [ ] **Step 1: Add _advanceGoal() to NPCBrain**

Add this method after `_reflexCheck()`:

```js
/**
 * Advance the active goal to its next step.
 * Returns true if a step was dispatched, false if goal is expired/exhausted.
 */
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

- [ ] **Step 2: Update update() — suppress drive switching while goal active**

In `update()`, find the drive-based silent task switching block (starts around line 241 with `const isManualLocked = ...`). Wrap the drive intent switching so it is skipped when a goal is active:

```js
const isManualLocked = this._npc._manualCommandUntil && now < this._npc._manualCommandUntil;
const isCommitLocked = (this._npc.soul?.drives?._commitUntil ?? 0) > now;

if (!isManualLocked && !isCommitLocked && !this._goal) {
  // Existing drive intent switching code (getDominantIntent, driveToTask, etc.)
  const dominantDrive = DriveSystem.getDominantIntent(this._npc, this._scene);
  // ... (keep existing code, just wrap it with !this._goal check above)
}
```

- [ ] **Step 3: Update update() — call _advanceGoal() in idle branch**

Find the idle/not-busy branch (around line 268, `const isBusy = status.running;`). In the block that checks `!isBusy`, call `_advanceGoal` before the LLM trigger logic:

```js
const isBusy = status.running;
if (!isBusy) {
  if (this._advanceGoal(now)) return; // goal has next step, skip LLM
  // ... existing idle refresh / LLM call logic continues
}
```

- [ ] **Step 4: Update _applyDecision() to store goal from LLM response**

In `_applyDecision(raw)`, after the intent application block, add goal storage. Find where `this._lastDecision = decision;` is set and add after it:

```js
// Store goal if LLM returned one
if (decision.goal && Array.isArray(decision.goal.steps) && decision.goal.steps.length > 0) {
  const ALLOWED_GOAL_TASKS = new Set([
    'mine_ore','gather','gather_stone','gather_all','deposit_to_crate',
    'train','practice_ki','wander_explore','follow','observe'
  ]);
  const validSteps = decision.goal.steps.filter(s => ALLOWED_GOAL_TASKS.has(s));
  if (validSteps.length > 0) {
    this._goal = {
      intent: decision.goal.intent || 'pursue goal',
      steps: validSteps,
      stepIndex: 0,
      repeat: !!decision.goal.repeat,
      startedAt: Date.now(),
      maxMs: decision.goal.maxMs ?? 120000,
    };
  }
} else if (decision.goal === null) {
  // LLM explicitly cleared the goal
  this._goal = null;
}
// If decision.goal is absent (undefined), leave existing goal unchanged
```

- [ ] **Step 5: Add current_goal to NPCBrainData.buildStatePacket()**

In `src/systems/npc/NPCBrainData.js`, find the return object of `buildStatePacket()` (around line 210). Add `current_goal` to the `npc` sub-object alongside `drives`:

```js
current_goal: this._brain._goal ? {
  intent: this._brain._goal.intent,
  current_step: this._brain._goal.steps[this._brain._goal.stepIndex],
  steps_remaining: this._brain._goal.steps.length - this._brain._goal.stepIndex,
  age_ms: Date.now() - this._brain._goal.startedAt,
} : null,
```

- [ ] **Step 6: Manual test — verify goal persistence**

In DevTools, after an NPC gets a decision, manually set:
```js
brain._goal = { intent: 'test', steps: ['mine_ore', 'deposit_to_crate'], stepIndex: 0, repeat: true, startedAt: Date.now(), maxMs: 120000 }
```
Watch the NPC: it should mine, then when mine_ore task completes (runner goes idle), it should advance to `deposit_to_crate`, then loop back to `mine_ore`. Confirm the LLM is NOT called during this cycle.

- [ ] **Step 7: Commit**

```bash
git add src/systems/NPCBrain.js src/systems/npc/NPCBrainData.js
git commit -m "feat: add goal persistence to NPCBrain — multi-step goals skip LLM between steps"
```

---

## Task 5: NPC-to-NPC Interaction (greet_npc task)

**Files:**
- Modify: `src/systems/npc/SocialTaskHandler.js`
- Modify: `src/systems/NPCTaskRunner.js`
- Modify: `src/systems/NPCBrain.js` (proximity tracking in update)

- [ ] **Step 1: Add doGreetNpc() to SocialTaskHandler**

Open `src/systems/npc/SocialTaskHandler.js`. Add this method (after `doSocializeNPC`):

```js
/**
 * Brief greeting between two NPCs.
 * cmd = tasks[0] with shape { task: 'greet_npc', target: 'ownerPid_npcId' }
 */
async doGreetNpc(cmd) {
  const npc = this._npc;
  const scene = this._scene;
  const targetKey = cmd.target;
  if (!targetKey) { this._tasks.shift(); return; }

  // Find the target sprite
  const entry = scene._remoteNPCSprites?.[targetKey]
    || Object.values(scene._remoteNPCSprites || {}).find(
        e => `${e.ownerPid}_${e.npcId}` === targetKey
      );
  if (!entry?.sprite) { this._tasks.shift(); return; }

  const targetSprite = entry.sprite;

  // Move within 2 tiles
  const targetX = targetSprite.x;
  const targetY = targetSprite.y;
  const dist = Phaser.Math.Distance.Between(npc.x, npc.y, targetX, targetY);
  if (dist > 2 * TILE_SIZE) {
    // Walk toward target
    scene.physics?.moveTo?.(npc, targetX, targetY, 80);
    // Check if target has wandered too far
    if (dist > 4 * TILE_SIZE) { this._tasks.shift(); return; }
    return; // still approaching
  }

  npc.stopMoving?.();

  // Generate greeting line — cheap prompt (personality + relationship only)
  const relKey = `npc:${entry.npcId}`;
  const relLabel = npc.soul?.relationships?.[relKey]?.label ?? 'stranger';
  const pType = npc.soul?.personality?.type ?? 'Pragmatist';
  let line = `Hey there!`; // fallback
  try {
    const { generateDecision } = await import('../../net/LLMClient.js');
    const resp = await Promise.race([
      generateDecision({
        type: 'greet_npc',
        personality: pType,
        relationship: relLabel,
        target_name: entry.npcId,
      }),
      new Promise(r => setTimeout(() => r(null), 3000)),
    ]);
    if (resp?.line) line = resp.line;
  } catch { /* use fallback */ }

  // Show speech bubbles
  npc.showBubble?.(line, 3000);
  targetSprite.showBubble?.('...', 2000);

  // Apply trust delta
  const rel = npc.soul?.relationships ?? {};
  if (!rel[relKey]) rel[relKey] = { label: 'stranger', trust: 0.5, cooperation: 0.5 };
  const coop = rel[relKey].cooperation ?? 0.5;
  rel[relKey].trust = Math.min(1, Math.max(0, (rel[relKey].trust ?? 0.5) + (coop > 0.5 ? 0.05 : 0)));
  npc.soul.relationships = rel;

  // Add memory
  npc.addMemory?.(`greeted ${entry.npcId}`, 'social', relKey);

  this._tasks.shift(); // task complete
}
```

Note: `SocialTaskHandler` needs `TILE_SIZE` imported if not already. Check existing imports at the top of the file — if missing, add:
```js
import { TILE_SIZE } from '../../constants.js';
```

- [ ] **Step 2: Add greet_npc case to NPCTaskRunner.js**

In `src/systems/NPCTaskRunner.js`, in the `update()` switch statement (after `case 'custom_task'`), add:

```js
case 'greet_npc':
  this._social.doGreetNpc(cmd);
  break;
```

Also update the supported tasks comment at the top of the file to include `greet_npc`.

- [ ] **Step 3: Add proximity tracking to NPCBrain.update()**

In `update()`, in the reflex throttle block (reuse the `_lastReflexCheck` timing), add proximity tracking alongside the reflex check:

```js
if (now - this._lastReflexCheck > 2000) {
  this._lastReflexCheck = now;

  // Proximity tracking — push events for NPCs entering range
  const currentNearby = this._scene.getNearbyRemoteNpcs?.(this._npc, 6 * TILE_SIZE) ?? [];
  const currentIds = new Set(currentNearby.map(e => `${e.ownerPid}_${e.npcId}`));
  for (const entry of currentNearby) {
    const eid = `${entry.ownerPid}_${entry.npcId}`;
    if (!this._knownNearbyNpcIds.has(eid)) {
      const inCombat = this._scene._recentThreats?.[`npc:${entry.npcId}`];
      this.pushEvent({
        type: inCombat ? 'npc_combat_nearby' : 'npc_nearby',
        text: `${entry.npcId} is ${inCombat ? 'fighting' : 'nearby'}`,
        importance: inCombat ? 0.65 : 0.3,
      });
    }
  }
  this._knownNearbyNpcIds = currentIds;

  if (this._reflexCheck(status, now)) return;
}
```

- [ ] **Step 4: Verify pushEvent exists on NPCBrain**

```bash
grep -n "pushEvent" src/systems/NPCBrain.js | head -5
```

If missing, add to NPCBrain:
```js
pushEvent(event) {
  this._eventQueue.push(event);
  this._recentEvents.push({ ...event, ts: Date.now() });
  if (this._recentEvents.length > 20) this._recentEvents.shift();
}
```

- [ ] **Step 5: Manual test — verify greet_npc fires**

Load a save with two players' NPCs visible. Set `brain._npc.soul.drives.social = 0.9` in DevTools. Within 2 seconds the reflex should fire `greet_npc`. NPC should walk toward the other NPC and show a speech bubble.

- [ ] **Step 6: Commit**

```bash
git add src/systems/npc/SocialTaskHandler.js src/systems/NPCTaskRunner.js src/systems/NPCBrain.js
git commit -m "feat: add greet_npc task and proximity event tracking for NPC-to-NPC interaction"
```

---

## Task 6: Background Work — Server Side

**Files:**
- Modify: `auxserver/services/input_handler.py`
- Modify: `auxserver/services/npc_manager.py`

- [ ] **Step 1: Update register_background_npc handler in input_handler.py**

Find the `register_background_npc` handler (around line 349). Replace the handler body to add `goal` storage and activity tracking:

```python
elif msg_type == "register_background_npc":
    npc_id = data.get("npc_id")
    npc_map = data.get("map", "level_01")
    task = data.get("task", {})
    goal = data.get("goal")  # new: multi-step goal
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
        logger.debug("Registered background NPC %s on %s: %s", npc_id, npc_map, task.get('task', '?'))
```

- [ ] **Step 2: Add return briefing to unregister_background_npcs handler**

Find the `unregister_background_npcs` handler (around line 363) in `auxserver/services/input_handler.py`. After `del gs.background_npcs[npc_id]`, add the return briefing send. (Note: the spec's file map also references `ws.py` for this, but the unregister message handler lives in `input_handler.py` per the spec's own code example — implement it here.)

```python
elif msg_type == "unregister_background_npcs":
    target_map = data.get("map", "")
    removed = []
    for npc_id, bg in list(gs.background_npcs.items()):
        if bg["pid"] == pid and bg["map"] == target_map:
            removed.append(npc_id)
            del gs.background_npcs[npc_id]
            # Send return briefing if NPC did anything
            ws = clients.get(pid)
            if ws and (bg.get("_gathered") or bg.get("_xp_gained")):
                import asyncio, json as _json
                asyncio.ensure_future(ws.send_text(_json.dumps({
                    "type": "bg_npc_return",
                    "npc_id": npc_id,
                    "summary": {
                        "goal_intent": bg.get("goal", {}).get("intent") if bg.get("goal") else None,
                        "ticks": bg.get("_tick_count", 0),
                        "gathered": bg.get("_gathered", {}),
                        "xp_gained": bg.get("_xp_gained", 0),
                    }
                })))
    # rest of existing handler (send removed list, etc.)
```

- [ ] **Step 3: Add _advance_bg_goal() to npc_manager.py**

In `auxserver/services/npc_manager.py` (inside the `NPCManager` class), add after `_bg_npc_deposit()`:

```python
def _advance_bg_goal(self, bg):
    """Advance background NPC to the next goal step. Returns True if advanced."""
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

- [ ] **Step 4: Update _tick_background_npcs() for goal advancement + new tasks**

In `_tick_background_npcs()`, find the existing `if task_type in ("custom_task", "mine_ore"):` block. Update to:

1. Track gathered items in `bg["_gathered"]`
2. After deposit completes, call `_advance_bg_goal(bg)`
3. Add `train` and `wander_explore` task handling:

```python
# After existing mine/deposit block, add:
elif task_type == "train":
    npc_stats = npc_state.setdefault("stats", {})
    xp_gain = npc_stats.get("level", 1) * 2
    npc_stats["xp"] = npc_stats.get("xp", 0) + xp_gain
    bg["_xp_gained"] = bg.get("_xp_gained", 0) + xp_gain
    bg["_tick_count"] = bg.get("_tick_count", 0) + 1
    # Advance goal after each train tick (train is a repeating action)
    self._advance_bg_goal(bg)

elif task_type == "wander_explore":
    # No-op — just count ticks
    bg["_tick_count"] = bg.get("_tick_count", 0) + 1
    self._advance_bg_goal(bg)
```

Also update the mining block to track gathered items:
```python
# After: npc_inv[drop.resource] = npc_inv.get(drop.resource, 0) + amount
bg.setdefault("_gathered", {})[drop.resource] = bg["_gathered"].get(drop.resource, 0) + amount
bg["_tick_count"] = bg.get("_tick_count", 0) + 1
```

**`_advance_bg_goal` must be called after every deposit completion** — not just the max-inventory branch. In `_tick_background_npcs`, update the deposit branch so `_advance_bg_goal` is always called after `_bg_npc_deposit` returns, regardless of why the deposit was triggered:

```python
if total_inv >= self.BG_NPC_MAX_INVENTORY:
    self._bg_npc_deposit(npc_state, npc_inv, task, npc_map)
    self._advance_bg_goal(bg)  # always advance after deposit — covers all exit paths
    continue
```

If `_bg_npc_deposit` can be called from other code paths in future, ensure `_advance_bg_goal` is called in each of those paths too. The intent is: any time a deposit step finishes, move to the next goal step.

- [ ] **Step 5: Verify server handles missing goal gracefully**

```bash
grep -n "_goal_step\|_advance_bg_goal\|_gathered\|_xp_gained" auxserver/services/npc_manager.py
```

Confirm all new fields use `.get()` with defaults so old background_npcs entries without them don't crash.

- [ ] **Step 6: Manual test — background NPC ticks**

Load game, let an NPC mine ore. Use the `/aip` or `/api/npc/debug` endpoint to confirm the NPC is registered as background when you change maps. Check `_tick_count` increments (restart server, check logs).

- [ ] **Step 7: Commit**

```bash
git add auxserver/services/input_handler.py auxserver/services/npc_manager.py
git commit -m "feat: background NPC goal advancement, train/wander support, return briefing"
```

---

## Task 7: Background Work — Client Handoff + Return Briefing

**Files:**
- Modify: `src/systems/NPCBrain.js` (add makeBackgroundGoal, _driveToBackgroundGoal)
- Modify: `src/scenes/GameScene.js` (update _registerBackgroundNPCs, handle bg_npc_return)

- [ ] **Step 1: Add _driveToBackgroundGoal() to NPCBrain**

```js
/** Deterministic fallback — picks background goal from dominant drive. */
_driveToBackgroundGoal() {
  const drives = this._npc.soul?.drives || {};
  const ranked = Object.entries(drives)
    .filter(([k]) => !k.startsWith('_'))
    .sort(([, a], [, b]) => b - a);
  const driveTaskMap = {
    greed:     { intent: 'gather resources', steps: ['mine_ore', 'deposit_to_crate'], repeat: true },
    ambition:  { intent: 'train skills',     steps: ['train'],                        repeat: true },
    aggression:{ intent: 'train combat',     steps: ['train'],                        repeat: true },
  };
  for (const [drive] of ranked) {
    if (driveTaskMap[drive]) {
      return { ...driveTaskMap[drive], startedAt: Date.now(), maxMs: 600000 };
    }
  }
  return { intent: 'rest', steps: ['wander_explore'], repeat: false, startedAt: Date.now(), maxMs: 60000 };
}
```

- [ ] **Step 2: Add makeBackgroundGoal() to NPCBrain**

```js
/**
 * Ask LLM for a background goal for this NPC. Returns a goal object or null.
 * Caller should use _driveToBackgroundGoal() as fallback on null/timeout.
 */
async makeBackgroundGoal() {
  try {
    const { generateDecision } = await import('../net/LLMClient.js');
    const packet = this._buildStatePacket();
    packet._context = 'background_goal'; // hint to prompt builder
    const resp = await generateDecision(packet);
    if (resp?.goal && Array.isArray(resp.goal.steps) && resp.goal.steps.length > 0) {
      return { ...resp.goal, startedAt: Date.now(), maxMs: resp.goal.maxMs ?? 600000 };
    }
  } catch { /* fall through */ }
  return null;
}
```

- [ ] **Step 3: Replace _registerBackgroundNPCs in GameScene.js**

Find `_registerBackgroundNPCs(oldMap, newMap)` (around line 838). Replace with the async version:

```js
async _registerBackgroundNPCs(oldMap, newMap) {
  const conn = this._conn;
  if (!conn?.connected) return;
  for (const npc of this.entities.npcs) {
    const npcMap = npc._map || oldMap;
    if (npcMap === newMap) continue; // NPC comes with us
    const runner = this._taskRunners.get(npc.id);
    const brain  = this._npcBrains?.get(npc.id);
    if (!runner) continue;

    // Ask LLM for goal with 5s timeout, fall back to drive-based
    let goal = null;
    if (brain) {
      goal = await Promise.race([
        brain.makeBackgroundGoal(),
        new Promise(r => setTimeout(() => r(null), 5000)),
      ]);
      if (!goal) goal = brain._driveToBackgroundGoal();
    } else {
      // No brain — fall back to current task if eligible
      const status = runner.getStatus();
      const task = status.tasks[0];
      if (!status.running || !task) continue;
      if (!['custom_task', 'mine_ore', 'gather'].includes(task.task)) continue;
    }

    const effectiveTask = goal
      ? { task: goal.steps[0] }
      : (runner.getStatus().tasks[0] || { task: 'mine_ore' });

    conn.send({
      type: 'register_background_npc',
      npc_id: npc.id,
      map: npcMap,
      task: effectiveTask,
      goal: goal ?? undefined,
      drives: npc.soul?.drives ? { ...npc.soul.drives } : undefined,
    });
  }
}
```

Check if `_npcBrains` is the Map name used in GameScene for brains. If it differs, grep:
```bash
grep -n "_npcBrains\|npcBrains" src/scenes/GameScene.js | head -10
```
Adjust the property name accordingly.

- [ ] **Step 4: Handle bg_npc_return in GameScene._onMessage()**

Find the `_onMessage(data)` handler in GameScene.js. Add a new case alongside `welcome`, `state`, etc.:

```js
case 'bg_npc_return': {
  const brain = this._npcBrains?.get(data.npc_id);
  if (brain && data.summary) {
    const { goal_intent, ticks, gathered, xp_gained } = data.summary;
    const parts = [];
    if (goal_intent) parts.push(goal_intent);
    if (xp_gained > 0) parts.push(`gained ${xp_gained} XP`);
    const gatherStr = Object.entries(gathered || {})
      .map(([k, v]) => `${v} ${k}`).join(', ');
    if (gatherStr) parts.push(`gathered ${gatherStr}`);
    const text = parts.length > 0 ? parts.join('; ') : 'returned from background';
    brain.pushEvent({ type: 'background_return', text, importance: 0.4 });
  }
  break;
}
```

- [ ] **Step 5: Verify _registerBackgroundNPCs caller passes correct signature**

The caller in `_mapManager` or `GameScene` calls `_registerBackgroundNPCs(oldMap, newMap)`. Since it's now async, find the call site and make sure it's awaited or the return value is at least not being used synchronously. Grep:

```bash
grep -n "_registerBackgroundNPCs" src/scenes/GameScene.js
```

If called without `await`, either `await` it or wrap: `this._registerBackgroundNPCs(oldMap, newMap).catch(console.error)`.

- [ ] **Step 6: Manual test — background goal handoff**

1. Stand on level_01 with an NPC that has mines nearby.
2. Change map. Check server logs — should see `Registered background NPC ... mine_ore` (or `train` if ambition is highest drive).
3. Change map back. Watch DevTools console for `bg_npc_return` message. The NPC's event queue should get a `background_return` event.

- [ ] **Step 7: Commit**

```bash
git add src/systems/NPCBrain.js src/scenes/GameScene.js
git commit -m "feat: async background NPC handoff with LLM goal selection and return briefing"
```

---

## Task 8: Final Integration Check

- [ ] **Step 1: Confirm imports are clean**

```bash
grep -rn "TASK_DRIVE_AFFINITY" src/
```
Expected: 0 matches. If any remain, replace with `DRIVE_TASK_SATISFACTION[key]?.[0]`.

- [ ] **Step 2: Confirm no console errors on load**

Load the game in browser. Open DevTools console. Confirm no `TypeError` or `Cannot read properties of undefined` errors on NPC update tick.

- [ ] **Step 3: Run through all 4 systems manually**

| System | Check |
|--------|-------|
| Drive decay | Set `drives.greed = 0.9`, watch mining, confirm greed drops |
| Reflex layer | Set `hp = 5` on NPC, confirm immediate `follow` |
| Goal persistence | Manually set `brain._goal = {...}`, confirm LLM not called between steps |
| NPC greeting | Set `drives.social = 0.9`, confirm `greet_npc` fires toward nearby NPC |
| Background work | Change map, change back, confirm `bg_npc_return` event in console |

- [ ] **Step 4: Check /npc dashboard**

Open `/npc` in browser. Select a player. Confirm:
- Drives panel shows current values
- `current_goal` appears in state when goal is active (visible in raw JSON if dashboard renders it)

- [ ] **Step 5: Final commit if any cleanup needed**

```bash
git add -p  # stage only intentional changes
git commit -m "chore: npc autonomy integration cleanup"
```

---

## Notes for Implementer

- **No tests in this codebase** — manual verification is the only test path. Each task has explicit manual steps.
- **`_remoteNPCSprites` structure**: values are objects with `{ sprite, ownerPid, npcId }`. The composite key in `_reflexCheck` and `doGreetNpc` is `${ownerPid}_${npcId}`.
- **LLM greet_npc prompt**: the existing `generateDecision()` in LLMClient.js handles arbitrary packet shapes — the `greet_npc` packet with `type: 'greet_npc'` may need a matching prompt template. If `generateDecision` returns null for this packet type, use the hardcoded fallback `"Hey there!"` — the task still completes.
- **Goal step tasks**: Only `mine_ore`, `gather`, `gather_stone`, `gather_all`, `deposit_to_crate`, `train`, `practice_ki`, `wander_explore`, `follow`, `observe` are safe as goal steps (parameterless). Never put `socialize_npc`, `greet_npc`, or `attack_*` in steps[].
- **Backward compat**: `register_background_npc` messages without the `goal` field still work — the server handler uses `.get("goal")` which returns None, and the tick loop falls back to the flat `task` field.
