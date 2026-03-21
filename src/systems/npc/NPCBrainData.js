// NPCBrainData.js — builds the LLM state packet and allowed-actions list.
// Extracted from NPCBrain.js. Receives (scene, npc, brain) in constructor.
//
// Responsibilities:
//   - Gather nearby entities, threats, trees, ores, crates into a structured packet
//   - Compute NPC-to-NPC relationship summaries
//   - Build the full decision packet for generateDecision()
//   - Summarize memories for LLM context

import Phaser from 'phaser';
import { TILE_SIZE } from '../../constants.js';

export class NPCBrainData {
  constructor(scene, npc, brain) {
    this._scene = scene;
    this._npc = npc;
    this._brain = brain;
  }

  /** Build the full state packet sent to the LLM. */
  buildStatePacket() {
    const scene = this._scene;
    const npc   = this._npc;
    const brain = this._brain;
    const player = scene.player;
    const playerId = scene.playerId;

    const playerDist = player
      ? Phaser.Math.Distance.Between(npc.x, npc.y, player.x, player.y) / TILE_SIZE
      : 999;

    // Current task runner status
    const runnerStatus = brain._runner.getStatus();
    const currentCommand = runnerStatus.running
      ? { type: runnerStatus.tasks[0]?.task || 'idle', age_ms: Date.now() - brain._lastDecisionTime }
      : { type: 'idle', age_ms: 0 };

    // Nearby entities — dummies, other players, remote NPCs
    const nearbyEntities = [];
    for (const dummy of (scene.dummies ?? [])) {
      if (dummy.isDead()) continue;
      const dist = Phaser.Math.Distance.Between(npc.x, npc.y, dummy.x, dummy.y) / TILE_SIZE;
      if (dist < 12) {
        const isEtrainer = !!dummy._isEtrainer;
        nearbyEntities.push({
          id: dummy._serverId || 'local_dummy',
          type: isEtrainer ? 'etrainer' : 'training_dummy',
          name: isEtrainer ? 'Etrainer (infinite HP)' : 'Training Dummy',
          distance: parseFloat(dist.toFixed(1)),
          hp: isEtrainer ? 'infinite' : dummy.hp,
          maxHp: isEtrainer ? 'infinite' : dummy.maxHp,
          visible: true,
        });
      }
    }

    // Other players
    for (const rp of Object.values(scene._remotePlayers || {})) {
      if (rp.isDead?.()) continue;
      const dist = Phaser.Math.Distance.Between(npc.x, npc.y, rp.x, rp.y) / TILE_SIZE;
      if (dist < 12) {
        nearbyEntities.push({
          id: rp.playerId,
          type: 'player',
          name: rp.playerId,
          distance: parseFloat(dist.toFixed(1)),
          hp: rp._hp,
          maxHp: rp._maxHp,
          visible: true,
        });
      }
    }

    // Other players' NPCs
    for (const rnpc of Object.values(scene._remoteNPCSprites || {})) {
      if (rnpc.isDead?.()) continue;
      const dist = Phaser.Math.Distance.Between(npc.x, npc.y, rnpc.x, rnpc.y) / TILE_SIZE;
      if (dist < 12) {
        nearbyEntities.push({
          id: `${rnpc.ownerPid}_${rnpc.npcId}`,
          npc_id: rnpc.npcId,
          type: 'enemy_npc',
          name: rnpc.getName(),
          owner: rnpc.ownerPid,
          distance: parseFloat(dist.toFixed(1)),
          hp: rnpc.hp,
          maxHp: rnpc.maxHp,
          logs: rnpc.logs ?? 0,
          maxLogs: rnpc.maxLogs ?? 0,
          gathering: rnpc.gathering ?? false,
          visible: true,
        });
      }
    }

    // Nearby threats tracked from recent combat events
    const nearbyThreats = [];
    const recentThreats = scene._recentThreats || {};
    for (const rp of Object.values(scene._remotePlayers || {})) {
      if (rp.isDead?.()) continue;
      const threatKey = `player:${rp.playerId}`;
      if (!recentThreats[threatKey]) continue;
      const dist = Phaser.Math.Distance.Between(npc.x, npc.y, rp.x, rp.y) / TILE_SIZE;
      if (dist >= 12) continue;
      nearbyThreats.push({
        id: rp.playerId,
        type: 'player',
        name: rp.playerId,
        distance: parseFloat(dist.toFixed(1)),
      });
    }
    for (const rnpc of Object.values(scene._remoteNPCSprites || {})) {
      if (rnpc.isDead?.()) continue;
      const threatKey = `npc:${rnpc.npcId}`;
      if (!recentThreats[threatKey]) continue;
      const dist = Phaser.Math.Distance.Between(npc.x, npc.y, rnpc.x, rnpc.y) / TILE_SIZE;
      if (dist >= 12) continue;
      nearbyThreats.push({
        id: `${rnpc.ownerPid}_${rnpc.npcId}`,
        npc_id: rnpc.npcId,
        type: 'enemy_npc',
        name: rnpc.getName(),
        owner: rnpc.ownerPid,
        distance: parseFloat(dist.toFixed(1)),
      });
    }

    // Nearby trees (un-chopped)
    let nearbyTrees = 0;
    for (const tree of (scene.trees ?? [])) {
      if (tree._chopped) continue;
      const dist = Phaser.Math.Distance.Between(npc.x, npc.y, tree.x, tree.y) / TILE_SIZE;
      if (dist < 10) nearbyTrees++;
    }

    // Nearby mineable world objects (ores)
    const nearbyOres = [];
    for (const [woId, wo] of Object.entries(scene._worldObjSprites || {})) {
      if (!wo || wo._depleted) continue;
      const dist = Phaser.Math.Distance.Between(npc.x, npc.y, wo.x, wo.y) / TILE_SIZE;
      if (dist < 12) {
        nearbyOres.push({ id: woId, asset_id: wo._assetId || 'ore', distance: parseFloat(dist.toFixed(1)) });
      }
    }

    // Nearby crates (for depositing)
    const nearbyCrates = [];
    for (const crate of (scene._crates || [])) {
      const dist = Phaser.Math.Distance.Between(npc.x, npc.y, crate.x, crate.y) / TILE_SIZE;
      if (dist < 12) {
        nearbyCrates.push({ id: crate._serverId, label: crate.getLabel?.() || '', distance: parseFloat(dist.toFixed(1)), stored: crate.getStored?.() || {} });
      }
    }

    // Recent events — age them
    const now = Date.now();
    const recentEvents = brain._recentEvents
      .map(e => ({
        type: e.type,
        text: e.text,
        age_ms: now - e.ts,
        importance: e.importance,
      }))
      .filter(e => e.age_ms < 30000); // only last 30s

    // Soul context
    const soul = npc.getSoulContext(playerId);

    // NPC-to-NPC relationships — summarize grudges/friendships with nearby NPCs
    const npcRelationships = {};
    for (const entity of nearbyEntities) {
      if (entity.type !== 'enemy_npc') continue;
      const relKey = `npc:${entity.npc_id || entity.id}`;
      const rel = npc.soul.relationships[relKey];
      if (rel) {
        npcRelationships[entity.id] = {
          name: entity.name,
          trust: rel.trust,
          anger: rel.anger,
          fear: rel.fear,
          label: rel.label,
        };
      }
      // Include relevant memories about this NPC (use bare npcId key)
      const memKey = `npc:${entity.npc_id || entity.id}`;
      const mems = npc.soul.memories[memKey];
      if (mems?.length > 0) {
        npcRelationships[entity.id] = npcRelationships[entity.id] || { name: entity.name };
        npcRelationships[entity.id].memories = mems.slice(0, 3).map(m => m.text);
      }
    }

    // Build the packet
    return {
      mode: 'decision',
      npc: {
        id: npc.id,
        name: npc.getName(),
        personality: soul.personality,
        state: {
          hp: npc.hp,
          maxHp: npc.maxHp,
          str: npc.str,
          def: npc.def,
          level: npc.level,
          logs: npc.logs,
          maxLogs: npc.maxLogs,
          inventory: npc._npcInventory || {},
          stones: npc.stones || 0,
          status: currentCommand.type,
        },
        current_command: currentCommand,
        emotion: soul.emotional_state,
        relationship: soul.relationship,
        npc_relationships: npcRelationships,
        drives: npc.soul?.drives ? {
          aggression: +(npc.soul.drives.aggression ?? 0).toFixed(2),
          attachment: +(npc.soul.drives.attachment ?? 0).toFixed(2),
          curiosity:  +(npc.soul.drives.curiosity  ?? 0).toFixed(2),
          greed:      +(npc.soul.drives.greed      ?? 0).toFixed(2),
          social:     +(npc.soul.drives.social     ?? 0).toFixed(2),
          survival:   +(npc.soul.drives.survival   ?? 0).toFixed(2),
          ambition:   +(npc.soul.drives.ambition   ?? 0).toFixed(2),
        } : null,
      },
      player: {
        id: playerId,
        distance: parseFloat(playerDist.toFixed(1)),
        visible: true,
        hp: player?.hp ?? 0,
        maxHp: player?.maxHp ?? 0,
        logs: player?.logs ?? 0,
      },
      nearby_entities: nearbyEntities,
      nearby_threats: nearbyThreats,
      nearby_trees: nearbyTrees,
      nearby_ores: nearbyOres,
      nearby_crates: nearbyCrates,
      learned_phrases: soul.learned_phrases || [],
      recent_events: recentEvents,
      memory_summary: summarizeMemories(soul.memories),
      allowed_actions: this.getAllowedActions(),
    };
  }

  /** Returns the list of action intents the LLM may choose from. */
  getAllowedActions() {
    const scene = this._scene;
    const actions = [
      'follow', 'stay_near_player', 'defend_player', 'attack_enemy',
      'attack_player', 'attack_npc', 'absorb_npc',
      'retreat', 'hold_position', 'observe', 'do_nothing', 'wander_explore',
      'gather_wood', 'give_logs', 'train', 'practice_ki',
      'socialize_npc', 'steal_logs',
    ];
    // Context-dependent actions — only offer if relevant entities exist
    const hasOres = Object.values(scene._worldObjSprites || {}).some(wo => wo && !wo._depleted);
    const hasCrates = (scene._crates || []).length > 0;
    if (hasOres) actions.push('mine_ore');
    if (hasCrates) actions.push('deposit_to_crate');
    return actions;
  }
}

/** Summarize memories array into a compact object for LLM context. */
export function summarizeMemories(memories) {
  if (!memories || memories.length === 0) {
    return { self: 'I am a robot companion built by the player.', player: 'The player is my creator.' };
  }
  const recent = memories.slice(-5);
  return {
    self: 'I am a robot companion built by the player.',
    player: recent.join(' | ').slice(0, 200) || 'The player is my creator.',
  };
}
