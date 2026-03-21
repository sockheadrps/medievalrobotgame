// KiTaskHandler.js — handles practice_ki, train tasks and ki blast helpers
// Extracted from NPCTaskRunner.js. Receives (scene, npc, runner) in constructor.

import Phaser from 'phaser';
import { TILE_SIZE, TREE_CHOP_DIST, NRG_KEY } from '../../constants.js';

const KI_BLAST_RANGE = TILE_SIZE * 4;
const KI_BLAST_COOLDOWN_BASE = 1200;

export class KiTaskHandler {
  constructor(scene, npc, runner) {
    this._scene = scene;
    this._npc = npc;
    this._runner = runner;
  }

  // ── Ki blast range/speed/cooldown helpers ─────────────────────────────────────

  _getKiShotUpgrade(stat) {
    return Number(this._npc?.kiBlastBonuses?.[stat] || 0);
  }

  _getKiBlastCooldownMs() {
    const personalityMod = this._npc._personalityMod?.kiCd ?? 1.0;
    return Math.max(150, KI_BLAST_COOLDOWN_BASE * personalityMod * (1 - this._getKiShotUpgrade('cooldown') * 0.01));
  }

  _getKiBlastRange() {
    return KI_BLAST_RANGE * (1 + this._getKiShotUpgrade('range') * 0.01);
  }

  _getKiBlastProjectileSpeed() {
    return 400 * (1 + this._getKiShotUpgrade('speed') * 0.01);
  }

  // ── Ranged Ki Blast helper (used by combat methods) ───────────────────────────

  /**
   * Attempt a ranged ki blast at a target during combat.
   * Returns true if a blast was fired, false otherwise.
   */
  _tryRangedKiBlast(target, targetType) {
    const npc = this._npc;
    const runner = this._runner;
    if (!npc._hasKiBlast) return false;
    if (runner._kiBlastCooldown > 0) return false;
    if (!npc.infKi && npc.ki < npc.getBlastCost()) return false;

    npc.stopMoving();
    runner._faceTarget(npc, target);
    const fired = this._npcFireKiBlast(target, targetType);
    if (fired) {
      runner._kiBlastCooldown = this._getKiBlastCooldownMs();
    }
    return fired;
  }

  // ── NPC Ki Blast (visual + server message) ────────────────────────────────────

