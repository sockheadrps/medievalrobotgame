// SkillSystem — tracks skill XP/levels and executes timed skill crafting.
//
// Skill definitions live in src/data/skills.js.
// XP curve lives in src/systems/XPTable.js (RS-inspired, ~1.5M XP at 99).
//
// API:
//   ss.getSkills()                              → SKILL_DEFS array
//   ss.getSkill(id)                             → single skill def or null
//   ss.getLevel(skillId)                        → current level (1-99)
//   ss.getXP(skillId)                           → raw total XP
//   ss.xpForLevel(n)                            → XP required to reach level n
//   ss.xpToNextLevel(skillId)                   → XP remaining to next level
//   ss.xpFraction(skillId)                      → 0-1 progress within current level
//   ss.awardXP(skillId, amount, scene)          → grant XP externally (tree chop, kill, etc.)
//   ss.canCraft(skillId, recipeId)              → bool (level check only, not inventory)
//   ss.startCraft(skillId, recipeId, scene, inventory, onComplete) → true if started
//   ss.isCrafting()                             → bool
//   ss.getCraftProgress(now)                    → 0-1
//   ss.getActiveCraft()                         → { skill, recipe } or null
//   ss.on('xp-gained', fn)  — { skillId, xp, totalXP, level }
//   ss.on('level-up',  fn)  — { skillId, level }

import Phaser from 'phaser';
import { SKILL_DEFS } from '../data/skills.js';
import {
  xpToLevel,
  xpForLevel as _xpForLevel,
  xpToNext,
  xpFraction as _xpFraction,
} from './XPTable.js';

// Re-export for panels that import SKILLS from SkillSystem
export { SKILL_DEFS as SKILLS };

export class SkillSystem extends Phaser.Events.EventEmitter {
  constructor() {
    super();
    // XP map: skillId → total XP accumulated
    this._xp = {};
    for (const s of SKILL_DEFS) this._xp[s.id] = 0;

    this._crafting = false;
    this._craftStart = 0;
    this._craftMs = 0;
    this._craftRecipe = null;
    this._craftSkill = null;
    this._craftTimer = null;
    this._inventory = null;
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  getSkills() {
    return SKILL_DEFS;
  }
  getSkill(id) {
    return SKILL_DEFS.find((s) => s.id === id) ?? null;
  }
  getXP(skillId) {
    return this._xp[skillId] ?? 0;
  }
  getLevel(skillId) {
    return xpToLevel(this.getXP(skillId));
  }
  xpForLevel(n) {
    return _xpForLevel(n);
  }
  xpToNextLevel(sid) {
    return xpToNext(this.getXP(sid));
  }
  xpFraction(sid) {
    return _xpFraction(this.getXP(sid));
  }

  isCrafting() {
    return this._crafting;
  }

  getCraftProgress(now) {
    if (!this._crafting || !this._craftMs) return 0;
    return Math.min(1, (now - this._craftStart) / this._craftMs);
  }

  getActiveCraft() {
    return this._crafting
      ? { skill: this._craftSkill, recipe: this._craftRecipe }
      : null;
  }

  /** True if the player/NPC has high enough level to use this recipe. */
  canCraft(skillId, recipeId) {
    const skill = this.getSkill(skillId);
    const recipe = skill?.recipes.find((r) => r.id === recipeId);
    if (!recipe) return false;
    return this.getLevel(skillId) >= (recipe.levelRequired ?? 1);
  }

  // ── XP Awarding (external actions) ───────────────────────────────────────

  /**
   * Award XP from an external action (tree chop, kill, quarry tick, etc.).
   * scene is optional — only used to trigger future scene-level effects if needed.
   */
  awardXP(skillId, amount, _scene) {
    if (!(skillId in this._xp)) return;
    const prevLvl = this.getLevel(skillId);
    this._xp[skillId] += amount;
    const newXP = this._xp[skillId];
    const newLvl = this.getLevel(skillId);
    this.emit('xp-gained', {
      skillId,
      xp: amount,
      totalXP: newXP,
      level: newLvl,
    });
    if (newLvl > prevLvl) this.emit('level-up', { skillId, level: newLvl });
  }

  // ── Crafting ─────────────────────────────────────────────────────────────

  /**
   * Attempt to start a timed craft.
   * inventory: Inventory instance or plain object shim { get, add, set }
   * onComplete: optional callback({ outputItem, outputQty })
   * Returns true if craft started.
   */
  startCraft(skillId, recipeId, scene, inventory, onComplete) {
    if (this._crafting) return false;

    const skill = this.getSkill(skillId);
    if (!skill) return false;
    const recipe = skill.recipes.find((r) => r.id === recipeId);
    if (!recipe) return false;

    // Level gate
    if (!this.canCraft(skillId, recipeId)) return false;

    // Check inputs
    for (const { item, qty } of recipe.inputs) {
      if (this._invGet(inventory, item) < qty) return false;
    }

    // Check output space first (slot-based Inventory may reject adds if full).
    // If this fails, do not consume inputs.
    if (typeof inventory?.canAdd === 'function') {
      const canFitOutput = inventory.canAdd(
        recipe.output.item,
        recipe.output.qty
      );
      if (!canFitOutput) return false;
    }

    // Consume inputs
    for (const { item, qty } of recipe.inputs) {
      this._invConsume(inventory, item, qty);
    }

    this._crafting = true;
    this._craftStart = scene.time.now;
    this._craftMs = recipe.craftMs;
    this._craftRecipe = recipe;
    this._craftSkill = skillId;
    this._inventory = inventory;

    this._craftTimer = scene.time.delayedCall(recipe.craftMs, () => {
      this._crafting = false;
      this._craftRecipe = null;
      this._craftSkill = null;
      this._craftTimer = null;

      // Deliver output
      this._invAdd(inventory, recipe.output.item, recipe.output.qty);

      // Award XP
      this.awardXP(skillId, recipe.xpPerCraft, scene);

      if (onComplete)
        onComplete({
          outputItem: recipe.output.item,
          outputQty: recipe.output.qty,
        });
    });

    return true;
  }

  // ── Serialisation ────────────────────────────────────────────────────────

  serialise() {
    return { xp: { ...this._xp } };
  }

  deserialise(data) {
    if (data?.xp) {
      for (const [id, val] of Object.entries(data.xp)) {
        if (id in this._xp) this._xp[id] = val;
      }
    }
  }

  // ── Inventory helpers ────────────────────────────────────────────────────

  _invGet(inv, key) {
    return typeof inv.get === 'function' ? inv.get(key) : (inv[key] ?? 0);
  }

  _invConsume(inv, key, qty) {
    if (typeof inv.set === 'function') {
      inv.set(key, this._invGet(inv, key) - qty);
    } else {
      inv[key] = (inv[key] ?? 0) - qty;
    }
  }

  _invAdd(inv, key, qty) {
    if (typeof inv.add === 'function') {
      inv.add(key, qty);
    } else {
      inv[key] = (inv[key] ?? 0) + qty;
    }
  }
}
