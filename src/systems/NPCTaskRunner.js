// NPCTaskRunner — interprets a JSON task list from the LLM and drives an NPC.
//
// One-shot tasks (run once and advance):
//   { task: "gather",  item: "wood"|"ore" }
//   { task: "deposit", target: "crate", item: "wood", amount: n|"all" }
//   { task: "fill",    target: "furnace", item: "wood"|"iron", amount: n|"all" }
//   { task: "smelt" }   — wait near furnace until done
//   { task: "follow" }  — follow player (never completes, stays until replaced)
//   { task: "idle" }    — stop
//
// Looping task (evaluates world state each tick, repeats forever):
//   { task: "loop", goals: [ ...goal objects ] }
//
// Goal objects inside a loop:
//   { goal: "fill_furnace_wood", threshold: 5 }   — keep furnace wood above threshold
//   { goal: "deposit_extra",     item: "Wood" }    — dump surplus NPC inv into crate
//   { goal: "gather",            item: "wood" }    — gather if NPC has none

import Phaser from 'phaser';
import { TILE_SIZE, INTERACT_DIST } from '../constants.js';

const LOOP_DELAY_MS    = 200;
const FURNACE_LOW_WOOD = 4;   // below this, NPC prioritises refuelling
const CRANK_DIST       = TILE_SIZE * 1.2; // must be this close to actually crank (≈58px, < 1.5 tiles)

export class NPCTaskRunner {
  constructor(scene, npc) {
    this._scene = scene;
    this._npc   = npc;
    npc.taskRunner = this;

    this._queue            = [];
    this._running          = false;
    this._timer            = null;
    this._activeFlywheel   = null; // flywheel the NPC is currently cranking
    this._activeGoalIndex  = -1;   // which goal inside a loop is executing this tick
    this._activeScriptLineIndex = -1; // active line index in script_loop
    this._scriptTaskRef = null;
  }

  /** Replace the current task queue and start executing. */
  setTasks(tasks) {
    // Cancel any in-progress movement
    if (this._timer) { this._timer.remove(); this._timer = null; }
    this._npc.stopMoving();
    this._running = false;

    this._queue = [...tasks];
    this._activeGoalIndex = -1;
    this._activeScriptLineIndex = -1;
    this._scriptTaskRef = null;
    if (this._queue.length > 0) this._startLoop();
  }

  /**
   * Add a task to the queue (front by default) and ensure execution starts.
   * Used by scene-level reactive systems (encounters, hostility, auto-defend).
   * @param {object} task
   * @param {{ front?: boolean }} [opts]
   */
  pushTask(task, opts = {}) {
    if (!task || typeof task !== 'object') return;
    const front = opts.front !== false;

    const head = this._queue[0];
    if (front && head?.task === task.task) {
      if (task.task !== 'attack_nearest_enemy' || head.target === task.target) return;
    }

    if (front) this._queue.unshift(task);
    else this._queue.push(task);

    if (this._timer) { this._timer.remove(); this._timer = null; }
    if (!this._running) this._running = true;
    this._tick();
  }

  /**
   * Interrupt current work with a one-shot combat task, then resume.
   * If the NPC is already executing a combat task, this is a no-op.
   */
  interruptWithCombat() {
    // Don't stack combat tasks
    const front = this._queue[0];
    if (front?.task === 'attack_nearest_enemy') return;

    // Pause the current timer
    if (this._timer) { this._timer.remove(); this._timer = null; }
    this._npc.stopMoving();

    // Push combat task to front; it will return true once no enemies remain,
    // which pops it and the original queue resumes naturally.
    this._queue.unshift({ task: 'attack_nearest_enemy', range: TILE_SIZE * 8 });

    // Restart the tick loop
    if (!this._running) this._running = true;
    this._tick();
  }

  /** Cancel everything. */
  stop() {
    this._queue   = [];
    this._running = false;
    if (this._timer) { this._timer.remove(); this._timer = null; }
    this._npc.stopMoving();
    if (this._activeFlywheel) {
      this._activeFlywheel.stopCrank();
      this._activeFlywheel = null;
    }
    this._activeGoalIndex = -1;
    this._activeScriptLineIndex = -1;
    this._scriptTaskRef = null;
  }

  // ── Engine ─────────────────────────────────────────────────────────────────

  _startLoop() {
    this._running = true;
    this._tick();
  }

  _tick() {
    if (!this._running || this._queue.length === 0) {
      this._running = false;
      return;
    }

    const task = this._queue[0];
    const done = this._executeStep(task);

    const isLoop = task.task === 'loop' || task.task === 'script_loop';
    if (done === true) {
      if (!isLoop) this._queue.shift(); // loop tasks never get removed on completion
      this._timer = this._scene.time.delayedCall(LOOP_DELAY_MS, () => this._tick());
    } else if (done === false) {
      this._timer = this._scene.time.delayedCall(LOOP_DELAY_MS, () => this._tick());
    }
    // 'async' — moveTo callback will call _tick() when NPC arrives
  }

  // ── Dispatch ───────────────────────────────────────────────────────────────

  _executeStep(task) {
    switch (task.task) {
      case 'gather':  return this._stepGather(task);
      case 'deposit': return this._stepDeposit(task);
      case 'fill':    return this._stepFill(task);
      case 'smelt':   return this._stepSmelt(task);
      case 'follow':  return this._stepFollow();
      case 'crank':   return this._stepCrank(task);
      case 'attack':             return this._stepAttack(task);
      case 'attack_nearest_enemy': return this._stepAttackNearestEnemy(task);
      case 'patrol_area':        return this._stepPatrol(task);
      case 'defend_player':      return this._stepDefendPlayer(task);
      case 'defend_location':    return this._stepDefendLocation(task);
      case 'fletch':             return this._stepFletch(task);
      case 'hunt_chickens':      return this._stepHuntChickens(task);
      case 'gather_wood_qty':    return this._stepGatherWoodQty(task);
      case 'fetch_from_crate':   return this._stepFetchFromCrate(task);
      case 'deposit_to_crate':   return this._stepDepositToCrate(task);
      case 'craft_arrows_qty':   return this._stepCraftArrowsQty(task);
      case 'smith_arrowheads':   return this._stepSmithArrowheads(task);
      case 'loop':    return this._stepLoop(task);
      case 'script_loop': return this._stepScriptLoop(task);
      case 'idle':
      default:
        this._npc.stopMoving();
        return true;
    }
  }

  // ── loop ───────────────────────────────────────────────────────────────────
  // Evaluates a priority-ordered list of goals; executes the first one that
  // applies, then returns false so the loop task is re-evaluated next tick.

  _stepLoop(task) {
    const goals = task.goals ?? [];
    this._activeGoalIndex = -1;
    for (let i = 0; i < goals.length; i++) {
      const result = this._evalGoal(goals[i]);
      if (result !== null) {
        this._activeGoalIndex = i;
        return result; // a goal is active — let it run
      }
    }
    // No goal active this tick — idle in place
    this._npc.stopMoving();
    return false;
  }

