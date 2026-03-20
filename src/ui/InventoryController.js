import Phaser from 'phaser';
import {
  FRAME_ANVIL,
  FRAME_CRYSTAL,
  FRAME_ROCK,
  FRAME_CONV_H,
  FRAME_CHEST,
  FRAME_FURNACE,
  FRAME_LOG_CUTTER,
  FRAME_ETRAINER,
  FRAME_TRACK_H,
  FRAME_GATE,
  FRAME_FENCE,
} from '../constants.js';

const TOP_HUD_MARGIN = 133;
const HOTBAR_SLOT_COUNT = 6;
const HOTBAR_STORAGE_KEY = 'futuregame.hotbarAssignments.v1';

const FRAME_SEED = 1355; // tileX=44 tileY=23 — veg sprout

const HOTBAR_ACTIONS = {
  drop_log: { id: 'drop_log', label: 'Log', frame: 526 },
  drop_stone: { id: 'drop_stone', label: 'Stone', frame: FRAME_ROCK },
  place_anvil: { id: 'place_anvil', label: 'Anvil', frame: FRAME_ANVIL },
  use_crystal: { id: 'use_crystal', label: 'Crystal', frame: FRAME_CRYSTAL },
  ki_shot: { id: 'ki_shot', label: 'Ki Shot', frame: FRAME_CRYSTAL },
  absorb: { id: 'absorb', label: 'Absorb', frame: FRAME_CRYSTAL },
  barrier: { id: 'barrier', label: 'Barrier', frame: FRAME_CRYSTAL },
  build_ki_target: { id: 'build_ki_target', label: 'Ki Target', frame: 526 },
  plant_seed: { id: 'plant_seed', label: 'Veg Seed', frame: FRAME_SEED },
  place_conveyor: { id: 'place_conveyor', label: 'Conveyor', frame: FRAME_CONV_H },
  place_crate: { id: 'place_crate', label: 'Crate', frame: FRAME_CHEST },
  place_furnace: { id: 'place_furnace', label: 'Furnace', frame: FRAME_FURNACE },
  place_log_cutter: { id: 'place_log_cutter', label: 'Log Cutter', frame: FRAME_LOG_CUTTER },
  place_etrainer: { id: 'place_etrainer', label: 'Etrainer', frame: FRAME_ETRAINER },
  place_track: { id: 'place_track', label: 'Track', frame: FRAME_TRACK_H },
  place_gate: { id: 'place_gate', label: 'Gate', frame: FRAME_GATE },
  place_fence: { id: 'place_fence', label: 'Fence', frame: FRAME_FENCE },
  empty: { id: 'empty', label: 'Empty', frame: 6 },
};

