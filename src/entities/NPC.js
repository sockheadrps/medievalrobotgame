// NPC — a robot companion that the player builds from 10 logs.
// Has HP/STR/DEF stats, a soul/personality system, and responds to chat via LLM.

import Phaser from 'phaser';
import {
  NPC_KEY,
  TILE_SIZE,
  NPC_FRAME_H,
  NFRAME_FACE_DOWN, NFRAME_FACE_UP, NFRAME_FACE_RIGHT, NFRAME_FACE_LEFT,
  NFRAME_WALK1_DOWN, NFRAME_WALK1_UP, NFRAME_WALK1_RIGHT, NFRAME_WALK1_LEFT,
  NFRAME_PUNCH_RIGHT, NFRAME_PUNCH_LEFT,
  KI_MAX_BASE, KI_MAX_PER_LEVEL, KI_REGEN_MS, KI_BLAST_BASE_COST, KI_BLAST_BASE_DMG, KI_BLAST_SCALE,
} from '../constants.js';
import { createBarrierOverlay, syncBarrierOverlay } from './BarrierOverlay.js';
import { createEquipmentOverlay, syncEquipmentOverlay } from './EquipmentOverlay.js';
import NPCPersonality from '../systems/NPCPersonality.js';

const HP_REGEN_MS = 30000;
const SCALE = TILE_SIZE / NPC_FRAME_H; // 48/32 = 1.5
const ARRIVE_D = 8;

// NPC frame → baseplayer frame mapping (for equipment overlay remap)
const NPC_TO_BASE = {
  0: 0, 1: 1, 2: 2, 3: 3,       // face down/up/right/left
  36: 4, 37: 5, 38: 6, 39: 7,    // walk1 down/up/right/left
  54: 26, 55: 25,                  // punch right/left
};

// Emotion decay — emotions drift toward baseline every DECAY_INTERVAL ms
const EMOTION_DECAY_INTERVAL = 2000; // 2 seconds
const EMOTION_DECAY_RATE = 0.02;       // base decay rate per interval
const OWNER_DECAY_MULT   = 0.2;       // owner emotions decay 5x slower (1/5)
const OTHER_DECAY_MULT   = 0.15;      // other players' emotions decay much slower (~11 min full decay)
const DEFAULT_TRUST_BASELINE = 0.5;  // starting baseline
const DEFAULT_FEAR_BASELINE  = 0.0;
const DEFAULT_ANGER_BASELINE = 0.0;

// Baseline drift — sustained high emotions permanently shift the baseline
const BASELINE_THRESHOLD = 0.9;       // emotion must be above this to count
const BASELINE_ACCUM_INTERVAL = 5000; // every 5s above threshold
const BASELINE_SHIFT = 0.01;          // +0.01 per tick of sustained high emotion
const BASELINE_CAP = 0.85;            // baselines can never exceed this

// Escalation — repeated interactions without a pause double impact each time
const ESCALATION_MAX = 16;            // cap at 16x multiplier
const ESCALATION_COOLDOWN = 30000;    // 30s of no interaction resets escalation

// Memory decay
const MEMORY_DECAY_INTERVAL = 60000; // 60 seconds
const MEMORY_IMPORTANCE_DECAY = 0.02; // importance lost per interval
const MEMORY_PRUNE_THRESHOLD = 0.1;  // memories below this get pruned
const MAX_MEMORIES = 30;

let _nextId = 1;

export class NPC extends Phaser.GameObjects.Sprite {

  constructor(scene, x, y, name, ownerId) {
    super(scene, x, y, NPC_KEY, NFRAME_FACE_DOWN);
    scene.add.existing(this);

    this.setScale(SCALE);
    this.setOrigin(0.5, 1);
    this.setDepth(2);
    this.setInteractive({ useHandCursor: true });

    const prefix = ownerId ? `${ownerId}_` : '';
    this.id   = `${prefix}npc_${_nextId++}`;
    this._name = name ?? `Robot-${_nextId - 1}`;

    // Stats
    this.maxHp = 15;
    this.hp    = this.maxHp;
    this.str   = 1;
    this.def   = 1;
    this.level = 1;
    this.xp    = 0;
    this._dead = false;
    this._knockedOut = false;
    this._knockedUntil = 0;
    this._carriedBy = null;
    this._regenAccum = 0;

    // Ki pool
    this.maxKi = KI_MAX_BASE;
    this.ki    = this.maxKi;
    this.infKi = false;
    this._kiRegenAccum = 0;
    this.blastLevel = 0;
    this.crystals = 0;
    this.kiMoves = ['absorb'];
    this.kiBlastBonuses = { blast_speed: 0, blast_range: 0, blast_dmg: 0, blast_cooldown: 0, barrier_duration: 0, barrier_cooldown: 0 };
    this._emotionDecayAccum = 0;
    this._memoryDecayAccum = 0;
    this._emotionReactAccum = 0; // periodic check for emotion-driven behavior
    this._emotionReactTarget = null; // current emotion-driven target { action, playerId/entityId, entityType }

    // Intel — whether this NPC can see attacker stats (future item unlocks this)
    this._canSeeStats = false;

    // Equipment
    this.equipment = {};  // slot -> eq_id
    this._equipOverlays = {};

    // Inventory — capacity scales with level
    this.logs    = 0;
    this.maxLogs = this._calcMaxLogs();
    this.stones  = 0;

    // Movement
    this._moveTarget = null;
    this._pathWaypoints = null; // BFS waypoints for fence avoidance
    this._pathTargetKey = null;
    this._pathAge = 0;
    this._baseSpeed  = 100;
    this._facing     = 'down';
    this._punching   = false;

    // Soul / personality
    this.soul = _makeSoul();
    // NPCPersonality instance — holds personality type + runtime personality state
    // (phrases, per-personality memory, relationship deltas).
    // Emotion decay and the authoritative soul object remain on NPC.js.
    this.personality = new NPCPersonality(this.soul.personality.type);
    // Behavioral modifiers derived from personality type
    this._personalityMod = getPersonalityModifiers(this.soul.personality.type);

    // Name label
    this._nameLabel = scene.add.text(x, y - TILE_SIZE - 10, this._name, {
      fontSize: '9px', color: '#aaddff', backgroundColor: '#00000088',
      padding: { x: 3, y: 1 },
    }).setOrigin(0.5, 1).setDepth(3);

    // Speech bubble
    this._bubble = scene.add.text(x, y - TILE_SIZE - 22, '', {
      fontSize: '9px', color: '#ffffff', backgroundColor: '#00000099',
      padding: { x: 4, y: 3 }, wordWrap: { width: 160 },
    }).setOrigin(0.5, 1).setDepth(10).setVisible(false);
    this._bubbleTimer = null;

    // Selection ring
    this._ring = scene.add.circle(x, y - 6, 20, 0x22d8ff, 0.34)
      .setStrokeStyle(3, 0x88f3ff, 0.9)
      .setDepth(1).setVisible(false);
    this._ringPulse = scene.add.circle(x, y - 6, 28, 0x22d8ff, 0.1)
      .setStrokeStyle(2, 0x22d8ff, 0.6)
      .setDepth(1).setVisible(false);

    // HP bar
    this._hpBarBg = scene.add.rectangle(x - 20, y - TILE_SIZE - 2, 40, 4, 0x333333)
      .setOrigin(0, 0.5).setDepth(3);
    this._hpBar = scene.add.rectangle(x - 20, y - TILE_SIZE - 2, 40, 4, 0x44ff44)
      .setOrigin(0, 0.5).setDepth(3);

    // Ki bar (below HP bar)
    this._kiBarBg = scene.add.rectangle(x - 20, y - TILE_SIZE + 3, 40, 3, 0x222233)
      .setOrigin(0, 0.5).setDepth(3);
    this._kiBar = scene.add.rectangle(x - 20, y - TILE_SIZE + 3, 40, 3, 0x4488ff)
      .setOrigin(0, 0.5).setDepth(3);
    this._barrierOverlay = createBarrierOverlay(scene, this);

    this._ensureAnims(scene);
  }

