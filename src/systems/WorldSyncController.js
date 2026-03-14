import Phaser from 'phaser';
import { Rock } from '../entities/Rock.js';
import { GroundItem } from '../entities/GroundItem.js';
import { TrainingDummy } from '../entities/TrainingDummy.js';
import { Fence } from '../entities/Fence.js';
import { TILE_SIZE, SHEET_KEY, FRAME_ANVIL } from '../constants.js';

export class WorldSyncController {
  constructor(scene) {
    this.scene = scene;
  }

  syncTrees(serverTrees) {
    if (!serverTrees) return;
    for (const st of serverTrees) {
      const tree = this.scene.trees[st.id];
      if (!tree) continue;
      tree.setChopped(st.chopped);
    }
  }

  syncRocks(serverRocks) {
    if (!serverRocks) return;
    const scene = this.scene;
    const seenIds = new Set();
    for (const sr of serverRocks) {
      seenIds.add(sr.id);
      let rock = scene._rockSprites[sr.id];
      if (!rock) {
        rock = new Rock(scene, sr.x, sr.y);
        rock.rockId = sr.id;
        rock.spawnIn();
        scene._rockSprites[sr.id] = rock;
      }
      if (!sr.mined) rock.setHits(sr.hits_left);
      else rock.setMined();
    }
    for (const [id, rock] of Object.entries(scene._rockSprites)) {
      if (!seenIds.has(Number(id))) {
        rock.setMined();
        scene.time.delayedCall(400, () => rock.destroy());
        delete scene._rockSprites[id];
      }
    }
  }

  syncGroundItems(serverItems) {
    const scene = this.scene;
    const seenIds = new Set();
    for (const si of serverItems) {
      seenIds.add(si.id);
      if (!scene._groundItemSprites[si.id]) {
        const gi = new GroundItem(scene, si.x, si.y, si.resource, si.amount, !!si._placed);
        gi._serverId = si.id;
        gi.applyState(si);
        scene._groundItemSprites[si.id] = gi;
      } else {
        scene._groundItemSprites[si.id].applyState(si);
      }
    }
    for (const [id, gi] of Object.entries(scene._groundItemSprites)) {
      if (!seenIds.has(id)) {
        const idx = scene.groundItems.indexOf(gi);
        if (idx >= 0) scene.groundItems.splice(idx, 1);
        gi.destroy();
        delete scene._groundItemSprites[id];
      }
    }
  }

  isCampfireLog(item) {
    return item && (item.resource === 'Wood' || item.resource === 'log');
  }

  isCampfireStone(item) {
    return item?.resource === 'Stone';
  }

  groundItemTile(item) {
    return { col: Math.floor(item.x / TILE_SIZE), row: Math.floor(item.y / TILE_SIZE) };
  }

  canLightCampfire(item) {
    if (!this.isCampfireLog(item) || item._lit) return false;
    const { col, row } = this.groundItemTile(item);
    const required = new Set([`${col - 1},${row}`, `${col + 1},${row}`, `${col},${row - 1}`, `${col},${row + 1}`]);
    const found = new Set();
    for (const other of this.scene.groundItems || []) {
      if (!this.isCampfireStone(other)) continue;
      const tile = this.groundItemTile(other);
      const key = `${tile.col},${tile.row}`;
      if (required.has(key)) found.add(key);
    }
    return found.size === required.size;
  }

  tryLightCampfire(item, npc = null) {
    const scene = this.scene;
    if (!item?._serverId || !this.canLightCampfire(item)) return false;
    const actor = npc || scene.player;
    if (!actor || scene._playerDead || (!npc && scene._playerKnockedOut)) return false;
    const d = Phaser.Math.Distance.Between(actor.x, actor.y, item.x, item.y);
    if (d > TILE_SIZE * 1.5) {
      const text = scene.add.text(item.x, item.y - TILE_SIZE / 2, 'Too far!', {
        fontSize: '10px', color: '#ff4444', backgroundColor: '#00000088',
        padding: { x: 3, y: 2 },
      }).setOrigin(0.5, 1).setDepth(20);
      scene.time.delayedCall(1000, () => text.destroy());
      return false;
    }
    actor.playAttack?.(item.x);
    scene._conn?.send({ type: 'light_campfire', item_id: item._serverId, ...(npc ? { npc_id: npc.id } : {}) });
    return true;
  }

  tryUseKiShrine(item, npc = null) {
    const scene = this.scene;
    if (!item?._serverId || item.resource !== 'KiShrine') return false;
    const actor = npc || ((scene.selectedNPC && !scene.selectedNPC.isDead?.()) ? scene.selectedNPC : scene.player);
    if (!actor || scene._playerDead || (!npc && scene._playerKnockedOut)) return false;
    const d = Phaser.Math.Distance.Between(actor.x, actor.y, item.x, item.y);
    if (d > TILE_SIZE * 1.5) {
      scene.chatBox?._addLog('Too far from the ki shrine.', '#ff4444');
      return false;
    }
    actor.playAttack?.(item.x);
    scene._conn?.send({
      type: 'use_ki_shrine',
      item_id: item._serverId,
      ...(actor !== scene.player ? { npc_id: actor.id } : {}),
    });
    return true;
  }

