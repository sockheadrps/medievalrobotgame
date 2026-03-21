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
  const collisionRects = [];
  /** Layer-0 tiles — hidden by MineRenderer when in cave */
  const tileImages = [];
  /** Layer ≥1 tiles — always visible, rendered above mine grid (depth 5) */
  const tileImagesOverlay = [];

  // Build a lookup: "col,row" -> tile entry (includes layer)
  const lookup = {};
  for (const t of tiles) {
    const key = `${t.x},${t.y}`;
    // Keep the highest-layer tile per cell when duplicates exist
    if (!lookup[key] || (t.layer ?? 0) > (lookup[key].layer ?? 0)) {
      lookup[key] = t;
    }
  }

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const x = col * TILE_SIZE + TILE_SIZE / 2;
      const y = row * TILE_SIZE + TILE_SIZE / 2;

      const t = lookup[`${col},${row}`];
      const isOverlay = (t?.layer ?? 0) >= 1;

      if (!t) {
        tileImages.push(scene.add.image(x, y, SHEET_KEY, FRAME_GRASS).setScale(SCALE).setDepth(0));
        continue;
      }

      const frame = frameFromGrid(t.tileX, t.tileY);

      if (frame === FRAME_TREE) {
        // Grass under the tree always goes in base layer
        tileImages.push(scene.add.image(x, y, SHEET_KEY, FRAME_GRASS).setScale(SCALE).setDepth(0));
        treePositions.push({ col, row });
      } else if (isOverlay) {
        // Layer ≥1: render above mine grid, never hidden by MineRenderer
        tileImagesOverlay.push(scene.add.image(x, y, SHEET_KEY, frame).setScale(SCALE).setDepth(5));
      } else {
        tileImages.push(scene.add.image(x, y, SHEET_KEY, frame).setScale(SCALE).setDepth(0));
        if (frame === FRAME_BARE) {
          rockSpawnTiles.push({ col, row });
        }
      }
    }
  }

  // Build static physics bodies for collision tiles
  for (const ct of (mapData.collisionTiles || [])) {
    const cx = ct.x * TILE_SIZE;
    const cy = ct.y * TILE_SIZE;
    collisionRects.push({ x: cx, y: cy, w: TILE_SIZE, h: TILE_SIZE });
  }

  return { treePositions, rockSpawnTiles, collisionRects, tileImages, tileImagesOverlay, width, height };
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
