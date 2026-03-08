import { Conveyor   } from '../entities/Conveyor.js';
import { Furnace    } from '../entities/Furnace.js';
import { Quarry     } from '../entities/Quarry.js';
import { OreCrusher } from '../entities/OreCrusher.js';
import { Crate      } from '../entities/Crate.js';
import { Flywheel   } from '../entities/Flywheel.js';
import { Anvil           } from '../entities/Anvil.js';
import { CraftingBench  } from '../entities/CraftingBench.js';
import { PlacedStructure } from '../entities/PlacedStructure.js';
import { Door           } from '../entities/Door.js';
import { WoodRobotChasisPod } from '../entities/WoodRobotChasisPod.js';
import { WoodCraftingTable } from '../entities/WoodCraftingTable.js';
import {
  TILE_SIZE,
  DIR_RIGHT, DIR_LEFT, DIR_UP, DIR_DOWN,
  tilePos, worldToTile,
} from '../constants.js';

const PHASE_IDLE     = 'idle';
const PHASE_START    = 'start';    // waiting for first click (or click existing conveyor end)
const PHASE_END      = 'end';      // have a start tile, waiting for end click
const PHASE_BUILDING = 'building'; // single-click placement (furnace, etc.)

// Given a start and an arbitrary end tile, clamp end to the same row or col
// (whichever axis has the larger delta), and return the direction + clamped end.
function lineSnap(startCol, startRow, rawCol, rawRow) {
  const dc = rawCol - startCol;
  const dr = rawRow - startRow;
  let dir, endCol, endRow;
  if (Math.abs(dc) >= Math.abs(dr)) {
    dir    = dc >= 0 ? DIR_RIGHT : DIR_LEFT;
    endCol = rawCol;
    endRow = startRow;
  } else {
    dir    = dr >= 0 ? DIR_DOWN : DIR_UP;
    endCol = startCol;
    endRow = rawRow;
  }
  return { dir, endCol, endRow };
}

// Return every tile in a straight run from start to end (inclusive, same row/col guaranteed)
function tilesInRun(startCol, startRow, endCol, endRow, dir) {
  const tiles = [];
  if (dir === DIR_RIGHT) {
    for (let c = startCol; c <= endCol; c++) tiles.push({ col: c, row: startRow });
  } else if (dir === DIR_LEFT) {
    for (let c = startCol; c >= endCol; c--) tiles.push({ col: c, row: startRow });
  } else if (dir === DIR_DOWN) {
    for (let r = startRow; r <= endRow; r++) tiles.push({ col: startCol, row: r });
  } else {
    for (let r = startRow; r >= endRow; r--) tiles.push({ col: startCol, row: r });
  }
  return tiles;
}

export class PlacementSystem {
  constructor(scene, grid, conveyors) {
    this._scene     = scene;
    this._grid      = grid;
    this._conveyors = conveyors;
    this._phase     = PHASE_IDLE;
    this._buildType = null; // 'conveyor' | 'furnace' | ...

    this._startCol       = null;
    this._startRow       = null;
    this._sourceConveyor = null; // conveyor we're extending from, if any
    this._consumeItemKey = null; // inventory item to consume on successful placement

    // Ghost graphics drawn in world space
    this._ghost = scene.add.graphics().setDepth(15).setVisible(false);

    // Status label — screen space
    this._statusText = scene.add.text(
      scene.cameras.main.width / 2, 8, '', {
        fontSize: '12px', color: '#ffff88', backgroundColor: '#00000099',
        padding: { x: 8, y: 3 }, align: 'center',
      }
    ).setOrigin(0.5, 0).setScrollFactor(0).setDepth(30).setVisible(false);

    scene.input.on('pointermove', (pointer) => {
      if (this._phase === PHASE_IDLE) return;
      this._updateGhost(pointer.worldX, pointer.worldY);
    });

    scene.input.on('pointerdown', (pointer) => {
      if (this._phase === PHASE_IDLE) return;
      if (pointer.rightButtonDown()) { this.cancel(); return; }
      if (this._skipNextClick) { this._skipNextClick = false; return; }
      this._handleClick(pointer.worldX, pointer.worldY);
    });

    scene.input.keyboard.on('keydown-ESC', () => this.cancel());
  }

  // ── public ─────────────────────────────────────────────────────────────────

