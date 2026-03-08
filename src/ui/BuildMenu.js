// BuildMenu — compact layout for HUD tab zone (916×174).
// 3-column grid of build items, scrollable.

const BUILDABLES = [
  { id: 'conveyor',        label: 'Conveyor',        tierRequired: 1, desc: 'Moves items between tiles',                                    color: '#66aaff' },
  { id: 'quarry',          label: 'Quarry',          tierRequired: 1, desc: 'Mines raw ore — needs adjacent flywheel',                      color: '#aaffaa' },
  { id: 'crusher',         label: 'Ore Crusher',     tierRequired: 1, desc: 'Crushes 5 ore → 1–3 iron — needs flywheel',                   color: '#ffdd88' },
  { id: 'plain_furnace',   label: 'Furnace',         tierRequired: 1, desc: 'Smelts 5 iron → 1 iron bar, wood-fired only (5 s)',          color: '#ddbb88' },
  { id: 'furnace',         label: 'Iron Furnace',    tierRequired: 1, desc: 'Smelts 5 iron → 1 iron bar (5 s)',                            color: '#ff9944' },
  { id: 'steel_furnace',  label: 'Steel Furnace',   tierRequired: 1, desc: '1 iron bar + 2 coal → 1 steel bar (5 s)',                      color: '#aabbdd' },
  { id: 'bronze_furnace', label: 'Bronze Furnace',  tierRequired: 1, desc: '1 copper + 1 tin → 1 bronze bar (5 s)',                        color: '#ddaa55' },
  { id: 'crate',           label: 'Storage',         tierRequired: 1, desc: 'Stores any resource (unlimited)',                              color: '#ccccff' },
  { id: 'flywheel',        label: 'Flywheel',        tierRequired: 1, desc: 'Hold Space nearby to charge',                                  color: '#ffcc66' },
  { id: 'anvil',           label: 'Anvil',           tierRequired: 1, desc: 'Blacksmithing — craft iron bars',                              color: '#ddddff' },
  { id: 'crafting_bench',  label: 'Crafting Bench',  tierRequired: 1, desc: 'Craft construction materials',                                 color: '#bbaa88' },
  { id: 'reinforced_block',label: 'Reinforced Block',tierRequired: 1, desc: 'Sturdy wall — consumes 1 from inv',                            color: '#aaaaaa' },
  { id: 'wood_frame',      label: 'Wood Frame',      tierRequired: 1, desc: 'Light wall — consumes 1 from inv',                             color: '#ccaa77' },
  { id: 'door',            label: 'Door',            tierRequired: 1, desc: 'Opens for allies, blocks enemies',                             color: '#cc9966' },
  { id: 'wall',   label: 'Wooden Wall', tierRequired: 2, desc: 'Impassable barrier',                color: '#aa8855' },
  { id: 'gate',   label: 'Gate',        tierRequired: 2, desc: 'Opens for allies, blocks enemies',  color: '#cc9966' },
  { id: 'tower',  label: 'Watch Tower', tierRequired: 3, desc: 'Ranged NPC station',                color: '#ffaaaa' },
  { id: 'pylon',  label: 'Claim Pylon', tierRequired: 3, desc: 'Marks territory, reduces heat',     color: '#aaffff' },
];

const DEPTH  = 52;
const COLS   = 3;
const ROW_H  = 46;

