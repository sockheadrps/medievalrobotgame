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
export const FRAME_CHEST    = 366;
export const FRAME_MACHINE  = 965;
export const FRAME_WOOD_ROBOT_POD = 596; // col=36, row=10 → 10*56+36 = 596
export const FRAME_PLAYER   = 47;
export const FRAME_IRON     = 1594;
export const FRAME_FURNACE  = 13;   // col=0,  row=0  → 0*57+13 = 13
export const FRAME_IRON_BAR = 795;  // col=54, row=13 → 13*57+54 = 795
export const FRAME_QUARRY   = 105;  // col=48, row=1  → 1*57+48 = 105
export const FRAME_CRUSHER  = 263;  // col=35, row=4  → 4*57+35 = 263
export const FRAME_FLYWHEEL = 102;  // col=45, row=1  → 1*57+45  = 102
export const FRAME_WOODEN_FLYWHEEL = 45; // col=45, row=0  → 0*57+45 = 45
export const FRAME_ANVIL            = 15;   // col=15, row=0  → 0*57+15  = 15
export const FRAME_WOOD_BUILDING    = 1381;
export const FRAME_WOOD_STORAGE     = 360;  // col=24, row=6 (mapmaker verified)

// --- Mine Rock frames ---
export const FRAME_ROCK_COPPER = 1137;  // col=54, row=19 → 54 + 19×57 = 1137
export const FRAME_ROCK_GOLD   = 1251;  // col=54, row=21 → 54 + 21×57 = 1251
export const FRAME_ROCK_TIN    = 1252;  // col=55, row=21 → 55 + 21×57 = 1252
export const FRAME_ROCK_COAL   = 1194;  // col=54, row=20 → 54 + 20×57 = 1194
export const FRAME_ROCK_ORE    = 614;   // reuse existing ore rock sprite

// --- West Zone ---
export const WEST_ZONE_COLS  = 20;   // 20 columns wide (cols -20 to -1)
export const WEST_ZONE_OFFSET_X = -960; // WEST_ZONE_COLS(20) × TILE_SIZE(48) = 960px west
export const FRAME_CRAFTING_BENCH   = 944;  // col=32, row=16 → 32 + 16×57 = 944
export const FRAME_WOOD_FRAME_WALL  = 951;  // col=39, row=16 → 39 + 16×57 = 951
export const FRAME_DOOR_CLOSED      = 33;   // col=33, row=0  → 33
export const FRAME_DOOR_OPEN        = 90;   // col=33, row=1  → 33 + 57 = 90

// --- Furnace variants ---
export const FRAME_STEEL_FURNACE    = 13;   // reuses furnace frame, tinted blue-grey
export const FRAME_BRONZE_FURNACE   = 13;   // reuses furnace frame, tinted amber

// --- Output bar frames ---
export const FRAME_STEEL_BAR        = 795;  // reuse iron bar frame (tinted differently)
export const FRAME_BRONZE_BAR       = 795;  // reuse iron bar frame

// Maps resource name → spritesheet frame for rendering items on belts / ground
export const RESOURCE_FRAME = {
  Iron:           1594,
  Ore:            614,   // col=44, row=10 → 10*57+44 = 614
  Wood:           526,
  Stone:          887,
  IronBar:        795,
  IronArrowhead:  55,    // col=55, row=0  → 0*57+55  = 55
  Feather:        1591,
  Arrow:          1590,
  CopperOre:      1137,  // copper rock sprite
  TinOre:         1252,  // tin rock sprite
  GoldOre:        1251,  // gold rock sprite
  Coal:           1194,  // coal rock sprite
  SteelBar:       795,   // same frame as iron bar
  BronzeBar:      795,   // same frame as iron bar
  WoodPulpConveyor: 1149,
};

// Conveyor direction arrows (bottom-right of sheet)
export const FRAME_ARROW_RIGHT = 1590;
export const FRAME_ARROW_LEFT  = 1589;
export const FRAME_ARROW_DOWN  = 1647;
export const FRAME_ARROW_UP    = 1646;

// Direction constants
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

export const DIR_ARROW_FRAME = {
  [DIR_RIGHT]: 1590,
  [DIR_LEFT]:  1589,
  [DIR_UP]:    1646,
  [DIR_DOWN]:  1647,
};

