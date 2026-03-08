// FurnacePanel — universal panel for all furnace types.
// Iron:   1 input (Iron), wood fuel → Iron Bar
// Steel:  2 inputs (Iron Bar + Coal), coal is fuel → Steel Bar
// Bronze: 2 inputs (Copper Ore + Tin Ore), wood fuel → Bronze Bar

const MAX_BARS     = 20;
const WOOD_BURN_MS = 8000;

export class FurnacePanel {
  constructor(scene, inventory) {
    this._scene     = scene;
    this._inventory = inventory;
    this._furnace   = null;
    this._visible   = false;
    this._objects   = [];

    const W = 380, H = 360;
    this._W  = W;
    this._H  = H;
    this._cx = scene.cameras.main.width  / 2;
    this._cy = scene.cameras.main.height / 2;

    this._bg = scene.add.rectangle(this._cx, this._cy, W, H, 0x1a0d00, 0.97)
      .setStrokeStyle(2, 0xff9944)
      .setScrollFactor(0).setDepth(25).setVisible(false);
    this._objects.push(this._bg);

    this._titleText = this._push(scene.add.text(this._cx, this._cy - H / 2 + 18, 'FURNACE', {
      fontSize: '15px', color: '#ff9944', align: 'center',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(26).setVisible(false));

    this._push(scene.add.text(this._cx, this._cy + H / 2 - 14,
      'Click: move 1  |  Shift+click: move all  |  E / click outside: close', {
      fontSize: '10px', color: '#554433', align: 'center',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(26).setVisible(false));

    // ── Fuel row (Wood) — hidden for steel ───────────────────────────────────
    const woodY = this._cy - 120;

    this._fuelLabel = this._push(scene.add.text(this._cx - 150, woodY, 'Wood (fuel)', {
      fontSize: '13px', color: '#aaddaa',
    }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(26).setVisible(false));

    this._invWoodCount = this._push(scene.add.text(this._cx - 20, woodY, '0', {
      fontSize: '13px', color: '#ffffff',
    }).setOrigin(1, 0.5).setScrollFactor(0).setDepth(26).setVisible(false));

    this._woodToBtn = this._push(scene.add.text(this._cx + 10, woodY, '→', {
      fontSize: '16px', color: '#44ff88',
      backgroundColor: '#1a3322', padding: { x: 8, y: 3 },
    }).setOrigin(0.5).setScrollFactor(0).setDepth(26).setVisible(false)
      .setInteractive({ useHandCursor: true }));

    this._woodFromBtn = this._push(scene.add.text(this._cx + 60, woodY, '←', {
      fontSize: '16px', color: '#ff8844',
      backgroundColor: '#331a11', padding: { x: 8, y: 3 },
    }).setOrigin(0.5).setScrollFactor(0).setDepth(26).setVisible(false)
      .setInteractive({ useHandCursor: true }));

    this._furnaceWoodCount = this._push(scene.add.text(this._cx + 100, woodY, '0/10', {
      fontSize: '13px', color: '#aaddaa',
    }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(26).setVisible(false));

    this._fuelBarBg = this._push(scene.add.rectangle(this._cx - 20, woodY + 20, 120, 7, 0x332211)
      .setScrollFactor(0).setDepth(26).setOrigin(0, 0.5).setVisible(false));
    this._fuelBar = this._push(scene.add.rectangle(this._cx - 20, woodY + 20, 0, 7, 0xff6600)
      .setScrollFactor(0).setDepth(27).setOrigin(0, 0.5).setVisible(false));

    this._woodToBtn.on('pointerover',  () => this._woodToBtn.setStyle({ backgroundColor: '#225533' }));
    this._woodToBtn.on('pointerout',   () => this._woodToBtn.setStyle({ backgroundColor: '#1a3322' }));
    this._woodToBtn.on('pointerdown',  (p) => this._moveWoodIn(p.event.shiftKey ? Infinity : 1));
    this._woodFromBtn.on('pointerover',() => this._woodFromBtn.setStyle({ backgroundColor: '#442211' }));
    this._woodFromBtn.on('pointerout', () => this._woodFromBtn.setStyle({ backgroundColor: '#331a11' }));
    this._woodFromBtn.on('pointerdown',(p) => this._moveWoodOut(p.event.shiftKey ? Infinity : 1));

    // ── Primary input row ─────────────────────────────────────────────────────
    const in1Y = this._cy - 40;

    this._in1Label = this._push(scene.add.text(this._cx - 150, in1Y, 'Iron (raw)', {
      fontSize: '13px', color: '#cccccc',
    }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(26).setVisible(false));

    this._invIn1Count = this._push(scene.add.text(this._cx - 20, in1Y, '0', {
      fontSize: '13px', color: '#ffffff',
    }).setOrigin(1, 0.5).setScrollFactor(0).setDepth(26).setVisible(false));

    this._in1ToBtn = this._push(scene.add.text(this._cx + 10, in1Y, '→', {
      fontSize: '16px', color: '#44ff88',
      backgroundColor: '#1a3322', padding: { x: 8, y: 3 },
    }).setOrigin(0.5).setScrollFactor(0).setDepth(26).setVisible(false)
      .setInteractive({ useHandCursor: true }));

    this._in1FromBtn = this._push(scene.add.text(this._cx + 60, in1Y, '←', {
      fontSize: '16px', color: '#ff8844',
      backgroundColor: '#331a11', padding: { x: 8, y: 3 },
    }).setOrigin(0.5).setScrollFactor(0).setDepth(26).setVisible(false)
      .setInteractive({ useHandCursor: true }));

    this._furnaceIn1Count = this._push(scene.add.text(this._cx + 100, in1Y, '0/5', {
      fontSize: '13px', color: '#aaaaff',
    }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(26).setVisible(false));

    this._in1ToBtn.on('pointerover',  () => this._in1ToBtn.setStyle({ backgroundColor: '#225533' }));
    this._in1ToBtn.on('pointerout',   () => this._in1ToBtn.setStyle({ backgroundColor: '#1a3322' }));
    this._in1ToBtn.on('pointerdown',  (p) => this._moveIn1(p.event.shiftKey ? Infinity : 1));
    this._in1FromBtn.on('pointerover',() => this._in1FromBtn.setStyle({ backgroundColor: '#442211' }));
    this._in1FromBtn.on('pointerout', () => this._in1FromBtn.setStyle({ backgroundColor: '#331a11' }));
    this._in1FromBtn.on('pointerdown',(p) => this._moveIn1Out(p.event.shiftKey ? Infinity : 1));

    // ── Secondary input row (only shown for dual-input furnaces) ─────────────
    const in2Y = this._cy + 20;

    this._in2Row = []; // objects to show/hide as a group

    this._in2Label = this._push(scene.add.text(this._cx - 150, in2Y, 'Coal', {
      fontSize: '13px', color: '#999999',
    }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(26).setVisible(false));
    this._in2Row.push(this._in2Label);

    this._invIn2Count = this._push(scene.add.text(this._cx - 20, in2Y, '0', {
      fontSize: '13px', color: '#ffffff',
    }).setOrigin(1, 0.5).setScrollFactor(0).setDepth(26).setVisible(false));
    this._in2Row.push(this._invIn2Count);

    this._in2ToBtn = this._push(scene.add.text(this._cx + 10, in2Y, '→', {
      fontSize: '16px', color: '#44ff88',
      backgroundColor: '#1a3322', padding: { x: 8, y: 3 },
    }).setOrigin(0.5).setScrollFactor(0).setDepth(26).setVisible(false)
      .setInteractive({ useHandCursor: true }));
    this._in2Row.push(this._in2ToBtn);

    this._in2FromBtn = this._push(scene.add.text(this._cx + 60, in2Y, '←', {
      fontSize: '16px', color: '#ff8844',
      backgroundColor: '#331a11', padding: { x: 8, y: 3 },
    }).setOrigin(0.5).setScrollFactor(0).setDepth(26).setVisible(false)
      .setInteractive({ useHandCursor: true }));
    this._in2Row.push(this._in2FromBtn);

    this._furnaceIn2Count = this._push(scene.add.text(this._cx + 100, in2Y, '0/10', {
      fontSize: '13px', color: '#bbbbaa',
    }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(26).setVisible(false));
    this._in2Row.push(this._furnaceIn2Count);

    this._in2ToBtn.on('pointerover',  () => this._in2ToBtn.setStyle({ backgroundColor: '#225533' }));
    this._in2ToBtn.on('pointerout',   () => this._in2ToBtn.setStyle({ backgroundColor: '#1a3322' }));
    this._in2ToBtn.on('pointerdown',  (p) => this._moveIn2(p.event.shiftKey ? Infinity : 1));
    this._in2FromBtn.on('pointerover',() => this._in2FromBtn.setStyle({ backgroundColor: '#442211' }));
    this._in2FromBtn.on('pointerout', () => this._in2FromBtn.setStyle({ backgroundColor: '#331a11' }));
    this._in2FromBtn.on('pointerdown',(p) => this._moveIn2Out(p.event.shiftKey ? Infinity : 1));

    // ── Smelt status ─────────────────────────────────────────────────────────
    const statusY = this._cy + 75;
    this._smeltStatus = this._push(scene.add.text(this._cx, statusY, '', {
      fontSize: '13px', color: '#ffdd44', align: 'center',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(26).setVisible(false));

    // ── Output bar row ────────────────────────────────────────────────────────
    const barY = this._cy + 120;

    this._outLabel = this._push(scene.add.text(this._cx - 150, barY, 'Iron Bar', {
      fontSize: '13px', color: '#ffcc44',
    }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(26).setVisible(false));

    this._furnaceBarCount = this._push(scene.add.text(this._cx - 20, barY, '0', {
      fontSize: '13px', color: '#aaaaff',
    }).setOrigin(1, 0.5).setScrollFactor(0).setDepth(26).setVisible(false));

    this._barTakeBtn = this._push(scene.add.text(this._cx + 10, barY, '←', {
      fontSize: '16px', color: '#ff8844',
      backgroundColor: '#331a11', padding: { x: 8, y: 3 },
    }).setOrigin(0.5).setScrollFactor(0).setDepth(26).setVisible(false)
      .setInteractive({ useHandCursor: true }));

    this._invBarCount = this._push(scene.add.text(this._cx + 80, barY, '0', {
      fontSize: '13px', color: '#ffffff',
    }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(26).setVisible(false));

    this._barTakeBtn.on('pointerover', () => this._barTakeBtn.setStyle({ backgroundColor: '#442211' }));
    this._barTakeBtn.on('pointerout',  () => this._barTakeBtn.setStyle({ backgroundColor: '#331a11' }));
    this._barTakeBtn.on('pointerdown', (p) => this._takeBar(p.event.shiftKey ? Infinity : 1));

    // Close on click outside
    scene.input.on('pointerdown', (pointer) => {
      if (!this._visible) return;
      const left = this._cx - W / 2, top = this._cy - H / 2;
      if (pointer.x < left || pointer.x > left + W ||
          pointer.y < top  || pointer.y > top  + H) {
        this.hide();
      }
    });

    // Refresh while open
    scene.time.addEvent({
      delay: 100,
      loop: true,
      callback: () => { if (this._visible) this._refresh(); },
    });
  }

  _push(obj) { this._objects.push(obj); return obj; }

  open(furnace) {
    this._furnace = furnace;
    this._applyType();
    this._refresh();
    this.show();
  }

  /** Reconfigure labels and visible rows based on furnace type. */
  _applyType() {
    const f   = this._furnace;
    const cfg = f._cfg;
    const isDual   = !!cfg.input2Key;
    const isWood   = !!cfg.fuelKey;

    // Title
    this._titleText.setText(cfg.label);
    this._titleText.setStyle({ color: cfg.labelColor });
    this._bg.setStrokeStyle(2, _hexNum(cfg.labelColor));

    // Fuel row — only for wood-fired furnaces
    const fuelObjs = [
      this._fuelLabel, this._invWoodCount, this._woodToBtn,
      this._woodFromBtn, this._furnaceWoodCount, this._fuelBarBg, this._fuelBar,
    ];
    fuelObjs.forEach(o => o.setVisible(isWood));

    // Input 1 label
    this._in1Label.setText(cfg.input1Label);

    // Input 2 row — only for dual-input furnaces
    this._in2Row.forEach(o => o.setVisible(isDual));
    if (isDual) this._in2Label.setText(cfg.input2Label);

    // Output label
    this._outLabel.setText(cfg.outputLabel);
    this._outLabel.setStyle({ color: cfg.labelColor });
  }

  _refresh() {
    if (!this._furnace) return;
    const f   = this._furnace;
    const cfg = f._cfg;
    const stored = f.getStored();
    const isDual = !!cfg.input2Key;
    const isWood = !!cfg.fuelKey;

    // Wood fuel
    if (isWood) {
      const woodAmt = stored[cfg.fuelKey] ?? 0;
      this._invWoodCount.setText(String(this._inventory.get(cfg.fuelKey)));
      this._furnaceWoodCount.setText(`${woodAmt}/${cfg.fuelMax}`);
      let fuelFrac = 0;
      if (f._burning) {
        const elapsed = this._scene.time.now - f._burnStart;
        fuelFrac = Math.max(0, 1 - elapsed / WOOD_BURN_MS);
      }
      this._fuelBar.setDisplaySize(Math.round(120 * fuelFrac), 7);
    }

    // Primary input
    const in1Amt = stored[cfg.input1Key] ?? 0;
    this._invIn1Count.setText(String(this._inventory.get(cfg.input1Key)));
    this._furnaceIn1Count.setText(`${in1Amt}/${cfg.input1Max}`);

    // Secondary input
    if (isDual) {
      const in2Amt = stored[cfg.input2Key] ?? 0;
      this._invIn2Count.setText(String(this._inventory.get(cfg.input2Key)));
      this._furnaceIn2Count.setText(`${in2Amt}/${cfg.input2Max}`);
    }

    // Output bars
    const barAmt = stored[cfg.outputKey] ?? 0;
    this._furnaceBarCount.setText(`${barAmt}/${MAX_BARS}`);
    this._invBarCount.setText(String(this._inventory.get(cfg.outputKey)));

    // Status
    this._refreshStatus(f, cfg, stored, barAmt, in1Amt);
  }

  _refreshStatus(f, cfg, stored, barAmt, in1Amt) {
    if (f._smelting) {
      const fuelTxt = f._burning ? '🔥 Smelting…' : '⏸ Waiting for fuel…';
      this._smeltStatus.setText(fuelTxt);
    } else if (barAmt >= MAX_BARS) {
      this._smeltStatus.setText('Output FULL — remove bars');
    } else if (cfg.fuelKey && !f._burning && (stored[cfg.fuelKey] ?? 0) === 0) {
      this._smeltStatus.setText(`No fuel — add ${cfg.fuelKey}`);
    } else if (in1Amt < cfg.input1Req) {
      this._smeltStatus.setText(`Need ${cfg.input1Req - in1Amt} more ${cfg.input1Label}`);
    } else if (cfg.input2Key && (stored[cfg.input2Key] ?? 0) < cfg.input2Req) {
      const have = stored[cfg.input2Key] ?? 0;
      this._smeltStatus.setText(`Need ${cfg.input2Req - have} more ${cfg.input2Label}`);
    } else {
      this._smeltStatus.setText('Ready to smelt');
    }
  }

  // ── Move wood in/out (iron/bronze only) ───────────────────────────────────

  _moveWoodIn(amount) {
    if (!this._furnace) return;
    const cfg   = this._furnace._cfg;
    const have  = this._inventory.get(cfg.fuelKey);
    const space = cfg.fuelMax - this._furnace._wood;
    if (have <= 0 || space <= 0) return;
    const moving = Math.min(have, space, amount === Infinity ? space : amount);
    this._inventory.set(cfg.fuelKey, have - moving);
    this._furnace.addToStorage(cfg.fuelKey, moving);
    this._refresh();
  }

  _moveWoodOut(amount) {
    if (!this._furnace) return;
    const cfg   = this._furnace._cfg;
    const stored = this._furnace._wood;
    if (stored <= 0) return;
    const moving = Math.min(stored, amount === Infinity ? stored : amount);
    this._furnace.removeFromStorage(cfg.fuelKey, moving);
    this._inventory.add(cfg.fuelKey, moving);
    this._refresh();
  }

  // ── Move primary input in/out ─────────────────────────────────────────────

  _moveIn1(amount) {
    if (!this._furnace) return;
    const cfg  = this._furnace._cfg;
    const have = this._inventory.get(cfg.input1Key);
    const space = cfg.input1Max - this._furnace._input1;
    if (have <= 0 || space <= 0 || this._furnace._smelting || this._furnace._bars >= MAX_BARS) return;
    const moving = Math.min(have, space, amount === Infinity ? space : amount);
    this._inventory.set(cfg.input1Key, have - moving);
    this._furnace.addToStorage(cfg.input1Key, moving);
    this._refresh();
  }

  _moveIn1Out(amount) {
    if (!this._furnace) return;
    const cfg   = this._furnace._cfg;
    const stored = this._furnace._input1;
    if (stored <= 0 || this._furnace._smelting) return;
    const moving = Math.min(stored, amount === Infinity ? stored : amount);
    this._furnace.removeFromStorage(cfg.input1Key, moving);
    this._inventory.add(cfg.input1Key, moving);
    this._refresh();
  }

  // ── Move secondary input in/out ───────────────────────────────────────────

  _moveIn2(amount) {
    if (!this._furnace) return;
    const cfg   = this._furnace._cfg;
    if (!cfg.input2Key) return;
    const have  = this._inventory.get(cfg.input2Key);
    const space = cfg.input2Max - this._furnace._input2;
    if (have <= 0 || space <= 0) return;
    const moving = Math.min(have, space, amount === Infinity ? space : amount);
    this._inventory.set(cfg.input2Key, have - moving);
    this._furnace.addToStorage(cfg.input2Key, moving);
    this._refresh();
  }

  _moveIn2Out(amount) {
    if (!this._furnace) return;
    const cfg   = this._furnace._cfg;
    if (!cfg.input2Key) return;
    const stored = this._furnace._input2;
    if (stored <= 0) return;
    const moving = Math.min(stored, amount === Infinity ? stored : amount);
    this._furnace.removeFromStorage(cfg.input2Key, moving);
    this._inventory.add(cfg.input2Key, moving);
    this._refresh();
  }

  // ── Take output bars ──────────────────────────────────────────────────────

  _takeBar(amount) {
    if (!this._furnace) return;
    const cfg    = this._furnace._cfg;
    const stored = this._furnace._bars;
    if (stored <= 0) return;
    const moving = Math.min(stored, amount === Infinity ? stored : amount);
    this._furnace.removeFromStorage(cfg.outputKey, moving);
    this._inventory.add(cfg.outputKey, moving);
    this._refresh();
  }

  show() { this._objects.forEach(o => o.setVisible(true));  this._visible = true;  }
  hide() { this._objects.forEach(o => o.setVisible(false)); this._visible = false; this._furnace = null; }
  isOpen() { return this._visible; }
}

// Parse hex color string like '#aabbcc' to number 0xaabbcc
function _hexNum(str) {
  if (!str) return 0xff9944;
  return parseInt(str.replace('#', ''), 16);
}
