// SaveSystem — serialises/deserialises the full game state to localStorage.
//
// Save key: 'futuregame_save'
// Auto-save every 30 seconds; Ctrl+S saves immediately.
// On load, the scene must NOT have placed any conveyors/buildings yet — call
// load() after grid + panels are ready but before trees / other static objects.

import { Conveyor   } from '../entities/Conveyor.js';
import { Crate      } from '../entities/Crate.js';
import { Furnace    } from '../entities/Furnace.js';
import { Quarry     } from '../entities/Quarry.js';
import { OreCrusher } from '../entities/OreCrusher.js';
import { Flywheel   } from '../entities/Flywheel.js';
import { Anvil, ANVIL_RECIPES } from '../entities/Anvil.js';
import { CraftingBench, BENCH_RECIPES } from '../entities/CraftingBench.js';
import { PlacedStructure } from '../entities/PlacedStructure.js';
import { Door } from '../entities/Door.js';
import { GroundItem } from '../entities/GroundItem.js';
import { WoodRobotChasisPod } from '../entities/WoodRobotChasisPod.js';
import { WoodCraftingTable } from '../entities/WoodCraftingTable.js';
import {
  TILE_SIZE, RESOURCE_FRAME, CONV_FRAME_LOOKUP, FRAME_CONV_H, tilePos,
} from '../constants.js';

const SAVE_KEY     = 'futuregame_save';
const AUTOSAVE_MS  = 30_000;

export class SaveSystem {
  constructor(scene) {
    this._scene = scene;

    // Auto-save timer
    scene.time.addEvent({
      delay: AUTOSAVE_MS,
      loop: true,
      callback: () => this.save(),
      callbackScope: this,
    });

    // Ctrl+S manual save
    scene.input.keyboard.on('keydown-S', (e) => {
      if (e.ctrlKey) { e.preventDefault(); this.save(); }
    });
  }

  // ── Save ───────────────────────────────────────────────────────────────────

