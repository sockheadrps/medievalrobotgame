import { RemotePlayer } from '../entities/RemotePlayer.js';
import { RemoteNPC } from '../entities/RemoteNPC.js';
export class StateSyncController {
  constructor(scene) {
    this.scene = scene;
  }

  applyServerState(data) {
    const scene = this.scene;
    scene._lastServerState = data;
    scene._xpMultipliers = (data.xp_multipliers && typeof data.xp_multipliers === 'object')
      ? { ...data.xp_multipliers }
      : (scene._xpMultipliers || { player: 1, npc: 1, ai_player: 1, ai_npc: 1 });
    if (scene.playerId === 'default') return;

    const players = data.players || {};
    const me = players[scene.playerId];
    if (me) {
      const prevPlayerHp = scene.player.hp;
      scene.player.x += (me.x - scene.player.x) * 0.3;
      scene.player.y += (me.y - scene.player.y) * 0.3;
      scene.player.logs = me.logs ?? 0;
      scene.player.stones = me.stones ?? 0;
      scene.player.crystals = me.crystals ?? scene.player.crystals ?? 0;
      scene.player.meat = me.meat ?? scene.player.meat ?? 0;
      scene.player.feathers = me.feathers ?? scene.player.feathers ?? 0;
      scene.player.vegetables = me.vegetables ?? scene.player.vegetables ?? 0;
      scene.player.seeds = me.seeds ?? scene.player.seeds ?? 0;
      scene.player.copper = me.copper ?? scene.player.copper ?? 0;
      scene.player.hp = me.hp ?? scene.player.hp;
      scene.player.maxHp = me.maxHp ?? scene.player.maxHp;
      scene.player.ki = me.ki ?? scene.player.ki;
      scene.player.maxKi = me.maxKi ?? scene.player.maxKi;
      scene.player.infKi = !!me.inf_ki;
      scene.player.blastLevel = me.blastLevel ?? scene.player.blastLevel;
      scene.player.kiSkillLevel = me.kiSkillLevel ?? scene.player.kiSkillLevel;
      scene.player.kiSkillXp = me.kiSkillXp ?? scene.player.kiSkillXp;
      scene.player.kiBlastBonuses = (me.ki_blast_bonuses && typeof me.ki_blast_bonuses === 'object') ? { ...me.ki_blast_bonuses } : (scene.player.kiBlastBonuses || {});
      if (Array.isArray(me.ki_moves)) scene.player.kiMoves = me.ki_moves;
      scene.player.str = me.str ?? scene.player.str;
      scene.player.def = me.def ?? scene.player.def;
      scene.player.level = me.level ?? scene.player.level;
      scene.player.xp = me.xp ?? scene.player.xp;
      scene.player.barrierProcUntil = Number(me.barrier_proc_until || 0);
      scene.player.barrierProcFacing = me.barrier_proc_facing || scene.player.barrierProcFacing || 'down';
      scene.player.combatMode = me.combat_mode ?? scene.player.combatMode ?? 'kill';
      scene.player.equipment = me.equipment ?? scene.player.equipment ?? {};
      scene.player.inventory = me.inventory ?? scene.player.inventory ?? {};
      scene.player._carrying = !!me.carrying;

      // Map change detection
      const newMap = me.map ?? 'level_01';
      if (newMap !== (scene._currentMap ?? 'level_01')) {
        scene._changeMap(newMap);
      }

      if ((me.hp ?? prevPlayerHp) > prevPlayerHp) {
        scene.player.showHealEffect?.((me.hp ?? prevPlayerHp) - prevPlayerHp);
      }

      if (me._refine_result) scene._handleRefineResult(me._refine_result);
      if (me._crystal_result) scene._handleCrystalResult?.(me._crystal_result);
    }

    const seenPids = new Set();
    for (const [pid, pState] of Object.entries(players)) {
      if (pid === scene.playerId) continue;
      seenPids.add(pid);

      let rp = scene._remotePlayers[pid];
      if (!rp) {
        rp = new RemotePlayer(scene, pState.x, pState.y, pid);
        scene._remotePlayers[pid] = rp;
      }
      const wasDead = rp._dead;
      rp.applyState(pState);
      if (pState.dead && !wasDead) {
        scene._notifyNearbyNPCsOfKill('player', pid, null, rp.x, rp.y);
      }
    }

    for (const pid of Object.keys(scene._remotePlayers)) {
      if (!seenPids.has(pid)) {
        scene._remotePlayers[pid].destroy();
        delete scene._remotePlayers[pid];
      }
    }

    if (data.trees) scene._syncTrees(data.trees);
    if (data.rocks) scene._syncRocks(data.rocks);
    scene._syncGroundItems(data.ground_items || []);
    scene._syncDummies(data.dummies || {});
    scene._syncAnvils(data.anvils || {});
    scene._syncCampfires(data.campfires || {});
    scene._syncAnimals(data.animals || []);
    scene._syncCrops(data.crops || []);
    scene._syncWorldObjects(data.world_objects || {});
    scene._syncBuildings(data.buildings || {});
    this.syncRemoteNPCs(players);
    scene._handleReplicatedFxEvents(data.fx_events || []);

    const myData = players[scene.playerId];
    if (myData?.npcs) {
      if (!scene._lastServerNPCLogs) scene._lastServerNPCLogs = {};
      for (const npc of scene.entities.npcs) {
        const serverNPC = myData.npcs[npc.id];
        if (!serverNPC) continue;
        const wasKnocked = npc.isKnockedOut?.() || false;
        npc.maxHp = serverNPC.maxHp ?? npc.maxHp;
        npc.str = serverNPC.str ?? npc.str;
        npc.def = serverNPC.def ?? npc.def;
        npc.level = serverNPC.level ?? npc.level;
        npc.xp = serverNPC.xp ?? npc.xp;
        npc.maxLogs = serverNPC.maxLogs ?? npc.maxLogs;
        if (serverNPC.has_ki_blast) npc._hasKiBlast = true;
        if (serverNPC.ki != null) npc.ki = serverNPC.ki;
        if (serverNPC.maxKi != null) npc.maxKi = serverNPC.maxKi;
        npc.infKi = !!serverNPC.inf_ki;
        if (serverNPC.blastLevel != null) npc.blastLevel = serverNPC.blastLevel;
        npc.kiBlastBonuses = (serverNPC.ki_blast_bonuses && typeof serverNPC.ki_blast_bonuses === 'object') ? { ...serverNPC.ki_blast_bonuses } : (npc.kiBlastBonuses || {});
        if (Array.isArray(serverNPC.ki_moves)) npc.kiMoves = serverNPC.ki_moves;
        if (serverNPC.stones != null) npc.stones = serverNPC.stones;
        if (serverNPC.crystals != null) npc.crystals = serverNPC.crystals;
        // Sync ore/resource inventory from server (updated by background worker ticks)
        if (serverNPC.inventory && typeof serverNPC.inventory === 'object') {
          npc._npcInventory = { ...serverNPC.inventory };
        }
        // Sync equipment from server
        if (serverNPC.equipment && typeof serverNPC.equipment === 'object') {
          npc.equipment = { ...serverNPC.equipment };
        }
        npc.barrierProcUntil = Number(serverNPC.barrier_proc_until || 0);
        npc.barrierProcFacing = serverNPC.barrier_proc_facing || npc.barrierProcFacing || npc.getFacing?.() || 'down';
        npc.setKnockedOut?.(!!serverNPC.knocked_out, {
          knockedUntil: serverNPC.knocked_until ?? 0,
        });
        if (serverNPC.knocked_out && !wasKnocked) {
          scene._handleOwnNPCKnockoutTransition(npc, serverNPC);
        } else if (!serverNPC.knocked_out && wasKnocked) {
          scene._handleOwnNPCWakeTransition(npc, serverNPC);
        }
        if (!serverNPC.knocked_out && wasKnocked) {
          npc.hp = serverNPC.hp ?? npc.hp;
        }
        if (serverNPC.hp > npc.hp) {
          const healed = serverNPC.hp - npc.hp;
          npc.hp = serverNPC.hp;
          npc.showHealEffect?.(healed);
        }
        if (serverNPC.knocked_out) {
          npc.x = serverNPC.x ?? npc.x;
          npc.y = serverNPC.y ?? npc.y;
        }

        if (serverNPC.hp < npc.hp) {
          const prevHp = npc.hp;
          npc.hp = serverNPC.hp;
          const attackedBy = serverNPC._last_attacked_by;
          if (attackedBy) {
            const threatKey = attackedBy.type === 'npc'
              ? `npc:${attackedBy.owner}_${attackedBy.id}`
              : `player:${attackedBy.id}`;
            scene._recentThreats[threatKey] = Date.now();
          }
          if (attackedBy && attackedBy.id !== scene.playerId) {
            const isNpcAttacker = attackedBy.type === 'npc';
            const relKey = isNpcAttacker ? `npc:${attackedBy.id}` : attackedBy.id;

            let attackerInfo;
            if (isNpcAttacker) {
              const spriteKey = attackedBy.owner ? `${attackedBy.owner}_${attackedBy.id}` : attackedBy.id;
              const rnpc = scene._remoteNPCSprites[spriteKey];
              attackerInfo = {
                type: 'npc', id: attackedBy.id,
                level: rnpc?.level, str: rnpc?.str, def: rnpc?.def,
                hp: rnpc?.hp, maxHp: rnpc?.maxHp,
              };
            } else {
              const rp = scene._remotePlayers[attackedBy.id];
              attackerInfo = {
                type: 'player', id: attackedBy.id,
                level: rp?.level, str: rp?.str, def: rp?.def,
                hp: rp?._hp, maxHp: rp?._maxHp,
              };
            }

            const brain = scene._npcBrains.get(npc.id);
            if (brain) {
              brain.pushEvent({
                type: 'attacked',
                attacker_type: attackedBy.type,
                attacker_id: attackedBy.id,
                damage: prevHp - npc.hp,
                hp_remaining: npc.hp,
              });
            }

            const hpPct = npc.hp / npc.maxHp;
            if (hpPct > 0) {
              npc.applyEmotionDeltas({ anger: 0.12, fear: 0.05 }, relKey);

              const assessment = npc.assessThreat(attackerInfo);
              const runner = scene._taskRunners.get(npc.id);
              if (runner) {
                if (assessment.action === 'fight') {
                  npc.applyEmotionDeltas({ anger: 0.15, fear: -0.1 }, relKey);
                  npc.showBubble(`You'll regret that!`, 3000);
                  if (isNpcAttacker) {
                    runner.setTasks([{
                      task: 'attack_npc',
                      target_owner: attackedBy.owner,
                      target_npc_id: attackedBy.id,
                    }]);
                  } else {
                    runner.setTasks([{ task: 'attack_player', target_id: attackedBy.id }]);
                  }
                } else {
                  npc.applyEmotionDeltas({ fear: 0.25, anger: -0.1 }, relKey);
                  npc.showBubble(`I can't take much more of this!`, 3000);
                  runner.setTasks([{
                    task: 'flee_player',
                    target_id: relKey,
                    target_owner: attackedBy.owner,
                    target_npc_id: isNpcAttacker ? attackedBy.id : null,
                  }]);
                }
              }
            }
          }

          if (serverNPC.dead && !npc.isDead()) {
            npc._triggerDeath();
            scene._notifyNearbyNPCsOfKill('own_npc', scene.playerId, npc.id, npc.x, npc.y);
          }
        }

        const serverLogs = serverNPC.logs ?? 0;
        const prevServerLogs = scene._lastServerNPCLogs[npc.id] ?? serverLogs;
        if (serverLogs < prevServerLogs) {
          if (npc._givingLogs) {
            npc._givingLogs = false;
          } else {
            const stolen = prevServerLogs - serverLogs;
            npc.logs = Math.max(0, npc.logs - stolen);

            const robbedBy = serverNPC._last_robbed_by;
            let thiefName = 'Someone';
            let thiefNpcId = null;
            if (robbedBy && robbedBy.npc_id) {
              thiefNpcId = robbedBy.npc_id;
              const thiefKey = `${robbedBy.owner}_${robbedBy.npc_id}`;
              const thiefSprite = scene._remoteNPCSprites?.[thiefKey];
              thiefName = thiefSprite?.getName?.() || `${robbedBy.owner}'s NPC`;
            }

            const robbedLine = `${thiefName} stole ${stolen} log${stolen > 1 ? 's' : ''} from me!`;
            npc.showBubble(robbedLine, 4000, { silent: true });
            scene._addNPCSpeechToChat(npc, robbedLine, '#ffaaaa');

            const brain = scene._npcBrains?.get(npc.id);
            const relKey = thiefNpcId ? `npc:${thiefNpcId}` : 'strangers';
            if (brain) {
              brain.pushEvent({
                type: 'robbed',
                text: `${thiefName} stole ${stolen} log(s) from me!`,
                importance: 0.9,
              });
              npc.applyEmotionDeltas({ anger: 0.15, trust: -0.1 }, relKey);
            }
            npc.addMemory(
              `${thiefName} stole ${stolen} log(s) from me while I was gathering wood.`,
              'event', relKey, 0.9
            );
          }
        }
        scene._lastServerNPCLogs[npc.id] = serverLogs;
      }
    }

    if (me?.dead && !scene._playerDead) {
      scene._playerDead = true;
      scene._notifyNearbyNPCsOfKill('own_player', scene.playerId, null, scene.player.x, scene.player.y);
      scene._showDeathScreen();
    } else if (me && !me.dead && scene._playerDead) {
      scene._playerDead = false;
      scene._hideDeathScreen();
    }
  }

