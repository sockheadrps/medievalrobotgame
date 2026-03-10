// RemoteNPC — renders another player's NPC based on server state.
// Purely visual with interpolation + HP bar. Can be clicked to attack.

import Phaser from 'phaser';
import {
  NPC_KEY, TILE_SIZE, NPC_FRAME_H,
  NFRAME_FACE_DOWN, NFRAME_FACE_UP, NFRAME_FACE_LEFT, NFRAME_FACE_RIGHT,
  NFRAME_WALK1_DOWN, NFRAME_WALK1_UP, NFRAME_WALK1_LEFT, NFRAME_WALK1_RIGHT,
} from '../constants.js';

const SCALE = TILE_SIZE / NPC_FRAME_H;
const LERP_SPEED = 0.35;
const SNAP_DIST = 1;
const MOVE_THRESHOLD = 0.5; // minimum delta to count as moving

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
    this.logs = 0;
    this.maxLogs = 10;
    this.gathering = false;
    this._dead = false;
    this._soul = {};        // relationship data per player: { pid: { trust, fear, anger, label } }
    this._personality = null; // { cooperation, aggression }
    this._facing = 'down';
    this._walkToggle = false;
    this._walkTimer = 0;

    // Name label (red tint to indicate enemy)
    this._nameLabel = scene.add.text(x, y - TILE_SIZE - 10, this._name, {
      fontSize: '9px', color: '#ffaaaa', backgroundColor: '#00000088',
      padding: { x: 3, y: 1 },
    }).setOrigin(0.5, 1).setDepth(3);

    // Owner label
    this._ownerLabel = scene.add.text(x, y - TILE_SIZE - 20, `[${ownerPid}]`, {
      fontSize: '7px', color: '#ff8888', backgroundColor: '#00000066',
      padding: { x: 2, y: 1 },
    }).setOrigin(0.5, 1).setDepth(3);

    // HP bar
    this._hpBarBg = scene.add.rectangle(x - 20, y - TILE_SIZE - 2, 40, 4, 0x333333)
      .setOrigin(0, 0.5).setDepth(3);
    this._hpBar = scene.add.rectangle(x - 20, y - TILE_SIZE - 2, 40, 4, 0xcc4444)
      .setOrigin(0, 0.5).setDepth(3);

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
  }

  isDead() { return this._dead; }
  getName() { return this._name; }

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
    this.logs = state.logs ?? this.logs;
    this.maxLogs = state.maxLogs ?? this.maxLogs;
    this.gathering = state.gathering ?? false;
    this._name = state.name || this._name;
    this._nameLabel?.setText(this._name);
    if (state.soul) this._soul = state.soul;
    if (state.personality) this._personality = state.personality;

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

    // Infer facing direction & animate from movement delta
    const dx = this.x - prevX;
    const dy = this.y - prevY;
    const moving = Math.abs(dx) > MOVE_THRESHOLD || Math.abs(dy) > MOVE_THRESHOLD;

    if (moving) {
      // Determine facing from dominant axis
      if (Math.abs(dx) > Math.abs(dy)) {
        this._facing = dx > 0 ? 'right' : 'left';
      } else {
        this._facing = dy > 0 ? 'down' : 'up';
      }
      // Toggle walk frame at ~6fps (every ~166ms)
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

  _onCtrlClicked() {
    if (this._dead) return;
    const scene = this.scene;

    if (scene._focusedRemote === this) {
      // Already selected → deselect
      scene._focusedRemote = null;
      this.clearTint();
      scene.chatBox?._addLog(`Deselected ${this._name}`, '#888888');
    } else {
      // Select (yellow)
      if (scene._focusedRemote) scene._focusedRemote.clearTint();
      scene._focusedRemote = this;
      this.setTint(0xffdd44);
      scene.chatBox?._addLog(`Selected ${this._name} [${this.ownerPid}] — click to attack`, '#ffaa66');
    }
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
    super.destroy(fromScene);
  }
}
