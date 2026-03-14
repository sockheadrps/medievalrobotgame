// TrainingDummy — a stationary target that players and NPCs can attack for XP.
// Built with 10+ logs. HP scales with logs used: HP = logs * 5.
// Does not fight back. Shakes when hit. Destroyed when HP reaches 0.

import Phaser from 'phaser';
import { KI_MAX_BASE, KI_MAX_PER_LEVEL, TILE_SIZE } from '../constants.js';

const DUMMY_KEY = 'trainingdummy';
const DUMMY_FRAME = 0;
const SCALE = TILE_SIZE / 32; // 32px sprite frames → 48px tiles
const ATTACK_RANGE = TILE_SIZE * 1.5;
const ATTACK_COOLDOWN_MS = 800;

// XP awarded per hit
const XP_PER_HIT = 5;

// Leveling: XP needed = level * 20
function xpToLevel(currentLevel) {
  return currentLevel * 20;
}

export class TrainingDummy extends Phaser.GameObjects.Container {
  constructor(scene, x, y, logsUsed = 10) {
    super(scene, x, y);
    scene.add.existing(this);
    this.setDepth(1);

    this.logsUsed = Math.max(10, logsUsed);
    this.maxHp    = this.logsUsed * 5;
    this.hp       = this.maxHp;
    this._dead    = false;

    // Sprite
    this._sprite = scene.add.image(0, 0, DUMMY_KEY, DUMMY_FRAME).setScale(SCALE);
    this.add(this._sprite);

    // HP bar background
    this._hpBarBg = scene.add.rectangle(0, -TILE_SIZE / 2 - 6, 40, 4, 0x333333)
      .setOrigin(0.5, 0.5);
    this.add(this._hpBarBg);

    // HP bar fill
    this._hpBar = scene.add.rectangle(0, -TILE_SIZE / 2 - 6, 40, 4, 0xcc4444)
      .setOrigin(0.5, 0.5);
    this.add(this._hpBar);

    // HP text
    this._hpText = scene.add.text(0, -TILE_SIZE / 2 - 14, `${this.hp}/${this.maxHp}`, {
      fontSize: '8px', color: '#ffffff',
    }).setOrigin(0.5, 1);
    this.add(this._hpText);

    // Label
    this._label = scene.add.text(0, TILE_SIZE / 2 + 4, 'Training Dummy', {
      fontSize: '9px', color: '#ccaa66', backgroundColor: '#00000088',
      padding: { x: 3, y: 1 },
    }).setOrigin(0.5, 0);
    this.add(this._label);

    // Make clickable for player attacks
    this._sprite.setInteractive({ useHandCursor: true });
    this._sprite.on('pointerdown', () => this._onClicked());
    this._sprite.on('pointerover', () => { if (!this._dead) this._sprite.setTint(0xffaaaa); });
    this._sprite.on('pointerout', () => this._sprite.clearTint());

    // Attack cooldown tracking per attacker
    this._lastAttackTime = new Map();
  }

  isDead() { return this._dead; }

  /** Attack this dummy. Returns XP earned (0 if on cooldown or dead). */
  attack(attacker, str = 1) {
    if (this._dead) return 0;

    const id = attacker.id ?? 'player';
    const now = Date.now();
    const last = this._lastAttackTime.get(id) ?? 0;
    if (now - last < ATTACK_COOLDOWN_MS) return 0;
    this._lastAttackTime.set(id, now);

    // Damage based on attacker STR
    const dmg = Math.max(1, str + Phaser.Math.Between(0, Math.ceil(str / 2)));
    this.hp = Math.max(0, this.hp - dmg);

    // Visual feedback — shake
    this.scene.tweens.add({
      targets: this._sprite,
      x: 4,
      duration: 30,
      yoyo: true,
      repeat: 2,
      onComplete: () => { this._sprite.x = 0; },
    });

    // Damage number popup
    const dmgText = this.scene.add.text(this.x, this.y - TILE_SIZE, `-${dmg}`, {
      fontSize: '12px', color: '#ff4444', fontStyle: 'bold',
    }).setOrigin(0.5, 1).setDepth(20);
    this.scene.tweens.add({
      targets: dmgText,
      y: dmgText.y - 20,
      alpha: 0,
      duration: 800,
      onComplete: () => dmgText.destroy(),
    });

    // Update HP display
    this._updateHpBar();

    if (this.hp <= 0) {
      this._destroy();
    }

    return XP_PER_HIT;
  }

  /** Check if attacker is facing this dummy. */
  _isFacing(attacker) {
    const facing = attacker.getFacing?.();
    if (!facing) return true; // no facing info = allow
    const dx = this.x - attacker.x;
    const dy = this.y - attacker.y;
    // Check the dominant axis matches facing direction
    if (Math.abs(dx) > Math.abs(dy)) {
      return (dx > 0 && facing === 'right') || (dx < 0 && facing === 'left');
    } else {
      return (dy > 0 && facing === 'down') || (dy < 0 && facing === 'up');
    }
  }

