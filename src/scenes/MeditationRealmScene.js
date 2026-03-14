import Phaser from 'phaser';
import { buildTilemapFromData } from '../systems/TilemapBuilder.js';
import { TILE_SIZE } from '../constants.js';
import { API_BASE } from '../config.js';

const PLAYER_SPEED = 250;
const PROJECTILE_SPEED = 520;
const ORB_RADIUS = 16;
const PICKUP_RADIUS = 8;
const HIT_LIMIT = 3;
const REALM_TOP_MARGIN = 120;

function getRealmDifficultyProfile(quality) {
  const normalized = String(quality || 'poor').toLowerCase();
  if (normalized === 'pristine') {
    return { label: 'Pristine', speedMult: 1.6, spawnRateMult: 1.6 };
  }
  if (normalized === 'normal') {
    return { label: 'Ki Crystal', speedMult: 1.3, spawnRateMult: 1.3 };
  }
  return { label: 'Cracked', speedMult: 1.0, spawnRateMult: 1.0 };
}

export default class MeditationRealmScene extends Phaser.Scene {
  constructor() {
    super('MeditationRealmScene');
  }

  init(data) {
    this._sourceSceneKey = data?.sourceSceneKey || 'GameScene';
    this._actorType = data?.actorType || 'player';
    this._npcId = data?.npcId || null;
    this._actorName = data?.actorName || 'Meditator';
  }

  create() {
    this._sourceScene = this.scene.get(this._sourceSceneKey);
    this._realmWorldW = 15 * TILE_SIZE;
    this._realmWorldH = 15 * TILE_SIZE;
    this._blockedTiles = new Set();
    this._moveKeys = this.input.keyboard.addKeys({
      up: Phaser.Input.Keyboard.KeyCodes.W,
      down: Phaser.Input.Keyboard.KeyCodes.S,
      left: Phaser.Input.Keyboard.KeyCodes.A,
      right: Phaser.Input.Keyboard.KeyCodes.D,
      up2: Phaser.Input.Keyboard.KeyCodes.UP,
      down2: Phaser.Input.Keyboard.KeyCodes.DOWN,
      left2: Phaser.Input.Keyboard.KeyCodes.LEFT,
      right2: Phaser.Input.Keyboard.KeyCodes.RIGHT,
    });
    this._fireKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    this._escKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.ESC);

    this._shots = [];
    this._orbs = [];
    this._pickups = [];
    this._pendingRealmCrystalT1 = 0;
    this._hitsTaken = 0;
    this._coreSpawned = false;
    this._completed = false;
    this._spawnAccum = 0;
    this._fireCooldownMs = 0;
    this._core = null;
    this._difficultyProfile = getRealmDifficultyProfile(this._getActorState()?.meditationCrystalQuality);

    this.add.rectangle(this.scale.width / 2, this.scale.height / 2, this.scale.width, this.scale.height, 0x03040a, 0.98).setScrollFactor(0);
    this._loadRealmMap();

    this.add.text(this.scale.width / 2, 44, `Meditation Realm - ${this._actorName}`, {
      fontSize: '28px',
      color: '#aee9ff',
      fontStyle: 'bold',
    }).setOrigin(0.5).setScrollFactor(0);
    this._statusText = this.add.text(this.scale.width / 2, 82, `${this._difficultyProfile.label} entry. Dodge the shadows. Shoot them for realm crystals.`, {
      fontSize: '16px',
      color: '#8db9d8',
    }).setOrigin(0.5).setScrollFactor(0);
    this._hudText = this.add.text(32, 28, '', {
      fontSize: '18px',
      color: '#d8f6ff',
      fontStyle: 'bold',
    }).setScrollFactor(0);
    this._hintText = this.add.text(this.scale.width - 28, this.scale.height - 24, 'WASD/Arrows move  SPACE fire  ESC leave', {
      fontSize: '14px',
      color: '#7a94aa',
    }).setOrigin(1, 1).setScrollFactor(0);

