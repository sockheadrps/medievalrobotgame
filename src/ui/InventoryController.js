import Phaser from 'phaser';
import { API_BASE } from '../config.js';
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
  BLAST_DEFS,
  BLAST_SPRITE_META,
  NRG_KEY,
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
  place_crafting_station: { id: 'place_crafting_station', label: 'Station', frame: FRAME_FURNACE },
  place_etrainer: { id: 'place_etrainer', label: 'Etrainer', frame: FRAME_ETRAINER },
  place_track: { id: 'place_track', label: 'Track', frame: FRAME_TRACK_H },
  place_gate: { id: 'place_gate', label: 'Gate', frame: FRAME_GATE },
  place_fence: { id: 'place_fence', label: 'Fence', frame: FRAME_FENCE },
  empty: { id: 'empty', label: 'Empty', frame: 6 },
};

const HOTBAR_DEFAULT_ASSIGNMENTS = ['ki_shot', 'absorb', 'barrier', 'drop_log', 'drop_stone', 'place_anvil'];
const KI_SLOT_COUNT = 3; // first 3 slots are ki-only

const KI_MOVE_DEFS = {
  ki_shot:  { id: 'ki_shot',  label: 'Ki Shot',  desc: 'Standard ki blast', stats: p => ({ 'Damage': p?.getBlastDmg?.() ?? '?', 'Cost': `${p?.getBlastCost?.() ?? '?'} Ki`, 'Type': 'Projectile' }) },
  absorb:   { id: 'absorb',   label: 'Absorb',   desc: 'Absorb an NPC\'s power', stats: () => ({ 'Cost': 'None', 'Type': 'Channel', 'Effect': 'Absorb target NPC' }) },
  barrier:  { id: 'barrier',  label: 'Barrier',   desc: 'Block incoming attacks', stats: () => ({ 'Block': '10% punch + ki', 'Cost': '3 Ki per proc', 'Type': 'Passive toggle' }) },
};

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
        if (HOTBAR_ACTIONS[actionId] || KI_MOVE_DEFS[actionId] || BLAST_DEFS[actionId]) return actionId;
        return fallback[i] || 'empty';
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
    if (HOTBAR_ACTIONS[actionId]) return HOTBAR_ACTIONS[actionId];
    // Ki moves not in HOTBAR_ACTIONS (scatter_shot, explosive_shot, custom blasts)
    if (KI_MOVE_DEFS[actionId]) return { id: actionId, label: KI_MOVE_DEFS[actionId].label, frame: FRAME_CRYSTAL };
    if (BLAST_DEFS[actionId]) return { id: actionId, label: BLAST_DEFS[actionId].displayName || actionId, frame: FRAME_CRYSTAL };
    return HOTBAR_ACTIONS.empty;
  }

  getAvailableHotbarActions() {
    // Non-ki actions only (ki moves go in slots 1-3 with their own picker)
    return [
      HOTBAR_ACTIONS.drop_log,
      HOTBAR_ACTIONS.drop_stone,
      HOTBAR_ACTIONS.place_anvil,
      HOTBAR_ACTIONS.use_crystal,
      HOTBAR_ACTIONS.build_ki_target,
      HOTBAR_ACTIONS.plant_seed,
      HOTBAR_ACTIONS.place_conveyor,
      HOTBAR_ACTIONS.place_crate,
      HOTBAR_ACTIONS.place_crafting_station,
      HOTBAR_ACTIONS.place_etrainer,
      HOTBAR_ACTIONS.place_track,
      HOTBAR_ACTIONS.place_gate,
      HOTBAR_ACTIONS.place_fence,
      HOTBAR_ACTIONS.empty,
    ];
  }

  /** Get ki moves the player currently knows. */
  getAvailableKiMoves() {
    const p = this.scene.player;
    const moves = [];
    if (p?.hasKiBlast !== false) moves.push(KI_MOVE_DEFS.ki_shot);
    const km = p?.kiMoves || [];
    if (km.includes('absorb')) moves.push(KI_MOVE_DEFS.absorb);
    // Also include custom blasts from BLAST_DEFS
    for (const def of Object.values(BLAST_DEFS)) {
      moves.push({
        id: def.id,
        label: def.displayName || def.id,
        desc: def.description || 'Custom blast',
        stats: () => {
          const s = {};
          if (def.kiCost != null) s['Cost'] = `${def.kiCost} Ki`;
          s['Type'] = 'Projectile';
          const fx = def.effects || {};
          if (fx.burn_dps > 0) s['Burn'] = `${fx.burn_dps}/s for ${fx.burn_duration}s`;
          if (fx.slow_pct > 0) s['Slow'] = `${fx.slow_pct}%`;
          if (fx.stun_duration > 0) s['Stun'] = `${fx.stun_duration}s`;
          if (fx.siphon_pct > 0) s['Siphon'] = `${fx.siphon_pct}%`;
          if (fx.vampiric_pct > 0) s['Vampiric'] = `${fx.vampiric_pct}%`;
          if (fx.pushback > 0) s['Pushback'] = `${fx.pushback}`;
          if (fx.ki_drain > 0) s['Ki Drain'] = `${fx.ki_drain}`;
          if (fx.expose_pct > 0) s['Expose'] = `${fx.expose_pct}% for ${fx.expose_duration}s`;
          if (fx.decay_def > 0) s['Def Decay'] = `${fx.decay_def} for ${fx.decay_duration}s`;
          return s;
        },
      });
    }
    return moves;
  }

  /** Open ki move picker for slots 0-2. */
  openKiMovePicker(slotIndex, centerX, topY) {
    const scene = this.scene;
    if (scene._hotbarPickerSlot === slotIndex) {
      this.closeHotbarPicker();
      return;
    }
    this.closeHotbarPicker();

    // Fetch fresh blast defs
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', `${API_BASE}/api/blasts`, false);
      xhr.send();
      if (xhr.status === 200) {
        for (const def of JSON.parse(xhr.responseText)) BLAST_DEFS[def.id] = def;
      }
    } catch (e) { /* ignore */ }

    const moves = this.getAvailableKiMoves();
    const noneEntry = { id: 'empty', label: '✕  None', desc: '', stats: () => ({}) };
    const km = scene.player?.kiMoves || [];
    const hasBarrier = km.includes('barrier');
    const entries = [noneEntry, ...moves];
    // Barrier is passive — shown as info-only after None
    const barrierEntry = hasBarrier ? KI_MOVE_DEFS.barrier : null;

    const W = scene._screenWidth();
    const rowH = 28;
    const panelW = 180;
    const infoPanelW = 180;
    const totalRows = entries.length + (barrierEntry ? 1 : 0);
    const panelH = 34 + totalRows * rowH;
    const x = Phaser.Math.Clamp(centerX - panelW / 2, 10, W - panelW - infoPanelW - 20);
    const y = Math.max(TOP_HUD_MARGIN + 6, topY - panelH - 8);
    const add = (obj) => { scene.addHud(obj); scene._hotbarPickerEls.push(obj); return obj; };

    add(scene.add.rectangle(x + panelW / 2, y + panelH / 2, panelW, panelH, 0x111827, 0.97)
      .setStrokeStyle(1, 0x4c6d92).setDepth(70));
    add(scene.add.text(x + 10, y + 8, `Ki Slot ${slotIndex + 1}`, {
      fontSize: '13px', color: '#88bbff',
    }).setDepth(71));

    // Info panel elements (shown on hover)
    const infoX = x + panelW + 4;
    const infoH = 140;
    const infoBg = add(scene.add.rectangle(infoX + infoPanelW / 2, y + infoH / 2, infoPanelW, infoH, 0x111827, 0.97)
      .setStrokeStyle(1, 0x4c6d92).setDepth(70).setVisible(false));
    const infoTitle = add(scene.add.text(infoX + 8, y + 8, '', {
      fontSize: '13px', color: '#ffdd66', fontStyle: 'bold',
    }).setDepth(71).setVisible(false));
    const infoDesc = add(scene.add.text(infoX + 8, y + 26, '', {
      fontSize: '11px', color: '#aabbcc', wordWrap: { width: infoPanelW - 16 },
    }).setDepth(71).setVisible(false));
    const infoStats = add(scene.add.text(infoX + 8, y + 44, '', {
      fontSize: '11px', color: '#d7ecff', lineSpacing: 4,
    }).setDepth(71).setVisible(false));

    const showInfo = (entry) => {
      if (!entry || entry.id === 'empty') {
        infoBg.setVisible(false);
        infoTitle.setVisible(false);
        infoDesc.setVisible(false);
        infoStats.setVisible(false);
        return;
      }
      infoTitle.setText(entry.label).setVisible(true);
      infoDesc.setText(entry.desc).setVisible(true);
      const stats = entry.stats(scene.player);
      const lines = Object.entries(stats).map(([k, v]) => `${k}: ${v}`).join('\n');
      infoStats.setText(lines).setVisible(true);
      // Resize info bg to fit content
      const totalH = Math.max(80, 52 + Object.keys(stats).length * 18);
      infoBg.setSize(infoPanelW, totalH)
        .setPosition(infoX + infoPanelW / 2, y + totalH / 2)
        .setVisible(true);
    };

    let rowIdx = 0;
    const currentAssignment = scene._hotbarAssignments?.[slotIndex] || 'empty';

    // Render None entry
    const noneBy = y + 30 + rowIdx * rowH;
    const noneIsActive = 'empty' === currentAssignment;
    const noneBtn = add(scene.add.rectangle(x + panelW / 2, noneBy + rowH / 2, panelW - 8, rowH - 2,
      noneIsActive ? 0x294865 : 0x203246, 1).setStrokeStyle(1, 0x486a8c).setDepth(71).setInteractive({ useHandCursor: true }));
    const noneLbl = add(scene.add.text(x + 12, noneBy + 6, noneEntry.label, {
      fontSize: '12px', color: '#aa7766',
    }).setDepth(72));
    noneBtn.on('pointerover', () => { noneBtn.setFillStyle(0x2e5475); noneLbl.setColor('#ffffff'); });
    noneBtn.on('pointerout', () => { noneBtn.setFillStyle(noneIsActive ? 0x294865 : 0x203246); noneLbl.setColor('#aa7766'); });
    noneBtn.on('pointerdown', () => {
      scene._hotbarAssignments[slotIndex] = 'empty';
      this.saveHotbarAssignments();
      scene._buildHotbar();
      this.closeHotbarPicker();
    });
    rowIdx++;

    // Barrier — sticky disabled info-only row (right after None)
    if (barrierEntry) {
      const bby = y + 30 + rowIdx * rowH;
      const bBtn = add(scene.add.rectangle(x + panelW / 2, bby + rowH / 2, panelW - 8, rowH - 2,
        0x1a1a2a, 1).setStrokeStyle(1, 0x333355).setDepth(71).setInteractive());
      const bLbl = add(scene.add.text(x + 12, bby + 6, `${barrierEntry.label}  (passive)`, {
        fontSize: '11px', color: '#667788',
      }).setDepth(72));
      bBtn.on('pointerover', () => { showInfo(barrierEntry); });
      bBtn.on('pointerout', () => { showInfo(null); });
      rowIdx++;
    }

    // Selectable ki moves (skip None, already rendered above)
    for (let mi = 1; mi < entries.length; mi++) {
      const entry = entries[mi];
      const by = y + 30 + rowIdx * rowH;
      const isActive = entry.id === currentAssignment;
      const btn = add(scene.add.rectangle(x + panelW / 2, by + rowH / 2, panelW - 8, rowH - 2,
        isActive ? 0x294865 : 0x203246, 1).setStrokeStyle(1, 0x486a8c).setDepth(71).setInteractive({ useHandCursor: true }));
      const lbl = add(scene.add.text(x + 12, by + 6, entry.label, {
        fontSize: '12px', color: '#d7ecff',
      }).setDepth(72));
      btn.on('pointerover', () => { btn.setFillStyle(0x2e5475); lbl.setColor('#ffffff'); showInfo(entry); });
      btn.on('pointerout', () => { btn.setFillStyle(isActive ? 0x294865 : 0x203246); lbl.setColor('#d7ecff'); showInfo(null); });
      btn.on('pointerdown', () => {
        scene._hotbarAssignments[slotIndex] = entry.id;
        this.saveHotbarAssignments();
        scene._buildHotbar();
        this.closeHotbarPicker();
      });
      rowIdx++;
    }

    scene._hotbarPickerSlot = slotIndex;
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

    // Ki slots (0-2): dispatch based on ki move ID
    if (index < KI_SLOT_COUNT) {
      const id = item.id;
      if (id === 'empty') return;
      // Set this ki move as the active blast slot (spacebar fires it)
      scene.player.activeBlastId = id;
      scene._conn?.send({ type: 'set_active_blast', blast_id: id });
      scene._inventoryUi?.updateBlastSlot(scene.player);
      return;
    }

    // Action slots (3-5)
    if (item.id === 'drop_log') this.dropLog();
    else if (item.id === 'drop_stone') this.dropStone();
    else if (item.id === 'place_anvil') this.placeAnvil();
    else if (item.id === 'use_crystal') this.useCrystal();
    else if (item.id === 'build_ki_target') this.buildKiTarget();
    else if (item.id === 'plant_seed') this.armPlantSeed();
    else if (item.id === 'place_conveyor') this.toggleConveyorPlacement();
    else if (item.id === 'place_crate') this.toggleCratePlacement();
    else if (item.id === 'place_crafting_station') this.toggleCraftingStationPicker();
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

  async toggleCraftingStationPicker() {
    const scene = this.scene;
    if (!scene._placement) return;
    if (scene._placement.isActive()) {
      scene._placement.cancel();
      return;
    }
    await this._showStationPicker();
  }

  async _showStationPicker() {
    const scene = this.scene;
    if (!this._stationManifest) {
      try {
        const resp = await fetch(`${API_BASE}/api/assets/crafting_stations`);
        this._stationManifest = await resp.json();
      } catch (e) {
        console.warn('Failed to fetch crafting stations:', e);
        return;
      }
    }
    const stations = Object.values(this._stationManifest);
    if (stations.length === 0) return;

    document.getElementById('_stationPickerPanel')?.remove();

    const panel = document.createElement('div');
    panel.id = '_stationPickerPanel';
    panel.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#222;border:1px solid #555;border-radius:6px;padding:12px;z-index:9999;min-width:200px;';
    panel.innerHTML = '<div style="color:#eee;font-size:13px;margin-bottom:8px;">Select Station</div>';

    for (const st of stations) {
      const btn = document.createElement('button');
      btn.style.cssText = 'display:block;width:100%;margin-bottom:4px;padding:6px 10px;background:#333;color:#eee;border:1px solid #666;border-radius:4px;cursor:pointer;text-align:left;';
      const cost = Object.entries(st.build_recipe || {}).map(([k, v]) => `${v}x ${k}`).join(', ');
      btn.innerHTML = `<b>${st.label}</b>${cost ? `<span style="color:#aaa;font-size:11px;margin-left:6px;">(${cost})</span>` : ''}`;
      btn.onclick = () => {
        panel.remove();
        this._selectedStationAssetId = st.id;
        scene._placement.startPlacing('crafting_station');
      };
      panel.appendChild(btn);
    }

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'display:block;width:100%;padding:6px;background:#444;color:#aaa;border:1px solid #555;border-radius:4px;cursor:pointer;margin-top:4px;';
    cancelBtn.onclick = () => panel.remove();
    panel.appendChild(cancelBtn);

    document.body.appendChild(panel);
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

  buildBlastSlot(x, y) {
    const scene = this.scene;
    this._blastSlotX = x;
    this._blastSlotY = y;

    this._blastSlotBg = scene.add.rectangle(x, y, 48, 48, 0x1a1a2e)
      .setStrokeStyle(1, 0x444466).setDepth(30).setScrollFactor(0);
    scene.addHud?.(this._blastSlotBg);

    this._blastSlotSprite = scene.add.sprite(x, y, NRG_KEY, 0)
      .setDepth(31).setScrollFactor(0).setScale(1.5).setVisible(false);
    scene.addHud?.(this._blastSlotSprite);

    this._blastSlotQuestion = scene.add.text(x, y, '?', {
      fontSize: '18px', color: '#555577',
    }).setOrigin(0.5, 0.5).setDepth(31).setScrollFactor(0);
    scene.addHud?.(this._blastSlotQuestion);

    this._blastSlotLabel = scene.add.text(x, y + 26, '', {
      fontSize: '8px', color: '#aaaacc',
    }).setOrigin(0.5, 0.5).setDepth(31).setScrollFactor(0);
    scene.addHud?.(this._blastSlotLabel);

    this._blastSlotBg.setInteractive({ useHandCursor: true });
    this._blastSlotBg.on('pointerdown', () => {
      if (this._pickerEls) { this._closeBlastPicker(); return; }
      this._openBlastPicker();
    });
  }

  updateBlastSlot(player) {
    if (!this._blastSlotBg) return;
    const activeId = player?.activeBlastId;
    const KI_MOVE_LABELS = { ki_shot: 'Ki Shot', absorb: 'Absorb', barrier: 'Barrier' };
    const def = activeId ? BLAST_DEFS[activeId] : null;
    if (def) {
      this._blastSlotLabel.setText(def.displayName || activeId);
      if (def.sprite && this.scene.textures.exists(`blast_${def.sprite}`)) {
        this._blastSlotSprite.setTexture(`blast_${def.sprite}`, 0).setVisible(true);
        this._blastSlotQuestion.setVisible(false);
      } else {
        this._blastSlotSprite.setVisible(false);
        this._blastSlotQuestion.setVisible(true);
      }
    } else if (activeId && KI_MOVE_LABELS[activeId]) {
      this._blastSlotLabel.setText(KI_MOVE_LABELS[activeId]);
      this._blastSlotSprite.setVisible(false);
      this._blastSlotQuestion.setVisible(true);
    } else {
      this._blastSlotSprite.setVisible(false);
      this._blastSlotQuestion.setVisible(true);
      this._blastSlotLabel.setText('');
    }
  }

  _openBlastPicker() {
    this._closeBlastPicker();
    const scene = this.scene;

    // Always fetch fresh blast list synchronously
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', `${API_BASE}/api/blasts`, false);
      xhr.send();
      if (xhr.status === 200) {
        for (const def of JSON.parse(xhr.responseText)) BLAST_DEFS[def.id] = def;
      }
    } catch (e) { /* ignore */ }

    // Build ki move entries from player state
    const player = scene.player;
    const kiMoveEntries = [];
    if (player?.hasKiBlast !== false) {
      kiMoveEntries.push({ id: 'ki_shot', label: 'Ki Shot', sub: '' });
    }
    if (Array.isArray(player?.kiMoves)) {
      if (player.kiMoves.includes('absorb')) kiMoveEntries.push({ id: 'absorb', label: 'Absorb', sub: '' });
      if (player.kiMoves.includes('barrier')) kiMoveEntries.push({ id: 'barrier', label: 'Barrier', sub: '' });
    }

    const blastList = Object.values(BLAST_DEFS);
    const entries = [
      { id: null, label: '✕  None', sub: '' },
      ...kiMoveEntries,
      ...blastList.map(d => ({ id: d.id, label: d.displayName || d.id, sub: d.kiCost != null ? `Ki: ${d.kiCost}` : '' })),
    ];

    const W = scene._screenWidth();
    const slotX = this._blastSlotX ?? 60;
    const slotY = this._blastSlotY ?? 500;
    const rowH = 26;
    const panelW = 200;
    const panelH = 34 + entries.length * rowH;
    const x = Phaser.Math.Clamp(slotX - panelW / 2, 10, W - panelW - 10);
    const y = Math.max(TOP_HUD_MARGIN + 6, slotY - panelH - 8);

    scene._blastPickerEls = scene._blastPickerEls ?? [];
    const add = (obj) => { scene.addHud(obj); scene._blastPickerEls.push(obj); return obj; };

    add(scene.add.rectangle(x + panelW / 2, y + panelH / 2, panelW, panelH, 0x111827, 0.97)
      .setStrokeStyle(1, 0x4c6d92).setDepth(70));
    add(scene.add.text(x + 10, y + 8, 'Select Blast', { fontSize: '13px', color: '#d7ecff' }).setDepth(71));

    entries.forEach((entry, idx) => {
      const by = y + 30 + idx * rowH;
      const isActive = entry.id === scene.player?.activeBlastId;
      const btn = add(scene.add.rectangle(x + panelW / 2, by + rowH / 2, panelW - 8, rowH - 2,
        isActive ? 0x294865 : 0x203246, 1).setStrokeStyle(1, 0x486a8c).setDepth(71).setInteractive({ useHandCursor: true }));
      const lbl = add(scene.add.text(x + 12, by + 6, entry.label + (entry.sub ? `  (${entry.sub})` : ''), {
        fontSize: '12px', color: entry.id === null ? '#aa7766' : '#d7ecff',
      }).setDepth(72));
      btn.on('pointerover', () => { btn.setFillStyle(0x2e5475); lbl.setColor('#ffffff'); });
      btn.on('pointerout', () => { btn.setFillStyle(isActive ? 0x294865 : 0x203246); lbl.setColor(entry.id === null ? '#aa7766' : '#d7ecff'); });
      btn.on('pointerdown', () => {
        scene._conn?.send({ type: 'set_active_blast', blast_id: entry.id });
        if (scene.player) scene.player.activeBlastId = entry.id;
        this.updateBlastSlot(scene.player);
        this._closeBlastPicker();
      });
    });

    this._pickerEls = scene._blastPickerEls;
  }

  _closeBlastPicker() {
    const scene = this.scene;
    if (scene?._blastPickerEls?.length) {
      for (const el of scene._blastPickerEls) el.destroy();
      scene._blastPickerEls = [];
    }
    this._pickerEls = null;
    if (this._pickerCloseHandler) {
      scene.input.off('pointerdown', this._pickerCloseHandler);
      this._pickerCloseHandler = null;
    }
  }
}
