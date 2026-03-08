// GridSystem — tracks which entity occupies each tile.
// Any placeable world object registers itself here.
// Conveyors query this to know what's at a given tile.

export class GridSystem {
  constructor() {
    // Map of "col,row" -> entity reference
    this._grid = new Map();
  }

  _key(col, row) { return `${col},${row}`; }

  // Register an entity at a tile. Returns false if already occupied.
  place(col, row, entity) {
    const key = this._key(col, row);
    if (this._grid.has(key)) return false;
    this._grid.set(key, entity);
    return true;
  }

  // Remove whatever is at this tile
  remove(col, row) {
    this._grid.delete(this._key(col, row));
  }

  // Get entity at tile, or null
  get(col, row) {
    return this._grid.get(this._key(col, row)) ?? null;
  }

  // Is tile free?
  isFree(col, row) {
    return !this._grid.has(this._key(col, row));
  }
}