    this._playerBorder = this.add.circle(this._realmWorldW / 2, this._realmWorldH / 2, 26, 0x000000, 0).setStrokeStyle(6, 0x3cf6ff, 1).setDepth(10);
    this._player = this.add.circle(this._realmWorldW / 2, this._realmWorldH / 2, 18, 0x06283b, 1).setStrokeStyle(5, 0xc8ffff, 1).setDepth(11);
    this._playerCore = this.add.circle(this._realmWorldW / 2, this._realmWorldH / 2, 7, 0xf6ffff, 1).setDepth(12);
    this._playerLabel = this.add.text(this._realmWorldW / 2, this._realmWorldH / 2 - 34, 'YOU', {
      fontSize: '12px',
      color: '#6ef7ff',
      fontStyle: 'bold',
      backgroundColor: '#00131acc',
      padding: { x: 4, y: 2 },
    }).setOrigin(0.5, 1).setDepth(13);
    this._playerFacing = new Phaser.Math.Vector2(1, 0);
    this._aura = this.add.circle(this._player.x, this._player.y, 30, 0x59a7ff, 0.15).setStrokeStyle(1, 0x8fd6ff, 0.35);
    this.tweens.add({
      targets: this._playerBorder,
      alpha: 0.45,
      scale: 1.12,
      yoyo: true,
      repeat: -1,
      duration: 420,
    });
    this.tweens.add({
      targets: this._playerCore,
      alpha: 0.65,
      yoyo: true,
      repeat: -1,
      duration: 260,
    });

