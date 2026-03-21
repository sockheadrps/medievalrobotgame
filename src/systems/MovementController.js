import { TILE_SIZE } from '../constants.js';

/**
 * MovementController — player movement prediction, collision setup,
 * and barrier resolution.
 * GameScene calls this._movement.update(delta) each frame.
 */
export default class MovementController {
  constructor(scene, player) {
    this.scene = scene;
    this.player = player;
  }

  /**
   * Register a Phaser physics collider between the player and the static
   * collision group built from the tilemap. Called from _loadMap() after
   * the collision group is ready.
   */
  addCollisionGroup(collisionGroup) {
    this.scene.physics.add.collider(this.player, collisionGroup);
  }

  update(delta) {
    const scene = this.scene;
    const player = this.player;

    // ── Send input to server + client-side prediction ─────────────────────────
    if (scene._conn.connected && !scene.chatBox?.isOpen() && !player._punching && !scene._namingNPC && !scene._playerDead && !scene._playerKnockedOut && !scene._escMenuOpen && !scene._inventoryOpen && !scene._charMenuOpen) {
      const keys = player._keys;
      let dx = 0, dy = 0;
      if (keys.left.isDown)  dx -= 1;
      if (keys.right.isDown) dx += 1;
      if (keys.up.isDown)    dy -= 1;
      if (keys.down.isDown)  dy += 1;
      const running = keys.run.isDown;
      scene._conn.sendMove(dx, dy, running);

      // Client-side prediction: move locally for responsive feel
      if (dx !== 0 || dy !== 0) {
        const speed = running ? 280 : 160;
        let mx = dx, my = dy;
        if (mx !== 0 && my !== 0) { mx /= Math.SQRT2; my /= Math.SQRT2; }
        const dt = delta / 1000;
        const prevX = player.x;
        const prevY = player.y;
        player.x += mx * speed * dt;
        player.y += my * speed * dt;
        // Clamp to world bounds
        if (scene._currentMap === 'cave_01') {
          const EXT = 15;
          const minB = -EXT * TILE_SIZE;
          const maxW = (scene._mapCols + EXT) * TILE_SIZE;
          const maxH = (scene._mapRows + EXT) * TILE_SIZE;
          player.x = Math.max(minB, Math.min(maxW, player.x));
          player.y = Math.max(minB, Math.min(maxH, player.y));
        } else {
          const worldW = scene._mapCols * TILE_SIZE;
          const worldH = scene._mapRows * TILE_SIZE;
          player.x = Math.max(0, Math.min(worldW, player.x));
          player.y = Math.max(0, Math.min(worldH, player.y));
        }
        // Fence/gate collision — push back if overlapping
        this._resolveBarrierCollision(prevX, prevY);
      }
    } else if (scene._conn.connected) {
      scene._conn.sendMove(0, 0, false);
    }
  }

  /**
   * After client-side movement prediction, check if player overlaps any
   * fence or gate they shouldn't pass through, and push back.
   */
  _resolveBarrierCollision(prevX, prevY) {
    const scene = this.scene;
    const p = this.player;
    if (!p) return;
    const halfBody = TILE_SIZE * 0.35; // approximate player half-width
    for (const entity of Object.values(scene._buildingSprites || {})) {
      if (entity._kind !== 'fence' && entity._kind !== 'gate') continue;
      // Gates: owner can pass through
      if (entity._kind === 'gate' && entity._owner === scene.playerId) continue;
      const bx = entity.x;
      const by = entity.y;
      const halfTile = TILE_SIZE / 2;
      // AABB overlap check
      const overlapX = (halfBody + halfTile) - Math.abs(p.x - bx);
      const overlapY = (halfBody + halfTile) - Math.abs(p.y - by);
      if (overlapX <= 0 || overlapY <= 0) continue;
      // Push back on the axis of least penetration
      if (overlapX < overlapY) {
        p.x = p.x < bx ? bx - halfTile - halfBody : bx + halfTile + halfBody;
      } else {
        p.y = p.y < by ? by - halfTile - halfBody : by + halfTile + halfBody;
      }
    }
  }
}