  startPlacing(type = 'conveyor') {
    this._buildType     = type;
    this._startCol      = null;
    this._startRow      = null;
    this._skipNextClick = true;  // ignore the click that opened placement
    this._consumeItemKey = null;
    this._ghost.setVisible(true);

    const BUILDINGS = {
      plain_furnace: 'Furnace', furnace: 'Iron Furnace', quarry: 'Quarry', crusher: 'Ore Crusher',
      crate: 'Storage', flywheel: 'Flywheel', wooden_flywheel: 'Wooden Flywheel', anvil: 'Anvil',
      wood_robot_chasis_pod: 'Wood Robot Chasis Pod',
      wood_storage: 'Wood Storage', wood_crafting_table: 'Wood Crafting Table',
      crafting_bench: 'Crafting Bench', reinforced_block: 'Reinforced Block',
      wood_frame: 'Wood Frame', wood_wall: 'Wood Wall', door: 'Door',
      steel_furnace: 'Steel Furnace', bronze_furnace: 'Bronze Furnace',
    };
    if (type in BUILDINGS) {
      this._phase = PHASE_BUILDING;
      this._setStatus(`Click a free tile to place ${BUILDINGS[type]}   |   Right-click / Esc to cancel`);
    } else {
      this._phase = PHASE_START;
      this._setStatus('Click a tile to start   |   Right-click / Esc to cancel');
    }
  }

  cancel() {
    this._phase          = PHASE_IDLE;
    this._buildType      = null;
    this._startCol       = null;
    this._startRow       = null;
    this._sourceConveyor = null;
    this._consumeItemKey = null;
    this._ghost.clear().setVisible(false);
    this._statusText.setVisible(false);
  }

  isActive()   { return this._phase !== PHASE_IDLE; }
  isPlacing()  { return this._phase !== PHASE_IDLE; }
  startPlacingFromInventory(type, itemKey) {
    this.startPlacing(type);
    this._consumeItemKey = itemKey ?? null;
  }

  // ── private ────────────────────────────────────────────────────────────────

  _setStatus(msg) {
    this._statusText.setText(msg).setVisible(true);
  }

  _updateGhost(wx, wy) {
    const { col, row } = worldToTile(wx, wy);
    this._ghost.clear();

    if (this._phase === PHASE_START || this._phase === PHASE_BUILDING) {
      // Single tile preview
      this._drawTileGhost(col, row, this._grid.isFree(col, row));
      return;
    }

    // PHASE_END — draw the full run from start to cursor
    const { dir, endCol, endRow } = lineSnap(this._startCol, this._startRow, col, row);
    let tiles = tilesInRun(this._startCol, this._startRow, endCol, endRow, dir);
    const ghostTiles = this._sourceConveyor ? tiles.slice(1) : tiles;

    const allFree = ghostTiles.every(t => this._grid.isFree(t.col, t.row));
    for (const t of ghostTiles) {
      this._drawTileGhost(t.col, t.row, allFree && this._grid.isFree(t.col, t.row));
    }

    if (ghostTiles.length > 0) {
      const last = ghostTiles[ghostTiles.length - 1];
      const { x, y } = tilePos(last.col, last.row);
      this._drawArrowHint(x, y, dir, allFree);
    }

    // Highlight the source conveyor tile as the junction anchor
    if (this._sourceConveyor) {
      const { x, y } = tilePos(this._sourceConveyor.col, this._sourceConveyor.row);
      this._ghost.lineStyle(2, 0xffdd44, 1);
      this._ghost.strokeRect(x - TILE_SIZE / 2, y - TILE_SIZE / 2, TILE_SIZE, TILE_SIZE);
    }
  }

  _drawTileGhost(col, row, free) {
    const { x, y } = tilePos(col, row);
    this._ghost.fillStyle(free ? 0x44aaff : 0xff4444, 0.35);
    this._ghost.fillRect(x - TILE_SIZE / 2, y - TILE_SIZE / 2, TILE_SIZE, TILE_SIZE);
    this._ghost.lineStyle(2, free ? 0x88ddff : 0xff8888, 0.9);
    this._ghost.strokeRect(x - TILE_SIZE / 2, y - TILE_SIZE / 2, TILE_SIZE, TILE_SIZE);
  }

  _drawArrowHint(cx, cy, dir, free) {
    const color = free ? 0xffffff : 0xff8888;
    this._ghost.fillStyle(color, 0.8);
    const s = 6;
    // Small triangle pointing in dir
    const pts = {
      [DIR_RIGHT]: [[cx+s, cy], [cx-s/2, cy-s/2], [cx-s/2, cy+s/2]],
      [DIR_LEFT]:  [[cx-s, cy], [cx+s/2, cy-s/2], [cx+s/2, cy+s/2]],
      [DIR_DOWN]:  [[cx, cy+s], [cx-s/2, cy-s/2], [cx+s/2, cy-s/2]],
      [DIR_UP]:    [[cx, cy-s], [cx-s/2, cy+s/2], [cx+s/2, cy+s/2]],
    }[dir];
    this._ghost.fillTriangle(...pts[0], ...pts[1], ...pts[2]);
  }