// Conveyor belt sprites
// Keyed by "incomingDir,outputDir" — incomingDir is the direction the feeding conveyor faces
// Straight
export const FRAME_CONV_V = 1092; // up→up or down→down
export const FRAME_CONV_H = 1149; // left→left or right→right
// Curves (frame names match the user's spritesheet labels):
//   1090: left/down  → feeder faces right (enters from left), this conv exits down
//   1147: down/right → feeder faces up    (enters from below), this conv exits right
//   1148: left/up    → feeder faces right (enters from left), this conv exits up   -- actually: feeder up, exits right? re-check
//   1091: up/left    → feeder faces down  (enters from above), this conv exits left
// Curve frame lookup: key = "inputDirection,outputDirection"
// inputDirection  = direction flow enters this tile (= conveyor's .direction field)
// outputDirection = direction flow exits this tile  (= conveyor's ._outDir field)
// Confirmed directly from spritesheet (col,row → frame):
//   1090 (col=7,row=19): horizontal-left  turning down  (right→down)
//   1091 (col=8,row=19): horizontal-right turning down  (left→down), also vertical-top turning right (up→right)
//   1148 (col=8,row=20): vertical-bottom  turning left  (down→left), also right→up
//   1147 (col=7,row=20): the remaining pair             (down→right, left→up)
export const CONV_FRAME_LOOKUP = {
  // straight
  'right,right': 1149, 'left,left': 1149,
  'up,up':       1092, 'down,down': 1092,
  // curves — key is (conveyor's own direction, its output direction)
  'right,down':  1091,
  'up,left':     1091,
  'left,down':   1090,
  'up,right':    1090,
  'down,left':   1148,
  'right,up':    1148,
  'down,right':  1147,
  'left,up':     1147,
};

// Conveyor tick rate (ms between item transfers)
export const CONVEYOR_TICK_MS = 1000;
export const WOOD_PULP_CONVEYOR_TICK_MS = 1400;

// --- Chicken spritesheet ---
export const CHICKEN_KEY       = 'chicken';
export const CHICKEN_PATH      = 'assets/Chicken_Sprite_Sheet.png';
export const CHICKEN_FRAME_W   = 32;  // 128px / 4 cols
export const CHICKEN_FRAME_H   = 32;  // 128px / 4 rows
// Row indices: 0=?? 1=?? 2=?? 3=walk-left (bottom row)
// We use row 3 for all movement directions; flip X for right, same for up/down.
export const CHICKEN_WALK_ROW  = 3;   // bottom row = walk animation

// --- Player spritesheet ---
export const PLAYER_KEY      = 'player';
export const PLAYER_PATH     = 'assets/player.png';
export const PLAYER_FRAME_W  = 16;
export const PLAYER_FRAME_H  = 32;
// Animation row indices (3 frames each, col 0-2 per row)
// Row 0: walk down, 1: walk up, 2: walk left (right = flip of left)
// Row 3: run down,  4: run up,  5: run left  (run right = flip of row 5)
export const PANIM_WALK_DOWN = 0;
export const PANIM_WALK_UP   = 1;
export const PANIM_WALK_LEFT = 2;
export const PANIM_RUN_DOWN  = 3;
export const PANIM_RUN_UP    = 4;
export const PANIM_RUN_LEFT  = 5;

// --- Player ---
export const PLAYER_SPEED     = 160;
export const PLAYER_RUN_SPEED = 280;
export const PLAYER_SIZE      = 16;   // matches sheet tile size, scaled in game

// --- Mother Machine ---
export const MACHINE_SIZE   = 16;
export const INTERACT_DIST  = 90;

// --- Tree ---
export const TREE_SIZE      = 16;
export const TREE_CHOP_DIST = 80;   // px, player must be within this to chop
export const TREE_REGROW_MIN = 15000; // ms
export const TREE_REGROW_MAX = 30000; // ms

// --- Inventory & Weight ---
export const BASE_CARRY_CAPACITY        = 100;
export const CARRY_PER_ATHLETICS_LEVEL  = 2;
export const ENCUMBRANCE_THRESHOLD      = 0.7;  // speed penalty starts at 70% capacity
export const MAX_SPEED_PENALTY          = 0.5;  // max 50% speed reduction at full encumbrance
export const ATHLETICS_XP_INTERVAL_MS   = 5000; // award Athletics XP every 5 s of movement
export const BASE_INVENTORY_SLOTS       = 20;
export const MAX_INVENTORY_SLOTS        = 40;

// --- Input ---
export const INTERACT_KEY = 'E';

// --- Grid helpers ---
// Returns world-space pixel center of a tile at (col, row)
export function tilePos(col, row) {
  return {
    x: col * TILE_SIZE + TILE_SIZE / 2,
    y: row * TILE_SIZE + TILE_SIZE / 2,
  };
}

// Returns tile col/row from world pixel position
export function worldToTile(x, y) {
  return {
    col: Math.floor(x / TILE_SIZE),
    row: Math.floor(y / TILE_SIZE),
  };
}