  // ── Getters / setters ─────────────────────────────────────────────────────

  getName()       { return this._name; }
  setName(name)   { this._name = name; this._nameLabel?.setText(name); }
  isDead()        { return this._dead; }
  isKnockedOut()  { return this._knockedOut; }
  getFacing()     { return this._facing; }

  /** Effective movement speed — personality base * emotion modifiers. */
  getEffectiveSpeed() {
    const base = this._baseSpeed * (this._personalityMod?.speed ?? 1.0);
    const rel = this._getOwnerRelationship();
    const fear = rel?.fear ?? 0;
    const anger = rel?.anger ?? 0;
    // Afraid NPCs move faster (fleeing instinct), angry NPCs charge slightly faster
    return base * (1 + fear * 0.3 + anger * 0.15);
  }

  /** Get the owner relationship (for emotion-driven modifiers). */
  _getOwnerRelationship() {
    const ownerId = this.scene?.playerId || 'default';
    return this.soul.relationships[ownerId] || this.soul.relationships['default'];
  }

  /** Play punch frame toward a target. */
  playAttack(targetX) {
    if (this._punching) return;
    this._punching = true;

    const side = targetX < this.x ? 'left' : 'right';
    this.setFlipX(false);
    this.stop();
    this.setFrame(side === 'left' ? NFRAME_PUNCH_LEFT : NFRAME_PUNCH_RIGHT);

    this.scene?.time.delayedCall(300, () => {
      this._punching = false;
    });
  }

  // ── HP / Combat ───────────────────────────────────────────────────────────

  takeDamage(amount) {
    const dmg = Math.max(1, amount - Math.floor(this.def / 2));
    this.hp = Math.max(0, this.hp - dmg);
    this._regenAccum = 0;
    if (this.hp <= 0) this._triggerDeath();
    return this.hp <= 0;
  }

  heal(amount) {
    this.hp = Math.min(this.maxHp, this.hp + amount);
  }

  showHealEffect(amount = 1) {
    const scene = this.scene;
    if (!scene?.add || !scene?.tweens || amount <= 0) return;
    const healText = scene.add.text(this.x, this.y - TILE_SIZE, `+${amount}`, {
      fontSize: '11px', color: '#6dff8a', fontStyle: 'bold',
      backgroundColor: '#103018cc', padding: { x: 4, y: 2 },
    }).setOrigin(0.5, 1).setDepth(20);
    scene.tweens.add({
      targets: healText,
      y: healText.y - 16,
      alpha: 0,
      duration: 900,
      onComplete: () => healText.destroy(),
    });
  }

  grantXP(amount, reason = '') {
    const xp = Math.max(0, Math.floor(amount || 0));
    if (xp <= 0) return false;

    this.xp = (this.xp ?? 0) + xp;
    let leveled = false;
    while (this.xp >= this.level * 20) {
      this.xp -= this.level * 20;
      this.level += 1;
      this.maxHp += 2;
      this.hp = this.maxHp;
      this.str += 1;
      this.def += 1;
      this.maxKi = Math.max(this.maxKi, KI_MAX_BASE + Math.max(0, this.level - 1) * KI_MAX_PER_LEVEL);
      this.ki = this.maxKi;
      this.maxLogs = this._calcMaxLogs();
      leveled = true;
    }

    const scene = this.scene;
    if (scene?.add && scene?.tweens) {
      const xpText = scene.add.text(this.x + 15, this.y - TILE_SIZE + 10, `+${xp} XP`, {
        fontSize: '10px', color: '#44ff44',
      }).setOrigin(0.5, 1).setDepth(20);
      scene.tweens.add({
        targets: xpText,
        y: xpText.y - 15,
        alpha: 0,
        duration: 1000,
        onComplete: () => xpText.destroy(),
      });

      if (leveled) {
        const levelText = scene.add.text(this.x, this.y - TILE_SIZE, `${this.getName()} Level ${this.level}!`, {
          fontSize: '14px', color: '#ffff44', fontStyle: 'bold',
          backgroundColor: '#00000099', padding: { x: 4, y: 2 },
        }).setOrigin(0.5, 1).setDepth(20);
        scene.tweens.add({
          targets: levelText,
          y: levelText.y - 30,
          alpha: 0,
          duration: 2000,
          onComplete: () => levelText.destroy(),
        });
      }
    }

    if (reason) this._lastXpReason = reason;
    return leveled;
  }

  /** Current ki blast cost, reduced 2% per blast level (compound). */
  getBlastCost() {
    return Math.max(1, Math.round(KI_BLAST_BASE_COST * Math.pow(1 - KI_BLAST_SCALE, this.blastLevel)));
  }

  /** Current ki blast damage, increased 2% per blast level (compound). */
  getBlastDmg() {
    return Math.max(1, Math.round(KI_BLAST_BASE_DMG * Math.pow(1 + KI_BLAST_SCALE, this.blastLevel)));
  }

  /** Try to fire a ki blast. Returns { cost, dmg } or null if not enough ki. */
  tryBlast() {
    const cost = this.getBlastCost();
    if (this.infKi) {
      this.ki = this.maxKi;
      const dmg = this.getBlastDmg();
      this.blastLevel += 1;
      return { cost: 0, dmg };
    }
    if (this.ki < cost) return null;
    this.ki -= cost;
    this._kiRegenAccum = 0;
    const dmg = this.getBlastDmg();
    this.blastLevel += 1;
    return { cost, dmg };
  }

  _triggerDeath() {
    this._dead = true;
    this._knockedOut = false;
    this.setVisible(false);
    this._nameLabel?.setVisible(false);
    this._hpBar?.setVisible(false);
    this._hpBarBg?.setVisible(false);
    this._kiBar?.setVisible(false);
    this._kiBarBg?.setVisible(false);
    this._ring?.setVisible(false);
    this.hideBubble();

    // Respawn after 10s
    this.scene?.time.delayedCall(10000, () => this._respawn());
  }

  _respawn() {
    this._dead = false;
    this._knockedOut = false;
    this._carriedBy = null;
    this.hp = this.maxHp;
    this.ki = this.maxKi;
    this.clearTint();
    this.setAlpha(1);
    this.setVisible(true);
    this._nameLabel?.setVisible(true);
    this._hpBar?.setVisible(true);
    this._hpBarBg?.setVisible(true);
    this._kiBar?.setVisible(true);
    this._kiBarBg?.setVisible(true);
  }

