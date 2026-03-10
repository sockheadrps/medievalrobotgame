// RemotePlayer — renders another player's avatar based on server state.
// No physics, no input — purely visual with interpolation.

import Phaser from 'phaser';
import {
  PLAYER_KEY, TILE_SIZE, PLAYER_FRAME_H,
  PFRAME_FACE_DOWN, PFRAME_FACE_UP, PFRAME_FACE_RIGHT, PFRAME_FACE_LEFT,
  PFRAME_PUNCH_LEFT, PFRAME_PUNCH_RIGHT,
} from '../constants.js';

const SCALE = TILE_SIZE / PLAYER_FRAME_H;
const LERP_SPEED = 0.35; // interpolation factor (higher = snappier)
const SNAP_DIST = 1;     // snap to target when this close

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
    this._dead = false;
    this._targetX = x;
    this._targetY = y;
    this._facing = 'down';
    this._anim = 'idle';
    this._punching = false;

    // Name label
    this._nameLabel = scene.add.text(x, y - TILE_SIZE - 8, playerId, {
      fontSize: '9px', color: '#ffddaa', backgroundColor: '#00000088',
      padding: { x: 3, y: 1 },
    }).setOrigin(0.5, 1).setDepth(3);

    // HP bar
    this._hpBarBg = scene.add.rectangle(x - 20, y - TILE_SIZE - 2, 40, 4, 0x333333)
      .setOrigin(0, 0.5).setDepth(3);
    this._hpBar = scene.add.rectangle(x - 20, y - TILE_SIZE - 2, 40, 4, 0x44ff44)
      .setOrigin(0, 0.5).setDepth(3);

    this._hp = 20;
    this._maxHp = 20;

    // Ctrl+click: select/deselect for inspection. Left-click: attack if selected.
    this.on('pointerdown', (pointer) => {
      if (pointer.event.ctrlKey || pointer.event.metaKey) {
        this._onCtrlClicked();
      } else {
        if (this === this.scene?._focusedRemote || this === this.scene?._pvpTarget) {
          this._onAttackClicked();
        }
      }
    });
    this.on('pointerover', () => { if (!this._dead) this.setTint(0xffcc66); });
    this.on('pointerout', () => {
      if (this === this.scene?._pvpTarget) this.setTint(0xff4444);
      else if (this === this.scene?._focusedRemote) this.setTint(0xffdd44);
      else this.clearTint();
    });

    this._ensureAnims(scene);
  }

  isDead() { return this._dead; }

  /** Update from server state. */
  applyState(state) {
    this._targetX = state.x;
    this._targetY = state.y;
    this._facing = state.facing || 'down';
    this._anim = state.anim || 'idle';
    this._punching = state.punching || false;
    this._hp = state.hp ?? 20;
    this._maxHp = state.maxHp ?? 20;
    if (state.chatColor) {
      this.chatColor = state.chatColor;
      this._nameLabel?.setColor(state.chatColor);
    }

    // Death
    if (state.dead && !this._dead) {
      this._dead = true;
      this.setAlpha(0.3);
      this._nameLabel?.setAlpha(0.3);
    } else if (!state.dead && this._dead) {
      this._dead = false;
      this.setAlpha(1);
      this._nameLabel?.setAlpha(1);
    }
  }

  _onCtrlClicked() {
    if (this._dead) return;
    const scene = this.scene;

    if (scene._focusedRemote === this) {
      // Already selected → deselect
      scene._focusedRemote = null;
      this.clearTint();
      scene.chatBox?._addLog(`Deselected ${this.playerId}`, '#888888');
    } else {
      // Select (yellow)
      if (scene._focusedRemote) scene._focusedRemote.clearTint();
      scene._focusedRemote = this;
      this.setTint(0xffdd44);
      scene.chatBox?._addLog(`Selected ${this.playerId} — click to attack`, '#ffaa66');
    }
  }

  _onAttackClicked() {
    if (this._dead) return;
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
    // Interpolate position — snap when very close to avoid endless drift
    const dx = this._targetX - this.x;
    const dy = this._targetY - this.y;
    if (Math.abs(dx) < SNAP_DIST && Math.abs(dy) < SNAP_DIST) {
      this.x = this._targetX;
      this.y = this._targetY;
    } else {
      this.x += dx * LERP_SPEED;
      this.y += dy * LERP_SPEED;
    }

    // Animation
    if (this._punching) {
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
      // Walk or run
      this.setFlipX(false);
      const prefix = this._anim === 'run' ? 'run' : 'walk';
      const key = `${prefix}-${this._facing}`;
      if (this.anims.currentAnim?.key !== key) this.play(key);
    }

    // Update attached elements
    this._nameLabel.setPosition(this.x, this.y - TILE_SIZE - 8);
    this._hpBarBg.setPosition(this.x - 20, this.y - TILE_SIZE - 2);
    this._hpBar.setPosition(this.x - 20, this.y - TILE_SIZE - 2);

    const hpPct = this._hp / this._maxHp;
    this._hpBar.setDisplaySize(40 * hpPct, 4);
    const color = hpPct > 0.5 ? 0x44ff44 : hpPct > 0.25 ? 0xffaa00 : 0xff4444;
    this._hpBar.setFillStyle(color);
  }

  _ensureAnims(scene) {
    // Player anims are already created by the local Player constructor,
    // but in case remote joins first, we do nothing — they share the same anim manager.
  }

  destroy(fromScene) {
    this._nameLabel?.destroy();
    this._hpBar?.destroy();
    this._hpBarBg?.destroy();
    super.destroy(fromScene);
  }
}
