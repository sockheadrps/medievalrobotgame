// DriveSystem.js — NPC motivational drive system.
// Drives accumulate continuously over time based on personality type.
// The strongest drive within the highest priority band determines the NPC's
// autonomous intention. The LLM is reserved for conflict resolution, social
// interaction, novel events, and command resistance.

import { TILE_SIZE } from '../constants.js';

// ── Drive growth rates (per second, 0–1 scale) ──────────────────────────────
// Higher = this drive fills faster for this personality type.
const DRIVE_GROWTH_RATES = {
  Guardian:   { aggression:0.05, attachment:0.12, curiosity:0.04, greed:0.03, social:0.07, survival:0.08, ambition:0.04 },
  Berserker:  { aggression:0.18, attachment:0.04, curiosity:0.06, greed:0.05, social:0.03, survival:0.06, ambition:0.08 },
  Scout:      { aggression:0.04, attachment:0.06, curiosity:0.15, greed:0.06, social:0.08, survival:0.07, ambition:0.05 },
  Caretaker:  { aggression:0.02, attachment:0.16, curiosity:0.05, greed:0.02, social:0.14, survival:0.05, ambition:0.03 },
  Paranoid:   { aggression:0.06, attachment:0.08, curiosity:0.03, greed:0.04, social:0.04, survival:0.16, ambition:0.03 },
  Pragmatist: { aggression:0.05, attachment:0.06, curiosity:0.07, greed:0.10, social:0.07, survival:0.07, ambition:0.09 },
};

// Emotion → drive growth multipliers. Applied when emotion exceeds 0.1.
const EMOTION_DRIVE_MULTS = {
  fear:  { survival: 3.0, curiosity: 0.2 },
  anger: { aggression: 2.5, social: 0.3 },
  trust: { attachment: 0.5, curiosity: 1.5 },
};

// Priority bands (higher index = higher priority)
// Within a band, the highest drive wins. Higher bands always beat lower bands.
const PRIORITY_BANDS = [
  { name: 'curiosity', drives: ['curiosity', 'social'],              threshold: 0.55 },
  { name: 'activity',  drives: ['aggression', 'greed', 'ambition'],  threshold: 0.60 },
  { name: 'attachment',drives: ['attachment'],                        threshold: 0.70 },
  { name: 'emergency', drives: ['survival'],                          threshold: 0.75 },
];

// Drive → candidate tasks mapping
const DRIVE_TO_INTENTS = {
  aggression: ['attack_nearest_enemy', 'train'],
  attachment: ['follow'],
  curiosity:  ['wander_explore'],
  greed:      ['gather', 'gather_wood'],
  social:     ['socialize_npc'],
  survival:   ['follow'],    // retreat to player
  ambition:   ['train', 'practice_ki'],
};

// Task → drive affinity (which drive does this task satisfy / is associated with)
export const TASK_DRIVE_AFFINITY = {
  gather:               'greed',
  gather_wood:          'greed',
  gather_stone:         'greed',
  gather_all:           'greed',
  give_logs:            'greed',
  give_materials:       'greed',
  train:                'ambition',
  practice_ki:          'ambition',
  follow:               'attachment',
  stay_near_player:     'attachment',
  defend_player:        'attachment',
  attack_nearest_enemy: 'aggression',
  attack_player:        'aggression',
  attack_npc:           'aggression',
  retreat:              'survival',
  flee_player:          'survival',
  socialize_npc:        'social',
  wander_explore:       'curiosity',
  idle:                 null,
  steal_logs:           'greed',
  mine_ore:             'greed',
  deposit_to_crate:     'greed',
};

// Decay applied to a drive per second while its task is executing
const TASK_DECAY_RATE = 0.06; // drive drops ~6% per second while task runs

// Conflict threshold — two drives this close and both above this value → LLM needed
const CONFLICT_THRESHOLD    = 0.05;
const CONFLICT_MIN_VALUE    = 0.50;

// Action commitment timing by personality type (ms)
const COMMIT_DURATION = {
  Guardian:   11000,
  Berserker:   6000,
  Scout:       8000,
  Caretaker:  12000,
  Paranoid:    9000,
  Pragmatist:  8000,
};

// Max delta-time per tick to prevent huge spikes after tab-hide/unhide
const MAX_DT_SEC = 0.5;

