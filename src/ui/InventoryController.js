import Phaser from 'phaser';
import {
  ARMOR_ELITE_KEY,
  FRAME_ANVIL,
  FRAME_CRYSTAL,
  FRAME_GATE,
  FRAME_ROCK,
  KI_SKILL_MEDITATE_UNLOCK_LEVEL,
  MEDITATION_NORMAL_MS,
  MEDITATION_POOR_MS,
  MEDITATION_PRISTINE_MS,
} from '../constants.js';

const TOP_HUD_MARGIN = 133;
const HOTBAR_SLOT_COUNT = 6;
const HOTBAR_STORAGE_KEY = 'futuregame.hotbarAssignments.v1';

const HOTBAR_ACTIONS = {
  drop_log: { id: 'drop_log', label: 'Log', frame: 526 },
  drop_stone: { id: 'drop_stone', label: 'Stone', frame: FRAME_ROCK },
  place_gate: { id: 'place_gate', label: 'Gate', frame: FRAME_GATE },
  place_anvil: { id: 'place_anvil', label: 'Anvil', frame: FRAME_ANVIL },
  place_ki_shrine: { id: 'place_ki_shrine', label: 'Shrine', frame: FRAME_CRYSTAL },
  ki_shot: { id: 'ki_shot', label: 'Ki Shot', frame: FRAME_CRYSTAL },
  charge: { id: 'charge', label: 'Charge', frame: FRAME_CRYSTAL },
  sense_ki: { id: 'sense_ki', label: 'Sense', frame: FRAME_CRYSTAL },
  barrier: { id: 'barrier', label: 'Barrier', frame: FRAME_CRYSTAL },
  empty: { id: 'empty', label: 'Empty', frame: 6 },
};

const HOTBAR_DEFAULT_ASSIGNMENTS = ['drop_log', 'drop_stone', 'place_gate', 'place_anvil', 'place_ki_shrine', 'ki_shot'];
const IMPLEMENTED_HOTBAR_MOVES = ['ki_shot', 'charge', 'sense_ki', 'barrier'];

export class InventoryController {
  constructor(scene) {
    this.scene = scene;
  }

  openContextMenu(entity, pointer) {
    const scene = this.scene;
    this.closeContextMenu();
    const actions = scene._buildContextActions(entity);
    if (actions.length === 0) return;
    const els = [];
    const add = (obj) => { scene.addHud(obj); els.push(obj); return obj; };
    const rowH = 28;
    const width = 150;
    const height = 10 + actions.length * rowH + 6;
    const W = scene._screenWidth();
    const H = scene._screenHeight();
    const px = Number.isFinite(pointer?.x) ? pointer.x : pointer?.downX;
    const py = Number.isFinite(pointer?.y) ? pointer.y : pointer?.downY;
    const x = Phaser.Math.Clamp((px ?? W / 2) + 10, 12, W - width - 12);
    const y = Phaser.Math.Clamp((py ?? H / 2) + 10, 12, H - height - 12);
    scene._contextMenuBounds = { x, y, width, height };
    add(scene.add.rectangle(x + width / 2, y + height / 2, width, height, 0x111122, 0.96)
      .setStrokeStyle(2, 0x553333).setDepth(70));
    actions.forEach((item, idx) => {
      const by = y + 8 + idx * rowH;
      const btn = add(scene.add.rectangle(x + width / 2, by + 10, width - 12, 22, 0x223344, 1)
        .setDepth(71).setInteractive({ useHandCursor: true }));
      const lbl = add(scene.add.text(x + 12, by + 3, item.label, {
        fontSize: '15px', color: '#dde8ff',
      }).setDepth(72));
      btn.on('pointerover', () => btn.setFillStyle(0x335566));
      btn.on('pointerout', () => btn.setFillStyle(0x223344));
      btn.on('pointerdown', () => {
        this.closeContextMenu();
        item.action();
      });
    });
    scene._contextMenuEls = els;
  }

  closeContextMenu() {
    const scene = this.scene;
    scene._contextMenuBounds = null;
    if (!scene._contextMenuEls) return;
    for (const el of scene._contextMenuEls) {
      scene.removeHud?.(el);
      el.destroy();
    }
    scene._contextMenuEls = null;
  }

  isPointerOverContextMenu(ptr) {
    const { _contextMenuBounds: bounds } = this.scene;
    if (!bounds) return false;
    const { x, y, width, height } = bounds;
    return ptr.x >= x && ptr.x <= x + width && ptr.y >= y && ptr.y <= y + height;
  }

