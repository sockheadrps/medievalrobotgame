import Phaser from 'phaser';
import {
  SHEET_KEY, FRAME_TREE, FRAME_STUMP,
  TILE_SIZE, SHEET_TILE,
  TREE_CHOP_DIST,
} from '../constants.js';

const SCALE = TILE_SIZE / SHEET_TILE;

export class Tree extends Phaser.GameObjects.Image {
  constructor(scene, x, y) {
    super(scene, x, y, SHEET_KEY, FRAME_TREE);
    scene.add.existing(this);
    this.setDepth(1);
    this.setScale(SCALE);
    this.setInteractive({ useHandCursor: true });

    this._chopped = false;
    // Tree index set after construction by GameScene (matches server tree ID)
    this.treeIndex = -1;

    // "Too far" label
    this._farLabel = scene.add.text(x, y - TILE_SIZE / 2 - 4, 'Too far!', {
      fontSize: '10px', color: '#ff4444', backgroundColor: '#00000088',
      padding: { x: 3, y: 2 }
    }).setOrigin(0.5, 1).setDepth(4).setVisible(false);

    this.on('pointerover', () => { if (!this._chopped) this.setTint(0xaaffaa); });
    this.on('pointerout',  () => { this.clearTint(); this._farLabel.setVisible(false); });
    this.on('pointerdown', this._onClicked, this);
  }

  _onClicked() {
    if (this._chopped) return;

    const player = this.scene.player;
    const dist = Phaser.Math.Distance.Between(player.x, player.y, this.x, this.y);

    if (dist > TREE_CHOP_DIST) {
      this._farLabel.setVisible(true);
      this.scene.tweens.add({
        targets: this,
        x: this.x + 4,
        duration: 40,
        yoyo: true,
        repeat: 2,
      });
      return;
    }

    // Send chop to server instead of chopping locally
    const conn = this.scene._conn;
    if (conn?.connected) {
      conn.send({ type: 'chop', tree_id: this.treeIndex });
    }
  }

  /** Called by server sync when tree state changes. */
  setChopped(chopped) {
    if (chopped && !this._chopped) {
      this._chopped = true;
      this.clearTint();
      this.disableInteractive();
      this._farLabel.setVisible(false);

      this.scene.tweens.add({
        targets: this,
        scaleY: SCALE * 1.2,
        duration: 80,
        yoyo: true,
        onComplete: () => {
          this.setFrame(FRAME_STUMP);
          this.setScale(SCALE);
          this.setAlpha(1);
        }
      });
    } else if (!chopped && this._chopped) {
      this._chopped = false;
      this.setFrame(FRAME_TREE);
      this.setScale(0.1);
      this.setInteractive({ useHandCursor: true });

      this.scene.tweens.add({
        targets: this,
        scaleX: SCALE,
        scaleY: SCALE,
        duration: 600,
        ease: 'Back.Out',
      });
    }
  }

  destroy(fromScene) {
    this._farLabel?.destroy();
    super.destroy(fromScene);
  }
}
