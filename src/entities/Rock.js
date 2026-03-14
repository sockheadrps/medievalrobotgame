import Phaser from 'phaser';
import {
  SHEET_KEY, FRAME_ROCK,
  TILE_SIZE, SHEET_TILE,
  ROCK_MINE_DIST, ROCK_HITS,
} from '../constants.js';

const SCALE = TILE_SIZE / SHEET_TILE;

export class Rock extends Phaser.GameObjects.Image {
  constructor(scene, x, y) {
    super(scene, x, y, SHEET_KEY, FRAME_ROCK);
    scene.add.existing(this);
    this.setDepth(1);
    this.setScale(SCALE);
    this.setInteractive({ useHandCursor: true });

    this._mined = false;
    this.rockId = -1; // set by GameScene from server data

    // Hit counter label (shows remaining hits)
    this._hitsLeft = ROCK_HITS;
    this._hitLabel = scene.add.text(x, y - TILE_SIZE / 2 - 4, '', {
      fontSize: '10px', color: '#ffcc44', backgroundColor: '#00000088',
      padding: { x: 3, y: 2 },
    }).setOrigin(0.5, 1).setDepth(4).setVisible(false);

    // "Too far" label
    this._farLabel = scene.add.text(x, y + TILE_SIZE / 2 + 4, 'Too far!', {
      fontSize: '10px', color: '#ff4444', backgroundColor: '#00000088',
      padding: { x: 3, y: 2 },
    }).setOrigin(0.5, 0).setDepth(4).setVisible(false);

    this.on('pointerover', () => { if (!this._mined) this.setTint(0xccccff); });
    this.on('pointerout',  () => { this.clearTint(); this._farLabel.setVisible(false); });
    this.on('pointerdown', this._onClicked, this);
  }

  _onClicked() {
    if (this._mined) return;

    const player = this.scene.player;
    const d = Phaser.Math.Distance.Between(player.x, player.y, this.x, this.y);

    if (d > ROCK_MINE_DIST) {
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

    // Send mine hit to server
    const conn = this.scene._conn;
    if (conn?.connected) {
      conn.send({ type: 'mine_rock', rock_id: this.rockId });
    }
  }

  /** Called by server sync to update hits remaining. */
  setHits(hitsLeft) {
    if (hitsLeft === this._hitsLeft) return; // no change
    const prevHits = this._hitsLeft;
    this._hitsLeft = hitsLeft;
    if (hitsLeft > 0 && hitsLeft < ROCK_HITS) {
      this._hitLabel.setText(`${hitsLeft}/${ROCK_HITS}`);
      this._hitLabel.setVisible(true);
      // Shake feedback only on actual hit
      if (hitsLeft < prevHits) {
        this.scene.tweens.add({
          targets: this,
          x: this.x + 3,
          duration: 30,
          yoyo: true,
          repeat: 1,
        });
      }
      // Darken slightly as it takes damage
      const frac = hitsLeft / ROCK_HITS;
      const tint = Phaser.Display.Color.GetColor(
        Math.round(255 * frac),
        Math.round(255 * frac),
        Math.round(255 * frac),
      );
      this.setTint(tint);
    }
  }

  /** Called when rock is fully mined or despawned — remove visual. */
  setMined() {
    if (this._mined) return;
    this._mined = true;
    this.clearTint();
    this.disableInteractive();
    this._farLabel.setVisible(false);
    this._hitLabel.setVisible(false);

    // Shrink away
    this.scene.tweens.add({
      targets: this,
      scaleX: 0,
      scaleY: 0,
      alpha: 0,
      duration: 300,
      onComplete: () => {
        this.setVisible(false);
      },
    });
  }

  /** Called when rock spawns in — grow from nothing. */
  spawnIn() {
    this._mined = false;
    this._hitsLeft = ROCK_HITS;
    this.setVisible(true);
    this.setAlpha(1);
    this.setScale(0.1);
    this.setInteractive({ useHandCursor: true });
    this._hitLabel.setVisible(false);
    this.clearTint();

    this.scene.tweens.add({
      targets: this,
      scaleX: SCALE,
      scaleY: SCALE,
      duration: 500,
      ease: 'Back.Out',
    });
  }

  destroy(fromScene) {
    this._farLabel?.destroy();
    this._hitLabel?.destroy();
    super.destroy(fromScene);
  }
}
