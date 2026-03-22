import Phaser from 'phaser';
import { ABSORB_FRAMES, ABSORB_KEY, BLAST_DEFS, BLAST_SPRITE_META, NRG_KEY, TILE_SIZE } from '../constants.js';

const ABSORB_DURATION_MS = 2000;
const ABSORB_TINT = 0x66ffff;

export class CombatFxController {
  constructor(scene) {
    this.scene = scene;
  }

  getKiShotUpgrade(actor, stat) {
    return Number(actor?.kiBlastBonuses?.[stat] || 0);
  }

  getKiBlastRange(actor) {
    return TILE_SIZE * 4 * (1 + this.getKiShotUpgrade(actor, 'blast_range') * 0.01);
  }

  getKiBlastCooldownMs(actor) {
    return Math.max(150, 1200 * (1 - this.getKiShotUpgrade(actor, 'blast_cooldown') * 0.01));
  }

  getKiBlastProjectileSpeed(actor) {
    return 400 * (1 + this.getKiShotUpgrade(actor, 'blast_speed') * 0.01);
  }

  getKiBlastAimInfo(actor) {
    const facing = actor?._facing || 'down';
    const dirMap = {
      down: { x: 0, y: 1 },
      up: { x: 0, y: -1 },
      left: { x: -1, y: 0 },
      right: { x: 1, y: 0 },
    };
    const dir = dirMap[facing] || dirMap.down;
    return {
      facing,
      dir,
      perp: { x: -dir.y, y: dir.x },
      spread: TILE_SIZE * 1.5,
    };
  }

  getKiModeCostMult(mode) {
    if (mode === 'scatter_shot') return 2;
    if (mode === 'explosive_shot') return 3;
    return 1;
  }

  ensureAbsorbAnim() {
    const scene = this.scene;
    if (scene.anims.exists('absorb-channel')) return;
    scene.anims.create({
      key: 'absorb-channel',
      frames: scene.anims.generateFrameNumbers(ABSORB_KEY, { start: 0, end: ABSORB_FRAMES - 1 }),
      frameRate: ABSORB_FRAMES / (ABSORB_DURATION_MS / 1000),
      repeat: -1,
    });
  }

  playAbsorbEffect(startX, startY, endX, endY, duration = ABSORB_DURATION_MS) {
    const scene = this.scene;
    this.ensureAbsorbAnim();
    const midX = (startX + endX) * 0.5;
    const midY = (startY + endY) * 0.5;
    const dist = Phaser.Math.Distance.Between(startX, startY, endX, endY);
    const beam = scene.add.sprite(midX, midY, ABSORB_KEY, 0);
    beam.setDepth(15);
    beam.setTint(ABSORB_TINT);
    beam.setAlpha(0.92);
    beam.setAngle(Phaser.Math.RadToDeg(Phaser.Math.Angle.Between(startX, startY, endX, endY)));
    beam.setScale(Math.max(1, dist / TILE_SIZE), 1.2);
    beam.play('absorb-channel');

    const startPulse = scene.add.circle(startX, startY, 18, ABSORB_TINT, 0.28).setDepth(16);
    const endPulse = scene.add.circle(endX, endY, 20, ABSORB_TINT, 0.34).setDepth(16);
    scene.tweens.add({
      targets: [startPulse, endPulse],
      scaleX: 1.5,
      scaleY: 1.5,
      alpha: 0.05,
      yoyo: true,
      repeat: Math.max(0, Math.round(duration / 250) - 1),
      duration: 250,
    });

    scene.time.delayedCall(duration, () => {
      beam.destroy();
      startPulse.destroy();
      endPulse.destroy();
      this.showKiBlastImpact(endX, endY, ABSORB_TINT, 24, false);
    });
  }