  loadHotbarAssignments() {
    const fallback = [...HOTBAR_DEFAULT_ASSIGNMENTS];
    while (fallback.length < HOTBAR_SLOT_COUNT) fallback.push('empty');
    try {
      const raw = window.localStorage?.getItem(HOTBAR_STORAGE_KEY);
      if (!raw) return fallback.slice(0, HOTBAR_SLOT_COUNT);
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return fallback.slice(0, HOTBAR_SLOT_COUNT);
      return Array.from({ length: HOTBAR_SLOT_COUNT }, (_v, i) => {
        const actionId = String(parsed[i] || fallback[i] || 'empty');
        return HOTBAR_ACTIONS[actionId] ? actionId : (fallback[i] || 'empty');
      });
    } catch {
      return fallback.slice(0, HOTBAR_SLOT_COUNT);
    }
  }

  saveHotbarAssignments() {
    try {
      window.localStorage?.setItem(HOTBAR_STORAGE_KEY, JSON.stringify(this.scene._hotbarAssignments || []));
    } catch {
      // ignore
    }
  }

  getHotbarEntry(slotIndex) {
    const actionId = this.scene._hotbarAssignments?.[slotIndex] || 'empty';
    return HOTBAR_ACTIONS[actionId] || HOTBAR_ACTIONS.empty;
  }

  getAvailableHotbarActions() {
    const scene = this.scene;
    const actions = [
      HOTBAR_ACTIONS.drop_log,
      HOTBAR_ACTIONS.drop_stone,
      HOTBAR_ACTIONS.place_gate,
      HOTBAR_ACTIONS.place_anvil,
      HOTBAR_ACTIONS.place_ki_shrine,
      HOTBAR_ACTIONS.empty,
    ];
    const learned = new Set(scene.player?.kiMoves || []);
    learned.add('ki_shot');
    for (const moveId of IMPLEMENTED_HOTBAR_MOVES) {
      if (!learned.has(moveId)) continue;
      const action = HOTBAR_ACTIONS[moveId];
      if (action && !actions.includes(action)) actions.push(action);
    }
    return actions;
  }

  closeHotbarPicker() {
    const scene = this.scene;
    if (scene._hotbarPickerEls?.length) {
      for (const el of scene._hotbarPickerEls) {
        scene.removeHud(el);
        el.destroy();
      }
    }
    scene._hotbarPickerEls = [];
    scene._hotbarPickerSlot = null;
  }

  openHotbarPicker(slotIndex, centerX, topY) {
    const scene = this.scene;
    if (scene._hotbarPickerSlot === slotIndex) {
      this.closeHotbarPicker();
      return;
    }
    this.closeHotbarPicker();
    const W = scene._screenWidth();
    const actions = this.getAvailableHotbarActions();
    const cols = 2;
    const rowH = 26;
    const panelW = 210;
    const panelH = 34 + Math.ceil(actions.length / cols) * rowH;
    const x = Phaser.Math.Clamp(centerX - panelW / 2, 10, W - panelW - 10);
    const y = Math.max(TOP_HUD_MARGIN + 6, topY - panelH - 8);
    const add = (obj) => { scene.addHud(obj); scene._hotbarPickerEls.push(obj); return obj; };
    add(scene.add.rectangle(x + panelW / 2, y + panelH / 2, panelW, panelH, 0x111827, 0.97)
      .setStrokeStyle(1, 0x4c6d92).setDepth(70));
    add(scene.add.text(x + 10, y + 8, `Assign Slot ${slotIndex + 1}`, {
      fontSize: '14px', color: '#d7ecff',
    }).setDepth(71));
    actions.forEach((action, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const bx = x + 10 + col * 96;
      const by = y + 30 + row * rowH;
      const btn = add(scene.add.rectangle(bx + 44, by + 10, 88, 20, 0x203246, 1)
        .setStrokeStyle(1, 0x486a8c).setDepth(71).setOrigin(0.5, 0.5).setInteractive({ useHandCursor: true }));
      const txt = add(scene.add.text(bx + 44, by + 10, action.label, {
        fontSize: '12px', color: '#d7ecff',
      }).setOrigin(0.5).setDepth(72));
      btn.on('pointerover', () => { btn.setFillStyle(0x294865); txt.setColor('#ffffff'); });
      btn.on('pointerout', () => { btn.setFillStyle(0x203246); txt.setColor('#d7ecff'); });
      btn.on('pointerdown', () => {
        scene._hotbarAssignments[slotIndex] = action.id;
        this.saveHotbarAssignments();
        scene._buildHotbar();
        this.closeHotbarPicker();
      });
    });
    scene._hotbarPickerSlot = slotIndex;
  }