  _stepScriptLoop(task) {
    const lines = task.lines ?? [];
    if (lines.length === 0) {
      this._activeScriptLineIndex = -1;
      this._npc.stopMoving();
      return false;
    }

    if (this._scriptTaskRef !== task) {
      this._scriptTaskRef = task;
      this._activeScriptLineIndex = 0;
    }
    if (this._activeScriptLineIndex < 0 || this._activeScriptLineIndex >= lines.length) {
      this._activeScriptLineIndex = 0;
    }

    const idx = this._activeScriptLineIndex;
    const line = lines[idx];
    if (!line) return false;

    const untilMet = this._evalLineUntil(line.until);
    if (untilMet) {
      this._activeScriptLineIndex = (idx + 1) % lines.length;
      this._npc.stopMoving();
      return false;
    }

    const result = this._stepScriptLineAction(line);

    // If no "until" condition is enabled for this line, treat it as a one-shot:
    // advance to the next line once this action reports completion.
    if (!line.until?.enabled && result === true) {
      this._activeScriptLineIndex = (idx + 1) % lines.length;
      this._npc.stopMoving();
      return false;
    }

    return result;
  }

  _stepScriptLineAction(line) {
    switch (line.action) {
      case 'gather':
        return this._stepGather({ task: 'gather', item: line.item ?? 'wood' });
      case 'deposit':
        return this._stepDeposit({ task: 'deposit', target: 'crate', item: line.item ?? 'Wood', amount: 'all' });
      case 'withdraw':
        return this._stepFetchFromCrate({ task: 'fetch_from_crate', item: line.item ?? 'Wood', qty: Number(line.qty ?? 1) });
      case 'maintain':
        return this._stepMaintainFurnaceWood({
          threshold: Number(line.threshold ?? FURNACE_LOW_WOOD),
          reserveQty: Number(line.reserveQty ?? 1),
        });
      case 'maintain_flywheels':
        return this._stepMaintainFlywheels({ low: Number(line.low ?? 20) });
      case 'smelt':
        return this._stepSmelt({});
      case 'attack_nearest_enemy':
        return this._stepAttackNearestEnemy({ task: 'attack_nearest_enemy', range: line.range ?? TILE_SIZE * 10 });
      case 'follow':
        return this._stepFollow();
      default:
        return true;
    }
  }

  _evalLineUntil(until) {
    if (!until?.enabled) return false;
    const conditions = until.conditions ?? [];
    if (conditions.length === 0) return false;
    const values = conditions.map(c => this._evalUntilCondition(c));
    if ((until.op ?? 'and') === 'or') return values.some(Boolean);
    return values.every(Boolean);
  }

  _evalUntilCondition(c) {
    const item = this._capitalize(c?.item ?? 'Wood');
    const qty = Math.max(0, Number(c?.qty ?? 1));
    const kind = c?.kind ?? 'inv_gte';
    if (kind === 'inv_gte') {
      return this._npc.getItem(item) >= qty;
    }

    const type = c?.targetType ?? 'crate';
    const source = type === 'crate'
      ? (this._scene.crates ?? [])
      : (type === 'furnace' ? (this._scene.furnaces ?? []) : (this._scene.flywheels ?? []));
    const target = this._assignedOrNearest(type, source);
    const have = this._objectItemAmount(target, item, type);
    if (kind === 'target_lte') return have <= qty;
    if (kind === 'target_gte') return have >= qty;
    return false;
  }

  _objectItemAmount(target, itemKey, type = 'crate') {
    if (!target) return 0;
    if (type === 'flywheel') return target.getMomentum?.() ?? 0;
    if (target._stored) return target._stored[itemKey] ?? 0;
    if (typeof target.getStored === 'function') {
      const stored = target.getStored();
      return stored?.[itemKey] ?? 0;
    }
    return 0;
  }