  setKnockedOut(on, opts = {}) {
    this._knockedOut = !!on;
    this._knockedUntil = opts.knockedUntil ?? this._knockedUntil ?? 0;
    this._carriedBy = opts.carriedBy ?? null;
    if (this._knockedOut) {
      this.hp = 0;
      this.stopMoving();
      this.hideBubble();
      this.setTint(0x777777);
      this.setAlpha(0.65);
    } else if (!this._dead) {
      this.clearTint();
      this.setAlpha(1);
    }
  }

  // ── Movement ──────────────────────────────────────────────────────────────

  moveTo(wx, wy) {
    this._moveTarget = { x: wx, y: wy };
  }

  stopMoving() {
    this._moveTarget = null;
    this._pathWaypoints = null;
    this._pathTargetKey = null;
  }

  /** Try to move by (mx, my), respecting fence/gate collision. */
  _tryMove(mx, my) {
    const newX = this.x + mx;
    const newY = this.y + my;
    const blocked = this._isBarrierAt(newX, newY);
    if (blocked) {
      // Try axis sliding
      if (!this._isBarrierAt(newX, this.y)) {
        this.x = newX;
        return true;
      }
      if (!this._isBarrierAt(this.x, newY)) {
        this.y = newY;
        return true;
      }
      return false;
    }
    this.x = newX;
    this.y = newY;
    return true;
  }

  /** Check if a position overlaps a fence/gate that blocks this NPC. */
  _isBarrierAt(x, y) {
    const scene = this.scene;
    if (!scene?._buildingSprites) return false;
    const TILE = 48; // TILE_SIZE
    const col = Math.floor(x / TILE);
    const row = Math.floor(y / TILE);
    const ownerId = scene.playerId || 'default';
    for (const entity of Object.values(scene._buildingSprites)) {
      if (entity._kind !== 'fence' && entity._kind !== 'gate') continue;
      if (entity.col !== col || entity.row !== row) continue;
      // Owner's NPCs can pass through owner's gates
      if (entity._kind === 'gate' && entity._owner === ownerId) continue;
      return true;
    }
    return false;
  }

  /** Pathfinding stub — no obstacles currently. Returns null (direct path). */
  _findPath(fromX, fromY, toX, toY) {
    return null;
  }

  getSpeed() {
    const base = this.getEffectiveSpeed();
    const fillPct = this.maxLogs > 0 ? this.logs / this.maxLogs : 0;
    if (fillPct <= 0.75) return base;
    // Linear slowdown from 100% speed at 75% full to 60% speed at 100% full
    const overPct = (fillPct - 0.75) / 0.25; // 0..1
    const slowFactor = 1 - overPct * 0.4;    // 1.0..0.6
    return base * slowFactor;
  }

  /** Max logs capacity based on level: 5 + level * 5 */
  _calcMaxLogs() {
    return 5 + this.level * 5;
  }

  /** Check if inventory is full. */
  isInventoryFull() {
    return this.logs >= this.maxLogs;
  }

  // ── Visual ────────────────────────────────────────────────────────────────

  select()   { this._ring?.setVisible(true); this._ringPulse?.setVisible(true); }
  deselect() { this._ring?.setVisible(false); this._ringPulse?.setVisible(false); }

  showBubble(text, durationMs = 5000, { silent = false } = {}) {
    if (!this._bubble) return;
    // Scale bubble duration by personality — Berserkers are terse, Caretakers linger
    const durMod = this._personalityMod?.bubbleDuration ?? 1.0;
    const effectiveDur = Math.round(durationMs * durMod);
    this._bubble.setText(text).setVisible(true);
    if (this._bubbleTimer) this._bubbleTimer.remove();
    this._bubbleTimer = this.scene?.time.delayedCall(effectiveDur, () => {
      if (this._bubble) this._bubble.setVisible(false);
      this._bubbleTimer = null;
    });
    // Log to chat unless silent
    if (!silent && this.scene?.chatBox) {
      this.scene.chatBox._addLog(`${this.getName()}: ${text}`, '#aaddff');
    }
  }

  hideBubble() {
    if (this._bubble) this._bubble.setVisible(false);
    if (this._bubbleTimer) { this._bubbleTimer.remove(); this._bubbleTimer = null; }
  }

  // ── Soul API ──────────────────────────────────────────────────────────────

  /** Apply emotion deltas with escalation. Returns the actual scaled deltas. */
  applyEmotionDeltas(deltas, playerId = 'default') {
    const rel = this._getRelationship(playerId);
    const now = Date.now();
    // Reset escalation if cooldown has elapsed since last interaction
    if (now - (rel._lastInteraction ?? 0) > ESCALATION_COOLDOWN) {
      rel._escalation = 1;
    }
    const esc = rel._escalation ?? 1;
    const actual = {};
    for (const [key, val] of Object.entries(deltas)) {
      if (key in rel) {
        const scaled = Number(val) * esc;
        const before = rel[key];
        rel[key] = Phaser.Math.Clamp(before + scaled, 0, 1);
        actual[key] = rel[key] - before; // actual change after clamping
      }
    }
    // Double escalation for next interaction (capped)
    rel._escalation = Math.min(esc * 2, ESCALATION_MAX);
    rel._lastInteraction = now;
    rel.label = _deriveRelationship(rel);
    return actual;
  }

  addMemory(text, type = 'event', playerId = null, importance = 1.0) {
    const bucket = playerId ?? 'global';
    if (!this.soul.memories[bucket]) this.soul.memories[bucket] = [];
    const arr = this.soul.memories[bucket];
    arr.push({ text, type, ts: Date.now(), importance });
    // Sort by importance (descending) and prune excess
    arr.sort((a, b) => (b.importance ?? 0.5) - (a.importance ?? 0.5));
    while (arr.length > MAX_MEMORIES) arr.pop();
  }

  /**
   * Learn a phrase from the owner's speech. NPCs pick up nicknames, insults,
   * catchphrases, and distinctive expressions their owner uses frequently.
   */
  /**
   * Learn a phrase from the owner's speech.
   * Thin wrapper — delegates to NPCPersonality.learnPhrase and keeps
   * soul.learned_phrases in sync so serialisation is unaffected.
   *
   * Emotion logic lives in NPC.js; personality metadata lives in NPCPersonality.
   */
  learnPhrase(phraseData) {
    // Delegate to NPCPersonality (canonical logic lives there)
    this.personality.learnPhrase(phraseData);
    // Keep soul.learned_phrases in sync for persistence / getSoulContext callers
    this.soul.learned_phrases = this.personality.phrases;
  }

