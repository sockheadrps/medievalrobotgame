import {
  TILE_SIZE,
  FRAME_GRASS, FRAME_TREE, FRAME_BARE,
  SHEET_KEY, SHEET_TILE, SHEET_COLS,
} from '../constants.js';

// Sheet tiles are 16px; game tiles are TILE_SIZE px
const SCALE = TILE_SIZE / SHEET_TILE;

// Frame index from spritesheet grid coords
function frameFromGrid(tileX, tileY) {
  return tileX + tileY * SHEET_COLS;
}

/**
 * Build tilemap from server-loaded map data.
 * Returns { treePositions, rockSpawnTiles, width, height }.
 */
export function buildTilemapFromData(scene, mapData) {
  const width  = mapData.width  || 30;
  const height = mapData.height || 30;
  const tiles  = mapData.tiles  || [];
  const treePositions = [];
  const rockSpawnTiles = [];

  // Build a lookup: "col,row" -> {tileX, tileY}
  const lookup = {};
  for (const t of tiles) {
    lookup[`${t.x},${t.y}`] = t;
  }

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const x = col * TILE_SIZE + TILE_SIZE / 2;
      const y = row * TILE_SIZE + TILE_SIZE / 2;

      const t = lookup[`${col},${row}`];
      if (!t) {
        scene.add.image(x, y, SHEET_KEY, FRAME_GRASS)
          .setScale(SCALE).setDepth(0);
        continue;
      }

      const frame = frameFromGrid(t.tileX, t.tileY);

      if (frame === FRAME_TREE) {
        // Render grass underneath the tree
        scene.add.image(x, y, SHEET_KEY, FRAME_GRASS)
          .setScale(SCALE).setDepth(0);
        treePositions.push({ col, row });
      } else {
        scene.add.image(x, y, SHEET_KEY, frame)
          .setScale(SCALE).setDepth(0);
        // Bare ground tiles can spawn rocks
        if (frame === FRAME_BARE) {
          rockSpawnTiles.push({ col, row });
        }
      }
    }
  }

  return { treePositions, rockSpawnTiles, width, height };
}

/**
 * Fallback: procedural tilemap (used if no map data loaded).
 */
export function buildTilemap(scene, cols, rows) {
  const FRAME_DIRT = 1483, FRAME_STONE = 887;

  let seed = 42;
  const rand = () => { seed = (seed * 1664525 + 1013904223) & 0xffffffff; return (seed >>> 0) / 0xffffffff; };

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = col * TILE_SIZE + TILE_SIZE / 2;
      const y = row * TILE_SIZE + TILE_SIZE / 2;

      let frame = FRAME_GRASS;
      if (row === 0 || row === rows - 1 || col === 0 || col === cols - 1) {
        frame = FRAME_STONE;
      } else if (rand() < 0.08) {
        frame = FRAME_DIRT;
      }

      scene.add.image(x, y, SHEET_KEY, frame)
        .setScale(SCALE).setDepth(0);
    }
  }
}