  findAbsorbTarget(actor, range, aim) {
    let bestForward = range + 1;
    let target = null;

    const considerTarget = (candidate) => {
      if (!candidate?.isKnockedOut?.() || candidate.isDead?.()) return;
      const dx = candidate.x - actor.x;
      const dy = candidate.y - actor.y;
      const forward = dx * aim.dir.x + dy * aim.dir.y;
      if (forward <= 0 || forward > range) return;
      const side = dx * aim.perp.x + dy * aim.perp.y;
      if (Math.abs(side) > aim.spread) return;
      if (forward < bestForward) {
        bestForward = forward;
        target = candidate;
      }
    };

    for (const rnpc of Object.values(this.scene._remoteNPCSprites || {})) considerTarget(rnpc);
    for (const npc of this.scene.npcs || []) considerTarget(npc);
    return target;
  }

  startPlayerAbsorb(target) {
    const scene = this.scene;
    const p = scene.player;
    const conn = scene._conn;
    if (!target || !conn?.connected) return false;

    const startX = p.x;
    const startY = p.y - p.displayHeight * 0.4;
    const endX = target.x;
    const endY = target.y - (target.displayHeight || TILE_SIZE) * 0.4;
    this.playAbsorbEffect(startX, startY, endX, endY, ABSORB_DURATION_MS);
    scene._lastBlastTime = Date.now();
    conn.send({
      type: 'absorb_npc',
      owner_id: target.ownerPid || scene.playerId,
      npc_id: target.npcId || target.id,
    });
    return true;
  }

  firePlayerAbsorb() {
    const scene = this.scene;
    const p = scene.player;
    if (!p || scene._playerDead || p._knockedOut) return;
    if (!(p.kiMoves || []).includes('absorb')) return;

    const now = Date.now();
    const cooldown = this.getKiBlastCooldownMs(p);
    if (scene._lastBlastTime && now - scene._lastBlastTime < cooldown) return;

    const range = this.getKiBlastRange(p);
    const aim = this.getKiBlastAimInfo(p);
    const target = this.findAbsorbTarget(p, range, aim);
    const estCost = p.getBlastCost?.() ?? 3;
    if (!target || (!p.infKi && p.ki < estCost)) return;
    this.startPlayerAbsorb(target);
  }

