// NPCTaskRunner — lightweight task executor for NPC commands.
// Supports: gather, follow, attack_nearest_enemy, defend_player, attack_player, attack_npc, idle.

import Phaser from 'phaser';
import { TILE_SIZE, TREE_CHOP_DIST, NRG_KEY } from '../constants.js';
import { generateNPCChat } from '../net/LLMClient.js';

const FOLLOW_DIST   = TILE_SIZE * 2;   // stay 2 tiles from player
const FOLLOW_LEASH  = TILE_SIZE * 1.2; // stop when this close
const ATTACK_RANGE  = TILE_SIZE * 1.2;
const DEFEND_RANGE  = TILE_SIZE * 6;
const ATTACK_COOLDOWN_MS = 1000; // ms between NPC attacks
const CAMPFIRE_SENSE_RADIUS = TILE_SIZE * 8;
const CAMPFIRE_GUARD_WARN_RADIUS = TILE_SIZE * 4;
const CAMPFIRE_GUARD_ATTACK_RADIUS = TILE_SIZE * 2;
const CAMPFIRE_GUARD_RESPONSE_MS = 2500;
const KI_BLAST_RANGE = TILE_SIZE * 4; // NPC ki blast range (matches player)
const KI_BLAST_COOLDOWN_MS = 1200; // NPC ki blast cooldown (matches player)

export class NPCTaskRunner {
  constructor(scene, npc) {
    this._scene = scene;
    this._npc   = npc;
    this._tasks = [];    // queue of { task, ... }
    this._state = 'idle';
    this._target = null; // current movement/interaction target
    this._targetType = null; // 'player', 'npc', 'dummy'
    this._chopCooldown = 0; // ms until NPC can chop again
    this._attackCooldown = 0; // ms until NPC can attack again
    this._kiBlastCooldown = 0; // ms until NPC can ki blast again
    this._campfireRecovery = null;
  }

  /** Replace entire task queue. */
  setTasks(commands) {
    this._tasks = Array.isArray(commands) ? [...commands] : [];
    this._state = 'idle';
    this._target = null;
    this._socializing = false;
    this._campfireRecovery = null;
    this._npc.stopMoving();
  }

  /** Stop everything. */
  stop() {
    this._tasks = [];
    this._state = 'idle';
    this._target = null;
    this._campfireRecovery = null;
    this._npc.stopMoving();
  }

  getStatus() {
    return { running: this._tasks.length > 0, tasks: this._tasks };
  }

  _targetIsDown(target) {
    return !!(target?.isDead?.() || target?._dead || target?.isKnockedOut?.());
  }

  _completeCombatTaskOnTargetDown(targetName = 'them') {
    const scene = this._scene;
    const npc = this._npc;
    const currentTask = this._tasks[0]?.task || 'attack';
    const line = scene._buildKnockoutVictoryLine?.(npc, currentTask) || `They're down.`;
    npc.showBubble(line, 3200, { silent: true });
    scene._addNPCSpeechToChat?.(npc, line);
    npc.addMemory(`I knocked ${targetName} down during a fight.`, 'event', scene.playerId, 0.65);
    this.setTasks([{ task: 'idle' }]);
  }

  _getOwnServerNPCState() {
    return this._scene?._lastServerState?.players?.[this._scene.playerId]?.npcs?.[this._npc.id] ?? null;
  }

  _npcIsCarryingTarget(cmd) {
    const carrying = this._getOwnServerNPCState()?.carrying;
    if (!carrying) return false;
    if (cmd.task === 'carry_away_player') {
      return carrying.type === 'player' && carrying.id === cmd.target_id;
    }
    return carrying.type === 'npc' && carrying.owner === cmd.target_owner && carrying.id === cmd.target_npc_id;
  }

  _maybeOpportunisticRob(cmd, target) {
    if (cmd._robAttempted) return;
    cmd._robAttempted = true;
    const npc = this._npc;
    const pers = npc.soul?.personality || {};
    const robScore = (pers.aggression ?? 0.3) * 0.55 + (1 - (pers.cooperation ?? 0.5)) * 0.25 + (pers.neuroticism ?? 0.3) * 0.2;
    if (robScore < 0.52 || (target?.logs ?? 0) <= 0) return;
    if (cmd.task === 'carry_away_player') {
      this._scene._conn?.send({ type: 'npc_rob_player', npc_id: npc.id, target_id: cmd.target_id });
    } else {
      this._scene._conn?.send({
        type: 'npc_rob_npc',
        npc_id: npc.id,
        owner_id: cmd.target_owner,
        target_npc_id: cmd.target_npc_id,
      });
    }
    const line = `Took their stuff too.`;
    npc.showBubble(line, 2600, { silent: true });
    this._scene._addNPCSpeechToChat?.(npc, line, '#ffccaa');
  }

  _finishCarryAway(cmd, targetName = 'them') {
    const npc = this._npc;
    const scene = this._scene;
    const line = (npc.soul?.personality?.aggression ?? 0.3) > 0.6
      ? `${targetName} woke up stranded. Hah.`
      : `I dumped ${targetName} far off and came back.`;
    npc.showBubble(line, 3600, { silent: true });
    scene._addNPCSpeechToChat?.(npc, line, '#ffccaa');
    npc.addMemory(`I carried ${targetName} away while they were unconscious.`, 'event', scene.playerId, 0.82);
    this.setTasks([{ task: 'follow' }]);
  }

  _carryAwayDestination() {
    const npc = this._npc;
    const player = this._scene.player;
    const dx = npc.x - player.x;
    const dy = npc.y - player.y;
    const len = Math.max(1, Math.hypot(dx, dy));
    return {
      x: npc.x + (dx / len) * TILE_SIZE * 5,
      y: npc.y + (dy / len) * TILE_SIZE * 5,
    };
  }

  /** Called every frame from GameScene update. */
  update(delta) {
    if (this._npc.isDead()) return;
    if (this._npc.meditating) {
      this._npc.stopMoving();
      return;
    }
    if (this._kiBlastCooldown > 0) this._kiBlastCooldown -= delta;
    if (this._tryCampfireRecovery(delta)) return;
    if (this._tasks.length === 0) return;

    const cmd = this._tasks[0];
    switch (cmd.task) {
      case 'gather':   this._doGather(delta); break;
      case 'follow':   this._doFollow(delta); break;
      case 'idle':     this._tasks.shift(); break;
      case 'attack_nearest_enemy': this._doAttack(delta); break;
      case 'train':                this._doTrain(delta); break;
      case 'defend_player':        this._doDefend(delta); break;
      case 'attack_player':        this._doAttackPlayer(delta); break;
      case 'attack_npc':            this._doAttackNPC(delta); break;
      case 'flee_player':           this._doFleePlayer(delta); break;
      case 'give_logs':            this._doGiveLogs(delta); break;
      case 'steal_logs':           this._doStealLogs(delta); break;
      case 'socialize_npc':        this._doSocializeNPC(delta); break;
      case 'build_fence':          this._doBuildFence(delta); break;
      case 'light_campfire':       this._doLightCampfire(delta); break;
      case 'guard_fire':           this._doGuardFire(delta); break;
      case 'move_away_from_fire':  this._doMoveAwayFromFire(delta); break;
      case 'carry_away_player':    this._doCarryAwayPlayer(delta); break;
      case 'carry_away_npc':       this._doCarryAwayNPC(delta); break;
      case 'learn_ki':             this._doLearnKi(delta); break;
      case 'show_blast':           this._doShowBlast(delta); break;
      case 'practice_ki':          this._doPracticeKi(delta); break;
      case 'pickup_stone':         this._doPickupStone(delta); break;
      case 'refine_stone':         this._doRefineStone(delta); break;
      case 'give_materials':       this._doGiveMaterials(delta); break;
      case 'meditate':             this._doMeditate(delta); break;
      default:
        console.warn(`[TaskRunner] Unknown task: ${cmd.task}`);
        this._tasks.shift();
    }
  }

  _campfireRecoveryBlocked(taskName) {
    return new Set([
      'attack_nearest_enemy', 'defend_player', 'attack_player', 'attack_npc',
      'flee_player', 'steal_logs', 'socialize_npc', 'carry_away_player',
      'carry_away_npc', 'guard_fire',
    ]).has(taskName);
  }

  _restoreCampfireRecoveryTasks() {
    if (!this._campfireRecovery) return;
    const paused = this._campfireRecovery.pausedTasks || [];
    this._campfireRecovery = null;
    if (this._tasks.length === 0 && paused.length > 0) {
      this._tasks = paused;
    }
  }

