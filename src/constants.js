// Shared constants — must match auxserver/data/constants.json.
// To verify sync: compare with GET /api/constants.
// Do NOT replace with an async fetch — static imports are required at Phaser init time.

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
export const FRAME_ROCK     = 1251; // col=54 row=21 — mineable rock
export const FRAME_BARE     = 6;    // col=6  row=0  — bare ground (rock spawn tile)

// Maps resource name → spritesheet frame for rendering items on ground
export const RESOURCE_FRAME = {
  Wood: 526,
  Stone: 1251,
  Crystal: 554,
  KiTarget: 526,
  bronze_bar: 795,
  raw_copper: 554,
  raw_tin: 554,
  planks: 526,
};

// --- Furnace ---
export const FRAME_FURNACE = 13;   // col=13 row=0

// --- Dropped-log sprites (custom PNGs, 16x16) ---
export const LOG1_KEY  = 'log1';
export const LOG1_PATH = 'assets/log1.png';
export const LOG2_KEY  = 'log2';
export const LOG2_PATH = 'assets/log2.png';
export const LOG3_KEY  = 'log3';
export const LOG3_PATH = 'assets/log3.png';

// --- NRG / Ki blast spritesheet (assets/nrg/7.png — 32x32 frames, 24 total) ---
export const NRG_KEY      = 'nrg_blast';
export const NRG_PATH     = 'assets/nrg/7.png';
export const NRG_FRAME_W  = 32;
export const NRG_FRAME_H  = 32;
export const ABSORB_KEY      = 'absorb_fx';
export const ABSORB_PATH     = 'assets/absorb/15.png';
export const ABSORB_FRAME_W  = 32;
export const ABSORB_FRAME_H  = 32;
export const ABSORB_FRAMES   = 12;
export const BARRIER_KEY     = 'barrier_fx';
export const BARRIER_PATH    = 'assets/barrier.png';
export const BARRIER_FRAME_W = 32;
export const BARRIER_FRAME_H = 32;
export const BARRIER_FRAMES  = 8;

// --- Ki defaults ---
export const KI_MAX_BASE       = 20;   // starting max Ki
export const KI_MAX_PER_LEVEL  = 2;    // guaranteed base max Ki gained per level
export const KI_REGEN_MS       = 5000; // regen 1 Ki every 5s
export const KI_BLAST_BASE_COST = 8;   // base cost at level 0
export const KI_BLAST_BASE_DMG  = 2;   // base damage at level 0
export const KI_BLAST_SCALE     = 0.02; // 2% improvement per blast level

// --- Anvil frame (from roguelike spritesheet) ---
export const FRAME_ANVIL    = 15;   // col=15 row=0  — placeable anvil
export const FRAME_CHEST    = 366;  // col=24 row=6  — chest/crate sprite
export const FRAME_CRYSTAL  = 554;  // col=50 row=9  — ki crystal sprite
export const FIRE_KEY       = 'fire';
export const FIRE_PATH      = 'assets/fire.png';
export const FIRE_FRAME_W   = 32;
export const FIRE_FRAME_H   = 32;
export const FIRE_FRAMES    = 12;


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

// --- Rock ---
export const ROCK_MINE_DIST  = 80;   // px, player must be within this to mine
export const ROCK_HITS        = 5;    // clicks required to harvest
export const ROCK_LIFESPAN   = 60000; // ms — despawns after 1 minute if not mined

// --- Interaction ---
export const INTERACT_DIST   = 90;
export const INTERACT_KEY    = 'E';

// --- Animal spritesheets ---
export const DINOBIRD_KEY    = 'dinobird';
export const DINOBIRD_PATH   = 'assets/dinobird.png';
export const DINOBIRD_FRAME_W = 32;
export const DINOBIRD_FRAME_H = 32;

// --- Conveyor system ---
export const DIR_RIGHT = 'right';
export const DIR_LEFT  = 'left';
export const DIR_UP    = 'up';
export const DIR_DOWN  = 'down';

