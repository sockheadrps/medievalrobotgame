// DepositTaskHandler.js — handles deposit_to_crate and steal_logs tasks
// Extracted from NPCTaskRunner.js. Receives (scene, npc, runner) in constructor.

import Phaser from 'phaser';
import { TILE_SIZE } from '../../constants.js';

export class DepositTaskHandler {
  constructor(scene, npc, runner) {
    this._scene = scene;
    this._npc = npc;
    this._runner = runner;
  }

  // ── Find Crate For Resource ─────────────────────────────────────────────────

  /**
   * Find the best crate for a resource.
   * Priority: 1) crate labeled with this exact resource  2) unlabeled crate  3) any crate
   */
  _findCrateForResource(resource) {
    const scene = this._scene;
    const npc = this._npc;
    const crates = scene._crates || [];
    let labelMatch = null, labelDist = Infinity;
    let unlabeled = null, unlabeledDist = Infinity;
    let any = null, anyDist = Infinity;
    for (const crate of crates) {
      const d = Phaser.Math.Distance.Between(npc.x, npc.y, crate.x, crate.y);
      const lbl = (crate.getLabel?.() || '').toLowerCase();
      if (lbl && lbl === resource.toLowerCase()) {
        if (d < labelDist) { labelDist = d; labelMatch = crate; }
      } else if (!lbl) {
        if (d < unlabeledDist) { unlabeledDist = d; unlabeled = crate; }
      }
      if (d < anyDist) { anyDist = d; any = crate; }
    }
    return labelMatch || unlabeled || any;
  }

  // ── Deposit to Crate ─────────────────────────────────────────────────────────

  doDepositToCrate(_delta) {
    const scene = this._scene;
    const npc   = this._npc;
    const runner = this._runner;
    const cmd   = runner._tasks[0];

    // Build list of all items NPC is carrying
    const items = []; // { resource, qty, source: 'inv'|'logs'|'stones' }
    const npcInv = npc._npcInventory || {};
    for (const [res, qty] of Object.entries(npcInv)) {
      if (qty > 0) items.push({ resource: res, qty, source: 'inv' });
    }
    if ((npc.logs || 0) > 0) items.push({ resource: 'logs', qty: npc.logs, source: 'logs' });
    if ((npc.stones || 0) > 0) items.push({ resource: 'stones', qty: npc.stones, source: 'stones' });

    if (items.length === 0) {
      npc.showBubble('Nothing to deposit!', 2000);
      runner._tasks.shift();
      return;
    }

    // Find target crate — if cmd.building_id is specified, use that directly
    let targetCrate = null;
    let depositItems = items; // what to deposit at this crate

    if (cmd.building_id) {
      for (const crate of (scene._crates || [])) {
        if (crate._serverId === cmd.building_id) { targetCrate = crate; break; }
      }
    }

    if (!targetCrate) {
      // Find the best crate for the first item, deposit all matching items there
      const firstItem = items[0];
      targetCrate = this._findCrateForResource(firstItem.resource);

      if (targetCrate) {
        const lbl = (targetCrate.getLabel?.() || '').toLowerCase();
        if (lbl) {
          // Only deposit items that match this crate's label
          depositItems = items.filter(i => i.resource.toLowerCase() === lbl);
        }
        // If unlabeled, deposit everything
      }
    }

    if (!targetCrate) {
      npc.showBubble('No crate nearby!', 2000);
      runner._tasks.shift();
      return;
    }

    const distToCrate = Phaser.Math.Distance.Between(npc.x, npc.y, targetCrate.x, targetCrate.y);
    if (distToCrate > TILE_SIZE * 1.5) {
      npc.moveTo(targetCrate.x, targetCrate.y);
      return;
    }

    // Close enough — deposit matching items
    npc.stopMoving();
    const conn = scene._conn;
    const bid = targetCrate._serverId;
    const deposited = [];

    for (const item of depositItems) {
      if (!conn?.connected || !bid) break;
      conn.send({ type: 'npc_deposit_to_crate', npc_id: npc.id, building_id: bid, resource: item.resource, amount: item.qty });
      targetCrate.addToStorage?.(item.resource, item.qty);
      deposited.push(item.resource);

      // Clear from NPC
      if (item.source === 'inv') {
        delete npcInv[item.resource];
      } else if (item.source === 'logs') {
        npc.logs = 0;
      } else if (item.source === 'stones') {
        npc.stones = 0;
      }
    }
    if (npc._npcInventory) {
      // Clean empty entries
      for (const k of Object.keys(npc._npcInventory)) {
        if (npc._npcInventory[k] <= 0) delete npc._npcInventory[k];
      }
    }

    const label = targetCrate.getLabel?.() || 'crate';
    npc.showBubble(`Stored ${deposited.join(', ')} in ${label}!`, 3000, { silent: true });

    // Check if NPC still has items to deposit elsewhere
    const remaining = [];
    for (const [res, qty] of Object.entries(npc._npcInventory || {})) {
      if (qty > 0) remaining.push(res);
    }
    if ((npc.logs || 0) > 0) remaining.push('logs');
    if ((npc.stones || 0) > 0) remaining.push('stones');

    if (remaining.length > 0) {
      // Re-run deposit for remaining items (will find a different crate)
      return; // don't shift — re-enter next frame to find next crate
    }

    runner._tasks.shift();
  }

  // ── Steal Logs ───────────────────────────────────────────────────────────────

  doStealLogs(_delta) {
    const scene = this._scene;
    const npc = this._npc;
    const runner = this._runner;
    if (runner._attackCooldown > 0) { runner._attackCooldown -= _delta; return; }
    const cmd = runner._tasks[0];
    const targetKey = `${cmd.target_owner}_${cmd.target_npc_id}`;

    const rnpc = scene._remoteNPCSprites?.[targetKey];
    if (!rnpc || rnpc.isDead?.()) {
      npc.showBubble('Target lost…', 2000);
      runner._tasks.shift();
      return;
    }

    // If target has no logs, abort
    if ((rnpc.logs ?? 0) <= 0) {
      npc.showBubble('They have nothing to take…', 2000);
      runner._tasks.shift();
      return;
    }

    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, rnpc.x, rnpc.y);
    if (dist > runner._ATTACK_RANGE) {
      npc.moveTo(rnpc.x, rnpc.y);
    } else {
      npc.stopMoving();
      runner._faceTarget(npc, rnpc);
      npc.playAttack?.(rnpc.x);
      runner._attackCooldown = runner._getAttackCooldownMs() * 2; // longer cooldown for stealing

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

      runner._tasks.shift(); // one-shot action, then return to previous behavior
    }
  }
}
