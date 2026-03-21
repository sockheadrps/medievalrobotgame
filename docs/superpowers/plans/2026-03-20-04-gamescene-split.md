# GameScene.js Split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce `GameScene.js` from 2,840 lines to under 600 by extracting `InputController`, `EntityManager`, `MovementController`, and `MapManager` into `src/systems/`.

**Architecture:** `GameScene` becomes a wiring layer. All four controllers receive the Phaser `scene` reference at construction time — never as a global. `EntityManager` is the first extraction because `WorldSyncController` and `StateSyncController` need it; complete `EntityManager` before the other three.

**Tech Stack:** Phaser.js 3. No new dependencies.

**Spec:** `docs/superpowers/specs/refactor/04-gamescene.md`

---

## File Map

**Create:**
- `src/systems/EntityManager.js` — all entity arrays and lookup methods (**do this first**)
- `src/systems/InputController.js` — keyboard + pointer + right-click handling
- `src/systems/MovementController.js` — player prediction, collision, pickups, portal detection
- `src/systems/MapManager.js` — map loading, bounds, tilemap building, tile images

**Modify:**
- `src/scenes/GameScene.js` — remove extracted logic, wire controllers in `create()`, delegate in `update()`
- `src/systems/WorldSyncController.js` — use `EntityManager` instead of `GameScene` arrays
- `src/systems/StateSyncController.js` — use `EntityManager` instead of `GameScene` arrays

---

### Task 1: Audit Connection.js before starting

- [ ] Read `src/net/Connection.js` (or wherever the WebSocket client lives):
```bash
find src/ -name "Connection.js" -o -name "connection.js" | head -5
```

- [ ] Check if `GameScene` calls `Connection` methods directly or if `Connection` calls back into `GameScene`:
```bash
grep -n "Connection\|connection\|websocket\|socket" src/scenes/GameScene.js | head -20
```

- [ ] If `Connection.js` interface is unchanged by this refactor, note "Connection.js: no changes needed" in a comment at the top of the plan.
  If it does need changes, document them before proceeding.

---

### Task 2: Extract EntityManager (do this before all other tasks)

**Files:**
- Create: `src/systems/EntityManager.js`

- [ ] Identify all entity arrays in `GameScene`:
```bash
grep -n "this\.trees\|this\.groundItems\|this\.npcs\|this\.dummies\|this\.animals\|this\.rocks\|this\.buildings\|this\.anvils\|this\.kiTargets\|this\.fences" src/scenes/GameScene.js | head -40
```

- [ ] Create `src/systems/EntityManager.js`:
```javascript
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
    this.animals = [];
    this.rocks = [];
    this.buildings = [];
    this.anvils = [];
    this.kiTargets = [];
    this.fences = [];
  }

  // Creation/destruction helpers
  add(type, entity) {
    this[type].push(entity);
    return entity;
  }

  remove(type, entity) {
    const arr = this[type];
    const idx = arr.indexOf(entity);
    if (idx !== -1) arr.splice(idx, 1);
  }

  // Lookup methods
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
```

- [ ] In `GameScene.create()`, replace entity array declarations with:
```javascript
import EntityManager from '../systems/EntityManager.js';
// ...
this.entities = new EntityManager(this);
// Replace: this.trees = []  →  (remove, now lives in EntityManager)
```

- [ ] Replace all `this.trees`, `this.npcs`, etc. references in `GameScene` with `this.entities.trees`, `this.entities.npcs`, etc.

- [ ] Update `WorldSyncController` to accept `entities` instead of `scene` for entity access:
```bash
grep -n "scene\.trees\|scene\.npcs\|scene\.groundItems\|scene\.rocks" src/systems/WorldSyncController.js
```
  Replace each `scene.X` with `entities.X` and update the constructor to accept `entities`.

- [ ] Update `StateSyncController` similarly.

- [ ] Manual check: open game, entities appear (trees, rocks, NPCs), nothing is broken.

- [ ] Commit:
```bash
git add src/systems/EntityManager.js src/scenes/GameScene.js src/systems/WorldSyncController.js src/systems/StateSyncController.js
git commit -m "refactor: extract EntityManager, update WorldSync/StateSync"
```

---

### Task 3: Extract InputController

**Files:**
- Create: `src/systems/InputController.js`
- Modify: `src/scenes/GameScene.js`

- [ ] Find all input handling in `GameScene`:
```bash
grep -n "this\.cursors\|this\.keys\|keyboard\|pointer\|onClick\|onPointer\|rightClick\|context" src/scenes/GameScene.js | head -40
```

- [ ] Create `src/systems/InputController.js`:
```javascript
/**
 * InputController — handles all keyboard and pointer input.
 * GameScene calls this._input.update() each frame.
 */
export default class InputController {
  constructor(scene) {
    this.scene = scene;

    // Set up keyboard bindings
    this.cursors = scene.input.keyboard.createCursorKeys();
    this.keys = scene.input.keyboard.addKeys({ /* existing key mappings */ });

    // Set up pointer handlers
    scene.input.on('pointerdown', this._onPointerDown, this);
    scene.input.on('pointerup', this._onPointerUp, this);
  }

  update() {
    // Move polling logic here from GameScene.update()
  }

  _onPointerDown(pointer) {
    // Move from GameScene
  }

  destroy() {
    this.scene.input.off('pointerdown', this._onPointerDown, this);
    this.scene.input.off('pointerup', this._onPointerUp, this);
  }
}
```
Move all input event handlers and polling logic from `GameScene` into this class.