  getSoulContext(playerId = 'default') {
    const rel = this._getRelationship(playerId);
    const p = this.soul.personality;

    // Effective personality = base + per-player mods
    const effectivePersonality = {
      type: p.type || '',
      cooperation: Phaser.Math.Clamp(p.cooperation + (rel.cooperation_mod || 0), 0, 1),
      aggression:  Phaser.Math.Clamp(p.aggression  + (rel.aggression_mod  || 0), 0, 1),
      neuroticism: p.neuroticism,
    };

    // Merge player-specific + global memories, weighted by importance * recency
    const playerMems = this.soul.memories[playerId] || [];
    const globalMems = this.soul.memories['global'] || [];
    const now = Date.now();
    const allMems = [...playerMems, ...globalMems]
      .map(m => {
        const ageSec = (now - m.ts) / 1000;
        const recency = Math.max(0.1, 1 - ageSec / 600); // fades over 10 min
        const imp = m.importance ?? 0.5;
        return { ...m, weight: imp * recency };
      })
      .sort((a, b) => b.weight - a.weight) // best memories first
      .slice(0, 12)
      .map(m => m.text);

    // Collect learned phrases (sorted by most-used first) with tone/usage context
    const phrases = (this.soul.learned_phrases || [])
      .slice().sort((a, b) => b.uses - a.uses)
      .slice(0, 6)
      .map(p => {
        const tags = [];
        if (p.usage && p.usage !== 'catchphrase') tags.push(p.usage);
        if (p.tone && p.tone !== 'neutral') tags.push(p.tone);
        return tags.length > 0 ? `${p.phrase} (${tags.join(', ')})` : p.phrase;
      });

    return {
      name: this.getName(),
      personality: effectivePersonality,
      emotional_state: { trust: rel.trust, fear: rel.fear, anger: rel.anger },
      relationship: rel.label,
      memories: allMems,
      learned_phrases: phrases,
    };
  }

  /** Build target-specific relationship context for dialogue about another entity. */
  getContextAboutEntity(entityId, displayName = '') {
    if (!entityId) return null;
    const rel = this.soul.relationships?.[entityId] || null;
    const mems = this.soul.memories?.[entityId] || [];
    const now = Date.now();
    const topMemories = mems
      .map(m => {
        const ageSec = (now - m.ts) / 1000;
        const recency = Math.max(0.1, 1 - ageSec / 600);
        const imp = m.importance ?? 0.5;
        return { ...m, weight: imp * recency };
      })
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 5)
      .map(m => m.text);

