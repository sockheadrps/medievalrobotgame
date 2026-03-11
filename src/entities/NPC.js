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
} from '../constants.js';

const HP_REGEN_MS = 30000;
const SCALE = TILE_SIZE / NPC_FRAME_H; // 48/32 = 1.5
const ARRIVE_D = 8;

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
    this._regenAccum = 0;
    this._emotionDecayAccum = 0;
    this._memoryDecayAccum = 0;
    this._emotionReactAccum = 0; // periodic check for emotion-driven behavior
    this._emotionReactTarget = null; // current emotion-driven target { action, playerId }

    // Inventory — capacity scales with level
    this.logs    = 0;
    this.maxLogs = this._calcMaxLogs();

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
    this._ring = scene.add.circle(x, y - 6, 18, 0x44aaff, 0.25)
      .setDepth(1).setVisible(false);

    // HP bar
    this._hpBarBg = scene.add.rectangle(x - 20, y - TILE_SIZE - 2, 40, 4, 0x333333)
      .setOrigin(0, 0.5).setDepth(3);
    this._hpBar = scene.add.rectangle(x - 20, y - TILE_SIZE - 2, 40, 4, 0x44ff44)
      .setOrigin(0, 0.5).setDepth(3);

    this._ensureAnims(scene);
  }

  // ── Getters / setters ─────────────────────────────────────────────────────

  getName()       { return this._name; }
  setName(name)   { this._name = name; this._nameLabel?.setText(name); }
  isDead()        { return this._dead; }
  getFacing()     { return this._facing; }

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

  _triggerDeath() {
    this._dead = true;
    this.setVisible(false);
    this._nameLabel?.setVisible(false);
    this._hpBar?.setVisible(false);
    this._hpBarBg?.setVisible(false);
    this._ring?.setVisible(false);
    this.hideBubble();

    // Respawn after 10s
    this.scene?.time.delayedCall(10000, () => this._respawn());
  }

  _respawn() {
    this._dead = false;
    this.hp = this.maxHp;
    this.setVisible(true);
    this._nameLabel?.setVisible(true);
    this._hpBar?.setVisible(true);
    this._hpBarBg?.setVisible(true);
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

  /** Check if a position is blocked by a fence. */
  _isFenceBlocked(x, y) {
    const fenceSprites = this.scene?._fenceSprites;
    if (!fenceSprites) return false;
    const myOwner = this.scene?.playerId;
    for (const fid of Object.keys(fenceSprites)) {
      const f = fenceSprites[fid];
      if (f._dead) continue;
      const fd = Math.sqrt((x - f.x) ** 2 + (y - f.y) ** 2);
      if (fd < TILE_SIZE * 0.45) {
        if (f.isGate && f.owner === myOwner) continue;
        return true;
      }
    }
    return false;
  }

  /** Check if a straight line from (x0,y0) to (x1,y1) passes near any fence. */
  _isLineBlocked(x0, y0, x1, y1) {
    const fenceSprites = this.scene?._fenceSprites;
    if (!fenceSprites) return false;
    const myOwner = this.scene?.playerId;
    const ldx = x1 - x0;
    const ldy = y1 - y0;
    const len = Math.sqrt(ldx * ldx + ldy * ldy);
    if (len < 1) return false;
    // Sample points along the line every half-tile
    const steps = Math.ceil(len / (TILE_SIZE * 0.5));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const sx = x0 + ldx * t;
      const sy = y0 + ldy * t;
      for (const fid of Object.keys(fenceSprites)) {
        const f = fenceSprites[fid];
        if (f._dead) continue;
        if (f.isGate && f.owner === myOwner) continue;
        const fd = Math.sqrt((sx - f.x) ** 2 + (sy - f.y) ** 2);
        if (fd < TILE_SIZE * 0.45) return true;
      }
    }
    return false;
  }

  /** Try to move by (mx, my). Returns true if not blocked by a fence. */
  _tryMove(mx, my) {
    const newX = this.x + mx;
    const newY = this.y + my;
    if (this._isFenceBlocked(newX, newY)) return false;
    this.x = newX;
    this.y = newY;
    return true;
  }

  /**
   * Simple BFS pathfinding on the tile grid around fences.
   * Returns array of {x,y} waypoints (tile centers), or null if no path.
   */
  _findPath(fromX, fromY, toX, toY) {
    const col0 = Math.floor(fromX / TILE_SIZE);
    const row0 = Math.floor(fromY / TILE_SIZE);
    const col1 = Math.floor(toX / TILE_SIZE);
    const row1 = Math.floor(toY / TILE_SIZE);
    if (col0 === col1 && row0 === row1) return null;

    // Build blocked set from fences
    const blocked = new Set();
    const fenceSprites = this.scene?._fenceSprites;
    const myOwner = this.scene?.playerId;
    if (fenceSprites) {
      for (const fid of Object.keys(fenceSprites)) {
        const f = fenceSprites[fid];
        if (f._dead) continue;
        if (f.isGate && f.owner === myOwner) continue;
        const fc = Math.floor(f.x / TILE_SIZE);
        const fr = Math.floor(f.y / TILE_SIZE);
        blocked.add(`${fc},${fr}`);
      }
    }
    if (blocked.size === 0) return null; // no fences, direct path fine

    // BFS with limited search radius
    const maxDist = 15;
    const queue = [[col0, row0]];
    const visited = new Map();
    visited.set(`${col0},${row0}`, null);
    const dirs = [[1,0],[-1,0],[0,1],[0,-1]];

    while (queue.length > 0) {
      const [c, r] = queue.shift();
      if (c === col1 && r === row1) {
        // Reconstruct path
        const path = [];
        let key = `${c},${r}`;
        while (key) {
          const [pc, pr] = key.split(',').map(Number);
          path.unshift({ x: pc * TILE_SIZE + TILE_SIZE / 2, y: pr * TILE_SIZE + TILE_SIZE / 2 });
          key = visited.get(key);
        }
        return path.length > 1 ? path.slice(1) : null; // skip start tile
      }
      for (const [dc, dr] of dirs) {
        const nc = c + dc;
        const nr = r + dr;
        const nk = `${nc},${nr}`;
        if (visited.has(nk)) continue;
        if (blocked.has(nk)) continue;
        if (Math.abs(nc - col0) > maxDist || Math.abs(nr - row0) > maxDist) continue;
        visited.set(nk, `${c},${r}`);
        queue.push([nc, nr]);
      }
    }
    return null; // no path found
  }

  getSpeed() {
    const fillPct = this.maxLogs > 0 ? this.logs / this.maxLogs : 0;
    if (fillPct <= 0.75) return this._baseSpeed;
    // Linear slowdown from 100% speed at 75% full to 60% speed at 100% full
    const overPct = (fillPct - 0.75) / 0.25; // 0..1
    const slowFactor = 1 - overPct * 0.4;    // 1.0..0.6
    return this._baseSpeed * slowFactor;
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

  select()   { this._ring?.setVisible(true); }
  deselect() { this._ring?.setVisible(false); }

  showBubble(text, durationMs = 5000, { silent = false } = {}) {
    if (!this._bubble) return;
    this._bubble.setText(text).setVisible(true);
    if (this._bubbleTimer) this._bubbleTimer.remove();
    this._bubbleTimer = this.scene?.time.delayedCall(durationMs, () => {
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

  getSoulContext(playerId = 'default') {
    const rel = this._getRelationship(playerId);
    const p = this.soul.personality;

    // Effective personality = base + per-player mods
    const effectivePersonality = {
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

    return {
      name: this.getName(),
      personality: effectivePersonality,
      emotional_state: { trust: rel.trust, fear: rel.fear, anger: rel.anger },
      relationship: rel.label,
      memories: allMems,
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
   * Check if this NPC should react to a specific player based on emotions.
   * Returns: null (no reaction), or { action: 'attack'|'flee', playerId }
   */
  getEmotionReaction(playerId) {
    const rel = this.soul.relationships[playerId];
    if (!rel) return null;
    // High anger → attack on sight
    if (rel.anger > 0.7) return { action: 'attack', playerId };
    // High fear → flee
    if (rel.fear > 0.5) return { action: 'flee', playerId };
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
   * Scan nearby remote players and check if any trigger an emotion reaction.
   * Returns { action: 'attack'|'flee', playerId } or null.
   */
  _scanForEmotionReaction() {
    const scene = this.scene;
    if (!scene?._remotePlayers) return null;

    const REACT_RANGE = 6 * TILE_SIZE; // 6 tiles
    let best = null;
    let bestDist = REACT_RANGE;

    for (const [pid, rp] of Object.entries(scene._remotePlayers)) {
      if (rp.isDead?.()) continue;
      const dist = Phaser.Math.Distance.Between(this.x, this.y, rp.x, rp.y);
      if (dist > REACT_RANGE) continue;

      const reaction = this.getEmotionReaction(pid);
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
      stats: { maxHp: this.maxHp, hp: this.hp, str: this.str, def: this.def, level: this.level, xp: this.xp, logs: this.logs },
      soul: this.soul,
    };
  }

  /** Restore NPC state from saved data. */
  loadFrom(data) {
    if (data.id) this.id = data.id;
    if (data.name) this.setName(data.name);
    if (data.stats) {
      this.maxHp = data.stats.maxHp ?? this.maxHp;
      this.hp    = data.stats.hp ?? this.hp;
      this.str   = data.stats.str ?? this.str;
      this.def   = data.stats.def ?? this.def;
      this.level = data.stats.level ?? this.level;
      this.xp    = data.stats.xp ?? this.xp;
      this.logs  = data.stats.logs ?? this.logs;
      this.maxLogs = this._calcMaxLogs();
    }
    if (data.soul) {
      this.soul = {
        personality: data.soul.personality ?? this.soul.personality,
        relationships: data.soul.relationships ?? this.soul.relationships,
        memories: (data.soul.memories && typeof data.soul.memories === 'object' && !Array.isArray(data.soul.memories))
          ? data.soul.memories
          : this.soul.memories,
      };
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
    if (this._dead) return;

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

    // Emotion-driven reactions — scan nearby remote players every 2s
    this._emotionReactAccum += delta;
    if (this._emotionReactAccum >= 2000) {
      this._emotionReactAccum = 0;
      this._emotionReactTarget = this._scanForEmotionReaction();
    }

    // Movement toward target (with fence pathfinding)
    if (this._moveTarget) {
      // Determine immediate waypoint — use pathfinding if direct path is blocked
      let goalX = this._moveTarget.x;
      let goalY = this._moveTarget.y;

      // Check if direct line to target crosses a fence
      const directBlocked = this._isFenceBlocked(goalX, goalY) ||
        this._isLineBlocked(this.x, this.y, goalX, goalY);

      if (directBlocked) {
        // Recompute path periodically (every 500ms or when target changed significantly)
        const targetKey = `${Math.floor(goalX / TILE_SIZE)},${Math.floor(goalY / TILE_SIZE)}`;
        if (!this._pathWaypoints || this._pathTargetKey !== targetKey ||
            (this._pathAge = (this._pathAge ?? 0) + delta) > 500) {
          this._pathWaypoints = this._findPath(this.x, this.y, goalX, goalY);
          this._pathTargetKey = targetKey;
          this._pathAge = 0;
        }
        // Follow waypoints
        if (this._pathWaypoints && this._pathWaypoints.length > 0) {
          goalX = this._pathWaypoints[0].x;
          goalY = this._pathWaypoints[0].y;
          const wpDist = Math.sqrt((this.x - goalX) ** 2 + (this.y - goalY) ** 2);
          if (wpDist <= TILE_SIZE * 0.4) {
            this._pathWaypoints.shift();
          }
        }
      } else {
        this._pathWaypoints = null;
        this._pathTargetKey = null;
      }

      const dx = goalX - this.x;
      const dy = goalY - this.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Check arrival against final target, not waypoint
      const finalDx = this._moveTarget.x - this.x;
      const finalDy = this._moveTarget.y - this.y;
      const finalDist = Math.sqrt(finalDx * finalDx + finalDy * finalDy);

      if (finalDist <= ARRIVE_D) {
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
    this._hpBarBg?.setPosition(this.x - 20, this.y - TILE_SIZE - 2);
    this._hpBar?.setPosition(this.x - 20, this.y - TILE_SIZE - 2);

    // Update HP bar width
    const hpPct = this.hp / this.maxHp;
    this._hpBar?.setDisplaySize(40 * hpPct, 4);
    const color = hpPct > 0.5 ? 0x44ff44 : hpPct > 0.25 ? 0xffaa00 : 0xff4444;
    this._hpBar?.setFillStyle(color);
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
    this._hpBar?.destroy();
    this._hpBarBg?.destroy();
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
  };
}
