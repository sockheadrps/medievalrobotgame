# NPCTaskRunner Sub-Split Plan

**Goal:** Split `src/systems/NPCTaskRunner.js` (2433 lines) into focused files by task category.

**When to execute:** After Plan 05 Tasks 5-7 are complete.

---

## Audit Findings

The dispatcher switch at line ~204 routes 20+ task types. Methods group naturally into five categories:

| Category | Task types | Methods (approx lines) |
|---|---|---|
| Gathering/Resources | `gather`, `give_logs`, `steal_logs`, `gather_stone`, `gather_all`, `pickup_stone`, `refine_stone`, `give_materials`, `mine_ore`, `deposit_to_crate` | L235–L489, L1068–L1137, L1322–L1519, L2050–L2347 (~900 lines) |
| Combat | `attack_nearest_enemy`, `attack_player`, `attack_npc`, `absorb_npc`, `defend_player`, `flee_player` | L616–L999, L850–L916 (~400 lines) |
| Ki/Training | `practice_ki`, `train` | L715–L759, L1696–L2049 (~600 lines) |
| Social/Exploration | `socialize_npc`, `wander_explore`, `custom_task` | L580–L615, L1138–L1321, L1521–L1685 (~400 lines) |
| Shared utilities | `_faceTarget`, `_npcFireKiBlast`, personality helpers, dispatcher | L1–L234, L1686–L1695, L2347–L2433 (~130 lines) |

---

## Proposed Split

- `src/systems/npc/GatherTaskHandler.js` — resource gathering: `gather`, `gather_stone`, `gather_all`, `give_logs`, `steal_logs`, `pickup_stone`, `refine_stone`, `give_materials`, `mine_ore`, `deposit_to_crate`
- `src/systems/npc/CombatTaskHandler.js` — combat/flee/absorb: `attack_nearest_enemy`, `attack_player`, `attack_npc`, `absorb_npc`, `defend_player`, `flee_player`
- `src/systems/npc/KiTaskHandler.js` — ki practice and training: `practice_ki`, `train`
- `src/systems/npc/SocialTaskHandler.js` — social/exploration/custom: `socialize_npc`, `wander_explore`, `follow`, `custom_task`
- `src/systems/NPCTaskRunner.js` (reduced) — constructor, `setTasks`, `update` dispatcher, personality helpers, shared utilities (`_faceTarget`, `_npcFireKiBlast`); delegates all task execution to handlers

---

## File Map

**Create:**
- `src/systems/npc/GatherTaskHandler.js`
- `src/systems/npc/CombatTaskHandler.js`
- `src/systems/npc/KiTaskHandler.js`
- `src/systems/npc/SocialTaskHandler.js`

**Modify:**
- `src/systems/NPCTaskRunner.js` — reduce to dispatcher (~150 lines); import and instantiate the four handlers; route switch cases to handler instances

---

## Handler Design Pattern

Each handler receives `(scene, npc, runner)` in its constructor, where `runner` is the `NPCTaskRunner` instance so handlers can call shared utilities like `_faceTarget`, read `_tasks`, `_state`, `_target`, etc.

```js
// Example handler skeleton
export class GatherTaskHandler {
  constructor(scene, npc, runner) {
    this._scene  = scene;
    this._npc    = npc;
    this._runner = runner;
  }
  doGather(delta)        { /* moved from NPCTaskRunner */ }
  doGiveLogs(delta)      { /* moved from NPCTaskRunner */ }
  // ...
}
```

NPCTaskRunner dispatcher becomes:

```js
case 'gather':           this._gather.doGather(delta); break;
case 'give_logs':        this._gather.doGiveLogs(delta); break;
case 'attack_nearest_enemy': this._combat.doAttack(delta); break;
// ...
```

---

## Tasks

### Task 1: Create `src/systems/npc/` directory and GatherTaskHandler

