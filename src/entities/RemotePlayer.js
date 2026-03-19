// RemotePlayer - renders another player's avatar based on server state.
// No physics, no input - purely visual with interpolation.

import Phaser from 'phaser';
import {
  PLAYER_KEY, TILE_SIZE, PLAYER_FRAME_H,
  PFRAME_FACE_DOWN, PFRAME_FACE_UP, PFRAME_FACE_RIGHT, PFRAME_FACE_LEFT,
  PFRAME_PUNCH_LEFT, PFRAME_PUNCH_RIGHT,
} from '../constants.js';
import { createBarrierOverlay, syncBarrierOverlay } from './BarrierOverlay.js';
import { createEquipmentOverlay, syncEquipmentOverlay } from './EquipmentOverlay.js';

const SCALE = TILE_SIZE / PLAYER_FRAME_H;
const LERP_SPEED = 0.35;
const SNAP_DIST = 1;

export class RemotePlayer extends Phaser.GameObjects.Sprite {
  constructor(scene, x, y, playerId) {
    super(scene, x, y, PLAYER_KEY, PFRAME_FACE_DOWN);
    scene.add.existing(this);

    this.setScale(SCALE);
    this.setOrigin(0.5, 1);
    this.setDepth(2);
    this.setInteractive({ useHandCursor: true });

    this.playerId = playerId;
    this.chatColor = '#cccccc';
    this.isAIRival = false;
    this._dead = false;
    this._knockedOut = false;
    this._carriedBy = null;
    this._targetX = x;
    this._targetY = y;
    this._facing = 'down';
    this._anim = 'idle';
    this._punching = false;
    this._selected = false;
    this._attackable = false;
    this._hovered = false;

    this._selectRing = scene.add.circle(x, y - 6, 21, 0xff4444, 0.28)
      .setStrokeStyle(3, 0xff8888, 0.95)
      .setDepth(1).setVisible(false);
    this._selectRingPulse = scene.add.circle(x, y - 6, 30, 0xff4444, 0.08)
      .setStrokeStyle(2, 0xff4444, 0.7)
      .setDepth(1).setVisible(false);
    this._attackRing = scene.add.circle(x, y - 6, 22, 0xff4444, 0.18)
      .setDepth(1).setVisible(false);

    this._nameLabel = scene.add.text(x, y - TILE_SIZE - 8, playerId, {
      fontSize: '9px', color: '#ffddaa', backgroundColor: '#00000088',
      padding: { x: 3, y: 1 },
    }).setOrigin(0.5, 1).setDepth(3);

    this._hpBarBg = scene.add.rectangle(x - 20, y - TILE_SIZE - 2, 40, 4, 0x333333)
      .setOrigin(0, 0.5).setDepth(3);
    this._hpBar = scene.add.rectangle(x - 20, y - TILE_SIZE - 2, 40, 4, 0x44ff44)
      .setOrigin(0, 0.5).setDepth(3);

    // Ki bar (below HP bar)
    this._kiBarBg = scene.add.rectangle(x - 20, y - TILE_SIZE + 3, 40, 3, 0x222233)
      .setOrigin(0, 0.5).setDepth(3);
    this._kiBar = scene.add.rectangle(x - 20, y - TILE_SIZE + 3, 40, 3, 0x4488ff)
      .setOrigin(0, 0.5).setDepth(3);

    this._hp = 20;
    this._maxHp = 20;
    this._ki = 20;
    this._maxKi = 20;
    this.level = 1;
    this.xp = 0;
    this.str = 1;
    this.def = 1;
    this.logs = 0;
    this.stones = 0;
    this.crystals = 0;
    this.blastLevel = 0;
    this.kiSkillLevel = 1;
    this.kiSkillXp = 0;
    this.kiBlastBonuses = {};
    this.kiMoves = [];

    this.on('pointerdown', (pointer, _localX, _localY, event) => {
      this.scene?._handleRemoteEntityPointerDown?.(this, pointer, event);
    });
    this.on('pointerover', () => {
      if (this._dead) return;
      this._hovered = true;
      this._updateVisualState();
    });
    this.on('pointerout', () => {
      this._hovered = false;
      this._updateVisualState();
    });

    this._barrierOverlay = createBarrierOverlay(scene, this);
    this._equipOverlays = {};
    this.equipment = {};
    this._ensureAnims(scene);
  }

  isDead() { return this._dead; }
  isKnockedOut() { return this._knockedOut; }

  setSelected(on) {
    this._selected = !!on;
    this._updateVisualState();
  }

  setAttackable(on) {
    this._attackable = !!on;
    this._updateVisualState();
  }

