// GatherTaskHandler.js — handles gather/mine/give/pickup/refine tasks
// Extracted from NPCTaskRunner.js. Receives (scene, npc, runner) in constructor.

import Phaser from 'phaser';
import { TILE_SIZE, TREE_CHOP_DIST, ROCK_MINE_DIST } from '../../constants.js';

export class GatherTaskHandler {
  constructor(scene, npc, runner) {
    this._scene = scene;
    this._npc = npc;
    this._runner = runner;
  }

  // ── Gather wood ─────────────────────────────────────────────────────────────

  doGather(_delta) {
    const scene = this._scene;
    const npc   = this._npc;
    const runner = this._runner;

    // Spot nearby NPCs from other players — maybe interact based on personality
    runner._gatherSpotAccum = (runner._gatherSpotAccum ?? 0) + _delta;
    if (runner._gatherSpotAccum > 10000) { // check every 10s
      runner._gatherSpotAccum = 0;
      for (const rnpc of Object.values(scene._remoteNPCSprites || {})) {
        if (rnpc.isDead?.()) continue;
        const d = Phaser.Math.Distance.Between(npc.x, npc.y, rnpc.x, rnpc.y) / TILE_SIZE;
        if (d < 8) {
          const interaction = this._decideNPCInteraction(npc, rnpc);
          if (interaction) {
            runner._tasks.unshift(interaction);
            return;
          }
          break;
        }
      }
    }

    // Inventory full — deposit to crate if available, else deliver logs to player
    if (npc.isInventoryFull()) {
      npc.stopMoving();
      const hasCrates = (scene._crates || []).length > 0;
      runner._tasks.shift();
      if (hasCrates) {
        npc.showBubble(`Full up! Going to deposit.`, 3000);
        runner._tasks.unshift({ task: 'deposit_to_crate' }, { task: 'gather', item: 'wood' });
      } else {
        npc.showBubble(`Full up! Bringing logs to you.`, 3000);
        runner._tasks.unshift({ task: 'give_logs' }, { task: 'gather', item: 'wood' });
      }
      return;
    }

    // Cooldown after chopping — wait for server to process
    if (runner._chopCooldown > 0) {
      runner._chopCooldown -= _delta;
      npc.stopMoving();
      return;
    }

    // Find nearest un-chopped tree
    if (!runner._target || runner._target._chopped) {
      const trees = (scene.trees ?? []).filter(t => !t._chopped);
      if (trees.length === 0) {
        npc.showBubble('No trees left!', 3000);
        runner._tasks.shift();
        return;
      }
      trees.sort((a, b) =>
        Phaser.Math.Distance.Between(npc.x, npc.y, a.x, a.y) -
        Phaser.Math.Distance.Between(npc.x, npc.y, b.x, b.y)
      );
      runner._target = trees[0];
      runner._state = 'moving_to_tree';
    }

    const tree = runner._target;
    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, tree.x, tree.y);