    return {
      id: entityId,
      name: displayName || entityId.replace(/^npc:/, ''),
      type: entityId.startsWith('npc:') ? 'npc' : 'player',
      relationship: rel?.label || 'unknown',
      emotional_state: rel ? { trust: rel.trust, fear: rel.fear, anger: rel.anger } : null,
      memories: topMemories,
    };
  }

  /** Get or create a per-player relationship entry. */
  _getRelationship(playerId = 'default') {
    if (!this.soul.relationships[playerId]) {
      this.soul.relationships[playerId] = _makeRelationship();
    }
    return this.soul.relationships[playerId];
  }

  /** Get the relationship label for a player (for display). */
  getRelationshipLabel(playerId = 'default') {
    return this._getRelationship(playerId).label;
  }

  /** Get emotional state for a player (for display). */
  getEmotionalState(playerId = 'default') {
    const rel = this._getRelationship(playerId);
    return { trust: rel.trust, fear: rel.fear, anger: rel.anger };
  }

  /**
   * Check if this NPC should react to a specific entity based on emotions.
   * Returns: null (no reaction), or { action: 'attack'|'flee', playerId, entityType }
   */
  getEmotionReaction(entityId) {
    const rel = this.soul.relationships[entityId];
    if (!rel) return null;
    const entityType = entityId.startsWith('npc:') ? 'npc' : 'player';
    // High anger → attack on sight
    if (rel.anger > 0.7) return { action: 'attack', playerId: entityId, entityType };
    // High fear → flee
    if (rel.fear > 0.5) return { action: 'flee', playerId: entityId, entityType };
    return null;
  }

  /**
   * Check if this NPC should obey a command from a given player.
   * Owner always obeyed. Non-owners only obeyed under coercion (high fear).
   */
  shouldObey(playerId) {
    const ownerId = this.scene?.playerId || 'default';
    if (playerId === ownerId || playerId === 'default') return true;
    const rel = this.soul.relationships[playerId];
    if (!rel) return false;
    // Only obey non-owners if terrified (fear > 0.6)
    return rel.fear > 0.6;
  }

  /**
   * Assess a threat and decide whether to fight or flee.
   * @param {object} attacker - { type: 'player'|'npc', id, hp, maxHp, str, def, level? }
   * @returns {{ action: 'fight'|'flee', confidence: number, reason: string }}
   */
  assessThreat(attacker) {
    const pers = this.soul.personality;
    const aggression = pers.aggression ?? 0.3;
    const cooperation = pers.cooperation ?? 0.5;
    const neuroticism = pers.neuroticism ?? 0.35;
    const myHpPct = this.hp / this.maxHp;

    // Base fight score from personality — aggressive NPCs want to fight
    let fightScore = aggression * 0.4 + (1 - neuroticism) * 0.15;

    // Relationship-based: high anger toward attacker → fight, high fear → flee
    const relKey = attacker.type === 'npc' ? `npc:${attacker.id}` : attacker.id;
    const rel = this.soul.relationships[relKey];
    if (rel) {
      fightScore += rel.anger * 0.25;   // rage makes you want to fight
      fightScore -= rel.fear * 0.3;     // fear makes you want to flee
    }

    // HP-based: low HP → flee unless very aggressive
    if (myHpPct < 0.2)      fightScore -= 0.4;
    else if (myHpPct < 0.4) fightScore -= 0.2;
    else if (myHpPct > 0.7) fightScore += 0.1;

    // If NPC can see attacker stats, use them to make an informed decision
    let reason = '';
    if (this._canSeeStats && attacker.level != null) {
      const levelDiff = (attacker.level ?? 1) - this.level;
      const strDiff = (attacker.str ?? 1) - this.str;
      const defAdv = this.def - (attacker.str ?? 1);

      if (levelDiff >= 3) {
        fightScore -= 0.35;
        reason = `outleveled by ${levelDiff}`;
      } else if (levelDiff >= 1) {
        fightScore -= 0.1 * levelDiff;
        reason = `slightly outleveled`;
      } else if (levelDiff <= -2) {
        fightScore += 0.2;
        reason = `I'm stronger`;
      }

      if (strDiff > 2) fightScore -= 0.15;
      if (defAdv > 2) fightScore += 0.15;

      // Can see attacker HP — wounded attacker is easier prey
      const attackerHpPct = (attacker.hp ?? attacker.maxHp ?? 15) / (attacker.maxHp ?? 15);
      if (attackerHpPct < 0.3) { fightScore += 0.2; reason = `attacker is wounded`; }
    } else {
      // Can't see stats — rely purely on personality + emotions + own HP
      reason = 'unknown threat';
      // Slightly bias toward caution when blind
      fightScore -= 0.05;
    }

    // Clamp
    fightScore = Math.max(0, Math.min(1, fightScore));

    const action = fightScore >= 0.45 ? 'fight' : 'flee';
    return { action, confidence: Math.abs(fightScore - 0.45) + 0.5, reason };
  }

  /**
   * Scan nearby remote players AND NPCs for emotion-driven reactions.
   * Returns { action: 'attack'|'flee', playerId, entityType } or null.
   */
  _scanForEmotionReaction() {
    const scene = this.scene;
    if (!scene) return null;

    const REACT_RANGE = 6 * TILE_SIZE; // 6 tiles
    let best = null;
    let bestDist = REACT_RANGE;

    // Scan remote players
    for (const [pid, rp] of Object.entries(scene._remotePlayers || {})) {
      if (rp.isDead?.()) continue;
      const dist = Phaser.Math.Distance.Between(this.x, this.y, rp.x, rp.y);
      if (dist > REACT_RANGE) continue;

      const reaction = this.getEmotionReaction(pid);
      if (reaction && dist < bestDist) {
        best = reaction;
        bestDist = dist;
      }
    }

    // Scan remote NPCs (other players' NPCs)
    for (const [key, rnpc] of Object.entries(scene._remoteNPCSprites || {})) {
      if (rnpc.isDead?.()) continue;
      const dist = Phaser.Math.Distance.Between(this.x, this.y, rnpc.x, rnpc.y);
      if (dist > REACT_RANGE) continue;

      const relKey = `npc:${rnpc.npcId}`;
      const reaction = this.getEmotionReaction(relKey);
      if (reaction && dist < bestDist) {
        best = reaction;
        bestDist = dist;
      }
    }

    return best;
  }

  /** Serialize full NPC state for server persistence. */
  serialize() {
    return {
      id: this.id,
      name: this._name,
      x: this.x,
      y: this.y,
      stats: { maxHp: this.maxHp, hp: this.hp, str: this.str, def: this.def, level: this.level, xp: this.xp, logs: this.logs, stones: this.stones, crystals: this.crystals, maxKi: this.maxKi, ki: this.ki, infKi: !!this.infKi, blastLevel: this.blastLevel, hasKiBlast: !!this._hasKiBlast, kiMoves: this.kiMoves ?? [], kiBlastBonuses: this.kiBlastBonuses ?? {}, equipment: this.equipment ?? {} },
      map: this._map || null,
      soul: this.soul,
    };
  }

  /** Restore NPC state from saved data. */
  loadFrom(data) {
    if (data.id) this.id = data.id;
    if (data.map) this._map = data.map;
    if (data.name) this.setName(data.name);
    if (data.stats) {
      this.maxHp = data.stats.maxHp ?? this.maxHp;
      this.hp    = data.stats.hp ?? this.hp;
      this.str   = data.stats.str ?? this.str;
      this.def   = data.stats.def ?? this.def;
      this.level = data.stats.level ?? this.level;
      this.xp    = data.stats.xp ?? this.xp;
      this.logs  = data.stats.logs ?? this.logs;
      this.stones = data.stats.stones ?? this.stones;
      this.crystals = data.stats.crystals ?? this.crystals;
      this.barrierProcUntil = Number(data.stats.barrierProcUntil ?? data.barrier_proc_until ?? this.barrierProcUntil);
      this.barrierProcFacing = data.stats.barrierProcFacing ?? data.barrier_proc_facing ?? this.barrierProcFacing;
      this.maxLogs = this._calcMaxLogs();
      this.maxKi = data.stats.maxKi ?? this.maxKi;
      this.ki    = data.stats.ki ?? this.ki;
      this.infKi = !!(data.stats.infKi ?? data.inf_ki ?? this.infKi);
      this.blastLevel = data.stats.blastLevel ?? this.blastLevel;
      if (Array.isArray(data.stats.kiMoves)) this.kiMoves = data.stats.kiMoves;
      this.kiBlastBonuses = (data.stats.kiBlastBonuses && typeof data.stats.kiBlastBonuses === 'object') ? { ...this.kiBlastBonuses, ...data.stats.kiBlastBonuses } : this.kiBlastBonuses;
      if (data.stats.hasKiBlast) this._hasKiBlast = true;
      if (data.stats.equipment) this.equipment = { ...data.stats.equipment };
    }
    if (data.soul) {
      const savedDrives = data.soul.drives;
      const mergedDrives = { ..._makeDefaultDrives() };
      if (savedDrives && typeof savedDrives === 'object') {
        for (const k of ['aggression','attachment','curiosity','greed','social','survival','ambition']) {
          if (typeof savedDrives[k] === 'number') mergedDrives[k] = savedDrives[k];
        }
      }
      // Never restore commit lock across sessions
      mergedDrives._commitUntil = 0;
      mergedDrives._lastUpdated = 0;

      this.soul = {
        personality: data.soul.personality ?? this.soul.personality,
        relationships: data.soul.relationships ?? this.soul.relationships,
        memories: (data.soul.memories && typeof data.soul.memories === 'object' && !Array.isArray(data.soul.memories))
          ? data.soul.memories
          : this.soul.memories,
        learned_phrases: data.soul.learned_phrases ?? this.soul.learned_phrases ?? [],
        drives: mergedDrives,
      };
      // Update behavioral modifiers when personality type changes
      this._personalityMod = getPersonalityModifiers(this.soul.personality.type);
      // Sync NPCPersonality instance with restored soul data
      this.personality.type   = this.soul.personality.type;
      this.personality.phrases = this.soul.learned_phrases;
      // Migrate old flat memories array to { global: [...] }
      if (Array.isArray(data.soul.memories)) {
        this.soul.memories = { global: data.soul.memories };
      }
      // Migrate old flat emotional_state/relationship to default player
      if (data.soul.emotional_state && !data.soul.relationships) {
        const es = data.soul.emotional_state;
        this.soul.relationships['default'] = {
          trust: es.trust ?? 0.7,
          fear: es.fear ?? 0.05,
          anger: es.anger ?? 0.0,
          cooperation_mod: 0,
          aggression_mod: 0,
          label: data.soul.relationship ?? 'neutral',
        };
      }
    }
  }

  // ── Update ────────────────────────────────────────────────────────────────

  update(delta) {
    if (this._dead) {
      return;
    }
    if (this._knockedOut) {
      this._nameLabel?.setPosition(this.x, this.y - TILE_SIZE - 8);
      this._hpBarBg?.setPosition(this.x - 20, this.y - TILE_SIZE - 2);
      this._hpBar?.setPosition(this.x - 20, this.y - TILE_SIZE - 2);
      this._kiBarBg?.setPosition(this.x - 20, this.y - TILE_SIZE + 3);
      this._kiBar?.setPosition(this.x - 20, this.y - TILE_SIZE + 3);
      this._ring?.setPosition(this.x, this.y - 4);
      this._ringPulse?.setPosition(this.x, this.y - 4);
      this._hpBar?.setVisible(true);
      this._hpBarBg?.setVisible(true);
      this._kiBar?.setVisible(true);
      this._kiBarBg?.setVisible(true);
      this._hpBar?.setDisplaySize(0, 4);
      this._kiBar?.setDisplaySize(0, 3);
      return;
    }

    this.clearTint();

    // Keep maxLogs in sync with level
    this.maxLogs = this._calcMaxLogs();

    // HP regen
    if (this.hp < this.maxHp) {
      this._regenAccum += delta;
      if (this._regenAccum >= HP_REGEN_MS) {
        this._regenAccum -= HP_REGEN_MS;
        this.heal(1);
      }
    } else {
      this._regenAccum = 0;
    }

    // Ki regen
    if (this.ki < this.maxKi) {
      this._kiRegenAccum += delta;
      if (this._kiRegenAccum >= KI_REGEN_MS) {
        this._kiRegenAccum -= KI_REGEN_MS;
        this.ki = Math.min(this.maxKi, this.ki + 1);
      }
    } else {
      this._kiRegenAccum = 0;
    }

    // Emotion decay — drift toward per-relationship baselines
    this._emotionDecayAccum += delta;
    if (this._emotionDecayAccum >= EMOTION_DECAY_INTERVAL) {
      this._emotionDecayAccum -= EMOTION_DECAY_INTERVAL;
      const ownerId = this.scene?.playerId || 'default';
      for (const [relKey, rel] of Object.entries(this.soul.relationships)) {
        // Owner emotions decay much slower; others decay at half rate
        const mult = (relKey === ownerId || relKey === 'default') ? OWNER_DECAY_MULT : OTHER_DECAY_MULT;
        const rate = EMOTION_DECAY_RATE * mult;
        const tb = rel.trust_baseline ?? DEFAULT_TRUST_BASELINE;
        const fb = rel.fear_baseline  ?? DEFAULT_FEAR_BASELINE;
        const ab = rel.anger_baseline ?? DEFAULT_ANGER_BASELINE;
        rel.trust = _decayToward(rel.trust, tb, rate);
        rel.fear  = _decayToward(rel.fear,  fb, rate);
        rel.anger = _decayToward(rel.anger, ab, rate);
        rel.label = _deriveRelationship(rel);

        // Baseline drift — sustained high emotions permanently shift baselines
        // Trust above threshold → baseline rises (NPC becomes more trusting)
        if (rel.trust >= BASELINE_THRESHOLD) {
          rel._trust_accum = (rel._trust_accum ?? 0) + EMOTION_DECAY_INTERVAL;
          if (rel._trust_accum >= BASELINE_ACCUM_INTERVAL) {
            rel._trust_accum -= BASELINE_ACCUM_INTERVAL;
            rel.trust_baseline = Math.min(BASELINE_CAP, (rel.trust_baseline ?? DEFAULT_TRUST_BASELINE) + BASELINE_SHIFT);
          }
        } else { rel._trust_accum = 0; }

        // Fear above threshold → baseline rises (NPC becomes naturally fearful)
        if (rel.fear >= BASELINE_THRESHOLD) {
          rel._fear_accum = (rel._fear_accum ?? 0) + EMOTION_DECAY_INTERVAL;
          if (rel._fear_accum >= BASELINE_ACCUM_INTERVAL) {
            rel._fear_accum -= BASELINE_ACCUM_INTERVAL;
            rel.fear_baseline = Math.min(BASELINE_CAP, (rel.fear_baseline ?? DEFAULT_FEAR_BASELINE) + BASELINE_SHIFT);
          }
        } else { rel._fear_accum = 0; }

        // Anger above threshold → baseline rises (NPC holds a grudge)
        if (rel.anger >= BASELINE_THRESHOLD) {
          rel._anger_accum = (rel._anger_accum ?? 0) + EMOTION_DECAY_INTERVAL;
          if (rel._anger_accum >= BASELINE_ACCUM_INTERVAL) {
            rel._anger_accum -= BASELINE_ACCUM_INTERVAL;
            rel.anger_baseline = Math.min(BASELINE_CAP, (rel.anger_baseline ?? DEFAULT_ANGER_BASELINE) + BASELINE_SHIFT);
          }
        } else { rel._anger_accum = 0; }
      }
    }

    // Memory decay — reduce importance over time, prune faded memories
    this._memoryDecayAccum += delta;
    if (this._memoryDecayAccum >= MEMORY_DECAY_INTERVAL) {
      this._memoryDecayAccum -= MEMORY_DECAY_INTERVAL;
      for (const bucket of Object.keys(this.soul.memories)) {
        const arr = this.soul.memories[bucket];
        for (const mem of arr) {
          mem.importance = Math.max(0, (mem.importance ?? 0.5) - MEMORY_IMPORTANCE_DECAY);
        }
        // Prune faded memories
        this.soul.memories[bucket] = arr.filter(m => (m.importance ?? 0) > MEMORY_PRUNE_THRESHOLD);
      }
    }

    // Emotion-driven reactions — suppressed briefly after explicit player commands.
    const manualCommandActive = (this._manualCommandUntil ?? 0) > Date.now();
    if (manualCommandActive) {
      this._emotionReactTarget = null;
      this._emotionReactAccum = 0;
    } else {
      this._emotionReactAccum += delta;
      if (this._emotionReactAccum >= 2000) {
        this._emotionReactAccum = 0;
        this._emotionReactTarget = this._scanForEmotionReaction();
      }
    }

    // Movement toward target
    if (this._moveTarget) {
      const dx = this._moveTarget.x - this.x;
      const dy = this._moveTarget.y - this.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= ARRIVE_D) {
        this._moveTarget = null;
        this._pathWaypoints = null;
        this._playIdle();
      } else if (dist > 1) {
        const speed = this.getSpeed();
        const step = (speed * delta) / 1000;
        const moveLen = Math.min(step, dist);
        const mx = (dx / dist) * moveLen;
        const my = (dy / dist) * moveLen;
        this._tryMove(mx, my);

        // Play walk animation based on direction of actual movement
        if (Math.abs(dx) > Math.abs(dy)) {
          this._playWalk(dx < 0 ? 'left' : 'right');
        } else {
          this._playWalk(dy < 0 ? 'up' : 'down');
        }
      }
    }

    // Update attached elements
    this._nameLabel?.setPosition(this.x, this.y - TILE_SIZE - 10);
    this._bubble?.setPosition(this.x, this.y - TILE_SIZE - 22);
    this._ring?.setPosition(this.x, this.y - 6);
    this._ringPulse?.setPosition(this.x, this.y - 6);
    if (this._ringPulse?.visible) {
      const pulse = 28 + Math.sin(this.scene.time.now / 140) * 3;
      this._ringPulse.setRadius(pulse);
    }
    this._hpBarBg?.setPosition(this.x - 20, this.y - TILE_SIZE - 2);
    this._hpBar?.setPosition(this.x - 20, this.y - TILE_SIZE - 2);
    this._kiBarBg?.setPosition(this.x - 20, this.y - TILE_SIZE + 3);
    this._kiBar?.setPosition(this.x - 20, this.y - TILE_SIZE + 3);
    syncBarrierOverlay(this._barrierOverlay, this);
    this._syncEquipOverlays();

    // Update HP bar width
    const hpPct = this.hp / this.maxHp;
    this._hpBar?.setDisplaySize(40 * hpPct, 4);
    const color = hpPct > 0.5 ? 0x44ff44 : hpPct > 0.25 ? 0xffaa00 : 0xff4444;
    this._hpBar?.setFillStyle(color);

    // Update Ki bar width
    const kiPct = this.maxKi > 0 ? this.ki / this.maxKi : 0;
    this._kiBar?.setDisplaySize(40 * Phaser.Math.Clamp(kiPct, 0, 1), 3);
    const kiColor = kiPct > 0.5 ? 0x4488ff : kiPct > 0.25 ? 0x6644cc : 0x8822aa;
    this._kiBar?.setFillStyle(kiColor);
  }

  _syncEquipOverlays() {
    const equipData = this.equipment || {};
    const textures = this.scene?._equipmentTextures || {};
    for (const [slot, eqId] of Object.entries(equipData)) {
      let overlay = this._equipOverlays[slot];
      const texInfo = textures[eqId];
      if (!texInfo || !this.scene.textures.exists(texInfo.textureKey)) {
        if (overlay) overlay.setVisible(false);
        continue;
      }
      // Build NPC-specific remap: NPC frame → armor frame
      if (!overlay || overlay._textureKey !== texInfo.textureKey) {
        if (overlay) overlay.destroy();
        const npcRemap = {};
        for (const [npcFrame, baseFrame] of Object.entries(NPC_TO_BASE)) {
          const armorFrame = texInfo.remap[baseFrame];
          if (armorFrame != null) npcRemap[Number(npcFrame)] = armorFrame;
        }
        overlay = createEquipmentOverlay(this.scene, this, texInfo.textureKey, npcRemap);
        this._equipOverlays[slot] = overlay;
      }
      syncEquipmentOverlay(overlay, this);
    }
    for (const [slot, overlay] of Object.entries(this._equipOverlays)) {
      if (!equipData[slot]) overlay.setVisible(false);
    }
  }

  // ── Animations ────────────────────────────────────────────────────────────

  _ensureAnims(scene) {
    const anims = scene.anims;
    const def = (key, frames, fps) => {
      if (anims.exists(key)) return;
      anims.create({
        key,
        frames: frames.map(f => ({ key: NPC_KEY, frame: f })),
        frameRate: fps,
        repeat: -1,
      });
    };

    // Walk: alternate between face and walk1 frames
    def('npc-walk-down',  [NFRAME_FACE_DOWN,  NFRAME_WALK1_DOWN],  6);
    def('npc-walk-up',    [NFRAME_FACE_UP,    NFRAME_WALK1_UP],    6);
    def('npc-walk-left',  [NFRAME_FACE_LEFT,  NFRAME_WALK1_LEFT],  6);
    def('npc-walk-right', [NFRAME_FACE_RIGHT, NFRAME_WALK1_RIGHT], 6);

  }

  _playWalk(dir) {
    if (this._punching) return;
    this._facing = dir;
    const key = `npc-walk-${dir}`;
    this.setFlipX(false);
    if (this.anims.currentAnim?.key !== key) this.play(key);
  }

  _playIdle() {
    this.stop();
    this.setFlipX(false);
    this.setFrame(NFRAME_FACE_DOWN);
  }

  destroy(fromScene) {
    this._bubbleTimer?.remove();
    this._nameLabel?.destroy();
    this._bubble?.destroy();
    this._ring?.destroy();
    this._ringPulse?.destroy();
    this._hpBar?.destroy();
    this._hpBarBg?.destroy();
    this._kiBar?.destroy();
    this._kiBarBg?.destroy();
    this._barrierOverlay?.destroy();
    for (const overlay of Object.values(this._equipOverlays || {})) overlay?.destroy();
    this._equipOverlays = {};
    super.destroy(fromScene);
  }
}