  save() {
    const scene = this._scene;

    const data = {
      version: 1,
      motherMachineTier: scene.motherMachineTier ?? 1,
      woodRobotCounter: scene._nextWoodRobotId ?? 0,
      inventory: scene.inventory.serialise(),
      skills: scene.skillSystem?.serialise?.() ?? null,
      conveyors: scene.conveyors.map(c => ({
        col: c.col, row: c.row,
        direction: c.direction,
        outDir: c._outDir,
        conveyorType: c.conveyorType ?? 'regular',
        held: c._held ?? null,
      })),
      crates: scene.crates.map(cr => ({
        col: Math.floor((cr.x - TILE_SIZE / 2) / TILE_SIZE),
        row: Math.floor((cr.y - TILE_SIZE / 2) / TILE_SIZE),
        variant: cr.getVariant?.() ?? 'storage',
        stored: cr.getStored(),
        acceptList: cr.getAcceptList() ?? null,
      })),
      furnaces: scene.furnaces.map(f => ({
        col:         f.col, row: f.row,
        furnaceType: f.furnaceType ?? 'iron',
        input1:      f._input1,
        input2:      f._input2,
        bars:        f._bars,
        wood:        f._wood,
        smelting:    f._smelting,
        burning:     f._burning,
      })),
      quarries: scene.quarries.map(q => ({
        col: q.col, row: q.row,
        ore: q._ore,
      })),
      crushers: scene.crushers.map(c => ({
        col: c.col, row: c.row,
        ore: c._ore,
        iron: c._iron,
        crushing: c._crushing,
      })),
      groundItems: scene.groundItems
        .filter(g => g.active)
        .map(g => ({ x: g.x, y: g.y, resource: g.resource, amount: g.amount })),
      flywheels: (scene.flywheels ?? []).map(fw => ({
        col: fw.col, row: fw.row,
        momentum: fw._momentum,
        flywheelType: fw.flywheelType ?? 'regular',
      })),
      woodRobotPods: (scene.woodRobotPods ?? []).map(p => ({
        col: p.col, row: p.row,
        charge: p.charge ?? 0,
        hatch: p.hatch ?? 0,
      })),
      anvils: (scene.anvils ?? []).map(av => ({
        col: av.col, row: av.row,
        activeRecipeId: av._activeRecipe?.id ?? null,
      })),
      craftingBenches: (scene.craftingBenches ?? []).map(b => ({
        col: b.col, row: b.row,
        activeRecipeId: b._activeRecipe?.id ?? null,
      })),
      woodCraftingTables: (scene.woodCraftingTables ?? []).map(t => t.serialise()),
      structures: (scene.structures ?? []).filter(s => !s._broken).map(s => ({
        col: s.col, row: s.row, type: s.type, hp: s.hp,
      })),
      doors: (scene.doors ?? []).filter(d => !d._broken).map(d => ({
        col: d.col, row: d.row, open: d._open, hp: d.hp,
      })),
      mineRocksDepleted: (scene.mineRocks ?? [])
        .filter(r => r.isDepleted())
        .map(r => ({ x: r.x, y: r.y })),
      npcs: scene.npcs.map(n => ({
        id: n.id,
        x: n.x,
        y: n.y,
        name: n._nameLabel?.text ?? null,
        profile: n.getProfile?.() ?? 'standard',
        inventory: { ...n._inventory },
        skills: n.skills.serialise(),
        upgrades: { ...n.upgrades },
        tasks: n.taskRunner?.serialiseTasks() ?? null,
        assignedTargets: _serialiseAssignedTargets(n.assignedTargets),
        soul: n.soul ?? null,
      })),
    };

    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(data));
      scene.events.emit('game-saved');
    } catch (e) {
      console.warn('Save failed:', e);
    }
  }

  // ── Load ──────────────────────────────────────────────────────────────────

  hasSave() {
    return localStorage.getItem(SAVE_KEY) !== null;
  }

  load() {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;

    let data;
    try { data = JSON.parse(raw); } catch { return false; }
    if (!data || data.version !== 1) return false;

    const scene = this._scene;

    // ── Mother Machine tier ───────────────────────────────────────────────────
    if (data.motherMachineTier) {
      scene.motherMachineTier = data.motherMachineTier;
      scene.machine.setTier(data.motherMachineTier);
      scene.hud.updateTier(data.motherMachineTier);
    }
    if (typeof data.woodRobotCounter === 'number') {
      scene._nextWoodRobotId = data.woodRobotCounter;
    }

    // ── Inventory ────────────────────────────────────────────────────────────
    if (data.inventory) {
      scene.inventory.deserialise(data.inventory);
    }
    if (data.skills) {
      scene.skillSystem.deserialise(data.skills);
      const conLvl = scene.skillSystem.getLevel('constitution');
      const athLvl = scene.skillSystem.getLevel('athletics');
      scene.player.setConstitutionLevel(conLvl);
      scene.player.setAthleticsLevel(athLvl);
      scene.hud.updateSkills(scene.skillSystem);
    }

    // ── Crates ───────────────────────────────────────────────────────────────
    if (data.crates) {
      for (const cd of data.crates) {
        const { x, y } = tilePos(cd.col, cd.row);
        const crate = new Crate(scene, x, y, { variant: cd.variant ?? 'storage' });
        crate.setPanel(scene.storagePanel);
        if (cd.stored) {
          for (const [res, amt] of Object.entries(cd.stored)) {
            crate._stored[res] = amt;
          }
        }
        if (cd.acceptList) crate.setAcceptList(cd.acceptList);
        scene.grid.place(cd.col, cd.row, crate);
        scene.crates.push(crate);
      }
    }

    // ── Furnaces ─────────────────────────────────────────────────────────────
    if (data.furnaces) {
      for (const fd of data.furnaces) {
        const type = fd.furnaceType ?? (fd.ironInput !== undefined ? 'iron' : 'iron');
        const f = new Furnace(scene, fd.col, fd.row, type);
        f.setPanel(scene.furnacePanel);
        f.setGrid(scene.grid);
        // Support both old save format (ironInput/ironBars) and new format (input1/bars)
        f._input1 = fd.input1 ?? fd.ironInput ?? 0;
        f._input2 = fd.input2 ?? 0;
        f._bars   = fd.bars   ?? fd.ironBars  ?? 0;
        f._wood   = fd.wood   ?? 0;
        // Restore in-progress state — use _tryBurn/_tryStartSmelt so timers re-fire
        if (fd.burning)  f._tryBurn();
        if (fd.smelting) f._tryStartSmelt();
        f._updateLabel();
        scene.grid.place(fd.col, fd.row, f);
        scene.furnaces.push(f);
      }
    }

    // ── Quarries ─────────────────────────────────────────────────────────────
    if (data.quarries) {
      for (const qd of data.quarries) {
        const q = new Quarry(scene, qd.col, qd.row);
        q.setGrid(scene.grid);
        q._ore = qd.ore ?? 0;
        q._updateLabel();
        scene.grid.place(qd.col, qd.row, q);
        scene.quarries.push(q);
      }
    }

    // ── Ore Crushers ─────────────────────────────────────────────────────────
    if (data.crushers) {
      for (const cd of data.crushers) {
        const c = new OreCrusher(scene, cd.col, cd.row);
        c.setGrid(scene.grid);
        c._ore  = cd.ore  ?? 0;
        c._iron = cd.iron ?? 0;
        if (cd.crushing) c._startCrush();
        c._updateLabel();
        scene.grid.place(cd.col, cd.row, c);
        scene.crushers.push(c);
      }
    }

    // ── Conveyors ────────────────────────────────────────────────────────────
    // Place all tiles first so neighbors are in the grid, then restore sprites.
    if (data.conveyors) {
      const placedConveyors = [];
      for (const cv of data.conveyors) {
        const conveyor = new Conveyor(scene, cv.col, cv.row, cv.direction, scene.grid, cv.conveyorType ?? 'regular');
        conveyor._outDir = cv.outDir ?? cv.direction;
        scene.grid.place(cv.col, cv.row, conveyor);
        scene.conveyors.push(conveyor);
        placedConveyors.push({ conveyor, data: cv });
      }
      // Second pass: restore belt sprite frame and held items
      for (const { conveyor, data: cv } of placedConveyors) {
        const { beltFrame } = _beltFrameHelper(conveyor.direction, conveyor._outDir);
        conveyor._belt.setFrame(beltFrame);

        if (cv.held) {
          conveyor._held = cv.held;
          const frame = RESOURCE_FRAME[cv.held.resource] ?? 0;
          conveyor._itemSprite.setFrame(frame).setPosition(0, 0).setVisible(true);
        }
      }
    }

    // ── Ground items ─────────────────────────────────────────────────────────
    if (data.groundItems) {
      for (const gi of data.groundItems) {
        new GroundItem(scene, gi.x, gi.y, gi.resource, gi.amount);
      }
    }

    // ── Flywheels ─────────────────────────────────────────────────────────────
    if (data.flywheels) {
      for (const fd of data.flywheels) {
        const fw = new Flywheel(scene, fd.col, fd.row, fd.flywheelType ?? 'regular');
        fw._momentum = fd.momentum ?? 0;
        fw.setGrid(scene.grid);
        fw._updateBar();
        // Restore powered state on linked machine
        fw._updatePowered?.();
        scene.grid.place(fd.col, fd.row, fw);
        scene.flywheels.push(fw);
      }
    }

    if (data.woodRobotPods) {
      for (const pd of data.woodRobotPods) {
        const pod = new WoodRobotChasisPod(scene, pd.col, pd.row);
        pod.charge = pd.charge ?? 0;
        pod.hatch = pd.hatch ?? 0;
        scene.grid.place(pd.col, pd.row, pod);
        scene.woodRobotPods.push(pod);
      }
    }

    // ── Anvils ───────────────────────────────────────────────────────────────
    if (data.anvils) {
      for (const ad of data.anvils) {
        const av = new Anvil(scene, ad.col, ad.row);
        av.setPanel(scene.smithingPanel);
        if (ad.activeRecipeId) {
          const recipe = ANVIL_RECIPES.find(r => r.id === ad.activeRecipeId);
          if (recipe) av.setActiveRecipe(recipe);
        }
        scene.grid.place(ad.col, ad.row, av);
        scene.anvils.push(av);
      }
    }

    // ── Crafting Benches ──────────────────────────────────────────────────────
    if (data.craftingBenches) {
      for (const bd of data.craftingBenches) {
        const b = new CraftingBench(scene, bd.col, bd.row);
        b.setPanel(scene.craftingBenchPanel);
        if (bd.activeRecipeId) {
          const recipe = BENCH_RECIPES.find(r => r.id === bd.activeRecipeId);
          if (recipe) b.setActiveRecipe(recipe);
        }
        scene.grid.place(bd.col, bd.row, b);
        scene.craftingBenches.push(b);
      }
    }

    if (data.woodCraftingTables) {
      for (const td of data.woodCraftingTables) {
        const t = new WoodCraftingTable(scene, td.col, td.row);
        t.setPanel(scene.woodCraftingTablePanel);
        t.deserialise(td);
        scene.grid.place(td.col, td.row, t);
        scene.woodCraftingTables.push(t);
      }
    }

    // ── Placed Structures ─────────────────────────────────────────────────────
    if (data.structures) {
      for (const sd of data.structures) {
        const s = new PlacedStructure(scene, sd.col, sd.row, sd.type);
        s.hp = sd.hp ?? s.maxHp;
        if (s.hp < s.maxHp) s._updateHPBar(); // show damage bar if already hurt
        scene.grid.place(sd.col, sd.row, s);
        if (scene.structureGroup) {
          scene.structureGroup.add(s);
          scene.structureGroup.refresh();
        }
        scene.structures.push(s);
      }
    }

    // ── Doors ─────────────────────────────────────────────────────────────────
    if (data.doors) {
      for (const dd of data.doors) {
        const d = new Door(scene, dd.col, dd.row);
        d.hp = dd.hp ?? d.maxHp;
        if (d.hp < d.maxHp) d._updateHPBar(); // show damage bar if already hurt
        if (dd.open) {
          d.open(); // removes from grid + structureGroup
        } else {
          scene.grid.place(dd.col, dd.row, d);
          if (scene.structureGroup) {
            scene.structureGroup.add(d);
            scene.structureGroup.refresh();
          }
        }
        scene.doors.push(d);
      }
    }

    // ── Mine Rocks (depleted state only — rocks are always world-static) ─────
    if (data.mineRocksDepleted) {
      for (const rd of data.mineRocksDepleted) {
        const rock = (scene.mineRocks ?? []).find(
          r => Math.abs(r.x - rd.x) < 1 && Math.abs(r.y - rd.y) < 1
        );
        if (rock && !rock.isDepleted()) {
          rock._deplete(); // immediately deplete; regrow timer fires as usual
        }
      }
    }

    // ── NPCs ─────────────────────────────────────────────────────────────────
    if (data.npcs) {
      for (const nd of data.npcs) {
        // npc_0 is already spawned in create() — just reposition and restore inv
        const existing = scene.npcs.find(n => n.id === nd.id);
        const npc = existing ?? scene._spawnNPC(nd.x, nd.y, nd.id);

        npc.x = nd.x;
        npc.y = nd.y;
        if (nd.name)     npc.setName(nd.name);
        const restoredProfile = nd.profile ?? (nd.id?.startsWith?.('wood_robot_') ? 'wood_robot' : 'standard');
        npc.setProfile?.(restoredProfile);
        if (nd.inventory) {
          for (const [res, amt] of Object.entries(nd.inventory)) {
            npc._inventory[res] = amt;
          }
        }
        if (nd.skills)   npc.skills.deserialise(nd.skills);
        if (nd.upgrades) Object.assign(npc.upgrades, nd.upgrades);

        // Restore assigned targets — match entities by position
        if (nd.assignedTargets) {
          _restoreAssignedTargets(npc, nd.assignedTargets, scene);
        }

        // Restore task queue (after targets so runner can reference them)
        if (nd.tasks) {
          npc.taskRunner?.restoreTasks(nd.tasks);
        }

        // Restore soul — fall back to freshly-generated soul if missing (old saves)
        if (nd.soul) {
          npc.soul = nd.soul;
        }
        npc.normalizeSoulState?.();
      }
    }

    return true;
  }

  // ── Clear save ────────────────────────────────────────────────────────────

  clearSave() {
    localStorage.removeItem(SAVE_KEY);
  }
}

