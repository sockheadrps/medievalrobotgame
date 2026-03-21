// NPCPersonality.js — Personality data tables and per-NPC runtime state.
// Centralises personality metadata (drive rates, emotion multipliers, commit timing)
// and provides a lightweight class to hold an individual NPC's personality-driven
// runtime state: emotions, memory, relationships, and learned vocabulary.

// ── Drive growth rates (per second, 0–1 scale) ──────────────────────────────
// Higher = this drive fills faster for this personality type.
export const DRIVE_GROWTH_RATES = {
  Guardian:   { aggression:0.05, attachment:0.09, curiosity:0.04, greed:0.03, social:0.07, survival:0.08, ambition:0.06 },
  Berserker:  { aggression:0.18, attachment:0.04, curiosity:0.06, greed:0.05, social:0.03, survival:0.06, ambition:0.10 },
  Scout:      { aggression:0.04, attachment:0.05, curiosity:0.15, greed:0.06, social:0.08, survival:0.07, ambition:0.07 },
  Caretaker:  { aggression:0.02, attachment:0.12, curiosity:0.05, greed:0.02, social:0.14, survival:0.05, ambition:0.05 },
  Paranoid:   { aggression:0.06, attachment:0.06, curiosity:0.03, greed:0.04, social:0.04, survival:0.16, ambition:0.05 },
  Pragmatist: { aggression:0.05, attachment:0.05, curiosity:0.07, greed:0.10, social:0.07, survival:0.07, ambition:0.10 },
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

    // Emotion state per relationship — mirrors soul.relationships structure.
    // NPC.js is still the authoritative store; this object mirrors/shadows it.
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