// ── Soul helpers ──────────────────────────────────────────────────────────────

function _decayToward(value, baseline, rate) {
  if (value > baseline) return Math.max(baseline, value - rate);
  if (value < baseline) return Math.min(baseline, value + rate);
  return value;
}

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

function _makeRelationship() {
  const r = (lo, hi) => parseFloat((lo + Math.random() * (hi - lo)).toFixed(2));
  const trust = r(0.62, 0.88);
  const fear  = r(0.0, 0.15);
  const anger = r(0.0, 0.08);
  return {
    trust, fear, anger,
    cooperation_mod: 0,
    aggression_mod: 0,
    label: _deriveRelationship({ trust, fear, anger }),
    // Per-relationship baselines — shift permanently from sustained high emotions
    trust_baseline: DEFAULT_TRUST_BASELINE,
    fear_baseline:  DEFAULT_FEAR_BASELINE,
    anger_baseline: DEFAULT_ANGER_BASELINE,
    // Accumulators for time spent above threshold (not persisted, reset on load)
    _trust_accum: 0,
    _fear_accum:  0,
    _anger_accum: 0,
  };
}

// Personality type definitions — ranges and metadata (mirrors server personality_types.json)
const PERSONALITY_TYPES = {
  Guardian:   { ranges: { cooperation: [0.65, 0.95], aggression: [0.15, 0.45], neuroticism: [0.25, 0.55] } },
  Scout:      { ranges: { cooperation: [0.45, 0.75], aggression: [0.05, 0.25], neuroticism: [0.15, 0.45] } },
  Berserker:  { ranges: { cooperation: [0.20, 0.50], aggression: [0.55, 0.90], neuroticism: [0.30, 0.70] } },
  Caretaker:  { ranges: { cooperation: [0.75, 1.00], aggression: [0.00, 0.15], neuroticism: [0.20, 0.50] } },
  Paranoid:   { ranges: { cooperation: [0.30, 0.60], aggression: [0.10, 0.40], neuroticism: [0.60, 0.95] } },
  Pragmatist: { ranges: { cooperation: [0.50, 0.80], aggression: [0.15, 0.40], neuroticism: [0.10, 0.35] } },
};

