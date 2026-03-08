// CraftingBenchPanel — compact layout for HUD tab zone (916×174).
// Shows crafting bench recipes. Click to select, Space to craft.

import Phaser from 'phaser';
import { BENCH_RECIPES } from '../entities/CraftingBench.js';

const DEPTH      = 52;
const ROW_H      = 34;
const BAR_H      = 6;
const COL_SEL_BG = 0x111100;
const COL_ACT_BG = 0x221a00;

export class CraftingBenchPanel {
  constructor(scene, inventory, zone) {
    this._scene     = scene;
    this._inventory = inventory;
    this._bench     = null;
    this._visible   = false;
    this._objects   = [];
    this._scrollY   = 0;
    this._maxScrollY = 0;

    this._zx = zone.x;
    this._zy = zone.y;
    this._zw = zone.w;
    this._zh = zone.h;

    const push = (o) => { this._objects.push(o); return o; };

    const rpX = zone.x + 4;
    const rpY = zone.y;
    const rpW = zone.w - 8;
    const rpH = zone.h - 24;
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

    // Build recipe rows
    this._recipeRows = [];
    const totalH = BENCH_RECIPES.length * ROW_H;
    this._maxScrollY = Math.max(0, totalH - rpH);

    for (let i = 0; i < BENCH_RECIPES.length; i++) {
      this._recipeRows.push(this._buildRecipeRow(BENCH_RECIPES[i], i));
    }

    // Footer
    const footerY = zone.y + zone.h - 20;
    const barW = rpW - 32;

    this._statusText = push(scene.add.text(rpX + rpW / 2, footerY, 'Open a bench to craft', {
      fontSize: '10px', color: '#556644', align: 'center',
    }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(DEPTH + 2));

    const barY = footerY + 14;
    this._progressBg = push(scene.add.rectangle(rpX + rpW / 2, barY, barW, BAR_H, 0x222200)
      .setScrollFactor(0).setDepth(DEPTH + 2).setOrigin(0.5, 0));
    this._progressFill = push(scene.add.rectangle(rpX + 16, barY, 0, BAR_H, 0xbbaa66)
      .setScrollFactor(0).setDepth(DEPTH + 3).setOrigin(0, 0));
    this._barW = barW;

    scene.time.addEvent({
      delay: 100, loop: true,
      callback: () => { if (this._visible) this._refresh(); },
    });

    this._setVisible(false);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  open(bench) {
    this._bench = bench;
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

  getBench() { return this._bench; }

  // ── Private ─────────────────────────────────────────────────────────────────

  _buildRecipeRow(recipe, index) {
    const scene = this._scene;
    const cx = this._rpX + this._rpW / 2;
    const push = (o) => { this._objects.push(o); return o; };

    const btn = push(scene.add.rectangle(cx, 0, this._rpW - 12, ROW_H - 4, COL_SEL_BG, 1)
      .setStrokeStyle(1, 0x445533)
      .setScrollFactor(0).setDepth(DEPTH + 2).setOrigin(0.5)
      .setInteractive({ useHandCursor: true }).setMask(this._clipMask));

    const labelText = push(scene.add.text(this._rpX + 12, 0, recipe.label, {
      fontSize: '11px', color: '#ccbb88',
    }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(DEPTH + 3).setMask(this._clipMask));

    const costText = push(scene.add.text(this._rpX + 12, 0, '', {
      fontSize: '9px', color: '#776655',
    }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(DEPTH + 3).setMask(this._clipMask));

    const selBar = push(scene.add.rectangle(this._rpX + 6, 0, 3, ROW_H - 10, 0xbbaa66)
      .setScrollFactor(0).setDepth(DEPTH + 3).setOrigin(0.5).setMask(this._clipMask));

    btn.on('pointerover', () => {
      if (this._bench?._activeRecipe !== recipe) btn.setFillStyle(0x1a1a00);
    });
    btn.on('pointerout', () => {
      btn.setFillStyle(this._bench?._activeRecipe === recipe ? COL_ACT_BG : COL_SEL_BG);
    });
    btn.on('pointerdown', () => {
      if (!this._bench) return;
      this._bench.setActiveRecipe(recipe);
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
      const isActive = this._bench?._activeRecipe === row.recipe;
      row.btn.setFillStyle(isActive ? COL_ACT_BG : COL_SEL_BG);
      row.btn.setStrokeStyle(1, isActive ? 0xbbaa66 : 0x445533);
      row.selBar.setVisible(this._visible && isActive);

      const have = this._inventory.get(row.recipe.inputItem);
      const canAfford = have >= row.recipe.inputQty;
      row.labelText.setColor(canAfford ? '#ccbb88' : '#554433');
      row.costText.setText(
        `${row.recipe.inputQty}× ${row.recipe.inputItem} → ${row.recipe.outputQty}× ${row.recipe.outputItem} (${row.recipe.craftMs / 1000}s) [have: ${have}]`
      ).setColor(canAfford ? '#776655' : '#442211');
    }
  }

  _refreshFooter() {
    if (!this._bench) {
      this._statusText.setText('Open a bench to craft').setColor('#556644');
      this._progressBg.setVisible(this._visible);
      this._progressFill.setDisplaySize(0, BAR_H).setVisible(false);
      return;
    }

    const crafting = this._bench.isCrafting();
    const progress = this._bench.getCraftProgress();
    const active   = this._bench._activeRecipe;

    if (crafting) {
      this._statusText.setText(`Crafting… ${Math.round(progress * 100)}%`).setColor('#ffdd88');
    } else if (!active) {
      this._statusText.setText('Select a recipe').setColor('#888866');
    } else {
      const have = this._inventory.get(active.inputItem);
      if (have < active.inputQty) {
        this._statusText.setText(`Need ${active.inputQty}× ${active.inputItem} (have ${have})`).setColor('#ff6666');
      } else {
        this._statusText.setText('Tap Space next to bench to craft').setColor('#88ff88');
      }
    }

    this._progressBg.setVisible(this._visible);
    this._progressFill
      .setDisplaySize(Math.round(this._barW * progress), BAR_H)
      .setVisible(this._visible && crafting);
  }
}