- [ ] Create `src/systems/npc/GatherTaskHandler.js`
- [ ] Move methods from NPCTaskRunner: `_doGather`, `_doGiveLogs`, `_doGatherStone`, `_doGatherAll`, `_doPickupStone`, `_doRefineStone` (and sub-methods `_refine_*`), `_doGiveMaterials`, `_doMineOre`, `_findCrateForResource`, `_doDepositToCrate`, `_doStealLogs`
- [ ] Rename methods: drop leading `_do` convention or keep it — keep `_do*` prefix for consistency
- [ ] Add handler import/instantiation to NPCTaskRunner constructor: `this._gather = new GatherTaskHandler(scene, npc, this)`
- [ ] Update dispatcher switch cases to call `this._gather.*`
- [ ] Run smoke test: NPC gather/mine tasks must still complete

### Task 2: Create CombatTaskHandler

- [ ] Create `src/systems/npc/CombatTaskHandler.js`
- [ ] Move methods: `_doAttack`, `_doAttackPlayer`, `_doAttackNPC`, `_doAbsorbNPC`, `_findNearestKnockedOutEnemyNpc`, `_doDefend`, `_doFleePlayer`
- [ ] Move combat-specific helpers: `_targetIsDown`, `_completeCombatTaskOnTargetDown`, `_pickAbsorbLine`, `_tryAbsorbKnockedOutNpc`
- [ ] Move combat constants: `ATTACK_RANGE`, `DEFEND_RANGE`, `ATTACK_COOLDOWN_BASE`
- [ ] Add handler: `this._combat = new CombatTaskHandler(scene, npc, this)`
- [ ] Update dispatcher switch cases
- [ ] Run smoke test: NPC attack/defend/flee must still work

### Task 3: Create KiTaskHandler

- [ ] Create `src/systems/npc/KiTaskHandler.js`
- [ ] Move methods: `_doPracticeKi`, `_doPracticeKi_watchAndLearn`, `_practiceKi_gather`, `_practiceKi_return`, `_practiceKi_build`, `_practiceKi_stepBack`, `_practiceKi_blast`, `_doTrain`
- [ ] Move ki helpers: `_findAndWatchKiTarget`, `_tryRangedKiBlast`, `_getKiShotUpgrade`, `_getKiBlastCooldownMs`, `_getKiBlastRange`, `_getKiBlastProjectileSpeed`, `_npcFireKiBlast`
- [ ] Move ki constants: `KI_BLAST_RANGE`, `KI_BLAST_COOLDOWN_BASE`
- [ ] Add handler: `this._ki = new KiTaskHandler(scene, npc, this)`
- [ ] Update dispatcher switch cases
- [ ] Run smoke test: NPC ki practice and training must still work

### Task 4: Create SocialTaskHandler

- [ ] Create `src/systems/npc/SocialTaskHandler.js`
- [ ] Move methods: `_doSocializeNPC`, `_decideNPCInteraction`, `_doWanderExplore`, `_doFollow`, `_doCustomTask`
- [ ] Add handler: `this._social = new SocialTaskHandler(scene, npc, this)`
- [ ] Update dispatcher switch cases
- [ ] Run smoke test: NPC follow, socialize, wander, and custom tasks must still work

### Task 5: Reduce NPCTaskRunner to dispatcher

- [ ] Verify NPCTaskRunner retains only: constructor, personality helpers (`_getFollowDist`, `_getFollowLeash`, `_getAttackCooldownMs`), `setTasks`, `update` (dispatcher), `_faceTarget`
- [ ] Confirm line count is under 200 lines
- [ ] Run full NPC smoke test across all task types

### Task 6: Verify 600-line gate

- [ ] Run `wc -l src/systems/NPCTaskRunner.js src/systems/npc/*.js`
- [ ] All files must be under 600 lines
- [ ] If any handler exceeds 600 lines, create a sub-split issue

---

## Notes

- `_chopCooldown`, `_mineCooldown`, `_attackCooldown`, `_kiBlastCooldown` live on the NPCTaskRunner instance; handlers access them via `this._runner._chopCooldown` etc. — consider moving relevant cooldowns to the owning handler after initial split
- `generateNPCChat` import (from `LLMClient.js`) is used in social tasks; move import to `SocialTaskHandler.js`
- Constants defined at top of file (`FOLLOW_DIST_BASE`, `FOLLOW_LEASH_BASE`, `ABSORB_DURATION_MS`, etc.) should migrate with the handler that uses them, or to a shared `src/systems/npc/npcConstants.js` if used across multiple handlers
