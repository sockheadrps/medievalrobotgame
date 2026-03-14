import Phaser from 'phaser';
import { MAP_COLS, MAP_ROWS, NRG_KEY, TILE_SIZE, worldToTile, CRATER_KEY } from '../constants.js';

export class CombatFxController {
  constructor(scene) {
    this.scene = scene;
  }

  getKiShotUpgrade(actor, stat) {
    return Number(actor?.kiUpgrades?.ki_shot?.[stat] || 0);
  }

  getKiBlastRange(actor) {
    return TILE_SIZE * 4 * (1 + this.getKiShotUpgrade(actor, 'range') * 0.01);
  }

  getKiBlastCooldownMs(actor) {
    return Math.max(150, 1200 * (1 - this.getKiShotUpgrade(actor, 'cooldown') * 0.01));
  }

  getKiBlastProjectileSpeed(actor) {
    return 400 * (1 + this.getKiShotUpgrade(actor, 'speed') * 0.01);
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

  firePlayerKiBlast() {
    const scene = this.scene;
    const p = scene.player;
    if (!p || scene._playerDead || p._knockedOut || p.meditating) return;
    const shotMode = p.getEquippedKiAugment?.('ki_shot');

    const now = Date.now();
    const blastCooldown = this.getKiBlastCooldownMs(p);
    if (scene._lastBlastTime && now - scene._lastBlastTime < blastCooldown) return;

    if (!p.canBlast()) {
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

    const range = this.getKiBlastRange(p);
    const aim = this.getKiBlastAimInfo(p);
    let bestForward = range + 1;
    let target = null;
    let targetType = null;
    let targetSideOffset = 0;

    const considerTarget = (candidate, type) => {
      if (!candidate) return;
      if (shotMode === 'homing') {
        const distance = Phaser.Math.Distance.Between(p.x, p.y, candidate.x, candidate.y);
        if (distance > range || distance >= bestForward) return;
        bestForward = distance;
        target = candidate;
        targetType = type;
        targetSideOffset = 0;
        return;
      }
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
    for (const dummy of (scene.dummies || [])) {
      if (dummy.isDead?.()) continue;
      considerTarget(dummy, 'dummy');
    }
    for (const ktSprite of Object.values(scene._kiTargetSprites || {})) {
      considerTarget(ktSprite, 'ki_target');
    }

    const dirFrames = { down: 0, up: 1, right: 2, left: 3 };
    const blastFrame = dirFrames[aim.facing] ?? 0;
    const projX = p.x;
    const projY = p.y - p.displayHeight * 0.4;
    const proj = scene.add.sprite(projX, projY, NRG_KEY, blastFrame);
    proj.setScale(1.5);
    proj.setDepth(15);
    proj.setTint(Number(p.auraTint ?? 0x4fd6ff));
    const projectileSpeed = this.getKiBlastProjectileSpeed(p);

    const conn = scene._conn;
    if (conn?.connected) {
      if (target && targetType === 'player') {
        conn.send({ type: 'ki_blast_player', target_id: target.playerId });
      } else if (target && targetType === 'npc') {
        conn.send({ type: 'ki_blast_npc', owner_id: target.ownerPid, npc_id: target.npcId });
      } else if (target && targetType === 'dummy') {
        conn.send({ type: 'ki_blast_dummy', dummy_id: target._serverId });
      } else if (target && targetType === 'ki_target') {
        let watchingNpcId = null;
        for (const npc of scene.npcs) {
          if (npc._watchingKiTarget === target._serverId) {
            watchingNpcId = npc.id;
            break;
          }
        }
        conn.send({ type: 'ki_blast_ki_target', target_id: target._serverId, npc_id: watchingNpcId });
      } else {
        conn.send({ type: 'ki_blast_miss' });
      }
    }

    if (target) {
      const variance = Phaser.Math.Clamp(targetSideOffset + Phaser.Math.FloatBetween(-TILE_SIZE * 0.2, TILE_SIZE * 0.2), -aim.spread, aim.spread);
      const targetProjX = target.x + aim.perp.x * variance;
      const targetProjY = target.y - (target.displayHeight || TILE_SIZE) * 0.4 + aim.perp.y * variance;
      const impactPoint = this.getKiBlastImpactPoint(projX, projY, targetProjX, targetProjY, shotMode === 'explosive');
      const travelDist = Phaser.Math.Distance.Between(projX, projY, impactPoint.x, impactPoint.y);
      scene.tweens.add({
        targets: proj,
        x: impactPoint.x,
        y: impactPoint.y,
        duration: Math.max(120, (travelDist / projectileSpeed) * 1000),
        onComplete: () => {
          this.showKiBlastImpact(impactPoint.x, impactPoint.y, p.auraTint, shotMode === 'explosive' ? 28 : 18, shotMode === 'explosive');
          proj.destroy();
        },
      });
    } else {
      const sideOffset = Phaser.Math.FloatBetween(-aim.spread, aim.spread);
      const intendedEndX = projX + aim.dir.x * range + aim.perp.x * sideOffset;
      const intendedEndY = projY + aim.dir.y * range + aim.perp.y * sideOffset;
      const impactPoint = this.getKiBlastImpactPoint(projX, projY, intendedEndX, intendedEndY, shotMode === 'explosive');
      scene.tweens.add({
        targets: proj,
        x: impactPoint.x,
        y: impactPoint.y,
        alpha: 0,
        duration: Math.max(140, (range / projectileSpeed) * 1000),
        onComplete: () => {
          this.showKiBlastImpact(impactPoint.x, impactPoint.y, p.auraTint, shotMode === 'explosive' ? 28 : 18, shotMode === 'explosive');
          proj.destroy();
        },
      });
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

  showKiBlastImpact(worldX, worldY, tint = 0x44aaff, radius = 18, placeCrater = false) {
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
    if (placeCrater) this.placeTemporaryCrater(worldX, worldY);
  }

  handleReplicatedFxEvents(events) {
    for (const event of events || []) {
      if (!event || event.kind !== 'ki_blast') continue;
      if (event.owner_pid && event.owner_pid === this.scene.playerId) continue;
      this.renderReplicatedKiBlast(event);
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
    const proj = scene.add.sprite(startX, startY, NRG_KEY, blastFrame);
    proj.setScale(1.5);
    proj.setDepth(15);
    proj.setTint(Number(event.aura_tint ?? 0x4fd6ff));
    const dist = Phaser.Math.Distance.Between(startX, startY, impactX, impactY);
    scene.tweens.add({
      targets: proj,
      x: impactX,
      y: impactY,
      duration: Math.max(120, (dist / 400) * 1000),
      onComplete: () => {
        this.showKiBlastImpact(impactX, impactY, event.aura_tint, event.explosive ? 28 : 18, !!event.explosive);
        proj.destroy();
      },
    });
  }

  placeTemporaryCrater(worldX, worldY) {
    const scene = this.scene;
    const { col, row } = worldToTile(worldX, worldY);
    if (col < 0 || row < 0 || col >= MAP_COLS || row >= MAP_ROWS) return;
    const tileKey = `${col},${row}`;
    if (scene._kiBlastCraters.has(tileKey)) return;
    const craterX = col * TILE_SIZE + TILE_SIZE / 2;
    const craterY = row * TILE_SIZE + TILE_SIZE / 2;
    const crater = scene.add.image(craterX, craterY, CRATER_KEY);
    crater.setDisplaySize(TILE_SIZE, TILE_SIZE);
    crater.setDepth(1.5);
    crater.setAlpha(0.95);
    scene._kiBlastCraters.set(tileKey, crater);
    const lifetime = Phaser.Math.Between(30000, 60000);
    scene.time.delayedCall(lifetime, () => {
      const activeCrater = scene._kiBlastCraters.get(tileKey);
      if (activeCrater !== crater) return;
      scene._kiBlastCraters.delete(tileKey);
      if (crater.active) crater.destroy();
    });
  }
}