export class BuildMenu {
  constructor(scene, onSelect, zone) {
    this._scene    = scene;
    this._onSelect = onSelect;
    this._visible  = false;
    this._scroll   = 0;
    this._rowObjs  = [];

    this._zx = zone.x;
    this._zy = zone.y;
    this._zw = zone.w;
    this._zh = zone.h;

    this._colW = Math.floor(zone.w / COLS);
    this._contentH  = 0;
    this._maxScroll = 0;
    this._curTier   = 1;

    // Clip mask
    const maskGfx = scene.add.graphics().setScrollFactor(0);
    maskGfx.fillRect(zone.x, zone.y, zone.w, zone.h);
    this._mask = maskGfx.createGeometryMask();
    maskGfx.setVisible(false);

    // Scroll hint text
    this._scrollHint = scene.add.text(zone.x + zone.w - 8, zone.y + zone.h - 4, '', {
      fontSize: '8px', color: '#334455',
    }).setOrigin(1, 1).setScrollFactor(0).setDepth(DEPTH + 1).setVisible(false);

    // Mouse wheel scrolling
    scene.input.on('wheel', (ptr, _objs, _dx, dy) => {
      if (!this._visible) return;
      if (ptr.x < this._zx || ptr.x > this._zx + this._zw) return;
      if (ptr.y < this._zy || ptr.y > this._zy + this._zh) return;
      this._scrollBy(dy > 0 ? ROW_H : -ROW_H);
    });
  }

  // ── Public ────────────────────────────────────────────────────────────────

  show() {
    this._curTier = this._scene.motherMachineTier ?? 1;
    const rows = Math.ceil(BUILDABLES.length / COLS);
    this._contentH  = rows * ROW_H;
    this._maxScroll = Math.max(0, this._contentH - this._zh);
    this._scroll    = 0;
    this._visible   = true;
    this._scrollHint.setVisible(true);
    this._buildRows();
  }

  hide() {
    this._destroyRows();
    this._scrollHint.setVisible(false);
    this._visible = false;
  }

  toggle() { this._visible ? this.hide() : this.show(); }
  isOpen()  { return this._visible; }

  // ── Private ───────────────────────────────────────────────────────────────

  _scrollBy(delta) {
    this._scroll = Math.max(0, Math.min(this._maxScroll, this._scroll + delta));
    this._buildRows();
  }

  _destroyRows() {
    for (const o of this._rowObjs) o.destroy();
    this._rowObjs = [];
  }

  _buildRows() {
    this._destroyRows();
    const scene   = this._scene;
    const curTier = this._curTier;
    const push    = (o) => { this._rowObjs.push(o); return o; };

    for (let i = 0; i < BUILDABLES.length; i++) {
      const item = BUILDABLES[i];
      const col  = i % COLS;
      const row  = Math.floor(i / COLS);
      const cx   = this._zx + col * this._colW + this._colW / 2;
      const cy   = this._zy + row * ROW_H + ROW_H / 2 - this._scroll;

      if (cy < this._zy - ROW_H || cy > this._zy + this._zh + ROW_H) continue;

      const locked = item.tierRequired > curTier;

      const btn = push(scene.add.rectangle(cx, cy, this._colW - 8, ROW_H - 6, locked ? 0x0d1015 : 0x112233, 1)
        .setStrokeStyle(1, locked ? 0x1a1f25 : 0x334466)
        .setScrollFactor(0).setDepth(DEPTH + 1).setMask(this._mask)
        .setInteractive({ useHandCursor: !locked }));

      push(scene.add.text(cx - this._colW / 2 + 8, cy - 8, item.label, {
        fontSize: '11px', color: locked ? '#334444' : item.color,
      }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(DEPTH + 2).setMask(this._mask));

      const descStr = locked ? `Tier ${item.tierRequired}` : item.desc;
      const descTrunc = descStr.length > 38 ? descStr.slice(0, 36) + '…' : descStr;
      push(scene.add.text(cx - this._colW / 2 + 8, cy + 8, descTrunc, {
        fontSize: '8px', color: locked ? '#222233' : '#667788',
      }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(DEPTH + 2).setMask(this._mask));

      if (!locked) {
        btn.on('pointerover', () => btn.setFillStyle(0x1a3344));
        btn.on('pointerout',  () => btn.setFillStyle(0x112233));
        btn.on('pointerdown', () => { this._onSelect(item.id); });
      }
    }

    const pct = this._maxScroll > 0 ? Math.round((this._scroll / this._maxScroll) * 100) : 0;
    this._scrollHint.setText(this._maxScroll > 0 ? `scroll ${pct}%` : '');
  }
}
