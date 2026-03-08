// CombatSystem — centralises melee damage, attack speed, and death/respawn.
//
// Damage formula (melee):
//   base = attacker.strengthLevel (defaults to 1)
//   max  = Math.floor(base * 1.2) + 1          e.g. lvl 1 → max 2, lvl 10 → max 13
//   roll = Phaser.Math.Between(0, max)          0 = splash miss
//   reduced = Math.max(1, roll - defenceBonus)  if target has defence
//
// Attack speed:
//   melee default 1400 ms between swings
//   bow is handled separately by Bow.js
//
// Death:
//   Player — drops half inventory as ground items, respawns at Machine with 1 HP
//   NPC    — plays death flash, removes from scene for 60s, then respawns
//
// Usage:
//   const cs = new CombatSystem(scene);
//   cs.playerMeleeAttack(target);   // call from GameScene when Space pressed + chicken selected
//   cs.npcMeleeAttack(npc, target); // call from NPCTaskRunner

import Phaser from 'phaser';
import { GroundItem } from '../entities/GroundItem.js';

const MELEE_COOLDOWN_MS = 1400; // ms between player melee swings
const NPC_RESPAWN_MS    = 60000;

export class CombatSystem {
  constructor(scene) {
    this._scene = scene;
    this._playerMeleeCooldown = 0; // ms remaining until next swing allowed
  }

  // ── Public — player ────────────────────────────────────────────────────────

  /**
   * Attempt a player melee attack on a target.
   * @param {object} target — any object with .x, .y, .hp, .takeDamage(), .isDead?.()
   *   Expects chicken-like or future enemy-like objects.
   * @param {number} attackRange — max px distance for melee (default 1.5 tiles)
   */
  playerMeleeAttack(target, attackRange) {
    if (!target) return;
    const scene    = this._scene;
    const player   = scene.player;
    const maxRange = attackRange ?? (scene.TILE_SIZE ?? 48) * 1.5;

    // Cooldown check
    if (this._playerMeleeCooldown > 0) return;

    // Range check
    const dist = Phaser.Math.Distance.Between(player.x, player.y, target.x, target.y);
    if (dist > maxRange) return;

    // Already dead?
    if (target.isDead?.()) return;

    // Damage calc
    const strengthLvl = scene.skillSystem?.getLevel('strength') ?? 1;
    const damage = _rollDamage(strengthLvl, 0);

    // Apply
    this._playerMeleeCooldown = MELEE_COOLDOWN_MS;
    scene.time.delayedCall(MELEE_COOLDOWN_MS, () => { this._playerMeleeCooldown = 0; });

    if (damage === 0) {
      // Miss — still award tiny Attack XP for attempting
      scene.skillSystem?.awardXP('attack', 2, scene);
      _spawnHitText(scene, target.x, target.y - 20, '0', '#aaaaaa');
      return;
    }

    // Award XP before potential death
    scene.skillSystem?.awardXP('attack',   4,  scene);
    scene.skillSystem?.awardXP('strength', 4,  scene);

    // Use chicken's built-in hit() if available (awards combat XP + drops feathers)
    if (typeof target.hit === 'function') {
      const died = target.hit(scene, null, scene.skillSystem);
      if (!died) {
        // Target survived (future: multi-HP enemies)
        _spawnHitText(scene, target.x, target.y - 20, String(damage), '#ff6666');
      }
      return;
    }

    // Generic target (future enemy)
    if (!_canTakeCombatDamage(target)) return;
    _spawnHitText(scene, target.x, target.y - 20, String(damage), '#ff6666');
    const died = target.takeDamage(damage);
    if (died) this._handleEntityDeath(target);
  }

  /**
   * NPC melee attack — called by NPCTaskRunner.
   * Returns true if target died.
   */
  npcMeleeAttack(npc, target) {
    if (!target || target.isDead?.()) return false;
    const scene = this._scene;

    const strengthLvl = npc.skills?.getLevel('strength') ?? 1;
    const rawDamage = _rollDamage(strengthLvl, 0);
    const isActorTarget = typeof target.takeDamage === 'function' && typeof target.hit !== 'function';
    const damage = isActorTarget ? Math.max(1, rawDamage) : rawDamage;

    if (damage === 0) {
      npc.skills?.awardXP('attack', 2, scene);
      return false;
    }

    npc.skills?.awardXP('attack',   4, scene);
    npc.skills?.awardXP('strength', 4, scene);

    if (typeof target.hit === 'function') {
      const collector = (item, qty) => npc.addItem(item, qty);
      return target.hit(scene, collector, npc.skills) === true;
    }

    if (!_canTakeCombatDamage(target)) {
      return false;
    }

    const died = target.takeDamage(damage);
    if (died) this._handleEntityDeath(target);
    return died;
  }

  // ── Player death / respawn ─────────────────────────────────────────────────

  /**
   * Call when player.hp reaches 0.
   * Drops roughly half the inventory as ground items, warps to machine, restores 1 HP.
   */
  handlePlayerDeath() {
    const scene    = this._scene;
    const player   = scene.player;
    const inv      = scene.inventory;
    const machine  = scene.machine;

    // Drop ~half of each stack as ground items at death location
    const allItems = inv.getAll();
    for (const [res, qty] of Object.entries(allItems)) {
      const drop = Math.floor(qty / 2);
      if (drop > 0) {
        inv.set(res, qty - drop);
        new GroundItem(scene, player.x, player.y, res, drop);
      }
    }

    // Death flash
    scene.cameras.main.shake(300, 0.015);
    scene.cameras.main.flash(400, 180, 0, 0);

    // Teleport to machine, restore 1 HP
    player.x  = machine.x;
    player.y  = machine.y + 48; // just south of machine
    player.hp = 1;

    // Notification
    _spawnHitText(scene, machine.x, machine.y - 60, 'You died!', '#ff4444');
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _handleEntityDeath(entity) {
    // Generic: just destroy
    entity.destroy?.();
  }
}

// ── Module-level helpers ───────────────────────────────────────────────────

/**
 * RS-style damage roll: 0 to max, where max = floor(strengthLevel * 1.2) + 1
 * defenceBonus reduces result (min 0, but we'll still call it a hit if >0 before reduction).
 */
function _rollDamage(strengthLevel, defenceBonus) {
  const maxHit = Math.floor(strengthLevel * 1.2) + 1;
  const raw    = Phaser.Math.Between(0, maxHit);
  return Math.max(0, raw - defenceBonus);
}

/**
 * Briefly show a floating damage number above a position.
 */
function _spawnHitText(scene, x, y, text, color) {
  const t = scene.add.text(x, y, text, {
    fontSize: '13px', color, fontStyle: 'bold',
    stroke: '#000000', strokeThickness: 2,
  }).setOrigin(0.5).setDepth(20);

  scene.tweens.add({
    targets: t,
    y: y - 24,
    alpha: 0,
    duration: 700,
    ease: 'Cubic.Out',
    onComplete: () => t.destroy(),
  });
}

function _canTakeCombatDamage(target) {
  if (typeof target?.takeDamage === 'function') return true;
  const name = target?.id ?? target?.name ?? target?.constructor?.name ?? 'unknown-target';
  console.warn(`[CombatSystem] Skipping invalid combat target: ${name}`);
  return false;
}
