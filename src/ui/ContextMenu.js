// ContextMenu — a small in-game right-click context menu.
// Show it with a list of { label, callback } items; it auto-hides after any selection
// or when the user clicks elsewhere.
//
// All objects use setScrollFactor(0) and are positioned in screen space so that
// the menu stays correctly positioned and clickable even when the camera moves.

const BG_COLOR    = 0x111111;
const BG_ALPHA    = 0.92;
const ITEM_H      = 22;
const ITEM_W      = 170;
const PAD_X       = 10;
const PAD_Y       = 6;
const HOVER_COLOR = 0x3355aa;
const DEPTH       = 50;

export class ContextMenu {
  constructor(scene) {
    this._scene   = scene;
    this._visible = false;
    this._objects = []; // all screen-space objects for the current open menu

    // Close when clicking outside the menu
    scene.input.on('pointerdown', (ptr) => {
      if (!this._visible) return;
      if (!this._closeOnOutsideClick) return;
      if (ptr.x < this._screenX || ptr.x > this._screenX + this._menuW ||
          ptr.y < this._screenY || ptr.y > this._screenY + this._menuH) {
        this.hide();
      }
    });

    this._screenX    = 0;
    this._screenY    = 0;
    this._menuW      = ITEM_W;
    this._menuH      = 0;
    this._itemCount  = 0;
    this._closeOnOutsideClick = true;
    this._closeOnItemClick = true;

    scene.input.keyboard?.on('keydown-ESC', () => {
      if (this._visible) this.hide();
    });
  }

  /**
   * @param {number} x  screen x (pointer.x)
   * @param {number} y  screen y (pointer.y)
   * @param {{ label: string, callback: () => void }[]} items
   * @param {{ width?: number }} [opts]
   */
  show(x, y, items, opts = {}) {
    this.hide(); // destroy any previously open menu first

    this._itemCount = items.length;
    this._visible   = true;
    const menuW = Math.max(140, Number(opts?.width ?? ITEM_W));
    this._menuW = menuW;
    this._closeOnOutsideClick = opts?.closeOnOutsideClick !== false;
    this._closeOnItemClick = opts?.closeOnItemClick !== false;

    const totalH = PAD_Y * 2 + ITEM_H * items.length;
    this._menuH = totalH;

    // Clamp to screen bounds
    const sw = this._scene.scale.width;
    const sh = this._scene.scale.height;
    const px = Math.min(x, sw - menuW - 4);
    const py = Math.min(y, sh - totalH - 4);
    this._screenX = px;
    this._screenY = py;

    const push = (o) => { this._objects.push(o); return o; };

    // Background
    push(this._scene.add.rectangle(px, py, menuW, totalH, BG_COLOR, BG_ALPHA)
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(DEPTH));

    items.forEach((item, i) => {
      const itemY = py + PAD_Y + i * ITEM_H;

      // Hover highlight — full-width, screen-space interactive rect
      const hover = push(this._scene.add.rectangle(px, itemY, menuW, ITEM_H, HOVER_COLOR, 0)
        .setOrigin(0, 0)
        .setScrollFactor(0)
        .setDepth(DEPTH + 1)
        .setInteractive({ useHandCursor: true }));

      hover.on('pointerover',  () => hover.setFillStyle(HOVER_COLOR, 0.8));
      hover.on('pointerout',   () => hover.setFillStyle(HOVER_COLOR, 0));
      hover.on('pointerdown',  (ptr) => {
        ptr.event.stopPropagation();
        if (this._closeOnItemClick) this.hide();
        item.callback();
      });

      push(this._scene.add.text(px + PAD_X, itemY + ITEM_H / 2, item.label, {
        fontSize: '12px', color: '#ffffff',
      }).setOrigin(0, 0.5)
        .setScrollFactor(0)
        .setDepth(DEPTH + 2));
    });
  }

  hide() {
    for (const o of this._objects) o.destroy();
    this._objects = [];
    this._visible   = false;
    this._itemCount = 0;
    this._menuW = ITEM_W;
    this._menuH = 0;
    this._closeOnOutsideClick = true;
    this._closeOnItemClick = true;
  }

  isOpen() {
    return this._visible;
  }

  destroy() {
    this.hide();
  }
}