  applyState(state) {
    this._targetX = state.x;
    this._targetY = state.y;
    this._facing = state.facing || 'down';
    this._anim = state.anim || 'idle';
    this._punching = state.punching || false;
    this._hp = state.hp ?? 20;
    this._maxHp = state.maxHp ?? 20;
    this._ki = state.ki ?? this._ki;
    this._maxKi = state.maxKi ?? this._maxKi;
    this.level = state.level ?? this.level;
    this.xp = state.xp ?? this.xp;
    this.str = state.str ?? this.str;
    this.def = state.def ?? this.def;
    this.logs = state.logs ?? this.logs;
    this.stones = state.stones ?? this.stones;
    this.crystals = state.crystals ?? this.crystals;
    this.blastLevel = state.blastLevel ?? this.blastLevel;
    this.kiSkillLevel = state.kiSkillLevel ?? this.kiSkillLevel;
    this.kiSkillXp = state.kiSkillXp ?? this.kiSkillXp;
    if (state.ki_blast_bonuses) this.kiBlastBonuses = state.ki_blast_bonuses;
    if (Array.isArray(state.ki_moves)) this.kiMoves = state.ki_moves;
    if (state.chatColor) {
      this.chatColor = state.chatColor;
      this._nameLabel?.setColor(state.chatColor);
    }

    this._knockedOut = !!state.knocked_out;
    this._carriedBy = state.carried_by ?? null;
    this.equipment = state.equipment ?? this.equipment ?? {};

    // AI rival visual distinction
    if (state.is_ai_rival && !this.isAIRival) {
      this.isAIRival = true;
      this._nameLabel?.setColor('#ff6644');
      this._nameLabel?.setBackgroundColor('#220000aa');
    }

    if (state.dead && !this._dead) {
      this._dead = true;
      this.setAlpha(0.3);
      this._nameLabel?.setAlpha(0.3);
    } else if (!state.dead && this._dead) {
      this._dead = false;
      this.setAlpha(1);
      this._nameLabel?.setAlpha(1);
    }
    this._updateVisualState();
  }

  _updateVisualState() {
    this._selectRing?.setVisible(!this._dead && this._selected);
    this._selectRingPulse?.setVisible(!this._dead && this._selected);
    this._attackRing?.setVisible(!this._dead && !this._knockedOut && this._attackable);
    if (this._dead) {
      this.clearTint();
      return;
    }
    if (this._knockedOut) {
      this.setTint(0x999999);
      this.setAlpha(0.6);
      return;
    }
    this.setAlpha(1);
    if (this._hovered) this.setTint(0xffcc66);
    else if (this.isAIRival) this.setTint(0xff6644);
    else this.clearTint();
  }

  _onAttackClicked() {
    if (this._dead || this._knockedOut) return;
    const scene = this.scene;
    const player = scene.player;
    if (scene._playerDead) return;

    const dist = Phaser.Math.Distance.Between(player.x, player.y, this.x, this.y);
    if (dist > TILE_SIZE * 1.5) {
      const text = scene.add.text(this.x, this.y - TILE_SIZE - 20, 'Too far!', {
        fontSize: '10px', color: '#ff4444', backgroundColor: '#00000088',
        padding: { x: 3, y: 2 },
      }).setOrigin(0.5, 1).setDepth(20);
      scene.time.delayedCall(1000, () => text.destroy());
      return;
    }

    player.playAttack?.(this.x);
    const conn = scene._conn;
    if (conn?.connected) {
      conn.send({ type: 'attack_player', target_id: this.playerId });
    }
  }