  firePlayerKiBlast() {
    const scene = this.scene;
    const p = scene.player;
    if (!p || scene._playerDead || p._knockedOut) return;

    const mode = p.activeKiMode || 'ki_shot';
    const costMult = this.getKiModeCostMult(mode);
    const now = Date.now();
    const blastCooldown = this.getKiBlastCooldownMs(p) * (mode === 'explosive_shot' ? 1.5 : 1);
    if (scene._lastBlastTime && now - scene._lastBlastTime < blastCooldown) return;

    const range = this.getKiBlastRange(p);
    const aim = this.getKiBlastAimInfo(p);
    const estCost = (p.getBlastCost?.() ?? 3) * costMult;
    if (!p.infKi && p.ki < estCost) {
      if (scene._pf_kiBar) {
        scene.tweens.add({
          targets: scene._pf_kiBar,
          alpha: 0.3,
          yoyo: true,
          duration: 120,
          repeat: 2,
        });
      }
      return;
    }

    scene._lastBlastTime = now;

    let bestForward = range + 1;
    let target = null;
    let targetType = null;
    let targetSideOffset = 0;

    const considerTarget = (candidate, type) => {
      if (!candidate) return;
      const dx = candidate.x - p.x;
      const dy = candidate.y - p.y;
      const forward = dx * aim.dir.x + dy * aim.dir.y;
      if (forward <= 0 || forward > range) return;
      const side = dx * aim.perp.x + dy * aim.perp.y;
      if (Math.abs(side) > aim.spread) return;
      if (forward < bestForward) {
        bestForward = forward;
        target = candidate;
        targetType = type;
        targetSideOffset = side;
      }
    };

    for (const rp of Object.values(scene._remotePlayers || {})) {
      if (rp.isDead?.() || rp.isKnockedOut?.()) continue;
      considerTarget(rp, 'player');
    }
    for (const rnpc of Object.values(scene._remoteNPCSprites || {})) {
      if (rnpc.isDead?.() || rnpc.isKnockedOut?.()) continue;
      considerTarget(rnpc, 'npc');
    }
    for (const dummy of scene.dummies || []) {
      if (dummy.isDead?.()) continue;
      considerTarget(dummy, 'dummy');
    }
    for (const ktSprite of Object.values(scene._kiTargetSprites || {})) considerTarget(ktSprite, 'ki_target');
    for (const gi of Object.values(scene._groundItemSprites || {})) {
      if (!gi._placed) continue;
      if (gi.resource !== 'Wood' && gi.resource !== 'log') continue;
      considerTarget(gi, 'ground_item');
    }

    const dirFrames = { down: 0, up: 1, right: 2, left: 3 };
    const blastFrame = dirFrames[aim.facing] ?? 0;
    const projX = p.x;
    const projY = p.y - p.displayHeight * 0.4;
    const activeBlastId = p.activeBlastId;
    const blastDef = activeBlastId ? BLAST_DEFS[activeBlastId] : null;
    const blastSprite = blastDef?.sprite ?? null;
    const blastMeta = blastSprite ? BLAST_SPRITE_META[blastSprite] : null;

    let projKey = NRG_KEY;
    let projFrame = blastFrame;
    if (blastSprite && blastMeta && scene.textures.exists(`blast_${blastSprite}`)) {
      projKey = `blast_${blastSprite}`;
      const dirs = blastMeta.dirs;
      if (dirs === 1) {
        projFrame = 0;
      } else {
        const dirMap4 = { down: 0, up: 1, right: 2, left: 3 };
        projFrame = dirMap4[aim.facing] ?? 0;
      }
    }

    const proj = scene.add.sprite(projX, projY, projKey, projFrame);
    proj.setScale(1.5);
    proj.setDepth(15);
    if (!blastSprite) {
      proj.setTint(Number(p.auraTint ?? 0x4fd6ff));
    }

    if (blastMeta && blastMeta.frames > 1 && scene.textures.exists(projKey)) {
      const animKey = `blast_anim_${blastSprite}_${aim.facing}`;
      if (!scene.anims.exists(animKey)) {
        const dirs = blastMeta.dirs;
        const frameNums = [];
        for (let f = 0; f < blastMeta.frames; f++) {
          let idx;
          if (dirs === 1) {
            idx = f;
          } else {
            const d = { down: 0, up: 1, right: 2, left: 3 };
            const dirIdx = Math.min(d[aim.facing] ?? 0, dirs - 1);
            idx = dirIdx + f * dirs;
          }
          frameNums.push(idx);
        }
        scene.anims.create({
          key: animKey,
          frames: frameNums.map(n => ({ key: projKey, frame: n })),
          frameRate: 8,
          repeat: -1,
        });
      }
      proj.play(animKey);
    }

    const projectileSpeed = this.getKiBlastProjectileSpeed(p);

    const conn = scene._conn;
    if (conn?.connected) {
      const modeExtra = mode !== 'ki_shot' ? { blast_mode: mode } : {};
      if (target && targetType === 'player') {
        conn.send({ type: 'ki_blast_player', target_id: target.playerId, ...modeExtra });
      } else if (target && targetType === 'npc') {
        conn.send({ type: 'ki_blast_npc', owner_id: target.ownerPid, npc_id: target.npcId, ...modeExtra });
      } else if (target && targetType === 'dummy') {
        conn.send({ type: 'ki_blast_dummy', dummy_id: target._serverId, ...modeExtra });
      } else if (target && targetType === 'ki_target') {
        let watchingNpcId = null;
        for (const npc of scene.npcs) {
          if (npc._watchingKiTarget === target._serverId) {
            watchingNpcId = npc.id;
            break;
          }
        }
        conn.send({ type: 'ki_blast_ki_target', target_id: target._serverId, npc_id: watchingNpcId, ...modeExtra });
      } else if (target && targetType === 'ground_item') {
        conn.send({ type: 'ki_blast_ground_item', item_id: target._serverId, ...modeExtra });
      } else {
        conn.send({ type: 'ki_blast_miss', ...modeExtra });
      }
    }

    const isExplosive = mode === 'explosive_shot';
    const impactRadius = isExplosive ? 40 : 18;
    const tint = Number(p.auraTint ?? 0x4fd6ff);
    if (isExplosive) proj.setScale(2.2);

    const animateProj = (sprite, endX, endY, miss = false) => {
      const dist = Phaser.Math.Distance.Between(projX, projY, endX, endY);
      scene.tweens.add({
        targets: sprite,
        x: endX,
        y: endY,
        alpha: miss ? 0 : 1,
        duration: Math.max(120, (dist / projectileSpeed) * 1000),
        onComplete: () => {
          if (!sprite.active) return;
          this.showKiBlastImpact(endX, endY, tint, impactRadius, false);
          sprite.destroy();
        },
      });
    };

    if (target) {
      const variance = Phaser.Math.Clamp(targetSideOffset + Phaser.Math.FloatBetween(-TILE_SIZE * 0.2, TILE_SIZE * 0.2), -aim.spread, aim.spread);
      const targetProjX = target.x + aim.perp.x * variance;
      const targetProjY = target.y - (target.displayHeight || TILE_SIZE) * 0.4 + aim.perp.y * variance;
      const impactPoint = this.getKiBlastImpactPoint(projX, projY, targetProjX, targetProjY, false);
      animateProj(proj, impactPoint.x, impactPoint.y);
    } else {
      const sideOffset = Phaser.Math.FloatBetween(-aim.spread, aim.spread);
      const intendedEndX = projX + aim.dir.x * range + aim.perp.x * sideOffset;
      const intendedEndY = projY + aim.dir.y * range + aim.perp.y * sideOffset;
      const impactPoint = this.getKiBlastImpactPoint(projX, projY, intendedEndX, intendedEndY, false);
      animateProj(proj, impactPoint.x, impactPoint.y, true);
    }

    if (mode === 'scatter_shot') {
      for (const sign of [-1, 1]) {
        const sideProj = scene.add.sprite(projX, projY, NRG_KEY, blastFrame);
        sideProj.setScale(1.2).setDepth(15).setTint(tint).setAlpha(0.8);
        const spreadAngle = sign * TILE_SIZE * 1.8;
        const endX = projX + aim.dir.x * range + aim.perp.x * spreadAngle;
        const endY = projY + aim.dir.y * range + aim.perp.y * spreadAngle;
        const ip = this.getKiBlastImpactPoint(projX, projY, endX, endY, false);
        animateProj(sideProj, ip.x, ip.y, !target);
      }
    }
  }

