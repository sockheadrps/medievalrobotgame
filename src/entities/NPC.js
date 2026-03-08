// NPC — an autonomous character driven by a task queue set by NPCTaskRunner.
// Uses the same player spritesheet as Player. Pathfinds by walking directly
// toward a world-space target; does not use physics collision.

import Phaser from 'phaser';
import {
  PLAYER_KEY,
  TILE_SIZE,
  PLAYER_FRAME_H,
  PANIM_WALK_DOWN,
  PANIM_WALK_UP,
  PANIM_WALK_LEFT,
  worldToTile,
} from '../constants.js';
import { SkillSystem } from '../systems/SkillSystem.js';
import { getRobotProfile } from '../data/robotProfiles.js';

// HP formula: 10 + (constitutionLevel * 5)
// Regen: 1 HP every 30s out of combat
const HP_REGEN_MS = 30000;

// ── Mood behaviour constants ──────────────────────────────────────────────────
// Mood score = trust - anger (range roughly -1 to +1)
// Happy  > MOOD_HAPPY   → speed boost + banter
// Upset  < MOOD_UPSET   → speed penalty + lazy chance + insults
const MOOD_HAPPY = 0.35; // trust - anger threshold for "good mood"
const MOOD_UPSET = -0.15; // trust - anger threshold for "bad mood"
const MOOD_SPEED_GOOD = 0.15; // +15% speed when happy
const MOOD_SPEED_BAD = -0.15; // -15% speed when upset

// How often (ms) the social/laziness tick runs — staggered by NPC to avoid
// everyone chatting at exactly the same moment
const SOCIAL_TICK_MIN = 18_000;
const SOCIAL_TICK_MAX = 35_000;

// Probability that a "bad mood" NPC abandons their task on a lazy tick
const LAZY_CHANCE = 0.35;

// Player/NPC proximity for social events (tiles)
const SOCIAL_DIST_TILES = 5;
const REL_DECAY_TICK_MS = 15000;
const AGGRO_RECHECK_MS = 1200;

const SCALE = TILE_SIZE / PLAYER_FRAME_H; // 1.5
const ARRIVE_D = 8; // px — close enough to consider "arrived"
export class NPC extends Phaser.GameObjects.Container {
  /**
   * @param {Phaser.Scene} scene
   * @param {number} x  world px
   * @param {number} y  world px
   * @param {string} id  unique id, e.g. "npc_0"
   */
  constructor(scene, x, y, id = 'npc_0') {
    super(scene, x, y);
    scene.add.existing(this);
    this.setDepth(2);

    this.id = id;
    this._profile = 'standard';
    this._baseSpeed = 100;
    this._speedBonuses = [1.0, 1.2, 1.4];
    this._linkColor = 0x88ccff;

    // Sprite (same sheet/anims as player, but tinted blue-ish)
    this._sprite = scene.add.sprite(0, 0, PLAYER_KEY, PANIM_WALK_DOWN * 3 + 1);
    this._sprite.setScale(SCALE);
    this._sprite.setOrigin(0.5, 1);
    this._sprite.setTint(0x88ccff);
    this.add(this._sprite);

    // Name label above head
    this._nameLabel = scene.add
      .text(0, -TILE_SIZE - 4, id, {
        fontSize: '9px',
        color: '#88ccff',
        backgroundColor: '#00000088',
        padding: { x: 3, y: 2 },
      })
      .setOrigin(0.5, 1)
      .setDepth(3);
    this.add(this._nameLabel);

    // Thought-bubble text (visible while thinking)
    this._bubble = scene.add
      .text(0, -TILE_SIZE * 2.6, '', {
        fontSize: '9px',
        color: '#ffffff',
        backgroundColor: '#00000099',
        padding: { x: 4, y: 3 },
        wordWrap: { width: 120 },
      })
      .setOrigin(0.5, 1)
      .setDepth(4)
      .setVisible(false);
    this.add(this._bubble);

    // Selection ring
    this._ring = scene.add.graphics();
    this._ring.lineStyle(2, 0xffff00, 1);
    this._ring.strokeCircle(0, -TILE_SIZE / 2, 18);
    this._ring.setVisible(false);
    this.add(this._ring);

    this._selected = false;
    this._target = null; // { x, y } world-space destination
    this._facing = 'down';
    this._inventory = {}; // resource → amount

    // Ctrl+click assigned targets — used by NPCTaskRunner before falling back to _nearest()
    // flywheels is an array (can manage multiple); others are single refs
    this.assignedTargets = {
      flywheels: [],
      trees: [],
      mine_rocks: [], // multiple rocks can be assigned
      crates: [], // ordered list — first assigned = default; multiple = per-ore routing
      crateOreMap: {}, // oreResKey → crate index (0-based) — set by ChatBox parser
      furnace: null,
      quarry: null,
      crusher: null,
      anvil: null,
    };

    // Graphics drawn in world space to show assignment links
    this._assignmentGraphics = scene.add.graphics().setDepth(2);

    // Inventory label — shown below NPC when selected
    this._invLabel = scene.add
      .text(0, 8, '', {
        fontSize: '9px',
        color: '#ffff88',
        backgroundColor: '#00000099',
        padding: { x: 4, y: 2 },
        align: 'center',
      })
      .setOrigin(0.5, 0)
      .setDepth(4)
      .setVisible(false);
    this.add(this._invLabel);

    // Task runner reference — set externally by NPCTaskRunner
    this.taskRunner = null;

    // Independent skill system — each NPC levels up separately from the player
    this.skills = new SkillSystem();

    // ── Soul — personality, emotional state, relationship, memory ─────────────
    // Personality is fixed at spawn (randomised within ranges).
    // Emotional state drifts through interactions. Relationship is derived.
    this.soul = _makeSoul();
    this.normalizeSoulState();
    this._responseProfile = _makeResponseProfile();
    this._recentCatalysts = [];
    this._aggroAccum = 0;
    this._aggroCooldownUntil = 0;

    // Mood social tick — fires every ~18-35s (staggered per NPC)
    this._scheduleSocialTick();
    this._relDecayAccum = 0;

    // Upgrade slots — modified by NPCUpgradePanel via the Mother Machine
    this.upgrades = {
      speedTier: 0, // 0=base, 1=+20%, 2=+40%
      carryCapacity: 10, // max items per resource type carried at once
      taskEfficiency: 1.0, // multiplier on all timed task durations (lower = faster)
      combatEnabled: false, // NPC will engage enemies autonomously when true
    };

    // HP — Constitution level sets maxHp; regen ticks in update()
    this.maxHp = 15; // default: Constitution level 1
    this.hp = this.maxHp;
    this._regenAccum = 0;

    // HP bar — thin bar just above the name label
    const BAR_W = 30;
    const BAR_H = 3;
    this._hpBarBg = scene.add
      .rectangle(0, -TILE_SIZE - 18, BAR_W, BAR_H, 0x330000)
      .setDepth(3)
      .setOrigin(0.5, 0.5);
    this._hpBarFill = scene.add
      .rectangle(-BAR_W / 2, -TILE_SIZE - 18, BAR_W, BAR_H, 0x44ff44)
      .setDepth(4)
      .setOrigin(0, 0.5);
    this.add(this._hpBarBg);
    this.add(this._hpBarFill);
    this._updateHPBar();

    // NPC click handling is performed centrally in GameScene (click-only hit test)
    // to avoid hover-related input churn on moving sprites.

    this.setProfile('standard');
    this._ensureAnims(scene);

    // Seed starting memories so the LLM has context from the first interaction
    this.addMemory("I work for the player's colony as a worker and companion.");
    this.addMemory(
      'The player is my boss. I generally trust them and follow their orders.'
    );
  }

