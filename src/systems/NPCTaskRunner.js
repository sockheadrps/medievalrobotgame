// NPCTaskRunner — lightweight task executor for NPC commands.
// Supports: gather, follow, attack_nearest_enemy, defend_player, attack_player, attack_npc, idle.

import Phaser from 'phaser';
import { TILE_SIZE, TREE_CHOP_DIST } from '../constants.js';
import { generateNPCChat } from '../net/LLMClient.js';

const FOLLOW_DIST   = TILE_SIZE * 2;   // stay 2 tiles from player
const FOLLOW_LEASH  = TILE_SIZE * 1.2; // stop when this close
const ATTACK_RANGE  = TILE_SIZE * 1.2;
const DEFEND_RANGE  = TILE_SIZE * 6;
const ATTACK_COOLDOWN_MS = 1000; // ms between NPC attacks

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
  }

  /** Replace entire task queue. */
  setTasks(commands) {
    this._tasks = Array.isArray(commands) ? [...commands] : [];
    this._state = 'idle';
    this._target = null;
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

  /** Called every frame from GameScene update. */
  update(delta) {
    if (this._npc.isDead()) return;
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
      default:
        console.warn(`[TaskRunner] Unknown task: ${cmd.task}`);
        this._tasks.shift();
    }
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
    if (!this._target || this._target._dead || this._target.isDead?.()) {
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
      npc.moveTo(target.x, target.y);
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
        conn.send({ type: 'npc_attack_dummy', dummy_id: target._serverId, str: npc.str });
      } else if (this._targetType === 'dummy') {
        target.npcAttack(npc);
      }

      if (target.isDead?.() || target._dead) {
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
        conn.send({ type: 'npc_attack_dummy', dummy_id: target._serverId, str: npc.str });
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

    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, rp.x, rp.y);
    if (dist > ATTACK_RANGE) {
      npc.moveTo(rp.x, rp.y);
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

    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, rnpc.x, rnpc.y);
    if (dist > ATTACK_RANGE) {
      npc.moveTo(rnpc.x, rnpc.y);
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

  // ── Flee from a specific player ─────────────────────────────────────────

  _doFleePlayer(_delta) {
    const scene = this._scene;
    const npc = this._npc;
    const cmd = this._tasks[0];
    const targetId = cmd.target_id;

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

    // Look for nearby hostile targets: other players and their NPCs
    let nearestTarget = null;
    let nearestDist = DEFEND_RANGE;

    // Check remote players
    for (const rp of Object.values(scene._remotePlayers || {})) {
      if (rp.isDead?.()) continue;
      const d = Phaser.Math.Distance.Between(npc.x, npc.y, rp.x, rp.y);
      if (d < nearestDist) {
        nearestDist = d;
        nearestTarget = { type: 'player', entity: rp, id: rp.playerId };
      }
    }

    // Check remote NPCs
    for (const rnpc of Object.values(scene._remoteNPCSprites || {})) {
      if (rnpc.isDead?.()) continue;
      const d = Phaser.Math.Distance.Between(npc.x, npc.y, rnpc.x, rnpc.y);
      if (d < nearestDist) {
        nearestDist = d;
        nearestTarget = { type: 'npc', entity: rnpc, ownerId: rnpc.ownerPid, npcId: rnpc.npcId };
      }
    }

    // Also check dummies
    for (const dummy of (scene.dummies ?? [])) {
      if (dummy.isDead()) continue;
      const d = Phaser.Math.Distance.Between(npc.x, npc.y, dummy.x, dummy.y);
      if (d < nearestDist) {
        nearestDist = d;
        nearestTarget = { type: 'dummy', entity: dummy };
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
        conn.send({ type: 'npc_attack_dummy', dummy_id: nearestTarget.entity._serverId, str: npc.str });
      }
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

      npc.showBubble(`Swiped ${stealAmount} log${stealAmount > 1 ? 's' : ''}! Heh.`, 3000);

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
        soul: { personality: {}, relationships: {}, memories: {} },
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
              if (isOurs) {
                npc.showBubble(entry.line, 4000, { silent: true });
              } else {
                // Show on the remote NPC sprite too
                rnpc.showBubble?.(entry.line, 4000);
              }
              // Log to chat
              scene.chatBox?._addLog(`${entry.speaker}: ${entry.line}`, '#aaccff');
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
}
