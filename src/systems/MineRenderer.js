/**
 * MineRenderer — renders the procedural mine grid with fog-of-war.
 *
 * Manages tile sprites for the cave mining system:
 * - open tiles: cave floor at full brightness
 * - wall/hardwall tiles: rock faces, with ore overlays if visible
 * - bedrock: unbreakable boundary
 * - unknown tiles: not rendered (black void)
 * - known but not visible: dimmed (alpha 0.35)
 *
 * Also creates Phaser static physics bodies for wall/hardwall/bedrock tiles
 * so the player can't walk through unmined walls.
 */

import {
  TILE_SIZE, SHEET_KEY, SHEET_TILE, SHEET_COLS,
  MINE_FRAME_WALL, MINE_FRAME_HARDWALL, MINE_FRAME_BEDROCK, MINE_FRAME_FLOOR,
  MINE_FRAME_ORE_IRON, MINE_FRAME_ORE_GOLD, MINE_FRAME_GEODE,
  tilePos,
} from '../constants.js';

const SCALE = TILE_SIZE / SHEET_TILE;

// Ore type → overlay frame
const ORE_FRAME_MAP = {
  raw_iron_ore: MINE_FRAME_ORE_IRON,
  raw_gold_ore: MINE_FRAME_ORE_GOLD,
  geode:        MINE_FRAME_GEODE,
  coal:         MINE_FRAME_ORE_IRON,  // reuse iron frame tinted
};

// Tile type → base frame
const TYPE_FRAME_MAP = {
  open:     MINE_FRAME_FLOOR,
  wall:     MINE_FRAME_WALL,
  hardwall: MINE_FRAME_HARDWALL,
  bedrock:  MINE_FRAME_BEDROCK,
};

const WALL_TYPES = new Set(['wall', 'hardwall', 'bedrock']);
const DIM_ALPHA = 0.35;

export default class MineRenderer {
  constructor(scene) {
    this.scene = scene;
    /** @type {Map<string, Phaser.GameObjects.Image>} key = "col,row" */
    this._sprites = new Map();
    /** @type {Map<string, Phaser.GameObjects.Image>} ore overlay sprites */
    this._oreSprites = new Map();
    /** @type {Map<string, Phaser.GameObjects.Rectangle>} physics bodies for wall tiles */
    this._wallBodies = new Map();
    /** @type {Phaser.Physics.Arcade.StaticGroup|null} */
    this._wallGroup = null;
    this._active = false;
    /** @type {Map<string, string>} key → tile type, for quick lookup */
    this._tileTypes = new Map();
  }

  /**
   * Apply a full set of mine tiles from the server.
   * Called on cave entry and after mine_update events.
   * @param {Array<{c:number, r:number, t:string, v:boolean, o?:string, vn?:boolean}>} tiles
   */
  updateTiles(tiles) {
    if (!tiles || !tiles.length) return;
    this._active = true;

    // Hide base cave tilemap sprites so they don't overlap mine tiles
    if (this.scene._tileImages) {
      for (const img of this.scene._tileImages) img?.setVisible(false);
    }

    // Ensure wall collision group exists
    if (!this._wallGroup) {
      this._wallGroup = this.scene.physics.add.staticGroup();
      if (this.scene.player) {
        this.scene.physics.add.collider(this.scene.player, this._wallGroup);
      }
    }

    const seen = new Set();

    for (const tile of tiles) {
      const key = `${tile.c},${tile.r}`;
      seen.add(key);
      this._tileTypes.set(key, tile.t);

      const { x, y } = tilePos(tile.c, tile.r);
      const frame = TYPE_FRAME_MAP[tile.t] || MINE_FRAME_FLOOR;

      // Create or update base sprite
      let sprite = this._sprites.get(key);
      if (!sprite) {
        sprite = this.scene.add.image(x, y, SHEET_KEY, frame)
          .setScale(SCALE)
          .setDepth(0);
        this._sprites.set(key, sprite);
      } else {
        sprite.setFrame(frame);
        sprite.setPosition(x, y);
        sprite.setVisible(true);
      }

      // Visibility: full brightness or dimmed
      sprite.setAlpha(tile.v ? 1.0 : DIM_ALPHA);

      // Vein tiles get a slight tint
      if (tile.vn) {
        sprite.setTint(0xffdd66);
      } else {
        sprite.clearTint();
      }

      // Ore overlay (only on visible wall/hardwall)
      let oreSprite = this._oreSprites.get(key);
      if (tile.o && tile.v && (tile.t === 'wall' || tile.t === 'hardwall')) {
        const oreFrame = ORE_FRAME_MAP[tile.o];
        if (oreFrame !== undefined) {
          if (!oreSprite) {
            oreSprite = this.scene.add.image(x, y, SHEET_KEY, oreFrame)
              .setScale(SCALE * 0.7)
              .setDepth(1)
              .setAlpha(0.8);
            this._oreSprites.set(key, oreSprite);
          } else {
            oreSprite.setFrame(oreFrame);
            oreSprite.setPosition(x, y);
            oreSprite.setVisible(true);
            oreSprite.setAlpha(0.8);
          }
        }
      } else if (oreSprite) {
        oreSprite.setVisible(false);
      }

      // Physics body for wall tiles (collision)
      const isWall = WALL_TYPES.has(tile.t);
      let body = this._wallBodies.get(key);
      if (isWall) {
        if (!body) {
          body = this.scene.add.rectangle(x, y, TILE_SIZE, TILE_SIZE);
          this.scene.physics.add.existing(body, true); // true = static
          this._wallGroup.add(body);
          this._wallBodies.set(key, body);
        }
      } else {
        // Tile became open (was mined) — remove physics body
        if (body) {
          body.destroy();
          this._wallBodies.delete(key);
        }
      }
    }

    // Remove sprites/bodies that are no longer in the tile set
    for (const [key, sprite] of this._sprites) {
      if (!seen.has(key)) {
        sprite.destroy();
        this._sprites.delete(key);
        this._tileTypes.delete(key);
        const ore = this._oreSprites.get(key);
        if (ore) {
          ore.destroy();
          this._oreSprites.delete(key);
        }
        const body = this._wallBodies.get(key);
        if (body) {
          body.destroy();
          this._wallBodies.delete(key);
        }
      }
    }
  }

  /**
   * Clean up all mine sprites (when leaving cave).
   */
  destroy() {
    for (const sprite of this._sprites.values()) sprite.destroy();
    for (const sprite of this._oreSprites.values()) sprite.destroy();
    for (const body of this._wallBodies.values()) body.destroy();
    this._sprites.clear();
    this._oreSprites.clear();
    this._wallBodies.clear();
    this._tileTypes.clear();
    if (this._wallGroup) {
      this._wallGroup.clear(true, true);
      this._wallGroup = null;
    }
    this._active = false;

    // Restore base tilemap sprites
    if (this.scene._tileImages) {
      for (const img of this.scene._tileImages) img?.setVisible(true);
    }
  }

  get isActive() {
    return this._active;
  }

  /**
   * Get the tile type at a grid position (for click detection).
   * Returns null if no mine tile data at that position.
   */
  getTileKey(col, row) {
    return this._sprites.has(`${col},${row}`) ? `${col},${row}` : null;
  }
}