  // ── Upgrade helpers ───────────────────────────────────────────────────────

  /** Returns current movement speed in px/s factoring in speedTier upgrade and soul mood. */
  getSpeed() {
    const bonus =
      this._speedBonuses[this.upgrades.speedTier] ??
      this._speedBonuses[this._speedBonuses.length - 1] ??
      1.0;
    const mood = _moodScore(this.soul);
    const moodMult =
      mood > MOOD_HAPPY
        ? 1 + MOOD_SPEED_GOOD
        : mood < MOOD_UPSET
          ? 1 + MOOD_SPEED_BAD
          : 1.0;
    return this._baseSpeed * bonus * moodMult;
  }

  // ── HP API ────────────────────────────────────────────────────────────────

  /** Call whenever this NPC's Constitution level changes. */
  setConstitutionLevel(lvl) {
    const prev = this.maxHp;
    this.maxHp = 10 + lvl * 5;
    this.hp = Math.min(this.hp + (this.maxHp - prev), this.maxHp);
    this._updateHPBar();
  }

  isDead() {
    return this._dead === true;
  }

  takeDamage(amount) {
    if (this._dead) return false;
    this.hp = Math.max(0, this.hp - amount);
    this._regenAccum = 0;
    this._updateHPBar();
    if (this.hp <= 0) {
      this._triggerDeath();
      return true;
    }
    // Auto-defend: interrupt current task and fight back
    if (amount > 0) this._autoDefend();
    return false;
  }

  /**
   * React to being hit: push an attack_nearest_enemy task to the front of the
   * queue so the NPC fights back immediately, then resumes prior work when done.
   * Suppressed if the NPC already has a combat task running or combatEnabled is
   * false and the NPC has no combat upgrade — always reacts if directly attacked.
   */
  _autoDefend() {
    if (!this.taskRunner) return;
    this.taskRunner.interruptWithCombat();
  }

  /** Visually kill the NPC and schedule a 60s respawn near the machine. */
  _triggerDeath() {
    if (this._dead) return;
    this._dead = true;
    this.taskRunner?.stop();
    this._target = null;
    this._onArrive = null;
    if (!this.scene) return;

    // Red flash then go invisible
    this._sprite.setTint(0xff2222);
    this.scene.tweens.add({
      targets: this._sprite,
      alpha: 0,
      duration: 400,
      onComplete: () => {
        if (!this.scene || !this.active) return;
        this.setVisible(false);
        const profile = getRobotProfile(this._profile);
        this._sprite.setAlpha(1).setTint(profile.bodyTint);
      },
    });

    this._respawnTimer?.remove();
    this._respawnTimer = this.scene.time.delayedCall(60000, () =>
      this._respawn()
    );
  }

  _respawn() {
    if (!this.scene || !this.active) return;
    const machine = this.scene.machine;
    if (!machine) return;
    // Scatter respawn within 2 tiles of machine
    this.x = machine.x + Phaser.Math.Between(-64, 64);
    this.y = machine.y + Phaser.Math.Between(32, 96);
    this.hp = this.maxHp;
    this._dead = false;
    this._regenAccum = 0;
    this._updateHPBar();
    this.setVisible(true);
    this._playIdle();
    this.showBubble('Back online.');
  }

  heal(amount) {
    this.hp = Math.min(this.maxHp, this.hp + amount);
    this._updateHPBar();
  }

  _updateHPBar() {
    const BAR_W = 30;
    const frac = this.maxHp > 0 ? Math.max(0, this.hp / this.maxHp) : 0;
    const fillW = Math.round(BAR_W * frac);
    this._hpBarFill.setDisplaySize(Math.max(0, fillW), 3);
    const col = frac > 0.5 ? 0x44ff44 : frac > 0.25 ? 0xffaa22 : 0xff2222;
    this._hpBarFill.setFillStyle(col);
  }

  // ── Selection ──────────────────────────────────────────────────────────────

  setSelected(selected) {
    this._selected = selected;
    this._ring.setVisible(selected);
    if (selected) {
      this._refreshInvLabel();
      this._invLabel.setVisible(true);
    } else {
      this._invLabel.setVisible(false);
    }
    this._drawAssignmentLinks();
  }

  isSelected() {
    return this._selected;
  }

  // ── Target assignment (ctrl+click) ────────────────────────────────────────

