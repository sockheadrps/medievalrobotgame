import Phaser from 'phaser';
import {
  PLAYER_KEY,
  NPC_KEY,
  SHEET_KEY,
  TILE_SIZE,
} from '../constants.js';

const RIGHT_HUD_MARGIN = 360;
const PLAYER_FRAME_SCALE = 0.7;
const TARGET_FRAME_RELATIVE_TO_PLAYER = 1.2;
const HOTBAR_SLOT_COUNT = 6;

export class HudController {
  constructor(scene) {
    this.scene = scene;
  }

  buildPlayerFrame() {
    const scene = this.scene;
    const s = PLAYER_FRAME_SCALE;
    const x = 10;
    const y = 10;
    const w = Math.round(510 * s);
    const h = Math.round(170 * s);

    scene._pf_bg = scene.addHud(scene.add.rectangle(x + w / 2, y + h / 2, w, h, 0x111122, 0.88)
      .setStrokeStyle(2, 0x334466).setDepth(50));

    const portraitSize = Math.round(96 * s);
    const portraitPad = Math.round(18 * s);
    const portraitX = x + portraitPad + portraitSize / 2;
    const portraitY = y + h / 2;
    scene._pf_portrait = scene.addHud(
      scene.add.sprite(portraitX, portraitY, PLAYER_KEY, 0)
        .setScale(4.2 * s).setDepth(51)
    );
    scene._pf_portraitBorder = scene.addHud(
      scene.add.rectangle(portraitX, portraitY, portraitSize, portraitSize, 0x000000, 0)
        .setStrokeStyle(2, 0x556688).setDepth(51)
    );

    const textX = x + portraitPad + portraitSize + portraitPad;
    scene._pf_name = scene.addHud(scene.add.text(textX, y + 12, '', {
      fontSize: `${Math.round(24 * s)}px`, color: '#ffffff', fontStyle: 'bold',
    }).setDepth(51));
    scene._pf_level = scene.addHud(scene.add.text(x + w - 18, y + 12, '', {
      fontSize: `${Math.round(20 * s)}px`, color: '#aabb99',
    }).setDepth(51).setOrigin(1, 0));

    const barX = textX;
    const barY = y + Math.round(48 * s);
    const barW = w - textX + x - Math.round(20 * s);
    const barH = Math.round(30 * s);
    scene._pf_hpBg = scene.addHud(scene.add.rectangle(barX + barW / 2, barY + barH / 2, barW, barH, 0x331111)
      .setStrokeStyle(1, 0x442222).setDepth(51));
    scene._pf_hpBar = scene.addHud(scene.add.rectangle(barX, barY, barW, barH, 0x44cc44)
      .setOrigin(0, 0).setDepth(52));
    scene._pf_hpText = scene.addHud(scene.add.text(barX + barW / 2, barY + barH / 2, '', {
      fontSize: `${Math.round(20 * s)}px`, color: '#ffffff', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(53));
    scene._pf_barW = barW;
    scene._pf_barH = barH;

    const kiBarY = barY + barH + 2;
    const kiBarH = Math.round(18 * s);
    scene._pf_kiBg = scene.addHud(scene.add.rectangle(barX + barW / 2, kiBarY + kiBarH / 2, barW, kiBarH, 0x111133)
      .setStrokeStyle(1, 0x222244).setDepth(51));
    scene._pf_kiBar = scene.addHud(scene.add.rectangle(barX, kiBarY, barW, kiBarH, 0x4488ff)
      .setOrigin(0, 0).setDepth(52));
    scene._pf_kiText = scene.addHud(scene.add.text(barX + barW / 2, kiBarY + kiBarH / 2, '', {
      fontSize: `${Math.round(16 * s)}px`, color: '#ffffff', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(53));

    scene._pf_stats = scene.addHud(scene.add.text(textX, y + Math.round(100 * s), '', {
      fontSize: `${Math.round(18 * s)}px`, color: '#99aacc',
    }).setDepth(51));
    scene._pf_xp = scene.addHud(scene.add.text(textX, y + Math.round(125 * s), '', {
      fontSize: `${Math.round(18 * s)}px`, color: '#778899',
    }).setDepth(51));
  }

  updatePlayerFrame(playerState) {
    const scene = this.scene;
    const p = playerState ?? scene.player;
    if (!p) return;
    scene._pf_name.setText(p.name ?? scene.playerId ?? 'Player');
    scene._pf_level.setText(`Lv ${p.level}`);

    const hpPct = p.hp / p.maxHp;
    scene._pf_hpBar.setDisplaySize(scene._pf_barW * Math.max(0, hpPct), scene._pf_barH);
    const hpColor = hpPct > 0.5 ? 0x44cc44 : hpPct > 0.25 ? 0xddaa22 : 0xcc3333;
    scene._pf_hpBar.setFillStyle(hpColor);
    scene._pf_hpText.setText(`${p.hp} / ${p.maxHp}`);

    const kiPct = p.maxKi > 0 ? p.ki / p.maxKi : 0;
    scene._pf_kiBar.setDisplaySize(scene._pf_barW * Phaser.Math.Clamp(kiPct, 0, 1), Math.round(18 * PLAYER_FRAME_SCALE));
    const kiColor = kiPct > 0.5 ? 0x4488ff : kiPct > 0.25 ? 0x6644cc : 0x8822aa;
    scene._pf_kiBar.setFillStyle(kiColor);
    scene._pf_kiText.setText(`${scene._formatKiValue(p.ki)} / ${scene._formatKiValue(p.maxKi)}`);

    const crystals = Number(p.crystals ?? 0);
    const copper = Number(p.copper ?? 0);
    let statsLine = `STR: ${p.str}   DEF: ${p.def}   Logs: ${p.logs}   Stone: ${p.stones ?? 0}   Cu: ${copper}   Crystals: ${crystals}`;
    const inv = p.inventory ?? {};
    for (const [itemId, qty] of Object.entries(inv)) {
      if (qty > 0) statsLine += `   ${itemId}: ${qty}`;
    }
    scene._pf_stats.setText(statsLine);
    const kiLv = p.kiSkillLevel ?? 1;
    const kiXpNeeded = kiLv * 20;
    scene._pf_xp.setText(`XP: ${p.xp} / ${p.level * 20}   Ki Lv: ${kiLv} (${p.kiSkillXp ?? 0}/${kiXpNeeded})`);
  }

  buildSensePanel() {
    const scene = this.scene;
    const x = scene._screenWidth() - RIGHT_HUD_MARGIN + 12;
    const y = scene.TOP_HUD_MARGIN ? scene.TOP_HUD_MARGIN + 318 : 190 + 318;
    const w = RIGHT_HUD_MARGIN - 24;
    const h = Math.max(220, scene._screenHeight() - y - 18);
    const els = [];
    const add = (obj) => { scene.addHud(obj); els.push(obj); return obj; };
    const tabHeight = 28;
    const tabWidth = Math.floor((w - 20) / 2);

    scene._sensePanelRect = { x, y, w, h };
    scene._sensePanelBg = add(scene.add.rectangle(x + w / 2, y + h / 2, w, h, 0x0d1222, 0.92)
      .setStrokeStyle(2, 0x2d456c, 0.95).setDepth(50));
    scene._sensePanelTitle = add(scene.add.text(x + 12, y + 10, 'Sense Ki', {
      fontSize: '20px', color: '#dff3ff', fontStyle: 'bold',
    }).setDepth(51));
    scene._sensePanelHint = add(scene.add.text(x + w - 12, y + 14, 'In range only', {
      fontSize: '12px', color: '#7f97b4',
    }).setOrigin(1, 0).setDepth(51));

    scene._senseTabOthersBg = add(scene.add.rectangle(x + 10 + tabWidth / 2, y + 48 + tabHeight / 2, tabWidth, tabHeight, 0x18314b, 1)
      .setOrigin(0.5).setDepth(51).setInteractive({ useHandCursor: true }));
    scene._senseTabOthersLabel = add(scene.add.text(x + 10 + tabWidth / 2, y + 48 + tabHeight / 2, 'Others', {
      fontSize: '13px', color: '#dfefff', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(52).setInteractive({ useHandCursor: true }));
    scene._senseTabMineBg = add(scene.add.rectangle(x + w - 10 - tabWidth / 2, y + 48 + tabHeight / 2, tabWidth, tabHeight, 0x152238, 1)
      .setOrigin(0.5).setDepth(51).setInteractive({ useHandCursor: true }));
    scene._senseTabMineLabel = add(scene.add.text(x + w - 10 - tabWidth / 2, y + 48 + tabHeight / 2, 'My NPCs', {
      fontSize: '13px', color: '#9cb3cd', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(52).setInteractive({ useHandCursor: true }));

    const onTab = (tab) => {
      scene._sensePanelTab = tab;
      scene._sensePanelNextRefreshAt = 0;
      this.updateSensePanel();
    };
    scene._senseTabOthersBg.on('pointerdown', () => onTab('others'));
    scene._senseTabOthersLabel.on('pointerdown', () => onTab('others'));
    scene._senseTabMineBg.on('pointerdown', () => onTab('mine'));
    scene._senseTabMineLabel.on('pointerdown', () => onTab('mine'));

    scene._sensePanelEmpty = add(scene.add.text(x + 12, y + 88, '', {
      fontSize: '14px', color: '#8fa4bb', wordWrap: { width: w - 24 }, lineSpacing: 4,
    }).setDepth(51));
    scene._sensePanelElements = els;
    this.updateSenseTabVisuals();
  }

  clearSensePanelRows() {
    const scene = this.scene;
    for (const row of scene._sensePanelRows || []) row?.destroy?.();
    scene._sensePanelRows = [];
  }

  clearSensePanelActions() {
    const scene = this.scene;
    for (const el of scene._sensePanelActionEls || []) el?.destroy?.();
    scene._sensePanelActionEls = [];
    scene._sensePanelActionPinnedUntil = 0;
  }

  updateSenseTabVisuals() {
    const scene = this.scene;
    const othersActive = scene._sensePanelTab !== 'mine';
    scene._senseTabOthersBg?.setFillStyle(othersActive ? 0x1f4e7a : 0x152238, 1);
    scene._senseTabMineBg?.setFillStyle(othersActive ? 0x152238 : 0x1f4e7a, 1);
    scene._senseTabOthersBg?.setStrokeStyle(othersActive ? 2 : 1, othersActive ? 0x7fd7ff : 0x35506e, 1);
    scene._senseTabMineBg?.setStrokeStyle(othersActive ? 1 : 2, othersActive ? 0x35506e : 0x7fd7ff, 1);
    scene._senseTabOthersLabel?.setColor(othersActive ? '#f4fbff' : '#9cb3cd');
    scene._senseTabMineLabel?.setColor(othersActive ? '#9cb3cd' : '#f4fbff');
  }

  updateSensePanel(now = 0) {
    const scene = this.scene;
    if (!scene._sensePanelBg) return;
    if (now && now < scene._sensePanelNextRefreshAt) return;
    scene._sensePanelNextRefreshAt = Number(now || 0) + 200;
    this.updateSenseTabVisuals();
    this.clearSensePanelRows();
    if (!scene._sensePanelActionPinnedUntil || Date.now() >= scene._sensePanelActionPinnedUntil) {
      this.clearSensePanelActions();
    }

    const observer = scene.player;
    const unlocked = !!observer?.hasKiMove?.('sense_ki');
    if (!unlocked) {
      scene._sensePanelHint?.setText('Unlock Sense Ki');
      scene._sensePanelEmpty?.setText('Learn Sense Ki to track nearby signatures here.');
      return;
    }

    const entries = this.collectSensedEntities(scene._sensePanelTab);
    scene._sensePanelHint?.setText(`${entries.length} sensed`);
    if (!entries.length) {
      scene._sensePanelEmpty?.setText(scene._sensePanelTab === 'mine'
        ? 'None of your NPCs are currently within sensing range.'
        : 'No other players or foreign NPCs are currently within sensing range.');
      return;
    }

    scene._sensePanelEmpty?.setText('');
    const { x, y, w, h } = scene._sensePanelRect;
    const rowHeight = 62;
    const startY = y + 84;
    const maxRows = Math.max(1, Math.floor((h - 94) / rowHeight));
    const visibleEntries = entries.slice(0, maxRows);
    visibleEntries.forEach((entry, index) => {
      const rowY = startY + index * rowHeight;
      this.buildSenseRow(entry, x + 10, rowY, w - 20, rowHeight - 6);
    });
  }

  collectSensedEntities(tab = 'others') {
    const scene = this.scene;
    const observer = scene.player;
    if (!observer?.hasKiMove?.('sense_ki')) return [];
    const info = scene._getActorSenseInfo(observer);
    const entries = [];
    const pushEntry = (entity, kind, own = false) => {
      if (!entity || entity.isDead?.()) return;
      const distPx = Phaser.Math.Distance.Between(observer.x, observer.y, entity.x, entity.y);
      if (distPx > info.range) return;
      entries.push(this.buildSensedEntityEntry(observer, entity, kind, own, distPx));
    };

    if (tab === 'mine') {
      for (const npc of scene.npcs || []) pushEntry(npc, 'npc', true);
    } else {
      for (const rp of Object.values(scene._remotePlayers || {})) pushEntry(rp, 'player', false);
      for (const rnpc of Object.values(scene._remoteNPCSprites || {})) pushEntry(rnpc, 'npc', false);
    }

    return entries.sort((a, b) => a.distanceTiles - b.distanceTiles);
  }

  buildSensedEntityEntry(observer, entity, kind, own, distPx) {
    const scene = this.scene;
    const canDetail = scene._canSenseTargetDetails(observer, entity);
    const canRevealName = canDetail && scene._canRevealTargetName(observer, entity);
    const levelRaw = entity.level ?? entity._level ?? '?';
    const nameRaw = kind === 'player'
      ? (entity.playerId || '')
      : (entity.getName?.() || entity._name || entity.npcId || '');
    const ownerRaw = !own && kind === 'npc' ? (entity.ownerPid || '') : '';
    const label = canRevealName ? nameRaw : (observer.hasKiAugment?.('sense_ki', 'reveal_name') && !canDetail ? '????' : '');
    const levelLabel = canDetail ? `Lv ${levelRaw}` : 'Lv ?????';
    const textureKey = entity.texture?.key || (kind === 'player' ? PLAYER_KEY : NPC_KEY);
    const frame = entity.frame?.name ?? entity.frame?.index ?? 0;
    return {
      entity,
      kind,
      own,
      label,
      levelLabel,
      ownerLabel: ownerRaw,
      distanceTiles: distPx / TILE_SIZE,
      distanceText: `${(distPx / TILE_SIZE).toFixed(1)} tiles`,
      directionText: this.senseDirection(observer.x, observer.y, entity.x, entity.y),
      textureKey,
      frame,
      detailKnown: canDetail,
      targetType: kind === 'player' ? 'player' : 'npc',
      targetOwner: kind === 'npc' && !own ? (entity.ownerPid || null) : null,
      targetId: kind === 'player' ? (entity.playerId || null) : (entity.npcId || entity.id || null),
    };
  }

  buildSenseRow(entry, x, y, w, h) {
    const scene = this.scene;
    const addRow = (obj) => { scene.addHud(obj); scene._sensePanelRows.push(obj); return obj; };
    const isPlayer = entry.kind === 'player';
    const accent = isPlayer ? 0x6bc3ff : entry.own ? 0x79f0ad : 0xff9f7a;
    const textAccent = isPlayer ? '#b9e7ff' : entry.own ? '#9dffd1' : '#ffd1bc';
    const rowBg = addRow(scene.add.rectangle(x + w / 2, y + h / 2, w, h, 0x132034, 0.95)
      .setOrigin(0.5).setStrokeStyle(1, 0x28425f, 0.95).setDepth(51));
    const iconBox = addRow(scene.add.rectangle(x + 22, y + h / 2, 30, 30, 0x0a1222, 1)
      .setStrokeStyle(1, accent, 0.95).setDepth(52));
    const icon = addRow(scene.add.sprite(x + 22, y + h / 2 + 3, entry.textureKey, entry.frame)
      .setScale(0.9).setDepth(53));
    const labelText = entry.label ? `${entry.label}  ${entry.levelLabel}` : `${entry.levelLabel}`;
    const nameText = addRow(scene.add.text(x + 42, y + 8, labelText, {
      fontSize: '13px', color: textAccent, fontStyle: 'bold',
      wordWrap: { width: w - 120 },
    }).setDepth(53));
    addRow(scene.add.text(x + 42, y + 26, `${entry.distanceText} • ${entry.directionText}`, {
      fontSize: '12px', color: '#d9e6f2',
    }).setDepth(53));
    const bottomMeta = entry.detailKnown && entry.ownerLabel
      ? `Owner: ${entry.ownerLabel}`
      : (isPlayer ? 'Player signature' : (entry.own ? 'Your NPC' : 'Foreign NPC'));
    addRow(scene.add.text(x + 42, y + 42, bottomMeta, {
      fontSize: '11px', color: entry.detailKnown ? '#89a6bf' : '#6e8197',
      wordWrap: { width: w - 120 },
    }).setDepth(53));
    addRow(scene.add.text(x + w - 10, y + 8, isPlayer ? 'PLAYER' : 'NPC', {
      fontSize: '10px', color: '#7d92ab', fontStyle: 'bold',
    }).setOrigin(1, 0).setDepth(53));
    [rowBg, iconBox, icon].forEach((obj) => {
      obj.setInteractive?.({ useHandCursor: true });
      obj.on?.('pointerdown', () => this.selectSensedEntity(entry));
    });
    if (entry.label) {
      nameText.setInteractive({ useHandCursor: true });
      nameText.on('pointerdown', (pointer) => {
        pointer.event?.stopPropagation?.();
        this.showSenseEntryActions(entry, x + w - 112, y + 6);
      });
    }
  }

  selectSensedEntity(entry) {
    const scene = this.scene;
    if (!entry?.entity) return;
    if (entry.own && entry.kind === 'npc') {
      scene._selectNPC(entry.entity);
      return;
    }
    scene._selectRemote(entry.entity);
  }

  senseDirection(fromX, fromY, toX, toY) {
    const angle = Phaser.Math.Angle.Normalize(Math.atan2(toY - fromY, toX - fromX));
    const sectors = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
    const index = Math.round(angle / (Math.PI / 4)) & 7;
    return sectors[index];
  }

  showSenseEntryActions(entry, x, y) {
    this.clearSensePanelActions();
    if (!entry?.label) return;
  }

  updateTargetFrame() {
    const scene = this.scene;
    const target = scene._focusedRemote || scene.selectedNPC;

    if (!target || target.isDead?.()) {
      this.hideTargetFrame();
      return;
    }

    if (!scene._targetFrame) this.buildTargetFrame();

    let name = '';
    let hp = 0;
    let maxHp = 1;
    let ki = 0;
    let maxKi = 1;
    let spriteKey = '';
    let frame = 0;
    let extra = '';

    if (target.playerId) {
      name = target.playerId;
      hp = target._hp ?? 0;
      maxHp = target._maxHp ?? 1;
      ki = target._ki ?? 0;
      maxKi = target._maxKi ?? 1;
      spriteKey = PLAYER_KEY;
      extra = `Level: ${target.level ?? target._level ?? '?'}`;
    } else if (target.ownerPid) {
      name = `${target.getName?.()} [${target.ownerPid}]`;
      hp = target.hp ?? 0;
      maxHp = target.maxHp ?? 1;
      ki = target.ki ?? 0;
      maxKi = target.maxKi ?? 1;
      spriteKey = NPC_KEY;
      extra = `STR: ${target.str ?? '?'}  DEF: ${target.def ?? '?'}  Logs: ${target.logs ?? 0}`;
    } else if (target.getName) {
      name = target.getName();
      hp = target.hp ?? 0;
      maxHp = target.maxHp ?? 1;
      ki = target.ki ?? 0;
      maxKi = target.maxKi ?? 1;
      spriteKey = NPC_KEY;
      extra = `STR: ${target.str ?? '?'}  DEF: ${target.def ?? '?'}  Logs: ${target.logs ?? 0}`;
    }

    scene._tf_name.setText(name);
    if (target.isKnockedOut?.()) scene._tf_name.setText(`${name} [KO]`);
    const hpPct = maxHp > 0 ? hp / maxHp : 0;
    scene._tf_hpBar.setDisplaySize(scene._tf_barW * Math.max(0, hpPct), scene._tf_barH);
    const hpColor = hpPct > 0.5 ? 0x44cc44 : hpPct > 0.25 ? 0xddaa22 : 0xcc3333;
    scene._tf_hpBar.setFillStyle(hpColor);
    scene._tf_hpText.setText(`${hp} / ${maxHp}`);

    const kiPctT = maxKi > 0 ? ki / maxKi : 0;
    scene._tf_kiBar.setDisplaySize(scene._tf_barW * Phaser.Math.Clamp(kiPctT, 0, 1), scene._tf_kiBarH);
    const kiColorT = kiPctT > 0.5 ? 0x4488ff : kiPctT > 0.25 ? 0x6644cc : 0x8822aa;
    scene._tf_kiBar.setFillStyle(kiColorT);
    scene._tf_kiText.setText(`${scene._formatKiValue(ki)} / ${scene._formatKiValue(maxKi)}`);

    scene._tf_extra.setText(extra);

    let soulInfo = '';
    if (target.soul && target._getRelationship) {
      const es = target.getEmotionalState(scene.playerId);
      const relLabel = target.getRelationshipLabel?.(scene.playerId) || '?';
      soulInfo = [
        `Feels: ${relLabel}`,
        `Trust ${es.trust.toFixed(2)}   Fear ${es.fear.toFixed(2)}   Anger ${es.anger.toFixed(2)}`,
        `Coop ${target.soul.personality.cooperation.toFixed(2)}   Aggro ${target.soul.personality.aggression.toFixed(2)}`,
      ].join('\n');
    } else if (target._soul) {
      const rel = target._soul[scene.playerId];
      const pers = target._personality;
      if (rel) {
        soulInfo = [
          `Feels: ${rel.label}`,
          `Trust ${rel.trust.toFixed(2)}   Fear ${rel.fear.toFixed(2)}   Anger ${rel.anger.toFixed(2)}`,
        ].join('\n');
        if (pers) soulInfo += `\nCoop ${pers.cooperation.toFixed(2)}   Aggro ${pers.aggression.toFixed(2)}`;
      } else if (pers) {
        soulInfo = `Coop ${pers.cooperation.toFixed(2)}   Aggro ${pers.aggression.toFixed(2)}`;
      }
    }
    scene._tf_soul.setText(soulInfo);

    const soulBottom = soulInfo ? scene._tf_soul.y + scene._tf_soul.height + 4 : scene._tf_extra.y + scene._tf_extra.height + 4;
    scene._tf_hint.setY(soulBottom);
    const baseY = scene._tfBaseY ?? 10;
    const totalH = soulBottom + scene._tf_hint.height + 8 - baseY;
    scene._tf_bg.setSize(scene._tf_bg.width, totalH);
    scene._tf_bg.setPosition(scene._tf_bg.x, baseY + totalH / 2);

    if (scene._tf_portrait.texture.key !== spriteKey) {
      scene._tf_portrait.setTexture(spriteKey, frame);
    }

    const borderColor = target === scene._focusedRemote ? 0xff5555 : 0x44eeff;
    scene._tf_portraitBorder.setStrokeStyle(3, borderColor);
    scene._tf_bg.setStrokeStyle(3, borderColor, 0.95);
    if (target.ownerPid) scene._tf_hint.setText(scene._armedAction === 'attack' ? 'Attack armed - left click a red target' : 'Left click selects, right click opens actions');
    else if (target.playerId) scene._tf_hint.setText(scene._armedAction === 'attack' ? 'Attack armed - left click a red target' : 'Right click opens actions');
    else scene._tf_hint.setText('Left click selects, right click opens actions');

    for (const el of scene._targetFrameElements) el.setVisible(true);
  }

  buildTargetFrame() {
    const scene = this.scene;
    const s = PLAYER_FRAME_SCALE * TARGET_FRAME_RELATIVE_TO_PLAYER;
    const x = scene._screenWidth() - RIGHT_HUD_MARGIN + 12;
    const y = (scene.TOP_HUD_MARGIN ?? 190) + 12;
    const w = RIGHT_HUD_MARGIN - 24;
    const h = Math.round(270 * s);

    const els = [];
    const add = (obj) => { scene.addHud(obj); els.push(obj); return obj; };
    scene._tfBaseY = y;

    scene._tf_bg = add(scene.add.rectangle(x + w / 2, y + h / 2, w, h, 0x111122, 0.88)
      .setStrokeStyle(2, 0x334466).setDepth(50)
      .setInteractive({ useHandCursor: true }));
    scene._tf_bg.on('pointerdown', () => {
      if (scene.selectedNPC && !scene._focusedRemote) scene._openNPCDetail(scene.selectedNPC);
    });

    const portraitSize = Math.round(92 * s);
    const portraitPad = Math.round(16 * s);
    const portraitX = x + portraitPad + portraitSize / 2;
    const portraitY = y + Math.round(78 * s);
    scene._tf_portrait = add(
      scene.add.sprite(portraitX, portraitY, PLAYER_KEY, 0).setScale(3.5 * s).setDepth(51)
    );
    scene._tf_portraitBorder = add(
      scene.add.rectangle(portraitX, portraitY, portraitSize, portraitSize, 0x000000, 0)
        .setStrokeStyle(2, 0x556688).setDepth(51)
    );

    const textX = x + portraitPad + portraitSize + portraitPad;
    const textMaxW = w - (textX - x) - Math.round(18 * s);

    scene._tf_name = add(scene.add.text(textX, y + Math.round(10 * s), '', {
      fontSize: `${Math.round(22 * s)}px`, color: '#ffffff', fontStyle: 'bold',
      wordWrap: { width: textMaxW },
    }).setDepth(51));
    scene._tf_clearBtn = add(scene.add.text(x + w - Math.round(14 * s), y + Math.round(10 * s), '[Clear]', {
      fontSize: `${Math.round(14 * s)}px`, color: '#ff9999', backgroundColor: '#331111bb',
      padding: { x: 6, y: 4 },
    }).setDepth(52).setOrigin(1, 0).setInteractive({ useHandCursor: true }));
    scene._tf_clearBtn.on('pointerdown', (pointer) => {
      pointer.event?.stopPropagation?.();
      scene._clearSelection();
    });
    scene._tf_clearBtn.on('pointerover', () => scene._tf_clearBtn.setColor('#ffffff'));
    scene._tf_clearBtn.on('pointerout', () => scene._tf_clearBtn.setColor('#ff9999'));

    const barX = textX;
    const barY = y + Math.round(46 * s);
    scene._tf_barW = textMaxW;
    scene._tf_barH = Math.round(26 * s);
    scene._tf_hpBg = add(scene.add.rectangle(barX + scene._tf_barW / 2, barY + scene._tf_barH / 2, scene._tf_barW, scene._tf_barH, 0x331111)
      .setStrokeStyle(1, 0x442222).setDepth(51));
    scene._tf_hpBar = add(scene.add.rectangle(barX, barY, scene._tf_barW, scene._tf_barH, 0x44cc44)
      .setOrigin(0, 0).setDepth(52));
    scene._tf_hpText = add(scene.add.text(barX + scene._tf_barW / 2, barY + scene._tf_barH / 2, '', {
      fontSize: `${Math.round(16 * s)}px`, color: '#ffffff', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(53));

    const kiBarY = barY + scene._tf_barH + 2;
    scene._tf_kiBarH = Math.round(14 * s);
    scene._tf_kiBg = add(scene.add.rectangle(barX + scene._tf_barW / 2, kiBarY + scene._tf_kiBarH / 2, scene._tf_barW, scene._tf_kiBarH, 0x111133)
      .setStrokeStyle(1, 0x222244).setDepth(51));
    scene._tf_kiBar = add(scene.add.rectangle(barX, kiBarY, scene._tf_barW, scene._tf_kiBarH, 0x4488ff)
      .setOrigin(0, 0).setDepth(52));
    scene._tf_kiText = add(scene.add.text(barX + scene._tf_barW / 2, kiBarY + scene._tf_kiBarH / 2, '', {
      fontSize: `${Math.round(12 * s)}px`, color: '#ffffff', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(53));

    scene._tf_extra = add(scene.add.text(textX, y + Math.round(100 * s), '', {
      fontSize: `${Math.round(15 * s)}px`, color: '#a8c0df',
      wordWrap: { width: textMaxW },
    }).setDepth(51));

    scene._tf_soul = add(scene.add.text(textX, y + Math.round(136 * s), '', {
      fontSize: `${Math.round(14 * s)}px`, color: '#d2d9f0', lineSpacing: Math.max(2, Math.round(4 * s)),
      wordWrap: { width: textMaxW },
    }).setDepth(51));

    scene._tf_hint = add(scene.add.text(textX, y + Math.round(222 * s), 'Click panel for details · right click world target for actions', {
      fontSize: `${Math.round(13 * s)}px`, color: '#7f8fa8',
    }).setDepth(51));

    scene._targetFrame = true;
    scene._targetFrameElements = els;
  }

  hideTargetFrame() {
    const scene = this.scene;
    if (!scene._targetFrame) return;
    for (const el of scene._targetFrameElements) el.setVisible(false);
  }

  buildHotbar() {
    const scene = this.scene;
    const W = scene._screenWidth();
    const H = scene._screenHeight();
    const slotSize = 72;
    const padding = 6;
    const items = Array.from({ length: HOTBAR_SLOT_COUNT }, (_v, idx) => scene._getHotbarEntry(idx));
    const viewportW = W - RIGHT_HUD_MARGIN;
    const totalW = items.length * (slotSize + padding) - padding;
    const startX = Math.max(12, Math.floor((viewportW - totalW) / 2));
    const bottomMargin = 18;
    const y = H - slotSize - bottomMargin;

    for (const el of scene._hotbarEls) el.destroy();
    scene._hotbarEls = [];
    scene._hotbar = [];
    scene._closeHotbarPicker();

    const add = (obj) => { scene.addHud(obj); scene._hotbarEls.push(obj); return obj; };

    for (let i = 0; i < items.length; i++) {
      const x = startX + i * (slotSize + padding);
      const item = items[i];

      const slotBg = add(scene.add.rectangle(x + slotSize / 2, y + slotSize / 2, slotSize, slotSize, 0x111122, 0.88)
        .setStrokeStyle(1, 0x334466).setDepth(50).setInteractive({ useHandCursor: true }));
      slotBg.on('pointerdown', (ptr) => {
        ptr._fgHandled = true;
        if (ptr.rightButtonDown()) {
          scene._openHotbarPicker(i, x + slotSize / 2, y);
        } else {
          scene._useHotbarSlot(i);
        }
      });

      add(scene.add.image(x + slotSize / 2, y + slotSize / 2, SHEET_KEY, item.frame)
        .setScale(3).setDepth(51));

      add(scene.add.text(x + 4, y + 3, `${i + 1}`, {
        fontSize: '15px', color: '#ffcc44', fontStyle: 'bold',
      }).setDepth(52));

      add(scene.add.text(x + slotSize / 2, y + slotSize - 3, item.label, {
        fontSize: '12px', color: '#aabbcc',
      }).setOrigin(0.5, 1).setDepth(52));

      const countText = add(scene.add.text(x + slotSize - 4, y + 3, '', {
        fontSize: '15px', color: '#ffffff', fontStyle: 'bold',
      }).setOrigin(1, 0).setDepth(52));
      scene._hotbar[i] = { ...item, _countText: countText };
    }
  }

  updateHotbar() {
    const scene = this.scene;
    const p = scene.player;
    if (!p) return;
    const logs = p.logs ?? 0;
    const stones = p.stones ?? 0;

    for (const item of scene._hotbar) {
      if (!item?._countText) continue;
      if (item.id === 'drop_log') item._countText.setText(logs > 0 ? `${logs}` : '');
      else if (item.id === 'drop_stone') item._countText.setText(stones > 0 ? `${stones}` : '');
      else if (item.id === 'place_anvil') item._countText.setText(stones >= 5 ? '1' : '');
      else item._countText.setText('');
    }
  }
}