  _onClicked() {
    if (this._dead) return;

    const player = this.scene.player;
    const dist = Phaser.Math.Distance.Between(player.x, player.y, this.x, this.y);

    if (dist > ATTACK_RANGE) {
      const farText = this.scene.add.text(this.x, this.y - TILE_SIZE - 20, 'Too far!', {
        fontSize: '10px', color: '#ff4444', backgroundColor: '#00000088',
        padding: { x: 3, y: 2 },
      }).setOrigin(0.5, 1).setDepth(20);
      this.scene.time.delayedCall(1000, () => farText.destroy());
      return;
    }

    if (!this._isFacing(player)) {
      const faceText = this.scene.add.text(this.x, this.y - TILE_SIZE - 20, 'Not facing target!', {
        fontSize: '10px', color: '#ffaa44', backgroundColor: '#00000088',
        padding: { x: 3, y: 2 },
      }).setOrigin(0.5, 1).setDepth(20);
      this.scene.time.delayedCall(1000, () => faceText.destroy());
      return;
    }

    // Play attack animation locally for responsiveness
    player.playAttack?.(this.x);

    // Send attack to server if we have a server ID
    const conn = this.scene._conn;
    if (conn?.connected && this._serverId) {
      conn.send({ type: 'attack_dummy', dummy_id: this._serverId });
    } else {
      // Fallback: local-only (e.g. NPC-spawned dummies without server)
      const xp = this.attack(player, player.str);
      if (xp > 0) {
        this._awardXP(player, xp);
      }
    }
  }

  _awardXP(entity, xp) {
    entity.xp = (entity.xp ?? 0) + xp;

    // Check for level up
    const needed = xpToLevel(entity.level ?? 1);
    if (entity.xp >= needed) {
      entity.xp -= needed;
      entity.level = (entity.level ?? 1) + 1;

      // Stat boost on level up
      entity.maxHp += 2;
      entity.hp = entity.maxHp;
      entity.str += 1;
      entity.def += 1;
      entity.maxKi = Math.max(entity.maxKi ?? KI_MAX_BASE, KI_MAX_BASE + Math.max(0, (entity.level ?? 1) - 1) * KI_MAX_PER_LEVEL);
      entity.ki = entity.maxKi;

      // Level up visual
      const name = entity.getName?.() ?? 'Player';
      const lvlText = this.scene.add.text(entity.x, entity.y - TILE_SIZE, `${name} Level ${entity.level}!`, {
        fontSize: '14px', color: '#ffff44', fontStyle: 'bold',
        backgroundColor: '#00000099', padding: { x: 4, y: 2 },
      }).setOrigin(0.5, 1).setDepth(20);
      this.scene.tweens.add({
        targets: lvlText,
        y: lvlText.y - 30,
        alpha: 0,
        duration: 2000,
        onComplete: () => lvlText.destroy(),
      });
    }

    // XP popup
    const xpText = this.scene.add.text(entity.x + 15, entity.y - TILE_SIZE + 10, `+${xp} XP`, {
      fontSize: '10px', color: '#44ff44',
    }).setOrigin(0.5, 1).setDepth(20);
    this.scene.tweens.add({
      targets: xpText,
      y: xpText.y - 15,
      alpha: 0,
      duration: 1000,
      onComplete: () => xpText.destroy(),
    });
  }

  /** Called by NPC task runner to attack this dummy. */
  npcAttack(npc) {
    if (!this._isFacing(npc)) return false;
    npc.playAttack?.(this.x);
    const xp = this.attack(npc, npc.str);
    if (xp > 0) {
      this._awardXP(npc, xp);
    }
    return xp > 0;
  }

  _updateHpBar() {
    const pct = this.hp / this.maxHp;
    this._hpBar.setDisplaySize(40 * pct, 4);
    this._hpText.setText(`${this.hp}/${this.maxHp}`);
  }

  _destroy() {
    this._dead = true;
    this._sprite.disableInteractive();

    // Death animation
    this.scene.tweens.add({
      targets: this,
      alpha: 0,
      scaleX: 0.5,
      scaleY: 0.5,
      duration: 500,
      onComplete: () => {
        // Remove from scene array
        const arr = this.scene.dummies ?? [];
        const idx = arr.indexOf(this);
        if (idx >= 0) arr.splice(idx, 1);
        this.destroy();
      },
    });
  }

  destroy(fromScene) {
    this._lastAttackTime?.clear();
    super.destroy(fromScene);
  }
}