  /**
   * Assign a world object to this NPC.
   * type: 'flywheel' | 'furnace' | 'crate' | 'quarry' | 'crusher'
   */
  assignTarget(type, obj) {
    if (type === 'flywheel') {
      if (!this.assignedTargets.flywheels.includes(obj))
        this.assignedTargets.flywheels.push(obj);
    } else if (type === 'tree') {
      if (!this.assignedTargets.trees.includes(obj))
        this.assignedTargets.trees.push(obj);
    } else if (type === 'mine_rock') {
      if (!this.assignedTargets.mine_rocks.includes(obj))
        this.assignedTargets.mine_rocks.push(obj);
    } else if (type === 'crate') {
      if (!this.assignedTargets.crates.includes(obj))
        this.assignedTargets.crates.push(obj);
    } else {
      this.assignedTargets[type] = obj;
    }
    this._drawAssignmentLinks();
  }

  unassignTarget(type, obj) {
    if (type === 'flywheel') {
      this.assignedTargets.flywheels = this.assignedTargets.flywheels.filter(
        (f) => f !== obj
      );
    } else if (type === 'tree') {
      this.assignedTargets.trees = this.assignedTargets.trees.filter(
        (t) => t !== obj
      );
    } else if (type === 'mine_rock') {
      this.assignedTargets.mine_rocks = this.assignedTargets.mine_rocks.filter(
        (r) => r !== obj
      );
    } else if (type === 'crate') {
      this.assignedTargets.crates = this.assignedTargets.crates.filter(
        (c) => c !== obj
      );
      // Clear any ore mappings that pointed to this crate
      this.assignedTargets.crateOreMap = {};
    } else {
      if (this.assignedTargets[type] === obj) this.assignedTargets[type] = null;
    }
    this._drawAssignmentLinks();
  }

  _drawAssignmentLinks() {
    const g = this._assignmentGraphics;
    g.clear();
    if (!this._selected) return;

    g.lineStyle(1, this._linkColor, 0.6);
    const allTargets = [
      ...this.assignedTargets.flywheels,
      ...this.assignedTargets.trees,
      ...this.assignedTargets.mine_rocks,
      ...this.assignedTargets.crates,
      this.assignedTargets.furnace,
      this.assignedTargets.quarry,
      this.assignedTargets.crusher,
      this.assignedTargets.anvil,
    ].filter(Boolean);

    for (const t of allTargets) {
      g.beginPath();
      g.moveTo(this.x, this.y);
      g.lineTo(t.x, t.y);
      g.strokePath();
      g.fillStyle(this._linkColor, 0.8);
      g.fillCircle(t.x, t.y, 5);
    }
  }

  // ── NPC inventory ──────────────────────────────────────────────────────────

  addItem(resource, amount) {
    this._inventory[resource] = (this._inventory[resource] ?? 0) + amount;
    if (this._selected) this._refreshInvLabel();
  }

  removeItem(resource, amount) {
    this._inventory[resource] = Math.max(
      0,
      (this._inventory[resource] ?? 0) - amount
    );
    if (this._selected) this._refreshInvLabel();
  }

  getItem(resource) {
    return this._inventory[resource] ?? 0;
  }
  getInventoryData() {
    return this._inventory;
  }

  _refreshInvLabel() {
    const entries = Object.entries(this._inventory).filter(([, v]) => v > 0);
    if (entries.length === 0) {
      this._invLabel.setText('(empty)');
    } else {
      this._invLabel.setText(entries.map(([k, v]) => `${k}: ${v}`).join('\n'));
    }
  }

  // ── Thought bubble ────────────────────────────────────────────────────────

  showBubble(text, durationMs = 6000, direct = false) {
    this._bubble.setText(text).setVisible(true);
    if (this._bubbleTimer) this._bubbleTimer.remove();
    this._bubbleTimer = this.scene.time.delayedCall(durationMs, () => {
      if (this._bubble) this._bubble.setVisible(false);
      this._bubbleTimer = null;
    });
    // Push to social chat panel if available
    this.scene?.socialChat?.addNpcLine?.(this.getName(), text, direct);
  }

  hideBubble() {
    if (this._bubbleTimer) {
      this._bubbleTimer.remove();
      this._bubbleTimer = null;
    }
    this._bubble.setVisible(false);
  }

  setName(name) {
    this._nameLabel.setText(name);
  }
  getName() {
    return this._nameLabel?.text ?? this.id;
  }
  getProfile() {
    return this._profile;
  }

  setProfile(profile = 'standard') {
    const p = getRobotProfile(profile);
    this._profile = p.id ?? 'standard';
    this._baseSpeed = p.baseSpeed ?? 100;
    this._speedBonuses = p.speedBonuses ?? [1.0, 1.2, 1.4];
    this._linkColor = p.linkColor ?? 0x88ccff;

    this._sprite.setTint(p.bodyTint ?? 0x88ccff);
    this._nameLabel.setColor(p.nameColor ?? '#88ccff');
    this.upgrades.carryCapacity = p.carryCapacity ?? 10;
    this.upgrades.taskEfficiency = p.taskEfficiency ?? 1.0;
    this.upgrades.combatEnabled = !!p.combatEnabled;
    this.maxHp = p.maxHp ?? 15;
    this.hp = Math.min(this.hp, this.maxHp);
    this._updateHPBar();
  }

  refreshLabels(_visible) {
    // NPC nametag always visible — not toggled by Ctrl
  }

  // ── Movement target ───────────────────────────────────────────────────────

  /** Walk toward world-space point (px). Calls onArrive when reached. */
  moveTo(x, y, onArrive) {
    this._target = { x, y };
    this._onArrive = onArrive ?? null;
  }

  stopMoving() {
    this._target = null;
    this._onArrive = null;
    this._playIdle();
  }

  // ── Update — called every frame by GameScene ──────────────────────────────