function _beltFrameHelper(inDir, outDir) {
  return { beltFrame: CONV_FRAME_LOOKUP[`${inDir},${outDir}`] ?? FRAME_CONV_H };
}

// Serialise npc.assignedTargets — object refs → positional keys
function _serialiseAssignedTargets(targets) {
  if (!targets) return null;
  const out = {};
  // Single col/row entities
  for (const key of ['furnace', 'quarry', 'crusher', 'anvil']) {
    const obj = targets[key];
    if (obj) out[key] = { col: obj.col, row: obj.row };
  }
  // Flywheel array (col/row)
  if (targets.flywheels?.length) {
    out.flywheels = targets.flywheels.map(fw => ({ col: fw.col, row: fw.row }));
  }
  // Crates array (col/row, order-preserving)
  if (targets.crates?.length) {
    out.crates = targets.crates.map(cr => ({ col: cr.col, row: cr.row }));
  }
  // crateOreMap — plain object, safe to JSON directly
  if (targets.crateOreMap && Object.keys(targets.crateOreMap).length > 0) {
    out.crateOreMap = { ...targets.crateOreMap };
  }
  // Mine rock array (x/y — rocks don't have col/row)
  if (targets.mine_rocks?.length) {
    out.mine_rocks = targets.mine_rocks.map(r => ({ x: r.x, y: r.y, rockType: r.rockType }));
  }
  // Tree array (x/y)
  if (targets.trees?.length) {
    out.trees = targets.trees.map(t => ({ x: t.x, y: t.y }));
  }
  return out;
}