  getLitCampfires() {
    return (this.scene.groundItems || []).filter((item) =>
      this.isCampfireLog(item) && item._lit && (item._burnUntil || 0) > Date.now() / 1000
    );
  }

  findNearestLitCampfire(x, y, maxTiles = Infinity) {
    const maxDist = maxTiles * TILE_SIZE;
    let best = null;
    let bestDist = Infinity;
    for (const fire of this.getLitCampfires()) {
      const d = Phaser.Math.Distance.Between(x, y, fire.x, fire.y);
      if (d <= maxDist && d < bestDist) {
        best = fire;
        bestDist = d;
      }
    }
    return best;
  }

  syncDummies(serverDummies) {
    const scene = this.scene;
    const seenIds = new Set();
    for (const [did, sd] of Object.entries(serverDummies)) {
      seenIds.add(did);
      let dummy = scene._dummySprites[did];
      if (!dummy) {
        dummy = new TrainingDummy(scene, sd.x, sd.y, Math.ceil(sd.maxHp / 5));
        dummy._serverId = did;
        scene._dummySprites[did] = dummy;
        scene.dummies.push(dummy);
      }
      dummy.hp = sd.hp;
      dummy.maxHp = sd.maxHp;
      dummy._updateHpBar();
    }
    for (const [did, dummy] of Object.entries(scene._dummySprites)) {
      if (!seenIds.has(did)) {
        const idx = scene.dummies.indexOf(dummy);
        if (idx >= 0) scene.dummies.splice(idx, 1);
        dummy.destroy();
        delete scene._dummySprites[did];
      }
    }
  }

  syncFences(serverFences) {
    const scene = this.scene;
    const seenIds = new Set();
    for (const [fid, sf] of Object.entries(serverFences)) {
      seenIds.add(fid);
      let fence = scene._fenceSprites[fid];
      if (!fence) {
        fence = new Fence(scene, sf.x, sf.y, sf);
        scene._fenceSprites[fid] = fence;
      }
      fence.applyState(sf);
    }
    for (const [fid, fence] of Object.entries(scene._fenceSprites)) {
      if (!seenIds.has(fid)) {
        fence.destroy();
        delete scene._fenceSprites[fid];
      }
    }
  }

  syncKiTargets(serverKiTargets) {
    const scene = this.scene;
    const seenIds = new Set();
    for (const [ktid, skt] of Object.entries(serverKiTargets)) {
      seenIds.add(ktid);
      let sprite = scene._kiTargetSprites[ktid];
      if (!sprite) {
        sprite = scene.add.sprite(skt.x, skt.y, SHEET_KEY, 587);
        sprite.setScale(TILE_SIZE / 16);
        sprite.setDepth(4);
        sprite._serverId = ktid;
        scene._kiTargetSprites[ktid] = sprite;
      }
      sprite.x = skt.x;
      sprite.y = skt.y;
    }
    for (const [ktid, sprite] of Object.entries(scene._kiTargetSprites)) {
      if (!seenIds.has(ktid)) {
        sprite.destroy();
        delete scene._kiTargetSprites[ktid];
      }
    }
  }

  syncAnvils(serverAnvils) {
    const scene = this.scene;
    const seenIds = new Set();
    for (const [aid, sa] of Object.entries(serverAnvils)) {
      seenIds.add(aid);
      let sprite = scene._anvilSprites[aid];
      if (!sprite) {
        sprite = scene.add.sprite(sa.x, sa.y, SHEET_KEY, FRAME_ANVIL);
        sprite.setScale(TILE_SIZE / 16);
        sprite.setDepth(4);
        sprite._serverId = aid;
        sprite.setInteractive({ useHandCursor: true });
        sprite.on('pointerdown', (ptr) => {
          if (ptr.rightButtonDown()) scene._conn?.send({ type: 'delete_anvil', anvil_id: aid });
          else this.tryRefineAtAnvil(aid, sprite.x, sprite.y);
        });
        scene._anvilSprites[aid] = sprite;
      }
      sprite.x = sa.x;
      sprite.y = sa.y;
    }
    for (const [aid, sprite] of Object.entries(scene._anvilSprites)) {
      if (!seenIds.has(aid)) {
        sprite.destroy();
        delete scene._anvilSprites[aid];
      }
    }
  }