  _evalGoal(g) {
    switch (g.goal) {

      case 'fill_furnace_wood': {
        return this._stepMaintainFurnaceWood(g, true);
      }

      case 'deposit_extra': {
        // If NPC is carrying anything, deposit it in a crate
        const item = this._capitalize(g.item ?? 'Wood');
        if (this._npc.getItem(item) <= 0) return null;
        return this._stepDeposit({ task: 'deposit', target: 'crate', item, amount: 'all' });
      }

      case 'maintain_inventory': {
        const item = this._capitalize(g.item ?? 'Wood');
        const minQty = Math.max(0, Number(g.minQty ?? g.qty ?? 1));
        const have = this._npc.getItem(item);
        if (have < minQty) {
          return this._stepFetchFromCrate({
            task: 'fetch_from_crate',
            item,
            qty: minQty - have,
          });
        }
        if (have > minQty) {
          return this._stepDeposit({
            task: 'deposit',
            target: 'crate',
            item,
            amount: have - minQty,
          });
        }
        return null;
      }

      case 'gather': {
        // Gather if NPC is carrying none
        const item = (g.item ?? 'wood').toLowerCase();
        const resKey = this._capitalize(item);
        if (this._npc.getItem(resKey) > 0) return null;
        return this._stepGather({ task: 'gather', item });
      }

      case 'gather_from_rocks': {
        // Mine assigned rocks until carrying targetQty, then signal done.
        // If no specific oreResKey given, infer from assigned mine_rocks.
        const targetQty = g.targetQty ?? (this._npc.upgrades?.carryCapacity ?? 10);
        const oreKey    = g.oreResKey ?? null; // null → infer from assigned rocks
        // Resolve the actual resource key to check inventory
        const resolvedKey = oreKey ?? (this._npc.assignedTargets?.mine_rocks?.[0]?.rockType ?? null);
        if (!resolvedKey) return null;
        if (this._npc.getItem(resolvedKey) >= targetQty) return null; // have enough — skip
        return this._stepMineRock(oreKey, targetQty);
      }

      case 'deposit_ore': {
        // Deposit ore from NPC inventory into the correct crate.
        // If crateOreMap is set, each ore type routes to its specific crate.
        // Otherwise all go to the first assigned crate (or nearest).
        const ORE_TYPES = ['CopperOre', 'TinOre', 'GoldOre', 'Coal', 'Ore'];
        // Find all ore types the NPC is carrying
        const carrying = ORE_TYPES.filter(k => this._npc.getItem(k) > 0);
        if (carrying.length === 0) return null;

        // Deposit one ore type per invocation (first found); loop will re-run for others
        const oreKey = g.oreResKey
          ? (this._npc.getItem(g.oreResKey) > 0 ? g.oreResKey : null)
          : carrying[0];
        if (!oreKey) return null;

        const crate = this._crateForOre(oreKey);
        return this._stepDeposit({ task: 'deposit', target: 'crate', item: oreKey, amount: 'all', _crateObj: crate });
      }

      case 'crank_flywheel': {
        // Keep flywheel(s) charged — commit to one flywheel at a time to avoid flip-flopping.
        //
        // Thresholds (all % of max momentum):
        //   target   = charge current flywheel up to this before considering done   (default 80)
        //   critical = another flywheel this low triggers an urgent switch           (default 15)
        //   safe     = only switch away when the current flywheel is above this      (default 40)
        //   low      = any flywheel below this needs attention at all                (default 20)
        const assignedFws = this._npc.assignedTargets?.flywheels ?? [];
        const pool = assignedFws.length > 0 ? assignedFws : (this._scene.flywheels ?? []);
        if (pool.length === 0) return null;

        const targetFull  = g.target   ?? 80;   // charge to this before moving on
        const criticalLow = g.critical ?? 15;    // another flywheel this low → urgent switch
        const safeToLeave = g.safe     ?? 40;    // only leave if current is above this
        const lowThresh   = g.low      ?? 20;    // below this = needs attention

        const current = this._activeFlywheel && pool.includes(this._activeFlywheel)
          ? this._activeFlywheel : null;
        const currentMom = current ? current.getMomentum() : -1;

        // --- Decide which flywheel to target this tick ---
        let target = current; // default: stick with what we have

        if (!target) {
          // No current target — pick the one that needs it most (lowest momentum)
          const needy = pool.filter(fw => fw.getMomentum() < lowThresh);
          target = needy.length > 0
            ? needy.reduce((a, b) => a.getMomentum() < b.getMomentum() ? a : b)
            : null;
        } else if (currentMom >= targetFull) {
          // Current flywheel is fully charged — find any other that needs attention
          const needy = pool.filter(fw => fw !== current && fw.getMomentum() < lowThresh);
          target = needy.length > 0
            ? needy.reduce((a, b) => a.getMomentum() < b.getMomentum() ? a : b)
            : null; // all fine — nothing to do
        } else {
          // Still charging current — only switch if another is critically low AND we're safe to leave
          if (currentMom >= safeToLeave) {
            const urgent = pool.filter(fw => fw !== current && fw.getMomentum() < criticalLow);
            if (urgent.length > 0) {
              target = urgent.reduce((a, b) => a.getMomentum() < b.getMomentum() ? a : b);
            }
          }
          // else: current is below safeToLeave — stay no matter what
        }

        if (!target) return null; // all flywheels are fine
        return this._stepCrankFlywheel(target, targetFull);
      }

      // ── Arrow-making workflow goals ────────────────────────────────────────
      // These work as a priority-ordered sequence inside a loop task:
      //   hunt → gather wood → fetch heads → craft → deposit → repeat
      // While waiting for chickens to respawn, wood and arrowhead gathering
      // are allowed to proceed so the NPC isn't idle.

      case 'hunt_for_feathers': {
        const targetQty = g.targetQty ?? 10;
        if (this._npc.getItem('Feather') >= targetQty) return null; // have enough — skip
        const chickens = (this._scene.chickens ?? []).filter(c => !c.isDead());
        if (chickens.length === 0) return null; // no chickens alive — skip, let other goals run
        return this._stepHuntChickens({ task: 'hunt_chickens', item: 'Feather', targetQty });
      }

      case 'gather_wood_for_arrows': {
        const targetQty   = g.targetQty   ?? 10;
        const featherQty  = g.featherQty  ?? 10;
        if (this._npc.getItem('Wood')  >= targetQty)      return null; // have enough — skip
        if (this._npc.getItem('Arrow') >= (g.qty ?? 10))  return null; // crafting done — skip
        // Gather if we have feathers OR if no chickens are alive (use waiting time productively)
        const hasFeathers = this._npc.getItem('Feather') >= featherQty;
        const noChickens  = (this._scene.chickens ?? []).filter(c => !c.isDead()).length === 0;
        if (!hasFeathers && !noChickens) return null; // chickens alive, go hunt first
        return this._stepGatherWoodQty({ task: 'gather_wood_qty', targetQty });
      }

      case 'smith_arrowheads': {
        // If crate has no arrowheads, fetch iron bars and smith them at the anvil.
        const arrowheadQty = g.arrowheadQty ?? 10;
        const ironQty      = g.ironQty      ?? 10; // iron bars to fetch (10 bars → 30 arrowheads)
        const targetHeads  = g.targetHeads  ?? 30; // smith until NPC holds this many arrowheads
        if (this._npc.getItem('Arrow') >= (g.qty ?? 10)) return null; // already crafted enough
        if (this._npc.getItem('IronArrowhead') >= arrowheadQty) return null; // have enough already
        // Check if crate has arrowheads — if so, skip this goal (fetch_arrowheads will grab them)
        const crate = this._assignedOrNearest('crate', this._scene.crates ?? []);
        if (crate && (crate._stored?.['IronArrowhead'] ?? 0) >= arrowheadQty) return null;
        // Need to smith — fetch iron bars first if we don't have them
        const haveIron = this._npc.getItem('IronBar');
        if (haveIron < 1) {
          return this._stepFetchFromCrate({ task: 'fetch_from_crate', item: 'IronBar', qty: ironQty });
        }
        return this._stepSmithArrowheads({ task: 'smith_arrowheads', targetHeads });
      }

      case 'fetch_arrowheads': {
        const qty        = g.qty        ?? 10;
        const featherQty = g.featherQty ?? 10;
        const woodQty    = g.woodQty    ?? 10;
        if (this._npc.getItem('IronArrowhead') >= qty) return null; // already have them
        if (this._npc.getItem('Arrow')         >= qty) return null; // crafting done
        // Fetch if we have feathers+wood, OR if blocked on feathers with no chickens alive
        const hasFeathers = this._npc.getItem('Feather') >= featherQty;
        const hasWood     = this._npc.getItem('Wood')    >= woodQty;
        const noChickens  = (this._scene.chickens ?? []).filter(c => !c.isDead()).length === 0;
        if (!hasFeathers && !noChickens) return null; // chickens alive, go hunt first
        if (!hasWood) return null; // still need wood — gather_wood_for_arrows handles that
        // Only fetch from crate if crate actually has some; otherwise smith_arrowheads handles it
        const crate2 = this._assignedOrNearest('crate', this._scene.crates ?? []);
        if (crate2 && (crate2._stored?.['IronArrowhead'] ?? 0) < 1) return null;
        return this._stepFetchFromCrate({ task: 'fetch_from_crate', item: 'IronArrowhead', qty });
      }

      case 'craft_arrows': {
        const qty     = g.qty ?? 10;
        const arrows  = this._npc.getItem('Arrow');
        const canCraft = this._npc.getItem('Feather') >= 2
                      && this._npc.getItem('Wood')    >= 1
                      && this._npc.getItem('IronArrowhead') >= 1;

        if (arrows >= qty) return null;       // hit target — go deposit
        if (!canCraft && arrows === 0) return null; // nothing crafted, nothing to work with — skip
        if (!canCraft) return null;            // out of materials mid-batch — let deposit handle what we have
        return this._stepCraftArrowsQty({ task: 'craft_arrows_qty', qty });
      }

      case 'deposit_arrows': {
        // Deposit any arrows the NPC is carrying, regardless of whether it hit the full qty target
        if (this._npc.getItem('Arrow') <= 0) return null;
        return this._stepDepositToCrate({ task: 'deposit_to_crate', item: 'Arrow' });
      }

      case 'fletch_arrow': {
        // Fletch arrows using NPC's own inventory if it has materials.
        const inv = this._npcInventoryShim();
        const ss  = this._scene.skillSystem;
        if (!ss) return null;
        // Check materials
        const hasWood     = this._npc.getItem('Wood')          >= 1;
        const hasFeather  = this._npc.getItem('Feather')       >= 2;
        const hasHead     = this._npc.getItem('IronArrowhead') >= 1;
        if (!hasWood || !hasFeather || !hasHead) return null; // nothing to do
        return this._stepFletch({ task: 'fletch', skillId: 'fletching', recipeId: 'fletch_arrow' });
      }

      case 'attack_chicken': {
        const chickens = (this._scene.chickens ?? []).filter(c => !c.isDead());
        if (chickens.length === 0) return null;
        const target = this._nearest(chickens);
        if (!target) return null;
        return this._stepAttack({ task: 'attack', target: target });
      }

      case 'attack_nearest_enemy': {
        // Attack nearest enemy if one is in range
        const range   = g.range ?? TILE_SIZE * 10;
        const enemies = (this._scene.enemies ?? []).filter(e => !e.isDead() && this._isCombatTarget(e));
        if (enemies.length === 0) return null;
        const enemy = this._nearestInRange(enemies, range);
        if (!enemy) return null;
        return this._stepAttackEnemy(enemy);
      }

      case 'defend_player': {
        // Chase any enemy that gets close to the player
        const guardRange = g.range ?? TILE_SIZE * 6;
        const px = this._scene.player?.x ?? 0;
        const py = this._scene.player?.y ?? 0;
        const nearby = (this._scene.enemies ?? []).filter(e => {
          if (e.isDead()) return false;
          if (!this._isCombatTarget(e)) return false;
          return Phaser.Math.Distance.Between(px, py, e.x, e.y) <= guardRange;
        });
        if (nearby.length === 0) return null;
        const target = this._nearestInRange(nearby, Infinity);
        if (!target) return null;
        return this._stepAttackEnemy(target);
      }

      case 'defend_location': {
        // Guard a fixed point; attack enemies that enter the radius
        const lx    = g.x ?? this._npc.x;
        const ly    = g.y ?? this._npc.y;
        const range = g.range ?? TILE_SIZE * 5;
        const nearby = (this._scene.enemies ?? []).filter(e => {
          if (e.isDead()) return false;
          if (!this._isCombatTarget(e)) return false;
          return Phaser.Math.Distance.Between(lx, ly, e.x, e.y) <= range;
        });
        if (nearby.length === 0) {
          // Return to post if not there
          const distToPost = Phaser.Math.Distance.Between(this._npc.x, this._npc.y, lx, ly);
          if (distToPost > TILE_SIZE) {
            if (!this._walkingToPoint(lx, ly)) {
              this._npc.moveTo(lx, ly, () => this._tick());
              return 'async';
            }
          }
          return null;
        }
        const target = this._nearestInRange(nearby, Infinity);
        return target ? this._stepAttackEnemy(target) : null;
      }

      default:
        return null;
    }
  }

