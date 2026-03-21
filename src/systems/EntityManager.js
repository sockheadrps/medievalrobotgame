/**
 * EntityManager — owns all entity arrays and provides lookup methods.
 * GameScene, WorldSyncController, and StateSyncController interact with
 * entities through this class, not through GameScene directly.
 */
export default class EntityManager {
  constructor(scene) {
    this.scene = scene;

    // Entity arrays (moved from GameScene)
    this.trees = [];
    this.groundItems = [];
    this.npcs = [];
    this.dummies = [];
  }

  add(type, entity) {
    if (!Array.isArray(this[type])) throw new Error(`EntityManager: unknown entity type "${type}"`);
    this[type].push(entity);
    return entity;
  }

  remove(type, entity) {
    const arr = this[type];
    const idx = arr.indexOf(entity);
    if (idx !== -1) arr.splice(idx, 1);
  }

  findNearestNpc(x, y, maxDist = Infinity) {
    let nearest = null, best = maxDist;
    for (const npc of this.npcs) {
      const d = Math.hypot(npc.x - x, npc.y - y);
      if (d < best) { best = d; nearest = npc; }
    }
    return nearest;
  }

  findAtPosition(type, x, y, tolerance = 16) {
    return this[type].find(e =>
      Math.abs(e.x - x) < tolerance && Math.abs(e.y - y) < tolerance
    ) ?? null;
  }
}