  tryRefineAtAnvil(anvilId, ax, ay) {
    const scene = this.scene;
    const p = scene.player;
    if (!p || scene._playerDead) return;
    const d = Phaser.Math.Distance.Between(p.x, p.y, ax, ay);
    if (d > TILE_SIZE * 1.5) {
      scene.chatBox?._addLog('Too far from the anvil.', '#ff4444');
      return;
    }
    if ((p.stones ?? 0) < 1) {
      scene.chatBox?._addLog('You need stone to refine.', '#ff4444');
      return;
    }
    scene._conn?.send({ type: 'refine_rock', anvil_id: anvilId });
  }

  handleRefineResult(result) {
    if (!result) return;
    const scene = this.scene;
    const { who, results } = result;
    const isNPC = who && who !== scene.playerId;
    let npcName = who;
    if (isNPC) {
      const npc = scene.npcs.find((n) => n.id === who);
      if (npc) npcName = npc.getName();
    }
    if (results && results.length > 0) {
      const prefix = isNPC ? `${npcName}: Found ` : 'Refined: ';
      for (const item of results) scene.chatBox?._addLog(`${prefix}${item}!`, '#44eeff');
    } else if (!isNPC) {
      scene.chatBox?._addLog('The rock crumbled to dust... nothing useful.', '#888888');
    }
  }

  handleMeditationResult(result) {
    if (!result) return;
    const scene = this.scene;
    scene._suppressMeditationRealmActorKey = null;
    const key = `${result.who || 'player'}:${result.quality || 'poor'}:${result.insight_total || 0}:${result.realm_tier || 0}:${result.realm_crystal_t1 || 0}:${result.learned_move || ''}`;
    if (scene._lastMeditationResultKey === key) return;
    scene._lastMeditationResultKey = key;
    const who = !result.who || result.who === 'player' || result.who === scene.playerId ? 'You' : result.who;
    const qualityName = result.quality === 'pristine'
      ? 'Pristine Crystal'
      : result.quality === 'normal'
        ? 'Ki Crystal'
        : 'Cracked Crystal';
    const rewards = [];
    if ((result.insight_gain ?? 0) > 0) rewards.push(`Insight +${result.insight_gain}`);
    if ((result.realm_crystal_t1 ?? 0) > 0) rewards.push(`Tier 1 Realm Crystals +${result.realm_crystal_t1}`);
    if (result.learned_move) rewards.push(`Learned ${scene._formatKiMoveLabel(result.learned_move)}`);
    scene.chatBox?._addLog(
      `${who} finished meditating with ${qualityName}. Realm Tier ${result.realm_tier ?? 0}.${rewards.length ? ` ${rewards.join(', ')}.` : ''}`,
      '#88ddff'
    );
  }

  syncMeditationRealmScene() {
    const scene = this.scene;
    const playerMeditating = !!scene.player?.meditating;
    const meditatingNpc = scene.npcs.find((npc) => npc.meditating) || null;
    const actorKey = playerMeditating ? 'player' : (meditatingNpc ? `npc:${meditatingNpc.id}` : null);
    const realmActive = scene.scene.isActive('MeditationRealmScene');
    if (!actorKey) scene._suppressMeditationRealmActorKey = null;
    if (actorKey && actorKey === scene._suppressMeditationRealmActorKey) {
      if (realmActive) scene.scene.stop('MeditationRealmScene');
      return;
    }
    if (actorKey && !realmActive) {
      scene._activeMeditationRealmActorKey = actorKey;
      scene.scene.launch('MeditationRealmScene', {
        sourceSceneKey: 'GameScene',
        actorType: playerMeditating ? 'player' : 'npc',
        npcId: meditatingNpc?.id || null,
        actorName: playerMeditating ? 'You' : (meditatingNpc?.getName?.() || meditatingNpc?.id || 'NPC'),
      });
      return;
    }
    if (!actorKey && realmActive) {
      scene.scene.stop('MeditationRealmScene');
      scene._activeMeditationRealmActorKey = null;
    }
  }

  handleKiTargetResult(result) {
    if (!result) return;
    const scene = this.scene;
    const { broke, npc_learned, npc_id } = result;
    const npc = npc_id ? scene.npcs.find((n) => n.id === npc_id) : null;
    if (npc_learned && npc) {
      npc.showBubble('I can feel the energy! I learned Ki Blast!', 5000);
      scene._addNPCSpeechToChat?.(npc, 'I learned Ki Blast!', '#44eeff');
      npc._hasKiBlast = true;
    } else if (broke && npc) {
      npc._watchingKiTarget = null;
    } else if (npc && !broke) {
      const lines = [
        'Interesting... I\'m watching closely.',
        'I think I see how you channel the energy...',
        'Keep going, I\'m learning!',
        'Fascinating technique!',
        'I can almost feel the energy flow...',
      ];
      npc.showBubble(lines[Math.floor(Math.random() * lines.length)], 2500, { silent: true });
    }
  }
}