export class DriveSystem {
  /**
   * Update drive levels each frame.
   * Call from NPCBrain.update() before the LLM decision block.
   */
  static tick(npc, scene, deltaMs) {
    const drives = npc.soul?.drives;
    if (!drives) return;

    const dt = Math.min(deltaMs / 1000, MAX_DT_SEC);
    const pType = npc.soul?.personality?.type || 'Pragmatist';
    const rates = DRIVE_GROWTH_RATES[pType] || DRIVE_GROWTH_RATES.Pragmatist;

    // Get owner emotions for multipliers
    const rel = npc._getOwnerRelationship?.();
    const emotions = rel ? { fear: rel.fear ?? 0, anger: rel.anger ?? 0, trust: rel.trust ?? 0 } : {};

    for (const drive of ['aggression','attachment','curiosity','greed','social','survival','ambition']) {
      let rate = rates[drive] ?? 0.05;

      // Apply emotion multipliers
      for (const [emotion, mults] of Object.entries(EMOTION_DRIVE_MULTS)) {
        const emotionVal = emotions[emotion] ?? 0;
        if (emotionVal > 0.1 && mults[drive] != null) {
          rate *= mults[drive];
        }
      }

      // Situational bonus
      rate *= DriveSystem._situationalMult(drive, npc, scene);

      drives[drive] = Math.min(1.0, (drives[drive] ?? 0) + rate * dt);
    }

    drives._lastUpdated = Date.now();
  }

  /** Situational multipliers based on world state. */
  static _situationalMult(drive, npc, scene) {
    if (drive === 'survival') {
      // Low HP spikes survival strongly
      const hpPct = npc.hp / (npc.maxHp || 1);
      return 1 + (1 - hpPct) * 2.0;
    }
    if (drive === 'greed') {
      // More trees nearby → greed grows faster
      const treeCount = (scene.trees ?? []).filter(t => !t._chopped).length;
      return 1 + Math.min(treeCount / 10, 1.0);
    }
    if (drive === 'social') {
      // Remote NPCs nearby boost social
      const remoteNpcs = Object.values(scene._remoteNPCSprites || {});
      const nearbyCount = remoteNpcs.filter(r => {
        const d = Phaser.Math.Distance.Between(npc.x, npc.y, r.x, r.y);
        return d < TILE_SIZE * 8;
      }).length;
      return 1 + Math.min(nearbyCount * 0.3, 1.0);
    }
    return 1.0;
  }

  /**
   * Get the dominant drive intent for direct (silent) task assignment.
   * Returns an intent string or null if no drive exceeds its threshold.
   * Evaluates bands from highest priority (emergency) down to lowest (curiosity).
   */
  static getDominantIntent(npc, scene) {
    const drives = npc.soul?.drives;
    if (!drives) return null;

    // Check bands from highest priority to lowest
    for (let i = PRIORITY_BANDS.length - 1; i >= 0; i--) {
      const band = PRIORITY_BANDS[i];
      let best = null;
      let bestVal = band.threshold;

      for (const driveName of band.drives) {
        const val = drives[driveName] ?? 0;
        if (val > bestVal) {
          bestVal = val;
          best = driveName;
        }
      }

      if (best) {
        // Special: social requires a nearby remote NPC target
        if (best === 'social') {
          const remoteNpcs = Object.values(scene._remoteNPCSprites || {});
          const hasTarget = remoteNpcs.some(r => {
            const d = Phaser.Math.Distance.Between(npc.x, npc.y, r.x, r.y);
            return d < TILE_SIZE * 10 && !r.isDead?.() && !r.isKnockedOut?.();
          });
          if (!hasTarget) continue;
        }
        return best; // return the drive name; caller maps to tasks
      }
    }

    return null;
  }

  /** Map a drive name to a concrete task definition for NPCTaskRunner. */
  static driveToTask(driveName, npc, scene) {
    switch (driveName) {
      case 'aggression': {
        // Prefer real enemy if one exists nearby, else train
        const hasDummy = (scene.dummies ?? []).some(d => !d.isDead?.());
        const hasEnemy = Object.values(scene._remotePlayers || {}).some(p => !p.isDead?.()) ||
                         Object.values(scene._remoteNPCSprites || {}).some(r => !r.isDead?.() && !r.isKnockedOut?.());
        if (hasEnemy) return { task: 'attack_nearest_enemy' };
        if (hasDummy) return { task: 'train' };
        return { task: 'train' };
      }
      case 'attachment':
        return { task: 'follow' };
      case 'curiosity':
        return { task: 'wander_explore' };
      case 'greed': {
        // Prefer depositing if NPC has items and crates exist
        const npcInv = npc._npcInventory || {};
        const hasCarriedOre = Object.values(npcInv).some(v => v > 0);
        const hasCarriedLogs = (npc.logs || 0) > 0;
        const hasCarriedStones = (npc.stones || 0) > 0;
        const hasCrates = (scene._crates || []).length > 0;
        if ((hasCarriedOre || hasCarriedLogs || hasCarriedStones) && hasCrates) return { task: 'deposit_to_crate' };
        // Prefer mining ores if they exist
        const hasOres = Object.values(scene._worldObjSprites || {}).some(wo => wo && !wo._depleted);
        if (hasOres) return { task: 'mine_ore' };
        return { task: 'gather', item: 'wood' };
      }
      case 'social': {
        // Find nearest remote NPC
        const remoteNpcs = Object.values(scene._remoteNPCSprites || {});
        let nearest = null, nearestDist = Infinity;
        for (const r of remoteNpcs) {
          if (r.isDead?.() || r.isKnockedOut?.()) continue;
          const d = Phaser.Math.Distance.Between(npc.x, npc.y, r.x, r.y);
          if (d < nearestDist) { nearestDist = d; nearest = r; }
        }
        if (nearest) return { task: 'socialize_npc', target_owner: nearest.ownerPid, target_npc_id: nearest.npcId, target_name: nearest.getName?.() || nearest.npcId };
        return null;
      }
      case 'survival':
        return { task: 'follow' };
      case 'ambition': {
        // Prefer ki practice if NPC has ki blast, else train
        if (npc._hasKiBlast || npc.blastLevel > 0) return { task: 'practice_ki' };
        return { task: 'train' };
      }
      default:
        return null;
    }
  }