- [ ] In `GameScene.create()`:
```javascript
import InputController from '../systems/InputController.js';
this._input = new InputController(this);
```

- [ ] In `GameScene.update()`:
```javascript
this._input.update();
```

- [ ] Manual check: WASD/arrow key movement works, clicking selects entities, right-click context menu works.

- [ ] Commit:
```bash
git add src/systems/InputController.js src/scenes/GameScene.js
git commit -m "refactor: extract InputController from GameScene"
```

---

### Task 4: Extract MovementController

**Files:**
- Create: `src/systems/MovementController.js`
- Modify: `src/scenes/GameScene.js`

- [ ] Find movement/physics logic in `GameScene`:
```bash
grep -n "velocity\|setVelocity\|overlap\|collider\|portal\|pickup\|physics\.add" src/scenes/GameScene.js | head -40
```

- [ ] Create `src/systems/MovementController.js`:
```javascript
/**
 * MovementController — player movement prediction, collision, pickups, portals.
 */
export default class MovementController {
  constructor(scene, player, entities) {
    this.scene = scene;
    this.player = player;
    this.entities = entities;

    this._setupCollision();
    this._setupPickupDetection();
  }

  update(input) {
    // Move player velocity application and clamping here
  }

  _setupCollision() {
    // Move collision setup (player vs walls, player vs mine walls)
  }

  _setupPickupDetection() {
    // Move overlap with ground items
  }

  _checkPortals() {
    // Move portal position check
  }
}
```

- [ ] Wire in `GameScene.create()` after player is created:
```javascript
import MovementController from '../systems/MovementController.js';
this._movement = new MovementController(this, this.player, this.entities);
```

- [ ] Call in `GameScene.update()`:
```javascript
this._movement.update(this._input);
```

- [ ] Manual check: player moves, collides with walls, picks up items, enters portals.

- [ ] Commit:
```bash
git add src/systems/MovementController.js src/scenes/GameScene.js
git commit -m "refactor: extract MovementController from GameScene"
```

---

### Task 5: Extract MapManager

**Files:**
- Create: `src/systems/MapManager.js`
- Modify: `src/scenes/GameScene.js`

- [ ] Find map loading methods in `GameScene`:
```bash
grep -n "def.*_loadMap\|_changeMap\|_applyMapBounds\|TilemapBuilder\|_tileImages\|spawnPoints" src/scenes/GameScene.js | head -30
grep -n "_loadMap\|_changeMap\|_applyMapBounds\|TilemapBuilder\|_tileImages\|spawnPoints" src/scenes/GameScene.js | head -30
```

- [ ] Create `src/systems/MapManager.js`:
```javascript
/**
 * MapManager — map loading, bounds, tilemap building, tile images.
 */
import TilemapBuilder from './TilemapBuilder.js';

export default class MapManager {
  constructor(scene) {
    this.scene = scene;
    this._tileImages = [];
    this._spawnPoints = {};
  }

  async loadMap(mapKey) {
    // Move _loadMap logic here
  }

  async changeMap(mapKey, spawnPoint) {
    // Move _changeMap logic here
  }

  applyMapBounds(mapWidth, mapHeight) {
    // Move _applyMapBounds (camera + physics bounds) here
  }
}
```

- [ ] Before wiring, check if `GameScene.create()` is already `async`:
```bash
grep -n "async create\|create()" src/scenes/GameScene.js | head -5
```
  **If `create()` is NOT async:** Phaser 3 calls `create()` synchronously and does not await it — making it async silently swallows errors. Use a callback pattern instead:
```javascript
// Safe approach if create() is not already async:
import MapManager from '../systems/MapManager.js';
this._mapManager = new MapManager(this);
this._mapManager.loadMap(this.initialMap).catch(err => console.error('Map load failed:', err));
```
  **If `create()` IS already async:** `await` works fine:
```javascript
import MapManager from '../systems/MapManager.js';
this._mapManager = new MapManager(this);
await this._mapManager.loadMap(this.initialMap);
```

- [ ] Manual check: map loads, camera bounds correct, tiles render, changing maps works.

- [ ] Commit:
```bash
git add src/systems/MapManager.js src/scenes/GameScene.js
git commit -m "refactor: extract MapManager from GameScene"
```

---

### Task 6: Clean up GameScene.js

- [ ] Check line count: `wc -l src/scenes/GameScene.js`

- [ ] GameScene should now contain only:
  - `preload()` — asset loading
  - `create()` — instantiate and wire controllers
  - `update()` — delegate to controllers
  - WebSocket message routing (`on('message', ...)` handlers)

- [ ] Remove any dead code, unused variables, leftover commented blocks.

- [ ] Final line count — must be under 600:
```bash
wc -l src/scenes/GameScene.js
```

- [ ] Full manual playtest: game loads, movement, combat, NPC interaction, resource gathering, map transitions all work.

- [ ] Commit:
```bash
git add src/scenes/GameScene.js
git commit -m "refactor: GameScene.js cleaned up — under 600 lines"
```
