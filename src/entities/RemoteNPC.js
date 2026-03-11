// RemoteNPC - renders another player's NPC based on server state.
// Purely visual with interpolation + HP bar.

import Phaser from 'phaser';
import {
  NPC_KEY, TILE_SIZE, NPC_FRAME_H,
  NFRAME_FACE_DOWN, NFRAME_FACE_UP, NFRAME_FACE_LEFT, NFRAME_FACE_RIGHT,
  NFRAME_WALK1_DOWN, NFRAME_WALK1_UP, NFRAME_WALK1_LEFT, NFRAME_WALK1_RIGHT,
} from '../constants.js';

const SCALE = TILE_SIZE / NPC_FRAME_H;
const LERP_SPEED = 0.35;
const SNAP_DIST = 1;
const MOVE_THRESHOLD = 0.5;

const FACE_FRAMES = { down: NFRAME_FACE_DOWN, up: NFRAME_FACE_UP, left: NFRAME_FACE_LEFT, right: NFRAME_FACE_RIGHT };
const WALK_FRAMES = { down: NFRAME_WALK1_DOWN, up: NFRAME_WALK1_UP, left: NFRAME_WALK1_LEFT, right: NFRAME_WALK1_RIGHT };

export class RemoteNPC extends Phaser.GameObjects.Sprite {
  constructor(scene, x, y, npcId, ownerPid, name) {
    super(scene, x, y, NPC_KEY, NFRAME_FACE_DOWN);
    scene.add.existing(this);

    this.setScale(SCALE);
    this.setOrigin(0.5, 1);
    this.setDepth(2);
    this.setInteractive({ useHandCursor: true });

    this.npcId = npcId;
    this.ownerPid = ownerPid;
    this._name = name || npcId;
    this._targetX = x;
    this._targetY = y;
    this.hp = 15;
    this.maxHp = 15;
    this.str = 1;
    this.def = 1;
    this.level = 1;
    this.logs = 0;
    this.maxLogs = 10;
    this.gathering = false;
    this._dead = false;
    this._knockedOut = false;
    this._carriedBy = null;
    this._soul = {};
    this._personality = null;
    this._facing = 'down';
    this._walkToggle = false;
    this._walkTimer = 0;
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

    this._nameLabel = scene.add.text(x, y - TILE_SIZE - 10, this._name, {
      fontSize: '9px', color: '#ffaaaa', backgroundColor: '#00000088',
      padding: { x: 3, y: 1 },
    }).setOrigin(0.5, 1).setDepth(3);

    this._ownerLabel = scene.add.text(x, y - TILE_SIZE - 20, `[${ownerPid}]`, {
      fontSize: '7px', color: '#ff8888', backgroundColor: '#00000066',
      padding: { x: 2, y: 1 },
    }).setOrigin(0.5, 1).setDepth(3);

    this._hpBarBg = scene.add.rectangle(x - 20, y - TILE_SIZE - 2, 40, 4, 0x333333)
      .setOrigin(0, 0.5).setDepth(3);
    this._hpBar = scene.add.rectangle(x - 20, y - TILE_SIZE - 2, 40, 4, 0xcc4444)
      .setOrigin(0, 0.5).setDepth(3);

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
  }

  isDead() { return this._dead; }
  isKnockedOut() { return this._knockedOut; }
  getName() { return this._name; }

  setSelected(on) {
    this._selected = !!on;
    this._updateVisualState();
  }

  setAttackable(on) {
    this._attackable = !!on;
    this._updateVisualState();
  }

  setOwnerColor(color) {
    this._ownerColor = color;
    this._nameLabel?.setColor(color);
    this._ownerLabel?.setColor(color);
  }