  /**
   * Check if two drives are in conflict (close values, both high).
   * This is a signal to invoke the LLM for narrated reasoning.
   */
  static hasDriveConflict(npc) {
    const drives = npc.soul?.drives;
    if (!drives) return false;

    const vals = ['aggression','attachment','curiosity','greed','social','survival','ambition']
      .map(k => drives[k] ?? 0)
      .filter(v => v >= CONFLICT_MIN_VALUE);

    for (let i = 0; i < vals.length; i++) {
      for (let j = i + 1; j < vals.length; j++) {
        if (Math.abs(vals[i] - vals[j]) < CONFLICT_THRESHOLD) return true;
      }
    }
    return false;
  }

  /**
   * Apply decay to the drive associated with a running task.
   * Call from NPCBrain each frame while a task is running.
   */
  static applyTaskDecay(npc, taskName, deltaMs) {
    const drives = npc.soul?.drives;
    if (!drives) return;

    const affinity = TASK_DRIVE_AFFINITY[taskName];
    if (!affinity) return;

    const dt = Math.min(deltaMs / 1000, MAX_DT_SEC);
    drives[affinity] = Math.max(0, (drives[affinity] ?? 0) - TASK_DECAY_RATE * dt);
  }

  /**
   * Check player command compliance based on NPC's current dominant drive.
   * Returns { level: 'eager'|'willing'|'reluctant'|'refusal', speechHint: string }
   */
  static checkCompliance(npc, commandTask) {
    const drives = npc.soul?.drives;
    if (!drives) return { level: 'willing', speechHint: 'normal' };

    const commandDrive = TASK_DRIVE_AFFINITY[commandTask];

    // Find dominant drive name and value
    let dominantDrive = 'attachment', dominantVal = 0;
    for (const [k, v] of Object.entries(drives)) {
      if (k.startsWith('_')) continue;
      if (v > dominantVal) { dominantVal = v; dominantDrive = k; }
    }

    // Neutral command — always willing
    if (!commandDrive) return { level: 'willing', speechHint: 'normal' };

    // Command matches dominant drive — eager
    if (commandDrive === dominantDrive && dominantVal >= 0.5) {
      return { level: 'eager', speechHint: 'enthusiastic' };
    }

    // Command drive has reasonable energy — willing
    if ((drives[commandDrive] ?? 0) >= 0.3) {
      return { level: 'willing', speechHint: 'normal' };
    }

    // Survival is dominant and very high — may resist non-safety commands
    if (dominantDrive === 'survival' && dominantVal >= 0.85 && commandDrive !== 'survival') {
      return { level: 'refusal', speechHint: 'fearful' };
    }

    // Dominant drive is strong and different from command drive — reluctant
    if (dominantVal >= 0.75) {
      return { level: 'reluctant', speechHint: 'grumbling' };
    }

    return { level: 'willing', speechHint: 'normal' };
  }

  /** Get commitment duration for a personality type (ms). */
  static getCommitDuration(personalityType) {
    return COMMIT_DURATION[personalityType] ?? 8000;
  }

  /** Zero out all drives (for reset soul). */
  static resetDrives(npc) {
    const drives = npc.soul?.drives;
    if (!drives) return;
    for (const k of ['aggression','attachment','curiosity','greed','social','survival','ambition']) {
      drives[k] = 0;
    }
    drives._commitUntil = 0;
  }

  /** Get a human-readable label for the dominant drive (for UI). */
  static getDominantDriveLabel(drives) {
    if (!drives) return null;
    let best = null, bestVal = 0.15; // min visibility threshold
    for (const k of ['aggression','attachment','curiosity','greed','social','survival','ambition']) {
      const v = drives[k] ?? 0;
      if (v > bestVal) { bestVal = v; best = k; }
    }
    return best;
  }
}

// Need Phaser for distance — import lazily
import Phaser from 'phaser';