// Restore npc.assignedTargets from saved positional data
function _restoreAssignedTargets(npc, saved, scene) {
  const at = npc.assignedTargets;

  // Single col/row lookup helpers
  const byColRow = (list, col, row) =>
    list.find(e => e.col === col && e.row === row) ?? null;

  if (saved.furnace)  at.furnace  = byColRow(scene.furnaces  ?? [], saved.furnace.col,  saved.furnace.row);
  if (saved.quarry)   at.quarry   = byColRow(scene.quarries   ?? [], saved.quarry.col,   saved.quarry.row);
  if (saved.crusher)  at.crusher  = byColRow(scene.crushers   ?? [], saved.crusher.col,  saved.crusher.row);
  if (saved.anvil)    at.anvil    = byColRow(scene.anvils     ?? [], saved.anvil.col,    saved.anvil.row);

  // Crates — restore as ordered array
  if (saved.crates?.length) {
    at.crates = saved.crates
      .map(cr => byColRow(scene.crates ?? [], cr.col, cr.row))
      .filter(Boolean);
  }
  // crateOreMap — plain object, restore directly
  if (saved.crateOreMap) {
    at.crateOreMap = { ...saved.crateOreMap };
  }

  if (saved.flywheels?.length) {
    at.flywheels = saved.flywheels
      .map(fw => byColRow(scene.flywheels ?? [], fw.col, fw.row))
      .filter(Boolean);
  }

  if (saved.mine_rocks?.length) {
    at.mine_rocks = saved.mine_rocks
      .map(sr => (scene.mineRocks ?? []).find(
        r => Math.abs(r.x - sr.x) < 1 && Math.abs(r.y - sr.y) < 1
      ))
      .filter(Boolean);
  }
  if (saved.trees?.length) {
    at.trees = saved.trees
      .map(st => (scene.trees ?? []).find(
        t => Math.abs(t.x - st.x) < 1 && Math.abs(t.y - st.y) < 1
      ))
      .filter(Boolean);
  }
}

