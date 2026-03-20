import { Conveyor } from '../entities/Conveyor.js';
import { MinecartTrack } from '../entities/MinecartTrack.js';
import {
  TILE_SIZE,
  DIR_RIGHT, DIR_LEFT, DIR_UP, DIR_DOWN,
  tilePos, worldToTile,
} from '../constants.js';

const PHASE_IDLE  = 'idle';
const PHASE_START = 'start';
const PHASE_END   = 'end';

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
    this._buildType = null;

    this._startCol       = null;
    this._startRow       = null;
    this._sourceConveyor = null;

    this._ghost = scene.add.graphics().setDepth(15).setVisible(false);

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

    scene.input.keyboard.on('keydown-ESC', () => {
      if (this._phase !== PHASE_IDLE) this.cancel();
    });
  }

  startPlacing(type = 'conveyor') {
    this._buildType     = type;
    this._startCol      = null;
    this._startRow      = null;
    this._skipNextClick = true;
    this._ghost.setVisible(true);
    this._phase = PHASE_START;
    const labels = {
      crate: 'crate', furnace: 'furnace', log_cutter: 'log cutter',
      etrainer: 'etrainer', gate: 'gate', fence: 'fence',
    };
    const singlePlace = labels[type];
    const msg = singlePlace
      ? `Click a tile to place ${singlePlace}   |   Right-click / Esc to cancel`
      : `Click a tile to start ${type === 'track' ? 'track' : 'conveyor'} run   |   Right-click / Esc to cancel`;
    this._setStatus(msg);
  }

  cancel() {
    this._phase          = PHASE_IDLE;
    this._buildType      = null;
    this._startCol       = null;
    this._startRow       = null;
    this._sourceConveyor = null;
    this._ghost.clear().setVisible(false);
    this._statusText.setVisible(false);
  }

  isActive()  { return this._phase !== PHASE_IDLE; }
  isPlacing() { return this._phase !== PHASE_IDLE; }

  _setStatus(msg) {
    this._statusText.setText(msg).setVisible(true);
  }

  _sendPlaceBuilding(kind, col, row, direction = '') {
    this._scene._conn?.send({
      type: 'place_building', kind, col, row, direction,
    });
  }

  _updateGhost(wx, wy) {
    const { col, row } = worldToTile(wx, wy);
    this._ghost.clear();

    if (this._phase === PHASE_START) {
      const existing = this._grid.get(col, row);
      const canExtend = this._buildType === 'track'
        ? existing instanceof MinecartTrack
        : existing instanceof Conveyor;
      this._drawTileGhost(col, row, this._grid.isFree(col, row) || canExtend);
      return;
    }

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

    // Single-click placement for crate / furnace / log_cutter — send to server
    if ((this._buildType === 'crate' || this._buildType === 'furnace' || this._buildType === 'log_cutter' || this._buildType === 'etrainer' || this._buildType === 'gate' || this._buildType === 'fence') && this._phase === PHASE_START) {
      if (!this._grid.isFree(col, row)) return;
      this._sendPlaceBuilding(this._buildType, col, row);
      return;
    }

    if (this._phase === PHASE_START) {
      const existing = this._grid.get(col, row);
      const isTrack = this._buildType === 'track';
      const canExtend = isTrack
        ? existing instanceof MinecartTrack
        : existing instanceof Conveyor;
      if (canExtend) {
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
        tiles = tiles.slice(1);
        if (tiles.length === 0) return;
      }

      if (!tiles.every(t => this._grid.isFree(t.col, t.row))) return;

      // Send each tile to server
      const kind = this._buildType; // 'conveyor' or 'track'
      for (const t of tiles) {
        this._sendPlaceBuilding(kind, t.col, t.row, dir);
      }

      // Also tell server to update source entity's outDirection if extending
      if (this._sourceConveyor) {
        if (typeof this._sourceConveyor._refreshOwnSprite === 'function') {
          this._sourceConveyor._refreshOwnSprite(dir);
        } else if (typeof this._sourceConveyor.refreshSprite === 'function') {
          this._sourceConveyor.refreshSprite();
        }
        const bid = this._sourceConveyor._serverId;
        if (bid) {
          this._scene._conn?.send({
            type: 'update_building_out_dir',
            building_id: bid,
            out_direction: dir,
          });
        }
      }

      this._phase          = PHASE_START;
      this._startCol       = null;
      this._startRow       = null;
      this._sourceConveyor = null;
      this._ghost.clear();
      this._setStatus('Click a tile to start conveyor run   |   Right-click / Esc to cancel');
    }
  }
}