// Personality-driven behavioral modifiers — these mechanically change how NPCs move, fight, and decide
// speed: movement multiplier, meleeCd: melee cooldown mult, kiCd: ki blast cooldown mult,
// followDist: how far from player the NPC orbits (mult on FOLLOW_DIST),
// decisionSpeed: LLM decision cooldown mult (lower = decides faster, more impulsive),
// bubbleDuration: speech bubble duration mult,
// fallback: what task to do when LLM is down or confidence is low
const PERSONALITY_MODIFIERS = {
  Guardian:   { speed: 0.9,  meleeCd: 1.1,  kiCd: 1.2,  followDist: 0.8,  decisionSpeed: 1.0, bubbleDuration: 1.0, fallback: 'defend_player' },
  Scout:      { speed: 1.2,  meleeCd: 1.0,  kiCd: 0.9,  followDist: 1.5,  decisionSpeed: 0.8, bubbleDuration: 0.6, fallback: 'idle' },
  Berserker:  { speed: 1.1,  meleeCd: 0.7,  kiCd: 0.8,  followDist: 2.0,  decisionSpeed: 0.6, bubbleDuration: 0.5, fallback: 'attack_nearest_enemy' },
  Caretaker:  { speed: 0.85, meleeCd: 1.3,  kiCd: 1.1,  followDist: 0.6,  decisionSpeed: 1.2, bubbleDuration: 1.4, fallback: 'follow' },
  Paranoid:   { speed: 1.0,  meleeCd: 0.9,  kiCd: 1.0,  followDist: 0.5,  decisionSpeed: 0.5, bubbleDuration: 0.8, fallback: 'follow' },
  Pragmatist: { speed: 1.0,  meleeCd: 1.0,  kiCd: 1.0,  followDist: 1.0,  decisionSpeed: 1.0, bubbleDuration: 0.7, fallback: 'gather' },
};

/** Get the behavioral modifier table for a personality type. */
export function getPersonalityModifiers(typeName) {
  return PERSONALITY_MODIFIERS[typeName] || PERSONALITY_MODIFIERS.Pragmatist;
}

function _makeDefaultDrives() {
  return {
    aggression: 0.0,
    attachment: 0.0,
    curiosity:  0.0,
    greed:      0.0,
    social:     0.0,
    survival:   0.0,
    ambition:   0.0,
    _commitUntil: 0,
    _lastUpdated: 0,
  };
}

