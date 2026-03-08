// SmithingPanel — compact layout for HUD tab zone (916×174).
// Shows anvil recipes in a scrollable list. Click to select, Space to craft.

import Phaser from 'phaser';
import { ANVIL_RECIPES } from '../entities/Anvil.js';

const DEPTH      = 52;
const ROW_H      = 34;
const BAR_H      = 6;
const COL_SEL_BG = 0x111122;
const COL_ACT_BG = 0x1a2244;

export class SmithingPanel {
  constructor(scene, inventory, zone) {
    this._scene     = scene;
    this._inventory = inventory;
    this._anvil     = null;
    this._visible   = false;
    this._objects   = [];
    this._scrollY   = 0;
    this._maxScrollY = 0;

    // Zone from HUD
    this._zx = zone.x;
    this._zy = zone.y;
    this._zw = zone.w;
    this._zh = zone.h;

    const push = (o) => { this._objects.push(o); return o; };

    // ── Recipe viewport ──────────────────────────────────────────────────────
    const rpX = zone.x + 4;
    const rpY = zone.y;
    const rpW = zone.w - 8;
    const rpH = zone.h - 24;  // leave 24px for footer
    this._rpX = rpX;
    this._rpY = rpY;
    this._rpW = rpW;
    this._rpH = rpH;

    // Clip mask
    this._maskGfx = scene.add.graphics().setScrollFactor(0).setDepth(DEPTH - 1);
    this._maskGfx.fillRect(rpX, rpY, rpW, rpH);
    this._clipMask = this._maskGfx.createGeometryMask();

    // Scroll
    scene.input.on('wheel', (ptr, _go, _dx, dy) => {
      if (!this._visible) return;
      if (ptr.x < rpX || ptr.x > rpX + rpW) return;
      if (ptr.y < rpY || ptr.y > rpY + rpH) return;
      this._scrollY = Phaser.Math.Clamp(this._scrollY + dy * 0.5, 0, this._maxScrollY);
      this._positionRecipes();
    });

    // ── Build recipe rows ────────────────────────────────────────────────────
    this._recipeRows = [];
    const totalH = ANVIL_RECIPES.length * ROW_H;
    this._maxScrollY = Math.max(0, totalH - rpH);

    for (let i = 0; i < ANVIL_RECIPES.length; i++) {
      const recipe = ANVIL_RECIPES[i];
      this._recipeRows.push(this._buildRecipeRow(recipe, i));
    }

    // ── Footer (craft status) ────────────────────────────────────────────────
    const footerY = zone.y + zone.h - 20;
    const barW = rpW - 32;

    this._statusText = push(scene.add.text(rpX + rpW / 2, footerY, 'Open an anvil to smith', {
      fontSize: '10px', color: '#556655', align: 'center',
    }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(DEPTH + 2));

    const barY = footerY + 14;
    this._progressBg = push(scene.add.rectangle(rpX + rpW / 2, barY, barW, BAR_H, 0x112222)
      .setScrollFactor(0).setDepth(DEPTH + 2).setOrigin(0.5, 0));
    this._progressFill = push(scene.add.rectangle(rpX + 16, barY, 0, BAR_H, 0xaaaaff)
      .setScrollFactor(0).setDepth(DEPTH + 3).setOrigin(0, 0));
    this._barW = barW;

    // Refresh loop
    scene.time.addEvent({
      delay: 100, loop: true,
      callback: () => { if (this._visible) this._refresh(); },
    });

    // Start hidden
    this._setVisible(false);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  open(anvil) {
    this._anvil = anvil;
    this._scrollY = 0;
    this._positionRecipes();
  }

  show() {
    this._setVisible(true);
    this._visible = true;
    this._positionRecipes();
    this._refresh();
  }

  hide() {
    this._setVisible(false);
    this._visible = false;
  }

  isOpen()  { return this._visible; }

  getAnvil() { return this._anvil; }

  // ── Private ─────────────────────────────────────────────────────────────────

  _buildRecipeRow(recipe, index) {
    const scene = this._scene;
    const cx = this._rpX + this._rpW / 2;
    const push = (o) => { this._objects.push(o); return o; };

    const btn = push(scene.add.rectangle(cx, 0, this._rpW - 12, ROW_H - 4, COL_SEL_BG, 1)
      .setStrokeStyle(1, 0x334466)
      .setScrollFactor(0).setDepth(DEPTH + 2).setOrigin(0.5)
      .setInteractive({ useHandCursor: true }).setMask(this._clipMask));

    const labelText = push(scene.add.text(this._rpX + 12, 0, recipe.label, {
      fontSize: '11px', color: '#ddddff',
    }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(DEPTH + 3).setMask(this._clipMask));

    const costText = push(scene.add.text(this._rpX + 12, 0, '', {
      fontSize: '9px', color: '#8888aa',
    }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(DEPTH + 3).setMask(this._clipMask));

    const selBar = push(scene.add.rectangle(this._rpX + 6, 0, 3, ROW_H - 10, 0xaaaaff)
      .setScrollFactor(0).setDepth(DEPTH + 3).setOrigin(0.5).setMask(this._clipMask));

    btn.on('pointerover', () => {
      if (this._anvil?._activeRecipe !== recipe) btn.setFillStyle(0x1a1a33);
    });
    btn.on('pointerout', () => {
      btn.setFillStyle(this._anvil?._activeRecipe === recipe ? COL_ACT_BG : COL_SEL_BG);
    });
    btn.on('pointerdown', () => {
      if (!this._anvil) return;
      this._anvil.setActiveRecipe(recipe);
      this._refreshRecipes();
    });

    return { recipe, index, btn, labelText, costText, selBar };
  }

  _positionRecipes() {
    for (const row of this._recipeRows) {
      const baseY = this._rpY + row.index * ROW_H + ROW_H / 2 - this._scrollY;
      row.btn.setY(baseY);
      row.labelText.setY(baseY - ROW_H * 0.2);
      row.costText.setY(baseY + ROW_H * 0.2);
      row.selBar.setY(baseY);
    }
  }

  _setVisible(v) {
    for (const o of this._objects) o.setVisible(v);
  }

  _refresh() {
    this._refreshRecipes();
    this._refreshFooter();
  }

  _refreshRecipes() {
    for (const row of this._recipeRows) {
      const isActive = this._anvil?._activeRecipe === row.recipe;
      row.btn.setFillStyle(isActive ? COL_ACT_BG : COL_SEL_BG);
      row.btn.setStrokeStyle(1, isActive ? 0x8888ff : 0x334466);
      row.selBar.setVisible(this._visible && isActive);

      const have = this._inventory.get(row.recipe.inputItem);
      const canAfford = have >= row.recipe.inputQty;
      row.labelText.setColor(canAfford ? '#ddddff' : '#554455');
      row.costText.setText(
        `${row.recipe.inputQty}× ${row.recipe.inputItem} → ${row.recipe.outputQty}× ${row.recipe.outputItem} (${row.recipe.craftMs / 1000}s) [have: ${have}]`
      ).setColor(canAfford ? '#8888aa' : '#442233');
    }
  }

  _refreshFooter() {
    if (!this._anvil) {
      this._statusText.setText('Open an anvil to smith').setColor('#556655');
      this._progressBg.setVisible(this._visible);
      this._progressFill.setDisplaySize(0, BAR_H).setVisible(false);
      return;
    }

    const crafting = this._anvil.isCrafting();
    const progress = this._anvil.getCraftProgress();
    const active   = this._anvil._activeRecipe;

    if (crafting) {
      this._statusText.setText(`Smithing… ${Math.round(progress * 100)}%`).setColor('#ffdd88');
    } else if (!active) {
      this._statusText.setText('Select a recipe').setColor('#888899');
    } else {
      const have = this._inventory.get(active.inputItem);
      if (have < active.inputQty) {
        this._statusText.setText(`Need ${active.inputQty}× ${active.inputItem} (have ${have})`).setColor('#ff6666');
      } else {
        this._statusText.setText('Tap Space next to anvil to craft').setColor('#88ff88');
      }
    }

    this._progressBg.setVisible(this._visible);
    this._progressFill
      .setDisplaySize(Math.round(this._barW * progress), BAR_H)
      .setVisible(this._visible && crafting);
  }
}
