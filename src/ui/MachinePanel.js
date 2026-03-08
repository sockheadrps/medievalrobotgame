// MachinePanel — opened when player presses E near the Mother Machine.
// Shows current tier, upgrade cost, and an upgrade button.
// Crafting (skills/recipes) remains on the SkillsPanel (C key).

import { TIER_COSTS, TIER_LABELS } from '../entities/MotherMachine.js';

const W       = 340;
const H       = 280;
const DEPTH   = 25;
const COL_BG  = 0x1a0d00;
const COL_STR = 0xffaa00;

export class MachinePanel {
  constructor(scene, machine, inventory) {
    this._scene     = scene;
    this._machine   = machine;
    this._inventory = inventory;
    this._visible   = false;
    this._objects   = [];

    const cx = scene.cameras.main.width  / 2;
    const cy = scene.cameras.main.height / 2;
    this._cx = cx;
    this._cy = cy;

    const push = (o) => { this._objects.push(o); return o; };

    // Background
    push(scene.add.rectangle(cx, cy, W, H, COL_BG, 0.97)
      .setStrokeStyle(2, COL_STR)
      .setScrollFactor(0).setDepth(DEPTH).setOrigin(0.5));

    // Title
    push(scene.add.text(cx, cy - H / 2 + 20, 'MOTHER MACHINE', {
      fontSize: '16px', color: '#ffaa00', fontStyle: 'bold',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 1));

    // Current tier label (dynamic)
    this._tierText = push(scene.add.text(cx, cy - H / 2 + 44, '', {
      fontSize: '13px', color: '#ffdd88',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 1));

    // Divider
    push(scene.add.rectangle(cx, cy - H / 2 + 58, W - 20, 1, COL_STR, 0.3)
      .setScrollFactor(0).setDepth(DEPTH + 1).setOrigin(0.5, 0));

    // Upgrade section label
    this._upgradeTitle = push(scene.add.text(cx, cy - H / 2 + 74, '', {
      fontSize: '12px', color: '#ffcc66',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 1));

    // Cost lines (up to 3 resources)
    this._costTexts = [];
    for (let i = 0; i < 3; i++) {
      this._costTexts.push(push(scene.add.text(cx, cy - H / 2 + 96 + i * 18, '', {
        fontSize: '11px', color: '#aaaaaa',
      }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 1)));
    }

    // Upgrade button
    this._upgBtn = push(scene.add.rectangle(cx, cy + H / 2 - 72, W - 60, 32, 0x332200, 1)
      .setStrokeStyle(1, 0xffaa00)
      .setScrollFactor(0).setDepth(DEPTH + 1).setOrigin(0.5)
      .setInteractive({ useHandCursor: true }));

    this._upgBtnText = push(scene.add.text(cx, cy + H / 2 - 72, 'Upgrade Machine', {
      fontSize: '13px', color: '#ffaa00',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 2));

    this._upgBtn.on('pointerover', () => this._upgBtn.setFillStyle(0x553300));
    this._upgBtn.on('pointerout',  () => this._upgBtn.setFillStyle(0x332200));
    this._upgBtn.on('pointerdown', () => this._doUpgrade());

    // Result flash
    this._resultText = push(scene.add.text(cx, cy + H / 2 - 40, '', {
      fontSize: '12px', color: '#88ff88',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 2));

    // Close hint
    push(scene.add.text(cx, cy + H / 2 - 16, 'E or Escape to close', {
      fontSize: '9px', color: '#554422',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 1));

    // Outside click closes
    scene.input.on('pointerup', (ptr) => {
      if (!this._visible) return;
      if (scene.time.now - this._openTime < 200) return;
      const px = cx - W / 2, py = cy - H / 2;
      if (ptr.x < px || ptr.x > px + W || ptr.y < py || ptr.y > py + H) this.hide();
    });

    scene.input.keyboard.on('keydown-ESC', () => { if (this._visible) this.hide(); });

    this._openTime = 0;
    this._setVisible(false);
  }

  // ── Public ────────────────────────────────────────────────────────────────

  show() {
    this._openTime = this._scene.time.now;
    this._refresh();
    this._setVisible(true);
    this._visible = true;
  }

  hide() {
    this._setVisible(false);
    this._visible = false;
  }

  toggle() { this._visible ? this.hide() : this.show(); }
  isOpen()  { return this._visible; }

  // ── Private ───────────────────────────────────────────────────────────────

  _refresh() {
    const tier = this._machine.tier;
    this._tierText.setText(`Current: ${TIER_LABELS[tier]}`);

    const cost = this._machine.nextTierCost();
    if (!cost) {
      // Max tier
      this._upgradeTitle.setText('Machine is fully upgraded');
      this._costTexts.forEach(t => t.setText(''));
      this._upgBtn.setVisible(false);
      this._upgBtnText.setVisible(false);
      return;
    }

    this._upgBtn.setVisible(true);
    this._upgBtnText.setVisible(true);
    this._upgradeTitle.setText(`Upgrade to ${TIER_LABELS[tier + 1]}:`);

    const entries = Object.entries(cost);
    for (let i = 0; i < 3; i++) {
      if (i < entries.length) {
        const [item, qty] = entries[i];
        const have = this._inventory.get(item);
        const ok   = have >= qty;
        this._costTexts[i]
          .setText(`${item}: ${have} / ${qty}`)
          .setColor(ok ? '#88ff88' : '#ff6666');
      } else {
        this._costTexts[i].setText('');
      }
    }

    // Dim button if can't afford
    const canAfford = entries.every(([item, qty]) => this._inventory.get(item) >= qty);
    this._upgBtn.setStrokeStyle(1, canAfford ? 0xffaa00 : 0x554400);
    this._upgBtnText.setColor(canAfford ? '#ffaa00' : '#665500');
  }

  _doUpgrade() {
    const success = this._machine.tryUpgrade(this._inventory);
    if (success) {
      // Update GameScene tier mirror
      this._scene.motherMachineTier = this._machine.tier;
      this._scene.hud.updateTier(this._machine.tier);
      this._resultText.setText(`Upgraded to ${TIER_LABELS[this._machine.tier]}!`).setColor('#88ff88');
    } else {
      this._resultText.setText('Not enough resources.').setColor('#ff6666');
    }
    this._refresh();
    // Clear result message after 2s
    this._scene.time.delayedCall(2000, () => { if (this._resultText) this._resultText.setText(''); });
  }

  _setVisible(v) {
    for (const o of this._objects) o.setVisible(v);
  }
}
