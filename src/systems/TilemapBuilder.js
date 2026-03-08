import {
  TILE_SIZE, MAP_COLS, MAP_ROWS,
  TILE_GRASS, TILE_DIRT, TILE_STONE,
  FRAME_GRASS, FRAME_DIRT, FRAME_STONE,
  SHEET_KEY, SHEET_TILE,
  WEST_ZONE_COLS, WEST_ZONE_OFFSET_X,
} from '../constants.js';

// 0 = grass, 1 = dirt, 2 = stone
// Map is procedurally generated at 80×50 with a stone border and scattered dirt patches.
// The original 30×20 hand-crafted layout is preserved in the top-left corner.
const ORIGINAL_PATCH = [
  [2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2],
  [2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2],
  [2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2],
  [2,0,0,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2],
  [2,0,0,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2],
  [2,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2],
  [2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2],
  [2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2],
  [0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,2],
  [0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,2],
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2],
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2],
  [2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2],
  [2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0,0,0,2],
  [2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,0,0,0,0,0,0,0,0,2],
  [2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2],
  [2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2],
  [2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2],
  [2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2],
  [2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2],
];

function buildMapData(cols, rows) {
  // Deterministic PRNG so dirt patches are stable across reloads
  let seed = 42;
  const rand = () => { seed = (seed * 1664525 + 1013904223) & 0xffffffff; return (seed >>> 0) / 0xffffffff; };

  const map = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      // Preserve the original hand-crafted patch in top-left corner
      if (r < ORIGINAL_PATCH.length && c < ORIGINAL_PATCH[0].length) {
        row.push(ORIGINAL_PATCH[r][c]);
        continue;
      }
      // Stone border around entire map
      if (r === 0 || r === rows - 1 || c === 0 || c === cols - 1) {
        row.push(2);
        continue;
      }
      // Scattered dirt patches (~8% chance)
      row.push(rand() < 0.08 ? 1 : 0);
    }
    map.push(row);
  }
  return map;
}

const MAP_DATA = buildMapData(MAP_COLS, MAP_ROWS);

const FRAME_MAP = {
  [TILE_GRASS]: FRAME_GRASS,
  [TILE_DIRT]:  FRAME_DIRT,
  [TILE_STONE]: FRAME_STONE,
};

// Sheet tiles are 16px; game tiles are TILE_SIZE px
const SCALE = TILE_SIZE / SHEET_TILE;

export function buildTilemap(scene) {
  for (let row = 0; row < MAP_ROWS; row++) {
    for (let col = 0; col < MAP_COLS; col++) {
      const tileId = MAP_DATA[row]?.[col] ?? TILE_GRASS;
      const frame  = FRAME_MAP[tileId] ?? FRAME_GRASS;

      // Images are positioned by center
      const x = col * TILE_SIZE + TILE_SIZE / 2;
      const y = row * TILE_SIZE + TILE_SIZE / 2;

      scene.add.image(x, y, SHEET_KEY, frame)
        .setScale(SCALE)
        .setDepth(0);
    }
  }
}

// ── West Zone — Mining Area ───────────────────────────────────────────────────
// Positioned at x = WEST_ZONE_OFFSET_X (−960) to x = 0, same Y rows as main map.
// The east wall col (col 19 in zone space = world col -1) is open at rows 8–11
// to form the passage connecting to the main map's west wall gap.
//
// Zone col 0 = world x WEST_ZONE_OFFSET_X + TILE_SIZE/2
// Zone col c = world x WEST_ZONE_OFFSET_X + c*TILE_SIZE + TILE_SIZE/2

// 0=grass, 1=dirt, 2=stone
// 20 cols × 20 rows. East edge (col 19) left open at passage rows.
const WEST_MAP_DATA = [
  [2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2],
  [2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2],
  [2,0,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2],
  [2,0,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2],
  [2,0,0,0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0,2],
  [2,0,0,0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0,2],
  [2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2],
  [2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2],
  [2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0], // row 8: east open (passage)
  [2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0], // row 9: east open (passage)
  [2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0], // row 10: east open (passage)
  [2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0], // row 11: east open (passage)
  [2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2],
  [2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,0,0,2],
  [2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,2],
  [2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2],
  [2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2],
  [2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2],
  [2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2],
  [2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2],
];

export function buildWestZone(scene) {
  const rows = WEST_MAP_DATA.length;
  const cols = WEST_ZONE_COLS;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const tileId = WEST_MAP_DATA[row]?.[col] ?? TILE_GRASS;
      const frame  = FRAME_MAP[tileId] ?? FRAME_GRASS;

      // World position: zone col 0 starts at WEST_ZONE_OFFSET_X
      const x = WEST_ZONE_OFFSET_X + col * TILE_SIZE + TILE_SIZE / 2;
      const y = row * TILE_SIZE + TILE_SIZE / 2;

      scene.add.image(x, y, SHEET_KEY, frame)
        .setScale(SCALE)
        .setDepth(0);
    }
  }
}