  // ── gather ─────────────────────────────────────────────────────────────────

  _stepGather(task) {
    const item = (task.item ?? '').toLowerCase();
    const cap  = this._npc.upgrades?.carryCapacity ?? 10;

    if (item === 'wood') {
      // Stop gathering if already at carry capacity — go deposit first
      if (this._npc.getItem('Wood') >= cap) return true;

      const assignedTrees = (this._npc.assignedTargets?.trees ?? []).filter(t => !t._chopped);
      const treePool = assignedTrees.length > 0
        ? assignedTrees
        : (this._scene.trees ?? []).filter(t => !t._chopped);
      const tree = this._nearest(treePool);
      if (!tree) {
        this._npc.showBubble('No trees nearby…');
        return false;
      }

      if (this._isNear(tree)) {
        this._npc.stopMoving();
        if (!tree._chopped) {
          tree._chop({ add: (res, amt) => this._npc.addItem(res, amt) }, this._npc.skills);
          this._npc.showBubble('Chopping…');
          return true;
        }
        return false; // chopped already — re-find next tick
      }

      if (!this._walkingTo(tree)) {
        this._npc.moveTo(tree.x, tree.y, () => this._tick());
        return 'async';
      }
      return false;
    }

    if (item === 'ore') {
      // Stop gathering if already at carry capacity
      if (this._npc.getItem('Ore') >= cap) return true;

      const quarry = this._nearest(this._scene.quarries ?? []);
      if (!quarry) return false;
      if (this._isNear(quarry)) {
        this._npc.stopMoving();
        this._npc.showBubble('Waiting for ore…');
        return true;
      }
      if (!this._walkingTo(quarry)) {
        this._npc.moveTo(quarry.x, quarry.y, () => this._tick());
        return 'async';
      }
      return false;
    }

    // Mine-rock ores: copperore, tinore, goldore, coal
    const ORE_ITEM_MAP = {
      copperore: 'CopperOre',
      tinore:    'TinOre',
      goldore:   'GoldOre',
      coal:      'Coal',
    };
    const oreResKey = ORE_ITEM_MAP[item];
    if (oreResKey) {
      return this._stepMineRock(oreResKey, cap);
    }

    return true;
  }

  _stepMaintainFurnaceWood(cfg, asGoal = false) {
    const furnace = this._assignedOrNearest('furnace', this._scene.furnaces ?? []);
    if (!furnace) {
      this._npc.showBubble('No furnace placed yet!');
      return asGoal ? false : true;
    }
    const threshold = Number(cfg?.threshold ?? FURNACE_LOW_WOOD);
    const furnaceWood = furnace._wood ?? 0;
    if (furnaceWood >= threshold) return asGoal ? null : true;

    const reserveQty = Math.max(1, Number(cfg?.reserveQty ?? 1));
    const npcWood = this._npc.getItem('Wood');
    if (npcWood >= reserveQty) {
      return this._stepFill({ task: 'fill', target: 'furnace', item: 'wood', amount: 'all' });
    }
    return this._stepGatherWoodQty({ task: 'gather_wood_qty', targetQty: reserveQty });
  }

  _stepMaintainFlywheels(cfg) {
    const low = Math.max(1, Number(cfg?.low ?? 20));
    const result = this._evalGoal({
      goal: 'crank_flywheel',
      low,
      critical: Math.max(5, low - 5),
      safe: Math.max(40, low),
      target: 80,
    });
    if (result === null) {
      this._npc.stopMoving();
      return false;
    }
    return result;
  }

  // ── mine rock ──────────────────────────────────────────────────────────────
  // Shared logic: walk to a suitable mine rock and mine it.
  // oreResKey: 'CopperOre'|'TinOre'|'GoldOre'|'Coal' (null = any assigned rock type)
  // stopAt: stop when NPC carries this many (default cap)

  _stepMineRock(oreResKey, stopAt) {
    const cap = stopAt ?? (this._npc.upgrades?.carryCapacity ?? 10);

    // If oreResKey is null, derive from assigned rocks (first type found)
    if (!oreResKey) {
      const rocks = this._npc.assignedTargets?.mine_rocks ?? [];
      oreResKey = rocks[0]?.rockType ?? null;
      if (!oreResKey) {
        this._npc.showBubble('No ore type assigned!');
        return false;
      }
    }

    if (this._npc.getItem(oreResKey) >= cap) return true; // at capacity

    // Prefer assigned rocks of this type, else search all
    const assignedRocks = (this._npc.assignedTargets?.mine_rocks ?? [])
      .filter(r => r.rockType === oreResKey);
    let rock;
    if (assignedRocks.length > 0) {
      rock = this._nearest(assignedRocks.filter(r => !r.isDepleted()));
      if (!rock) {
        // All assigned rocks depleted — wait near the closest one
        const waitTarget = this._nearest(assignedRocks);
        if (waitTarget && !this._walkingTo(waitTarget)) {
          this._npc.moveTo(waitTarget.x, waitTarget.y, () => this._tick());
          return 'async';
        }
        this._npc.stopMoving();
        this._npc.showBubble('Waiting for rock to regrow…');
        return false;
      }
    } else {
      rock = this._nearest(
        (this._scene.mineRocks ?? []).filter(r => r.rockType === oreResKey && !r.isDepleted())
      );
    }

    if (!rock) {
      this._npc.stopMoving();
      this._npc.showBubble(`No ${oreResKey} available…`);
      return false;
    }

    if (this._isNear(rock)) {
      this._npc.stopMoving();
      const mined = rock.mine(this._npcInventoryShim(), this._npc.skills);
      if (mined) {
        const have = this._npc.getItem(oreResKey);
        this._npc.showBubble(`Mined! (${have}/${cap})`);
        return have >= cap; // done when at target qty, else keep going
      }
      return false; // depleted — re-find next tick
    }

    if (!this._walkingTo(rock)) {
      this._npc.moveTo(rock.x, rock.y, () => this._tick());
      return 'async';
    }
    return false;
  }

