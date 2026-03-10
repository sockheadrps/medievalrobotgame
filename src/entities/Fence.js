import Phaser from 'phaser';
import {
  TILE_SIZE, SHEET_KEY,
  FRAME_FENCE_T1, FRAME_FENCE_T2, FRAME_FENCE_T3, FRAME_GATE,
} from '../constants.js';

const FENCE_FRAMES = [null, FRAME_FENCE_T1, FRAME_FENCE_T2, FRAME_FENCE_T3];
const SCALE = TILE_SIZE / 16;

export class Fence extends Phaser.GameObjects.Sprite {
  constructor(scene, x, y, fenceData) {
    const isGate = fenceData.gate;
    const frame = isGate ? FRAME_GATE : (FENCE_FRAMES[fenceData.tier] || FRAME_FENCE_T1);
    super(scene, x, y, SHEET_KEY, frame);
    scene.add.existing(this);

    this.setScale(SCALE);
    this.setOrigin(0.5, 0.5);
    this.setDepth(2);
    this.setInteractive({ useHandCursor: true });

    this.fenceId = fenceData.id;
    this.owner = fenceData.owner;
    this.isGate = isGate;
    this.tier = fenceData.tier;
    this.hp = fenceData.hp;
    this.maxHp = fenceData.maxHp;
    this._dead = false;

    // HP bar
    this._hpBarBg = scene.add.rectangle(x - 16, y - TILE_SIZE / 2 - 4, 32, 3, 0x333333)
      .setOrigin(0, 0.5).setDepth(3);
    this._hpBar = scene.add.rectangle(x - 16, y - TILE_SIZE / 2 - 4, 32, 3, isGate ? 0x4488ff : 0xcc8844)
      .setOrigin(0, 0.5).setDepth(3);

    // Label
    const label = isGate ? `Gate [${fenceData.owner}]` : `Fence T${fenceData.tier}`;
    this._label = scene.add.text(x, y - TILE_SIZE / 2 - 10, label, {
      fontSize: '8px', color: isGate ? '#88bbff' : '#ccaa77',
      backgroundColor: '#00000088', padding: { x: 2, y: 1 },
    }).setOrigin(0.5, 1).setDepth(3);

    // Click to attack, Ctrl+click own gate to pick up
    this.on('pointerdown', (pointer) => {
      if (pointer.event.ctrlKey || pointer.event.metaKey) {
        this._onCtrlClicked();
      } else {
        this._onClicked();
      }
    });
    this.on('pointerover', () => { if (!this._dead) this.setTint(0xffcc66); });
    this.on('pointerout', () => this.clearTint());
  }

  applyState(data) {
    this.hp = data.hp;
    this.maxHp = data.maxHp;
    this.tier = data.tier;
    this.owner = data.owner;

    if (data.dead && !this._dead) {
      this._dead = true;
      this.setVisible(false);
      this._hpBar?.setVisible(false);
      this._hpBarBg?.setVisible(false);
      this._label?.setVisible(false);
    }

    // Update HP bar
    const pct = this.hp / this.maxHp;
    this._hpBar?.setDisplaySize(32 * pct, 3);
    const color = pct > 0.5 ? (this.isGate ? 0x4488ff : 0xcc8844)
      : pct > 0.25 ? 0xffaa00 : 0xff4444;
    this._hpBar?.setFillStyle(color);
  }

  _onClicked() {
    if (this._dead) return;
    const scene = this.scene;
    const player = scene.player;
    if (!player || scene._playerDead) return;

    // Don't attack own fences/gates
    if (this.owner === scene._playerId) {
      scene.chatBox?._addLog(
        this.isGate ? 'This is your gate. (Ctrl+click to pick up)' : 'This is your fence.',
        '#aaaaaa',
      );
      return;
    }

    const d = Phaser.Math.Distance.Between(player.x, player.y, this.x, this.y);
    if (d > TILE_SIZE * 1.5) {
      const text = scene.add.text(this.x, this.y - TILE_SIZE / 2 - 16, 'Too far!', {
        fontSize: '10px', color: '#ff4444', backgroundColor: '#00000088',
        padding: { x: 3, y: 2 },
      }).setOrigin(0.5, 1).setDepth(20);
      scene.time.delayedCall(1000, () => text.destroy());
      return;
    }

    player.playAttack?.(this.x);
    const conn = scene._conn;
    if (conn?.connected) {
      conn.send({ type: 'attack_fence', fence_id: this.fenceId });
    }
  }

  _onCtrlClicked() {
    if (this._dead) return;
    const scene = this.scene;
    const player = scene.player;
    if (!player || scene._playerDead) return;

    // Only owner can pick up their own gate
    if (this.owner !== scene._playerId) return;
    if (!this.isGate) {
      scene.chatBox?._addLog('Only gates can be picked up.', '#aaaaaa');
      return;
    }

    const d = Phaser.Math.Distance.Between(player.x, player.y, this.x, this.y);
    if (d > TILE_SIZE * 1.5) {
      const text = scene.add.text(this.x, this.y - TILE_SIZE / 2 - 16, 'Too far!', {
        fontSize: '10px', color: '#ff4444', backgroundColor: '#00000088',
        padding: { x: 3, y: 2 },
      }).setOrigin(0.5, 1).setDepth(20);
      scene.time.delayedCall(1000, () => text.destroy());
      return;
    }

    const conn = scene._conn;
    if (conn?.connected) {
      conn.send({ type: 'pickup_fence', fence_id: this.fenceId });
      scene.chatBox?._addLog('Picked up gate (+10 logs).', '#88bbff');
    }
  }

  destroy(fromScene) {
    this._hpBar?.destroy();
    this._hpBarBg?.destroy();
    this._label?.destroy();
    super.destroy(fromScene);
  }
}
