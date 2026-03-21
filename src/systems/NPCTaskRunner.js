// NPCTaskRunner.js — thin dispatcher. Executes task descriptors produced by NPCBrain.
// It does NOT make decisions about what task to run.
// See docs/superpowers/plans/2026-03-20-05a-npc-task-runner-subsplit.md for split details.
//
// Supported tasks: gather, follow, attack_nearest_enemy, defend_player,
//   attack_player, attack_npc, idle, give_logs, deposit_to_crate,
//   socialize_npc, greet_npc, steal_logs, practice_ki, refine_stone, mine_ore, custom_task.

import { TILE_SIZE } from '../constants.js';
import { GatherTaskHandler }  from './npc/GatherTaskHandler.js';
import { CombatTaskHandler }  from './npc/CombatTaskHandler.js';
import { KiTaskHandler }      from './npc/KiTaskHandler.js';
import { SocialTaskHandler }  from './npc/SocialTaskHandler.js';
import { DepositTaskHandler } from './npc/DepositTaskHandler.js';
import { RefineStoneHelper }  from './npc/RefineStoneHelper.js';

const FOLLOW_DIST_BASE  = TILE_SIZE * 2;   // stay 2 tiles from player (base, scaled by personality)
const FOLLOW_LEASH_BASE = TILE_SIZE * 1.2; // stop when this close (base)
const ATTACK_COOLDOWN_BASE = 1000; // ms between NPC attacks (base, scaled by personality)

export class NPCTaskRunner {
  constructor(scene, npc) {
    this._scene = scene;
    this._npc   = npc;
    this._tasks = [];    // queue of { task, ... }
    this._state = 'idle';
    this._target = null; // current movement/interaction target
    this._targetType = null; // 'player', 'npc', 'dummy'
    this._chopCooldown = 0; // ms until NPC can chop again
    this._mineCooldown = 0; // ms until NPC can mine again
    this._attackCooldown = 0; // ms until NPC can attack again
    this._kiBlastCooldown = 0; // ms until NPC can ki blast again

    // Expose ATTACK_RANGE for handlers that need it
    this._ATTACK_RANGE = TILE_SIZE * 1.2;

    // Instantiate task handlers
    this._gather  = new GatherTaskHandler(scene, npc, this);
    this._combat  = new CombatTaskHandler(scene, npc, this);
    this._ki      = new KiTaskHandler(scene, npc, this);
    this._social  = new SocialTaskHandler(scene, npc, this);
    this._deposit = new DepositTaskHandler(scene, npc, this);
    this._refine  = new RefineStoneHelper(scene, npc, this);
  }

  // ── Personality-modulated constants ─────────────────────────────────────────

  /** Effective follow distance — personality controls orbit radius. */
  _getFollowDist() {
    return FOLLOW_DIST_BASE * (this._npc._personalityMod?.followDist ?? 1.0);
  }

  /** Effective follow leash — scales with follow distance. */
  _getFollowLeash() {
    return FOLLOW_LEASH_BASE * (this._npc._personalityMod?.followDist ?? 1.0);
  }

  /** Effective melee attack cooldown — personality + emotion. */
  _getAttackCooldownMs() {
    const mod = this._npc._personalityMod?.meleeCd ?? 1.0;
    const rel = this._npc._getOwnerRelationship?.();
    const anger = rel?.anger ?? 0;
    // Angry NPCs attack faster (reckless swings, up to 25% faster at max anger)
    return Math.max(200, ATTACK_COOLDOWN_BASE * mod * (1 - anger * 0.25));
  }

  /** Replace entire task queue. */
  setTasks(commands) {
    this._tasks = Array.isArray(commands) ? [...commands] : [];
    this._state = 'idle';
    this._target = null;
    this._socializing = false;
    this._npc.stopMoving();
  }

  /** Stop everything. */
  stop() {
    this._tasks = [];
    this._state = 'idle';
    this._target = null;
    this._npc.stopMoving();
  }

  getStatus() {
    return { running: this._tasks.length > 0, tasks: this._tasks };
  }

  /** Face NPC toward a target entity. */
  _faceTarget(npc, target) {
    const dx = target.x - npc.x;
    const dy = target.y - npc.y;
    if (Math.abs(dx) > Math.abs(dy)) {
      npc._facing = dx > 0 ? 'right' : 'left';
    } else {
      npc._facing = dy > 0 ? 'down' : 'up';
    }
  }

  /** Called every frame from GameScene update. */
  update(delta) {
    if (this._npc.isDead()) return;
    if (this._kiBlastCooldown > 0) this._kiBlastCooldown -= delta;
    if (this._tasks.length === 0) return;

    const cmd = this._tasks[0];
    switch (cmd.task) {
      case 'gather':               this._gather.doGather(delta); break;
      case 'follow':               this._social.doFollow(delta); break;
      case 'idle':                 this._tasks.shift(); break;
      case 'attack_nearest_enemy': this._combat.doAttack(delta); break;
      case 'train':                this._ki.doTrain(delta); break;
      case 'gather_stone':         this._gather.doGatherStone(delta); break;
      case 'gather_all':           this._gather.doGatherAll(delta); break;
      case 'defend_player':        this._combat.doDefend(delta); break;
      case 'attack_player':        this._combat.doAttackPlayer(delta); break;
      case 'attack_npc':           this._combat.doAttackNPC(delta); break;
      case 'absorb_npc':           this._combat.doAbsorbNPC(delta); break;
      case 'flee_player':          this._combat.doFleePlayer(delta); break;
      case 'give_logs':            this._gather.doGiveLogs(delta); break;
      case 'steal_logs':           this._deposit.doStealLogs(delta); break;
      case 'socialize_npc':        this._social.doSocializeNPC(delta); break;
      case 'greet_npc':            this._social.doGreetNpc(cmd); break;
      case 'practice_ki':          this._ki.doPracticeKi(delta); break;
      case 'pickup_stone':         this._gather.doPickupStone(delta); break;
      case 'refine_stone':         this._refine.doRefineStone(delta); break;
      case 'give_materials':       this._gather.doGiveMaterials(delta); break;
      case 'wander_explore':       this._social.doWanderExplore(delta); break;
      case 'mine_ore':             this._gather.doMineOre(delta); break;
      case 'deposit_to_crate':     this._deposit.doDepositToCrate(delta); break;
      case 'custom_task':          this._social.doCustomTask(delta); break;
      default:
        console.warn(`[TaskRunner] Unknown task: ${cmd.task}`);
        this._tasks.shift();
    }
  }
}