  // ── deposit ────────────────────────────────────────────────────────────────

  _stepDeposit(task) {
    const item   = task.item ?? 'wood';
    const amount = task.amount === 'all' ? Infinity : Number(task.amount ?? 1);
    const resKey = this._capitalize(item);

    // Allow caller to pass a specific crate object directly (ore routing).
    // Otherwise pick the best crate that accepts this item.
    const crate = task._crateObj ?? this._assignedOrNearest('crate', this._scene.crates ?? [], resKey);
    if (!crate) return false;

    // If the resolved crate doesn't accept this item, give up cleanly
    if (!(crate.acceptsItem?.(resKey) ?? true)) return true;

    if (this._isNear(crate)) {
      this._npc.stopMoving();
      const have = this._npc.getItem(resKey);
      if (have <= 0) return true;
      const toDeposit = amount === Infinity ? have : Math.min(amount, have);
      this._npc.removeItem(resKey, toDeposit);
      crate.addToStorage(resKey, toDeposit);
      this._npc.showBubble(`Deposited ${toDeposit} ${resKey}`);
      return true;
    }

    if (!this._walkingTo(crate)) {
      this._npc.moveTo(crate.x, crate.y, () => this._tick());
      return 'async';
    }
    return false;
  }

  // ── fill ───────────────────────────────────────────────────────────────────

  _stepFill(task) {
    const item   = this._capitalize(task.item ?? 'iron');
    const amount = task.amount === 'all' ? Infinity : Number(task.amount ?? 5);

    const furnace = this._assignedOrNearest('furnace', this._scene.furnaces ?? []);
    if (!furnace) return false;

    if (this._isNear(furnace)) {
      this._npc.stopMoving();
      const have = this._npc.getItem(item);
      if (have <= 0) return true;
      const toFill = amount === Infinity ? have : Math.min(amount, have);
      const accepted = furnace.addToStorage(item, toFill);
      if (accepted) {
        this._npc.removeItem(item, toFill);
        this._npc.showBubble(`Fuelled furnace: ${toFill} ${item}`);
      }
      return true;
    }

    if (!this._walkingTo(furnace)) {
      this._npc.moveTo(furnace.x, furnace.y, () => this._tick());
      return 'async';
    }
    return false;
  }

  // ── smelt ──────────────────────────────────────────────────────────────────

  _stepSmelt(task) {
    const furnace = this._assignedOrNearest('furnace', this._scene.furnaces ?? []);
    if (!furnace) return false;

    if (this._isNear(furnace)) {
      this._npc.stopMoving();
      this._npc.showBubble('Watching furnace…');
      if (!furnace._smelting) return true;
      return false;
    }

    if (!this._walkingTo(furnace)) {
      this._npc.moveTo(furnace.x, furnace.y, () => this._tick());
      return 'async';
    }
    return false;
  }

  // ── crank ──────────────────────────────────────────────────────────────────
  // One-shot: walk to assigned/nearest flywheel and crank until fully charged.

  _stepCrank(task) {
    const assignedFws = this._npc.assignedTargets?.flywheels ?? [];
    const flywheel = assignedFws.length > 0
      ? this._nearest(assignedFws)
      : this._nearest(this._scene.flywheels ?? []);
    if (!flywheel) {
      this._npc.showBubble('No flywheel found!');
      return false;
    }
    return this._stepCrankFlywheel(flywheel, 80);
  }

  /** Walk to a specific flywheel and crank until momentum >= stopAt. Returns task result. */
  _stepCrankFlywheel(flywheel, stopAt) {
    // If we switched to a different flywheel, stop the previous one
    if (this._activeFlywheel && this._activeFlywheel !== flywheel) {
      this._activeFlywheel.stopCrank();
      this._activeFlywheel = null;
    }

    const distToFw = Phaser.Math.Distance.Between(this._npc.x, this._npc.y, flywheel.x, flywheel.y);
    if (distToFw <= CRANK_DIST) {
      this._npc.stopMoving();
      if (flywheel.getMomentum() >= stopAt) {
        flywheel.stopCrank();
        this._activeFlywheel = null;
        this._npc.showBubble('Flywheel charged!');
        return true;
      }
      if (!flywheel._cranking) flywheel.startCrank();
      this._activeFlywheel = flywheel;
      this._npc.showBubble(`Cranking… ${Math.round(flywheel.getMomentum())}%`);
      return false;
    }

    // Not close enough — stop cranking while walking
    if (this._activeFlywheel === flywheel) {
      flywheel.stopCrank();
      this._activeFlywheel = null;
    }
    if (!this._walkingTo(flywheel)) {
      this._npc.moveTo(flywheel.x, flywheel.y, () => this._tick());
      return 'async';
    }
    return false;
  }

  // ── hunt_chickens ──────────────────────────────────────────────────────────
  // Attack chickens until the NPC has >= targetQty of item (default Feather).

  _stepHuntChickens(task) {
    const item      = task.item      ?? 'Feather';
    const targetQty = task.targetQty ?? 10;

    if (this._npc.getItem(item) >= targetQty) {
      this._npc.showBubble(`Got ${targetQty}× ${item}!`);
      return true; // done
    }

    const chickens = (this._scene.chickens ?? []).filter(c => !c.isDead());
    if (chickens.length === 0) {
      this._npc.stopMoving();
      this._npc.showBubble(`Waiting for chickens… (${this._npc.getItem(item)}/${targetQty} ${item})`);
      return false; // wait for respawn
    }

    const target = this._nearest(chickens);
    return this._stepAttack({ task: 'attack', target });
  }

  // ── gather_wood_qty ────────────────────────────────────────────────────────
  // Chop trees until the NPC carries >= targetQty Wood.

  _stepGatherWoodQty(task) {
    const targetQty = task.targetQty ?? 10;
    if (this._npc.getItem('Wood') >= targetQty) {
      this._npc.showBubble(`Got ${targetQty}× Wood!`);
      return true;
    }
    // Delegate to existing gather-wood logic
    return this._stepGather({ task: 'gather', item: 'wood' });
  }

  // ── fetch_from_crate ───────────────────────────────────────────────────────
  // Walk to crate and take up to `qty` of `item` into NPC inventory.

