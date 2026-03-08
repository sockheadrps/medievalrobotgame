import { SKILL_DEFS } from '../data/skills.js';

const DEPTH = 52;
const CARD_COLS = 4;
const CARD_W = 84;
const CARD_H = 56;
const CARD_GAP_X = 10;
const CARD_GAP_Y = 8;
const DOUBLE_CLICK_MS = 320;

export class SkillsPanel {
  constructor(scene, skillSystem, inventory, zone) {
    this._scene = scene;
    this._skills = skillSystem;
    this._inventory = inventory;
    this._zone = zone;
    this._visible = false;
    this._activeRecipe = null;
    this._selectedSkill = SKILL_DEFS[0]?.id ?? null;
    this._detailSkillId = null;
    this._lastClick = { skillId: null, at: 0 };
    this._recipeIndexBySkill = {};

    this._objects = [];
    this._cards = {};
    this._detailObjects = [];

    const push = (o) => {
      this._objects.push(o);
      return o;
    };

    const startX = zone.x + 8;
    const startY = zone.y + 8;

    for (let i = 0; i < SKILL_DEFS.length; i++) {
      const skill = SKILL_DEFS[i];
      const col = i % CARD_COLS;
      const row = Math.floor(i / CARD_COLS);
      const x = startX + col * (CARD_W + CARD_GAP_X);
      const y = startY + row * (CARD_H + CARD_GAP_Y);
      const cx = x + CARD_W / 2;
      const cy = y + CARD_H / 2;

      const bg = push(scene.add.rectangle(cx, cy, CARD_W, CARD_H, 0x0f1720, 1)
        .setStrokeStyle(1, 0x2a3b4d)
        .setScrollFactor(0)
        .setDepth(DEPTH + 1)
        .setOrigin(0.5));

      const nameText = push(scene.add.text(cx, y + 10, skill.name, {
        fontSize: '12px',
        color: skill.color ?? '#88ddff',
        align: 'center',
      }).setOrigin(0.5, 0.2).setScrollFactor(0).setDepth(DEPTH + 2));

      const lvlText = push(scene.add.text(cx, cy - 3, 'Lv 1', {
        fontSize: '11px',
        color: '#d9e5f2',
        fontStyle: 'bold',
      }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 2));

      const xpText = push(scene.add.text(cx, y + CARD_H - 10, '0 / 83 XP', {
        fontSize: '10px',
        color: '#7f91a3',
        align: 'center',
      }).setOrigin(0.5, 1).setScrollFactor(0).setDepth(DEPTH + 2));

      const hitZone = push(scene.add.rectangle(cx, cy, CARD_W, CARD_H, 0xffffff, 0)
        .setScrollFactor(0)
        .setDepth(DEPTH + 3)
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true }));

      hitZone.on('pointerover', () => {
        if (skill.id !== this._selectedSkill) bg.setFillStyle(0x152233);
      });
      hitZone.on('pointerout', () => {
        if (skill.id !== this._selectedSkill) bg.setFillStyle(0x0f1720);
      });
      hitZone.on('pointerdown', () => this._onSkillCardClicked(skill.id));

