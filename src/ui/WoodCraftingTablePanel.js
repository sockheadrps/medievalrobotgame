import Phaser from 'phaser';

const W = 420;
const H = 220;
const DEPTH = 26;

export class WoodCraftingTablePanel {
  constructor(scene, inventory, skillSystem) {
    this._scene = scene;
    this._inventory = inventory;
    this._skills = skillSystem;
    this._table = null;
    this._visible = false;
    this._objs = [];

    const cx = scene.cameras.main.width / 2;
    const cy = scene.cameras.main.height / 2;
    this._cx = cx;
    this._cy = cy;

    const push = (o) => { this._objs.push(o); return o; };
    push(scene.add.rectangle(cx, cy, W, H, 0x14222f, 0.96)
      .setStrokeStyle(2, 0x4b7597)
      .setScrollFactor(0).setDepth(DEPTH).setVisible(false));
    push(scene.add.text(cx, cy - H / 2 + 16, 'WOOD CRAFTING TABLE', {
      fontSize: '14px', color: '#d9b37a',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 1).setVisible(false));

    this._status = push(scene.add.text(cx, cy - 34, '', {
      fontSize: '12px', color: '#aac7dd', align: 'center',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 1).setVisible(false));
    this._recipe = push(scene.add.text(cx, cy - 12, 'Recipe: 1 Wood -> 1 Wood Pulp Conveyor (1s)', {
      fontSize: '11px', color: '#88b4d6', align: 'center',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 1).setVisible(false));

    this._queueLabel = push(scene.add.text(cx - 170, cy + 24, 'Queue:', {
      fontSize: '11px', color: '#99b0c2',
    }).setScrollFactor(0).setDepth(DEPTH + 1).setVisible(false));
    this._takeLabel = push(scene.add.text(cx - 170, cy + 64, 'Collect Output:', {
      fontSize: '11px', color: '#99b0c2',
    }).setScrollFactor(0).setDepth(DEPTH + 1).setVisible(false));

    this._btns = [];
    this._btns.push(this._mkBtn(cx - 70, cy + 24, '+1', () => this._queue(1)));
    this._btns.push(this._mkBtn(cx,      cy + 24, '+5', () => this._queue(5)));
    this._btns.push(this._mkBtn(cx + 70, cy + 24, '+All', () => {
      const wood = this._inventory.get?.('Wood') ?? 0;
      this._queue(wood);
    }));
    this._btns.push(this._mkBtn(cx - 70, cy + 64, 'Take 1', () => this._take(1)));
    this._btns.push(this._mkBtn(cx + 10, cy + 64, 'Take All', () => {
      const out = this._table?.getOutput?.() ?? 0;
      this._take(Math.max(1, out));
    }));

    this._hint = push(scene.add.text(cx, cy + H / 2 - 18, 'Queue consumes wood now. XP is granted on collection.', {
      fontSize: '10px', color: '#5b7b95', align: 'center',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 1).setVisible(false));

    scene.time.addEvent({
      delay: 120,
      loop: true,
      callback: () => { if (this._visible) this._refresh(); },
    });
  }

  _mkBtn(x, y, label, onClick) {
    const bg = this._scene.add.rectangle(x, y, 64, 24, 0x1b2f41, 1)
      .setStrokeStyle(1, 0x4b7597)
      .setScrollFactor(0).setDepth(DEPTH + 1).setVisible(false)
      .setInteractive({ useHandCursor: true });
    const t = this._scene.add.text(x, y, label, {
      fontSize: '11px', color: '#d0e7f7',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 2).setVisible(false);
    bg.on('pointerover', () => bg.setFillStyle(0x244159));
    bg.on('pointerout', () => bg.setFillStyle(0x1b2f41));
    bg.on('pointerdown', onClick);
    this._objs.push(bg, t);
    return { bg, t };
  }

  open(table) {
    this._table = table;
    this.show();
  }
  show() {
    this._visible = true;
    for (const o of this._objs) o.setVisible(true);
    this._refresh();
  }
  hide() {
    this._visible = false;
    for (const o of this._objs) o.setVisible(false);
  }
  isOpen() { return this._visible; }

  _queue(n) {
    if (!this._table) return;
    this._table.queueCrafts(this._inventory, n);
    this._refresh();
  }

  _take(n) {
    if (!this._table) return;
    this._table.pickupOutput(this._inventory, this._skills, n);
    this._refresh();
  }

  _refresh() {
    if (!this._table) {
      this._status.setText('No table selected');
      return;
    }
    const wood = this._inventory.get?.('Wood') ?? 0;
    const q = this._table.getQueued?.() ?? 0;
    const out = this._table.getOutput?.() ?? 0;
    const c = this._table.isCrafting?.() ? ` | Craft ${Math.round((this._table.getCraftProgress?.() ?? 0) * 100)}%` : '';
    this._status.setText(`Wood: ${wood} | Queue: ${q} | Output: ${out}${c}`);
  }
}