  syncRemoteNPCs(players) {
    const scene = this.scene;
    const seenKeys = new Set();
    for (const [pid, pState] of Object.entries(players || {})) {
      if (pid === scene.playerId) continue;
      const npcs = pState.npcs || {};
      for (const [npcId, npcState] of Object.entries(npcs)) {
        const key = `${pid}_${npcId}`;
        seenKeys.add(key);
        let rnpc = scene._remoteNPCSprites[key];
        if (!rnpc) {
          rnpc = new RemoteNPC(scene, npcState.x, npcState.y, npcId, pid, npcState.name);
          scene._remoteNPCSprites[key] = rnpc;
        }
        const wasDead = rnpc._dead;
        const wasKnocked = rnpc.isKnockedOut?.() || false;
        rnpc.applyState(npcState);
        const ownerColor = pState.chatColor || '#cccccc';
        rnpc.setOwnerColor(ownerColor);
        if (npcState.knocked_out && !wasKnocked) {
          rnpc._koOrigin = { x: npcState.x ?? rnpc.x, y: npcState.y ?? rnpc.y };
        } else if (!npcState.knocked_out && wasKnocked) {
          scene._handleRemoteNPCWakeTransition(rnpc, npcState);
        }
        if (npcState.dead && !wasDead) {
          scene._notifyNearbyNPCsOfKill('npc', pid, npcId, rnpc.x, rnpc.y);
        }
      }
    }

    for (const [key, rnpc] of Object.entries(scene._remoteNPCSprites)) {
      if (!seenKeys.has(key)) {
        rnpc.destroy();
        delete scene._remoteNPCSprites[key];
      }
    }
  }
}
