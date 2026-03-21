import Phaser from 'phaser';
import { Rock } from '../entities/Rock.js';
import { GroundItem } from '../entities/GroundItem.js';
import { TrainingDummy } from '../entities/TrainingDummy.js';
import { Etrainer } from '../entities/Etrainer.js';
import { AnimalEntity } from '../entities/AnimalEntity.js';
import { WorldObject } from '../entities/WorldObject.js';
import { Conveyor } from '../entities/Conveyor.js';
import { Crate } from '../entities/Crate.js';
import { Furnace } from '../entities/Furnace.js';
import { LogCuttingStation } from '../entities/LogCuttingStation.js';
import { MinecartTrack } from '../entities/MinecartTrack.js';
import { TILE_SIZE, SHEET_KEY, FRAME_ANVIL, FRAME_GATE, FRAME_FENCE, FIRE_KEY, FIRE_FRAMES, tilePos } from '../constants.js';

export class WorldSyncController {
  constructor(scene) {
    this.scene = scene;
  }

  syncTrees(serverTrees) {
    if (!serverTrees) return;
    for (const st of serverTrees) {
      const tree = this.scene.entities.trees[st.id];
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
    const seenKiTargetIds = new Set();
    for (const si of serverItems) {
      seenIds.add(si.id);
      if (!scene._groundItemSprites[si.id]) {
        const gi = new GroundItem(scene, si.x, si.y, si.resource, si.amount, !!si._placed, !!si._equipment);
        gi._serverId = si.id;
        gi._isEquipment = !!si._equipment;
        gi.applyState(si);
        scene._groundItemSprites[si.id] = gi;
      } else {
        scene._groundItemSprites[si.id].applyState(si);
      }
      // Register KiTarget ground items into _kiTargetSprites so combat & NPC systems can find them
      if (si.resource === 'KiTarget') {
        seenKiTargetIds.add(si.id);
        if (!scene._kiTargetSprites[si.id]) {
          scene._kiTargetSprites[si.id] = scene._groundItemSprites[si.id];
        }
      }
    }
    for (const [id, gi] of Object.entries(scene._groundItemSprites)) {
      if (!seenIds.has(id)) {
        const idx = scene.entities.groundItems.indexOf(gi);
        if (idx >= 0) scene.entities.groundItems.splice(idx, 1);
        gi.destroy();
        delete scene._groundItemSprites[id];
      }
    }
    // Clean up removed ki targets
    for (const ktId of Object.keys(scene._kiTargetSprites)) {
      if (!seenKiTargetIds.has(ktId)) {
        delete scene._kiTargetSprites[ktId];
      }
    }
  }

  syncDummies(serverDummies) {
    const scene = this.scene;
    const seenIds = new Set();
    for (const [did, sd] of Object.entries(serverDummies)) {
      seenIds.add(did);
      let dummy = scene._dummySprites[did];
      if (!dummy) {
        if (sd.etrainer) {
          dummy = new Etrainer(scene, sd.x, sd.y);
        } else {
          dummy = new TrainingDummy(scene, sd.x, sd.y, Math.ceil(sd.maxHp / 5));
        }
        dummy._serverId = did;
        scene._dummySprites[did] = dummy;
        scene.entities.dummies.push(dummy);
      }
      if (!sd.etrainer) {
        dummy.hp = sd.hp;
        dummy.maxHp = sd.maxHp;
        dummy._updateHpBar?.();
      }
    }
    for (const [did, dummy] of Object.entries(scene._dummySprites)) {
      if (!seenIds.has(did)) {
        const idx = scene.entities.dummies.indexOf(dummy);
        if (idx >= 0) scene.entities.dummies.splice(idx, 1);
        dummy.destroy();
        delete scene._dummySprites[did];
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

  syncCampfires(serverCampfires) {
    const scene = this.scene;
    if (!scene._campfireSprites) scene._campfireSprites = {};

    // Create fire animation if it doesn't exist yet
    if (!scene.anims.exists('campfire_burn')) {
      scene.anims.create({
        key: 'campfire_burn',
        frames: scene.anims.generateFrameNumbers(FIRE_KEY, { start: 0, end: FIRE_FRAMES - 1 }),
        frameRate: 10,
        repeat: -1,
      });
    }

    const seenIds = new Set();
    for (const [cid, sc] of Object.entries(serverCampfires)) {
      seenIds.add(cid);
      let cf = scene._campfireSprites[cid];
      if (!cf) {
        cf = scene.add.sprite(sc.x, sc.y, FIRE_KEY, 0);
        cf.setScale(TILE_SIZE / 16);
        cf.setDepth(3);
        cf._serverId = cid;
        cf.play('campfire_burn');
        scene._campfireSprites[cid] = cf;

        // Add a glow circle showing the aura radius
        const glow = scene.add.circle(sc.x, sc.y, TILE_SIZE * 2, 0xff6600, 0.08);
        glow.setDepth(0);
        cf._glow = glow;
        scene.tweens.add({
          targets: glow,
          alpha: { from: 0.05, to: 0.12 },
          duration: 800,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut',
        });
      }
      cf._remaining = sc.remaining;
      cf._duration = sc.duration;

      // Fade out as fire dies — last 25% of duration
      const pct = sc.remaining / sc.duration;
      cf.setAlpha(pct < 0.25 ? 0.4 + pct * 2.4 : 1.0);
      if (cf._glow) cf._glow.setAlpha(pct < 0.25 ? 0.03 + pct * 0.2 : 0.08);
    }
    for (const [cid, cf] of Object.entries(scene._campfireSprites)) {
      if (!seenIds.has(cid)) {
        if (cf._glow) cf._glow.destroy();
        cf.destroy();
        delete scene._campfireSprites[cid];
      }
    }
  }

  syncCrops(serverCrops) {
    if (!serverCrops) return;
    const scene = this.scene;
    if (!scene._cropSprites) scene._cropSprites = {};
    const seenIds = new Set();

    for (const sc of serverCrops) {
      seenIds.add(sc.id);
      if (sc.stage === 'harvested') {
        // Hide if harvested
        if (scene._cropSprites[sc.id]) {
          scene._cropSprites[sc.id].setVisible(false);
          scene._cropSprites[sc.id]._progressBar?.setVisible(false);
        }
        continue;
      }
      if (!sc.frame) continue;

      let sprite = scene._cropSprites[sc.id];
      if (!sprite) {
        sprite = scene.add.image(sc.x, sc.y, 'roguelike');
        sprite.setDepth(4);
        sprite.setScale(3); // 16px tile → 48px world
        sprite.setInteractive({ useHandCursor: true });
        sprite.on('pointerdown', () => {
          if (sc.stage === 'ready') {
            scene._conn?.send({ type: 'harvest_crop', crop_id: sc.id });
          }
        });
        // Progress bar
        const bar = scene.add.graphics();
        bar.setDepth(5);
        sprite._progressBar = bar;
        scene._cropSprites[sc.id] = sprite;
      }

      sprite.setVisible(true);
      sprite.x = sc.x;
      sprite.y = sc.y;

      // Update frame
      const frameIndex = sc.frame.tileX + sc.frame.tileY * 57;
      sprite.setFrame(frameIndex);

      // Progress bar (only while growing)
      const bar = sprite._progressBar;
      bar.clear();
      if (sc.stage === 'growing') {
        bar.setVisible(true);
        const bw = 32;
        const bh = 3;
        const bx = sc.x - bw / 2;
        const by = sc.y + 28;
        bar.fillStyle(0x333333);
        bar.fillRect(bx, by, bw, bh);
        bar.fillStyle(0x44cc44);
        bar.fillRect(bx, by, bw * sc.progress, bh);
      } else {
        bar.setVisible(false);
      }
    }

    // Remove gone crops
    for (const [id, sprite] of Object.entries(scene._cropSprites)) {
      if (!seenIds.has(id)) {
        sprite._progressBar?.destroy();
        sprite.destroy();
        delete scene._cropSprites[id];
      }
    }
  }

  syncAnimals(serverAnimals) {
    if (!serverAnimals) return;
    const scene = this.scene;
    const seenIds = new Set();
    for (const sa of serverAnimals) {
      seenIds.add(sa.id);
      let animal = scene._animalSprites[sa.id];
      if (!animal) {
        animal = new AnimalEntity(scene, sa.x, sa.y, sa.species || 'dinobird');
        animal._serverId = sa.id;
        animal.setInteractive({ useHandCursor: true });
        animal.on('pointerdown', (ptr) => {
          if (ptr.leftButtonDown()) {
            scene._conn?.send({ type: 'attack_animal', animal_id: sa.id });
          }
        });
        scene._animalSprites[sa.id] = animal;
      }
      animal.applyState(sa);
    }
    for (const [id, animal] of Object.entries(scene._animalSprites)) {
      if (!seenIds.has(id)) {
        animal.destroy();
        delete scene._animalSprites[id];
      }
    }
  }

  syncWorldObjects(serverWorldObjects) {
    const scene = this.scene;
    if (!scene._worldObjSprites) scene._worldObjSprites = {};
    // Wait for asset manifest before creating world objects — without it
    // we don't know the correct sprite frame and would show frame 0.
    if (!scene._assetManifest) return;
    const seenIds = new Set();
    for (const [woId, swo] of Object.entries(serverWorldObjects)) {
      seenIds.add(woId);
      let wo = scene._worldObjSprites[woId];
      if (!wo) {
        // Look up asset definition from the manifest
        const assetDef = scene._assetManifest?.worldObjects?.[swo.asset_id];
        wo = new WorldObject(scene, swo.x, swo.y, woId, assetDef);
        scene._worldObjSprites[woId] = wo;
      }
      wo.applyState(swo);
    }
    for (const [woId, wo] of Object.entries(scene._worldObjSprites)) {
      if (!seenIds.has(woId)) {
        wo.destroy();
        delete scene._worldObjSprites[woId];
      }
    }
  }

  syncBuildings(serverBuildings) {
    const scene = this.scene;
    if (!scene._buildingSprites) scene._buildingSprites = {};
    const seenIds = new Set();

    for (const [bid, sb] of Object.entries(serverBuildings)) {
      seenIds.add(bid);
      let entity = scene._buildingSprites[bid];
      if (!entity) {
        const { x, y } = tilePos(sb.col, sb.row);
        if (sb.kind === 'conveyor') {
          entity = new Conveyor(scene, sb.col, sb.row, sb.direction || 'right', scene.grid);
          scene.grid.place(sb.col, sb.row, entity);
          scene._conveyors.push(entity);
          // Apply curve if out_direction differs from direction
          if (sb.out_direction && sb.out_direction !== sb.direction) {
            entity._refreshOwnSprite(sb.out_direction);
          } else {
            entity.setStraight();
          }
        } else if (sb.kind === 'crate') {
          entity = new Crate(scene, x, y);
          scene.grid.place(sb.col, sb.row, entity);
          scene._crates.push(entity);
        } else if (sb.kind === 'furnace') {
          entity = new Furnace(scene, x, y);
          entity.setGrid(scene.grid);
          scene.grid.place(sb.col, sb.row, entity);
          scene._furnaces.push(entity);
        } else if (sb.kind === 'log_cutter') {
          entity = new LogCuttingStation(scene, x, y);
          entity.setGrid(scene.grid);
          entity.setTrackClass(MinecartTrack);
          scene.grid.place(sb.col, sb.row, entity);
          scene._logCutters.push(entity);
        } else if (sb.kind === 'track') {
          entity = new MinecartTrack(scene, sb.col, sb.row, sb.direction || 'right', scene.grid);
          scene.grid.place(sb.col, sb.row, entity);
          scene._tracks.push(entity);
          if (sb.out_direction && sb.out_direction !== (sb.direction || 'right')) {
            entity._refreshOwnSprite(sb.out_direction);
          }
        } else if (sb.kind === 'etrainer') {
          // Etrainer is rendered via syncDummies, not as a building sprite
          entity = { _skip: true };
        } else if (sb.kind === 'gate' || sb.kind === 'fence') {
          const frame = sb.kind === 'gate' ? FRAME_GATE : FRAME_FENCE;
          entity = scene.add.sprite(x, y, SHEET_KEY, frame);
          entity.setScale(TILE_SIZE / 16);
          entity.setDepth(4);
          entity.col = sb.col;
          entity.row = sb.row;
          entity._kind = sb.kind;
          entity._owner = sb.owner || '';

          if (sb.kind === 'fence') {
            const hpBar = scene.add.graphics().setDepth(5);
            entity._hpBar = hpBar;
            entity._hp = sb.hp ?? 50;
            entity._maxHp = sb.maxHp ?? 50;
            this._updateFenceHpBar(entity);
            entity.setInteractive({ useHandCursor: true });
            entity.on('pointerdown', (ptr) => {
              if (ptr.leftButtonDown()) {
                scene._conn?.send({ type: 'attack_fence', building_id: bid });
              } else if (ptr.rightButtonDown()) {
                ptr._fgHandled = true;
                scene._openBuildingContextMenu(bid, 'fence', ptr, entity);
              }
            });
          } else {
            entity.setInteractive({ useHandCursor: true });
            entity.on('pointerdown', (ptr) => {
              if (ptr.rightButtonDown()) {
                ptr._fgHandled = true;
                scene._openBuildingContextMenu(bid, 'gate', ptr, entity);
              }
            });
          }
        }
        if (entity && !entity._skip) {
          entity._serverId = bid;
          scene._buildingSprites[bid] = entity;
        }
      }

      // Sync label for crates
      if (entity && sb.kind === 'crate' && entity.setLabel) {
        const serverLabel = sb.label || '';
        if (entity.getLabel() !== serverLabel) {
          entity.setLabel(serverLabel);
        }
      }

      // Sync stored contents from server — server is authoritative
      if (entity && sb.stored && (sb.kind === 'crate' || sb.kind === 'furnace' || sb.kind === 'log_cutter')) {
        if (typeof entity._applyServerStored === 'function') {
          entity._applyServerStored(sb.stored);
        }
      }

      // Sync cart state on tracks from server
      if (entity && sb.kind === 'track' && entity.applyServerCart) {
        entity.applyServerCart(sb.cart || null);
      }

      // Sync fence HP
      if (entity && sb.kind === 'fence' && sb.hp != null) {
        entity._hp = sb.hp;
        entity._maxHp = sb.maxHp ?? 50;
        this._updateFenceHpBar(entity);
      }

      // Sync gate owner
      if (entity && (sb.kind === 'gate' || sb.kind === 'fence')) {
        entity._owner = sb.owner || '';
      }

      // Re-apply conveyor out_direction on every sync (in case it was reset by neighbor refreshSprite)
      if (entity && sb.kind === 'conveyor') {
        if (sb.out_direction && sb.out_direction !== sb.direction) {
          if (entity._outDir !== sb.out_direction) {
            entity._refreshOwnSprite(sb.out_direction);
          }
        }
        if (entity.applyServerHeld) {
          entity.applyServerHeld(sb.held || null);
        }
      }
    }

    // Remove buildings that server no longer has
    for (const [bid, entity] of Object.entries(scene._buildingSprites)) {
      if (!seenIds.has(bid)) {
        if (entity instanceof Conveyor) {
          const idx = scene._conveyors.indexOf(entity);
          if (idx >= 0) scene._conveyors.splice(idx, 1);
        } else if (entity instanceof Crate) {
          const idx = scene._crates.indexOf(entity);
          if (idx >= 0) scene._crates.splice(idx, 1);
        } else if (entity instanceof Furnace) {
          const idx = scene._furnaces.indexOf(entity);
          if (idx >= 0) scene._furnaces.splice(idx, 1);
        } else if (entity instanceof LogCuttingStation) {
          const idx = scene._logCutters.indexOf(entity);
          if (idx >= 0) scene._logCutters.splice(idx, 1);
        } else if (entity instanceof MinecartTrack) {
          const idx = scene._tracks.indexOf(entity);
          if (idx >= 0) scene._tracks.splice(idx, 1);
        } else if (entity._kind === 'fence' || entity._kind === 'gate') {
          if (entity._hpBar) entity._hpBar.destroy();
        }
        if (entity.col != null && entity.row != null) scene.grid.remove(entity.col, entity.row);
        if (typeof entity.destroy === 'function') {
          entity.destroy();
        }
        delete scene._buildingSprites[bid];
      }
    }
  }

  _updateFenceHpBar(entity) {
    if (!entity._hpBar) return;
    const bar = entity._hpBar;
    bar.clear();
    const hp = entity._hp ?? 0;
    const maxHp = entity._maxHp ?? 1;
    if (hp >= maxHp) return; // Don't show bar at full HP
    const bw = 32;
    const bh = 4;
    const bx = entity.x - bw / 2;
    const by = entity.y + TILE_SIZE * 0.4;
    bar.fillStyle(0x333333);
    bar.fillRect(bx, by, bw, bh);
    const pct = hp / maxHp;
    const color = pct > 0.5 ? 0x44cc44 : pct > 0.25 ? 0xccaa44 : 0xcc4444;
    bar.fillStyle(color);
    bar.fillRect(bx, by, bw * pct, bh);
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
      const npc = scene.entities.npcs.find((n) => n.id === who);
      if (npc) npcName = npc.getName();
    }
    if (results && results.length > 0) {
      const prefix = isNPC ? `${npcName}: Found ` : 'Refined: ';
      for (const item of results) scene.chatBox?._addLog(`${prefix}${item}!`, '#44eeff');
    } else if (!isNPC) {
      scene.chatBox?._addLog('The rock crumbled to dust... nothing useful.', '#888888');
    }
  }

  handleCrystalResult(result) {
    if (!result) return;
    const scene = this.scene;
    const { who, consumed, upgraded, stat } = result;
    const isNPC = who && who !== scene.playerId;
    const name = isNPC ? (scene.entities.npcs.find(n => n.id === who)?.getName() || who) : 'You';
    if (!consumed) {
      scene.chatBox?._addLog(`${name} could not use a crystal.`, '#ff8888');
      return;
    }
    if (upgraded && stat) {
      const label = String(stat).replace('blast_', '').replace('barrier_', 'barrier ');
      const actor = isNPC
        ? scene.entities.npcs.find((n) => n.id === who)
        : scene.player;
      const value = Number(actor?.kiBlastBonuses?.[stat] || 0);
      scene.chatBox?._addLog(`${name} absorbed the crystal! +1% ${label}${value > 0 ? ` (now ${value}%)` : ''}`, '#44eeff');
    } else {
      scene.chatBox?._addLog(`${name} crushed the crystal... nothing happened.`, '#888888');
    }
  }
}