  update(delta) {
    if (this._dead) return;
    this._relDecayAccum += delta;
    if (this._relDecayAccum >= REL_DECAY_TICK_MS) {
      this._relDecayAccum -= REL_DECAY_TICK_MS;
      this._decayRelationshipDynamics();
    }

    // HP regen — 1 HP every HP_REGEN_MS ms
    if (this.hp < this.maxHp) {
      this._regenAccum += delta;
      if (this._regenAccum >= HP_REGEN_MS) {
        this._regenAccum -= HP_REGEN_MS;
        this.heal(1);
      }
    } else {
      this._regenAccum = 0;
    }

    this._aggroAccum += delta;
    if (this._aggroAccum >= AGGRO_RECHECK_MS) {
      this._aggroAccum = 0;
      this._maybeAutonomousAggro();
    }

    if (!this._target) return;

    const dx = this._target.x - this.x;
    const dy = this._target.y - this.y;
    const dist = Math.hypot(dx, dy);

    if (dist <= ARRIVE_D) {
      this.x = this._target.x;
      this.y = this._target.y;
      this._target = null;
      this._playIdle();
      if (this._onArrive) {
        const cb = this._onArrive;
        this._onArrive = null;
        cb();
      }
      return;
    }

    const step = (this.getSpeed() * delta) / 1000;
    const nextX = this.x + (dx / dist) * step;
    const nextY = this.y + (dy / dist) * step;

    // Auto-open any closed door the NPC is about to walk into
    const nTile = worldToTile(nextX, nextY);
    const atTile = this.scene?.grid?.get(nTile.col, nTile.row);
    if (
      atTile &&
      typeof atTile.isOpen === 'function' &&
      !atTile.isOpen() &&
      !atTile.isDead()
    ) {
      atTile.open();
      // Schedule close after a short delay so the NPC can pass through
      this.scene.time.delayedCall(600, () => {
        if (!atTile.isDead() && atTile.isOpen()) atTile.close();
      });
    }

    this.x = nextX;
    this.y = nextY;

    // Facing
    if (Math.abs(dx) >= Math.abs(dy)) {
      this._facing = dx > 0 ? 'right' : 'left';
    } else {
      this._facing = dy > 0 ? 'down' : 'up';
    }
    this._playWalk();
    if (this._selected) this._drawAssignmentLinks();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _playWalk() {
    const isSide = this._facing === 'left' || this._facing === 'right';
    this._sprite.setFlipX(this._facing === 'right');
    const key = isSide
      ? 'walk-side'
      : this._facing === 'up'
        ? 'walk-up'
        : 'walk-down';
    if (this._sprite.anims.currentAnim?.key !== key) this._sprite.play(key);
  }

  _playIdle() {
    this._sprite.stop();
    const rowMap = {
      down: PANIM_WALK_DOWN,
      up: PANIM_WALK_UP,
      left: PANIM_WALK_LEFT,
      right: PANIM_WALK_LEFT,
    };
    this._sprite.setFlipX(this._facing === 'right');
    this._sprite.setFrame(rowMap[this._facing] * 3 + 1);
  }

  _ensureAnims(scene) {
    const anims = scene.anims;
    const def = (key, row, fps) => {
      if (anims.exists(key)) return;
      anims.create({
        key,
        frames: anims.generateFrameNumbers(PLAYER_KEY, {
          start: row * 3,
          end: row * 3 + 2,
        }),
        frameRate: fps,
        repeat: -1,
      });
    };
    def('walk-down', PANIM_WALK_DOWN, 8);
    def('walk-up', PANIM_WALK_UP, 8);
    def('walk-side', PANIM_WALK_LEFT, 8);
  }

  // ── Soul API ──────────────────────────────────────────────────────────────

  /**
   * Apply emotion deltas from an LLM response.
   * Deltas are clamped so no single event can swing an emotion more than 0.4.
   * Emotions are clamped to [0, 1] after application.
   * Automatically re-derives relationship stage.
   * @param {{ trust?: number, fear?: number, anger?: number }} deltas
   */
  applyEmotionDeltas(deltas) {
    this.normalizeSoulState();
    const MAX_DELTA = 0.4;
    const em = this.soul.emotional_state;
    for (const [key, raw] of Object.entries(deltas)) {
      if (!(key in em)) continue;
      const clamped = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, raw));
      em[key] = Math.max(0, Math.min(1, em[key] + clamped));
    }
    this.soul.relationship = _deriveRelationship(em);
  }

  /**
   * Update long-term relationship metrics against another NPC.
   * @param {string} otherId
   * @param {{ trust?: number, respect?: number, anger?: number, fear?: number, rivalry?: number }} deltas
   */
  applyRelationshipDeltas(otherId, deltas = {}, otherName = null) {
    if (!otherId || !deltas) return;
    this.normalizeSoulState();
    const bond = this._getRelationshipMetrics(otherId);
    const prevAnger = bond.anger;
    const keys = ['trust', 'respect', 'anger', 'fear', 'rivalry'];
    for (const key of keys) {
      const raw = Number(deltas[key]);
      if (!Number.isFinite(raw)) continue;
      bond[key] = Phaser.Math.Clamp(bond[key] + raw, -100, 100);
    }
    bond.lastUpdated = Date.now();
    const other =
      this.scene?.npcs?.find?.((n) => n.id === otherId) ??
      this.scene?.npNPCs?.find?.((n) => n.id === otherId) ??
      null;
    const resolvedOtherName = otherName || other?.getName?.() || otherId;

    if (prevAnger < 25 && bond.anger >= 25) {
      this.addIntent(`Starting to get mad at ${resolvedOtherName}.`);
    }
    if (prevAnger < 55 && bond.anger >= 55) {
      this.addIntent(
        `Thinking about fighting ${resolvedOtherName} for that disrespect.`
      );
    }
    if (prevAnger < 75 && bond.anger >= 75) {
      this.addIntent(`One more comment from ${resolvedOtherName} and it's on.`);
    }

    this.applyEmotionDeltas({
      trust: Number(deltas.trust ?? 0) * 0.002,
      fear: Number(deltas.fear ?? 0) * 0.0015,
      anger: Number(deltas.anger ?? 0) * 0.002,
    });
  }

  getRelationshipMetrics(otherId) {
    return { ...this._getRelationshipMetrics(otherId) };
  }

  /**
   * Read-only relationship metrics snapshot without creating a new entry.
   * Returns null if this NPC has no recorded relationship data for otherId.
   * @param {string} otherId
   */
  peekRelationshipMetrics(otherId) {
    this.normalizeSoulState();
    const map = this.soul?.relationship_dynamics;
    if (!map || typeof map !== 'object') return null;
    const m = map[otherId];
    return m ? { ...m } : null;
  }

  /**
   * Deterministically process a social stimulus (player/NPC line) into
   * relationship + emotional changes and catalyst score tracking.
   * @param {{
   *   sourceId: string,
   *   sourceName?: string,
   *   text?: string,
   *   tags?: string[],
   *   intensity?: number,
   *   targeted?: boolean,
   * }} evt
   */
  recordSocialStimulus(evt = {}) {
    const sourceId = String(evt.sourceId ?? '').trim();
    if (!sourceId) return;
    this.normalizeSoulState();

    const tags = Array.isArray(evt.tags) ? evt.tags : [];
    const intensity = Phaser.Math.Clamp(Number(evt.intensity ?? 0.35), 0, 1);
    const targetedBoost = evt.targeted ? 1.15 : 0.85;

    const aggr = Phaser.Math.Clamp(
      Number(this.soul?.personality?.aggression ?? 0.5),
      0,
      1
    );
    const neuro = Phaser.Math.Clamp(
      Number(this.soul?.personality?.neuroticism ?? 0.5),
      0,
      1
    );
    const coop = Phaser.Math.Clamp(
      Number(this.soul?.personality?.cooperation ?? 0.5),
      0,
      1
    );
    const forgive = Phaser.Math.Clamp(
      Number(this.soul?.personality?.forgiveness ?? 0.5),
      0,
      1
    );

    const hostile = tags.some((t) =>
      ['insult', 'threat', 'mock', 'hostile'].includes(t)
    );
    const friendly = tags.some((t) =>
      ['praise', 'apology', 'friendly', 'gratitude'].includes(t)
    );
    const orderish = tags.some((t) => ['order', 'command'].includes(t));

    const hostilityWeight = hostile ? 0.8 + aggr * 0.7 + neuro * 0.5 : 0;
    const friendlyWeight = friendly ? 0.55 + coop * 0.5 + forgive * 0.35 : 0;
    const orderWeight = orderish ? 0.2 + (1 - coop) * 0.15 : 0;

    const catalystScore = Phaser.Math.Clamp(
      intensity *
        targetedBoost *
        (hostilityWeight + orderWeight + (friendly ? 0.05 : 0)),
      0,
      2.5
    );

    this.applyRelationshipDeltas(
      sourceId,
      {
        anger: hostile ? 10 * intensity * (0.7 + aggr + neuro) : 0,
        fear: tags.includes('threat') ? 8 * intensity * (0.4 + neuro) : 0,
        trust: friendly
          ? 10 * intensity * friendlyWeight
          : hostile
            ? -8 * intensity * (0.6 + (1 - forgive))
            : 0,
        rivalry: hostile
          ? 7 * intensity * (0.6 + aggr)
          : -2 * intensity * friendlyWeight,
        respect: tags.includes('respect')
          ? 6 * intensity
          : hostile
            ? -5 * intensity
            : 0,
      },
      evt.sourceName ?? sourceId
    );

    const emoDeltas = {
      anger: hostile ? 0.08 * intensity * (0.8 + aggr + neuro) : 0,
      fear: tags.includes('threat') ? 0.05 * intensity * (0.6 + neuro) : 0,
      trust: friendly
        ? 0.08 * intensity * friendlyWeight
        : hostile
          ? -0.06 * intensity * (0.5 + (1 - forgive))
          : 0,
    };
    this.applyEmotionDeltas(emoDeltas);

    const totalsMap =
      this.soul.source_emotion_totals ?? (this.soul.source_emotion_totals = {});
    const cur = totalsMap[sourceId] ?? {
      trust: 0,
      fear: 0,
      anger: 0,
      samples: 0,
      source_name: evt.sourceName ?? sourceId,
    };
    cur.trust = Number(cur.trust ?? 0) + Number(emoDeltas.trust ?? 0);
    cur.fear = Number(cur.fear ?? 0) + Number(emoDeltas.fear ?? 0);
    cur.anger = Number(cur.anger ?? 0) + Number(emoDeltas.anger ?? 0);
    cur.samples = Number(cur.samples ?? 0) + 1;
    cur.source_name = evt.sourceName ?? cur.source_name ?? sourceId;
    totalsMap[sourceId] = cur;

    const now = Date.now();
    this._recentCatalysts.push({
      sourceId,
      score: catalystScore,
      ts: now,
      tags,
      text: String(evt.text ?? ''),
    });
    if (this._recentCatalysts.length > 20) this._recentCatalysts.shift();
  }

  /**
   * Choose target by strongest catalyst score toward this NPC.
   * Falls back to nearest when no meaningful catalyst exists.
   * @param {Array<any>} candidates
   */
  selectCatalystTarget(candidates = []) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    const now = Date.now();
    let best = null;
    let bestScore = -Infinity;
    for (const c of candidates) {
      if (!c) continue;
      const id = c.id ?? 'player';
      const rel = this.peekRelationshipMetrics?.(id) ?? null;
      const anger = Number(rel?.anger ?? 0);
      const rivalry = Number(rel?.rivalry ?? 0);
      const trust = Number(rel?.trust ?? 0);
      const recent = (this._recentCatalysts ?? [])
        .filter((r) => r.sourceId === id && now - Number(r.ts ?? 0) <= 90_000)
        .reduce((sum, r) => sum + Number(r.score ?? 0), 0);
      const score = anger + rivalry * 0.6 + recent * 30 - trust * 0.25;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (
      best &&
      bestScore >= Number(this._responseProfile?.attackCatalystThreshold ?? 20)
    ) {
      return best;
    }
    return candidates.reduce((near, cur) => {
      if (!near) return cur;
      const dCur = Phaser.Math.Distance.Between(this.x, this.y, cur.x, cur.y);
      const dNear = Phaser.Math.Distance.Between(
        this.x,
        this.y,
        near.x,
        near.y
      );
      return dCur < dNear ? cur : near;
    }, null);
  }

  /**
   * Returns per-source cumulative emotion deltas, strongest first.
   */
  getEmotionSourceTotals() {
    this.normalizeSoulState();
    const map = this.soul?.source_emotion_totals ?? {};
    const rows = Object.entries(map).map(([sourceId, v]) => ({
      sourceId,
      sourceName: v?.source_name ?? sourceId,
      trust: Number(v?.trust ?? 0),
      fear: Number(v?.fear ?? 0),
      anger: Number(v?.anger ?? 0),
      samples: Number(v?.samples ?? 0),
    }));
    rows.sort((a, b) => {
      const magA = Math.abs(a.trust) + Math.abs(a.fear) + Math.abs(a.anger);
      const magB = Math.abs(b.trust) + Math.abs(b.fear) + Math.abs(b.anger);
      return magB - magA;
    });
    return rows;
  }

  /**
   * Returns the highest-severity recent catalyst statements said by `sourceId`.
   * Useful for logging why this NPC escalated into aggression.
   * @param {string} sourceId
   * @param {number} limit
   * @returns {string[]}
   */
  getTopCatalystStatements(sourceId, limit = 3) {
    const src = String(sourceId ?? '').trim();
    if (!src || !Array.isArray(this._recentCatalysts)) return [];
    const rows = this._recentCatalysts
      .filter(
        (r) =>
          String(r?.sourceId ?? '') === src &&
          String(r?.text ?? '').trim().length > 0
      )
      .sort((a, b) => {
        const scoreDelta = Number(b?.score ?? 0) - Number(a?.score ?? 0);
        if (scoreDelta !== 0) return scoreDelta;
        return Number(b?.ts ?? 0) - Number(a?.ts ?? 0);
      });

    const out = [];
    const seen = new Set();
    for (const r of rows) {
      const text = String(r?.text ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(text);
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * Push a memory entry. Keeps only the most recent MAX_MEMORIES entries,
   * dropping the oldest when full. Each entry is a plain string describing
   * the event — the LLM will receive these as a bullet list.
   * @param {string} text
   */
  addMemory(text) {
    this.normalizeSoulState();
    const MAX_MEMORIES = 12;
    this.soul.memory.push({ event: text, ts: Date.now() });
    if (this.soul.memory.length > MAX_MEMORIES) {
      this.soul.memory.shift();
    }
  }

  /**
   * Returns a compact context object suitable for sending to the LLM endpoint.
   * Does NOT include the full emotion floats — just what the model needs.
   */
  getSoulContext() {
    this.normalizeSoulState();
    const {
      personality,
      emotional_state,
      relationship,
      memory,
      relationship_dynamics,
      source_emotion_totals,
    } = this.soul;
    return {
      name: this.getName(),
      personality,
      emotional_state,
      relationship,
      relationship_dynamics: relationship_dynamics ?? {},
      source_emotion_totals: source_emotion_totals ?? {},
      // Most recent memories, oldest first, as plain strings
      recent_memories: memory.slice(-8).map((m) => m.event),
      recent_intents: (this.soul.intent_log ?? [])
        .slice(-6)
        .map((i) => i.text ?? ''),
    };
  }

  addIntent(text) {
    this.normalizeSoulState();
    const msg = String(text ?? '').trim();
    if (!msg) return;
    const MAX_INTENTS = 12;
    this.soul.intent_log.push({ text: msg, ts: Date.now() });
    if (this.soul.intent_log.length > MAX_INTENTS) {
      this.soul.intent_log.shift();
    }
  }

  /**
   * Set a personality trait in [0, 1].
   * @param {string} key
   * @param {number} value
   */
  setSoulPersonality(key, value) {
    this.normalizeSoulState();
    if (!key) return;
    this.soul.personality[key] = Phaser.Math.Clamp(Number(value) || 0, 0, 1);
  }

  /**
   * Set an emotional trait in [0, 1] and re-derive relationship state.
   * @param {'trust'|'fear'|'anger'} key
   * @param {number} value
   */
  setSoulEmotion(key, value) {
    this.normalizeSoulState();
    if (!key || !(key in this.soul.emotional_state)) return;
    this.soul.emotional_state[key] = Phaser.Math.Clamp(
      Number(value) || 0,
      0,
      1
    );
    this.soul.relationship = _deriveRelationship(this.soul.emotional_state);
  }

  normalizeSoulState() {
    if (!this.soul || typeof this.soul !== 'object') this.soul = _makeSoul();
    if (!Array.isArray(this.soul.memory)) this.soul.memory = [];
    if (!Array.isArray(this.soul.intent_log)) this.soul.intent_log = [];
    if (
      !this.soul.relationship_dynamics ||
      typeof this.soul.relationship_dynamics !== 'object'
    ) {
      this.soul.relationship_dynamics = {};
    }
    if (!this.soul.personality || typeof this.soul.personality !== 'object') {
      this.soul.personality = {};
    }
    if (
      !this.soul.emotional_state ||
      typeof this.soul.emotional_state !== 'object'
    ) {
      this.soul.emotional_state = { trust: 0.5, fear: 0.1, anger: 0.1 };
    }
    if (
      !this.soul.source_emotion_totals ||
      typeof this.soul.source_emotion_totals !== 'object'
    ) {
      this.soul.source_emotion_totals = {};
    }
    if (!this.soul.relationship) {
      this.soul.relationship = _deriveRelationship(this.soul.emotional_state);
    }
  }

  _getRelationshipMetrics(otherId) {
    this.normalizeSoulState();
    if (
      !this.soul.relationship_dynamics ||
      typeof this.soul.relationship_dynamics !== 'object'
    ) {
      this.soul.relationship_dynamics = {};
    }
    if (!this.soul.relationship_dynamics[otherId]) {
      this.soul.relationship_dynamics[otherId] = {
        trust: 0,
        respect: 0,
        anger: 0,
        fear: 0,
        rivalry: 0,
        lastUpdated: Date.now(),
      };
    }
    return this.soul.relationship_dynamics[otherId];
  }

  _decayRelationshipDynamics() {
    this.normalizeSoulState();
    const map = this.soul.relationship_dynamics;
    if (!map || typeof map !== 'object') return;
    const forgiveness = Phaser.Math.Clamp(
      this.soul?.personality?.forgiveness ?? 0.5,
      0,
      1
    );
    const angerDecay = 1.2 + forgiveness * 2.0;
    for (const [otherId, metrics] of Object.entries(map)) {
      if (!metrics || typeof metrics !== 'object') continue;
      metrics.anger = Phaser.Math.Clamp(metrics.anger - angerDecay, -100, 100);
      if (metrics.trust > 35 && metrics.rivalry > 0) {
        metrics.rivalry = Phaser.Math.Clamp(metrics.rivalry - 1.0, -100, 100);
      }
      metrics.lastUpdated = Date.now();
      map[otherId] = metrics;
    }
    if (Array.isArray(this._recentCatalysts)) {
      const now = Date.now();
      this._recentCatalysts = this._recentCatalysts.filter(
        (r) => now - Number(r.ts ?? 0) <= 120_000
      );
    }
  }

  // ── Social / mood behaviour ───────────────────────────────────────────────

  _scheduleSocialTick() {
    const delay =
      SOCIAL_TICK_MIN + Math.random() * (SOCIAL_TICK_MAX - SOCIAL_TICK_MIN);
    this._socialTimer = this.scene?.time.delayedCall(delay, () => {
      if (!this._dead) this._socialTick();
      this._scheduleSocialTick();
    });
  }

  _maybeAutonomousAggro() {
    if (this._dead || !this.scene || !this.taskRunner) return;
    const now = Date.now();
    if (now < Number(this._aggroCooldownUntil ?? 0)) return;

    const status = this.taskRunner.getStatus?.();
    const activeTask = status?.tasks?.[0]?.task ?? '';
    if (
      activeTask === 'attack_nearest_enemy' ||
      activeTask === 'defend_player' ||
      activeTask === 'defend_location'
    )
      return;

    const anger = Phaser.Math.Clamp(
      Number(this.soul?.emotional_state?.anger ?? 0),
      0,
      1
    );
    const aggr = Phaser.Math.Clamp(
      Number(this.soul?.personality?.aggression ?? 0),
      0,
      1
    );
    const trust = Phaser.Math.Clamp(
      Number(this.soul?.emotional_state?.trust ?? 0),
      0,
      1
    );
    const urge = anger * 0.65 + aggr * 0.35;

    // Don't force combat for low-urge NPCs.
    if (urge < 0.58) return;

    let candidates = [];
    const scene = this.scene;
    if (this.faction === 'rival') {
      candidates = [
        ...(scene.npcs ?? []).filter((n) => n && !n._dead),
        scene.player,
      ].filter(Boolean);
    } else {
      candidates = [
        ...(scene.npNPCs ?? []).filter((n) => n && !n._dead),
        ...(scene.enemies ?? []).filter((e) => e && !e.isDead?.()),
      ];
    }
    if (candidates.length === 0) return;

    const nearby = candidates.filter((t) => {
      if (!t || t === this) return false;
      return (
        Phaser.Math.Distance.Between(this.x, this.y, t.x, t.y) <= TILE_SIZE * 10
      );
    });
    if (nearby.length === 0) return;

    // Moderate angry/aggressive: roughly 1/3 chance. Very high urge: almost always.
    const pJoin =
      urge >= 0.9
        ? 0.9
        : Phaser.Math.Clamp(
            0.12 + (urge - 0.58) * 0.75 - trust * 0.1,
            0.1,
            0.45
          );
    if (Math.random() > pJoin) return;

    const target = this.selectCatalystTarget?.(nearby) ?? nearby[0];
    if (!target) return;

    this.addIntent(
      `Enough talking. I am attacking ${target.getName?.() ?? target.id ?? 'them'}.`
    );
    this.taskRunner.pushTask({
      task: 'attack_nearest_enemy',
      target,
      range: TILE_SIZE * 12,
    });
    this._aggroCooldownUntil = now + 10_000;
  }

  async _socialTick() {
    if (this._dead || !this.scene) return;
    // Don't interrupt a bubble that's already showing
    if (this._bubble?.visible) return;

    const mood = _moodScore(this.soul);
    const isHappy = mood > MOOD_HAPPY;
    const isUpset = mood < MOOD_UPSET;
    const scene = this.scene;
    const player = scene.player;
    const allNPCs = scene.npcs ?? [];
    const PROX = SOCIAL_DIST_TILES * TILE_SIZE;

    const playerDist = player
      ? Phaser.Math.Distance.Between(this.x, this.y, player.x, player.y)
      : Infinity;
    const nearPlayer = playerDist <= PROX;
    const playerName = 'boss';

    // Find the nearest other NPC within social range
    let nearestNPC = null;
    let nearestNPCDist = Infinity;
    for (const n of allNPCs) {
      if (n === this || n._dead) continue;
      const d = Phaser.Math.Distance.Between(this.x, this.y, n.x, n.y);
      if (d < PROX && d < nearestNPCDist) {
        nearestNPCDist = d;
        nearestNPC = n;
      }
    }

    // Decide what situation to generate for, then fetch one quip
    let situation = null;
    let otherName = '';
    let targetNPC = null; // if we want a second NPC to also say something
    let targetSit = null;
    let stopTask = false;

    // ── Priority decision tree ─────────────────────────────────────────────
    if (isUpset) {
      const status = this.taskRunner?.getStatus?.();
      const activeTask = status?.tasks?.[0]?.task ?? '';
      const hasTask = status?.running && activeTask !== 'idle';
      const isCombatTask =
        activeTask === 'attack_nearest_enemy' ||
        activeTask === 'defend_player' ||
        activeTask === 'defend_location' ||
        activeTask === 'patrol_area';

      if (hasTask && !isCombatTask && Math.random() < LAZY_CHANCE) {
        situation = 'lazy_complaint';
        stopTask = true;
      } else if (nearPlayer && Math.random() < 0.5) {
        situation =
          this.soul.relationship === 'hostile'
            ? 'hostile_player'
            : 'upset_player';
        otherName = playerName;
      }
    }

    if (!situation && isHappy) {
      if (nearPlayer && Math.random() < 0.55) {
        situation = 'happy_player';
        otherName = playerName;
      } else if (
        nearestNPC &&
        !nearestNPC._bubble?.visible &&
        Math.random() < 0.4
      ) {
        situation = 'happy_npc';
        otherName = nearestNPC.getName();
        targetNPC = nearestNPC;
        targetSit = 'npc_reply';
      }
    }

    if (
      !situation &&
      nearestNPC &&
      !nearestNPC._bubble?.visible &&
      Math.random() < 0.25
    ) {
      situation = 'greet_npc';
      otherName = nearestNPC.getName();
      targetNPC = nearestNPC;
      targetSit = 'greet_npc';
    }

    if (
      !situation &&
      nearPlayer &&
      (this.soul.relationship === 'allied' ||
        this.soul.relationship === 'devoted') &&
      Math.random() < 0.3
    ) {
      situation = 'greet_player';
      otherName = playerName;
    }

    if (!situation) return;

    // Stop task before fetching so the NPC visually stops immediately
    if (stopTask) this.taskRunner.stop();

    // Fetch both quips in parallel if there's a target NPC response
    const quipPromise = _fetchQuip(this, situation, otherName);
    const replyPromise = targetNPC
      ? _fetchQuip(targetNPC, targetSit, this.getName())
      : null;

    const [quip, reply] = await Promise.all([
      quipPromise,
      replyPromise ?? Promise.resolve(null),
    ]);

    // Guard: NPC might have died or scene might have changed while we awaited
    if (this._dead || !this.scene) return;

    if (quip) this.showBubble(quip, 6000);
    if (reply && targetNPC && !targetNPC._dead) {
      // Small delay so reply comes ~1.5s after the opening line
      this.scene.time.delayedCall(1500, () => {
        if (!targetNPC._dead) targetNPC.showBubble(reply, 5000);
      });
    }
  }

  destroy(fromScene) {
    this._socialTimer?.remove();
    this._bubbleTimer?.remove();
    this._respawnTimer?.remove();
    this._assignmentGraphics?.destroy();
    super.destroy(fromScene);
  }
}

// ── Mood helpers ──────────────────────────────────────────────────────────────

/** Mood score: positive = good mood, negative = bad mood. Range roughly -1 to +1. */
function _moodScore(soul) {
  if (!soul?.emotional_state) return 0;
  const { trust = 0.3, anger = 0.1 } = soul.emotional_state;
  return trust - anger;
}

/**
 * Fetch a single spontaneous quip from the auxserver.
 * Returns the quip string, or null if the server is unreachable.
 */
async function _fetchQuip(npc, situation, otherName = '') {
  try {
    const res = await fetch('http://127.0.0.1:8001/npc_quip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        npc_id: npc.id,
        soul: npc.getSoulContext?.() ?? {},
        situation,
        other_name: otherName,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.quip ?? null;
  } catch {
    return null;
  }
}

// ── Soul helpers ──────────────────────────────────────────────────────────────

/**
 * Relationship stages derived from emotional state.
 * trust and anger are the primary drivers; fear modulates.
 */
function _deriveRelationship(em) {
  const { trust, anger, fear } = em;
  if (anger > 0.7) return 'hostile';
  if (trust < 0.2 && fear > 0.5) return 'hostile';
  if (trust < 0.25) return 'wary';
  if (anger > 0.4) return 'wary';
  if (trust >= 0.75 && anger < 0.15) return 'devoted';
  if (trust >= 0.5) return 'allied';
  return 'neutral';
}

/**
 * Spawn a fresh soul with randomised personality and neutral-ish emotional state.
 * Personalities are sampled from loose archetypes so NPCs feel distinct.
 */
function _makeSoul() {
  const r = (lo, hi) => parseFloat((lo + Math.random() * (hi - lo)).toFixed(2));

  // Pick a rough archetype then add noise so no two are identical
  const archetypes = [
    {
      cooperation: r(0.6, 1.0),
      aggression: r(0.0, 0.2),
      neuroticism: r(0.1, 0.4),
    }, // friendly
    {
      cooperation: r(0.5, 0.8),
      aggression: r(0.1, 0.3),
      neuroticism: r(0.3, 0.5),
    }, // easygoing
    {
      cooperation: r(0.4, 0.7),
      aggression: r(0.1, 0.3),
      neuroticism: r(0.4, 0.7),
    }, // anxious
    {
      cooperation: r(0.5, 0.8),
      aggression: r(0.1, 0.3),
      neuroticism: r(0.1, 0.3),
    }, // stoic
    {
      cooperation: r(0.6, 0.9),
      aggression: r(0.0, 0.2),
      neuroticism: r(0.2, 0.5),
    }, // warm
  ];
  const base = archetypes[Math.floor(Math.random() * archetypes.length)];

  // Starting emotional state — regular NPCs begin clearly allied toward player
  const startTrust = r(0.62, 0.88);
  const startFear = r(0.0, 0.15);
  const startAnger = r(0.0, 0.08);

  return {
    personality: {
      cooperation: base.cooperation,
      aggression: base.aggression,
      neuroticism: base.neuroticism,
      pride: r(0.2, 0.85),
      impulse_control: r(0.25, 0.9),
      forgiveness: r(0.2, 0.9),
    },
    emotional_state: {
      trust: startTrust,
      fear: startFear,
      anger: startAnger,
    },
    relationship: _deriveRelationship({
      trust: startTrust,
      fear: startFear,
      anger: startAnger,
    }),
    relationship_dynamics: {},
    memory: [],
    intent_log: [],
  };
}

function _makeResponseProfile() {
  return {
    attackCatalystThreshold: Phaser.Math.Between(10, 20),
  };
}
