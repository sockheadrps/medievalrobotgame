import Phaser from 'phaser';
import { TILE_SIZE, worldToTile } from '../constants.js';

/**
 * InputController — handles all keyboard and pointer input for GameScene.
 * GameScene calls this._input.update() each frame.
 */
export default class InputController {
  constructor(scene) {
    this.scene = scene;

    // Scroll-wheel zoom
    scene._zoomLevel = 1;
    scene.input.mouse?.disableContextMenu();
    scene.input.on('wheel', (_pointer, _gos, _dx, dy) => {
      if (scene.chatBox?.isOpen()) return; // don't zoom while typing
      const step = 0.1;
      scene._zoomLevel += dy < 0 ? step : -step;
      scene._zoomLevel = Phaser.Math.Clamp(scene._zoomLevel, 1, 3);
      scene.cameras.main.setZoom(scene._zoomLevel);
    });

    // NPC double-click selection
    scene.input.on('pointerdown', (ptr) => {
      if (ptr._fgHandled) {
        ptr._fgHandled = false;
        return;
      }
      if (scene._hotbarPickerSlot != null) scene._closeHotbarPicker();
      if (scene._isPointerOverContextMenu(ptr)) return;
      // Check if click is inside building context menu
      if (scene._buildingContextBounds) {
        const b = scene._buildingContextBounds;
        if (ptr.x >= b.x && ptr.x <= b.x + b.width && ptr.y >= b.y && ptr.y <= b.y + b.height) return;
        scene._closeBuildingContextMenu();
      }
      if (!scene._isPointerInWorldViewport(ptr)) {
        if (ptr.rightButtonDown() || ptr.button === 2) scene._closeContextMenu();
        return;
      }
      const isRightClick = ptr.rightButtonDown() || ptr.button === 2;
      const npc = scene._findNpcAtPointer(ptr);
      const remoteEntity = !npc ? scene._findRemoteEntityAtPointer(ptr) : null;

      if (npc) {
        scene._handleOwnNPCPointerDown(npc, ptr);
        return;
      }

      if (remoteEntity && isRightClick) {
        scene._selectRemote(remoteEntity);
        scene._openContextMenu(remoteEntity, ptr);
        return;
      }

      if (remoteEntity && scene._armedAction === 'attack' && !isRightClick) {
        ptr._fgHandled = true;
        if (scene._isAttackableEntity(remoteEntity)) scene._executeAttack(remoteEntity);
        // Stay in attack mode so player can keep clicking to attack
        return;
      }

      if (scene._armedAction === 'plant_seed' && !isRightClick) {
        const worldX = ptr.worldX;
        const worldY = ptr.worldY;
        scene._conn?.send({ type: 'plant_seed', x: worldX, y: worldY });
        // Keep armed so player can keep clicking multiple soil tiles
        return;
      }

      // Right-click on dummy or ki target — delete it
      if (isRightClick) {
        const worldX = ptr.worldX;
        const worldY = ptr.worldY;
        const clickRange = TILE_SIZE * 0.8;

        // Check dummies
        for (const dummy of (scene.entities.dummies ?? [])) {
          if (dummy.isDead?.()) continue;
          const d = Phaser.Math.Distance.Between(worldX, worldY, dummy.x, dummy.y);
          if (d < clickRange && dummy._serverId) {
            scene._conn?.send({ type: 'delete_dummy', dummy_id: dummy._serverId });
            scene._closeContextMenu();
            return;
          }
        }

        // Check ki targets
        for (const [ktid, ktSprite] of Object.entries(scene._kiTargetSprites || {})) {
          const d = Phaser.Math.Distance.Between(worldX, worldY, ktSprite.x, ktSprite.y);
          if (d < clickRange) {
            scene._conn?.send({ type: 'delete_ki_target', target_id: ktid });
            scene._closeContextMenu();
            return;
          }
        }

        scene._closeContextMenu();
        return;
      }

      // Mine tile click (left-click on cave_01 when not on an NPC/entity)
      if (scene._currentMap === 'cave_01' && scene._mineRenderer.isActive && !isRightClick) {
        const worldX = ptr.worldX;
        const worldY = ptr.worldY;
        const { col, row } = worldToTile(worldX, worldY);
        if (scene._mineRenderer.getTileKey(col, row)) {
          scene._conn?.send({ type: 'mine_tile', col, row });
          return;
        }
      }

      scene._closeContextMenu();
      if (scene._armedAction) {
        scene._disarmActionMode();
      }
    });

    // Enter key — open chat
    scene.input.keyboard.on('keydown', (event) => {
      if (scene._namingNPC || scene._escMenuOpen || scene._playerKnockedOut) return;
      if (event.key === 'Enter' && !scene.chatBox.isOpen()) {
        if (scene._getChatTarget()) scene.chatBox.open();
      }
    });

    // Tab key — cycle through nearby targets.
    // Priority: own NPCs by distance, then remote players/NPCs by distance.
    scene.input.keyboard.on('keydown-TAB', (event) => {
      event.preventDefault();
      if (scene.chatBox?.isOpen() || scene._namingNPC || scene._escMenuOpen || scene._playerKnockedOut) return;
      const cycle = scene._buildTabCycleList();
      if (cycle.length === 0) return;

      const current = scene._focusedRemote || scene.selectedNPC || null;
      const curIdx = current ? cycle.findIndex(entry => entry.entity === current) : -1;
      const next = cycle[(curIdx + 1 + cycle.length) % cycle.length];
      if (!next) return;

      if (next.kind === 'own_npc') scene._selectNPC(next.entity);
      else scene._selectRemote(next.entity);
    });

    // B key — build NPC (client-side, NPCs stay local)
    scene.input.keyboard.on('keydown-B', () => {
      if (scene.chatBox?.isOpen() || scene._namingNPC || scene._escMenuOpen || scene._playerKnockedOut) return;
      scene._tryBuildNPC();
    });

    // T key — build training dummy (server-side)
    scene.input.keyboard.on('keydown-T', () => {
      if (scene.chatBox?.isOpen() || scene._namingNPC || scene._escMenuOpen || scene._playerKnockedOut) return;
      scene._tryBuildDummy();
    });

    // G key — drop carried entity
    scene.input.keyboard.on('keydown-G', () => {
      if (scene.chatBox?.isOpen() || scene._namingNPC) return;
      if (scene.player?._carrying) {
        scene._conn?.send({ type: 'drop_carried' });
      }
    });

    // Q key — admin menu
    scene.input.keyboard.on('keydown-Q', () => {
      if (scene.chatBox?.isOpen() || scene._namingNPC || scene._escMenuOpen) return;
      scene._toggleAdmin();
    });
    scene.input.keyboard.on('keydown-LEFT', () => {
      if (!scene._adminOpen) return;
      scene._adminPage = Math.max(1, (scene._adminPage || 1) - 1);
      scene._renderAdminPanel();
    });
    scene.input.keyboard.on('keydown-RIGHT', () => {
      if (!scene._adminOpen) return;
      scene._adminPage = Math.min(3, (scene._adminPage || 1) + 1);
      scene._renderAdminPanel();
    });

    // Number keys — hotbar actions (1-6)
    scene.input.keyboard.on('keydown', (event) => {
      if (scene.chatBox?.isOpen() || scene._namingNPC || scene._escMenuOpen || scene._inventoryOpen || scene._playerKnockedOut) return;
      const slot = parseInt(event.key, 10);
      if (slot >= 1 && slot <= scene._hotbar?.length) {
        scene._useHotbarSlot(slot - 1);
      }
    });

    // I key — toggle inventory
    scene.input.keyboard.on('keydown-I', () => {
      if (scene.chatBox?.isOpen() || scene._namingNPC || scene._escMenuOpen || scene._playerKnockedOut) return;
      scene._toggleInventory();
    });

    // Space bar — fire ki blast
    scene.input.keyboard.on('keydown-SPACE', (event) => {
      if (scene.chatBox?.isOpen() || scene._namingNPC || scene._escMenuOpen || scene._inventoryOpen || scene._charMenuOpen || scene._playerKnockedOut) return;
      event.preventDefault();
      scene._fireKiBlast();
    });

    // C key — toggle character menu
    scene.input.keyboard.on('keydown-C', () => {
      if (scene.chatBox?.isOpen() || scene._namingNPC || scene._escMenuOpen || scene._inventoryOpen || scene._playerKnockedOut) return;
      scene._toggleCharMenu();
    });

    // Escape key — toggle pause/menu
    scene.input.keyboard.on('keydown-ESC', () => {
      if (scene.chatBox?.isOpen() || scene._namingNPC) return;
      if (scene._storageOpen) { scene._closeStorageUI(); return; }
      if (scene._charMenuOpen) { scene._closeCharMenu(); return; }
      if (scene._inventoryOpen) { scene._closeInventory(); return; }
      if (scene._contextMenuEls) { scene._closeContextMenu(); return; }
      if (scene._buildingContextEls) { scene._closeBuildingContextMenu(); return; }
      if (scene._armedAction) { scene._disarmActionMode(); return; }
      if (scene.selectedNPC || scene._focusedRemote) { scene._clearSelection(); return; }
      scene._toggleEscMenu();
    });

    // E key — interact with nearby crate
    scene.input.keyboard.on('keydown-E', () => {
      if (scene.chatBox?.isOpen() || scene._namingNPC || scene._playerDead) return;

      // If storage panel is open, close it
      if (scene._storageOpen) { scene._closeStorageUI(); return; }

      const px = scene.player.x, py = scene.player.y;

      // Check crates
      for (const crate of scene._crates) {
        if (crate.updateProximity(px, py)) {
          scene._openCrateUI(crate);
          return;
        }
      }
    });
  }

  update() {
    // Movement input polling is handled by MovementController.update(),
    // which GameScene calls each frame. InputController only wires up
    // discrete event listeners (keyboard/pointer); it has no per-frame
    // polling work of its own.
  }

  destroy() {
    // Phaser cleans up scene.input listeners automatically when the scene shuts
    // down; no manual teardown is required.
  }
}