  _stepFetchFromCrate(task) {
    const item = task.item ?? 'IronArrowhead';
    const qty  = task.qty  ?? 10;

    const crate = this._assignedOrNearest('crate', this._scene.crates ?? []);
    if (!crate) {
      this._npc.showBubble('No crate found!');
      return false;
    }

    if (this._isNear(crate)) {
      this._npc.stopMoving();
      const inCrate    = crate._stored?.[item] ?? 0;
      const toTake     = Math.min(qty, inCrate);
      if (toTake <= 0) {
        this._npc.showBubble(`No ${item} in crate!`);
        return true; // nothing to take — move on rather than block forever
      }
      crate._stored[item] = inCrate - toTake;
      this._npc.addItem(item, toTake);
      this._npc.showBubble(`Took ${toTake}× ${item} from crate`);
      return true;
    }

    if (!this._walkingTo(crate)) {
      this._npc.moveTo(crate.x, crate.y, () => this._tick());
      return 'async';
    }
    return false;
  }

  // ── deposit_to_crate ───────────────────────────────────────────────────────
  // Walk to crate and deposit all of `item` from NPC inventory.

  _stepDepositToCrate(task) {
    const item = task.item ?? 'Arrow';

    const crate = this._assignedOrNearest('crate', this._scene.crates ?? []);
    if (!crate) return false;

    if (this._isNear(crate)) {
      this._npc.stopMoving();
      const have = this._npc.getItem(item);
      if (have <= 0) return true;
      crate._stored[item] = (crate._stored[item] ?? 0) + have;
      this._npc.removeItem(item, have);
      this._npc.showBubble(`Deposited ${have}× ${item}`);
      return true;
    }

    if (!this._walkingTo(crate)) {
      this._npc.moveTo(crate.x, crate.y, () => this._tick());
      return 'async';
    }
    return false;
  }

  // ── craft_arrows_qty ───────────────────────────────────────────────────────
  // Fletch arrows until NPC has crafted `qty` total (tracks via output item count).

  _stepCraftArrowsQty(task) {
    const targetQty  = task.qty      ?? 10;
    const skillId    = task.skillId  ?? 'fletching';
    const recipeId   = task.recipeId ?? 'fletch_arrow';

    // Done when NPC has enough arrows in their inventory
    if (this._npc.getItem('Arrow') >= targetQty) {
      this._npc.showBubble(`Made ${targetQty}× Arrow!`);
      return true;
    }

    // Delegate to fletch — returns 'async' while crafting, true when done
    return this._stepFletch({ task: 'fletch', skillId, recipeId });
  }

  // ── smith_arrowheads ───────────────────────────────────────────────────────
  // Walk to nearest anvil and smith IronBars into IronArrowheads until targetHeads reached.

  _stepSmithArrowheads(task) {
    const targetHeads = task.targetHeads ?? 30;

    if (this._npc.getItem('IronArrowhead') >= targetHeads) {
      this._npc.showBubble(`Smithed ${targetHeads}× arrowheads!`);
      return true;
    }

    // No iron bars left — done with what we have
    if (this._npc.getItem('IronBar') < 1) {
      this._npc.showBubble('Out of iron bars.');
      return true;
    }

    const anvil = this._assignedOrNearest('anvil', this._scene.anvils ?? []);
    if (!anvil) {
      this._npc.showBubble('No anvil found!');
      return false;
    }

    const dist = Phaser.Math.Distance.Between(this._npc.x, this._npc.y, anvil.x, anvil.y);
    if (dist > INTERACT_DIST) {
      if (!this._walkingTo(anvil)) {
        this._npc.moveTo(anvil.x, anvil.y, () => this._tick());
        return 'async';
      }
      return false;
    }

    // At the anvil — wait if already smithing
    if (anvil.isCrafting()) {
      this._npc.stopMoving();
      this._npc.showBubble(`Smithing… ${Math.round(anvil.getCraftProgress() * 100)}%`);
      return false;
    }

    // Ensure the anvil's active recipe is iron_arrowhead (it's the only recipe, always set)
    // anvil._activeRecipe is already set to ANVIL_RECIPES[0] by default in Anvil constructor.

    const inv     = this._npcInventoryShim();
    const started = anvil.startCraft(inv, ({ outputItem, outputQty }) => {
      this._npc.showBubble(`Smithed ${outputQty}× ${outputItem}!`);
      this._tick();
    });

    if (started) {
      this._npc.stopMoving();
      this._npc.showBubble('Smithing arrowheads…');
      return 'async';
    }
    // Not enough iron — done
    return true;
  }

  // ── fletch ─────────────────────────────────────────────────────────────────
  // Use the scene's SkillSystem to craft using NPC inventory.

  _stepFletch(task) {
    const ss = this._scene.skillSystem;
    if (!ss) return true;
    if (ss.isCrafting()) {
      // Already crafting — wait
      this._npc.stopMoving();
      const act = ss.getActiveCraft();
      this._npc.showBubble(`Fletching… ${act?.recipe?.label ?? ''}`);
      return false;
    }
    const inv     = this._npcInventoryShim();
    const started = ss.startCraft(task.skillId, task.recipeId, this._scene, inv, ({ outputItem, outputQty }) => {
      this._npc.showBubble(`Made ${outputQty}× ${outputItem}!`);
      this._tick();
    });
    if (started) {
      this._npc.stopMoving();
      this._npc.showBubble('Fletching…');
      return 'async';
    }
    return true; // couldn't start (missing materials) — move on
  }

  /** Returns an inventory shim that reads/writes the NPC's own _inventory object. */
  _npcInventoryShim() {
    const npc = this._npc;
    return {
      get: (key) => npc.getItem(key),
      set: (key, val) => { npc._inventory[key] = val; },
      add: (key, qty) => { npc.addItem(key, qty); },
    };
  }

  // ── attack ─────────────────────────────────────────────────────────────────
  // Walk to a chicken and attack it when within 1 tile.

  _stepAttack(task) {
    const chicken = task.target;
    if (!chicken || chicken.isDead?.()) return true; // done — target is dead

    const dist = Phaser.Math.Distance.Between(
      this._npc.x, this._npc.y, chicken.x, chicken.y
    );

    if (dist <= TILE_SIZE * 1.2) {
      this._npc.stopMoving();
      chicken.hit(this._scene, (item, qty) => this._npc.addItem(item, qty), this._npc.skills);
      this._npc.showBubble('Squawk!');
      return true; // one hit, done
    }

    if (!this._walkingTo(chicken)) {
      this._npc.moveTo(chicken.x, chicken.y, () => this._tick());
      return 'async';
    }
    return false;
  }

  // ── attack_nearest_enemy (one-shot task) ──────────────────────────────────