  applyState(state) {
    this._targetX = state.x;
    this._targetY = state.y;
    this.hp = state.hp ?? this.hp;
    this.maxHp = state.maxHp ?? this.maxHp;
    this.str = state.str ?? this.str;
    this.def = state.def ?? this.def;
    this.level = state.level ?? this.level;
    this.logs = state.logs ?? this.logs;
    this.maxLogs = state.maxLogs ?? this.maxLogs;
    this.gathering = state.gathering ?? false;
    this._name = state.name || this._name;
    this._nameLabel?.setText(this._name);
    if (state.soul) this._soul = state.soul;
    if (state.personality) this._personality = state.personality;
    this._knockedOut = !!state.knocked_out;
    this._carriedBy = state.carried_by ?? null;

    if (state.dead && !this._dead) {
      this._dead = true;
      this.setVisible(false);
      this._nameLabel?.setVisible(false);
      this._ownerLabel?.setVisible(false);
      this._hpBar?.setVisible(false);
      this._hpBarBg?.setVisible(false);
    } else if (!state.dead && this._dead) {
      this._dead = false;
      this.setVisible(true);
      this._nameLabel?.setVisible(true);
      this._ownerLabel?.setVisible(true);
      this._hpBar?.setVisible(true);
      this._hpBarBg?.setVisible(true);
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
    else this.clearTint();
  }

  update(time) {
    if (this._dead) return;

    const prevX = this.x;
    const prevY = this.y;
    const ddx = this._targetX - this.x;
    const ddy = this._targetY - this.y;
    if (Math.abs(ddx) < SNAP_DIST && Math.abs(ddy) < SNAP_DIST) {
      this.x = this._targetX;
      this.y = this._targetY;
    } else {
      this.x += ddx * LERP_SPEED;
      this.y += ddy * LERP_SPEED;
    }

    const dx = this.x - prevX;
    const dy = this.y - prevY;
    const moving = Math.abs(dx) > MOVE_THRESHOLD || Math.abs(dy) > MOVE_THRESHOLD;

    if (this._knockedOut) {
      this.setFrame(FACE_FRAMES[this._facing]);
    } else if (moving) {
      if (Math.abs(dx) > Math.abs(dy)) this._facing = dx > 0 ? 'right' : 'left';
      else this._facing = dy > 0 ? 'down' : 'up';

      if (time - this._walkTimer > 166) {
        this._walkToggle = !this._walkToggle;
        this._walkTimer = time;
      }
      this.setFrame(this._walkToggle ? WALK_FRAMES[this._facing] : FACE_FRAMES[this._facing]);
    } else {
      this.setFrame(FACE_FRAMES[this._facing]);
    }

    this._nameLabel?.setPosition(this.x, this.y - TILE_SIZE - 10);
    this._ownerLabel?.setPosition(this.x, this.y - TILE_SIZE - 20);
    this._hpBarBg?.setPosition(this.x - 20, this.y - TILE_SIZE - 2);
    this._hpBar?.setPosition(this.x - 20, this.y - TILE_SIZE - 2);
    this._bubble?.setPosition(this.x, this.y - TILE_SIZE - 30);
    this._selectRing?.setPosition(this.x, this.y - 6);
    this._selectRingPulse?.setPosition(this.x, this.y - 6);
    if (this._selectRingPulse?.visible) {
      const pulse = 30 + Math.sin(this.scene.time.now / 140) * 3;
      this._selectRingPulse.setRadius(pulse);
    }
    this._attackRing?.setPosition(this.x, this.y - 6);

    const hpPct = this.hp / this.maxHp;
    this._hpBar?.setDisplaySize(40 * hpPct, 4);
    const color = hpPct > 0.5 ? 0xcc4444 : hpPct > 0.25 ? 0xffaa00 : 0xff2222;
    this._hpBar?.setFillStyle(color);
  }

  showBubble(text, duration = 4000) {
    if (this._bubble) { this._bubble.destroy(); this._bubble = null; }
    this._bubble = this.scene.add.text(this.x, this.y - TILE_SIZE - 30, text, {
      fontSize: '10px', color: '#ffffff', backgroundColor: '#222244cc',
      padding: { x: 5, y: 3 }, wordWrap: { width: 160 },
    }).setOrigin(0.5, 1).setDepth(20);
    this.scene.time.delayedCall(duration, () => {
      if (this._bubble) { this._bubble.destroy(); this._bubble = null; }
    });
  }

  _onAttackClicked() {
    if (this._dead) return;
    const scene = this.scene;
    const player = scene.player;
    if (player.hp <= 0) return;

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
      conn.send({
        type: 'attack_npc',
        owner_id: this.ownerPid,
        npc_id: this.npcId,
      });
    }
  }

  destroy(fromScene) {
    this._nameLabel?.destroy();
    this._ownerLabel?.destroy();
    this._hpBar?.destroy();
    this._hpBarBg?.destroy();
    this._bubble?.destroy();
    this._selectRing?.destroy();
    this._selectRingPulse?.destroy();
    this._attackRing?.destroy();
    super.destroy(fromScene);
  }
}