export const DIR_DELTA = {
  [DIR_RIGHT]: { dc:  1, dr:  0 },
  [DIR_LEFT]:  { dc: -1, dr:  0 },
  [DIR_UP]:    { dc:  0, dr: -1 },
  [DIR_DOWN]:  { dc:  0, dr:  1 },
};

// Conveyor direction arrows
export const FRAME_ARROW_RIGHT = 1590;
export const FRAME_ARROW_LEFT  = 1589;
export const FRAME_ARROW_DOWN  = 1647;
export const FRAME_ARROW_UP    = 1646;

export const DIR_ARROW_FRAME = {
  [DIR_RIGHT]: 1590,
  [DIR_LEFT]:  1589,
  [DIR_UP]:    1646,
  [DIR_DOWN]:  1647,
};

// Conveyor belt tick interval (ms)
export const CONVEYOR_TICK_MS           = 1000;
export const WOOD_PULP_CONVEYOR_TICK_MS = 1400;

// Belt sprite frames
export const FRAME_CONV_V = 1092; // up→up or down→down
export const FRAME_CONV_H = 1149; // left→left or right→right

// Frame lookup: "inDir,outDir" → frame index
// Straights and 90° curves from spritesheet
export const CONV_FRAME_LOOKUP = {
  // Straights
  'right,right': 1149, 'left,left': 1149,
  'up,up':       1092, 'down,down': 1092,
  // Curves
  'right,down':  1091,
  'up,left':     1091,
  'left,down':   1090,
  'up,right':    1090,
  'down,left':   1148,
  'right,up':    1148,
  'down,right':  1147,
  'left,up':     1147,
};

// --- Gate & Fence ---
export const FRAME_GATE      = 1334; // col=46 row=23
export const FRAME_FENCE     = 1335; // col=47 row=23
export const FENCE_BASE_HP   = 50;
export const GATE_LOG_COST   = 3;
export const FENCE_LOG_COST  = 2;

// --- Log Cutting Station ---
export const FRAME_LOG_CUTTER = 1250; // col=53 row=21
export const FRAME_ETRAINER   = 587;  // col=17 row=10 — eternal training dummy

// --- Minecart Tracks ---
export const FRAME_TRACK_H = 1069;  // col=43 row=18 — horizontal track
export const FRAME_TRACK_V = 1126;  // col=43 row=19 — vertical track
export const FRAME_CART_H  = 1132;  // col=49 row=19 — horizontal cart
export const FRAME_CART_V  = 1134;  // col=51 row=19 — vertical cart
export const FRAME_MINECART_PORTAL = 150; // col=36 row=2 — exit/entrance marker
export const TRACK_TICK_MS = 800;

// Frame lookup: "inDir,outDir" → track frame index
export const TRACK_FRAME_LOOKUP = {
  // Straights
  'right,right': 1069, 'left,left': 1069,
  'up,up':       1126, 'down,down': 1126,
  // Corners (rotated 90° CCW from spritesheet labels)
  'up,right':    1067, 'left,down': 1067,
  'right,down':  1068, 'up,left':   1068,
  'down,left':   1125, 'right,up':  1125,
  'left,up':     1124, 'down,right': 1124,
};

// --- Cave Mining ---
export const MINE_FRAME_WALL     = 1271;  // col=39 row=22
export const MINE_FRAME_HARDWALL = 1271;  // col=39 row=22
export const MINE_FRAME_BEDROCK  = 1174;  // col=34 row=20 — unbreakable boundary
export const MINE_FRAME_FLOOR    = 578;   // col=8  row=10 — cave floor
export const MINE_FRAME_ORE_IRON = 1251;  // col=54 row=21 — iron ore overlay
export const MINE_FRAME_ORE_GOLD = 554;   // col=50 row=9  — gold ore overlay (crystal sprite)
export const MINE_FRAME_GEODE    = 366;   // col=24 row=6  — geode (chest sprite)

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