  _tryCampfireRecovery(_delta) {
    const scene = this._scene;
    const npc = this._npc;
    const currentTask = this._tasks[0]?.task || null;
    if (this._campfireRecoveryBlocked(currentTask)) {
      this._restoreCampfireRecoveryTasks();
      return false;
    }
    if (npc.hp >= npc.maxHp) {
      this._restoreCampfireRecoveryTasks();
      return false;
    }

    const fire = scene._findNearestLitCampfire?.(npc.x, npc.y, 8);
    if (!fire) {
      this._restoreCampfireRecoveryTasks();
      return false;
    }

    if (!this._campfireRecovery) {
      this._campfireRecovery = {
        fireId: fire._serverId,
        pausedTasks: this._tasks.length > 0 ? [...this._tasks] : [],
      };
      this._tasks = [];
    }

    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, fire.x, fire.y);
    if (dist > TILE_SIZE * 1.2) {
      npc.moveTo(fire.x, fire.y);
    } else {
      npc.stopMoving();
      if (!this._campfireRecovery.announcedAt || Date.now() - this._campfireRecovery.announcedAt > 6000) {
        npc.showBubble('Using the fire to patch myself up.', 2200, { silent: true });
        this._campfireRecovery.announcedAt = Date.now();
      }
    }
    return true;
  }

  // ── Gather wood ─────────────────────────────────────────────────────────────

  _doGather(_delta) {
    const scene = this._scene;
    const npc   = this._npc;

    // Spot nearby NPCs from other players — maybe interact based on personality
    this._gatherSpotAccum = (this._gatherSpotAccum ?? 0) + _delta;
    if (this._gatherSpotAccum > 10000) { // check every 10s
      this._gatherSpotAccum = 0;
      for (const rnpc of Object.values(scene._remoteNPCSprites || {})) {
        if (rnpc.isDead?.()) continue;
        const d = Phaser.Math.Distance.Between(npc.x, npc.y, rnpc.x, rnpc.y) / TILE_SIZE;
        if (d < 8) {
          const interaction = this._decideNPCInteraction(npc, rnpc);
          if (interaction) {
            // Insert interaction before current gather task, gather resumes after
            this._tasks.unshift(interaction);
            return;
          }
          break; // only consider one nearby NPC per check
        }
      }
    }

    // Inventory full — deliver logs to player, then resume gathering
    if (npc.isInventoryFull()) {
      npc.stopMoving();
      npc.showBubble(`Full up! Bringing logs to you.`, 3000);
      // Replace current gather with: give_logs → gather (auto-resume)
      this._tasks.shift();
      this._tasks.unshift({ task: 'give_logs' }, { task: 'gather', item: 'wood' });
      return;
    }

    // Cooldown after chopping — wait for server to process
    if (this._chopCooldown > 0) {
      this._chopCooldown -= _delta;
      npc.stopMoving();
      return;
    }

    // Find nearest un-chopped tree
    if (!this._target || this._target._chopped) {
      const trees = (scene.trees ?? []).filter(t => !t._chopped);
      if (trees.length === 0) {
        npc.showBubble('No trees left!', 3000);
        this._tasks.shift();
        return;
      }
      trees.sort((a, b) =>
        Phaser.Math.Distance.Between(npc.x, npc.y, a.x, a.y) -
        Phaser.Math.Distance.Between(npc.x, npc.y, b.x, b.y)
      );
      this._target = trees[0];
      this._state = 'moving_to_tree';
    }

    const tree = this._target;
    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, tree.x, tree.y);

    if (dist > TREE_CHOP_DIST) {
      // Walk toward tree
      npc.moveTo(tree.x, tree.y);
    } else {
      // Close enough — chop via server
      npc.stopMoving();
      if (!tree._chopped) {
        const conn = this._scene._conn;
        if (conn?.connected && tree.treeIndex >= 0) {
          conn.send({ type: 'npc_chop', tree_id: tree.treeIndex, owner_id: scene.playerId });
        }
        // Add log to NPC inventory
        npc.logs = Math.min(npc.logs + 1, npc.maxLogs);
        npc.showBubble(`Chopping! (${npc.logs}/${npc.maxLogs})`, 1500, { silent: true });
        this._chopCooldown = 1500; // wait before looking for next tree
      }
      this._target = null; // find next tree after cooldown
    }
  }

  // ── Give logs to player ─────────────────────────────────────────────────────

  _doGiveLogs(_delta) {
    const scene = this._scene;
    const npc   = this._npc;
    const player = scene.player;
    if (!player) return;

    if (npc.logs <= 0) {
      npc.showBubble('I have no logs to give!', 2000);
      this._tasks.shift();
      return;
    }

    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, player.x, player.y);

    if (dist > FOLLOW_LEASH) {
      // Walk to player first
      npc.moveTo(player.x, player.y);
    } else {
      // Close enough — transfer logs
      npc.stopMoving();
      const amount = npc.logs;
      npc.logs = 0;
      // Mark as voluntary transfer so theft detection ignores the server drop
      npc._givingLogs = true;
      // Add logs to player via server
      const conn = scene._conn;
      if (conn?.connected) {
        conn.send({ type: 'admin', field: 'logs', value: amount });
      }
      npc.showBubble(`Here's ${amount} log${amount > 1 ? 's' : ''}, boss!`, 3000);
      this._tasks.shift();
    }
  }

  // ── Follow player ───────────────────────────────────────────────────────────

  _doFollow(_delta) {
    const player = this._scene.player;
    const npc    = this._npc;
    if (!player) return;

    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, player.x, player.y);

    if (dist > FOLLOW_DIST) {
      npc.moveTo(player.x, player.y);
    } else if (dist < FOLLOW_LEASH) {
      npc.stopMoving();
    }
  }

  // ── Attack nearest enemy (players, their NPCs, or dummies) ─────────────────

  _doAttack(_delta) {
    const scene = this._scene;
    const npc   = this._npc;

    // Attack cooldown
    if (this._attackCooldown > 0) { this._attackCooldown -= _delta; return; }

    // Re-acquire target if current one is dead or missing
    if (!this._target || this._target._dead || this._target.isDead?.() || this._target.isKnockedOut?.()) {
      this._target = null;
      let bestDist = Infinity;

      // Check remote players
      for (const rp of Object.values(scene._remotePlayers || {})) {
        if (rp.isDead?.()) continue;
        const d = Phaser.Math.Distance.Between(npc.x, npc.y, rp.x, rp.y);
        if (d < bestDist) {
          bestDist = d;
          this._target = rp;
          this._targetType = 'player';
        }
      }

      // Check remote NPCs (other players' NPCs)
      for (const rnpc of Object.values(scene._remoteNPCSprites || {})) {
        if (rnpc.isDead?.()) continue;
        const d = Phaser.Math.Distance.Between(npc.x, npc.y, rnpc.x, rnpc.y);
        if (d < bestDist) {
          bestDist = d;
          this._target = rnpc;
          this._targetType = 'npc';
        }
      }

      // Check dummies
      for (const dummy of (scene.dummies ?? [])) {
        if (dummy.isDead()) continue;
        const d = Phaser.Math.Distance.Between(npc.x, npc.y, dummy.x, dummy.y);
        if (d < bestDist) {
          bestDist = d;
          this._target = dummy;
          this._targetType = 'dummy';
        }
      }

      if (!this._target) {
        npc.showBubble('Nothing to attack…', 2000);
        this._tasks.shift();
        return;
      }
    }

    const target = this._target;
    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, target.x, target.y);

    if (dist > ATTACK_RANGE) {
      // Try ki blast at range if we have the ability and enough ki
      if (dist <= this._getKiBlastRange() && this._targetType !== 'dummy'
          && this._tryRangedKiBlast(target, this._targetType)) {
        // Fired a ki blast — don't move closer this frame
      } else {
        npc.moveTo(target.x, target.y);
      }
    } else {
      npc.stopMoving();
      this._faceTarget(npc, target);
      npc.playAttack?.(target.x);
      this._attackCooldown = ATTACK_COOLDOWN_MS;

      const conn = scene._conn;
      if (this._targetType === 'player' && conn?.connected) {
        conn.send({ type: 'npc_attack_player', target_id: target.playerId, str: npc.str, npc_id: npc.id });
      } else if (this._targetType === 'npc' && conn?.connected) {
        conn.send({ type: 'npc_attack_npc', target_owner: target.ownerPid, target_npc_id: target.npcId, str: npc.str, npc_id: npc.id });
      } else if (this._targetType === 'dummy' && conn?.connected && target._serverId) {
        conn.send({ type: 'npc_attack_dummy', dummy_id: target._serverId, str: npc.str, npc_id: npc.id });
      } else if (this._targetType === 'dummy') {
        target.npcAttack(npc);
      }

      if (this._targetIsDown(target)) {
        const targetName = target.getName?.() || target.playerId || target.npcId || 'them';
        this._completeCombatTaskOnTargetDown(targetName);
        this._target = null;
      }
    }
  }

  // ── Train on dummy ──────────────────────────────────────────────────────────

  _doTrain(_delta) {
    const scene = this._scene;
    const npc   = this._npc;

    const dummies = (scene.dummies ?? []).filter(d => !d.isDead());
    if (dummies.length === 0) {
      // Wait for dummies — stay idle but don't remove the task
      npc.stopMoving();
      return;
    }

    if (!this._target || this._target.isDead()) {
      dummies.sort((a, b) =>
        Phaser.Math.Distance.Between(npc.x, npc.y, a.x, a.y) -
        Phaser.Math.Distance.Between(npc.x, npc.y, b.x, b.y)
      );
      this._target = dummies[0];
    }

    const target = this._target;
    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, target.x, target.y);

    if (dist > ATTACK_RANGE) {
      npc.moveTo(target.x, target.y);
    } else {
      npc.stopMoving();
      const dx = target.x - npc.x;
      const dy = target.y - npc.y;
      if (Math.abs(dx) > Math.abs(dy)) {
        npc._facing = dx > 0 ? 'right' : 'left';
      } else {
        npc._facing = dy > 0 ? 'down' : 'up';
      }
      // Attack via server if server-synced dummy, otherwise local
      const conn = this._scene._conn;
      if (conn?.connected && target._serverId) {
        npc.playAttack?.(target.x);
        conn.send({ type: 'npc_attack_dummy', dummy_id: target._serverId, str: npc.str, npc_id: npc.id });
      } else {
        target.npcAttack(npc);
      }
      if (target.isDead()) {
        this._target = null;
      }
    }
  }

  // ── Attack a specific player ────────────────────────────────────────────────

  _doAttackPlayer(_delta) {
    const scene = this._scene;
    const npc = this._npc;
    if (this._attackCooldown > 0) { this._attackCooldown -= _delta; return; }

    const cmd = this._tasks[0];
    const targetId = cmd.target_id;

    // Find the remote player
    const rp = scene._remotePlayers?.[targetId];
    if (!rp || rp.isDead?.()) {
      npc.showBubble('Target lost…', 2000);
      this._tasks.shift();
      return;
    }
    if (rp.isKnockedOut?.()) {
      this._completeCombatTaskOnTargetDown(rp.getName?.() || rp.playerId || 'them');
      return;
    }

    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, rp.x, rp.y);
    if (dist > ATTACK_RANGE) {
      if (dist <= this._getKiBlastRange() && this._tryRangedKiBlast(rp, 'player')) {
        // Fired ki blast
      } else {
        npc.moveTo(rp.x, rp.y);
      }
    } else {
      npc.stopMoving();
      this._faceTarget(npc, rp);
      npc.playAttack?.(rp.x);
      this._attackCooldown = ATTACK_COOLDOWN_MS;
      const conn = scene._conn;
      if (conn?.connected) {
        conn.send({
          type: 'npc_attack_player',
          target_id: targetId,
          str: npc.str,
          npc_id: npc.id,
        });
      }
    }
  }

  // ── Attack a specific NPC ──────────────────────────────────────────────────

  _doAttackNPC(_delta) {
    const scene = this._scene;
    const npc = this._npc;
    if (this._attackCooldown > 0) { this._attackCooldown -= _delta; return; }
    const cmd = this._tasks[0];
    const targetKey = `${cmd.target_owner}_${cmd.target_npc_id}`;

    const rnpc = scene._remoteNPCSprites?.[targetKey];
    if (!rnpc || rnpc.isDead?.()) {
      npc.showBubble('Target lost…', 2000);
      this._tasks.shift();
      return;
    }
    if (rnpc.isKnockedOut?.()) {
      this._completeCombatTaskOnTargetDown(rnpc.getName?.() || cmd.target_npc_id || 'them');
      return;
    }

    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, rnpc.x, rnpc.y);
    if (dist > ATTACK_RANGE) {
      if (dist <= this._getKiBlastRange() && this._tryRangedKiBlast(rnpc, 'npc')) {
        // Fired ki blast
      } else {
        npc.moveTo(rnpc.x, rnpc.y);
      }
    } else {
      npc.stopMoving();
      this._faceTarget(npc, rnpc);
      npc.playAttack?.(rnpc.x);
      this._attackCooldown = ATTACK_COOLDOWN_MS;
      const conn = scene._conn;
      if (conn?.connected) {
        conn.send({
          type: 'npc_attack_npc',
          target_owner: cmd.target_owner,
          target_npc_id: cmd.target_npc_id,
          str: npc.str,
          npc_id: npc.id,
        });
      }
    }
  }

  _doCarryAwayPlayer(_delta) {
    const scene = this._scene;
    const npc = this._npc;
    const cmd = this._tasks[0];
    const rp = scene._remotePlayers?.[cmd.target_id];
    const targetName = rp?.playerId || cmd.target_name || 'them';
    if (!rp || rp.isDead?.()) {
      npc.showBubble('Body got away...', 2000);
      this.setTasks([{ task: 'follow' }]);
      return;
    }
    if (!rp.isKnockedOut?.() && !this._npcIsCarryingTarget(cmd)) {
      this._finishCarryAway(cmd, targetName);
      return;
    }
    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, rp.x, rp.y);
    if (!this._npcIsCarryingTarget(cmd)) {
      if (dist > ATTACK_RANGE) {
        npc.moveTo(rp.x, rp.y);
        return;
      }
      npc.stopMoving();
      this._faceTarget(npc, rp);
      this._maybeOpportunisticRob(cmd, rp);
      scene._conn?.send({ type: 'npc_carry_player', npc_id: npc.id, target_id: cmd.target_id });
      return;
    }
    if (rp.isKnockedOut?.()) {
      if (!cmd._dest) cmd._dest = this._carryAwayDestination();
      const dd = Phaser.Math.Distance.Between(npc.x, npc.y, cmd._dest.x, cmd._dest.y);
      if (dd > TILE_SIZE * 1.2) npc.moveTo(cmd._dest.x, cmd._dest.y);
      else npc.stopMoving();
      return;
    }
    this._finishCarryAway(cmd, targetName);
  }

  _doCarryAwayNPC(_delta) {
    const scene = this._scene;
    const npc = this._npc;
    const cmd = this._tasks[0];
    const key = `${cmd.target_owner}_${cmd.target_npc_id}`;
    const rnpc = scene._remoteNPCSprites?.[key];
    const targetName = rnpc?.getName?.() || cmd.target_name || 'them';
    if (!rnpc || rnpc.isDead?.()) {
      npc.showBubble('Body got away...', 2000);
      this.setTasks([{ task: 'follow' }]);
      return;
    }
    if (!rnpc.isKnockedOut?.() && !this._npcIsCarryingTarget(cmd)) {
      this._finishCarryAway(cmd, targetName);
      return;
    }
    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, rnpc.x, rnpc.y);
    if (!this._npcIsCarryingTarget(cmd)) {
      if (dist > ATTACK_RANGE) {
        npc.moveTo(rnpc.x, rnpc.y);
        return;
      }
      npc.stopMoving();
      this._faceTarget(npc, rnpc);
      this._maybeOpportunisticRob(cmd, rnpc);
      scene._conn?.send({
        type: 'npc_carry_npc',
        npc_id: npc.id,
        owner_id: cmd.target_owner,
        target_npc_id: cmd.target_npc_id,
      });
      return;
    }
    if (rnpc.isKnockedOut?.()) {
      if (!cmd._dest) cmd._dest = this._carryAwayDestination();
      const dd = Phaser.Math.Distance.Between(npc.x, npc.y, cmd._dest.x, cmd._dest.y);
      if (dd > TILE_SIZE * 1.2) npc.moveTo(cmd._dest.x, cmd._dest.y);
      else npc.stopMoving();
      return;
    }
    this._finishCarryAway(cmd, targetName);
  }

  // ── Flee from a specific player ─────────────────────────────────────────

  _doFleePlayer(_delta) {
    const scene = this._scene;
    const npc = this._npc;
    const cmd = this._tasks[0];
    const targetId = cmd.target_id;

    if (targetId?.startsWith?.('npc:')) {
      const targetKey = cmd.target_owner && cmd.target_npc_id
        ? `${cmd.target_owner}_${cmd.target_npc_id}`
        : null;
      let target = targetKey ? scene._remoteNPCSprites?.[targetKey] : null;
      if (!target) {
        const npcId = targetId.replace('npc:', '');
        target = Object.values(scene._remoteNPCSprites || {}).find(r => r.npcId === npcId);
      }
      if (!target || target.isDead?.()) {
        this._tasks.shift();
        return;
      }

      const dist = Phaser.Math.Distance.Between(npc.x, npc.y, target.x, target.y);
      const FLEE_RANGE = TILE_SIZE * 8;
      const SAFE_RANGE = TILE_SIZE * 10;

      if (dist >= SAFE_RANGE) {
        npc.stopMoving();
        this._tasks.shift();
        return;
      }

      const dx = npc.x - target.x;
      const dy = npc.y - target.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const fleeX = npc.x + (dx / len) * FLEE_RANGE;
      const fleeY = npc.y + (dy / len) * FLEE_RANGE;

      const worldW = (scene._mapCols || 60) * TILE_SIZE;
      const worldH = (scene._mapRows || 60) * TILE_SIZE;
      npc.moveTo(
        Math.max(TILE_SIZE, Math.min(worldW - TILE_SIZE, fleeX)),
        Math.max(TILE_SIZE, Math.min(worldH - TILE_SIZE, fleeY)),
      );
      return;
    }

    const rp = scene._remotePlayers?.[targetId];
    if (!rp || rp.isDead?.()) {
      // Target gone — stop fleeing
      this._tasks.shift();
      return;
    }

    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, rp.x, rp.y);
    const FLEE_RANGE = TILE_SIZE * 8; // run until 8 tiles away
    const SAFE_RANGE = TILE_SIZE * 10; // stop fleeing at 10 tiles

    if (dist >= SAFE_RANGE) {
      // Far enough — stop fleeing
      npc.stopMoving();
      this._tasks.shift();
      return;
    }

    // Run in the opposite direction from the player
    const dx = npc.x - rp.x;
    const dy = npc.y - rp.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const fleeX = npc.x + (dx / len) * FLEE_RANGE;
    const fleeY = npc.y + (dy / len) * FLEE_RANGE;

    // Clamp to world bounds
    const worldW = (scene._mapCols || 60) * TILE_SIZE;
    const worldH = (scene._mapRows || 60) * TILE_SIZE;
    npc.moveTo(
      Math.max(TILE_SIZE, Math.min(worldW - TILE_SIZE, fleeX)),
      Math.max(TILE_SIZE, Math.min(worldH - TILE_SIZE, fleeY)),
    );
  }

  // ── Defend player ───────────────────────────────────────────────────────────

  _doDefend(_delta) {
    const scene = this._scene;
    const npc = this._npc;
    const now = Date.now();
    const THREAT_EXPIRE_MS = 30000; // threats expire after 30s

    // Clean up expired threats
    for (const key of Object.keys(scene._recentThreats || {})) {
      if (now - scene._recentThreats[key] > THREAT_EXPIRE_MS) {
        delete scene._recentThreats[key];
      }
    }

    // Only target entities that have recently attacked us
    let nearestTarget = null;
    let nearestDist = DEFEND_RANGE;

    // Check remote players that are threats
    for (const rp of Object.values(scene._remotePlayers || {})) {
      if (rp.isDead?.()) continue;
      const threatKey = `player:${rp.playerId}`;
      if (!scene._recentThreats[threatKey]) continue;
      const d = Phaser.Math.Distance.Between(npc.x, npc.y, rp.x, rp.y);
      if (d < nearestDist) {
        nearestDist = d;
        nearestTarget = { type: 'player', entity: rp, id: rp.playerId };
      }
    }

    // Check remote NPCs that are threats
    for (const [key, rnpc] of Object.entries(scene._remoteNPCSprites || {})) {
      if (rnpc.isDead?.()) continue;
      const threatKey = `npc:${key}`;
      if (!scene._recentThreats[threatKey]) continue;
      const d = Phaser.Math.Distance.Between(npc.x, npc.y, rnpc.x, rnpc.y);
      if (d < nearestDist) {
        nearestDist = d;
        nearestTarget = { type: 'npc', entity: rnpc, ownerId: rnpc.ownerPid, npcId: rnpc.npcId };
      }
    }

    if (nearestTarget && nearestDist <= ATTACK_RANGE) {
      npc.stopMoving();
      this._faceTarget(npc, nearestTarget.entity);
      npc.playAttack?.(nearestTarget.entity.x);
      const conn = scene._conn;

      if (nearestTarget.type === 'player' && conn?.connected) {
        conn.send({ type: 'npc_attack_player', target_id: nearestTarget.id, str: npc.str, npc_id: npc.id });
      } else if (nearestTarget.type === 'npc' && conn?.connected) {
        conn.send({ type: 'npc_attack_npc', target_owner: nearestTarget.ownerId, target_npc_id: nearestTarget.npcId, str: npc.str, npc_id: npc.id });
      } else if (nearestTarget.type === 'dummy' && conn?.connected && nearestTarget.entity._serverId) {
        conn.send({ type: 'npc_attack_dummy', dummy_id: nearestTarget.entity._serverId, str: npc.str, npc_id: npc.id });
      }
    } else if (nearestTarget && nearestDist <= this._getKiBlastRange()
               && nearestTarget.type !== 'dummy'
               && this._tryRangedKiBlast(nearestTarget.entity, nearestTarget.type)) {
      // Fired ki blast at threat from range
      npc.stopMoving();
    } else if (nearestTarget && nearestDist <= DEFEND_RANGE) {
      // Move toward nearest threat
      npc.moveTo(nearestTarget.entity.x, nearestTarget.entity.y);
    } else {
      // No threats — follow player
      this._doFollow(_delta);
    }
  }

  // ── Steal logs from another player's NPC ──────────────────────────────────

  _doStealLogs(_delta) {
    const scene = this._scene;
    const npc = this._npc;
    if (this._attackCooldown > 0) { this._attackCooldown -= _delta; return; }
    const cmd = this._tasks[0];
    const targetKey = `${cmd.target_owner}_${cmd.target_npc_id}`;

    const rnpc = scene._remoteNPCSprites?.[targetKey];
    if (!rnpc || rnpc.isDead?.()) {
      npc.showBubble('Target lost…', 2000);
      this._tasks.shift();
      return;
    }

    // If target has no logs, abort
    if ((rnpc.logs ?? 0) <= 0) {
      npc.showBubble('They have nothing to take…', 2000);
      this._tasks.shift();
      return;
    }

    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, rnpc.x, rnpc.y);
    if (dist > ATTACK_RANGE) {
      npc.moveTo(rnpc.x, rnpc.y);
    } else {
      npc.stopMoving();
      this._faceTarget(npc, rnpc);
      npc.playAttack?.(rnpc.x);
      this._attackCooldown = ATTACK_COOLDOWN_MS * 2; // longer cooldown for stealing

      // Steal 1-3 logs based on STR
      const stealAmount = Math.min(1 + Math.floor(Math.random() * Math.min(3, npc.str)), rnpc.logs ?? 0);

      const conn = scene._conn;
      if (conn?.connected) {
        conn.send({
          type: 'npc_steal_logs',
          target_owner: cmd.target_owner,
          target_npc_id: cmd.target_npc_id,
          str: npc.str,
          npc_id: npc.id,
          amount: stealAmount,
        });
      }

      // Add stolen logs to own inventory
      npc.logs = Math.min(npc.logs + stealAmount, npc.maxLogs);

      const stealLine = `Swiped ${stealAmount} log${stealAmount > 1 ? 's' : ''}! Heh.`;
      npc.showBubble(stealLine, 3000, { silent: true });
      scene._addNPCSpeechToChat?.(npc, stealLine, '#ffccaa');

      // Record grudge — the victim's owner will see this via events
      const brain = scene._npcBrains?.get(npc.id);
      if (brain) {
        const targetName = rnpc.getName?.() || cmd.target_npc_id;
        npc.addMemory(
          `I stole ${stealAmount} log(s) from ${targetName}.`,
          'event', `npc:${cmd.target_npc_id}`, 0.85
        );
        // Increase anger toward this NPC (they'll retaliate)
        npc.applyEmotionDeltas({ trust: -0.05, anger: 0.1 }, `npc:${cmd.target_npc_id}`);
      }

      this._tasks.shift(); // one-shot action, then return to previous behavior
    }
  }

  // ── Socialize with another player's NPC ──────────────────────────────────

  _doSocializeNPC(_delta) {
    const scene = this._scene;
    const npc = this._npc;
    const cmd = this._tasks[0];
    const targetKey = `${cmd.target_owner}_${cmd.target_npc_id}`;

    const rnpc = scene._remoteNPCSprites?.[targetKey];
    if (!rnpc || rnpc.isDead?.()) {
      npc.showBubble('They left…', 1500);
      this._tasks.shift();
      return;
    }

    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, rnpc.x, rnpc.y);
    const SOCIAL_RANGE = TILE_SIZE * 2;

    if (dist > SOCIAL_RANGE) {
      npc.moveTo(rnpc.x, rnpc.y);
    } else if (!this._socializing) {
      // Close enough — start conversation
      npc.stopMoving();
      this._faceTarget(npc, rnpc);
      this._socializing = true;

      const targetName = cmd.target_name || rnpc.getName?.() || 'fellow worker';

      // Build NPC context for conversation
      const npcACtx = {
        id: npc.id, name: npc.getName(), logs: npc.logs,
        soul: npc.soul,
      };
      const npcBCtx = {
        id: rnpc.npcId, name: targetName, logs: rnpc.logs ?? 0,
        ownerPid: rnpc.ownerPid,
        soul: {
          personality: rnpc._personality || {},
          relationships: rnpc._soul || {},
          memories: {},
          learned_phrases: [],
        },
      };

      // Fire off LLM conversation (async)
      generateNPCChat(npcACtx, npcBCtx).then(({ lines, impact }) => {
        if (lines.length === 0) {
          // Fallback if LLM fails
          npc.showBubble(`Hey ${targetName}!`, 3000);
        } else {
          // Play conversation lines with delays
          let delay = 0;
          for (const entry of lines) {
            const isOurs = entry.speakerId === npc.id;
            scene.time.delayedCall(delay, () => {
              const fromName = isOurs ? (npc.getName?.() || entry.speaker || npc.id) : (targetName || entry.speaker || rnpc.npcId);
              const toName = isOurs ? (targetName || rnpc.getName?.() || rnpc.npcId) : (npc.getName?.() || npc.id);
              if (isOurs) {
                npc.showBubble(entry.line, 4000, { silent: true });
              } else {
                // Show on the remote NPC sprite too
                rnpc.showBubble?.(entry.line, 4000);
              }
              // Log to chat
              scene._addNPCDirectedSpeechToChat?.(fromName, toName, entry.line, '#aaccff');
            });
            delay += 3000; // 3s between lines
          }
        }

        // Apply LLM-evaluated emotional impact (can be dramatic)
        const impA = impact?.npcA || { trust: 0.03, anger: -0.01 };
        const impB = impact?.npcB || { trust: 0.03, anger: -0.01 };

        npc.applyEmotionDeltas(
          { trust: impA.trust, anger: impA.anger },
          `npc:${cmd.target_npc_id}`,
        );

        // Log dramatic shifts to chat so the player notices
        if (Math.abs(impA.anger) >= 0.1 || Math.abs(impA.trust) >= 0.1) {
          const emoji = impA.anger > 0.1 ? '[angry]' : impA.trust > 0.1 ? '[happy]' : '[upset]';
          scene.chatBox?._addLog(
            `${npc.getName()} ${emoji} (trust ${impA.trust > 0 ? '+' : ''}${impA.trust.toFixed(2)}, anger ${impA.anger > 0 ? '+' : ''}${impA.anger.toFixed(2)})`,
            impA.anger > 0.1 ? '#ff6666' : '#88ddaa',
          );
        }

        // Store memory — use LLM's tag if available, otherwise summarize
        const memTag = impA.memory_tag || (lines.length > 0
          ? `Chatted with ${targetName}: "${lines[0].line}"`
          : `Had a brief chat with ${targetName}.`);
        const importance = (Math.abs(impA.trust) + Math.abs(impA.anger)) > 0.15 ? 0.85 : 0.6;
        npc.addMemory(memTag, 'relationship', `npc:${cmd.target_npc_id}`, importance);

        // Also apply impact to NPC B if it's a local NPC (same owner)
        // For remote NPCs, their owner's client will handle it
        // But we can store what B felt for display purposes
        if (impB.memory_tag) {
          scene.chatBox?._addLog(
            `${targetName} felt: ${impB.memory_tag}`,
            impB.anger > 0.1 ? '#ff8888' : '#aaddcc',
          );
        }

        // Done after all lines play out
        const finishDelay = Math.max(1000, lines.length * 3000);
        scene.time.delayedCall(finishDelay, () => {
          this._socializing = false;
          this._socializeDoneAt = Date.now();
          this._tasks.shift();
        });
      }).catch(() => {
        npc.showBubble(`Hey ${targetName}!`, 3000);
        npc.applyEmotionDeltas({ trust: 0.03, anger: -0.01 }, `npc:${cmd.target_npc_id}`);
        npc.addMemory(
          `Had a brief chat with ${targetName} while gathering wood.`,
          'relationship', `npc:${cmd.target_npc_id}`, 0.6
        );
        this._socializing = false;
        this._socializeDoneAt = Date.now();
        this._tasks.shift();
      });
    }
    // While socializing, just wait (don't shift task until conversation finishes)
  }

  // ── NPC-to-NPC interaction decision (local, no LLM) ─────────────────────

  /**
   * Decide whether this NPC should interact with a nearby remote NPC.
   * Returns a task object ({ task, target_owner, ... }) or null.
   * Uses personality traits and relationship history — no LLM needed.
   */
  _decideNPCInteraction(npc, rnpc) {
    const pers = npc.soul?.personality || {};
    const cooperation = pers.cooperation ?? 0.5;
    const aggression = pers.aggression ?? 0.3;

    // Check existing relationship with this NPC
    const relKey = `npc:${rnpc.npcId}`;
    const rel = npc.soul?.relationships?.[relKey];
    const trust = rel?.trust ?? 0.5;
    const anger = rel?.anger ?? 0;

    // Cooldown — don't interact with the same NPC too often
    const now = Date.now();
    if (!this._lastInteraction) this._lastInteraction = {};
    const lastTime = this._lastInteraction[rnpc.npcId] ?? 0;
    if (now - lastTime < 30000) return null; // 30s cooldown per NPC

    // Base chance to interact at all (~20% per check)
    if (Math.random() > 0.2) return null;

    this._lastInteraction[rnpc.npcId] = now;

    // Decide: socialize vs steal
    // High cooperation + high trust → socialize
    // High aggression + low trust or high anger → steal
    // Grudge (anger > 0.3) makes stealing much more likely
    const hasLogs = (rnpc.logs ?? 0) > 0;
    const socializeScore = cooperation * 0.6 + trust * 0.3 + (1 - aggression) * 0.1;
    let stealScore = aggression * 0.5 + (1 - cooperation) * 0.3 + anger * 0.4;
    if (!hasLogs) stealScore = 0; // can't steal if they have nothing
    if (trust > 0.7) stealScore *= 0.2; // don't steal from friends

    if (socializeScore > stealScore && socializeScore > 0.35) {
      return {
        task: 'socialize_npc',
        target_owner: rnpc.ownerPid,
        target_npc_id: rnpc.npcId,
        target_name: rnpc.getName?.() || rnpc.npcId,
      };
    } else if (stealScore > 0.3 && hasLogs) {
      return {
        task: 'steal_logs',
        target_owner: rnpc.ownerPid,
        target_npc_id: rnpc.npcId,
      };
    }

    return null;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _faceTarget(npc, target) {
    const dx = target.x - npc.x;
    const dy = target.y - npc.y;
    if (Math.abs(dx) > Math.abs(dy)) {
      npc._facing = dx > 0 ? 'right' : 'left';
    } else {
      npc._facing = dy > 0 ? 'down' : 'up';
    }
  }

  // ── Build Fence ──────────────────────────────────────────────────────────

  _doBuildFence(_delta) {
    const scene = this._scene;
    const npc = this._npc;
    const cmd = this._tasks[0];

    // Cooldown after building a fence (wait for server to process)
    if (cmd._buildCooldown > 0) {
      cmd._buildCooldown -= _delta;
      return;
    }

    // Find nearest ground log pile that doesn't already have a fence on it
    let targetX = null;
    let targetY = null;
    let bestDist = Infinity;
    for (const gi of scene.groundItems) {
      if (gi.resource !== 'Wood' && gi.resource !== 'log') continue;
      if (gi._lit) continue;
      // Skip piles that already have a fence on the same tile
      const tileCol = Math.floor(gi.x / TILE_SIZE);
      const tileRow = Math.floor(gi.y / TILE_SIZE);
      let hasFence = false;
      for (const fid of Object.keys(scene._fenceSprites || {})) {
        const f = scene._fenceSprites[fid];
        if (Math.floor(f.x / TILE_SIZE) === tileCol && Math.floor(f.y / TILE_SIZE) === tileRow) {
          hasFence = true;
          break;
        }
      }
      if (hasFence) continue;
      const d = Phaser.Math.Distance.Between(npc.x, npc.y, gi.x, gi.y);
      if (d < bestDist) {
        bestDist = d;
        targetX = gi.x;
        targetY = gi.y;
      }
    }

    if (targetX == null) {
      npc.showBubble('No more logs to build with!', 3000);
      this._tasks.shift();
      return;
    }

    // Walk to the log pile
    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, targetX, targetY);
    if (dist > TILE_SIZE * 1.2) {
      npc.moveTo(targetX, targetY);
      return;
    }

    // At the pile — send build request to server
    npc.stopMoving();
    const conn = scene._conn;
    if (conn?.connected) {
      conn.send({ type: 'build_fence', x: targetX, y: targetY });
    }
    const remaining = scene.groundItems.filter(gi =>
      (gi.resource === 'Wood' || gi.resource === 'log') && (gi.x !== targetX || gi.y !== targetY)
    ).length;
    npc.showBubble(remaining > 0 ? `Built a fence! (${remaining} more to go)` : 'Built a fence! All done.', 2000);

    // Wait for server to process before looking for next pile
    cmd._buildCooldown = 800;

    // If no more piles remain, finish the task
    if (remaining <= 0) {
      this._tasks.shift();
    }
  }

  _doLightCampfire(_delta) {
    const scene = this._scene;
    const npc = this._npc;
    const cmd = this._tasks[0];

    if (cmd._lightCooldown > 0) {
      cmd._lightCooldown -= _delta;
      return;
    }

    const candidates = (scene.groundItems || []).filter(gi =>
      (gi.resource === 'Wood' || gi.resource === 'log') &&
      !gi._lit &&
      scene._canLightCampfire?.(gi)
    );

    if (candidates.length === 0) {
      npc.showBubble('No ready campfire to light.', 2500, { silent: true });
      this._tasks.shift();
      return;
    }

    candidates.sort((a, b) =>
      Phaser.Math.Distance.Between(npc.x, npc.y, a.x, a.y) -
      Phaser.Math.Distance.Between(npc.x, npc.y, b.x, b.y)
    );

    const target = candidates[0];
    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, target.x, target.y);
    if (dist > TILE_SIZE * 1.2) {
      npc.moveTo(target.x, target.y);
      return;
    }

    npc.stopMoving();
    this._faceTarget(npc, target);
    if (scene._tryLightCampfire?.(target, npc)) {
      npc.showBubble('Lighting it now.', 2200, { silent: true });
      cmd._lightCooldown = 600;
      this._tasks.shift();
      return;
    }

    npc.showBubble('Could not light it.', 2000, { silent: true });
    this._tasks.shift();
  }

  _doGuardFire(_delta) {
    const scene = this._scene;
    const npc = this._npc;
    const cmd = this._tasks[0];

    if (this._attackCooldown > 0) this._attackCooldown -= _delta;

    let fire = null;
    if (cmd.fire_item_id) {
      fire = (scene.groundItems || []).find(gi => gi._serverId === cmd.fire_item_id && gi._lit);
    }
    if (!fire) {
      fire = scene._findNearestLitCampfire?.(npc.x, npc.y, 12) || null;
      if (fire) cmd.fire_item_id = fire._serverId;
    }

    if (!fire) {
      npc.showBubble('That fire is out.', 2200, { silent: true });
      this._tasks.shift();
      return;
    }

    cmd._warned = cmd._warned || {};
    const now = Date.now();
    let intruder = null;
    let intruderDistToFire = Infinity;
    for (const rnpc of Object.values(scene._remoteNPCSprites || {})) {
      if (rnpc.isDead?.() || rnpc.isKnockedOut?.()) continue;
      const dToFire = Phaser.Math.Distance.Between(rnpc.x, rnpc.y, fire.x, fire.y);
      if (dToFire < intruderDistToFire && dToFire <= CAMPFIRE_GUARD_WARN_RADIUS) {
        intruder = rnpc;
        intruderDistToFire = dToFire;
      }
    }

    const guardDist = Phaser.Math.Distance.Between(npc.x, npc.y, fire.x, fire.y);
    if (guardDist > TILE_SIZE * 1.5 && (!intruder || intruderDistToFire > CAMPFIRE_GUARD_ATTACK_RADIUS)) {
      npc.moveTo(fire.x, fire.y);
      return;
    }

    npc.stopMoving();

    if (!intruder) return;

    const warnKey = `${intruder.ownerPid}_${intruder.npcId}`;
    const warning = cmd._warned[warnKey] || null;
    if (warning) {
      const movingAway = intruderDistToFire > (warning.lastDistToFire ?? intruderDistToFire) + TILE_SIZE * 0.15;
      warning.lastDistToFire = intruderDistToFire;
      if (movingAway) {
        warning.leaving = true;
      }
      if (intruderDistToFire > CAMPFIRE_GUARD_WARN_RADIUS) {
        if (warning.leaving) {
          const name = intruder.getName?.() || intruder.npcId || 'them';
          const line = `${name} is leaving the fire alone.`;
          npc.showBubble(line, 2200, { silent: true });
          scene._addNPCSpeechToChat?.(npc, line, '#cce8aa');
        }
        delete cmd._warned[warnKey];
        return;
      }
      if (warning.complies && intruderDistToFire <= CAMPFIRE_GUARD_WARN_RADIUS) {
        const gotCloserThanWarned = intruderDistToFire < (warning.warnDistToFire ?? intruderDistToFire) - TILE_SIZE * 0.15;
        if (!gotCloserThanWarned) {
          if (!warning.remindedAt || now - warning.remindedAt > 4000) {
            const line = `${intruder.getName?.() || intruder.npcId || 'You'}, keep your distance from the fire.`;
            npc.showBubble(line, 2200, { silent: true });
            scene._addNPCSpeechToChat?.(npc, line, '#ffd39a');
            warning.remindedAt = now;
          }
          return;
        }
      }
    }

    if (intruderDistToFire <= CAMPFIRE_GUARD_WARN_RADIUS && !warning) {
      const name = intruder.getName?.() || intruder.npcId || 'you';
      const line = `${name}, back off. This fire is claimed.`;
      npc.showBubble(line, 2800, { silent: true });
      scene._addNPCSpeechToChat?.(npc, line, '#ffd39a');
      cmd._warned[warnKey] = {
        warnedAt: now,
        warnDistToFire: intruderDistToFire,
        lastDistToFire: intruderDistToFire,
        leaving: false,
        complies: false,
        awaitingResponse: true,
        response: '',
      };
      scene._conn?.send({
        type: 'chat_to_npc',
        target_owner: intruder.ownerPid,
        target_npc_id: intruder.npcId,
        text: line,
        meta: {
          type: 'fire_warning',
          fire_item_id: cmd.fire_item_id || fire._serverId || null,
          fire_x: fire.x,
          fire_y: fire.y,
          guard_npc_id: npc.id,
          guard_npc_name: npc.getName?.() || npc.id,
          leave_distance_tiles: 5,
        },
      });
      return;
    }

    if (intruderDistToFire > CAMPFIRE_GUARD_ATTACK_RADIUS) return;
    if (!warning) return;
    if (warning.leaving) return;
    if (warning.complies) {
      const gotCloserThanWarned = intruderDistToFire < (warning.warnDistToFire ?? intruderDistToFire) - TILE_SIZE * 0.15;
      if (!gotCloserThanWarned) return;
    }
    if (warning.awaitingResponse) return;
    if (now - warning.warnedAt < CAMPFIRE_GUARD_RESPONSE_MS) return;
    if (this._attackCooldown > 0) return;

    const distToIntruder = Phaser.Math.Distance.Between(npc.x, npc.y, intruder.x, intruder.y);
    if (distToIntruder > ATTACK_RANGE) {
      npc.moveTo(intruder.x, intruder.y);
      return;
    }

    npc.stopMoving();
    this._faceTarget(npc, intruder);
    npc.playAttack?.(intruder.x);
    this._attackCooldown = ATTACK_COOLDOWN_MS;
    scene._conn?.send({
      type: 'npc_attack_npc',
      target_owner: intruder.ownerPid,
      target_npc_id: intruder.npcId,
      str: npc.str,
      npc_id: npc.id,
    });
  }

  handleFireWarningReply(warnKey, response = {}) {
    const cmd = this._tasks[0];
    if (!cmd || cmd.task !== 'guard_fire' || !warnKey) return;
    cmd._warned = cmd._warned || {};
    const warning = cmd._warned[warnKey];
    if (!warning) return;
    warning.awaitingResponse = false;
    warning.complies = !!response.complies;
    warning.leaving = !!response.complies;
    warning.response = response.reply || '';
  }

  _doMoveAwayFromFire(_delta) {
    const npc = this._npc;
    const cmd = this._tasks[0];
    const minDistance = Math.max(TILE_SIZE * 3, Number(cmd.min_distance || TILE_SIZE * 5));
    const dx = npc.x - Number(cmd.fire_x || 0);
    const dy = npc.y - Number(cmd.fire_y || 0);
    const dist = Math.hypot(dx, dy);
    const durationMs = Number(cmd.duration_ms || 5000);
    cmd.startedAt = cmd.startedAt || Date.now();

    if (dist >= minDistance || Date.now() - cmd.startedAt >= durationMs) {
      npc.stopMoving();
      this._tasks.shift();
      return;
    }

    const len = Math.max(1, dist);
    const dirX = dist < 4 ? 1 : dx / len;
    const dirY = dist < 4 ? 0 : dy / len;
    const targetX = npc.x + dirX * TILE_SIZE * 2;
    const targetY = npc.y + dirY * TILE_SIZE * 2;
    npc.moveTo(targetX, targetY);
  }

  // ── Learn Ki ──────────────────────────────────────────────────────────────

  _doLearnKi(_delta) {
    const scene = this._scene;
    const npc = this._npc;
    const cmd = this._tasks[0];

    // Already learned? Done.
    if (npc._hasKiBlast) {
      npc.showBubble('I already know Ki Blast!', 3000);
      this._tasks.shift();
      return;
    }

    // Phase 0: Initialize — remember where the player was when the command was given
    if (!cmd._learnPhase) {
      cmd._learnPhase = 'gather';
      cmd._targetX = scene.player?.x ?? npc.x;
      cmd._targetY = scene.player?.y ?? npc.y;
      cmd._logsNeeded = 10;
      cmd._originalLogs = npc.logs;
      npc.showBubble('I\'ll gather wood for a Ki Target!', 3000);
      scene._addNPCSpeechToChat?.(npc, 'Starting ki training — gathering wood for a Ki Target.', '#ffccaa');
    }

    switch (cmd._learnPhase) {
      case 'gather':
        this._learnKi_gather(cmd, _delta);
        break;
      case 'return':
        this._learnKi_return(cmd, _delta);
        break;
      case 'build':
        this._learnKi_build(cmd, _delta);
        break;
      case 'step_back':
        this._learnKi_stepBack(cmd, _delta);
        break;
      case 'watch':
        this._learnKi_watch(cmd, _delta);
        break;
    }
  }

  _learnKi_gather(cmd, _delta) {
    const npc = this._npc;
    const scene = this._scene;

    // Check if we have enough logs
    if (npc.logs >= 10) {
      cmd._learnPhase = 'return';
      npc.showBubble('Got enough logs! Heading back to build the target.', 3000);
      return;
    }

    // Cooldown after chopping
    if (this._chopCooldown > 0) {
      this._chopCooldown -= _delta;
      npc.stopMoving();
      return;
    }

    // Find nearest tree
    if (!this._target || this._target._chopped) {
      const trees = (scene.trees ?? []).filter(t => !t._chopped);
      if (trees.length === 0) {
        npc.showBubble('No trees! Need logs for the Ki Target.', 3000);
        npc.stopMoving();
        return;
      }
      trees.sort((a, b) =>
        Phaser.Math.Distance.Between(npc.x, npc.y, a.x, a.y) -
        Phaser.Math.Distance.Between(npc.x, npc.y, b.x, b.y)
      );
      this._target = trees[0];
    }

    const tree = this._target;
    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, tree.x, tree.y);
    if (dist > TREE_CHOP_DIST) {
      npc.moveTo(tree.x, tree.y);
    } else {
      npc.stopMoving();
      if (!tree._chopped) {
        const conn = scene._conn;
        if (conn?.connected && tree.treeIndex >= 0) {
          conn.send({ type: 'npc_chop', tree_id: tree.treeIndex, owner_id: scene.playerId });
        }
        npc.logs = Math.min(npc.logs + 1, npc.maxLogs);
        npc.showBubble(`Chopping for Ki Target (${npc.logs}/10)`, 1500, { silent: true });
        this._chopCooldown = 1500;
      }
      this._target = null;
    }
  }

  _learnKi_return(cmd, _delta) {
    const npc = this._npc;
    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, cmd._targetX, cmd._targetY);
    if (dist > TILE_SIZE * 1.5) {
      npc.moveTo(cmd._targetX, cmd._targetY);
    } else {
      npc.stopMoving();
      cmd._learnPhase = 'build';
      cmd._buildTimer = 2000; // 2s build animation
      npc.showBubble('Building the Ki Target...', 2500);
    }
  }

  _learnKi_build(cmd, _delta) {
    const npc = this._npc;
    const scene = this._scene;
    cmd._buildTimer -= _delta;
    if (cmd._buildTimer > 0) return;

    // Build ki target via server
    const conn = scene._conn;
    if (conn?.connected) {
      // Place it 2 tiles ahead of the NPC
      const dx = cmd._targetX - npc.x;
      const dy = cmd._targetY - npc.y;
      const len = Math.max(1, Math.hypot(dx, dy));
      const buildX = npc.x + (dx / len) * TILE_SIZE * 2;
      const buildY = npc.y + (dy / len) * TILE_SIZE * 2;

      // Transfer NPC's logs to player, then build (server deducts from player)
      const logsToGive = Math.min(npc.logs, 10);
      npc.logs = Math.max(0, npc.logs - 10);
      npc._givingLogs = true;
      conn.send({ type: 'admin', field: 'logs', value: logsToGive });
      conn.send({
        type: 'build_ki_target',
        x: buildX,
        y: buildY,
      });

      cmd._kiTargetX = buildX;
      cmd._kiTargetY = buildY;
      cmd._learnPhase = 'step_back';
      npc.showBubble('Ki Target built! Stepping back to observe.', 3000);
      scene._addNPCSpeechToChat?.(npc, 'Ki Target is ready! Show me your blast!', '#ffccaa');
    }
  }

  _learnKi_stepBack(cmd, _delta) {
    const npc = this._npc;
    // Step back ~3 tiles from the ki target
    const dx = npc.x - cmd._kiTargetX;
    const dy = npc.y - cmd._kiTargetY;
    const dist = Math.hypot(dx, dy);

    if (dist < TILE_SIZE * 3) {
      // Move away from the ki target
      const len = Math.max(1, dist);
      const stepX = npc.x + (dx / len) * TILE_SIZE * 2;
      const stepY = npc.y + (dy / len) * TILE_SIZE * 2;
      npc.moveTo(stepX, stepY);
    } else {
      npc.stopMoving();
      // Face toward the ki target
      if (Math.abs(dx) > Math.abs(dy)) {
        npc._facing = dx > 0 ? 'left' : 'right';
      } else {
        npc._facing = dy > 0 ? 'up' : 'down';
      }
      cmd._learnPhase = 'watch';
      cmd._watchTimer = 0;

      // Mark this NPC as watching the nearest ki target
      this._findAndWatchKiTarget(cmd);

      npc.showBubble('Ready! Blast the Ki Target!', 3000);
    }
  }

  _findAndWatchKiTarget(cmd, excludeId) {
    const scene = this._scene;
    const npc = this._npc;
    // Find nearest ki target sprite (optionally excluding one that just broke)
    let bestDist = Infinity;
    let bestId = null;
    for (const [ktid, ktSprite] of Object.entries(scene._kiTargetSprites || {})) {
      if (ktid === excludeId) continue;
      const d = Phaser.Math.Distance.Between(npc.x, npc.y, ktSprite.x, ktSprite.y);
      if (d < bestDist) {
        bestDist = d;
        bestId = ktid;
      }
    }
    npc._watchingKiTarget = bestId;
  }

  _learnKi_watch(cmd, _delta) {
    const npc = this._npc;
    const scene = this._scene;
    cmd._watchTimer = (cmd._watchTimer || 0) + _delta;

    // If NPC learned ki blast (set by _handleKiTargetResult), we're done!
    if (npc._hasKiBlast) {
      npc._watchingKiTarget = null;
      this._tasks.shift();
      npc.showBubble('I mastered the Ki Blast! Thank you, master!', 5000);
      scene._addNPCSpeechToChat?.(npc, 'Ki training complete! I can now use Ki Blast!', '#44eeff');
      return;
    }

    // Check if the ki target still exists
    const targetId = npc._watchingKiTarget;
    const hasTarget = targetId && scene._kiTargetSprites[targetId];

    // If we had a target and it's gone, OR we never found one — rebuild
    if (!hasTarget) {
      // Broke acknowledgment: show reaction, then wait before rebuilding
      if (!cmd._brokeAckTimer) {
        // First frame noticing it's gone — react
        const brokeId = targetId; // remember which one broke (might still be in sprites briefly)
        npc._watchingKiTarget = null;

        // Try to re-find a nearby ki target first (maybe one was placed manually)
        this._findAndWatchKiTarget(cmd, brokeId);
        if (npc._watchingKiTarget && scene._kiTargetSprites[npc._watchingKiTarget]) {
          npc.showBubble('Found a Ki Target! Watching...', 2500);
          return;
        }

        // No target — show disappointment and pause before rebuilding
        const breakLines = [
          'Damn... maybe next time.',
          'So close! I almost had it...',
          'Tch, the target crumbled. I need more practice.',
          'Not yet... but I\'m getting closer, I can feel it.',
          'Ugh, shattered again. One more try!',
          'The energy slipped away... build another one!',
        ];
        npc.showBubble(breakLines[Math.floor(Math.random() * breakLines.length)], 3500);
        cmd._brokeAckTimer = 3500; // wait for the bubble to display
        return;
      }

      // Count down the ack timer
      cmd._brokeAckTimer -= _delta;
      if (cmd._brokeAckTimer > 0) return;
      delete cmd._brokeAckTimer;

      // Update target position to player's current location for rebuild
      const player = scene.player;
      if (player) {
        cmd._targetX = player.x;
        cmd._targetY = player.y;
      }

      // Now transition to rebuild
      npc.showBubble('I\'ll build another one!', 2500);
      if (npc.logs >= 10) {
        cmd._learnPhase = 'build';
        cmd._buildTimer = 2000;
      } else {
        cmd._learnPhase = 'gather';
      }
      return;
    }

    // Periodic commentary while watching
    if (cmd._watchTimer > 8000) {
      cmd._watchTimer = 0;
      const lines = [
        'I\'m studying your technique...',
        'Keep blasting! I\'m watching carefully.',
        'Show me that energy again!',
        'Almost getting it... I think...',
        'The way you channel ki is fascinating.',
        'Hit the target! I need to see more!',
      ];
      npc.showBubble(lines[Math.floor(Math.random() * lines.length)], 2500, { silent: true });
    }
  }

  // ── Ranged Ki Blast helper (used by combat methods) ─────────────────────────

  /**
   * Attempt a ranged ki blast at a target during combat.
   * Returns true if a blast was fired, false otherwise.
   */
  _tryRangedKiBlast(target, targetType) {
    const npc = this._npc;
    if (!npc._hasKiBlast) return false;
    if (this._kiBlastCooldown > 0) return false;
    if (!npc.infKi && npc.ki < npc.getBlastCost()) return false;

    npc.stopMoving();
    this._faceTarget(npc, target);
    const fired = this._npcFireKiBlast(target, targetType);
    if (fired) {
      this._kiBlastCooldown = this._getKiBlastCooldownMs();
    }
    return fired;
  }

  _getKiShotUpgrade(stat) {
    return Number(this._npc?.kiUpgrades?.ki_shot?.[stat] || 0);
  }

  _getKiBlastCooldownMs() {
    return Math.max(150, KI_BLAST_COOLDOWN_MS * (1 - this._getKiShotUpgrade('cooldown') * 0.01));
  }

  _getKiBlastRange() {
    return KI_BLAST_RANGE * (1 + this._getKiShotUpgrade('range') * 0.01);
  }

  _getKiBlastProjectileSpeed() {
    return 400 * (1 + this._getKiShotUpgrade('speed') * 0.01);
  }

  // ── Show Blast (demonstrate ki blast on command) ────────────────────────────

  _doShowBlast(_delta) {
    const npc = this._npc;

    if (!npc._hasKiBlast) {
      npc.showBubble('I haven\'t learned any blasts yet...', 3000);
      this._tasks.shift();
      return;
    }

    if (!npc.infKi && npc.ki < npc.getBlastCost()) {
      npc.showBubble('Not enough ki energy right now...', 3000);
      this._tasks.shift();
      return;
    }

    // Face away from player (safe direction)
    const player = this._scene.player;
    if (player) {
      const dx = npc.x - player.x;
      const dy = npc.y - player.y;
      if (Math.abs(dx) > Math.abs(dy)) {
        npc._facing = dx > 0 ? 'right' : 'left';
      } else {
        npc._facing = dy > 0 ? 'down' : 'up';
      }
    }

    npc.stopMoving();
    npc.showBubble('Watch this!', 2000);
    this._npcFireKiBlast(null, null);
    this._tasks.shift();
  }

  // ── Practice Ki (NPC self-trains: gather → build → blast → repeat) ─────────

  _doPracticeKi(_delta) {
    const scene = this._scene;
    const npc = this._npc;
    const cmd = this._tasks[0];

    if (!npc._hasKiBlast) {
      npc.showBubble('I need to learn Ki Blast first!', 3000);
      this._tasks.shift();
      return;
    }

    // Initialize
    if (!cmd._practicePhase) {
      cmd._practicePhase = 'gather';
      cmd._practiceRounds = 0;
      cmd._practiceMaxRounds = 3 + Math.floor(Math.random() * 3); // 3-5 rounds
      cmd._targetX = scene.player?.x ?? npc.x;
      cmd._targetY = scene.player?.y ?? npc.y;
      npc.showBubble(`Time to practice! ${cmd._practiceMaxRounds} rounds.`, 3000);
      scene._addNPCSpeechToChat?.(npc, 'Starting ki blast practice!', '#66bbff');
    }

    // Check if all rounds complete
    if (cmd._practiceRounds >= cmd._practiceMaxRounds) {
      npc.showBubble('Good practice session!', 3000);
      scene._addNPCSpeechToChat?.(npc, `Finished ${cmd._practiceRounds} rounds of ki practice.`, '#66bbff');
      this._tasks.shift();
      return;
    }

    switch (cmd._practicePhase) {
      case 'gather':
        this._practiceKi_gather(cmd, _delta);
        break;
      case 'return':
        this._practiceKi_return(cmd, _delta);
        break;
      case 'build':
        this._practiceKi_build(cmd, _delta);
        break;
      case 'step_back':
        this._practiceKi_stepBack(cmd, _delta);
        break;
      case 'blast':
        this._practiceKi_blast(cmd, _delta);
        break;
    }
  }

  _practiceKi_gather(cmd, _delta) {
    const npc = this._npc;
    const scene = this._scene;

    if (npc.logs >= 10) {
      cmd._practicePhase = 'return';
      npc.showBubble('Got the logs! Building a target.', 2000);
      return;
    }

    // Inline gather logic (same as _learnKi_gather but without phase transition)
    if (this._chopCooldown > 0) {
      this._chopCooldown -= _delta;
      npc.stopMoving();
      return;
    }

    if (!this._target || this._target._chopped) {
      const trees = (scene.trees ?? []).filter(t => !t._chopped);
      if (trees.length === 0) {
        npc.showBubble('No trees around...', 3000);
        npc.stopMoving();
        return;
      }
      trees.sort((a, b) =>
        Phaser.Math.Distance.Between(npc.x, npc.y, a.x, a.y) -
        Phaser.Math.Distance.Between(npc.x, npc.y, b.x, b.y)
      );
      this._target = trees[0];
    }

    const tree = this._target;
    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, tree.x, tree.y);
    if (dist > TREE_CHOP_DIST) {
      npc.moveTo(tree.x, tree.y);
    } else {
      npc.stopMoving();
      if (!tree._chopped) {
        const conn = scene._conn;
        if (conn?.connected && tree.treeIndex >= 0) {
          conn.send({ type: 'npc_chop', tree_id: tree.treeIndex, owner_id: scene.playerId });
        }
        npc.logs = Math.min(npc.logs + 1, npc.maxLogs);
        npc.showBubble(`Chopping (${npc.logs}/10)`, 1500, { silent: true });
        this._chopCooldown = 1500;
      }
      this._target = null;
    }
  }

  _practiceKi_return(cmd, _delta) {
    const npc = this._npc;
    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, cmd._targetX, cmd._targetY);
    if (dist > TILE_SIZE * 1.5) {
      npc.moveTo(cmd._targetX, cmd._targetY);
    } else {
      npc.stopMoving();
      cmd._practicePhase = 'build';
      cmd._buildTimer = 2000;
      npc.showBubble('Building target...', 2000);
    }
  }

  _practiceKi_build(cmd, _delta) {
    const npc = this._npc;
    const scene = this._scene;
    cmd._buildTimer -= _delta;
    if (cmd._buildTimer > 0) return;

    const conn = scene._conn;
    if (conn?.connected) {
      const dx = cmd._targetX - npc.x;
      const dy = cmd._targetY - npc.y;
      const len = Math.max(1, Math.hypot(dx, dy));
      const buildX = npc.x + (dx / len) * TILE_SIZE * 2;
      const buildY = npc.y + (dy / len) * TILE_SIZE * 2;

      const logsToGive = Math.min(npc.logs, 10);
      npc.logs = Math.max(0, npc.logs - 10);
      npc._givingLogs = true;
      conn.send({ type: 'admin', field: 'logs', value: logsToGive });
      conn.send({ type: 'build_ki_target', x: buildX, y: buildY });

      cmd._kiTargetX = buildX;
      cmd._kiTargetY = buildY;
      cmd._practicePhase = 'step_back';
      npc.showBubble('Target ready!', 2000);
    }
  }

  _practiceKi_stepBack(cmd, _delta) {
    const npc = this._npc;
    const dx = npc.x - cmd._kiTargetX;
    const dy = npc.y - cmd._kiTargetY;
    const dist = Math.hypot(dx, dy);

    if (dist < TILE_SIZE * 3) {
      const len = Math.max(1, dist);
      npc.moveTo(npc.x + (dx / len) * TILE_SIZE * 2, npc.y + (dy / len) * TILE_SIZE * 2);
    } else {
      npc.stopMoving();
      // Face toward the ki target
      if (Math.abs(dx) > Math.abs(dy)) {
        npc._facing = dx > 0 ? 'left' : 'right';
      } else {
        npc._facing = dy > 0 ? 'up' : 'down';
      }
      cmd._practicePhase = 'blast';
      cmd._blastTimer = 0;
      cmd._blastsThisRound = 0;

      // Find the ki target we just built
      this._findAndWatchKiTarget(cmd);
      npc.showBubble('Here goes!', 1500);
    }
  }

  _practiceKi_blast(cmd, _delta) {
    const npc = this._npc;
    const scene = this._scene;
    cmd._blastTimer = (cmd._blastTimer || 0) + _delta;

    // Find the ki target sprite
    const targetId = npc._watchingKiTarget;
    const ktSprite = targetId ? scene._kiTargetSprites[targetId] : null;

    if (!ktSprite) {
      // Target gone (broke) — round over
      npc._watchingKiTarget = null;
      cmd._practiceRounds++;
      const remaining = cmd._practiceMaxRounds - cmd._practiceRounds;
      if (remaining > 0) {
        const lines = [
          `Broke it! ${remaining} more round${remaining > 1 ? 's' : ''} to go.`,
          `Shattered! Again! (${remaining} left)`,
          `Ha! Let me build another one.`,
        ];
        npc.showBubble(lines[Math.floor(Math.random() * lines.length)], 2500);
        // Update target position to player's current spot
        const player = scene.player;
        if (player) {
          cmd._targetX = player.x;
          cmd._targetY = player.y;
        }
        cmd._practicePhase = 'gather';
      }
      return;
    }

    // Blast every 1.5s
    if (cmd._blastTimer >= 1500) {
      cmd._blastTimer = 0;

      if (!npc.infKi && npc.ki < npc.getBlastCost()) {
        // Wait for ki regen
        const lines = ['Recharging...', 'Need more ki...', 'Almost ready...'];
        npc.showBubble(lines[Math.floor(Math.random() * lines.length)], 1200, { silent: true });
        return;
      }

      this._faceTarget(npc, ktSprite);
      this._npcFireKiBlast(ktSprite, 'ki_target');
      cmd._blastsThisRound++;

      const commentary = [
        'Hya!', 'Take that!', 'Ki Blast!', 'Pow!', 'Focus...!',
      ];
      npc.showBubble(commentary[Math.floor(Math.random() * commentary.length)], 1000, { silent: true });
    }
  }

  // ── Pickup Stone ───────────────────────────────────────────────────────────

  _doPickupStone(_delta) {
    const scene = this._scene;
    const npc = this._npc;
    const cmd = this._tasks[0];

    // Cooldown after pickup
    if (cmd._pickupCooldown > 0) {
      cmd._pickupCooldown -= _delta;
      return;
    }

    // Find target stone ground item — use the one specified in the command, or nearest
    let stoneItem = null;
    if (cmd._targetItemId) {
      stoneItem = (scene.groundItems || []).find(gi =>
        gi._serverId === cmd._targetItemId && gi.resource === 'Stone'
      );
    }
    if (!stoneItem) {
      // Find nearest stone on ground
      let bestDist = Infinity;
      for (const gi of (scene.groundItems || [])) {
        if (gi.resource !== 'Stone') continue;
        if (!gi._placed) continue;
        const d = Phaser.Math.Distance.Between(npc.x, npc.y, gi.x, gi.y);
        if (d < bestDist) {
          bestDist = d;
          stoneItem = gi;
        }
      }
    }

    if (!stoneItem) {
      npc.showBubble('No stone to pick up!', 2000);
      this._tasks.shift();
      return;
    }

    // Walk to the stone
    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, stoneItem.x, stoneItem.y);
    if (dist > TILE_SIZE * 1.2) {
      npc.moveTo(stoneItem.x, stoneItem.y);
      return;
    }

    // Close enough — pick up all stone from this tile
    npc.stopMoving();
    const tileCol = Math.floor(stoneItem.x / TILE_SIZE);
    const tileRow = Math.floor(stoneItem.y / TILE_SIZE);
    let amount = 0;
    for (const gi of (scene.groundItems || [])) {
      if (gi.resource !== 'Stone' || !gi._placed) continue;
      if (Math.floor(gi.x / TILE_SIZE) !== tileCol || Math.floor(gi.y / TILE_SIZE) !== tileRow) continue;
      amount += gi.amount || 1;
    }
    const conn = scene._conn;
    if (conn?.connected) {
      conn.send({ type: 'npc_pickup_stone_tile', x: stoneItem.x, y: stoneItem.y, npc_id: npc.id });
    }
    npc.stones = (npc.stones || 0) + amount;
    npc.showBubble(`Picked up ${amount} stone!`, 2000);
    this._tasks.shift();
  }

  // ── Refine Stone ──────────────────────────────────────────────────────────

  _doRefineStone(_delta) {
    const scene = this._scene;
    const npc = this._npc;
    const cmd = this._tasks[0];

    // Initialize phase
    if (!cmd._refinePhase) cmd._refinePhase = 'find_anvil';

    switch (cmd._refinePhase) {
      case 'find_anvil':   this._refine_findAnvil(cmd); break;
      case 'walk_to_anvil': this._refine_walkToAnvil(cmd); break;
      case 'refining':     this._refine_refining(cmd, _delta); break;
      case 'wait_for_player': this._refine_waitForPlayer(cmd, _delta); break;
      case 'walk_to_player': this._refine_walkToPlayer(cmd); break;
      case 'report':       this._refine_report(cmd); break;
      default:
        this._tasks.shift();
    }
  }

  _refine_findAnvil(cmd) {
    const scene = this._scene;
    const npc = this._npc;

    if ((npc.stones || 0) < 1) {
      npc.showBubble("I don't have any stone to refine!", 2500);
      this._tasks.shift();
      return;
    }

    // Find nearest anvil
    let bestDist = Infinity;
    let bestAnvil = null;
    for (const [aid, sprite] of Object.entries(scene._anvilSprites || {})) {
      const d = Phaser.Math.Distance.Between(npc.x, npc.y, sprite.x, sprite.y);
      if (d < bestDist) {
        bestDist = d;
        bestAnvil = { id: aid, x: sprite.x, y: sprite.y };
      }
    }

    if (!bestAnvil) {
      npc.showBubble("I can't find an anvil!", 2500);
      this._tasks.shift();
      return;
    }

    cmd._anvilId = bestAnvil.id;
    cmd._anvilX = bestAnvil.x;
    cmd._anvilY = bestAnvil.y;
    cmd._totalBastalite = 0;
    cmd._totalCrystalPristine = 0;
    cmd._totalCrystalNormal = 0;
    cmd._totalCrystalPoor = 0;
    cmd._refineCount = 0;
    cmd._refinePhase = 'walk_to_anvil';
    npc.showBubble('Heading to the anvil!', 2000);
  }

  _refine_walkToAnvil(cmd) {
    const npc = this._npc;
    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, cmd._anvilX, cmd._anvilY);
    if (dist > TILE_SIZE * 1.2) {
      npc.moveTo(cmd._anvilX, cmd._anvilY);
    } else {
      npc.stopMoving();
      cmd._refinePhase = 'refining';
      cmd._refineCooldown = 0;
      npc.showBubble('Time to refine!', 1500);
    }
  }

  _refine_refining(cmd, _delta) {
    const npc = this._npc;
    const scene = this._scene;

    cmd._refineCooldown = (cmd._refineCooldown || 0) - _delta;
    if (cmd._refineCooldown > 0) return;

    // Out of stones — done refining
    if ((npc.stones || 0) < 1) {
      npc.showBubble('All out of stone!', 2000);
      cmd._refinePhase = 'wait_for_player';
      cmd._waitTimer = 0;
      return;
    }

    // Check anvil still exists
    const anvilSprite = scene._anvilSprites?.[cmd._anvilId];
    if (!anvilSprite) {
      npc.showBubble('The anvil is gone!', 2000);
      cmd._refinePhase = 'wait_for_player';
      cmd._waitTimer = 0;
      return;
    }

    // Refine one stone
    const conn = scene._conn;
    if (conn?.connected) {
      conn.send({ type: 'npc_refine_rock', anvil_id: cmd._anvilId, npc_id: npc.id });
    }

    // Client-side prediction: decrement stone, we'll get exact results from server
    npc.stones = Math.max(0, (npc.stones || 0) - 1);
    cmd._refineCount++;

    // Check server refine result for tracking totals
    // (The server sends _refine_result which gets displayed via _handleRefineResult)

    const commentary = [
      'Refining...', 'Hammering away...', 'Let\'s see what we get...',
      'Working the stone...', 'Almost...', 'Clang!',
    ];
    npc.showBubble(commentary[Math.floor(Math.random() * commentary.length)], 1000, { silent: true });
    cmd._refineCooldown = 1200; // 1.2s between refines
  }

  _refine_waitForPlayer(cmd, _delta) {
    const npc = this._npc;
    const scene = this._scene;
    const player = scene.player;
    if (!player) return;

    cmd._waitTimer = (cmd._waitTimer || 0) + _delta;

    // Check if player is within 5 tiles
    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, player.x, player.y);
    if (dist <= TILE_SIZE * 5) {
      cmd._refinePhase = 'walk_to_player';
      return;
    }

    // Idle look around every 5s
    if (cmd._waitTimer > 5000) {
      cmd._waitTimer = 0;
      const lines = [
        'Waiting for the boss...', 'Where\'d they go?',
        'I\'ll wait here...', 'Finished refining!',
      ];
      npc.showBubble(lines[Math.floor(Math.random() * lines.length)], 2500, { silent: true });
    }
  }

  _refine_walkToPlayer(cmd) {
    const npc = this._npc;
    const player = this._scene.player;
    if (!player) return;

    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, player.x, player.y);
    if (dist > FOLLOW_LEASH) {
      npc.moveTo(player.x, player.y);
    } else {
      npc.stopMoving();
      cmd._refinePhase = 'report';
    }
  }

  _refine_report(cmd) {
    const npc = this._npc;
    const scene = this._scene;

    // Transfer materials to player via server
    const conn = scene._conn;
    if (conn?.connected) {
      conn.send({ type: 'npc_give_materials', npc_id: npc.id });
    }

    // Build report message from NPC's current inventory
    const parts = [];
    if (npc.bastalite > 0) parts.push(`${npc.bastalite} Bastalite`);
    if (npc.crystalPristine > 0) parts.push(`${npc.crystalPristine} Pristine Crystal`);
    if (npc.crystalNormal > 0) parts.push(`${npc.crystalNormal} Ki Crystal`);
    if (npc.crystalPoor > 0) parts.push(`${npc.crystalPoor} Cracked Crystal`);

    let msg;
    if (parts.length > 0) {
      msg = `Done refining ${cmd._refineCount} stone! Got: ${parts.join(', ')}. Here you go!`;
    } else {
      msg = `Refined ${cmd._refineCount} stone but didn't find anything good. Sorry boss!`;
    }

    npc.showBubble(msg, 5000);
    scene.chatBox?._addLog(`${npc.getName()}: ${msg}`, '#44eeff');

    // Clear NPC materials (server already transferred them)
    npc.bastalite = 0;
    npc.crystalPristine = 0;
    npc.crystalNormal = 0;
    npc.crystalPoor = 0;
    npc.stones = 0;

    this._tasks.shift();
  }

  // ── Give Materials ────────────────────────────────────────────────────────

  _doGiveMaterials(_delta) {
    const scene = this._scene;
    const npc = this._npc;
    const player = scene.player;
    if (!player) return;

    const hasMats = (npc.bastalite || 0) + (npc.crystalPristine || 0) +
                    (npc.crystalNormal || 0) + (npc.crystalPoor || 0) +
                    (npc.stones || 0);
    if (hasMats <= 0) {
      npc.showBubble("I don't have any materials to give!", 2000);
      this._tasks.shift();
      return;
    }

    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, player.x, player.y);
    if (dist > FOLLOW_LEASH) {
      npc.moveTo(player.x, player.y);
    } else {
      npc.stopMoving();
      const conn = scene._conn;
      if (conn?.connected) {
        conn.send({ type: 'npc_give_materials', npc_id: npc.id });
      }

      const parts = [];
      if (npc.bastalite > 0) parts.push(`${npc.bastalite} Bastalite`);
      if (npc.crystalPristine > 0) parts.push(`${npc.crystalPristine} Pristine Crystal`);
      if (npc.crystalNormal > 0) parts.push(`${npc.crystalNormal} Ki Crystal`);
      if (npc.crystalPoor > 0) parts.push(`${npc.crystalPoor} Cracked Crystal`);
      if (npc.stones > 0) parts.push(`${npc.stones} Stone`);

      npc.showBubble(`Here's what I have: ${parts.join(', ')}!`, 4000);

      npc.bastalite = 0;
      npc.crystalPristine = 0;
      npc.crystalNormal = 0;
      npc.crystalPoor = 0;
      npc.stones = 0;

      this._tasks.shift();
    }
  }

  _doMeditate(_delta) {
    const npc = this._npc;
    const scene = this._scene;
    const cmd = this._tasks[0] || {};
    if (npc.meditating) {
      this._tasks.shift();
      return;
    }
    if ((npc.kiSkillLevel ?? 1) < 10) {
      const line = 'I need stronger ki before I can meditate.';
      npc.showBubble(line, 2600, { silent: true });
      scene._addNPCSpeechToChat?.(npc, line);
      this._tasks.shift();
      return;
    }
    scene._conn?.send({
      type: 'npc_meditate',
      npc_id: npc.id,
      crystal_quality: cmd.crystal_quality || undefined,
    });
    const line = cmd.crystal_quality
      ? `Meditating with a ${cmd.crystal_quality} crystal.`
      : 'Beginning meditation.';
    npc.showBubble(line, 2600, { silent: true });
    scene._addNPCSpeechToChat?.(npc, line);
    this._tasks.shift();
  }

  // ── NPC Ki Blast (visual + server message) ─────────────────────────────────

  /**
   * Fire a ki blast from this NPC toward a target entity, or in facing direction if null.
   * targetType: 'player' | 'npc' | 'ki_target' | null (miss/demo)
   * target: the entity sprite, or null
   * Returns true if blast was fired, false if not enough ki.
   */
  _npcFireKiBlast(target, targetType) {
    const npc = this._npc;
    const scene = this._scene;

    if (!npc._hasKiBlast) return false;
    if (!npc.infKi && npc.ki < npc.getBlastCost()) return false;

    // Client-side ki deduction (server is authoritative but we need visual feedback)
    const cost = npc.getBlastCost();
    if (npc.infKi) {
      npc.ki = npc.maxKi;
    } else {
      npc.ki -= cost;
      npc._kiRegenAccum = 0;
    }

    // Determine facing direction based on target or current facing
    const facing = npc._facing || 'down';
    const shotMode = npc.getEquippedKiAugment?.('ki_shot');
    const dirFrames = { down: 0, up: 1, right: 2, left: 3 };
    const blastFrame = dirFrames[facing] ?? 0;

    // Spawn projectile
    const projX = npc.x;
    const projY = npc.y - npc.displayHeight * 0.4;
    const proj = scene.add.sprite(projX, projY, NRG_KEY, blastFrame);
    proj.setScale(1.5);
    proj.setDepth(15);
    proj.setTint(Number(npc.auraTint ?? 0x4fd6ff));

    // Send server message
    const conn = scene._conn;
    if (conn?.connected) {
      if (target && targetType === 'player') {
        conn.send({ type: 'npc_ki_blast_player', npc_id: npc.id, target_id: target.playerId });
      } else if (target && targetType === 'npc') {
        conn.send({ type: 'npc_ki_blast_npc', npc_id: npc.id, target_owner: target.ownerPid, target_npc_id: target.npcId });
      } else if (target && targetType === 'ki_target' && target._serverId) {
        conn.send({ type: 'npc_ki_blast_ki_target', npc_id: npc.id, target_id: target._serverId });
      }
    }

    if (target) {
      // Face the target
      this._faceTarget(npc, target);

      // Animate toward target
      const targetProjY = target.y - (target.displayHeight || TILE_SIZE) * 0.4;
      const speed = this._getKiBlastProjectileSpeed();
      const impactPoint = scene._getKiBlastImpactPoint?.(projX, projY, target.x, targetProjY, shotMode === 'explosive')
        || { x: target.x, y: targetProjY };
      const travelDist = Phaser.Math.Distance.Between(projX, projY, impactPoint.x, impactPoint.y);
      scene.tweens.add({
        targets: proj,
        x: impactPoint.x,
        y: impactPoint.y,
        duration: Math.max(120, (travelDist / speed) * 1000),
        onComplete: () => {
          scene._showKiBlastImpact?.(impactPoint.x, impactPoint.y, npc.auraTint, shotMode === 'explosive' ? 28 : 18, shotMode === 'explosive');
          proj.destroy();
        },
      });
    } else {
      // No target — fire in facing direction
      const dirVecs = { down: { x: 0, y: 1 }, up: { x: 0, y: -1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
      const dir = dirVecs[facing] || dirVecs.down;
      const intendedEndX = projX + dir.x * this._getKiBlastRange();
      const intendedEndY = projY + dir.y * this._getKiBlastRange();
      const impactPoint = scene._getKiBlastImpactPoint?.(projX, projY, intendedEndX, intendedEndY, shotMode === 'explosive')
        || { x: intendedEndX, y: intendedEndY };
      const endX = impactPoint.x;
      const endY = impactPoint.y;
      scene.tweens.add({
        targets: proj,
        x: endX,
        y: endY,
        alpha: 0,
        duration: Math.max(140, (this._getKiBlastRange() / this._getKiBlastProjectileSpeed()) * 1000),
        onComplete: () => {
          scene._showKiBlastImpact?.(endX, endY, npc.auraTint, shotMode === 'explosive' ? 28 : 18, shotMode === 'explosive');
          proj.destroy();
        },
      });
    }

    return true;
  }
}
