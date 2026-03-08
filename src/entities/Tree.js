import Phaser from 'phaser';
import {
  SHEET_KEY, FRAME_TREE, FRAME_STUMP,
  TILE_SIZE, SHEET_TILE,
  TREE_CHOP_DIST, TREE_REGROW_MIN, TREE_REGROW_MAX,
} from '../constants.js';

const SCALE = TILE_SIZE / SHEET_TILE;

export class Tree extends Phaser.GameObjects.Image {
  constructor(scene, x, y, inventory) {
    super(scene, x, y, SHEET_KEY, FRAME_TREE);
    scene.add.existing(this);
    this.setDepth(1);
    this.setScale(SCALE);
    this.setInteractive({ useHandCursor: true });

    this._inventory = inventory;
    this._chopped   = false;

    // "Too far" label, hidden by default
    this._farLabel = scene.add.text(x, y - TILE_SIZE / 2 - 4, 'Too far!', {
      fontSize: '10px', color: '#ff4444', backgroundColor: '#00000088',
      padding: { x: 3, y: 2 }
    }).setOrigin(0.5, 1).setDepth(4).setVisible(false);

    this.on('pointerover',  () => { if (!this._chopped) this.setTint(0xaaffaa); });
    this.on('pointerout',   () => { this.clearTint(); this._farLabel.setVisible(false); });
    this.on('pointerdown',  this._onClicked, this);
  }

  _onClicked(ptr) {
    if (ptr?.event?.ctrlKey) {
      this.scene.events.emit('object-ctrl-clicked', { type: 'tree', obj: this });
      return;
    }
    if (this._chopped) return;
    if (this.scene.craftingPanel?.isOpen()) return;

    const player = this.scene.player;
    const dist = Phaser.Math.Distance.Between(player.x, player.y, this.x, this.y);

    if (dist > TREE_CHOP_DIST) {
      // Flash "Too far!" label and shake the tree slightly
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

    // Player chop — award woodcutting XP to the player's skill system
    this._chop(null, this.scene.skillSystem);
  }

  /**
   * @param {object|null} targetInventory  override inventory (NPC use)
   * @param {SkillSystem|null} skillSystem  who gets the woodcutting XP
   */
  _chop(targetInventory, skillSystem) {
    this._chopped = true;
    this.clearTint();
    this.disableInteractive();
    this._farLabel.setVisible(false);

    const inv = targetInventory ?? this._inventory;

    // Chop animation: quick scale pop then swap to stump
    this.scene.tweens.add({
      targets: this,
      scaleY: SCALE * 1.2,
      duration: 80,
      yoyo: true,
      onComplete: () => {
        inv.add('Wood', 1);
        skillSystem?.awardXP('woodcutting', 25, this.scene);

        // Swap to stump sprite
        this.setFrame(FRAME_STUMP);
        this.setScale(SCALE);
        this.setAlpha(1);

        // Schedule regrowth
        const delay = Phaser.Math.Between(TREE_REGROW_MIN, TREE_REGROW_MAX);
        this.scene.time.delayedCall(delay, () => this._regrow());
      }
    });
  }

  _regrow() {
    this._chopped = false;
    this.setFrame(FRAME_TREE);
    this.setScale(0.1);
    this.setInteractive({ useHandCursor: true });

    // Grow from tiny to full size
    this.scene.tweens.add({
      targets: this,
      scaleX: SCALE,
      scaleY: SCALE,
      duration: 600,
      ease: 'Back.Out',
    });
  }

  destroy(fromScene) {
    this._farLabel?.destroy();
    super.destroy(fromScene);
  }
}
