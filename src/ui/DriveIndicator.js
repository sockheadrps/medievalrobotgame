// DriveIndicator.js — displays NPC drive bars above the selected NPC in world-space.
// Rendered as small colored bars, updated each frame.

const DRIVE_COLORS = {
  aggression: 0xff3333,
  attachment: 0x33ddff,
  curiosity:  0xffdd00,
  greed:      0xff8800,
  social:     0x44ff88,
  survival:   0xff44cc,
  ambition:   0x4488ff,
};

const DRIVE_ORDER = ['survival', 'attachment', 'aggression', 'greed', 'ambition', 'social', 'curiosity'];
const BAR_W = 28;
const BAR_H = 3;
const BAR_GAP = 1;
const TOTAL_H = DRIVE_ORDER.length * (BAR_H + BAR_GAP);
const OFFSET_Y = 42; // pixels above NPC origin

export class DriveIndicator {
  constructor(scene) {
    this._scene = scene;
    this._npc = null;
    this._bars = []; // { bg, fill, label }
    this._container = null;
    this._built = false;
  }

  attach(npc) {
    this._npc = npc;
    if (!this._built) this._build();
    this._setVisible(true);
  }

  detach() {
    this._npc = null;
    this._setVisible(false);
  }

  update() {
    if (!this._npc || !this._built) return;
    if (this._npc.isDead?.() || this._npc.isKnockedOut?.()) {
      this._setVisible(false);
      return;
    }

    const drives = this._npc.soul?.drives;
    if (!drives) { this._setVisible(false); return; }

    // Position above the NPC (world-space)
    const cx = this._npc.x;
    const cy = this._npc.y - OFFSET_Y;

    this._setVisible(true);

    for (let i = 0; i < DRIVE_ORDER.length; i++) {
      const driveName = DRIVE_ORDER[i];
      const bar = this._bars[i];
      if (!bar) continue;

      const val = Math.max(0, Math.min(1, drives[driveName] ?? 0));
      const rowY = cy - TOTAL_H / 2 + i * (BAR_H + BAR_GAP);
      const rowX = cx - BAR_W / 2;

      bar.bg.setPosition(cx, rowY + BAR_H / 2);
      bar.fill.setPosition(rowX + (val * BAR_W) / 2, rowY + BAR_H / 2);
      bar.fill.setSize(val * BAR_W, BAR_H);
    }
  }

  destroy() {
    this._destroyBars();
    this._built = false;
    this._npc = null;
  }

  _build() {
    const scene = this._scene;
    this._destroyBars();

    for (let i = 0; i < DRIVE_ORDER.length; i++) {
      const driveName = DRIVE_ORDER[i];
      const color = DRIVE_COLORS[driveName] ?? 0xffffff;

      const bg = scene.add.rectangle(0, 0, BAR_W, BAR_H, 0x000000, 0.5)
        .setDepth(12).setOrigin(0.5, 0.5).setScrollFactor(1);

      const fill = scene.add.rectangle(0, 0, 0, BAR_H, color, 0.9)
        .setDepth(13).setOrigin(0, 0.5).setScrollFactor(1);

      this._bars.push({ bg, fill });
    }

    this._built = true;
    this._setVisible(false);
  }

  _setVisible(on) {
    for (const bar of this._bars) {
      bar.bg.setVisible(on);
      bar.fill.setVisible(on);
    }
  }

  _destroyBars() {
    for (const bar of this._bars) {
      bar.bg?.destroy();
      bar.fill?.destroy();
    }
    this._bars = [];
  }
}