  _handleClick(wx, wy) {
    const { col, row } = worldToTile(wx, wy);

    if (this._phase === PHASE_BUILDING) {
      if (!this._grid.isFree(col, row)) return;
      this._spawnBuilding(col, row);
      // Stay in PHASE_BUILDING so the player can place another immediately
      this._ghost.clear();
      return;
    }

    if (this._phase === PHASE_START) {
      const existing = this._grid.get(col, row);
      if (existing instanceof Conveyor) {
        // Anchor at the source tile; slice(1) in PHASE_END skips it when spawning.
        this._startCol       = existing.col;
        this._startRow       = existing.row;
        this._sourceConveyor = existing;
        this._phase          = PHASE_END;
        this._setStatus('Click end tile to extend   |   Right-click / Esc to cancel');
        return;
      }

      if (!this._grid.isFree(col, row)) return;

      this._startCol       = col;
      this._startRow       = row;
      this._sourceConveyor = null;
      this._phase          = PHASE_END;
      this._setStatus('Click end tile to place run   |   Right-click / Esc to cancel');
      return;
    }

    if (this._phase === PHASE_END) {
      const { dir, endCol, endRow } = lineSnap(this._startCol, this._startRow, col, row);
      let tiles = tilesInRun(this._startCol, this._startRow, endCol, endRow, dir);

      if (this._sourceConveyor) {
        tiles = tiles.slice(1); // source tile already exists, skip it
        if (tiles.length === 0) return;
      }

      if (!tiles.every(t => this._grid.isFree(t.col, t.row))) return;

      let placedAny = false;
      for (const t of tiles) {
        const ok = this._spawnConveyor(t.col, t.row, dir);
        if (!ok) break;
        placedAny = true;
      }

      // Refresh source conveyor — if the new run direction differs from its _outDir it becomes a curve
      if (this._sourceConveyor && placedAny) {
        this._sourceConveyor._refreshOwnSprite(dir);
      }

      this._phase          = PHASE_START;
      this._startCol       = null;
      this._startRow       = null;
      this._sourceConveyor = null;
      this._ghost.clear();
      this._setStatus('Click a tile to start   |   Right-click / Esc to cancel');
    }
  }

  _dirDelta(dir) {
    return { [DIR_RIGHT]:{dc:1,dr:0}, [DIR_LEFT]:{dc:-1,dr:0},
             [DIR_UP]:{dc:0,dr:-1},   [DIR_DOWN]:{dc:0,dr:1} }[dir];
  }

