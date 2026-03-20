// Etrainer — Eternal Training Dummy.
// Infinite HP, never destroyed. Placeable via hotbar.
// Uses roguelike tilemap frame 587. NPCs will train on it autonomously.

import Phaser from 'phaser';
import { SHEET_KEY, FRAME_ETRAINER, TILE_SIZE, KI_MAX_BASE, KI_MAX_PER_LEVEL } from '../constants.js';

const SCALE = TILE_SIZE / 16; // roguelike tiles are 16px
const ATTACK_RANGE = TILE_SIZE * 1.5;
const ATTACK_COOLDOWN_MS = 800;
const XP_PER_HIT = 5;

function xpToLevel(currentLevel) {
  return currentLevel * 20;
}

export class Etrainer extends Phaser.GameObjects.Container {
  constructor(scene, x, y) {
    super(scene, x, y);
    scene.add.existing(this);
    this.setDepth(1);

    this.maxHp = 999999;
    this.hp    = this.maxHp;
    this._dead = false;
    this._isEtrainer = true;

    // Sprite from roguelike tilemap
    this._sprite = scene.add.image(0, 0, SHEET_KEY, FRAME_ETRAINER).setScale(SCALE);
    this.add(this._sprite);

    // Label
    this._label = scene.add.text(0, TILE_SIZE / 2 + 4, 'Etrainer', {
      fontSize: '9px', color: '#66ccff', backgroundColor: '#00000088',
      padding: { x: 3, y: 1 },
    }).setOrigin(0.5, 0);
    this.add(this._label);

    // Infinity HP label
    this._hpText = scene.add.text(0, -TILE_SIZE / 2 - 10, '∞ HP', {
      fontSize: '8px', color: '#66ccff',
    }).setOrigin(0.5, 1);
    this.add(this._hpText);

    // Make clickable for player attacks
    this._sprite.setInteractive({ useHandCursor: true });
    this._sprite.on('pointerdown', (pointer) => {
      if (pointer.rightButtonDown()) {
        pointer._fgHandled = true;
        if (this._serverId) {
          scene._openBuildingContextMenu(this._serverId, 'etrainer', pointer, this);
        }
      } else {
        this._onClicked();
      }
    });
    this._sprite.on('pointerover', () => this._sprite.setTint(0xaaddff));
    this._sprite.on('pointerout', () => this._sprite.clearTint());

    this._lastAttackTime = new Map();
  }

  isDead() { return false; }

  attack(attacker, str = 1) {
    const id = attacker.id ?? 'player';
    const now = Date.now();
    const last = this._lastAttackTime.get(id) ?? 0;
    if (now - last < ATTACK_COOLDOWN_MS) return 0;
    this._lastAttackTime.set(id, now);

    const dmg = Math.max(1, str + Phaser.Math.Between(0, Math.ceil(str / 2)));
    // HP doesn't actually decrease — infinite

    // Visual shake
    this.scene.tweens.add({
      targets: this._sprite,
      x: 4, duration: 30, yoyo: true, repeat: 2,
      onComplete: () => { this._sprite.x = 0; },
    });

    // Damage number popup
    const dmgText = this.scene.add.text(this.x, this.y - TILE_SIZE, `-${dmg}`, {
      fontSize: '12px', color: '#66aaff', fontStyle: 'bold',
    }).setOrigin(0.5, 1).setDepth(20);
    this.scene.tweens.add({
      targets: dmgText,
      y: dmgText.y - 20, alpha: 0, duration: 800,
      onComplete: () => dmgText.destroy(),
    });

    return XP_PER_HIT;
  }

  _isFacing(attacker) {
    const facing = attacker.getFacing?.();
    if (!facing) return true;
    const dx = this.x - attacker.x;
    const dy = this.y - attacker.y;
    if (Math.abs(dx) > Math.abs(dy)) {
      return (dx > 0 && facing === 'right') || (dx < 0 && facing === 'left');
    } else {
      return (dy > 0 && facing === 'down') || (dy < 0 && facing === 'up');
    }
  }

  _onClicked() {
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

    player.playAttack?.(this.x);

    const conn = this.scene._conn;
    if (conn?.connected && this._serverId) {
      conn.send({ type: 'attack_dummy', dummy_id: this._serverId });
    } else {
      const xp = this.attack(player, player.str);
      if (xp > 0) this._awardXP(player, xp);
    }
  }

  _awardXP(entity, xp) {
    entity.xp = (entity.xp ?? 0) + xp;
    const needed = xpToLevel(entity.level ?? 1);
    if (entity.xp >= needed) {
      entity.xp -= needed;
      entity.level = (entity.level ?? 1) + 1;
      entity.maxHp += 2;
      entity.hp = entity.maxHp;
      entity.str += 1;
      entity.def += 1;
      entity.maxKi = Math.max(entity.maxKi ?? KI_MAX_BASE, KI_MAX_BASE + Math.max(0, (entity.level ?? 1) - 1) * KI_MAX_PER_LEVEL);
      entity.ki = entity.maxKi;

      const name = entity.getName?.() ?? 'Player';
      const lvlText = this.scene.add.text(entity.x, entity.y - TILE_SIZE, `${name} Level ${entity.level}!`, {
        fontSize: '14px', color: '#ffff44', fontStyle: 'bold',
        backgroundColor: '#00000099', padding: { x: 4, y: 2 },
      }).setOrigin(0.5, 1).setDepth(20);
      this.scene.tweens.add({
        targets: lvlText, y: lvlText.y - 30, alpha: 0, duration: 2000,
        onComplete: () => lvlText.destroy(),
      });
    }

    const xpText = this.scene.add.text(entity.x + 15, entity.y - TILE_SIZE + 10, `+${xp} XP`, {
      fontSize: '10px', color: '#44ff44',
    }).setOrigin(0.5, 1).setDepth(20);
    this.scene.tweens.add({
      targets: xpText, y: xpText.y - 15, alpha: 0, duration: 1000,
      onComplete: () => xpText.destroy(),
    });
  }

  npcAttack(npc) {
    if (!this._isFacing(npc)) return false;
    npc.playAttack?.(this.x);
    const xp = this.attack(npc, npc.str);
    if (xp > 0) this._awardXP(npc, xp);
    return xp > 0;
  }

  destroy(fromScene) {
    this._lastAttackTime?.clear();
    super.destroy(fromScene);
  }
}
