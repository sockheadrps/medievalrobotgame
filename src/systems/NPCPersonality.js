// NPCPersonality.js — Personality data tables and per-NPC runtime state.
// Centralises personality metadata (drive rates, emotion multipliers, commit timing)
// and provides a lightweight class to hold an individual NPC's personality-driven
// runtime state: emotions, memory, relationships, and learned vocabulary.

// ── Drive growth rates (per second, 0–1 scale) ──────────────────────────────
// Higher = this drive fills faster for this personality type.
export const DRIVE_GROWTH_RATES = {
  Guardian:   { aggression:0.005, attachment:0.009, curiosity:0.004, greed:0.003, social:0.007, survival:0.008, ambition:0.006 },
  Berserker:  { aggression:0.018, attachment:0.004, curiosity:0.006, greed:0.005, social:0.003, survival:0.006, ambition:0.010 },
  Scout:      { aggression:0.004, attachment:0.005, curiosity:0.015, greed:0.006, social:0.008, survival:0.007, ambition:0.007 },
  Caretaker:  { aggression:0.002, attachment:0.012, curiosity:0.005, greed:0.002, social:0.014, survival:0.005, ambition:0.005 },
  Paranoid:   { aggression:0.006, attachment:0.006, curiosity:0.003, greed:0.004, social:0.004, survival:0.016, ambition:0.005 },
  Pragmatist: { aggression:0.005, attachment:0.005, curiosity:0.007, greed:0.010, social:0.007, survival:0.007, ambition:0.010 },
};

// Emotion → drive growth multipliers. Applied when emotion exceeds 0.1.
export const EMOTION_DRIVE_MULTS = {
  fear:  { survival: 3.0, curiosity: 0.2 },
  anger: { aggression: 2.5, social: 0.3 },
  trust: { attachment: 0.5, curiosity: 1.5 },
};

// Action commitment timing by personality type (ms)
export const COMMIT_DURATION = {
  Guardian:   11000,
  Berserker:   6000,
  Scout:       8000,
  Caretaker:  12000,
  Paranoid:    9000,
  Pragmatist:  8000,
};

// Ordered list of personality type names (keys of DRIVE_GROWTH_RATES)
export const PERSONALITY_TYPES = Object.keys(DRIVE_GROWTH_RATES);

// ── NPCPersonality class ──────────────────────────────────────────────────────

/**
 * Holds the personality type and all personality-driven runtime state for a
 * single NPC instance: emotion/relationship buckets, episodic memory, and
 * the vocabulary of phrases the NPC has learned from its owner.
 *
 * Emotion decay and complex relationship logic remain in NPC.js because they
 * access many NPC internals. This class is a data container and provides
 * simple mutation helpers.
 */
export default class NPCPersonality {
  /**
   * @param {string} [personalityType] - One of the PERSONALITY_TYPES names.
   *   Defaults to 'Pragmatist' if not recognised.
   */
  constructor(personalityType = 'Pragmatist') {
    /** @type {string} */
    this.type = PERSONALITY_TYPES.includes(personalityType) ? personalityType : 'Pragmatist';

    // Personality-scoped relationship tracking; note soul.relationships in NPC.js
    // is a separate store used by LLM context (the two are never synced).
    /** @type {Object.<string, {trust:number, fear:number, anger:number}>} */
    this.relationships = {};

    // Episodic memory — keyed by playerId or 'global'
    /** @type {Object.<string, Array<{text:string, type:string, ts:number, importance:number}>>} */
    this.memory = {};

    // Vocabulary learned from the owner's speech
    /** @type {Array<{phrase:string, uses:number, last_heard:number, usage:string, tone:string}>} */
    this.phrases = [];
  }

  // ── Phrase learning ──────────────────────────────────────────────────────

  /**
   * Learn a phrase from the owner's speech. Mirrors the learnPhrase logic that
   * lives in NPC.js so callers can delegate to this object.
   *
   * Supports both legacy string format and the richer { phrase, usage, tone }
   * object format.
   *
   * @param {string|{phrase:string, usage?:string, tone?:string}} phraseData
   */
  learnPhrase(phraseData) {
    const phrase = typeof phraseData === 'string' ? phraseData : phraseData.phrase;
    const usage  = (typeof phraseData === 'object' && phraseData.usage) || 'catchphrase';
    const tone   = (typeof phraseData === 'object' && phraseData.tone)  || 'neutral';

    const lower    = phrase.toLowerCase();
    const existing = this.phrases.find(p => p.phrase.toLowerCase() === lower);
    if (existing) {
      existing.uses++;
      existing.last_heard = Date.now();
      if (tone  !== 'neutral')      existing.tone  = tone;
      if (usage !== 'catchphrase')  existing.usage = usage;
      return;
    }

    this.phrases.push({ phrase, uses: 1, last_heard: Date.now(), usage, tone });
    // Keep max 8 phrases, drop least-used
    if (this.phrases.length > 8) {
      this.phrases.sort((a, b) => b.uses - a.uses);
      this.phrases.length = 8;
    }
  }

  // ── Memory ───────────────────────────────────────────────────────────────

  /**
   * Record an event in episodic memory.
   * Memories are bucketed by playerId (or 'global'), sorted by importance, and
   * capped at 50 entries per bucket.
   *
   * @param {{ text:string, type?:string, playerId?:string|null, importance?:number }} event
   */
  recordMemory({ text, type = 'event', playerId = null, importance = 1.0 }) {
    const bucket = playerId ?? 'global';
    if (!this.memory[bucket]) this.memory[bucket] = [];
    const arr = this.memory[bucket];
    arr.push({ text, type, ts: Date.now(), importance });
    arr.sort((a, b) => (b.importance ?? 0.5) - (a.importance ?? 0.5));
    while (arr.length > 50) arr.pop();
  }

  // ── Relationships ─────────────────────────────────────────────────────────

  /**
   * Apply a numeric delta to one or more emotion fields for a given player.
   * Creates the relationship bucket on first use with neutral defaults.
   * Values are clamped to [0, 1].
   *
   * @param {string} playerId
   * @param {{ trust?:number, fear?:number, anger?:number }} delta
   */
  updateRelationship(playerId, delta) {
    if (!this.relationships[playerId]) {
      this.relationships[playerId] = { trust: 0.5, fear: 0.0, anger: 0.0 };
    }
    const rel = this.relationships[playerId];
    for (const [key, val] of Object.entries(delta)) {
      if (key in rel) {
        rel[key] = Math.max(0, Math.min(1, rel[key] + Number(val)));
      }
    }
  }
}