  _stepAttackNearestEnemy(task) {
    const range   = task.range ?? TILE_SIZE * 10;
    const target  = task.target ?? null;
    if (target) {
      if (target.isDead?.() === true) return true;
      if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) return true;
      if (!this._isCombatTarget(target)) return true;
      // Explicit target attacks should stay locked-on until resolved; don't
      // auto-complete just because distance exceeds the initial trigger range.
      return this._stepAttackEnemy(target);
    }
    const enemies = (this._scene.enemies ?? []).filter(e => !e.isDead() && this._isCombatTarget(e));
    if (enemies.length === 0) {
      this._npc.stopMoving();
      return true; // no enemies — done
    }
    const enemy = this._nearestInRange(enemies, range);
    if (!enemy) {
      this._npc.stopMoving();
      return true;
    }
    return this._stepAttackEnemy(enemy);
  }

  // ── patrol_area ───────────────────────────────────────────────────────────
  // Walk between random points within a radius of a centre point.
  // Interrupts to fight any enemy that comes within aggro range.

  _stepPatrol(task) {
    const cx    = task.x      ?? this._npc.x;
    const cy    = task.y      ?? this._npc.y;
    const range = task.range  ?? TILE_SIZE * 4;
    const aggro = task.aggro  ?? TILE_SIZE * 6;

    // Attack any nearby enemy first
    const enemy = this._nearestInRange(
      (this._scene.enemies ?? []).filter(e => !e.isDead() && this._isCombatTarget(e)), aggro
    );
    if (enemy) return this._stepAttackEnemy(enemy);

    // Otherwise wander
    if (!this._patrolTarget || this._isNearPoint(this._patrolTarget.x, this._patrolTarget.y)) {
      const angle = Math.random() * Math.PI * 2;
      const dist  = Math.random() * range;
      this._patrolTarget = {
        x: cx + Math.cos(angle) * dist,
        y: cy + Math.sin(angle) * dist,
      };
      this._npc.moveTo(this._patrolTarget.x, this._patrolTarget.y, () => {
        this._patrolTarget = null;
        this._tick();
      });
      return 'async';
    }
    return false;
  }

  // ── defend_player (one-shot task) ─────────────────────────────────────────
  // Continuously intercept any enemy within `range` tiles of the player.
  // Returns false (never completes) — stays active until manually replaced.

  _stepDefendPlayer(task) {
    const guardRange = task.range ?? TILE_SIZE * 4;
    const px = this._scene.player?.x ?? 0;
    const py = this._scene.player?.y ?? 0;

    const nearby = (this._scene.enemies ?? []).filter(e => {
      if (e.isDead()) return false;
      if (!this._isCombatTarget(e)) return false;
      return Phaser.Math.Distance.Between(px, py, e.x, e.y) <= guardRange;
    });

    if (nearby.length === 0) {
      // Loosely follow the player when nothing to fight
      const dist = Phaser.Math.Distance.Between(this._npc.x, this._npc.y, px, py);
      if (dist > TILE_SIZE * 2) {
        if (!this._walkingToPoint(px, py)) {
          this._npc.moveTo(px, py, () => this._tick());
          return 'async';
        }
      } else {
        this._npc.stopMoving();
      }
      return false;
    }

    const target = this._nearestInRange(nearby, Infinity);
    if (target) this._stepAttackEnemy(target);
    return false; // permanent — never auto-completes
  }

  // ── defend_location (one-shot task) ───────────────────────────────────────
  // Stand at (x, y), attack any enemy that enters `range` tiles.
  // Returns false — permanent until replaced.

  _stepDefendLocation(task) {
    const lx    = task.x     ?? this._npc.x;
    const ly    = task.y     ?? this._npc.y;
    const range = task.range ?? TILE_SIZE * 5;

    const nearby = (this._scene.enemies ?? []).filter(e => {
      if (e.isDead()) return false;
      if (!this._isCombatTarget(e)) return false;
      return Phaser.Math.Distance.Between(lx, ly, e.x, e.y) <= range;
    });

    if (nearby.length > 0) {
      const target = this._nearestInRange(nearby, Infinity);
      if (target) this._stepAttackEnemy(target);
      return false;
    }

    // Return to post if drifted
    if (!this._isNearPoint(lx, ly)) {
      if (!this._walkingToPoint(lx, ly)) {
        this._npc.moveTo(lx, ly, () => this._tick());
        return 'async';
      }
    } else {
      this._npc.stopMoving();
    }
    return false;
  }

  // ── shared enemy-attack helper ─────────────────────────────────────────────
  // Walk to enemy, attack via CombatSystem, return task result.

  _stepAttackEnemy(enemy) {
    if (!enemy || enemy.isDead?.() === true) return true;
    if (!this._isCombatTarget(enemy)) return true;

    const dist = Phaser.Math.Distance.Between(
      this._npc.x, this._npc.y, enemy.x, enemy.y
    );

    if (dist <= TILE_SIZE * 1.2) {
      this._npc.stopMoving();
      this._scene.combatSystem?.npcMeleeAttack(this._npc, enemy);
      this._npc.showBubble('Attack!');
      return false; // return false so task re-evaluates and keeps attacking until dead
    }

    if (!this._walkingTo(enemy)) {
      this._npc.moveTo(enemy.x, enemy.y, () => this._tick());
      return 'async';
    }
    return false;
  }

  // ── follow ─────────────────────────────────────────────────────────────────

  _stepFollow() {
    const player = this._scene.player;
    const px = player.x;
    const py = player.y;

    // Attack any enemy within 4 tiles of the player
    const DEFEND_RANGE = TILE_SIZE * 4;
    const threat = this._nearestInRange(
      (this._scene.enemies ?? []).filter(e => !e.isDead() && this._isCombatTarget(e) &&
        Phaser.Math.Distance.Between(px, py, e.x, e.y) <= DEFEND_RANGE),
      Infinity
    );
    if (threat) {
      this._stepAttackEnemy(threat);
      return false;
    }

    // No threat — stay close to player
    const dist = Phaser.Math.Distance.Between(this._npc.x, this._npc.y, px, py);
    if (dist > TILE_SIZE) {
      this._npc.moveTo(px, py, null);
    } else {
      this._npc.stopMoving();
    }
    return false; // permanent
  }

  // ── Status (for UI panels) ─────────────────────────────────────────────────

  /**
   * Returns a snapshot of the current task state for display.
   * {
   *   running: bool,
   *   tasks: [ task objects ],           // full queue
   *   activeGoalIndex: number,           // index within loop goals (-1 if not looping)
   *   progress: { item, have, need }     // live progress for the active goal (may be null)
   * }
   */
  getStatus() {
    if (!this._running || this._queue.length === 0) {
      return { running: false, tasks: [], activeGoalIndex: -1, progress: null };
    }

    const tasks   = this._queue;
    const current = tasks[0];
    const isGoalLoop = current?.task === 'loop';
    const isScriptLoop = current?.task === 'script_loop';
    const goalIdx = isGoalLoop ? this._activeGoalIndex : (isScriptLoop ? this._activeScriptLineIndex : -1);
    const goal = isGoalLoop
      ? (current.goals?.[goalIdx] ?? null)
      : (isScriptLoop ? (current.lines?.[goalIdx] ?? null) : null);

    // Derive live progress hint from the active goal/task
    let progress = null;
    if (goal && isGoalLoop) {
      progress = this._goalProgress(goal);
    } else if (goal && isScriptLoop) {
      progress = this._scriptLineProgress(goal);
    } else if (current && current.task !== 'loop') {
      progress = this._taskProgress(current);
    }

    return { running: true, tasks, activeGoalIndex: goalIdx, progress };
  }

  /** Live progress for a goal object. Returns { item, have, need } or null. */
  _goalProgress(g) {
    const npc = this._npc;
    switch (g.goal) {
      case 'hunt_for_feathers':
        return { item: 'Feather', have: npc.getItem('Feather'), need: g.targetQty ?? 10 };
      case 'gather_wood_for_arrows':
        return { item: 'Wood', have: npc.getItem('Wood'), need: g.targetQty ?? 10 };
      case 'gather':
        return { item: this._capitalize(g.item ?? 'wood'), have: npc.getItem(this._capitalize(g.item ?? 'wood')), need: 1 };
      case 'smith_arrowheads':
        return { item: 'IronArrowhead', have: npc.getItem('IronArrowhead'), need: g.arrowheadQty ?? 10 };
      case 'fetch_arrowheads':
        return { item: 'IronArrowhead', have: npc.getItem('IronArrowhead'), need: g.qty ?? 10 };
      case 'craft_arrows':
        return { item: 'Arrow', have: npc.getItem('Arrow'), need: g.qty ?? 10 };
      case 'deposit_arrows':
        return { item: 'Arrow', have: npc.getItem('Arrow'), need: 0 };
      case 'deposit_extra':
        return { item: this._capitalize(g.item ?? 'Wood'), have: npc.getItem(this._capitalize(g.item ?? 'Wood')), need: 0 };
      case 'maintain_inventory': {
        const item = this._capitalize(g.item ?? 'Wood');
        return { item, have: npc.getItem(item), need: Math.max(0, Number(g.minQty ?? g.qty ?? 1)) };
      }
      case 'fill_furnace_wood': {
        const furnace = this._assignedOrNearest('furnace', this._scene.furnaces ?? []);
        return { item: 'Wood (furnace)', have: furnace?._wood ?? 0, need: g.threshold ?? 5 };
      }
      case 'crank_flywheel': {
        const fw = this._activeFlywheel;
        return fw ? { item: 'Momentum', have: Math.round(fw.getMomentum()), need: g.target ?? 80 } : null;
      }
      default:
        return null;
    }
  }

  _scriptLineProgress(line) {
    const npc = this._npc;
    switch (line.action) {
      case 'gather':
        return { item: this._capitalize(line.item ?? 'wood'), have: npc.getItem(this._capitalize(line.item ?? 'wood')), need: 1 };
      case 'deposit':
        return { item: this._capitalize(line.item ?? 'wood'), have: npc.getItem(this._capitalize(line.item ?? 'wood')), need: 0 };
      case 'withdraw':
        return { item: this._capitalize(line.item ?? 'wood'), have: npc.getItem(this._capitalize(line.item ?? 'wood')), need: Number(line.qty ?? 1) };
      case 'maintain': {
        const furnace = this._assignedOrNearest('furnace', this._scene.furnaces ?? []);
        return { item: 'Wood (furnace)', have: furnace?._wood ?? 0, need: Number(line.threshold ?? FURNACE_LOW_WOOD) };
      }
      case 'maintain_flywheels': {
        const fw = this._activeFlywheel;
        return fw
          ? { item: 'Momentum', have: Math.round(fw.getMomentum()), need: Number(line.low ?? 20) }
          : { item: 'Momentum', have: 100, need: Number(line.low ?? 20) };
      }
      default:
        return null;
    }
  }

  /** Live progress for a one-shot task. Returns { item, have, need } or null. */
  _taskProgress(task) {
    const npc = this._npc;
    switch (task.task) {
      case 'gather':
        return { item: this._capitalize(task.item ?? 'wood'), have: npc.getItem(this._capitalize(task.item ?? 'wood')), need: 1 };
      case 'deposit':
        return { item: this._capitalize(task.item ?? 'wood'), have: npc.getItem(this._capitalize(task.item ?? 'wood')), need: 0 };
      default:
        return null;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Return the assigned target of this type if set, otherwise nearest from list. */
  _assignedOrNearest(type, entities, resKey = null) {
    if (type === 'crate') {
      const crates = this._npc.assignedTargets?.crates ?? [];
      // Pick first assigned crate that accepts the item (or first if no filter needed)
      const viable = resKey
        ? crates.filter(c => c.acceptsItem?.(resKey) ?? true)
        : crates;
      if (viable.length > 0) return viable[0];
      // Fall back to nearest scene crate that accepts the item
      const all = resKey
        ? (entities).filter(c => c.acceptsItem?.(resKey) ?? true)
        : entities;
      return this._nearest(all);
    }
    const assigned = this._npc.assignedTargets?.[type];
    if (assigned) return assigned;
    return this._nearest(entities);
  }

  /**
   * Return the best crate for depositing a specific ore type.
   * Checks crateOreMap first (explicit per-ore assignment), then first
   * assigned crate, then nearest in scene.
   */
  _crateForOre(oreResKey) {
    const at     = this._npc.assignedTargets ?? {};
    const crates = at.crates ?? [];
    const oreMap = at.crateOreMap ?? {};

    if (oreResKey && oreResKey in oreMap) {
      const mapped = crates[oreMap[oreResKey]];
      if (mapped && (mapped.acceptsItem?.(oreResKey) ?? true)) return mapped;
    }
    // First assigned crate that accepts this ore
    const viable = oreResKey
      ? crates.filter(c => c.acceptsItem?.(oreResKey) ?? true)
      : crates;
    if (viable.length > 0) return viable[0];
    // Nearest scene crate that accepts this ore
    const all = this._scene.crates ?? [];
    return this._nearest(oreResKey ? all.filter(c => c.acceptsItem?.(oreResKey) ?? true) : all);
  }

  _nearest(entities) {
    let best = null, bestDist = Infinity;
    for (const e of entities) {
      const d = Phaser.Math.Distance.Between(this._npc.x, this._npc.y, e.x, e.y);
      if (d < bestDist) { bestDist = d; best = e; }
    }
    return best;
  }

  _isNear(entity) {
    return Phaser.Math.Distance.Between(
      this._npc.x, this._npc.y, entity.x, entity.y
    ) <= INTERACT_DIST;
  }

  _walkingTo(entity) {
    const t = this._npc._target;
    if (!t) return false;
    return Math.abs(t.x - entity.x) < TILE_SIZE && Math.abs(t.y - entity.y) < TILE_SIZE;
  }

  _walkingToPoint(x, y) {
    const t = this._npc._target;
    if (!t) return false;
    return Math.abs(t.x - x) < TILE_SIZE && Math.abs(t.y - y) < TILE_SIZE;
  }

  _isNearPoint(x, y) {
    return Phaser.Math.Distance.Between(this._npc.x, this._npc.y, x, y) <= INTERACT_DIST;
  }

  _nearestInRange(entities, range) {
    let best = null, bestDist = range;
    for (const e of entities) {
      const d = Phaser.Math.Distance.Between(this._npc.x, this._npc.y, e.x, e.y);
      if (d < bestDist) { bestDist = d; best = e; }
    }
    return best;
  }

  _isCombatTarget(entity) {
    return !!entity && (
      typeof entity.hit === 'function' ||
      typeof entity.takeDamage === 'function'
    );
  }

  _capitalize(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  // ── Serialisation ──────────────────────────────────────────────────────────

  /**
   * Serialise the current task queue to plain JSON-safe data.
   * The queue is already plain objects (no game-object refs), so just clone it.
   * assigned targets are saved as positional keys for reconstruction.
   */
  serialiseTasks() {
    return {
      queue: JSON.parse(JSON.stringify(this._queue)),
    };
  }

  /**
   * Restore a serialised task queue.  Called from SaveSystem after all scene
   * entities have been re-created (so assigned targets can be looked up by pos).
   */
  restoreTasks(data) {
    if (!data?.queue?.length) return;
    this.setTasks(data.queue);
  }
}