  getKiBlastImpactPoint(startX, startY, endX, endY, allowEarlyDetonation = false) {
    const travelDist = Phaser.Math.Distance.Between(startX, startY, endX, endY);
    if (!allowEarlyDetonation) return { x: endX, y: endY };
    const rangeTiles = travelDist / TILE_SIZE;
    const cappedRangeTiles = Math.min(rangeTiles, 7);
    let earlyMaxTiles = 0;
    if (cappedRangeTiles <= 6) earlyMaxTiles = 2;
    else if (cappedRangeTiles <= 7) earlyMaxTiles = 3;

    let effectiveDist = travelDist;
    if (earlyMaxTiles > 0 && Math.random() < 0.2) {
      const earlyTiles = Phaser.Math.Between(1, earlyMaxTiles);
      effectiveDist = Math.max(TILE_SIZE, travelDist - earlyTiles * TILE_SIZE);
    }
    if (effectiveDist >= travelDist) return { x: endX, y: endY };
    const dx = endX - startX;
    const dy = endY - startY;
    const len = Math.max(1, Math.hypot(dx, dy));
    const scale = effectiveDist / len;
    return { x: startX + dx * scale, y: startY + dy * scale };
  }

  showKiBlastImpact(worldX, worldY, tint = 0x44aaff, radius = 18, _placeCrater = false) {
    const scene = this.scene;
    const flash = scene.add.circle(worldX, worldY, radius, Number(tint ?? 0x44aaff), 0.7).setDepth(16);
    scene.tweens.add({
      targets: flash,
      alpha: 0,
      scaleX: 2,
      scaleY: 2,
      duration: 250,
      onComplete: () => flash.destroy(),
    });
  }