    this.cameras.main.setBackgroundColor('#050912');
    this._layoutRealmCamera();
  }

  _layoutRealmCamera() {
    const cam = this.cameras.main;
    if (!cam) return;
    cam.stopFollow();
    const extraX = Math.max(0, this.scale.width - this._realmWorldW);
    const extraY = Math.max(0, this.scale.height - REALM_TOP_MARGIN - this._realmWorldH);
    cam.scrollX = -Math.floor(extraX / 2);
    cam.scrollY = -REALM_TOP_MARGIN - Math.floor(extraY / 2);
  }

  async _loadRealmMap() {
    try {
      const res = await fetch(`${API_BASE}/load-map?name=realm-1`);
      if (!res.ok) throw new Error(`Map load failed: ${res.status}`);
      const mapData = await res.json();
      const { width, height } = buildTilemapFromData(this, mapData);
      this._realmWorldW = width * TILE_SIZE;
      this._realmWorldH = height * TILE_SIZE;
      this._blockedTiles = new Set();
      for (let col = 0; col < width; col += 1) {
        this._blockedTiles.add(`${col},0`);
        this._blockedTiles.add(`${col},${height - 1}`);
      }
      for (let row = 0; row < height; row += 1) {
        this._blockedTiles.add(`0,${row}`);
        this._blockedTiles.add(`${width - 1},${row}`);
      }
      this._player.setPosition(this._realmWorldW / 2, this._realmWorldH / 2);
      this._playerBorder.setPosition(this._player.x, this._player.y);
      this._playerCore.setPosition(this._player.x, this._player.y);
      this._playerLabel.setPosition(this._player.x, this._player.y - 34);
      this._aura.setPosition(this._player.x, this._player.y);
      this._layoutRealmCamera();
    } catch (err) {
      console.warn('[realm] Failed to load realm-1, using fallback arena:', err?.message || err);
    }
  }

  _isBlocked(wx, wy) {
    const col = Math.floor(wx / TILE_SIZE);
    const row = Math.floor(wy / TILE_SIZE);
    return this._blockedTiles.has(`${col},${row}`);
  }

  _getActorState() {
    if (!this._sourceScene) return null;
    if (this._actorType === 'npc') {
      return this._sourceScene.npcs?.find((npc) => npc.id === this._npcId) || null;
    }
    return this._sourceScene.player || null;
  }

  _getActorKiUpgrade(stat) {
    const actor = this._getActorState();
    return Number(actor?.kiUpgrades?.ki_shot?.[stat] || 0);
  }

  _spawnOrb() {
    if (this._coreSpawned || this._completed) return;
    const side = Phaser.Math.Between(0, 1) === 0 ? 'left' : 'right';
    const y = Phaser.Math.Between(80, this._realmWorldH - 80);
    const x = side === 'left' ? -40 : this._realmWorldW + 40;
    const dir = side === 'left' ? 1 : -1;
    const orb = this.add.circle(x, y, ORB_RADIUS, 0x000000, 1).setStrokeStyle(2, 0x2f2f2f, 1);
    orb._vx = dir;
    orb._vy = Phaser.Math.FloatBetween(-0.12, 0.12);
    this._orbs.push(orb);
  }

  _spawnCore() {
    if (this._coreSpawned) return;
    this._coreSpawned = true;
    this._statusText.setText('The core is exposed. Hit the blue orb with a ki blast.');
    this._sourceScene?._conn?.send({
      type: 'pause_meditation_timer',
      npc_id: this._actorType === 'npc' ? this._npcId : null,
    });
    this._core = this.add.circle(this._realmWorldW / 2, this._realmWorldH / 2, 24, 0x288dff, 1).setStrokeStyle(4, 0xa3ddff, 1);
    this.tweens.add({
      targets: this._core,
      scale: 1.12,
      alpha: 0.86,
      yoyo: true,
      repeat: -1,
      duration: 480,
    });
  }

  _spawnPickup(x, y) {
    const pickup = this.add.circle(x, y, PICKUP_RADIUS, 0x87f7ff, 0.95).setStrokeStyle(2, 0xe5ffff, 1);
    pickup._bornAt = this.time.now;
    this._pickups.push(pickup);
  }

  _fireShot() {
    if (this._completed || this._fireCooldownMs > 0) return;
    this._fireCooldownMs = Math.max(100, 240 * (1 - this._getActorKiUpgrade('cooldown') * 0.01));
    const shot = this.add.circle(this._player.x, this._player.y, 6, 0x7af6ff, 1);
    shot._vx = this._playerFacing.x;
    shot._vy = this._playerFacing.y;
    this._shots.push(shot);
  }

  _collectRewards(requestMoveRoll) {
    if (this._completed) return;
    this._completed = true;
    if (this._sourceScene) {
      this._sourceScene._suppressMeditationRealmActorKey = this._actorType === 'npc' ? `npc:${this._npcId}` : 'player';
    }
    this._statusText.setText(requestMoveRoll ? 'Core shattered. Returning from meditation...' : 'Meditation ends. Returning...');
    this._sourceScene?._conn?.send({
      type: 'complete_meditation_realm',
      npc_id: this._actorType === 'npc' ? this._npcId : null,
      tier: 1,
      realm_crystal_t1: this._pendingRealmCrystalT1,
      request_move_roll: !!requestMoveRoll,
    });
    this.time.delayedCall(250, () => {
      if (this.scene.isActive()) this.scene.stop();
    });
  }

  update(_time, delta) {
    const actor = this._getActorState();
    if (!actor || !actor.meditating) {
      this.scene.stop();
      return;
    }

    if (Phaser.Input.Keyboard.JustDown(this._escKey)) {
      this._collectRewards(false);
      return;
    }

    const remainingMs = actor.meditationUntil
      ? Math.max(0, ((actor.meditationUntil || 0) - Date.now() / 1000) * 1000)
      : 0;
    const totalMs = Math.max(1, actor.meditationTotalMs || 1);
    const elapsedPct = Phaser.Math.Clamp(1 - (remainingMs / totalMs), 0, 1);
    const profile = getRealmDifficultyProfile(actor.meditationCrystalQuality);
    const orbSpeed = (140 * profile.speedMult) + (elapsedPct * 200);
    const spawnEveryMs = Math.max(260, (900 / profile.spawnRateMult) - (elapsedPct * 520));

    if (!this._completed && !this._coreSpawned && remainingMs <= 0) {
      this._statusText.setText('Meditation ran out before the core surfaced.');
      this._collectRewards(false);
      return;
    }

    const left = this._moveKeys.left.isDown || this._moveKeys.left2.isDown;
    const right = this._moveKeys.right.isDown || this._moveKeys.right2.isDown;
    const up = this._moveKeys.up.isDown || this._moveKeys.up2.isDown;
    const down = this._moveKeys.down.isDown || this._moveKeys.down2.isDown;
    let dx = (right ? 1 : 0) - (left ? 1 : 0);
    let dy = (down ? 1 : 0) - (up ? 1 : 0);
    if (dx !== 0 || dy !== 0) {
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      this._playerFacing.set(dx, dy);
      const nextX = Phaser.Math.Clamp(this._player.x + (dx * PLAYER_SPEED * delta / 1000), 24, this._realmWorldW - 24);
      const nextY = Phaser.Math.Clamp(this._player.y + (dy * PLAYER_SPEED * delta / 1000), 24, this._realmWorldH - 24);
      if (!this._isBlocked(nextX, this._player.y)) this._player.x = nextX;
      if (!this._isBlocked(this._player.x, nextY)) this._player.y = nextY;
    }
    this._playerBorder.setPosition(this._player.x, this._player.y);
    this._aura.setPosition(this._player.x, this._player.y);
    this._playerCore.setPosition(this._player.x, this._player.y);
    this._playerLabel.setPosition(this._player.x, this._player.y - 34);

    if (Phaser.Input.Keyboard.JustDown(this._fireKey)) {
      this._fireShot();
    }
    this._fireCooldownMs = Math.max(0, this._fireCooldownMs - delta);

    if (!this._coreSpawned) {
      this._spawnAccum += delta;
      while (this._spawnAccum >= spawnEveryMs) {
        this._spawnAccum -= spawnEveryMs;
        this._spawnOrb();
      }
    }

    const shotSpeed = PROJECTILE_SPEED * (1 + this._getActorKiUpgrade('speed') * 0.01);
    for (const shot of [...this._shots]) {
      shot.x += shot._vx * shotSpeed * delta / 1000;
      shot.y += shot._vy * shotSpeed * delta / 1000;
      if (shot.x < -20 || shot.x > this._realmWorldW + 20 || shot.y < -20 || shot.y > this._realmWorldH + 20) {
        Phaser.Utils.Array.Remove(this._shots, shot);
        shot.destroy();
        continue;
      }
      let consumed = false;
      for (const orb of [...this._orbs]) {
        if (Phaser.Math.Distance.Between(shot.x, shot.y, orb.x, orb.y) <= ORB_RADIUS + 8) {
          consumed = true;
          Phaser.Utils.Array.Remove(this._shots, shot);
          Phaser.Utils.Array.Remove(this._orbs, orb);
          shot.destroy();
          this._spawnPickup(orb.x, orb.y);
          orb.destroy();
          break;
        }
      }
      if (!consumed && this._core && Phaser.Math.Distance.Between(shot.x, shot.y, this._core.x, this._core.y) <= 32) {
        Phaser.Utils.Array.Remove(this._shots, shot);
        shot.destroy();
        this._core.destroy();
        this._core = null;
        this._collectRewards(true);
        return;
      }
    }

    for (const orb of [...this._orbs]) {
      orb.x += orb._vx * orbSpeed * delta / 1000;
      orb.y += orb._vy * orbSpeed * delta / 1000;
      if (orb.x < -80 || orb.x > this._realmWorldW + 80 || orb.y < -40 || orb.y > this._realmWorldH + 40) {
        Phaser.Utils.Array.Remove(this._orbs, orb);
        orb.destroy();
        continue;
      }
      if (Phaser.Math.Distance.Between(orb.x, orb.y, this._player.x, this._player.y) <= ORB_RADIUS + 18) {
        Phaser.Utils.Array.Remove(this._orbs, orb);
        orb.destroy();
        this._hitsTaken += 1;
        this.cameras.main.flash(120, 40, 40, 40, false);
        if (this._hitsTaken >= HIT_LIMIT) {
          for (const other of this._orbs.splice(0, this._orbs.length)) other.destroy();
          this._spawnCore();
          break;
        }
      }
    }

    for (const pickup of [...this._pickups]) {
      if (Phaser.Math.Distance.Between(pickup.x, pickup.y, this._player.x, this._player.y) <= 22) {
        Phaser.Utils.Array.Remove(this._pickups, pickup);
        pickup.destroy();
        this._pendingRealmCrystalT1 += 1;
        continue;
      }
      if (this.time.now - pickup._bornAt > 12000) {
        Phaser.Utils.Array.Remove(this._pickups, pickup);
        pickup.destroy();
      }
    }

    this._hudText.setText([
      `Hits: ${this._hitsTaken}/${HIT_LIMIT}`,
      `Realm Crystals: ${this._pendingRealmCrystalT1}`,
      `Time: ${this._coreSpawned ? 'PAUSED' : `${Math.ceil(remainingMs / 1000)}s`}`,
    ].join('   '));
  }
}
