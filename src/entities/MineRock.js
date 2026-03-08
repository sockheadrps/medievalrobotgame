// MineRock — a mineable mineral deposit (copper, gold, tin, coal).
// Click when adjacent to mine. Yields ore, then becomes depleted and regrows.
// NPCs can be sent to mine via the 'gather' task with item = ore type.

import Phaser from 'phaser';
import {
  SHEET_KEY, SHEET_TILE, TILE_SIZE,
  FRAME_ROCK_COPPER, FRAME_ROCK_GOLD, FRAME_ROCK_TIN, FRAME_ROCK_COAL, FRAME_ROCK_ORE,
  TREE_CHOP_DIST,
} from '../constants.js';

const ROCK_REGROW_MIN = 10_000; // 10 s
const ROCK_REGROW_MAX = 20_000; // 20 s
const DEPLETED_TINT   = 0x333333; // dark grey overlay when mined out

const SCALE = TILE_SIZE / SHEET_TILE;

// Depleted rock — a dark stone frame used for all types when mined out
const FRAME_DEPLETED = 887; // stone tile reused as rubble

// Config per rock type
const ROCK_CONFIG = {
  Ore:       { frame: FRAME_ROCK_ORE,    tint: null,       yieldItem: 'Ore',       yieldMin: 1, yieldMax: 2, label: 'Ore Rock'    },
  CopperOre: { frame: FRAME_ROCK_COPPER, tint: null,       yieldItem: 'CopperOre', yieldMin: 1, yieldMax: 2, label: 'Copper Rock'  },
  GoldOre:   { frame: FRAME_ROCK_GOLD,   tint: 0xffe066,   yieldItem: 'GoldOre',   yieldMin: 1, yieldMax: 1, label: 'Gold Rock'    },
  TinOre:    { frame: FRAME_ROCK_TIN,    tint: null,       yieldItem: 'TinOre',    yieldMin: 1, yieldMax: 2, label: 'Tin Rock'     },
  Coal:      { frame: FRAME_ROCK_COAL,   tint: 0x222222,   yieldItem: 'Coal',      yieldMin: 1, yieldMax: 3, label: 'Coal Deposit' },
};

export class MineRock extends Phaser.GameObjects.Image {
  /**
   * @param {Phaser.Scene} scene
   * @param {number} x  world px
   * @param {number} y  world px
   * @param {string} rockType  'Ore'|'CopperOre'|'GoldOre'|'TinOre'|'Coal'
   * @param {object} inventory  the scene-shared Inventory
   */
  constructor(scene, x, y, rockType, inventory) {
    const cfg = ROCK_CONFIG[rockType] ?? ROCK_CONFIG.Ore;
    super(scene, x, y, SHEET_KEY, cfg.frame);
    scene.add.existing(this);
    this.setDepth(1).setScale(SCALE);
    if (cfg.tint) this.setTint(cfg.tint);

    this._cfg       = cfg;
    this._rockType  = rockType;
    this._inventory = inventory;
    this._depleted  = false;
    this._baseTint  = cfg.tint ?? null;

    this.setInteractive({ useHandCursor: true });

    // Hover tint
    this.on('pointerover', () => {
      if (!this._depleted) this.setTint(0xaaddff);
    });
    this.on('pointerout', () => {
      if (!this._depleted) {
        if (this._baseTint) this.setTint(this._baseTint); else this.clearTint();
      }
    });
    this.on('pointerdown', (ptr) => {
      if (ptr.event.ctrlKey) {
        scene.events.emit('object-ctrl-clicked', { type: 'mine_rock', obj: this });
      } else {
        this._onClicked();
      }
    });

    // Label
    this._label = scene.add.text(x, y - TILE_SIZE / 2 - 4, cfg.label, {
      fontSize: '10px', color: '#ddccaa', backgroundColor: '#00000088',
      padding: { x: 3, y: 2 },
    }).setOrigin(0.5, 1).setDepth(4).setVisible(false);

    this._farLabel = scene.add.text(x, y - TILE_SIZE / 2 - 18, 'Too far!', {
      fontSize: '10px', color: '#ff4444', backgroundColor: '#00000088',
      padding: { x: 3, y: 2 },
    }).setOrigin(0.5, 1).setDepth(4).setVisible(false);

    this.on('pointerout', () => { this._farLabel.setVisible(false); });
  }

  get rockType() { return this._rockType; }
  isDepleted()   { return this._depleted; }

  // ── Public mine API (also used by NPCs) ────────────────────────────────────

  /**
   * Mine this rock. Adds ore to targetInventory (or scene inventory if null).
   * Returns true if mining succeeded.
   * @param {object|null} targetInventory
   * @param {object|null} skillSystem
   */
  mine(targetInventory, skillSystem) {
    if (this._depleted) return false;

    const inv = targetInventory ?? this._inventory;
    const qty = Phaser.Math.Between(this._cfg.yieldMin, this._cfg.yieldMax);

    this._deplete();
    inv.add(this._cfg.yieldItem, qty);
    skillSystem?.awardXP('mining', 20, this.scene);

    return true;
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  _onClicked() {
    if (this._depleted) return;

    const player = this.scene.player;
    const dist = Phaser.Math.Distance.Between(player.x, player.y, this.x, this.y);

    if (dist > TREE_CHOP_DIST) {
      this._farLabel.setVisible(true);
      this.scene.tweens.add({
        targets: this, x: this.x + 3, duration: 40, yoyo: true, repeat: 2,
        onComplete: () => { this.x = this.x; }, // reset
      });
      return;
    }

    this.mine(null, this.scene.skillSystem);
  }

  _deplete() {
    this._depleted = true;
    this._label.setVisible(false);
    this.disableInteractive();

    // Quick shake then darken (keep frame, apply dark tint)
    this.scene.tweens.add({
      targets: this,
      scaleY: SCALE * 0.85,
      duration: 60,
      yoyo: true,
      onComplete: () => {
        this.setTint(DEPLETED_TINT);

        // Regrow after short delay
        const delay = Phaser.Math.Between(ROCK_REGROW_MIN, ROCK_REGROW_MAX);
        this.scene.time.delayedCall(delay, () => this._regrow());
      },
    });
  }

  _regrow() {
    this._depleted = false;
    // Restore original tint (or clear if none)
    if (this._baseTint) this.setTint(this._baseTint); else this.clearTint();
    this.setScale(SCALE * 0.4);
    this.setInteractive({ useHandCursor: true });

    this.scene.tweens.add({
      targets: this,
      scaleX: SCALE, scaleY: SCALE,
      duration: 500,
      ease: 'Back.Out',
    });
  }

  updateProximity(playerX, playerY) {
    const dist = Phaser.Math.Distance.Between(playerX, playerY, this.x, this.y);
    const show = !this._depleted && dist <= TILE_SIZE * 2;
    this._label.setVisible(show);
  }

  destroy(fromScene) {
    this._label?.destroy();
    this._farLabel?.destroy();
    super.destroy(fromScene);
  }
}
