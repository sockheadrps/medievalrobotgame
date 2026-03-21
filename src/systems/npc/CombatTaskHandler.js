// CombatTaskHandler.js — handles attack, defend, flee, absorb tasks
// Extracted from NPCTaskRunner.js. Receives (scene, npc, runner) in constructor.

import Phaser from 'phaser';
import { TILE_SIZE } from '../../constants.js';

const ATTACK_RANGE  = TILE_SIZE * 1.2;
const DEFEND_RANGE  = TILE_SIZE * 6;
const ABSORB_DURATION_MS = 2000;

export class CombatTaskHandler {
  constructor(scene, npc, runner) {
    this._scene = scene;
    this._npc = npc;
    this._runner = runner;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _targetIsDown(target) {
    return !!(target?.isDead?.() || target?._dead || target?.isKnockedOut?.());
  }

  _completeCombatTaskOnTargetDown(targetName = 'them') {
    const scene = this._scene;
    const npc = this._npc;
    const runner = this._runner;
    const currentTask = runner._tasks[0]?.task || 'attack';
    const line = scene._buildKnockoutVictoryLine?.(npc, currentTask) || `They're down.`;
    npc.showBubble(line, 3200, { silent: true });
    scene._addNPCSpeechToChat?.(npc, line);
    npc.addMemory(`I knocked ${targetName} down during a fight.`, 'event', scene.playerId, 0.65);
    runner.setTasks([{ task: 'idle' }]);
  }

  _pickAbsorbLine(kind = 'start', targetName = 'them') {
    const type = this._npc.soul?.personality?.type || 'Pragmatist';
    const linesByType = {
      Guardian: {
        start: [
          `I'll absorb ${targetName} before they recover.`,
          `Keeping this contained. Absorbing ${targetName} now.`,
        ],
        cast: [
          `Taking their power now.`,
          `Their energy is mine.`,
        ],
      },
      Scout: {
        start: [
          `Ooh, let's see what ${targetName} was hiding.`,
          `Alright, draining ${targetName} now.`,
        ],
        cast: [
          `Whoa... that's a lot of power.`,
          `Yep, I'm taking that.`,
        ],
      },
      Berserker: {
        start: [
          `Good. I'll rip the power out of ${targetName}.`,
          `Stay down, ${targetName}. I'm taking everything.`,
        ],
        cast: [
          `Mine now.`,
          `Your power belongs to me.`,
        ],
      },
      Caretaker: {
        start: [
          `I'll end this cleanly. Absorbing ${targetName}.`,
          `Sorry... but I need that strength, ${targetName}.`,
        ],
        cast: [
          `Easy... just let go.`,
          `It's over. I'm taking the energy.`,
        ],
      },
      Paranoid: {
        start: [
          `Not risking them getting back up. Absorbing ${targetName}.`,
          `No chances. I'm draining ${targetName} now.`,
        ],
        cast: [
          `Safer this way.`,
          `They won't be getting up from that.`,
        ],
      },
      Pragmatist: {
        start: [
          `Absorbing ${targetName}. Efficient.`,
          `Target is down. Beginning absorption.`,
        ],
        cast: [
          `Energy transfer underway.`,
          `Power acquired.`,
        ],
      },
    };
    const pool = linesByType[type]?.[kind] || linesByType.Pragmatist[kind] || ['Absorbing target.'];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  _tryAbsorbKnockedOutNpc(target) {
    const npc = this._npc;
    const scene = this._scene;
    const runner = this._runner;
    if (!target?.isKnockedOut?.() || target.isDead?.()) return false;
    if (!(npc.kiMoves || []).includes('absorb')) return false;
    if (runner._kiBlastCooldown > 0) return false;
    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, target.x, target.y);
    if (dist > runner._ki._getKiBlastRange()) return false;
    if (!npc.infKi && npc.ki < npc.getBlastCost()) return false;

    const cost = npc.getBlastCost();
    if (npc.infKi) {
      npc.ki = npc.maxKi;
    } else {
      npc.ki -= cost;
      npc._kiRegenAccum = 0;
    }

    runner._faceTarget(npc, target);
    npc.stopMoving();
    scene._combatFx?.playAbsorbEffect(
      npc.x,
      npc.y - npc.displayHeight * 0.4,
      target.x,
      target.y - (target.displayHeight || TILE_SIZE) * 0.4,
      ABSORB_DURATION_MS,
    );
    scene._conn?.send({
      type: 'npc_absorb_npc',
      npc_id: npc.id,
      target_owner: target.ownerPid,
      target_npc_id: target.npcId,
    });
    const castLine = this._pickAbsorbLine('cast', target.getName?.() || target.npcId || 'them');
    npc.showBubble(castLine, 1800, { silent: true });
    scene._addNPCSpeechToChat?.(npc, castLine, '#66e0ff');
    runner._kiBlastCooldown = ABSORB_DURATION_MS;
    return true;
  }

  _findNearestKnockedOutEnemyNpc() {
    const scene = this._scene;
    const npc = this._npc;
    let nearest = null;
    let nearestDist = Infinity;
    for (const rnpc of Object.values(scene._remoteNPCSprites || {})) {
      if (!rnpc || rnpc.ownerPid === scene.playerId || rnpc.isDead?.() || !rnpc.isKnockedOut?.()) continue;
      const dist = Phaser.Math.Distance.Between(npc.x, npc.y, rnpc.x, rnpc.y);
      if (dist < nearestDist) {
        nearest = rnpc;
        nearestDist = dist;
      }
    }
    return nearest;
  }

  // ── Attack nearest enemy ──────────────────────────────────────────────────────

  doAttack(_delta) {
    const scene = this._scene;
    const npc   = this._npc;
    const runner = this._runner;

    if (runner._attackCooldown > 0) { runner._attackCooldown -= _delta; return; }

    if (runner._target?.isKnockedOut?.()) {
      const targetName = runner._target.getName?.() || runner._target.playerId || runner._target.npcId || 'them';
      if (runner._targetType === 'npc') this._tryAbsorbKnockedOutNpc(runner._target);
      this._completeCombatTaskOnTargetDown(targetName);
      runner._target = null;
      return;
    }

    if (!runner._target || runner._target._dead || runner._target.isDead?.()) {
      runner._target = null;
      let bestDist = Infinity;

      for (const rp of Object.values(scene._remotePlayers || {})) {
        if (rp.isDead?.()) continue;
        const d = Phaser.Math.Distance.Between(npc.x, npc.y, rp.x, rp.y);
        if (d < bestDist) {
          bestDist = d;
          runner._target = rp;
          runner._targetType = 'player';
        }
      }

      for (const rnpc of Object.values(scene._remoteNPCSprites || {})) {
        if (rnpc.isDead?.()) continue;
        const d = Phaser.Math.Distance.Between(npc.x, npc.y, rnpc.x, rnpc.y);
        if (d < bestDist) {
          bestDist = d;
          runner._target = rnpc;
          runner._targetType = 'npc';
        }
      }

      for (const dummy of (scene.dummies ?? [])) {
        if (dummy.isDead()) continue;
        const d = Phaser.Math.Distance.Between(npc.x, npc.y, dummy.x, dummy.y);
        if (d < bestDist) {
          bestDist = d;
          runner._target = dummy;
          runner._targetType = 'dummy';
        }
      }

      if (!runner._target) {
        npc.showBubble('Nothing to attack…', 2000);
        runner._tasks.shift();
        return;
      }
    }

    const target = runner._target;
    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, target.x, target.y);

    if (dist > ATTACK_RANGE) {
      if (dist <= runner._ki._getKiBlastRange() && runner._targetType !== 'dummy'
          && runner._ki._tryRangedKiBlast(target, runner._targetType)) {
        // Fired a ki blast — don't move closer this frame
      } else {
        npc.moveTo(target.x, target.y);
      }
    } else {
      npc.stopMoving();
      runner._faceTarget(npc, target);
      npc.playAttack?.(target.x);
      runner._attackCooldown = runner._getAttackCooldownMs();

      const conn = scene._conn;
      if (runner._targetType === 'player' && conn?.connected) {
        conn.send({ type: 'npc_attack_player', target_id: target.playerId, str: npc.str, npc_id: npc.id });
      } else if (runner._targetType === 'npc' && conn?.connected) {
        conn.send({ type: 'npc_attack_npc', target_owner: target.ownerPid, target_npc_id: target.npcId, str: npc.str, npc_id: npc.id });
      } else if (runner._targetType === 'dummy' && conn?.connected && target._serverId) {
        conn.send({ type: 'npc_attack_dummy', dummy_id: target._serverId, str: npc.str, npc_id: npc.id });
      } else if (runner._targetType === 'dummy') {
        target.npcAttack(npc);
      }

      if (this._targetIsDown(target)) {
        const targetName = target.getName?.() || target.playerId || target.npcId || 'them';
        if (runner._targetType === 'npc') this._tryAbsorbKnockedOutNpc(target);
        this._completeCombatTaskOnTargetDown(targetName);
        runner._target = null;
      }
    }
  }