function _makeSoul(personalityType) {
  const r = (lo, hi) => parseFloat((lo + Math.random() * (hi - lo)).toFixed(2));

  // Pick a random type if none specified
  const typeNames = Object.keys(PERSONALITY_TYPES);
  const typeName = personalityType || typeNames[Math.floor(Math.random() * typeNames.length)];
  const typeRanges = PERSONALITY_TYPES[typeName]?.ranges || PERSONALITY_TYPES.Pragmatist.ranges;

  return {
    personality: {
      type: typeName,
      cooperation: r(...typeRanges.cooperation),
      aggression:  r(...typeRanges.aggression),
      neuroticism: r(...typeRanges.neuroticism),
    },
    relationships: {
      default: _makeRelationship(),
    },
    memories: {},  // keyed by playerId or 'global'
    learned_phrases: [], // phrases picked up from owner's speech
    drives: _makeDefaultDrives(),
  };
}

/**
 * Extract notable phrases from player speech that NPCs should learn.
 * Catches nicknames for NPCs/players, insults, exclamations, pet names,
 * and distinctive multi-word expressions.
 * Returns an array of phrase strings (may be empty).
 */
// Words/patterns that suggest an insult
const INSULT_WORDS = /\b(dumb|stupid|ugly|idiot|fool|loser|trash|junk|garbage|worthless|pathetic|lame|weak|scrap|rust|clank|stink|suck|useless|moron|crap|busted|broke|wack|whack|sorry|sad|slow|fat|skinny|smelly|dirty|nasty|gross|freak|creep|nerd|noob|scrub)\b/i;
// Words/patterns that suggest friendliness
const FRIENDLY_WORDS = /\b(buddy|pal|friend|homie|bro|fam|champ|chief|boss|king|queen|legend|hero|star|ace|gem|sweetheart|darling|love|dear|cutie|sunshine|beautiful|awesome|cool|amazing|great|good|best|fave|favorite)\b/i;

/**
 * Classify tone of a phrase: 'insult', 'friendly', or 'neutral'.
 */
function classifyTone(phrase) {
  if (INSULT_WORDS.test(phrase)) return 'insult';
  if (FRIENDLY_WORDS.test(phrase)) return 'friendly';
  return 'neutral';
}

export function extractLearnablePhrases(text, knownNames = new Set()) {
  if (!text || text.length < 3) return [];
  const phrases = []; // { phrase, usage, tone }

  // Helper: strip known entity names from a phrase, e.g. "pap you ladyboy" → "ladyboy"
  const stripNames = (str) => {
    const words = str.split(/\s+/).filter(w => !knownNames.has(w.toLowerCase()));
    return words.join(' ').trim();
  };

  // Pattern 1: Quoted phrases — "dumb clanker", 'tin can', etc.
  const quoted = text.match(/["']([^"']{3,30})["']/g);
  if (quoted) {
    for (const q of quoted) {
      const p = q.replace(/["']/g, '').trim();
      phrases.push({ phrase: p, usage: 'catchphrase', tone: classifyTone(p) });
    }
  }

  // Pattern 2: Nicknames/insults — "you <word>" or "you <adj> <noun>" patterns
  const nickRe = /\byou\s+([\w-]+(?:\s+[\w-]+){0,2})\b/gi;
  let m;
  const boringAfterYou = /^(can|will|should|go|are|were|have|need|want|do|did|know|think|see|look|get|got|come|said|say|just|too|also|really|don|t|re|ll|ve|the|a|an|my|his|her|ok|okay)\b/i;
  while ((m = nickRe.exec(text)) !== null) {
    const candidate = m[1].trim();
    if (!boringAfterYou.test(candidate) && candidate.length >= 3) {
      phrases.push({ phrase: candidate, usage: 'calling_others', tone: classifyTone(candidate) });
    }
  }

  // Pattern 3: Exclamatory expressions — "what a <phrase>!", "<word> <word>!"
  const exclRe = /\b([\w-]+(?:\s+[\w-]+){1,3})!/g;
  while ((m = exclRe.exec(text)) !== null) {
    const candidate = m[1].trim();
    if (candidate.length >= 4 && !/^(oh no|oh my|come on|let me|hold on|watch out)$/i.test(candidate)) {
      phrases.push({ phrase: candidate, usage: 'exclamation', tone: classifyTone(candidate) });
    }
  }

  // Pattern 4: "call them/him/her/it <phrase>"
  const callRe = /\bcall\s+(?:them|him|her|it|that)\s+([\w-]+(?:\s+[\w-]+){0,2})/gi;
  while ((m = callRe.exec(text)) !== null) {
    const p = m[1].trim();
    phrases.push({ phrase: p, usage: 'calling_others', tone: classifyTone(p) });
  }

  // Pattern 5: Terms of address — "hey/hi/yo/sup/thanks/listen/look <word>"
  const addressRe = /\b(?:hey|hi|yo|sup|thanks|thankyou|listen|look|bye|later|welcome|whats\s?up|oi)\s+([\w-]+)\b/gi;
  while ((m = addressRe.exec(text)) !== null) {
    const candidate = m[1].trim();
    // Skip common follow-ups like "hey there", "look out", "hi guys"
    if (!/^(there|here|man|guys|dude|bro|up|out|at|over|buddy|mate|now|everyone|all)$/i.test(candidate) && candidate.length >= 3) {
      phrases.push({ phrase: candidate, usage: 'calling_others', tone: classifyTone(candidate) });
    }
  }

  // Pattern 6: Word used as name at end of sentence — "..., <word>" or "... <word>." (comma-preceded or sentence-final address)
  const endAddrRe = /,\s+([\w-]+)\s*[.!?]?\s*$/gim;
  while ((m = endAddrRe.exec(text)) !== null) {
    const candidate = m[1].trim();
    if (!/^(right|ok|okay|please|now|then|too|yeah|sure|thanks|anyway|so|though)$/i.test(candidate) && candidate.length >= 3) {
      phrases.push({ phrase: candidate, usage: 'calling_others', tone: classifyTone(candidate) });
    }
  }

  // Common words that should never be learned as phrases
  const STOPWORDS = new Set([
    'the', 'a', 'an', 'is', 'it', 'in', 'on', 'at', 'to', 'for', 'of', 'and',
    'or', 'but', 'not', 'no', 'yes', 'you', 'your', 'me', 'my', 'we', 'our',
    'he', 'she', 'his', 'her', 'they', 'them', 'their', 'its', 'was', 'were',
    'has', 'had', 'have', 'been', 'are', 'did', 'does', 'do', 'will', 'can',
    'could', 'would', 'should', 'may', 'might', 'shall', 'this', 'that',
    'what', 'when', 'where', 'who', 'how', 'why', 'which', 'with', 'from',
    'just', 'like', 'some', 'all', 'any', 'more', 'much', 'many', 'very',
    'too', 'also', 'than', 'then', 'now', 'here', 'there', 'out', 'about',
    'up', 'down', 'off', 'over', 'into', 'only', 'own', 'same', 'so',
    'got', 'get', 'go', 'going', 'gone', 'come', 'back', 'one', 'two',
    'thing', 'things', 'way', 'well', 'even', 'still', 'new', 'old',
  ]);

  // Strip known entity names from phrases, dedupe, filter stopwords
  const seen = new Set();
  return phrases
    .map(p => ({ ...p, phrase: stripNames(p.phrase) }))
    .filter(p => {
      const key = p.phrase.toLowerCase();
      if (!p.phrase || seen.has(key) || key.length < 3 || STOPWORDS.has(key)) return false;
      seen.add(key);
      return true;
    });
}