  useHotbarSlot(index) {
    const scene = this.scene;
    const item = this.getHotbarEntry(index);
    if (!item) return;
    if (item.id === 'drop_log') this.dropLog();
    else if (item.id === 'drop_stone') this.dropStone();
    else if (item.id === 'place_gate') this.placeGate();
    else if (item.id === 'place_anvil') this.placeAnvil();
    else if (item.id === 'place_ki_shrine') this.placeKiShrine();
    else if (item.id === 'ki_shot') scene._fireKiBlast();
    else if (item.id === 'charge') this.toggleCharge();
    else if (item.id === 'sense_ki' || item.id === 'barrier') scene.chatBox?._addLog(`${item.label} is passive or contextual.`, '#88bbff');
  }

  toggleCharge() {
    const scene = this.scene;
    const p = scene.player;
    const conn = scene._conn;
    if (!p || scene._playerDead || p._knockedOut || p.meditating || !conn?.connected) return;
    if (!(p.kiMoves || []).includes('charge')) {
      scene.chatBox?._addLog('Charge is not unlocked yet.', '#88bbff');
      return;
    }
    conn.send({ type: 'toggle_charge' });
    scene.chatBox?._addLog(p.charging ? 'Charge released.' : 'Charging aura...', '#88ddff');
  }

  dropLog() {
    const scene = this.scene;
    const p = scene.player;
    if (!p || scene._playerDead) return;
    if ((p.logs ?? 0) < 1) {
      scene.chatBox?._addLog('No logs to drop.', '#ff4444');
      return;
    }
    scene._conn?.send({ type: 'drop_item', item: 'log', amount: 1 });
  }

  dropStone() {
    const scene = this.scene;
    const p = scene.player;
    if (!p || scene._playerDead) return;
    if ((p.stones ?? 0) < 1) {
      scene.chatBox?._addLog('No stone to drop.', '#ff4444');
      return;
    }
    scene._conn?.send({ type: 'drop_item', item: 'stone', amount: 1 });
  }

  placeGate() {
    const scene = this.scene;
    const p = scene.player;
    if (!p || scene._playerDead) return;
    if ((p.logs ?? 0) < 10) {
      scene.chatBox?._addLog('Need 10 logs to build a gate.', '#ff4444');
      return;
    }
    if (scene._conn?.connected) {
      scene._conn.send({ type: 'build_gate' });
      scene.chatBox?._addLog('Building fence gate...', '#88bbff');
    }
  }

  placeAnvil() {
    const scene = this.scene;
    const p = scene.player;
    if (!p || scene._playerDead) return;
    if ((p.stones ?? 0) < 5) {
      scene.chatBox?._addLog('Need 5 stone to build an anvil.', '#ff4444');
      return;
    }
    if (scene._conn?.connected) {
      scene._conn.send({ type: 'build_anvil' });
      scene.chatBox?._addLog('Placing anvil...', '#88bbff');
    }
  }

  placeKiShrine() {
    const scene = this.scene;
    if (!scene._conn?.connected || scene._playerDead) return;
    scene._conn.send({ type: 'build_ki_shrine' });
    scene.chatBox?._addLog('Placing ki shrine...', '#88ddff');
  }

  toggleInventory() {
    if (this.scene._inventoryOpen) this.closeInventory();
    else this.openInventory();
  }

