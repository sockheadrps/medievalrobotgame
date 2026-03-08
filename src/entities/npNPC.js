// npNPC - Rival colony NPC faction.
// Subclass of NPC with a distinct identity: orange-red tint, suspicious starting
// soul, and a factionTrust value that tracks their relationship with the player's
// faction as a whole (separate from the per-conversation soul trust).

import { NPC } from './NPC.js';

const RIVAL_NAMES = [
  'Rex', 'Vega', 'Harlow', 'Cinder', 'Mox', 'Dray', 'Sable',
  'Kira', 'Flint', 'Zane', 'Rook', 'Lyra', 'Torq', 'Nyx', 'Bram',
];

let _nameIndex = 0;

// Faction trust thresholds
export const RIVAL_TRUST_HOSTILE  = 0.15;  // below this => attacks player faction
export const RIVAL_TRUST_TRADE    = 0.5;   // above this => open to cooperation
export const RIVAL_TRUST_ALLIED   = 0.75;  // above this => actively helpful
export const RIVAL_ANGER_HOSTILE  = 0.7;  // at/above this => immediately hostile

export class npNPC extends NPC {
  constructor(scene, x, y, id) {
    super(scene, x, y, id);

    this.faction = 'rival';

    // Clear the player-faction memories seeded by the NPC base constructor
    this.soul.memory = [];

    // Faction-level trust: shared attitude toward the player's colony.
    // Individual soul.emotional_state.trust tracks per-conversation warmth.
    this.factionTrust = 0.35;

    // Apply rival profile (orange-red tint, combat-ready stats)
    this.setProfile('rival');

    // Assign a name from the rival roster
    const name = RIVAL_NAMES[_nameIndex % RIVAL_NAMES.length];
    _nameIndex++;
    this.setName(name);

    // Override starting soul to be wary/suspicious
    this.soul.emotional_state.trust = 0.2;
    this.soul.emotional_state.anger = 0.3;
    this.soul.emotional_state.fear  = 0.15;
    this.soul.relationship = 'wary';

    // Add a faction memory so the LLM knows their context
    this.addMemory('I am from the rival colony. I do not fully trust outsiders.');
  }

  /**
   * Adjust faction-level trust by delta and clamp to [0, 1].
   * Call this after diplomacy interactions to shift the overall relationship.
   */
  adjustFactionTrust(delta) {
    this.factionTrust = Math.max(0, Math.min(1, this.factionTrust + delta));
  }

  /**
   * Returns true if this rival is hostile enough to attack player factions.
   */
  isHostileToFaction() {
    const anger = Number(this.soul?.emotional_state?.anger ?? 0);
    return this.factionTrust < RIVAL_TRUST_HOSTILE || anger >= RIVAL_ANGER_HOSTILE;
  }

  /**
   * Serialise faction-specific state for save/load.
   * Merged on top of the base NPC serialise output.
   */
  serialise() {
    return { ...super.serialise?.() ?? {}, faction: 'rival', factionTrust: this.factionTrust };
  }

  restoreFrom(data) {
    super.restoreFrom?.(data);
    if (data.factionTrust !== undefined) this.factionTrust = data.factionTrust;
  }
}