  update() {
    const dx = this._targetX - this.x;
    const dy = this._targetY - this.y;
    if (Math.abs(dx) < SNAP_DIST && Math.abs(dy) < SNAP_DIST) {
      this.x = this._targetX;
      this.y = this._targetY;
    } else {
      this.x += dx * LERP_SPEED;
      this.y += dy * LERP_SPEED;
    }

    if (this._knockedOut) {
      this.stop();
      this.setFlipX(false);
      const idleFrame = {
        down: PFRAME_FACE_DOWN, up: PFRAME_FACE_UP,
        left: PFRAME_FACE_LEFT, right: PFRAME_FACE_RIGHT,
      }[this._facing] ?? PFRAME_FACE_DOWN;
      this.setFrame(idleFrame);
    } else if (this._punching) {
      this.stop();
      this.setFlipX(false);
      const side = this._facing === 'left' ? 'left' : 'right';
      this.setFrame(side === 'left' ? PFRAME_PUNCH_LEFT : PFRAME_PUNCH_RIGHT);
    } else if (this._anim === 'idle') {
      this.stop();
      this.setFlipX(false);
      const idleFrame = {
        down: PFRAME_FACE_DOWN, up: PFRAME_FACE_UP,
        left: PFRAME_FACE_LEFT, right: PFRAME_FACE_RIGHT,
      }[this._facing] ?? PFRAME_FACE_DOWN;
      this.setFrame(idleFrame);
    } else {
      this.setFlipX(false);
      const prefix = this._anim === 'run' ? 'run' : 'walk';
      const key = `${prefix}-${this._facing}`;
      if (this.anims.currentAnim?.key !== key) this.play(key);
    }

    this._nameLabel.setPosition(this.x, this.y - TILE_SIZE - 8);
    if (this._bubble) this._bubble.setPosition(this.x, this.y - TILE_SIZE - 22);
    this._hpBarBg.setPosition(this.x - 20, this.y - TILE_SIZE - 2);
    this._hpBar.setPosition(this.x - 20, this.y - TILE_SIZE - 2);
    this._kiBarBg.setPosition(this.x - 20, this.y - TILE_SIZE + 3);
    this._kiBar.setPosition(this.x - 20, this.y - TILE_SIZE + 3);
    this._selectRing?.setPosition(this.x, this.y - 6);
    this._selectRingPulse?.setPosition(this.x, this.y - 6);
    if (this._selectRingPulse?.visible) {
      const pulse = 30 + Math.sin(this.scene.time.now / 140) * 3;
      this._selectRingPulse.setRadius(pulse);
    }
    this._attackRing?.setPosition(this.x, this.y - 6);

    const hpPct = this._hp / this._maxHp;
    this._hpBar.setDisplaySize(40 * hpPct, 4);
    const color = hpPct > 0.5 ? 0x44ff44 : hpPct > 0.25 ? 0xffaa00 : 0xff4444;
    this._hpBar.setFillStyle(color);

    const kiPct = this._maxKi > 0 ? this._ki / this._maxKi : 0;
    this._kiBar.setDisplaySize(40 * Phaser.Math.Clamp(kiPct, 0, 1), 3);
    const kiColor = kiPct > 0.5 ? 0x4488ff : kiPct > 0.25 ? 0x6644cc : 0x8822aa;
    this._kiBar.setFillStyle(kiColor);
    syncBarrierOverlay(this._barrierOverlay, this);
    this._syncEquipOverlays();
  }

  _syncEquipOverlays() {
    const equipData = this.equipment || {};
    const textures = this.scene?._equipmentTextures || {};
    for (const [slot, eqId] of Object.entries(equipData)) {
      let overlay = this._equipOverlays[slot];
      const texInfo = textures[eqId];
      if (!texInfo || !this.scene.textures.exists(texInfo.textureKey)) {
        if (overlay) overlay.setVisible(false);
        continue;
      }
      if (!overlay || overlay._textureKey !== texInfo.textureKey) {
        if (overlay) overlay.destroy();
        overlay = createEquipmentOverlay(this.scene, this, texInfo.textureKey, texInfo.remap);
        this._equipOverlays[slot] = overlay;
      }
      syncEquipmentOverlay(overlay, this);
    }
    for (const [slot, overlay] of Object.entries(this._equipOverlays)) {
      if (!equipData[slot]) overlay.setVisible(false);
    }
  }

  showBubble(text, duration = 4000) {
    if (this._bubble) this._bubble.destroy();
    this._bubble = this.scene.add.text(this.x, this.y - TILE_SIZE - 22, text, {
      fontSize: '9px', color: '#ffffff', backgroundColor: '#000000aa',
      padding: { x: 4, y: 2 }, wordWrap: { width: 160 },
    }).setOrigin(0.5, 1).setDepth(20);
    this.scene.time.delayedCall(duration, () => {
      this._bubble?.destroy();
      this._bubble = null;
    });
  }

  _ensureAnims(_scene) {
    // Shared player animations are created by the local Player entity.
  }

  destroy(fromScene) {
    this._bubble?.destroy();
    this._nameLabel?.destroy();
    this._hpBar?.destroy();
    this._hpBarBg?.destroy();
    this._kiBar?.destroy();
    this._kiBarBg?.destroy();
    this._selectRing?.destroy();
    this._selectRingPulse?.destroy();
    this._attackRing?.destroy();
    this._barrierOverlay?.destroy();
    for (const overlay of Object.values(this._equipOverlays || {})) overlay?.destroy();
    this._equipOverlays = {};
    super.destroy(fromScene);
  }
}