  // ── Attack a specific player ──────────────────────────────────────────────────

  doAttackPlayer(_delta) {
    const scene = this._scene;
    const npc = this._npc;
    const runner = this._runner;
    if (runner._attackCooldown > 0) { runner._attackCooldown -= _delta; return; }

    const cmd = runner._tasks[0];
    const targetId = cmd.target_id;

    const rp = scene._remotePlayers?.[targetId];
    if (!rp || rp.isDead?.()) {
      npc.showBubble('Target lost…', 2000);
      runner._tasks.shift();
      return;
    }
    if (rp.isKnockedOut?.()) {
      this._completeCombatTaskOnTargetDown(rp.getName?.() || rp.playerId || 'them');
      return;
    }

    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, rp.x, rp.y);
    if (dist > ATTACK_RANGE) {
      if (dist <= runner._ki._getKiBlastRange() && runner._ki._tryRangedKiBlast(rp, 'player')) {
        // Fired ki blast
      } else {
        npc.moveTo(rp.x, rp.y);
      }
    } else {
      npc.stopMoving();
      runner._faceTarget(npc, rp);
      npc.playAttack?.(rp.x);
      runner._attackCooldown = runner._getAttackCooldownMs();
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

  // ── Attack a specific NPC ─────────────────────────────────────────────────────

  doAttackNPC(_delta) {
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
    if (rnpc.isKnockedOut?.()) {
      this._tryAbsorbKnockedOutNpc(rnpc);
      this._completeCombatTaskOnTargetDown(rnpc.getName?.() || cmd.target_npc_id || 'them');
      return;
    }

    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, rnpc.x, rnpc.y);
    if (dist > ATTACK_RANGE) {
      if (dist <= runner._ki._getKiBlastRange() && runner._ki._tryRangedKiBlast(rnpc, 'npc')) {
        // Fired ki blast
      } else {
        npc.moveTo(rnpc.x, rnpc.y);
      }
    } else {
      npc.stopMoving();
      runner._faceTarget(npc, rnpc);
      npc.playAttack?.(rnpc.x);
      runner._attackCooldown = runner._getAttackCooldownMs();
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

  // ── Absorb NPC ────────────────────────────────────────────────────────────────

  doAbsorbNPC(_delta) {
    const scene = this._scene;
    const npc = this._npc;
    const runner = this._runner;
    const cmd = runner._tasks[0] || {};
    let target = null;

    if (cmd.target_owner && cmd.target_npc_id) {
      target = scene._remoteNPCSprites?.[`${cmd.target_owner}_${cmd.target_npc_id}`] || null;
    }
    if (!target && cmd.target_id?.startsWith?.('npc:')) {
      const bareId = cmd.target_id.slice(4);
      target = Object.values(scene._remoteNPCSprites || {}).find(rnpc => rnpc?.npcId === bareId) || null;
    }
    if (!target) {
      target = this._findNearestKnockedOutEnemyNpc();
    }

    if (!target || target.isDead?.()) {
      npc.showBubble('No KO target to absorb…', 2000);
      runner._tasks.shift();
      return;
    }
    if (!target.isKnockedOut?.()) {
      npc.showBubble("They need to be KO'd first.", 2000);
      runner._tasks.shift();
      return;
    }

    if (!cmd._announced) {
      cmd._announced = true;
      const startLine = this._pickAbsorbLine('start', target.getName?.() || target.npcId || 'them');
      npc.showBubble(startLine, 2600, { silent: true });
      scene._addNPCSpeechToChat?.(npc, startLine, '#66e0ff');
    }

    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, target.x, target.y);
    if (dist > runner._ki._getKiBlastRange()) {
      npc.moveTo(target.x, target.y);
      return;
    }

    if (this._tryAbsorbKnockedOutNpc(target)) {
      runner._tasks.shift();
      return;
    }

    npc.stopMoving();
  }

  // ── Flee from a specific player / NPC ─────────────────────────────────────────

  doFleePlayer(_delta) {
    const scene = this._scene;
    const npc = this._npc;
    const runner = this._runner;
    const cmd = runner._tasks[0];
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
        runner._tasks.shift();
        return;
      }

      const dist = Phaser.Math.Distance.Between(npc.x, npc.y, target.x, target.y);
      const FLEE_RANGE = TILE_SIZE * 8;
      const SAFE_RANGE = TILE_SIZE * 10;

      if (dist >= SAFE_RANGE) {
        npc.stopMoving();
        runner._tasks.shift();
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
      runner._tasks.shift();
      return;
    }

    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, rp.x, rp.y);
    const FLEE_RANGE = TILE_SIZE * 8;
    const SAFE_RANGE = TILE_SIZE * 10;

