// --- Tilemap ---
export const TILE_SIZE    = 48;
export const MAP_COLS     = 80;
export const MAP_ROWS     = 50;

// --- Tile type IDs ---
export const TILE_GRASS   = 0;
export const TILE_DIRT    = 1;
export const TILE_STONE   = 2;

// --- Spritesheet ---
export const SHEET_KEY      = 'roguelike';
export const SHEET_PATH     = 'assets/Spritesheet/roguelikeSheet_transparent.png';
export const SHEET_TILE     = 16;   // tile size in px
export const SHEET_SPACING  = 1;    // gap between tiles
export const SHEET_COLS     = 57;   // columns in sheet

// --- Spritesheet frame indices (col + row * SHEET_COLS) ---
export const FRAME_GRASS    = 1492;
export const FRAME_DIRT     = 1483;
export const FRAME_STONE    = 887;
export const FRAME_TREE     = 531;
export const FRAME_STUMP    = 1193;
export const FRAME_PLAYER   = 47;

// Maps resource name → spritesheet frame for rendering items on ground
export const RESOURCE_FRAME = {
  Wood: 526,
};

// --- Dropped-log sprites (custom PNGs, 16x16) ---
export const LOG1_KEY  = 'log1';
export const LOG1_PATH = 'assets/log1.png';
export const LOG2_KEY  = 'log2';
export const LOG2_PATH = 'assets/log2.png';
export const LOG3_KEY  = 'log3';
export const LOG3_PATH = 'assets/log3.png';

// --- Fence / Gate frames (from roguelike spritesheet) ---
export const FRAME_FENCE_T1  = 493;  // col=37 row=8  — 1-log fence (weakest)
export const FRAME_FENCE_T2  = 494;  // col=38 row=8  — 2-log fence
export const FRAME_FENCE_T3  = 495;  // col=39 row=8  — 3-log fence (strongest)
export const FRAME_GATE      = 40;   // col=40 row=0  — fence gate

// --- Player spritesheet (baseplayer.png — 32x32 frames) ---
export const PLAYER_KEY      = 'baseplayer';
export const PLAYER_PATH     = 'assets/baseplayer.png';
export const PLAYER_FRAME_W  = 32;
export const PLAYER_FRAME_H  = 32;
// Frame indices from baseplayer.json
export const PFRAME_FACE_DOWN  = 0;
export const PFRAME_FACE_UP    = 1;
export const PFRAME_FACE_RIGHT = 2;
export const PFRAME_FACE_LEFT  = 3;
export const PFRAME_WALK1_DOWN  = 4;
export const PFRAME_WALK1_UP   = 5;
export const PFRAME_WALK1_RIGHT = 6;
export const PFRAME_WALK1_LEFT  = 7;
export const PFRAME_STAND_DOWN  = 8;
export const PFRAME_STAND_UP    = 9;
export const PFRAME_STAND_RIGHT = 10;
export const PFRAME_STAND_LEFT  = 11;
export const PFRAME_WALK2_DOWN  = 12;
export const PFRAME_WALK2_UP    = 13;
export const PFRAME_WALK2_RIGHT = 14;
export const PFRAME_WALK2_LEFT  = 15;
// Punch frames (left/right only)
export const PFRAME_PUNCH_LEFT  = 25;
export const PFRAME_PUNCH_RIGHT = 26;

// --- NPC spritesheet (robotnpc.png — 32x32 frames) ---
export const NPC_KEY      = 'robotnpc';
export const NPC_PATH     = 'assets/robotnpc.png';
export const NPC_FRAME_W  = 32;
export const NPC_FRAME_H  = 32;
export const NFRAME_FACE_DOWN  = 0;
export const NFRAME_FACE_UP    = 1;
export const NFRAME_FACE_RIGHT = 2;
export const NFRAME_FACE_LEFT  = 3;
export const NFRAME_WALK1_DOWN  = 36;
export const NFRAME_WALK1_UP    = 37;
export const NFRAME_WALK1_RIGHT = 38;
export const NFRAME_WALK1_LEFT  = 39;
// Punch frames
export const NFRAME_PUNCH_RIGHT = 54;
export const NFRAME_PUNCH_LEFT  = 55;

// --- Player ---
export const PLAYER_SPEED     = 160;
export const PLAYER_RUN_SPEED = 280;

// --- Tree ---
export const TREE_CHOP_DIST  = 80;   // px, player must be within this to chop
export const TREE_REGROW_MIN = 15000; // ms
export const TREE_REGROW_MAX = 30000; // ms

// --- Interaction ---
export const INTERACT_DIST   = 90;
export const INTERACT_KEY    = 'E';

// --- Grid helpers ---
export function tilePos(col, row) {
  return {
    x: col * TILE_SIZE + TILE_SIZE / 2,
    y: row * TILE_SIZE + TILE_SIZE / 2,
  };
}

export function worldToTile(x, y) {
  return {
    col: Math.floor(x / TILE_SIZE),
    row: Math.floor(y / TILE_SIZE),
  };
}