const HOTBAR_DEFAULT_ASSIGNMENTS = ['drop_log', 'drop_stone', 'place_anvil', 'use_crystal', 'ki_shot', 'barrier'];
const IMPLEMENTED_HOTBAR_MOVES = ['ki_shot', 'absorb', 'barrier'];

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
    const actions = [
      HOTBAR_ACTIONS.drop_log,
      HOTBAR_ACTIONS.drop_stone,
      HOTBAR_ACTIONS.place_anvil,
      HOTBAR_ACTIONS.use_crystal,
      HOTBAR_ACTIONS.ki_shot,
      HOTBAR_ACTIONS.absorb,
      HOTBAR_ACTIONS.barrier,
      HOTBAR_ACTIONS.build_ki_target,
      HOTBAR_ACTIONS.plant_seed,
      HOTBAR_ACTIONS.place_conveyor,
      HOTBAR_ACTIONS.place_crate,
      HOTBAR_ACTIONS.place_furnace,
      HOTBAR_ACTIONS.place_log_cutter,
      HOTBAR_ACTIONS.place_etrainer,
      HOTBAR_ACTIONS.place_track,
      HOTBAR_ACTIONS.place_gate,
      HOTBAR_ACTIONS.place_fence,
      HOTBAR_ACTIONS.empty,
    ];
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
    else if (item.id === 'place_anvil') this.placeAnvil();
    else if (item.id === 'use_crystal') this.useCrystal();
    else if (item.id === 'ki_shot') scene._fireKiBlast();
    else if (item.id === 'absorb') scene._fireAbsorb();
    else if (item.id === 'barrier') scene.chatBox?._addLog(`${item.label} is passive or contextual.`, '#88bbff');
    else if (item.id === 'build_ki_target') this.buildKiTarget();
    else if (item.id === 'plant_seed') this.armPlantSeed();
    else if (item.id === 'place_conveyor') this.toggleConveyorPlacement();
    else if (item.id === 'place_crate') this.toggleCratePlacement();
    else if (item.id === 'place_furnace') this.toggleFurnacePlacement();
    else if (item.id === 'place_log_cutter') this.toggleLogCutterPlacement();
    else if (item.id === 'place_etrainer') this.toggleEtrainerPlacement();
    else if (item.id === 'place_track') this.toggleTrackPlacement();
    else if (item.id === 'place_gate') this.toggleGatePlacement();
    else if (item.id === 'place_fence') this.toggleFencePlacement();
  }

  toggleConveyorPlacement() {
    const scene = this.scene;
    if (!scene._placement) return;
    if (scene._placement.isActive()) {
      scene._placement.cancel();
    } else {
      scene._placement.startPlacing('conveyor');
    }
  }

  toggleCratePlacement() {
    const scene = this.scene;
    if (!scene._placement) return;
    if (scene._placement.isActive()) {
      scene._placement.cancel();
    } else {
      scene._placement.startPlacing('crate');
    }
  }

  toggleFurnacePlacement() {
    const scene = this.scene;
    if (!scene._placement) return;
    if (scene._placement.isActive()) {
      scene._placement.cancel();
    } else {
      scene._placement.startPlacing('furnace');
    }
  }

  toggleLogCutterPlacement() {
    const scene = this.scene;
    if (!scene._placement) return;
    if (scene._placement.isActive()) {
      scene._placement.cancel();
    } else {
      scene._placement.startPlacing('log_cutter');
    }
  }

  toggleEtrainerPlacement() {
    const scene = this.scene;
    if (!scene._placement) return;
    if (scene._placement.isActive()) {
      scene._placement.cancel();
    } else {
      scene._placement.startPlacing('etrainer');
    }
  }

  toggleTrackPlacement() {
    const scene = this.scene;
    if (!scene._placement) return;
    if (scene._placement.isActive()) {
      scene._placement.cancel();
    } else {
      scene._placement.startPlacing('track');
    }
  }

  toggleGatePlacement() {
    const scene = this.scene;
    if (!scene._placement) return;
    if (scene._placement.isActive()) {
      scene._placement.cancel();
    } else {
      scene._placement.startPlacing('gate');
    }
  }

  toggleFencePlacement() {
    const scene = this.scene;
    if (!scene._placement) return;
    if (scene._placement.isActive()) {
      scene._placement.cancel();
    } else {
      scene._placement.startPlacing('fence');
    }
  }

  armPlantSeed() {
    const scene = this.scene;
    const p = scene.player;
    if (!p || scene._playerDead) return;
    if ((p.seeds ?? 0) < 1) {
      scene.chatBox?._addLog('No seeds. Use /give seeds or harvest crops.', '#ff4444');
      return;
    }
    scene._armActionMode('plant_seed');
    scene._armedStatus?.setText('Plant Mode — click a fertile soil tile, Esc to cancel').setVisible(true);
  }

  buildKiTarget() {
    const scene = this.scene;
    const p = scene.player;
    if (!p || scene._playerDead) return;
    if ((p.logs ?? 0) < 5) {
      scene.chatBox?._addLog('Need 5 logs to build a Ki Target.', '#ff4444');
      return;
    }
    scene._conn?.send({ type: 'build_ki_target' });
    scene.chatBox?._addLog('Building Ki Target... (5 logs)', '#66bbff');
  }

  useCrystal() {
    const scene = this.scene;
    const p = scene.player;
    if (!p || scene._playerDead) return;
    const crystals = Number(p.crystals ?? 0);
    if (crystals < 1) {
      scene.chatBox?._addLog('No crystals to use.', '#ff4444');
      return;
    }
    scene._conn?.send({ type: 'consume_crystal' });
    scene.chatBox?._addLog('Using crystal...', '#44eeff');
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
    const crystals = Number(scene.player?.crystals ?? 0);
    const meat = scene.player?.meat ?? 0;
    const feathers = scene.player?.feathers ?? 0;
    const vegetables = scene.player?.vegetables ?? 0;
    const seeds = scene.player?.seeds ?? 0;
    add(scene.add.text(x + 24, y + 52, `Logs: ${logs}     Stone: ${stones}     Crystals: ${crystals}`, { fontSize: '17px', color: '#ccaa77' }).setDepth(61));
    add(scene.add.text(x + 24, y + 74, `Meat: ${meat}     Feathers: ${feathers}     Veg: ${vegetables}     Seeds: ${seeds}`, { fontSize: '17px', color: '#ffaa88' }).setDepth(61));

    // Data-driven inventory items
    const inv = scene.player?.inventory ?? {};
    const invLine = Object.entries(inv).filter(([, q]) => q > 0).map(([id, q]) => `${id}: ${q}`).join('     ');
    if (invLine) {
      add(scene.add.text(x + 24, y + 96, invLine, { fontSize: '17px', color: '#aaccee' }).setDepth(61));
    }

    const craftY = y + (invLine ? 106 : 84);
    add(scene.add.text(x + 24, craftY, 'Crafting:', { fontSize: '17px', color: '#aabbcc', fontStyle: 'bold' }).setDepth(61));

    const canAnvil = stones >= 5;
    const anvilBtn = add(scene.add.text(x + 42, craftY + 30, `[Anvil] - 5 stone ${canAnvil ? '' : '(need more)'}`, {
      fontSize: '16px', color: canAnvil ? '#88bbff' : '#666666', backgroundColor: canAnvil ? '#22334488' : '#11111188', padding: { x: 8, y: 5 },
    }).setDepth(61));
    if (canAnvil) {
      anvilBtn.setInteractive({ useHandCursor: true });
      anvilBtn.on('pointerdown', () => { this.placeAnvil(); this.closeInventory(); });
    }

    const useCrystalEnabled = crystals > 0;
    const crystalBtn = add(scene.add.text(x + 42, craftY + 62, `[Use Crystal] ${useCrystalEnabled ? '' : '(none)'}`, {
      fontSize: '16px', color: useCrystalEnabled ? '#44eeff' : '#666666', backgroundColor: useCrystalEnabled ? '#112233cc' : '#11111188', padding: { x: 8, y: 5 },
    }).setDepth(61));
    if (useCrystalEnabled) {
      crystalBtn.setInteractive({ useHandCursor: true });
      crystalBtn.on('pointerdown', () => { this.useCrystal(); this.closeInventory(); });
    }

    add(scene.add.text(x + 24, craftY + 110, 'Click anvil to refine stone.', {
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
