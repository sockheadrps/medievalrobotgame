import Phaser from 'phaser';
import { INTERACT_DIST, TILE_SIZE, SHEET_KEY, FRAME_MACHINE, SHEET_TILE } from '../constants.js';

// Tier upgrade costs — what the player must have in inventory to upgrade
export const TIER_COSTS = {
  2: { IronBar: 20, Stone: 10, Wood: 5 },
  3: { SteelBar: 30, ReinforcedBlock: 20, GoldBar: 10 },
  4: { SteelBar: 50, GoldBar: 25, IronBar: 20 },
};

export const TIER_LABELS = {
  1: 'Tier I',
  2: 'Tier II',
  3: 'Tier III',
  4: 'Tier IV (MAX)',
};

export class MotherMachine extends Phaser.GameObjects.Image {
  constructor(scene, x, y) {
    super(scene, x, y, SHEET_KEY, FRAME_MACHINE);
    scene.add.existing(this);
    this.setDepth(1);
    this.setScale(TILE_SIZE / SHEET_TILE);

    this._tier = 1;

    const halfH = TILE_SIZE / 2;

    this._label = scene.add.text(x, y - halfH - 12, 'THE MACHINE', {
      fontSize: '11px',
      color: '#ffaa00',
      align: 'center'
    }).setOrigin(0.5, 1).setDepth(3);

    this._tierLabel = scene.add.text(x, y - halfH - 24, TIER_LABELS[1], {
      fontSize: '9px',
      color: '#ffdd88',
      align: 'center',
      backgroundColor: '#00000088',
      padding: { x: 3, y: 1 },
    }).setOrigin(0.5, 1).setDepth(3);

    this._prompt = scene.add.text(x, y - halfH - 38, '[E] Craft / Upgrade', {
      fontSize: '10px',
      color: '#ffffff',
      align: 'center',
      backgroundColor: '#00000088',
      padding: { x: 4, y: 2 }
    }).setOrigin(0.5, 1).setDepth(3).setVisible(false);
  }

  get tier() { return this._tier; }

  setTier(t) {
    this._tier = Math.min(4, Math.max(1, t));
    this._tierLabel.setText(TIER_LABELS[this._tier]);
  }

  /** Returns the cost object for upgrading to the next tier, or null if max. */
  nextTierCost() {
    const next = this._tier + 1;
    return TIER_COSTS[next] ?? null;
  }

  /**
   * Attempt to upgrade using the given inventory.
   * Returns true if upgrade succeeded, false if insufficient resources or already max.
   */
  tryUpgrade(inventory) {
    const cost = this.nextTierCost();
    if (!cost) return false;

    // Check
    for (const [item, qty] of Object.entries(cost)) {
      if (inventory.get(item) < qty) return false;
    }
    // Consume
    for (const [item, qty] of Object.entries(cost)) {
      inventory.set(item, inventory.get(item) - qty);
    }

    this.setTier(this._tier + 1);
    return true;
  }

  // Returns true if player is in interaction range
  updateProximity(playerX, playerY) {
    const dist = Phaser.Math.Distance.Between(playerX, playerY, this.x, this.y);
    const inRange = dist <= INTERACT_DIST;
    this._prompt.setVisible(inRange);
    return inRange;
  }
}