      this._cards[skill.id] = { bg, nameText, lvlText, xpText };
    }

    scene.time.addEvent({
      delay: 100,
      loop: true,
      callback: () => {
        if (this._visible) this._refresh();
      },
    });

    this._setVisible(false);
  }

  show() {
    this._setVisible(true);
    this._visible = true;
    this._syncActiveRecipe();
    this._refresh();
  }

  hide() {
    this._setVisible(false);
    this._visible = false;
  }

  toggle() { this._visible ? this.hide() : this.show(); }
  isOpen() { return this._visible; }
  getActiveRecipe() { return this._activeRecipe; }

  setSkillSystem(skillSystem) {
    this._skills = skillSystem;
    this._syncActiveRecipe();
    if (this._visible) this._refresh();
  }

  setInventory(inventory) {
    this._inventory = inventory;
  }

  _setVisible(v) {
    for (const o of this._objects) o.setVisible(v);
    for (const o of this._detailObjects) o.setVisible(v && this._detailSkillId !== null);
  }

  _refresh() {
    this._refreshCards();
    if (this._detailSkillId) this._renderDetailPage();
  }

  _onSkillCardClicked(skillId) {
    const now = Date.now();
    const isDouble = this._lastClick.skillId === skillId && (now - this._lastClick.at) <= DOUBLE_CLICK_MS;

    this._selectedSkill = skillId;
    this._syncActiveRecipe();
    this._refreshCards();

    if (isDouble) {
      const sk = SKILL_DEFS.find(s => s.id === skillId);
      if (sk?.recipes?.length) {
        this._detailSkillId = skillId;
        this._renderDetailPage();
      }
    }

    this._lastClick = { skillId, at: now };
  }

  _syncActiveRecipe() {
    const sk = SKILL_DEFS.find(s => s.id === this._selectedSkill);
    if (!sk || !sk.recipes || sk.recipes.length === 0) {
      this._activeRecipe = null;
      return;
    }
    const idx = this._recipeIndexBySkill[sk.id] ?? 0;
    const clamped = Math.max(0, Math.min(idx, sk.recipes.length - 1));
    this._recipeIndexBySkill[sk.id] = clamped;
    this._activeRecipe = { skillId: sk.id, recipe: sk.recipes[clamped] };
  }

  _refreshCards() {
    for (const skill of SKILL_DEFS) {
      const card = this._cards[skill.id];
      if (!card) continue;

      const lvl = this._skills.getLevel(skill.id);
      const xp = this._skills.getXP(skill.id);
      const nextLevel = Math.min(99, lvl + 1);
      const nextXpTotal = lvl >= 99 ? this._skills.xpForLevel(99) : this._skills.xpForLevel(nextLevel);

      card.lvlText.setText(`Lv ${lvl}`);
      card.xpText.setText(lvl >= 99 ? 'MAX' : `${xp} / ${nextXpTotal} XP`);

      const selected = skill.id === this._selectedSkill;
      card.bg.setFillStyle(selected ? 0x1e3448 : 0x0f1720);
      card.bg.setStrokeStyle(1, selected ? 0x66b8ff : 0x2a3b4d);
      card.nameText.setColor(selected ? '#ffffff' : (skill.color ?? '#88ddff'));
    }
  }

  _clearDetailObjects() {
    for (const o of this._detailObjects) o.destroy();
    this._detailObjects = [];
  }

  _renderDetailPage() {
    this._clearDetailObjects();
    if (!this._detailSkillId) return;

    const scene = this._scene;
    const z = this._zone;
    const skill = SKILL_DEFS.find(s => s.id === this._detailSkillId);
    if (!skill) return;

    const push = (o) => {
      this._detailObjects.push(o);
      return o;
    };

    // Overlay panel on right tab zone
    push(scene.add.rectangle(z.x + z.w / 2, z.y + z.h / 2, z.w - 8, z.h - 8, 0x0b1320, 0.97)
      .setStrokeStyle(1, 0x35506b)
      .setScrollFactor(0)
      .setDepth(DEPTH + 4));

    push(scene.add.text(z.x + 12, z.y + 10, `${skill.name} Craftables`, {
      fontSize: '13px',
      color: skill.color ?? '#d8b073',
      fontStyle: 'bold',
    }).setScrollFactor(0).setDepth(DEPTH + 5));

    const backBg = push(scene.add.rectangle(z.x + z.w - 58, z.y + 18, 92, 20, 0x1c2d42, 1)
      .setStrokeStyle(1, 0x486d95)
      .setScrollFactor(0)
      .setDepth(DEPTH + 5)
      .setInteractive({ useHandCursor: true }));
    push(scene.add.text(backBg.x, backBg.y, 'Back', {
      fontSize: '10px', color: '#d6e7ff',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 6));
    backBg.on('pointerdown', () => {
      this._detailSkillId = null;
      this._clearDetailObjects();
      this._syncActiveRecipe();
    });

    const recipes = skill.recipes ?? [];
    const selectedIdx = this._recipeIndexBySkill[skill.id] ?? 0;
    let y = z.y + 36;
    const ROW_H = 30;
    const ROW_STEP = 32;
    const LIST_BOTTOM = z.y + z.h - 10;
    for (let i = 0; i < recipes.length; i++) {
      const r = recipes[i];
      const selected = i === selectedIdx;
      const inputs = (r.inputs ?? []).map(inp => `${inp.qty} ${inp.item}`).join(', ');
      const out = `${r.output?.qty ?? 1} ${r.output?.item ?? r.label}`;
      const req = `Lv ${r.levelRequired ?? 1}`;
      const canLevel = this._skills.getLevel(skill.id) >= (r.levelRequired ?? 1);
      if (y + ROW_H > LIST_BOTTOM) break;

      const rowBg = push(scene.add.rectangle(z.x + z.w / 2, y + ROW_H / 2, z.w - 20, ROW_H, selected ? 0x16304a : 0x101f31, 1)
        .setStrokeStyle(1, selected ? 0x67b9ff : 0x2b455f)
        .setScrollFactor(0)
        .setDepth(DEPTH + 5)
        .setInteractive({ useHandCursor: true }));
      rowBg.on('pointerdown', () => {
        this._recipeIndexBySkill[skill.id] = i;
        this._selectedSkill = skill.id;
        this._syncActiveRecipe();
        this._renderDetailPage();
      });

      push(scene.add.text(z.x + 16, y + 9, `${out}  |  ${inputs}`, {
        fontSize: '10px',
        color: selected ? '#ffffff' : '#d7e6f5',
      }).setScrollFactor(0).setDepth(DEPTH + 6));

      push(scene.add.text(z.x + z.w - 16, y + ROW_H / 2, `${req}${canLevel ? '' : ' (locked)'}`, {
        fontSize: '10px',
        color: canLevel ? '#8ff0ae' : '#ff9a9a',
      }).setOrigin(1, 0.5).setScrollFactor(0).setDepth(DEPTH + 6));

      y += ROW_STEP;
    }
  }
}
