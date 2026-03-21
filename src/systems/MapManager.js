/**
 * MapManager — map loading, bounds, tilemap building, tile images.
 * GameScene.create() initializes this and calls loadMap().
 * scene._currentMap is kept in sync so other scene code can read it directly.
 */
import { buildTilemap, buildTilemapFromData } from './TilemapBuilder.js';
import { TILE_SIZE } from '../constants.js';
import { API_BASE } from '../config.js';

export default class MapManager {
  constructor(scene) {
    this.scene = scene;
    this._tileImages = [];
    this._tileImagesOverlay = []; // layer ≥1 tiles — never hidden by MineRenderer
    this._collisionGroup = null;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Initial map load called from create(). Returns a promise (non-async callers use .catch()). */
  async loadMap() {
    const scene = this.scene;
    try {
      const res = await fetch(`${API_BASE}/load-map?name=level_01`);
      if (!res.ok) throw new Error(`Map load failed: ${res.status}`);
      const mapData = await res.json();

      const { treePositions, rockSpawnTiles, collisionRects, tileImages, tileImagesOverlay, width, height } = buildTilemapFromData(scene, mapData);
      scene._currentMap = mapData.name || 'level_01';
      this._tileImages = tileImages;
      this._tileImagesOverlay = tileImagesOverlay;
      scene._tileImages = tileImages;
      scene._tileImagesOverlay = tileImagesOverlay;

      // Update world dimensions on scene so other code can read them
      scene._mapCols = width;
      scene._mapRows = height;
      this.applyMapBounds(scene._currentMap, width, height);

      // Parse minecart exit tiles from map items
      scene._minecartExitTiles = (mapData.mapItems || [])
        .filter(it => (it.label || '').startsWith('minecart_exit:'))
        .map(it => ({ col: it.tileCol, row: it.tileRow, target: it.label.split(':')[1] }));

      // Parse + shade minecart entrance tiles
      scene._clearMinecartMarkers();
      (mapData.mapItems || [])
        .filter(it => (it.label || '') === 'minecart_entrance')
        .forEach(it => scene._addMinecartMarker(it.tileCol, it.tileRow, 0x3366ff));
      (mapData.mapItems || [])
        .filter(it => (it.label || '').startsWith('minecart_exit:'))
        .forEach(it => scene._addMinecartMarker(it.tileCol, it.tileRow, 0xff6633));

      // Spawn trees at positions found in the map
      scene._spawnTreesAt(treePositions);

      // Create static physics bodies for collision tiles
      if (!this._collisionGroup) {
        this._collisionGroup = scene.physics.add.staticGroup();
      }
      for (const { x, y, w, h } of collisionRects) {
        const body = scene.add.rectangle(x + w / 2, y + h / 2, w, h);
        scene.physics.add.existing(body, true);
        this._collisionGroup.add(body);
      }
      if (scene.player) {
        scene._movement.addCollisionGroup(this._collisionGroup);
      }

      console.log(`[map] Loaded level_01: ${width}x${height}, ${treePositions.length} trees, ${rockSpawnTiles.length} rock spawn tiles, ${collisionRects.length} collision tiles`);
    } catch (e) {
      console.warn('[map] Failed to load level1, using fallback:', e.message);
      buildTilemap(scene, scene._mapCols, scene._mapRows);
      scene._spawnTreesFallback();
    }
  }

  /** Server-triggered map transition. Called via scene._changeMap() → this.changeMap(). */
  async changeMap(newMap) {
    const scene = this.scene;

    // Register background NPCs — NPCs staying on the old map with active tasks
    await scene._registerBackgroundNPCs(scene._currentMap, newMap);

    // Determine which NPCs stay on old map vs come to new map
    for (const npc of scene.entities.npcs) {
      if (!npc._map) npc._map = scene._currentMap;
      const runner = scene._taskRunners.get(npc.id);
      const status = runner?.getStatus();
      const task = status?.tasks?.[0];
      const staysOnOldMap = npc._map === scene._currentMap
        && task && ['custom_task', 'mine_ore', 'gather'].includes(task.task);
      if (staysOnOldMap) {
        // NPC stays behind — hide it
        npc.setVisible(false);
        if (npc.body) npc.body.enable = false;
      } else {
        // NPC comes with player — update its map
        npc._map = newMap;
      }
    }

    // Fade out
    scene.cameras.main.fadeOut(300, 0, 0, 0);
    await new Promise(r => setTimeout(r, 320));

    // Destroy old tile images
    for (const img of (this._tileImages || [])) img?.destroy();
    for (const img of (this._tileImagesOverlay || [])) img?.destroy();
    this._tileImages = [];
    this._tileImagesOverlay = [];

    // Destroy old trees
    for (const tree of (scene.entities.trees || [])) tree?.destroy?.();
    scene.entities.trees = [];

    // Destroy old collision group
    if (this._collisionGroup) {
      this._collisionGroup.clear(true, true);
      this._collisionGroup = null;
    }

    // Load new map
    try {
      const res = await fetch(`${API_BASE}/load-map?name=${newMap}`);
      if (!res.ok) throw new Error(`Map load failed: ${res.status}`);
      const mapData = await res.json();
      const { treePositions, rockSpawnTiles, collisionRects, tileImages, tileImagesOverlay, width, height } = buildTilemapFromData(scene, mapData);
      scene._currentMap = newMap;
      this._tileImages = tileImages;
      this._tileImagesOverlay = tileImagesOverlay;
      scene._tileImages = tileImages;
      scene._tileImagesOverlay = tileImagesOverlay;
      scene._mapCols = width;
      scene._mapRows = height;
      this.applyMapBounds(newMap, width, height);

      // Parse minecart exit tiles from map items
      scene._minecartExitTiles = (mapData.mapItems || [])
        .filter(it => (it.label || '').startsWith('minecart_exit:'))
        .map(it => ({ col: it.tileCol, row: it.tileRow, target: it.label.split(':')[1] }));

      // Shade minecart entrance/exit markers
      scene._clearMinecartMarkers();
      (mapData.mapItems || [])
        .filter(it => (it.label || '') === 'minecart_entrance')
        .forEach(it => scene._addMinecartMarker(it.tileCol, it.tileRow, 0x3366ff));
      (mapData.mapItems || [])
        .filter(it => (it.label || '').startsWith('minecart_exit:'))
        .forEach(it => scene._addMinecartMarker(it.tileCol, it.tileRow, 0xff6633));

      scene._spawnTreesAt(treePositions);

      // Collision group
      this._collisionGroup = scene.physics.add.staticGroup();
      for (const { x, y, w, h } of collisionRects) {
        const body = scene.add.rectangle(x + w / 2, y + h / 2, w, h);
        scene.physics.add.existing(body, true);
        this._collisionGroup.add(body);
      }
      if (scene.player) {
        scene._movement.addCollisionGroup(this._collisionGroup);
      }

      // Mine renderer: request tiles when entering cave, destroy when leaving
      if (newMap === 'cave_01') {
        scene._conn?.send({ type: 'request_mine_tiles' });
      } else {
        scene._mineRenderer.destroy();
      }
    } catch (e) {
      console.warn('[map] Failed to change map:', e.message);
    }

    // Unregister background NPCs that are on the NEW map (player just arrived)
    scene._unregisterBackgroundNPCs(newMap);

    // Show NPCs that are on the new map, keep hiding others
    for (const npc of scene.entities.npcs) {
      if (npc._map === newMap || !npc._map) {
        npc.setVisible(true);
        if (npc.body) npc.body.enable = true;
      }
    }

    // Fade back in
    scene.cameras.main.fadeIn(300, 0, 0, 0);
  }

  /** Set camera + physics bounds for the given map dimensions. */
  applyMapBounds(mapName, cols, rows) {
    const scene = this.scene;
    if (mapName === 'cave_01') {
      // Initial bounds — MineRenderer will tighten these once tile data arrives
      const EXT = 100;
      const minX = -EXT * TILE_SIZE;
      const minY = -EXT * TILE_SIZE;
      const totalW = (cols + EXT * 2) * TILE_SIZE;
      const totalH = (rows + EXT * 2) * TILE_SIZE;
      scene.physics.world.setBounds(minX, minY, totalW, totalH);
      scene.cameras.main.setBounds(minX, minY, totalW, totalH);
    } else {
      const worldW = cols * TILE_SIZE;
      const worldH = rows * TILE_SIZE;
      scene.physics.world.setBounds(0, 0, worldW, worldH);
      scene.cameras.main.setBounds(0, 0, worldW, worldH);
    }
  }
}