    if (dist >= SAFE_RANGE) {
      npc.stopMoving();
      runner._tasks.shift();
      return;
    }

    const dx = npc.x - rp.x;
    const dy = npc.y - rp.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const fleeX = npc.x + (dx / len) * FLEE_RANGE;
    const fleeY = npc.y + (dy / len) * FLEE_RANGE;

    const worldW = (scene._mapCols || 60) * TILE_SIZE;
    const worldH = (scene._mapRows || 60) * TILE_SIZE;
    npc.moveTo(
      Math.max(TILE_SIZE, Math.min(worldW - TILE_SIZE, fleeX)),
      Math.max(TILE_SIZE, Math.min(worldH - TILE_SIZE, fleeY)),
    );
  }

  // ── Defend player ──────────────────────────────────────────────────────────────

  doDefend(_delta) {
    const scene = this._scene;
    const npc = this._npc;
    const runner = this._runner;
    const now = Date.now();
    const THREAT_EXPIRE_MS = 30000;

    for (const key of Object.keys(scene._recentThreats || {})) {
      if (now - scene._recentThreats[key] > THREAT_EXPIRE_MS) {
        delete scene._recentThreats[key];
      }
    }

    let nearestTarget = null;
    let nearestDist = DEFEND_RANGE;

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
      runner._faceTarget(npc, nearestTarget.entity);
      npc.playAttack?.(nearestTarget.entity.x);
      const conn = scene._conn;

      if (nearestTarget.type === 'player' && conn?.connected) {
        conn.send({ type: 'npc_attack_player', target_id: nearestTarget.id, str: npc.str, npc_id: npc.id });
      } else if (nearestTarget.type === 'npc' && conn?.connected) {
        conn.send({ type: 'npc_attack_npc', target_owner: nearestTarget.ownerId, target_npc_id: nearestTarget.npcId, str: npc.str, npc_id: npc.id });
      } else if (nearestTarget.type === 'dummy' && conn?.connected && nearestTarget.entity._serverId) {
        conn.send({ type: 'npc_attack_dummy', dummy_id: nearestTarget.entity._serverId, str: npc.str, npc_id: npc.id });
      }
    } else if (nearestTarget && nearestDist <= runner._ki._getKiBlastRange()
               && nearestTarget.type !== 'dummy'
               && runner._ki._tryRangedKiBlast(nearestTarget.entity, nearestTarget.type)) {
      npc.stopMoving();
    } else if (nearestTarget && nearestDist <= DEFEND_RANGE) {
      npc.moveTo(nearestTarget.entity.x, nearestTarget.entity.y);
    } else {
      runner._social.doFollow(_delta);
    }
  }
}