  /**
   * Fire a ki blast from this NPC toward a target entity, or in facing direction if null.
   * targetType: 'player' | 'npc' | 'ki_target' | null (miss/demo)
   * Returns true if blast was fired, false if not enough ki.
   */
  _npcFireKiBlast(target, targetType) {
    const npc = this._npc;
    const scene = this._scene;
    const runner = this._runner;

    if (!npc._hasKiBlast) return false;
    if (!npc.infKi && npc.ki < npc.getBlastCost()) return false;

    const cost = npc.getBlastCost();
    if (npc.infKi) {
      npc.ki = npc.maxKi;
    } else {
      npc.ki -= cost;
      npc._kiRegenAccum = 0;
    }

    const facing = npc._facing || 'down';
    const dirFrames = { down: 0, up: 1, right: 2, left: 3 };
    const blastFrame = dirFrames[facing] ?? 0;

    const projX = npc.x;
    const projY = npc.y - npc.displayHeight * 0.4;
    const proj = scene.add.sprite(projX, projY, NRG_KEY, blastFrame);
    proj.setScale(1.5);
    proj.setDepth(15);
    proj.setTint(Number(npc.auraTint ?? 0x4fd6ff));

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
      runner._faceTarget(npc, target);

      const targetProjY = target.y - (target.displayHeight || TILE_SIZE) * 0.4;
      const speed = this._getKiBlastProjectileSpeed();
      const impactPoint = scene._getKiBlastImpactPoint?.(projX, projY, target.x, targetProjY, false)
        || { x: target.x, y: targetProjY };
      const travelDist = Phaser.Math.Distance.Between(projX, projY, impactPoint.x, impactPoint.y);
      scene.tweens.add({
        targets: proj,
        x: impactPoint.x,
        y: impactPoint.y,
        duration: Math.max(120, (travelDist / speed) * 1000),
        onComplete: () => {
          scene._showKiBlastImpact?.(impactPoint.x, impactPoint.y, npc.auraTint, 18, false);
          proj.destroy();
        },
      });
    } else {
      const dirVecs = { down: { x: 0, y: 1 }, up: { x: 0, y: -1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
      const dir = dirVecs[facing] || dirVecs.down;
      const intendedEndX = projX + dir.x * this._getKiBlastRange();
      const intendedEndY = projY + dir.y * this._getKiBlastRange();
      const impactPoint = scene._getKiBlastImpactPoint?.(projX, projY, intendedEndX, intendedEndY, false)
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
          scene._showKiBlastImpact?.(endX, endY, npc.auraTint, 18, false);
          proj.destroy();
        },
      });
    }

    return true;
  }

  // ── Find and watch ki target ──────────────────────────────────────────────────

  _findAndWatchKiTarget(cmd) {
    const scene = this._scene;
    const npc = this._npc;
    const tx = cmd._kiTargetX;
    const ty = cmd._kiTargetY;
    let bestId = null;
    let bestDist = TILE_SIZE * 2;
    for (const [ktid, ktSprite] of Object.entries(scene._kiTargetSprites || {})) {
      const d = Phaser.Math.Distance.Between(tx, ty, ktSprite.x, ktSprite.y);
      if (d < bestDist) {
        bestDist = d;
        bestId = ktid;
      }
    }
    npc._watchingKiTarget = bestId;
  }

  // ── Train on dummy ────────────────────────────────────────────────────────────

  doTrain(_delta) {
    const scene = this._scene;
    const npc   = this._npc;
    const runner = this._runner;
    if (runner._attackCooldown > 0) { runner._attackCooldown -= _delta; return; }

    const dummies = (scene.dummies ?? []).filter(d => !d.isDead());
    if (dummies.length === 0) {
      npc.stopMoving();
      return;
    }

    if (!runner._target || runner._target.isDead()) {
      dummies.sort((a, b) =>
        Phaser.Math.Distance.Between(npc.x, npc.y, a.x, a.y) -
        Phaser.Math.Distance.Between(npc.x, npc.y, b.x, b.y)
      );
      runner._target = dummies[0];
    }

    const target = runner._target;
    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, target.x, target.y);
    const ATTACK_RANGE = TILE_SIZE * 1.2;

    if (dist > ATTACK_RANGE) {
      npc.moveTo(target.x, target.y);
    } else {
      npc.stopMoving();
      runner._faceTarget(npc, target);
      const conn = scene._conn;
      if (conn?.connected && target._serverId) {
        npc.playAttack?.(target.x);
        conn.send({ type: 'npc_attack_dummy', dummy_id: target._serverId, str: npc.str, npc_id: npc.id });
      } else {
        target.npcAttack(npc);
      }
      runner._attackCooldown = runner._getAttackCooldownMs();
      if (target.isDead()) {
        runner._target = null;
      }
    }
  }

  // ── Practice Ki ──────────────────────────────────────────────────────────────

  doPracticeKi(_delta) {
    const scene = this._scene;
    const npc = this._npc;
    const runner = this._runner;
    const cmd = runner._tasks[0];

    if (!npc._hasKiBlast) {
      this._doPracticeKi_watchAndLearn(_delta);
      return;
    }

    if (!cmd._practicePhase) {
      cmd._practicePhase = 'gather';
      cmd._practiceRounds = 0;
      cmd._practiceMaxRounds = 3 + Math.floor(Math.random() * 3);
      cmd._targetX = scene.player?.x ?? npc.x;
      cmd._targetY = scene.player?.y ?? npc.y;
      npc.showBubble(`Time to practice! ${cmd._practiceMaxRounds} rounds.`, 3000);
      scene._addNPCSpeechToChat?.(npc, 'Starting ki blast practice!', '#66bbff');
    }

    if (cmd._practiceRounds >= cmd._practiceMaxRounds) {
      npc.showBubble('Good practice session!', 3000);
      scene._addNPCSpeechToChat?.(npc, `Finished ${cmd._practiceRounds} rounds of ki practice.`, '#66bbff');
      runner._tasks.shift();
      return;
    }

    switch (cmd._practicePhase) {
      case 'gather':    this._practiceKi_gather(cmd, _delta); break;
      case 'return':    this._practiceKi_return(cmd, _delta); break;
      case 'build':     this._practiceKi_build(cmd, _delta); break;
      case 'step_back': this._practiceKi_stepBack(cmd, _delta); break;
      case 'blast':     this._practiceKi_blast(cmd, _delta); break;
    }
  }

  /**
   * NPC doesn't have ki blast yet — find a ki target and watch it,
   * waiting for the player to blast it so the NPC can learn (1/25 chance).
   */
  _doPracticeKi_watchAndLearn(_delta) {
    const npc = this._npc;
    const scene = this._scene;
    const runner = this._runner;
    const cmd = runner._tasks[0];

    if (!cmd._watchPhase) {
      cmd._watchPhase = 'find_target';
      cmd._watchBubbleShown = false;
    }

    const kiTargets = Object.entries(scene._kiTargetSprites || {});
    if (kiTargets.length === 0) {
      if (!cmd._watchBubbleShown) {
        npc.showBubble("I need a Ki Target to watch! Build one near me.", 4000);
        scene._addNPCSpeechToChat?.(npc, "I need a Ki Target to learn ki blast. Please build one!", '#ffaa44');
        cmd._watchBubbleShown = true;
      }
      npc.stopMoving();
      return;
    }

    let bestId = null, bestSprite = null, bestDist = Infinity;
    for (const [ktId, ktSprite] of kiTargets) {
      const d = Phaser.Math.Distance.Between(npc.x, npc.y, ktSprite.x, ktSprite.y);
      if (d < bestDist) {
        bestDist = d;
        bestId = ktId;
        bestSprite = ktSprite;
      }
    }

    const WATCH_DIST = 80;

    if (bestDist > WATCH_DIST) {
      npc.moveTo(bestSprite.x, bestSprite.y);
      if (!cmd._watchBubbleShown) {
        npc.showBubble("Going to watch the Ki Target...", 2500);
        cmd._watchBubbleShown = true;
      }
    } else {
      npc.stopMoving();
      runner._faceTarget(npc, bestSprite);
      npc._watchingKiTarget = bestId;

      if (!cmd._watchingMsg) {
        npc.showBubble("Watching... blast it so I can learn!", 4000);
        scene._addNPCSpeechToChat?.(npc, "I'm watching the Ki Target. Blast it so I can learn ki!", '#66bbff');
        cmd._watchingMsg = true;
      }

      if (npc._hasKiBlast) {
        npc.showBubble("I learned Ki Blast!!", 4000);
        scene._addNPCSpeechToChat?.(npc, "I learned Ki Blast!!", '#44ff44');
        npc._watchingKiTarget = null;
        delete cmd._watchPhase;
        delete cmd._watchBubbleShown;
        delete cmd._watchingMsg;
        return;
      }
    }
  }

  _practiceKi_gather(cmd, _delta) {
    const npc = this._npc;
    const scene = this._scene;
    const runner = this._runner;

    if (npc.logs >= 5) {
      cmd._practicePhase = 'return';
      npc.showBubble('Got the logs! Building a target.', 2000);
      return;
    }

    if (runner._chopCooldown > 0) {
      runner._chopCooldown -= _delta;
      npc.stopMoving();
      return;
    }

    if (!runner._target || runner._target._chopped) {
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
      runner._target = trees[0];
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
          conn.send({ type: 'npc_chop', tree_id: tree.treeIndex, owner_id: scene.playerId });
        }
        npc.logs = Math.min(npc.logs + 1, npc.maxLogs);
        npc.showBubble(`Chopping (${npc.logs}/10)`, 1500, { silent: true });
        runner._chopCooldown = 1500;
      }
      runner._target = null;
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
      if (Math.abs(dx) > Math.abs(dy)) {
        npc._facing = dx > 0 ? 'left' : 'right';
      } else {
        npc._facing = dy > 0 ? 'up' : 'down';
      }
      cmd._practicePhase = 'blast';
      cmd._blastTimer = 0;
      cmd._blastsThisRound = 0;

      this._findAndWatchKiTarget(cmd);
      npc.showBubble('Here goes!', 1500);
    }
  }

  _practiceKi_blast(cmd, _delta) {
    const npc = this._npc;
    const scene = this._scene;
    const runner = this._runner;
    cmd._blastTimer = (cmd._blastTimer || 0) + _delta;

    const targetId = npc._watchingKiTarget;
    const ktSprite = targetId ? scene._kiTargetSprites[targetId] : null;

    if (!ktSprite) {
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
        const player = scene.player;
        if (player) {
          cmd._targetX = player.x;
          cmd._targetY = player.y;
        }
        cmd._practicePhase = 'gather';
      }
      return;
    }

    if (cmd._blastTimer >= 1500) {
      cmd._blastTimer = 0;

      if (!npc.infKi && npc.ki < npc.getBlastCost()) {
        const lines = ['Recharging...', 'Need more ki...', 'Almost ready...'];
        npc.showBubble(lines[Math.floor(Math.random() * lines.length)], 1200, { silent: true });
        return;
      }

      runner._faceTarget(npc, ktSprite);
      this._npcFireKiBlast(ktSprite, 'ki_target');
      cmd._blastsThisRound++;

      const commentary = [
        'Hya!', 'Take that!', 'Ki Blast!', 'Pow!', 'Focus...!',
      ];
      npc.showBubble(commentary[Math.floor(Math.random() * commentary.length)], 1000, { silent: true });
    }
  }
}
