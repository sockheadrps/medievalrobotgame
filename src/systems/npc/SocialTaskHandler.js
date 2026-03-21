// SocialTaskHandler.js — handles follow, wander_explore, socialize_npc, custom_task
// Extracted from NPCTaskRunner.js. Receives (scene, npc, runner) in constructor.

import Phaser from 'phaser';
import { TILE_SIZE, ROCK_MINE_DIST } from '../../constants.js';
import { generateNPCChat } from '../../net/LLMClient.js';

export class SocialTaskHandler {
  constructor(scene, npc, runner) {
    this._scene = scene;
    this._npc = npc;
    this._runner = runner;
  }

  // ── Follow player ─────────────────────────────────────────────────────────────

  doFollow(_delta) {
    const player = this._scene.player;
    const npc    = this._npc;
    const runner = this._runner;
    if (!player) return;

    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, player.x, player.y);

    if (dist > runner._getFollowDist()) {
      npc.moveTo(player.x, player.y);
    } else if (dist < runner._getFollowLeash()) {
      npc.stopMoving();
    }
  }

  // ── Wander/explore ────────────────────────────────────────────────────────────

  doWanderExplore(_delta) {
    const scene = this._scene;
    const npc = this._npc;
    const runner = this._runner;
    const player = scene.player;
    const now = Date.now();

    const target = runner._wanderTarget;
    const expired = !target || now > target.expiresAt;

    if (expired) {
      const baseX = player ? player.x : npc.x;
      const baseY = player ? player.y : npc.y;
      const angle = Math.random() * Math.PI * 2;
      const radius = TILE_SIZE * (6 + Math.random() * 6);
      runner._wanderTarget = {
        x: baseX + Math.cos(angle) * radius,
        y: baseY + Math.sin(angle) * radius,
        expiresAt: now + 8000 + Math.random() * 4000,
      };
      npc.moveTo(runner._wanderTarget.x, runner._wanderTarget.y);
      return;
    }

    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, target.x, target.y);
    if (dist < TILE_SIZE * 0.8) {
      runner._wanderTarget = null;
      runner._tasks.shift();
      npc.stopMoving();
    }
  }

  // ── Socialize with another player's NPC ───────────────────────────────────────

  doSocializeNPC(_delta) {
    const scene = this._scene;
    const npc = this._npc;
    const runner = this._runner;
    const cmd = runner._tasks[0];
    const targetKey = `${cmd.target_owner}_${cmd.target_npc_id}`;

    const rnpc = scene._remoteNPCSprites?.[targetKey];
    if (!rnpc || rnpc.isDead?.()) {
      npc.showBubble('They left…', 1500);
      runner._tasks.shift();
      return;
    }

    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, rnpc.x, rnpc.y);
    const SOCIAL_RANGE = TILE_SIZE * 2;

    if (dist > SOCIAL_RANGE) {
      npc.moveTo(rnpc.x, rnpc.y);
    } else if (!runner._socializing) {
      npc.stopMoving();
      runner._faceTarget(npc, rnpc);
      runner._socializing = true;

      const targetName = cmd.target_name || rnpc.getName?.() || 'fellow worker';

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

      generateNPCChat(npcACtx, npcBCtx).then(({ lines, impact }) => {
        if (lines.length === 0) {
          npc.showBubble(`Hey ${targetName}!`, 3000);
        } else {
          let delay = 0;
          for (const entry of lines) {
            const isOurs = entry.speakerId === npc.id;
            scene.time.delayedCall(delay, () => {
              const fromName = isOurs ? (npc.getName?.() || entry.speaker || npc.id) : (targetName || entry.speaker || rnpc.npcId);
              const toName = isOurs ? (targetName || rnpc.getName?.() || rnpc.npcId) : (npc.getName?.() || npc.id);
              if (isOurs) {
                npc.showBubble(entry.line, 4000, { silent: true });
              } else {
                rnpc.showBubble?.(entry.line, 4000);
              }
              scene._addNPCDirectedSpeechToChat?.(fromName, toName, entry.line, '#aaccff');
            });
            delay += 3000;
          }
        }

        const impA = impact?.npcA || { trust: 0.03, anger: -0.01 };
        const impB = impact?.npcB || { trust: 0.03, anger: -0.01 };

        npc.applyEmotionDeltas(
          { trust: impA.trust, anger: impA.anger },
          `npc:${cmd.target_npc_id}`,
        );

        if (Math.abs(impA.anger) >= 0.1 || Math.abs(impA.trust) >= 0.1) {
          const emoji = impA.anger > 0.1 ? '[angry]' : impA.trust > 0.1 ? '[happy]' : '[upset]';
          scene.chatBox?._addLog(
            `${npc.getName()} ${emoji} (trust ${impA.trust > 0 ? '+' : ''}${impA.trust.toFixed(2)}, anger ${impA.anger > 0 ? '+' : ''}${impA.anger.toFixed(2)})`,
            impA.anger > 0.1 ? '#ff6666' : '#88ddaa',
          );
        }

        const memTag = impA.memory_tag || (lines.length > 0
          ? `Chatted with ${targetName}: "${lines[0].line}"`
          : `Had a brief chat with ${targetName}.`);
        const importance = (Math.abs(impA.trust) + Math.abs(impA.anger)) > 0.15 ? 0.85 : 0.6;
        npc.addMemory(memTag, 'relationship', `npc:${cmd.target_npc_id}`, importance);

        if (impB.memory_tag) {
          scene.chatBox?._addLog(
            `${targetName} felt: ${impB.memory_tag}`,
            impB.anger > 0.1 ? '#ff8888' : '#aaddcc',
          );
        }

        const finishDelay = Math.max(1000, lines.length * 3000);
        scene.time.delayedCall(finishDelay, () => {
          runner._socializing = false;
          runner._socializeDoneAt = Date.now();
          runner._tasks.shift();
        });
      }).catch(() => {
        npc.showBubble(`Hey ${targetName}!`, 3000);
        npc.applyEmotionDeltas({ trust: 0.03, anger: -0.01 }, `npc:${cmd.target_npc_id}`);
        npc.addMemory(
          `Had a brief chat with ${targetName} while gathering wood.`,
          'relationship', `npc:${cmd.target_npc_id}`, 0.6
        );
        runner._socializing = false;
        runner._socializeDoneAt = Date.now();
        runner._tasks.shift();
      });
    }
    // While socializing, just wait (don't shift task until conversation finishes)
  }

  // ── Brief greeting between two NPCs ──────────────────────────────────────────

  /**
   * Brief greeting between two NPCs.
   * cmd = tasks[0] with shape { task: 'greet_npc', target: 'ownerPid_npcId' }
   */
  async doGreetNpc(cmd) {
    const npc = this._npc;
    const scene = this._scene;
    const targetKey = cmd.target;
    if (!targetKey) { this._runner._tasks.shift(); return; }

    // Find the target sprite
    const entry = scene._remoteNPCSprites?.[targetKey]
      || Object.values(scene._remoteNPCSprites || {}).find(
          e => `${e.ownerPid}_${e.npcId}` === targetKey
        );
    if (!entry?.sprite) { this._runner._tasks.shift(); return; }

    const targetSprite = entry.sprite;

    // Move within 2 tiles
    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, targetSprite.x, targetSprite.y);
    if (dist > 2 * TILE_SIZE) {
      // Walk toward target
      if (dist > 4 * TILE_SIZE) { this._runner._tasks.shift(); return; } // too far, give up
      scene.physics?.moveTo?.(npc, targetSprite.x, targetSprite.y, 80);
      return; // still approaching, called again next frame
    }

    // Guard against missing soul before any async work
    if (!npc.soul) {
      this._runner._tasks.shift();
      return;
    }

    // At this point NPC is within range — if async greeting already in-flight, don't start a new one
    if (this._runner._greeting) return;

    npc.stopMoving?.();

    this._runner._greeting = true;
    try {
      // Generate greeting line — cheap prompt (personality + relationship only)
      const relKey = `npc:${entry.npcId}`;
      const relLabel = npc.soul?.relationships?.[relKey]?.label ?? 'stranger';
      const pType = npc.soul?.personality?.type ?? 'Pragmatist';
      let line = 'Hey there!'; // fallback
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

      this._runner._tasks.shift(); // task complete
    } finally {
      this._runner._greeting = false;
    }
  }

  // ── Custom Task (mine specified ores → deposit to specified crates, repeat) ────

  doCustomTask(_delta) {
    const scene = this._scene;
    const npc   = this._npc;
    const runner = this._runner;
    const cmd   = runner._tasks[0];

    if (!cmd._phase) {
      cmd._phase = 'mine';
      cmd._oreIdx = 0;
    }

    if (cmd._phase === 'mine') {
      if (runner._mineCooldown > 0) {
        runner._mineCooldown -= _delta;
        npc.stopMoving();
        return;
      }

      const npcInv = npc._npcInventory || {};
      const totalOre = Object.values(npcInv).reduce((s, v) => s + v, 0);
      if (totalOre >= 10) {
        cmd._phase = 'deposit';
        cmd._depositIdx = 0;
        npc.showBubble('Full up! Going to deposit.', 2000, { silent: true });
        return;
      }

      const oreAssetIds = cmd.ore_asset_ids || [];
      let bestWo = null;
      let bestDist = Infinity;
      for (const [woId, wo] of Object.entries(scene._worldObjSprites || {})) {
        if (!wo || wo._depleted) continue;
        if (oreAssetIds.length > 0 && !oreAssetIds.includes(wo._assetId)) continue;
        const d = Phaser.Math.Distance.Between(npc.x, npc.y, wo.x, wo.y);
        if (d < bestDist) {
          bestDist = d;
          bestWo = wo;
        }
      }

      if (!bestWo) {
        npc.showBubble('No ore to mine!', 2000, { silent: true });
        runner._mineCooldown = 3000;
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
        const dropResource = bestWo._dropResource || bestWo._assetId || 'ore';
        if (!npc._npcInventory) npc._npcInventory = {};
        npc._npcInventory[dropResource] = (npc._npcInventory[dropResource] || 0) + 1;
        const total = Object.values(npc._npcInventory).reduce((s, v) => s + v, 0);
        npc.showBubble(`Mining! (${total}/10)`, 1200, { silent: true });
        runner._mineCooldown = 1200;
      }
    } else if (cmd._phase === 'deposit') {
      const npcInv = npc._npcInventory || {};
      const items = [];
      for (const [res, qty] of Object.entries(npcInv)) {
        if (qty > 0) items.push({ resource: res, qty });
      }

      if (items.length === 0) {
        cmd._phase = 'mine';
        return;
      }

      const firstItem = items[0];
      let targetCrate = null;

      const crateBids = cmd.crate_building_ids || [];
      const crateLabels = cmd.crate_labels || [];
      if (crateBids.length > 0) {
        for (let i = 0; i < crateBids.length; i++) {
          const bid = crateBids[i];
          const lbl = (crateLabels[i] || '').toLowerCase();
          if (lbl && lbl !== firstItem.resource.toLowerCase()) continue;
          for (const crate of (scene._crates || [])) {
            if (crate._serverId === bid) { targetCrate = crate; break; }
          }
          if (targetCrate) break;
        }
        if (!targetCrate) {
          for (const bid of crateBids) {
            for (const crate of (scene._crates || [])) {
              if (crate._serverId === bid) {
                const lbl = (crate.getLabel?.() || '').toLowerCase();
                if (!lbl) { targetCrate = crate; break; }
              }
            }
            if (targetCrate) break;
          }
        }
      }

      if (!targetCrate) {
        targetCrate = runner._deposit._findCrateForResource(firstItem.resource);
      }

      if (!targetCrate) {
        npc.showBubble('No crate nearby!', 2000, { silent: true });
        cmd._phase = 'mine';
        runner._mineCooldown = 3000;
        return;
      }

      const distToCrate = Phaser.Math.Distance.Between(npc.x, npc.y, targetCrate.x, targetCrate.y);
      if (distToCrate > TILE_SIZE * 1.5) {
        npc.moveTo(targetCrate.x, targetCrate.y);
        return;
      }

      npc.stopMoving();
      const conn = scene._conn;
      const bid = targetCrate._serverId;
      const lbl = (targetCrate.getLabel?.() || '').toLowerCase();
      const depositItems = lbl ? items.filter(i => i.resource.toLowerCase() === lbl) : items;

      for (const item of depositItems) {
        if (!conn?.connected || !bid) break;
        conn.send({ type: 'npc_deposit_to_crate', npc_id: npc.id, building_id: bid, resource: item.resource, amount: item.qty });
        targetCrate.addToStorage?.(item.resource, item.qty);
        delete npcInv[item.resource];
      }

      for (const k of Object.keys(npc._npcInventory || {})) {
        if (npc._npcInventory[k] <= 0) delete npc._npcInventory[k];
      }

      const label = targetCrate.getLabel?.() || 'crate';
      npc.showBubble(`Stored in ${label}!`, 2000, { silent: true });

      const remaining = Object.values(npc._npcInventory || {}).reduce((s, v) => s + v, 0);
      if (remaining <= 0) {
        cmd._phase = 'mine';
      }
    }
  }
}