    if (dist > TREE_CHOP_DIST) {
      npc.moveTo(tree.x, tree.y);
    } else {
      npc.stopMoving();
      if (!tree._chopped) {
        const conn = scene._conn;
        if (conn?.connected && tree.treeIndex >= 0) {
          conn.send({ type: 'npc_chop', tree_id: tree.treeIndex, owner_id: scene.playerId, npc_id: npc.id });
        }
        npc.logs = Math.min(npc.logs + 1, npc.maxLogs);
        npc.showBubble(`Chopping! (${npc.logs}/${npc.maxLogs})`, 1500, { silent: true });
        runner._chopCooldown = 1500;
      }
      runner._target = null;
    }
  }

  // ── Give logs to player ─────────────────────────────────────────────────────

  doGiveLogs(_delta) {
    const scene = this._scene;
    const npc   = this._npc;
    const runner = this._runner;
    const player = scene.player;
    if (!player) return;

    if (npc.logs <= 0) {
      npc.showBubble('I have no logs to give!', 2000);
      runner._tasks.shift();
      return;
    }

    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, player.x, player.y);

    if (dist > runner._getFollowLeash()) {
      npc.moveTo(player.x, player.y);
    } else {
      npc.stopMoving();
      const amount = npc.logs;
      npc.logs = 0;
      npc._givingLogs = true;
      const conn = scene._conn;
      if (conn?.connected) {
        conn.send({ type: 'admin', field: 'logs', value: amount });
      }
      npc.showBubble(`Here's ${amount} log${amount > 1 ? 's' : ''}, boss!`, 3000);
      runner._tasks.shift();
    }
  }

  // ── Gather Stone ─────────────────────────────────────────────────────────────

  doGatherStone(_delta) {
    const scene = this._scene;
    const npc = this._npc;
    const runner = this._runner;
    const player = scene.player;
    const npcInv = npc._npcInventory || {};
    const invStone = Number(npcInv.stone || npcInv.Stone || 0);
    const invCrystal = Number(npcInv.crystal || npcInv.Crystal || 0);

    if (runner._mineCooldown > 0) {
      runner._mineCooldown -= _delta;
      npc.stopMoving();
      return;
    }

    if ((npc.stones || 0) + (npc.crystals || 0) + invStone + invCrystal > 0) {
      if (!player) return;
      const distToPlayer = Phaser.Math.Distance.Between(npc.x, npc.y, player.x, player.y);
      if (distToPlayer > runner._getFollowLeash()) {
        npc.moveTo(player.x, player.y);
      } else {
        npc.stopMoving();
        const conn = scene._conn;
        if (conn?.connected) {
          conn.send({ type: 'npc_give_materials', npc_id: npc.id });
        }
        const parts = [];
        const totalCrystals = (npc.crystals || 0) + invCrystal;
        const totalStones = (npc.stones || 0) + invStone;
        if (totalCrystals > 0) parts.push(`${totalCrystals} Crystal${totalCrystals > 1 ? 's' : ''}`);
        if (totalStones > 0) parts.push(`${totalStones} Stone${totalStones > 1 ? 's' : ''}`);
        npc.showBubble(`Bringing you ${parts.join(', ')}!`, 3000, { silent: true });
        npc.crystals = 0;
        npc.stones = 0;
        delete npcInv.crystal;
        delete npcInv.Crystal;
        delete npcInv.stone;
        delete npcInv.Stone;
      }
      return;
    }

    let rockSprite = null;
    let bestRockDist = Infinity;
    for (const rock of Object.values(scene._rockSprites || {})) {
      if (!rock || rock._mined) continue;
      const d = Phaser.Math.Distance.Between(npc.x, npc.y, rock.x, rock.y);
      if (d < bestRockDist) {
        bestRockDist = d;
        rockSprite = rock;
      }
    }
    if (rockSprite) {
      const distToRock = Phaser.Math.Distance.Between(npc.x, npc.y, rockSprite.x, rockSprite.y);
      if (distToRock > ROCK_MINE_DIST) {
        npc.moveTo(rockSprite.x, rockSprite.y);
      } else {
        npc.stopMoving();
        const conn = scene._conn;
        if (conn?.connected && rockSprite.rockId >= 0) {
          conn.send({ type: 'npc_mine_rock', rock_id: rockSprite.rockId, npc_id: npc.id });
        }
        npc.stones = (npc.stones || 0) + 1;
        npc.showBubble('Mining stone!', 1200, { silent: true });
        runner._mineCooldown = 1000;
      }
      return;
    }

    let rockWorldObj = null;
    let bestWorldRockDist = Infinity;
    for (const wo of Object.values(scene._worldObjSprites || {})) {
      if (!wo || wo._depleted || wo._assetId !== 'rock') continue;
      const d = Phaser.Math.Distance.Between(npc.x, npc.y, wo.x, wo.y);
      if (d < bestWorldRockDist) {
        bestWorldRockDist = d;
        rockWorldObj = wo;
      }
    }
    if (rockWorldObj) {
      if (bestWorldRockDist > ROCK_MINE_DIST) {
        npc.moveTo(rockWorldObj.x, rockWorldObj.y);
      } else {
        npc.stopMoving();
        const conn = scene._conn;
        if (conn?.connected && rockWorldObj._woId) {
          conn.send({ type: 'npc_interact_world_object', wo_id: rockWorldObj._woId, npc_id: npc.id });
        }
        npc.stones = (npc.stones || 0) + 1;
        npc.showBubble('Mining stone!', 1200, { silent: true });
        runner._mineCooldown = 1000;
      }
      return;
    }

    let stoneItem = null;
    let bestDist = Infinity;
    for (const gi of (scene.groundItems || [])) {
      if (gi.resource !== 'Stone' || !gi._placed) continue;
      const d = Phaser.Math.Distance.Between(npc.x, npc.y, gi.x, gi.y);
      if (d < bestDist) {
        bestDist = d;
        stoneItem = gi;
      }
    }

    if (!stoneItem) {
      npc.showBubble('No stone to gather right now.', 2000);
      runner._tasks.shift();
      return;
    }

    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, stoneItem.x, stoneItem.y);
    if (dist > TILE_SIZE * 1.2) {
      npc.moveTo(stoneItem.x, stoneItem.y);
      return;
    }

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
    npc.showBubble(`Picked up ${amount} stone!`, 2000, { silent: true });
    // Intentional: don't shift task — loop to gather remaining stones; the no-stone branch above will shift.
  }

  // ── Gather All ───────────────────────────────────────────────────────────────

  doGatherAll(_delta) {
    const scene = this._scene;
    const npc = this._npc;
    const runner = this._runner;

    const hasMaterials = (npc.stones || 0) + (npc.crystals || 0) > 0;
    if (hasMaterials) {
      this.doGatherStone(_delta);
      return;
    }

    const hasRockNodes = Object.values(scene._rockSprites || {}).some(rock => rock && !rock._mined);
    if (hasRockNodes) {
      this.doGatherStone(_delta);
      return;
    }

    const hasStoneOnGround = (scene.groundItems || []).some(gi => gi.resource === 'Stone' && gi._placed);
    if (hasStoneOnGround) {
      this.doGatherStone(_delta);
      return;
    }

    if (npc.isInventoryFull()) {
      this.doGiveLogs(_delta);
      return;
    }

    const trees = (scene.trees ?? []).filter(t => !t._chopped);
    if (trees.length === 0) {
      if ((npc.logs || 0) > 0) {
        this.doGiveLogs(_delta);
      } else {
        npc.showBubble('Nothing left to gather.', 2500);
        runner._tasks.shift();
      }
      return;
    }

    if (runner._chopCooldown > 0) {
      runner._chopCooldown -= _delta;
      npc.stopMoving();
      return;
    }

    if (!runner._target || runner._target._chopped) {
      trees.sort((a, b) =>
        Phaser.Math.Distance.Between(npc.x, npc.y, a.x, a.y) -
        Phaser.Math.Distance.Between(npc.x, npc.y, b.x, b.y)
      );
      runner._target = trees[0];
      runner._state = 'moving_to_tree';
    }

    const tree = runner._target;
    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, tree.x, tree.y);
    if (dist > TREE_CHOP_DIST) {
      npc.moveTo(tree.x, tree.y);
      return;
    }

    npc.stopMoving();
    if (!tree._chopped) {
      const conn = scene._conn;
      if (conn?.connected && tree.treeIndex >= 0) {
        conn.send({ type: 'npc_chop', tree_id: tree.treeIndex, owner_id: scene.playerId, npc_id: npc.id });
      }
      npc.logs = Math.min(npc.logs + 1, npc.maxLogs);
      npc.showBubble(`Gathering all! (${npc.logs}/${npc.maxLogs} logs)`, 1500, { silent: true });
      runner._chopCooldown = 1500;
    }
    runner._target = null;
  }

  // ── Pickup Stone ─────────────────────────────────────────────────────────────

  doPickupStone(_delta) {
    const scene = this._scene;
    const npc = this._npc;
    const runner = this._runner;
    const cmd = runner._tasks[0];

    if (cmd._pickupCooldown > 0) {
      cmd._pickupCooldown -= _delta;
      return;
    }

    let stoneItem = null;
    if (cmd._targetItemId) {
      stoneItem = (scene.groundItems || []).find(gi =>
        gi._serverId === cmd._targetItemId && gi.resource === 'Stone'
      );
    }
    if (!stoneItem) {
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
      runner._tasks.shift();
      return;
    }

    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, stoneItem.x, stoneItem.y);
    if (dist > TILE_SIZE * 1.2) {
      npc.moveTo(stoneItem.x, stoneItem.y);
      return;
    }

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
    runner._tasks.shift();
  }

  // ── Give Materials ────────────────────────────────────────────────────────────

  doGiveMaterials(_delta) {
    const scene = this._scene;
    const npc = this._npc;
    const runner = this._runner;
    const player = scene.player;
    if (!player) return;

    const hasMats = (npc.crystals || 0) + (npc.stones || 0);
    if (hasMats <= 0) {
      npc.showBubble("I don't have any materials to give!", 2000);
      runner._tasks.shift();
      return;
    }

    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, player.x, player.y);
    if (dist > runner._getFollowLeash()) {
      npc.moveTo(player.x, player.y);
    } else {
      npc.stopMoving();
      const conn = scene._conn;
      if (conn?.connected) {
        conn.send({ type: 'npc_give_materials', npc_id: npc.id });
      }

      const parts = [];
      if (npc.crystals > 0) parts.push(`${npc.crystals} Crystal${npc.crystals > 1 ? 's' : ''}`);
      if (npc.stones > 0) parts.push(`${npc.stones} Stone`);

      npc.showBubble(`Here's what I have: ${parts.join(', ')}!`, 4000);

      npc.crystals = 0;
      npc.stones = 0;

      runner._tasks.shift();
    }
  }

  // ── Mine Ore (world objects) ──────────────────────────────────────────────────

  doMineOre(_delta) {
    const scene = this._scene;
    const npc   = this._npc;
    const runner = this._runner;
    const cmd   = runner._tasks[0];

    if (runner._mineCooldown > 0) {
      runner._mineCooldown -= _delta;
      npc.stopMoving();
      return;
    }

    const npcInv = npc._npcInventory || {};
    const totalOre = Object.values(npcInv).reduce((s, v) => s + v, 0);
    if (totalOre >= 10) {
      const hasCrates = (scene._crates || []).length > 0;
      if (hasCrates) {
        npc.showBubble('Full up! Going to deposit.', 2000, { silent: true });
        runner._tasks.shift();
        runner._tasks.unshift({ task: 'deposit_to_crate' }, { task: 'mine_ore', asset_id: cmd.asset_id });
      } else {
        npc.showBubble('Inventory full!', 2000, { silent: true });
        runner._tasks.shift();
      }
      return;
    }

    const targetAssetId = cmd.asset_id || null;
    let bestWo = null;
    let bestDist = Infinity;
    for (const [woId, wo] of Object.entries(scene._worldObjSprites || {})) {
      if (!wo || wo._depleted) continue;
      if (targetAssetId && wo._assetId !== targetAssetId) continue;
      const d = Phaser.Math.Distance.Between(npc.x, npc.y, wo.x, wo.y);
      if (d < bestDist) {
        bestDist = d;
        bestWo = wo;
      }
    }

    if (!bestWo) {
      npc.showBubble('No ore to mine!', 2000);
      runner._tasks.shift();
      return;
    }

    if (bestDist > ROCK_MINE_DIST) {
      npc.moveTo(bestWo.x, bestWo.y);
    } else {
      npc.stopMoving();
      const conn = scene._conn;
      if (conn?.connected && bestWo._woId) {
        conn.send({ type: 'npc_interact_world_object', wo_id: bestWo._woId, npc_id: npc.id });
      }
      const assetId = bestWo._assetId || 'ore';
      const dropResource = bestWo._dropResource || assetId;
      if (!npc._npcInventory) npc._npcInventory = {};
      npc._npcInventory[dropResource] = (npc._npcInventory[dropResource] || 0) + 1;
      const total = Object.values(npc._npcInventory).reduce((s, v) => s + v, 0);
      npc.showBubble(`Mining! (${total}/10)`, 1200, { silent: true });
      runner._mineCooldown = 1200;
    }
  }

  // ── NPC-to-NPC interaction decision ──────────────────────────────────────────

  /**
   * Decide whether this NPC should interact with a nearby remote NPC.
   * Returns a task object ({ task, target_owner, ... }) or null.
   * Uses personality traits and relationship history — no LLM needed.
   */
  _decideNPCInteraction(npc, rnpc) {
    const runner = this._runner;
    const pers = npc.soul?.personality || {};
    const cooperation = pers.cooperation ?? 0.5;
    const aggression = pers.aggression ?? 0.3;

    const relKey = `npc:${rnpc.npcId}`;
    const rel = npc.soul?.relationships?.[relKey];
    const trust = rel?.trust ?? 0.5;
    const anger = rel?.anger ?? 0;

    // Cooldown — don't interact with the same NPC too often
    const now = Date.now();
    if (!runner._lastInteraction) runner._lastInteraction = {};
    const lastTime = runner._lastInteraction[rnpc.npcId] ?? 0;
    if (now - lastTime < 30000) return null; // 30s cooldown per NPC

    // Base chance to interact at all (~20% per check)
    if (Math.random() > 0.2) return null;

    runner._lastInteraction[rnpc.npcId] = now;

    // Decide: socialize vs steal
    const hasLogs = (rnpc.logs ?? 0) > 0;
    const socializeScore = cooperation * 0.6 + trust * 0.3 + (1 - aggression) * 0.1;
    let stealScore = aggression * 0.5 + (1 - cooperation) * 0.3 + anger * 0.4;
    if (!hasLogs) stealScore = 0;
    if (trust > 0.7) stealScore *= 0.2;

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
}