  openInventory() {
    const scene = this.scene;
    scene._inventoryOpen = true;
    const W = scene._screenWidth();
    const H = scene._screenHeight();
    const panelW = 420;
    const panelH = 480;
    const x = Math.floor(W / 2 - panelW / 2);
    const y = Math.floor(H / 2 - panelH / 2);
    const conn = scene._conn;
    const add = (obj) => { scene.addHud(obj); scene._inventoryEls.push(obj); return obj; };

    add(scene.add.rectangle(W / 2, H / 2, panelW, panelH, 0x111122, 0.95).setStrokeStyle(2, 0x334466).setDepth(60));
    add(scene.add.text(W / 2, y + 16, 'Inventory [I]', {
      fontSize: '20px', color: '#ffcc44', fontStyle: 'bold',
    }).setOrigin(0.5, 0).setDepth(61));

    const logs = scene.player?.logs ?? 0;
    const stones = scene.player?.stones ?? 0;
    add(scene.add.text(x + 24, y + 52, `Logs: ${logs}     Stone: ${stones}`, { fontSize: '17px', color: '#ccaa77' }).setDepth(61));

    const bastalite = scene.player?.bastalite ?? 0;
    const cPristine = scene.player?.crystalPristine ?? 0;
    const cNormal = scene.player?.crystalNormal ?? 0;
    const cPoor = scene.player?.crystalPoor ?? 0;
    const realmCrystalT1 = scene.player?.realmCrystalT1 ?? 0;
    const canMeditate = scene.player?.canMeditate?.();
    const hasMats = bastalite > 0 || cPristine > 0 || cNormal > 0 || cPoor > 0 || realmCrystalT1 > 0;
    if (hasMats) {
      const parts = [];
      if (bastalite > 0) parts.push(`Bastalite: ${bastalite}`);
      if (cPristine > 0) parts.push(`Pristine Crystal: ${cPristine}`);
      if (cNormal > 0) parts.push(`Ki Crystal: ${cNormal}`);
      if (cPoor > 0) parts.push(`Cracked Crystal: ${cPoor}`);
      if (realmCrystalT1 > 0) parts.push(`Realm Crystal T1: ${realmCrystalT1}`);
      add(scene.add.text(x + 24, y + 74, parts.join('  '), {
        fontSize: '15px', color: '#44eeff', wordWrap: { width: panelW - 48 },
      }).setDepth(61));
    }

    const matOffset = hasMats ? 16 : 0;
    add(scene.add.text(x + 24, y + 84 + matOffset, 'Equipment:', {
      fontSize: '17px', color: '#aabbcc', fontStyle: 'bold',
    }).setDepth(61));

    const p = scene.player;
    const hasArmorEquipped = !!p?.armorElite;
    const hasArmorInv = !!p?.armorEliteInv;
    const hasArmor = hasArmorEquipped || hasArmorInv;
    if (hasArmor) {
      const rowY = y + 112 + matOffset;
      const itemBg = add(scene.add.rectangle(W / 2, rowY + 16, panelW - 48, 36, 0x1a1a33, 0.9)
        .setStrokeStyle(1, hasArmorEquipped ? 0x44eeff : 0x334466).setDepth(61));
      add(scene.add.sprite(x + 42, rowY + 16, ARMOR_ELITE_KEY, 0).setScale(0.9).setDepth(62));
      add(scene.add.text(x + 66, rowY + 6, `Elite Armor  ${hasArmorEquipped ? '[Equipped]' : '[In Bag]'}`, {
        fontSize: '15px', color: hasArmorEquipped ? '#44eeff' : '#888899',
      }).setDepth(62));

      const actionBtn = add(scene.add.text(x + panelW - 48, rowY + 6, hasArmorEquipped ? 'Click: Unequip' : 'Click: Equip', {
        fontSize: '13px', color: '#88bbff', backgroundColor: '#22334488', padding: { x: 6, y: 4 },
      }).setOrigin(1, 0).setDepth(62));
      actionBtn.setInteractive({ useHandCursor: true });
      actionBtn.on('pointerdown', (ptr) => {
        if (ptr.rightButtonDown()) return;
        conn?.send({ type: hasArmorEquipped ? 'unequip_armor' : 'equip_armor' });
        this.closeInventory();
        scene.time.delayedCall(100, () => { if (!scene._inventoryOpen) this.openInventory(); });
      });

      itemBg.setInteractive({ useHandCursor: true });
      itemBg.on('pointerdown', (ptr) => {
        if (!ptr.rightButtonDown()) return;
        this.closeInvContextMenu();
        const mx = ptr.x;
        const my = ptr.y;
        const cmBg = scene.add.rectangle(mx + 60, my + 15, 120, 30, 0x1a1a2e, 0.95)
          .setStrokeStyle(1, 0xff5555).setDepth(72).setScrollFactor(0);
        scene.addHud(cmBg);
        const dropBtn = scene.add.text(mx + 8, my + 5, 'Drop Armor', {
          fontSize: '14px', color: '#ff6666',
        }).setDepth(73).setScrollFactor(0);
        scene.addHud(dropBtn);
        dropBtn.setInteractive({ useHandCursor: true });
        dropBtn.on('pointerdown', () => {
          conn?.send({ type: 'drop_armor' });
          this.closeInvContextMenu();
          this.closeInventory();
        });
        scene._invContextEls = [cmBg, dropBtn];
      });
    } else {
      add(scene.add.text(x + 42, y + 118 + matOffset, '(no equipment)', { fontSize: '15px', color: '#556677' }).setDepth(61));
    }

    const craftY = y + 165 + matOffset;
    add(scene.add.text(x + 24, craftY, 'Crafting:', { fontSize: '17px', color: '#aabbcc', fontStyle: 'bold' }).setDepth(61));
    const canGate = logs >= 10;
    const gateBtn = add(scene.add.text(x + 42, craftY + 30, `[Gate] - 10 logs ${canGate ? '' : '(need more)'}`, {
      fontSize: '16px', color: canGate ? '#88bbff' : '#666666', backgroundColor: canGate ? '#22334488' : '#11111188', padding: { x: 8, y: 5 },
    }).setDepth(61));
    if (canGate) {
      gateBtn.setInteractive({ useHandCursor: true });
      gateBtn.on('pointerdown', () => { this.placeGate(); this.closeInventory(); });
    }

    const canAnvil = stones >= 5;
    const anvilBtn = add(scene.add.text(x + 42, craftY + 62, `[Anvil] - 5 stone ${canAnvil ? '' : '(need more)'}`, {
      fontSize: '16px', color: canAnvil ? '#88bbff' : '#666666', backgroundColor: canAnvil ? '#22334488' : '#11111188', padding: { x: 8, y: 5 },
    }).setDepth(61));
    if (canAnvil) {
      anvilBtn.setInteractive({ useHandCursor: true });
      anvilBtn.on('pointerdown', () => { this.placeAnvil(); this.closeInventory(); });
    }

    const meditateY = craftY + 102;
    add(scene.add.text(x + 24, meditateY, 'Meditation:', { fontSize: '17px', color: '#aabbcc', fontStyle: 'bold' }).setDepth(61));
    add(scene.add.text(x + 42, meditateY + 22,
      canMeditate
        ? `Unlocks realm insight. Poor ${Math.round(MEDITATION_POOR_MS / 1000)}s, Ki ${Math.round(MEDITATION_NORMAL_MS / 1000)}s, Pristine ${Math.round(MEDITATION_PRISTINE_MS / 1000)}s.`
        : `Locked until Ki Skill ${KI_SKILL_MEDITATE_UNLOCK_LEVEL}.`, {
        fontSize: '13px', color: canMeditate ? '#7799aa' : '#666666', wordWrap: { width: panelW - 80 },
      }).setDepth(61));
    [
      { label: '[Meditate - Cracked Crystal]', quality: 'poor', count: cPoor, color: '#88bbff', y: meditateY + 52 },
      { label: '[Meditate - Ki Crystal]', quality: 'normal', count: cNormal, color: '#66ddff', y: meditateY + 84 },
      { label: '[Meditate - Pristine Crystal]', quality: 'pristine', count: cPristine, color: '#99ffff', y: meditateY + 116 },
    ].forEach((entry) => {
      const enabled = canMeditate && entry.count > 0 && !scene.player?.meditating;
      const btn = add(scene.add.text(x + 42, entry.y, `${entry.label} ${enabled ? '' : `(x${entry.count})`}`, {
        fontSize: '14px', color: enabled ? entry.color : '#666666',
        backgroundColor: enabled ? '#112233cc' : '#111111aa', padding: { x: 8, y: 4 },
      }).setDepth(62));
      if (!enabled) return;
      btn.setInteractive({ useHandCursor: true });
      btn.on('pointerdown', () => {
        conn?.send({ type: 'start_meditation', crystal_quality: entry.quality });
        this.closeInventory();
      });
    });
    add(scene.add.text(x + 24, craftY + 252, 'Click anvil to refine stone.\nDrop logs for fences, gates.', {
      fontSize: '14px', color: '#667788', wordWrap: { width: panelW - 60 },
    }).setDepth(61));
    add(scene.add.text(W / 2, y + panelH - 16, 'Press I to close', {
      fontSize: '14px', color: '#556677',
    }).setOrigin(0.5, 1).setDepth(61));
  }

  closeInvContextMenu() {
    const scene = this.scene;
    if (scene._invContextEls) {
      for (const el of scene._invContextEls) el.destroy();
      scene._invContextEls = null;
    }
  }

  closeInventory() {
    const scene = this.scene;
    scene._inventoryOpen = false;
    this.closeInvContextMenu();
    for (const el of scene._inventoryEls) el.destroy();
    scene._inventoryEls = [];
  }
}