  _spawnBuilding(col, row) {
    const scene = this._scene;
    let placed = false;

    if (this._buildType === 'plain_furnace') {
      const e = new Furnace(scene, col, row, 'plain');
      e.setPanel(scene.furnacePanel);
      e.setGrid(this._grid);
      this._grid.place(col, row, e);
      scene.furnaces?.push(e);
      placed = true;

    } else if (this._buildType === 'furnace') {
      const e = new Furnace(scene, col, row, 'iron');
      e.setPanel(scene.furnacePanel);
      e.setGrid(this._grid);
      this._grid.place(col, row, e);
      scene.furnaces?.push(e);
      placed = true;

    } else if (this._buildType === 'steel_furnace') {
      const e = new Furnace(scene, col, row, 'steel');
      e.setPanel(scene.furnacePanel);
      e.setGrid(this._grid);
      this._grid.place(col, row, e);
      scene.furnaces?.push(e);
      placed = true;

    } else if (this._buildType === 'bronze_furnace') {
      const e = new Furnace(scene, col, row, 'bronze');
      e.setPanel(scene.furnacePanel);
      e.setGrid(this._grid);
      this._grid.place(col, row, e);
      scene.furnaces?.push(e);
      placed = true;

    } else if (this._buildType === 'quarry') {
      const e = new Quarry(scene, col, row);
      e.setGrid(this._grid);
      this._grid.place(col, row, e);
      scene.quarries?.push(e);
      placed = true;

    } else if (this._buildType === 'crusher') {
      const e = new OreCrusher(scene, col, row);
      e.setGrid(this._grid);
      this._grid.place(col, row, e);
      scene.crushers?.push(e);
      placed = true;

    } else if (this._buildType === 'crate') {
      const { x, y } = tilePos(col, row);
      const e = new Crate(scene, x, y);
      e.setPanel(scene.storagePanel);
      this._grid.place(col, row, e);
      scene.crates?.push(e);
      placed = true;

    } else if (this._buildType === 'wood_storage') {
      const key = this._consumeItemKey ?? 'WoodStorage';
      if ((scene.inventory?.get(key) ?? 0) < 1) return false;
      if (!this._consumeItemKey) scene.inventory.remove(key, 1);
      const { x, y } = tilePos(col, row);
      const e = new Crate(scene, x, y, { variant: 'wood_storage' });
      e.setPanel(scene.storagePanel);
      this._grid.place(col, row, e);
      scene.crates?.push(e);
      placed = true;

    } else if (this._buildType === 'flywheel') {
      const e = new Flywheel(scene, col, row, 'regular');
      e.setGrid(this._grid);
      this._grid.place(col, row, e);
      scene.flywheels?.push(e);
      placed = true;

    } else if (this._buildType === 'wooden_flywheel') {
      const e = new Flywheel(scene, col, row, 'wooden');
      e.setGrid(this._grid);
      this._grid.place(col, row, e);
      scene.flywheels?.push(e);
      placed = true;

    } else if (this._buildType === 'anvil') {
      if (this._consumeItemKey && (scene.inventory?.get(this._consumeItemKey) ?? 0) < 1) return false;
      const e = new Anvil(scene, col, row);
      e.setPanel(scene.smithingPanel);
      this._grid.place(col, row, e);
      scene.anvils?.push(e);
      placed = true;

    } else if (this._buildType === 'crafting_bench') {
      const e = new CraftingBench(scene, col, row);
      e.setPanel(scene.craftingBenchPanel);
      this._grid.place(col, row, e);
      scene.craftingBenches?.push(e);
      placed = true;

    } else if (this._buildType === 'wood_crafting_table') {
      const key = this._consumeItemKey ?? 'WoodCraftingTable';
      if ((scene.inventory?.get(key) ?? 0) < 1) return false;
      if (!this._consumeItemKey) scene.inventory.remove(key, 1);
      const e = new WoodCraftingTable(scene, col, row);
      e.setPanel(scene.woodCraftingTablePanel);
      this._grid.place(col, row, e);
      scene.woodCraftingTables?.push(e);
      placed = true;

    } else if (this._buildType === 'wood_robot_chasis_pod') {
      if (this._consumeItemKey && (scene.inventory?.get(this._consumeItemKey) ?? 0) < 1) return false;
      const e = new WoodRobotChasisPod(scene, col, row);
      this._grid.place(col, row, e);
      scene.woodRobotPods?.push(e);
      placed = true;

    } else if (this._buildType === 'reinforced_block') {
      const key = this._consumeItemKey ?? 'ReinforcedBlock';
      if ((scene.inventory?.get(key) ?? 0) < 1) return false;
      if (!this._consumeItemKey) scene.inventory.remove('ReinforcedBlock', 1);
      const e = new PlacedStructure(scene, col, row, 'reinforced_block');
      this._grid.place(col, row, e);
      scene.structureGroup?.add(e);
      scene.structures?.push(e);
      placed = true;

    } else if (this._buildType === 'wood_frame') {
      const key = this._consumeItemKey ?? 'WoodenFrame';
      if ((scene.inventory?.get(key) ?? 0) < 1) return false;
      if (!this._consumeItemKey) scene.inventory.remove('WoodenFrame', 1);
      const e = new PlacedStructure(scene, col, row, 'wood_frame');
      this._grid.place(col, row, e);
      scene.structureGroup?.add(e);
      scene.structures?.push(e);
      placed = true;

    } else if (this._buildType === 'wood_wall') {
      const key = this._consumeItemKey ?? 'WoodWall';
      if ((scene.inventory?.get(key) ?? 0) < 1) return false;
      if (!this._consumeItemKey) scene.inventory.remove(key, 1);
      const e = new PlacedStructure(scene, col, row, 'wood_wall');
      this._grid.place(col, row, e);
      scene.structureGroup?.add(e);
      scene.structures?.push(e);
      placed = true;

    } else if (this._buildType === 'door') {
      const key = this._consumeItemKey ?? 'Door';
      if ((scene.inventory?.get(key) ?? 0) < 1) return false;
      if (!this._consumeItemKey) scene.inventory.remove('Door', 1);
      const e = new Door(scene, col, row);
      this._grid.place(col, row, e);
      scene.structureGroup?.add(e);
      scene.doors?.push(e);
      placed = true;
    }

    if (placed && this._consumeItemKey) {
      scene.inventory?.remove(this._consumeItemKey, 1);
    }
    return placed;
  }

  _spawnConveyor(col, row, direction) {
    const conveyorType = this._buildType === 'wood_pulp_conveyor' ? 'wood_pulp' : 'regular';
    if (this._consumeItemKey) {
      const inv = this._scene.inventory;
      if ((inv?.get(this._consumeItemKey) ?? 0) < 1) return false;
      inv?.remove(this._consumeItemKey, 1);
    }
    const conveyor = new Conveyor(this._scene, col, row, direction, this._grid, conveyorType);
    this._grid.place(col, row, conveyor);
    this._conveyors.push(conveyor);
    // Straight tile — don't look at neighbors, just set the correct straight frame.
    // The source conveyor (corner) is refreshed separately after the run is placed.
    conveyor.setStraight();
    return true;
  }
}
