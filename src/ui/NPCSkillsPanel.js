// NPCSkillsPanel — read-only view of an NPC's skill levels and XP.
// Opened via right-click → "Inspect Skills" on an NPC.
// Closed with E or clicking outside.

import { SKILL_DEFS } from '../data/skills.js';

const W          = 300;
const HEADER_H   = 50;
const SKILL_H    = 44;
const FOOTER_H   = 30;
const MINI_BAR_W = 180;
const MINI_BAR_H = 4;

export class NPCSkillsPanel {
  constructor(scene) {
    this._scene   = scene;
    this._npc     = null;
    this._visible = false;
    this._objects = [];
    this._rows    = {}; // skillId → { lvlText, miniFill }

    const H  = HEADER_H + SKILL_DEFS.length * SKILL_H + FOOTER_H;
    this._H  = H;

    const cx = scene.cameras.main.width  - W / 2 - 16;
    const cy = scene.cameras.main.height / 2;
    this._cx = cx;
    this._cy = cy;

    // Background
    this._bg = scene.add.rectangle(cx, cy, W, H, 0x0d1b2a, 0.97)
      .setStrokeStyle(2, 0x88ccff)
      .setScrollFactor(0).setDepth(30).setVisible(false);
    this._objects.push(this._bg);

    // Title (updated on open)
    this._title = scene.add.text(cx, cy - H / 2 + 18, 'NPC SKILLS', {
      fontSize: '13px', color: '#88ccff', align: 'center',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(31).setVisible(false);
    this._objects.push(this._title);

    // Footer hint
    this._objects.push(scene.add.text(cx, cy + H / 2 - 12, 'E or click outside to close', {
      fontSize: '10px', color: '#334455', align: 'center',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(31).setVisible(false));

    // Skill rows
    let cursorY = cy - H / 2 + HEADER_H;
    for (const skill of SKILL_DEFS) {
      const midY = cursorY + SKILL_H / 2;

      const rowBg = scene.add.rectangle(cx, midY, W - 16, SKILL_H - 4, 0x0a1822)
        .setScrollFactor(0).setDepth(31).setVisible(false);
      this._objects.push(rowBg);

      const nameText = scene.add.text(cx - W / 2 + 12, midY - 8, skill.name.toUpperCase(), {
        fontSize: '11px', color: skill.color ?? '#88ccff',
      }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(32).setVisible(false);
      this._objects.push(nameText);

      const lvlText = scene.add.text(cx + W / 2 - 12, midY - 8, '', {
        fontSize: '10px', color: '#aaaaaa', align: 'right',
      }).setOrigin(1, 0.5).setScrollFactor(0).setDepth(32).setVisible(false);
      this._objects.push(lvlText);

      // Mini XP bar
      const barX = cx - W / 2 + 12;
      const barY = midY + 8;
      const barBg = scene.add.rectangle(barX + MINI_BAR_W / 2, barY, MINI_BAR_W, MINI_BAR_H, 0x1a2a33)
        .setScrollFactor(0).setDepth(32).setVisible(false);
      this._objects.push(barBg);
      const barFill = scene.add.rectangle(barX, barY, 0, MINI_BAR_H, 0x88ccff)
        .setOrigin(0, 0.5).setScrollFactor(0).setDepth(33).setVisible(false);
      this._objects.push(barFill);

      this._rows[skill.id] = { lvlText, barFill };
      cursorY += SKILL_H;
    }

    // Close on click outside — use pointerup so the open-click doesn't immediately close
    this._openTime = 0;
    scene.input.on('pointerup', (ptr) => {
      if (!this._visible) return;
      if (scene.time.now - this._openTime < 200) return; // ignore the click that opened it
      const left = cx - W / 2, top = cy - H / 2;
      if (ptr.x < left || ptr.x > left + W || ptr.y < top || ptr.y > top + H) {
        this.hide();
      }
    });

    // Refresh loop
    scene.time.addEvent({
      delay: 200,
      loop: true,
      callback: () => { if (this._visible && this._npc) this._refresh(); },
    });
  }

  open(npc) {
    this._npc = npc;
    this._openTime = this._scene.time.now;
    this._title.setText(`${npc._nameLabel?.text ?? npc.id} — Skills`);
    this._refresh();
    this._objects.forEach(o => o.setVisible(true));
    this._visible = true;
  }

  hide() {
    this._objects.forEach(o => o.setVisible(false));
    this._visible = false;
    this._npc     = null;
  }

  isOpen() { return this._visible; }

  _refresh() {
    const skills = this._npc?.skills;
    if (!skills) return;
    for (const skill of SKILL_DEFS) {
      const row = this._rows[skill.id];
      if (!row) continue;
      const lvl    = skills.getLevel(skill.id);
      const xp     = skills.getXP(skill.id);
      const toNext = skills.xpToNextLevel(skill.id);
      const frac   = skills.xpFraction(skill.id);
      row.lvlText.setText(`Lvl ${lvl}  (${xp} XP)`);
      row.barFill.setDisplaySize(Math.round(MINI_BAR_W * frac), MINI_BAR_H);
    }
  }
}
