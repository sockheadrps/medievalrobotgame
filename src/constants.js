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
  Bastalite: 554,
  CrystalPristine: 554,
  CrystalNormal: 554,
  CrystalPoor: 554,
  KiShrine: 554,
};

// --- Dropped-log sprites (custom PNGs, 16x16) ---
export const LOG1_KEY  = 'log1';
export const LOG1_PATH = 'assets/log1.png';
export const LOG2_KEY  = 'log2';
export const LOG2_PATH = 'assets/log2.png';
export const LOG3_KEY  = 'log3';
export const LOG3_PATH = 'assets/log3.png';
export const FIRE_KEY  = 'fire';
export const FIRE_PATH = 'assets/fire.png';
export const CRATER_KEY = 'crater';
export const CRATER_PATH = 'assets/crater.png';
export const FIRE_JSON_PATH = 'assets/fire.json';
export const FIRE_FRAME_W = 32;
export const FIRE_FRAME_H = 32;
export const FIRE_TOTAL_FRAMES = 12;
export const ARMOR_ELITE_KEY = 'armor_elite';
export const ARMOR_ELITE_PATH = 'assets/overplayer/Armor_Elite.png';
export const ARMOR_ELITE_META_KEY = 'armor_elite_meta';
export const ARMOR_ELITE_META_PATH = 'assets/overplayer/Armor_Elite_mapped.json';
export const ARMOR_ELITE_FRAME_W = 32;
export const ARMOR_ELITE_FRAME_H = 32;

// --- NRG / Ki blast spritesheet (assets/nrg/7.png — 32x32 frames, 24 total) ---
export const NRG_KEY      = 'nrg_blast';
export const NRG_PATH     = 'assets/nrg/7.png';
export const NRG_FRAME_W  = 32;
export const NRG_FRAME_H  = 32;
export const AURA_KEY     = 'charge_aura';
export const AURA_PATH    = 'assets/Aura.png';
export const AURA_FRAME_W = 32;
export const AURA_FRAME_H = 32;
export const AURA_FRAMES  = 6;
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
export const CHARGE_STR_BONUS   = 0.50;
export const CHARGE_DEF_BONUS   = 0.50;
export const CHARGE_KI_ATTACK_BONUS = 0.50;
export const CHARGE_KI_REGEN_BONUS  = 1.00;
export const KI_SKILL_MEDITATE_UNLOCK_LEVEL = 10;
export const MEDITATION_POOR_MS = 30000;
export const MEDITATION_NORMAL_MS = 50000;
export const MEDITATION_PRISTINE_MS = 70000;

// --- Anvil frame (from roguelike spritesheet) ---
export const FRAME_ANVIL    = 15;   // col=15 row=0  — placeable anvil
export const FRAME_CRYSTAL  = 554;  // col=50 row=9  — ki crystal sprite

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
export const PFRAME_MEDITATE    = 16;
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
