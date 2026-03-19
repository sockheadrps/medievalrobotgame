import Phaser from 'phaser';
import { SHEET_KEY, TILE_SIZE, SHEET_TILE, SHEET_COLS } from '../constants.js';

const SCALE = TILE_SIZE / SHEET_TILE;
const MINE_DIST = 80;

/**
 * Client-side representation of a data-driven world object (e.g. copper ore node).
 * Follows the Rock.js pattern — sprite from tilemap frame, HP bar while interacting,
 * depleted state tinted grey, click handler sends interaction to server.
 */
export class WorldObject extends Phaser.GameObjects.Image {
  constructor(scene, x, y, woId, assetDef) {
    // Determine frame from asset definition's sprite ref
    const frame = (assetDef?.sprite?.tileCol ?? 0) + (assetDef?.sprite?.tileRow ?? 0) * SHEET_COLS;
    super(scene, x, y, SHEET_KEY, frame);
    scene.add.existing(this);
    this.setDepth(1);
    this.setScale(SCALE);
    this.setInteractive({ useHandCursor: true });

    this.woId = woId;
    this._woId = woId;  // alias for NPC task runner
    this.assetDef = assetDef;
    this._assetId = assetDef?.id ?? '';
    this._depleted = false;
    this._hp = assetDef?.hp ?? 5;
    this._maxHp = this._hp;
    // Primary drop resource — used by NPC for optimistic inventory tracking
    this._dropResource = assetDef?.drops?.[0]?.resource ?? this._assetId;

    // HP bar (only visible while being mined)
    this._hpBar = scene.add.graphics().setDepth(5);
    this._hpBarVisible = false;

    // "Too far" label
    this._farLabel = scene.add.text(x, y + TILE_SIZE / 2 + 4, 'Too far!', {
      fontSize: '10px', color: '#ff4444', backgroundColor: '#00000088',
      padding: { x: 3, y: 2 },
    }).setOrigin(0.5, 0).setDepth(4).setVisible(false);

    // Label showing name
    this._nameLabel = scene.add.text(x, y - TILE_SIZE / 2 - 4, assetDef?.label ?? 'Object', {
      fontSize: '9px', color: '#ffcc44', backgroundColor: '#00000088',
      padding: { x: 3, y: 1 },
    }).setOrigin(0.5, 1).setDepth(4).setVisible(false);

    this.on('pointerover', () => {
      if (!this._depleted) {
        this.setTint(0xccccff);
        this._nameLabel.setVisible(true);
      }
    });
    this.on('pointerout', () => {
      this.clearTint();
      if (this._depleted) this.setTint(0x666666);
      this._farLabel.setVisible(false);
      this._nameLabel.setVisible(false);
    });
    this.on('pointerdown', this._onClicked, this);
  }

  _onClicked() {
    if (this._depleted) return;

    // Task recording mode — add this ore as a target instead of mining
    if (this.scene._taskRecorder?.isRecording()) {
      const added = this.scene._taskRecorder.addOreTarget(this);
      if (added) {
        this.scene._chatBox?._addLog(`[Task] Added ore: ${this.assetDef?.label ?? this._assetId}`, '#44ff44');
        this.scene._chatBox?._addLog(`[Task] ${this.scene._taskRecorder.getRecordingSummary()}`, '#888888');
      } else {
        this.scene._chatBox?._addLog(`[Task] Ore type already added.`, '#ffaa44');
      }
      return;
    }

    const player = this.scene.player;
    const d = Phaser.Math.Distance.Between(player.x, player.y, this.x, this.y);
    if (d > MINE_DIST) {
      this._farLabel.setVisible(true);
      this.scene.tweens.add({
        targets: this, x: this.x + 4,
        duration: 40, yoyo: true, repeat: 2,
      });
      return;
    }

    const conn = this.scene._conn;
    if (conn?.connected) {
      conn.send({ type: 'interact_world_object', wo_id: this.woId });
    }
  }

  applyState(serverWo) {
    this._hp = serverWo.hp;
    this._maxHp = serverWo.maxHp;

    if (serverWo.depleted && !this._depleted) {
      this._depleted = true;
      this.setTint(0x666666);
      this.disableInteractive();
      this._hideHpBar();
    } else if (!serverWo.depleted && this._depleted) {
      // Respawned
      this._depleted = false;
      this.clearTint();
      this.setInteractive({ useHandCursor: true });
      this.setAlpha(1);
      // Pop-in animation
      this.setScale(0.1);
      this.scene.tweens.add({
        targets: this,
        scaleX: SCALE, scaleY: SCALE,
        duration: 400, ease: 'Back.Out',
      });
    }

    // Show HP bar if partially damaged
    if (!this._depleted && this._hp < this._maxHp) {
      this._showHpBar();
    } else {
      this._hideHpBar();
    }
  }

  _showHpBar() {
    const bar = this._hpBar;
    bar.clear();
    const bw = 32;
    const bh = 3;
    const bx = this.x - bw / 2;
    const by = this.y + TILE_SIZE / 2 + 2;
    bar.fillStyle(0x333333);
    bar.fillRect(bx, by, bw, bh);
    const frac = Math.max(0, this._hp / this._maxHp);
    bar.fillStyle(frac > 0.5 ? 0x44cc44 : frac > 0.25 ? 0xcccc44 : 0xcc4444);
    bar.fillRect(bx, by, bw * frac, bh);
    this._hpBarVisible = true;
  }

  _hideHpBar() {
    if (this._hpBarVisible) {
      this._hpBar.clear();
      this._hpBarVisible = false;
    }
  }

  destroy(fromScene) {
    this._hpBar?.destroy();
    this._farLabel?.destroy();
    this._nameLabel?.destroy();
    super.destroy(fromScene);
  }
}