  handleReplicatedFxEvents(events) {
    for (const event of events || []) {
      if (!event) continue;
      if (event.owner_pid && event.owner_pid === this.scene.playerId) continue;
      if (event.kind === 'ki_blast') this.renderReplicatedKiBlast(event);
      if (event.kind === 'absorb') this.renderReplicatedAbsorb(event);
    }
  }

  renderReplicatedKiBlast(event) {
    const scene = this.scene;
    const facing = event.facing || 'down';
    const dirFrames = { down: 0, up: 1, right: 2, left: 3 };
    const blastFrame = dirFrames[facing] ?? 0;
    let startX = Number(event.start_x || 0);
    let startY = Number(event.start_y || 0);
    if (event.owner_pid && event.npc_id) {
      const rnpc = scene._remoteNPCSprites?.[`${event.owner_pid}_${event.npc_id}`];
      if (rnpc) {
        startX = rnpc.x;
        startY = rnpc.y - (rnpc.displayHeight || TILE_SIZE) * 0.4;
      }
    } else if (event.owner_pid) {
      const rp = scene._remotePlayers?.[event.owner_pid];
      if (rp) {
        startX = rp.x;
        startY = rp.y - (rp.displayHeight || TILE_SIZE) * 0.4;
      }
    }
    const impactX = Number(event.impact_x || startX);
    const impactY = Number(event.impact_y || startY);
    const repBlastId = event.blast_id;
    const repDef = repBlastId ? BLAST_DEFS[repBlastId] : null;
    const repSprite = repDef?.sprite ?? null;
    const repKey = (repSprite && scene.textures.exists(`blast_${repSprite}`)) ? `blast_${repSprite}` : NRG_KEY;
    let repFrame = blastFrame;
    if (repSprite && repKey !== NRG_KEY) {
      const repMeta = BLAST_SPRITE_META[repSprite];
      if (repMeta) {
        if (repMeta.dirs === 1) {
          repFrame = 0;
        } else {
          const dirMap4 = { down: 0, up: 1, right: 2, left: 3 };
          repFrame = dirMap4[facing] ?? 0;
        }
      }
    }
    const proj = scene.add.sprite(startX, startY, repKey, repFrame);
    proj.setScale(1.5);
    proj.setDepth(15);
    if (repKey === NRG_KEY) {
      proj.setTint(0x4fd6ff);
    }
    const dist = Phaser.Math.Distance.Between(startX, startY, impactX, impactY);
    scene.tweens.add({
      targets: proj,
      x: impactX,
      y: impactY,
      duration: Math.max(120, (dist / 400) * 1000),
      onComplete: () => {
        if (!proj.active) return;
        this.showKiBlastImpact(impactX, impactY, 0x4fd6ff, 18, false);
        proj.destroy();
      },
    });
  }

  renderReplicatedAbsorb(event) {
    const scene = this.scene;
    let startX = Number(event.start_x || 0);
    let startY = Number(event.start_y || 0);
    if (event.owner_pid && event.npc_id) {
      const rnpc = scene._remoteNPCSprites?.[`${event.owner_pid}_${event.npc_id}`];
      if (rnpc) {
        startX = rnpc.x;
        startY = rnpc.y - (rnpc.displayHeight || TILE_SIZE) * 0.4;
      }
    } else if (event.owner_pid) {
      const rp = scene._remotePlayers?.[event.owner_pid];
      if (rp) {
        startX = rp.x;
        startY = rp.y - (rp.displayHeight || TILE_SIZE) * 0.4;
      }
    }
    const endX = Number(event.impact_x || startX);
    const endY = Number(event.impact_y || startY);
    this.playAbsorbEffect(startX, startY, endX, endY, Number(event.duration_ms || ABSORB_DURATION_MS));
  }
}
