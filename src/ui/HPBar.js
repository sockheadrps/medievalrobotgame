// HPBar — a reusable HP bar rendered in world space above an entity.
// Attach to a Phaser Container or position manually each frame.
//
// Usage:
//   const bar = new HPBar(scene, { width: 30, yOffset: -56 });
//   bar.update(hp, maxHp);      // call each frame or on HP change
//   bar.setPosition(x, y);      // call each frame to follow entity
//   bar.destroy();

const BAR_H      = 4;
const BORDER     = 1;
const COL_BG     = 0x330000;
const COL_FILL_H = 0x44ff44;  // > 50%
const COL_FILL_M = 0xffaa22;  // 25–50%
const COL_FILL_L = 0xff2222;  // < 25%
const COL_BORDER = 0x000000;

export class HPBar {
  /**
   * @param {Phaser.Scene} scene
   * @param {{ width?: number, depth?: number }} opts
   */
  constructor(scene, opts = {}) {
    this._scene  = scene;
    this._w      = opts.width ?? 30;
    this._depth  = opts.depth ?? 5;

    // Border rect
    this._border = scene.add.rectangle(0, 0, this._w + BORDER * 2, BAR_H + BORDER * 2, COL_BORDER)
      .setDepth(this._depth).setOrigin(0.5, 0.5);

    // Background
    this._bg = scene.add.rectangle(0, 0, this._w, BAR_H, COL_BG)
      .setDepth(this._depth + 1).setOrigin(0.5, 0.5);

    // Fill — width set dynamically; origin left-center
    this._fill = scene.add.rectangle(0, 0, this._w, BAR_H, COL_FILL_H)
      .setDepth(this._depth + 2).setOrigin(0.5, 0.5);

    this._hp    = 1;
    this._maxHp = 1;
  }

  /** Update displayed HP values. */
  update(hp, maxHp) {
    this._hp    = hp;
    this._maxHp = maxHp;

    const frac = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;
    const fillW = Math.round(this._w * frac);

    this._fill.setDisplaySize(Math.max(0, fillW), BAR_H);

    // Shift fill so it grows from left edge of background
    const leftEdge = this._bg.x - this._w / 2;
    this._fill.setX(leftEdge + fillW / 2);

    // Colour based on health fraction
    const col = frac > 0.5 ? COL_FILL_H : frac > 0.25 ? COL_FILL_M : COL_FILL_L;
    this._fill.setFillStyle(col);
  }

  /** Position all bar parts at world-space (x, y). */
  setPosition(x, y) {
    this._border.setPosition(x, y);
    this._bg.setPosition(x, y);
    // fill x is handled in update(); set y here
    this._fill.setY(y);
    // Re-apply fill X based on current fraction
    const frac   = this._maxHp > 0 ? Math.max(0, Math.min(1, this._hp / this._maxHp)) : 0;
    const fillW  = Math.round(this._w * frac);
    const leftEdge = x - this._w / 2;
    this._fill.setX(leftEdge + Math.max(0, fillW) / 2);
  }

  setVisible(v) {
    this._border.setVisible(v);
    this._bg.setVisible(v);
    this._fill.setVisible(v);
  }

  destroy() {
    this._border.destroy();
    this._bg.destroy();
    this._fill.destroy();
  }
}
