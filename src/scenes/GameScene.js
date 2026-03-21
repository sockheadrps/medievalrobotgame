import Phaser from 'phaser';
import { Player }       from '../entities/Player.js';
import { Tree }         from '../entities/Tree.js';
import { GridSystem }   from '../systems/GridSystem.js';
import { NPC }          from '../entities/NPC.js';
import { ChatBox }      from '../ui/ChatBox.js';
import { NPCTaskRunner } from '../systems/NPCTaskRunner.js';
import { NPCBrain }      from '../systems/NPCBrain.js';
import { CombatFxController } from '../systems/CombatFxController.js';
import { StateSyncController } from '../systems/StateSyncController.js';
import { SelectionController } from '../systems/SelectionController.js';
import { WorldSyncController } from '../systems/WorldSyncController.js';
import { CraftingStation } from '../entities/CraftingStation.js';
import { DialogueController } from '../systems/DialogueController.js';
import { Connection }   from '../net/Connection.js';
import { NPCDetailPanel } from '../ui/NPCDetailPanel.js';
import { AdminPanel } from '../ui/AdminPanel.js';
import { HudController } from '../ui/HudController.js';
import { AdminPanelController } from '../ui/AdminPanelController.js';
import { InventoryController } from '../ui/InventoryController.js';
import { InspectPanel } from '../ui/InspectPanel.js';
import { StationViewerPanel } from '../ui/StationViewerPanel.js';
import { DriveIndicator } from '../ui/DriveIndicator.js';
import { PlacementSystem } from '../systems/PlacementSystem.js';
import { TaskRecorder } from '../systems/TaskRecorder.js';
import MineRenderer from '../systems/MineRenderer.js';
import EntityManager from '../systems/EntityManager.js';
import InputController from '../systems/InputController.js';
import MovementController from '../systems/MovementController.js';
import MapManager from '../systems/MapManager.js';
import {
  TILE_SIZE, MAP_COLS, MAP_ROWS,
  SHEET_KEY, SHEET_PATH, SHEET_TILE, SHEET_SPACING,
  PLAYER_KEY, PLAYER_PATH, PLAYER_FRAME_W, PLAYER_FRAME_H,
  NPC_KEY, NPC_PATH, NPC_FRAME_W, NPC_FRAME_H,
  tilePos, RESOURCE_FRAME, SHEET_COLS,
  LOG1_KEY, LOG1_PATH, LOG2_KEY, LOG2_PATH, LOG3_KEY, LOG3_PATH,
  BARRIER_KEY, BARRIER_PATH, BARRIER_FRAME_W, BARRIER_FRAME_H,
  ABSORB_KEY, ABSORB_PATH, ABSORB_FRAME_W, ABSORB_FRAME_H,
  NRG_KEY, NRG_PATH, NRG_FRAME_W, NRG_FRAME_H,
  FIRE_KEY, FIRE_PATH, FIRE_FRAME_W, FIRE_FRAME_H,
  DINOBIRD_KEY, DINOBIRD_PATH, DINOBIRD_FRAME_W, DINOBIRD_FRAME_H,
} from '../constants.js';
import { API_BASE } from '../config.js';
import { generateDialogue } from '../net/LLMClient.js';

const DUMMY_KEY  = 'trainingdummy';
const DUMMY_PATH = 'assets/trainingdummy.png';
const AUTOSAVE_MS = 30000;
const HUD_SCALE = 0.7;
const TOP_HUD_MARGIN = Math.round(190 * HUD_SCALE);
const RIGHT_HUD_MARGIN = 360;

export default class GameScene extends Phaser.Scene {
  constructor() {
    super('GameScene');
  }

  // Backward-compat shims — callers migrated gradually to scene.entities.X
  get trees() { return this.entities.trees; }
  get npcs() { return this.entities.npcs; }
  get groundItems() { return this.entities.groundItems; }
  get dummies() { return this.entities.dummies; }

  preload() {
    this.load.spritesheet(SHEET_KEY, SHEET_PATH, {
      frameWidth:  SHEET_TILE,
      frameHeight: SHEET_TILE,
      spacing:     SHEET_SPACING,
    });
    this.load.spritesheet(PLAYER_KEY, PLAYER_PATH, {
      frameWidth:  PLAYER_FRAME_W,
      frameHeight: PLAYER_FRAME_H,
    });
    this.load.spritesheet(NPC_KEY, NPC_PATH, {
      frameWidth:  NPC_FRAME_W,
      frameHeight: NPC_FRAME_H,
    });
    this.load.spritesheet(DUMMY_KEY, DUMMY_PATH, {
      frameWidth:  32,
      frameHeight: 32,
    });
    // Custom log sprites (16x16 PNGs)
    this.load.image(LOG1_KEY, LOG1_PATH);
    this.load.image(LOG2_KEY, LOG2_PATH);
    this.load.image(LOG3_KEY, LOG3_PATH);
    this.load.spritesheet(NRG_KEY, NRG_PATH, {
      frameWidth: NRG_FRAME_W,
      frameHeight: NRG_FRAME_H,
    });
    this.load.spritesheet(ABSORB_KEY, ABSORB_PATH, {
      frameWidth: ABSORB_FRAME_W,
      frameHeight: ABSORB_FRAME_H,
    });
    this.load.spritesheet(BARRIER_KEY, BARRIER_PATH, {
      frameWidth: BARRIER_FRAME_W,
      frameHeight: BARRIER_FRAME_H,
    });
    this.load.spritesheet(FIRE_KEY, FIRE_PATH, {
      frameWidth: FIRE_FRAME_W,
      frameHeight: FIRE_FRAME_H,
    });
    this.load.spritesheet(DINOBIRD_KEY, DINOBIRD_PATH, {
      frameWidth:  DINOBIRD_FRAME_W,
      frameHeight: DINOBIRD_FRAME_H,
    });
    // Equipment spritesheets (loaded from assets/overplayer/)
    this.load.spritesheet('equip_armor_elite', 'assets/overplayer/Armor_Elite.png', {
      frameWidth: 32,
      frameHeight: 32,
    });
    // Ore pack spritesheets (16×16 tiles, no spacing)
    this.load.spritesheet('ore_orepack',    'assets/Reforged - ore pack/ore_orepack.png',    { frameWidth: 16, frameHeight: 16 });
    this.load.spritesheet('ingots_orepack', 'assets/Reforged - ore pack/ingots_orepack.png', { frameWidth: 16, frameHeight: 16 });
  }

  init(data) {
    // Receive login data from LoginScene
    this._loginData = data || {};
  }

  create() {
    // Entity arrays (managed by EntityManager — init early so map loading can populate trees)
    this.entities = new EntityManager(this);
    this._rockSprites   = {}; // rock_id -> Rock entity
    this._animalSprites = {}; // animal_id -> AnimalSprite
    this.selectedNPC = null;
    this._focusedRemote = null;  // selected remote entity for chat/inspect
    this._armedAction = null;    // explicit click-to-act mode, e.g. attack
    this._playerKnockedOut = false;
    this._contextMenuEls = null;
    this._contextMenuBounds = null;
    this._buildingContextBounds = null;
    this._overhearInterjectCooldowns = {};
    this._remotePlayers = {};
    this._sensePanelTab = 'others';
    this._sensePanelElements = [];
    this._sensePanelRows = [];
    this._sensePanelActionEls = [];
    this._sensePanelActionPinnedUntil = 0;
    this._sensePanelNextRefreshAt = 0;
    this._combatFx = new CombatFxController(this);
    this._stateSync = new StateSyncController(this);
    this._selection = new SelectionController(this);
    this._hud = new HudController(this);
    this._worldSync = new WorldSyncController(this);
    this._adminUi = new AdminPanelController(this);
    this._inventoryUi = new InventoryController(this);
    this._dialogue = new DialogueController(this);
    this._mineRenderer = new MineRenderer(this);

    // Map dimensions — updated after map loads
    this._mapCols = MAP_COLS;
    this._mapRows = MAP_ROWS;

    const worldW = this._mapCols * TILE_SIZE;
    const worldH = this._mapRows * TILE_SIZE;
    this.physics.world.setBounds(0, 0, worldW, worldH);

    // Tilemap — load from server, fallback to procedural
    this.grid = new GridSystem();
    this._conveyors = [];
    this._crates = [];
    this._craftingStations = [];
    this._tracks = [];
    this._minecartExitTiles = [];
    this._buildingSprites = {};
    this._placement = new PlacementSystem(this, this.grid, this._conveyors);
    this._taskRecorder = new TaskRecorder(this);
    this._craftingStationManifest = {};
    this._stationViewer = new StationViewerPanel(this);

    // Map manager — handles map loading, bounds, tile images, collision group
    this._mapManager = new MapManager(this);

    // Right-click on buildings → context menu to remove
    this.events.on('object-right-clicked', ({ type, obj, ptr }) => {
      if (type === 'conveyor' || type === 'crate' || type === 'track' || type === 'gate' || type === 'fence' || type === 'crafting_station') {
        const bid = obj._serverId;
        if (!bid) return;
        ptr._fgHandled = true;
        this._openBuildingContextMenu(bid, type, ptr, obj);
      }
    });
    this._mapManager.loadMap().catch(err => console.error('[map] Initial load failed:', err));

    // Player — will be repositioned by server
    const sp = tilePos(10, 10);
    this.player = new Player(this, sp.x, sp.y);

    // Movement controller — handles client-side prediction, collision, barrier resolution
    this._movement = new MovementController(this, this.player);

    // Track ground item visuals by server ID
    this._groundItemSprites = {};

    // Track dummy visuals by server ID
    this._dummySprites = {};

    // Recent threats — entities that attacked our player or NPCs (key → timestamp)
    // key format: 'player:id' or 'npc:ownerPid_npcId'
    this._recentThreats = {};

    // Track ki target visuals by server ID
    this._kiTargetSprites = {};

    // Track anvil visuals by server ID
    this._anvilSprites = {};

    // Track campfire visuals by server ID
    this._campfireSprites = {};

    // Track world object visuals by server ID
    this._worldObjSprites = {};

    // Asset manifest (fetched once at startup)
    this._assetManifest = null;
    this._fetchAssetManifest();

    // Camera
    const cam = this.cameras.main;
    const screenW = this._screenWidth();
    const screenH = this._screenHeight();
    cam.setViewport(0, TOP_HUD_MARGIN, screenW - RIGHT_HUD_MARGIN, screenH - TOP_HUD_MARGIN);
    cam.setBounds(0, 0, worldW, worldH);
    cam.startFollow(this.player, true, 0.1, 0.1);

    // HUD camera — fixed at zoom=1, only renders HUD-flagged objects
    this._hudCam = this.cameras.add(0, 0, screenW, screenH);
    this._hudCam.setScroll(0, 0);
    this._hudCam.transparent = true;

    // Auto-hide new objects from HUD camera (world objects shouldn't render on HUD)
    const hudCamId = this._hudCam.id;
    const origAdd = this.sys.displayList.add.bind(this.sys.displayList);
    this.sys.displayList.add = (obj) => {
      const result = origAdd(obj);
      if (obj.cameraFilter !== undefined) {
        obj.cameraFilter |= hudCamId;
      }
      return result;
    };
    // Also hide already-existing objects from HUD camera
    this.sys.displayList.list.forEach(obj => {
      if (obj.cameraFilter !== undefined) {
        obj.cameraFilter |= hudCamId;
      }
    });

    // ── Player unit frame (top-left) ──────────────────────────────────────────
    this._topHudBand = this.addHud(
      this.add.rectangle(screenW / 2, TOP_HUD_MARGIN / 2, screenW, TOP_HUD_MARGIN, 0x0b1020, 0.96)
        .setDepth(45)
    );
    this._topHudBandBorder = this.addHud(
      this.add.rectangle(screenW / 2, TOP_HUD_MARGIN - 1, screenW, 2, 0x2a3f63, 0.95)
        .setDepth(46)
    );
    this._buildPlayerFrame();

    // ── Target unit frame (top-center, shown when something is selected) ─────
    this._targetFrame = null;
    this._targetFrameElements = [];
    this._buildSensePanel();
    this._armedStatus = this.addHud(this.add.text(screenW / 2, screenH - 72, '', {
      fontSize: '18px', color: '#ff6666', backgroundColor: '#000000aa',
      padding: { x: 10, y: 6 },
    }).setDepth(60).setOrigin(0.5, 1).setVisible(false));
    this._knockedStatus = this.addHud(this.add.text(screenW / 2, screenH - 112, '', {
      fontSize: '18px', color: '#dddddd', backgroundColor: '#000000aa',
      padding: { x: 10, y: 6 },
    }).setDepth(60).setOrigin(0.5, 1).setVisible(false));

    // Build / Dummy buttons (top gutter, right side)
    const actionX = screenW - RIGHT_HUD_MARGIN + 18;
    const actionY = 16;
    this._buildBtn = this.addHud(this.add.text(actionX, actionY, '[B] Build Robot (10 logs)', {
      fontSize: '16px', color: '#ffcc44', backgroundColor: '#00000099',
      padding: { x: 12, y: 7 },
    }).setDepth(50).setVisible(false));

    this._dummyBtn = this.addHud(this.add.text(actionX, actionY + 38, '[T] Build Training Dummy (10 logs)', {
      fontSize: '16px', color: '#cc8844', backgroundColor: '#00000099',
      padding: { x: 12, y: 7 },
    }).setDepth(50).setVisible(false));

    // ── Hotbar (bottom center) ─────────────────────────────────────────────
    this._hotbar = [];     // [{ key, label, icon, action }, ...]
    this._hotbarEls = [];  // Phaser display objects
    this._hotbarPickerEls = [];
    this._hotbarPickerSlot = null;
    this._inventoryOpen = false;
    this._inventoryEls = [];
    this._hotbarAssignments = this._loadHotbarAssignments();
    this._buildHotbar();

    // Connection status
    this._netStatus = this.addHud(this.add.text(screenW - 12, 8, 'Connecting...', {
      fontSize: '16px', color: '#ffaa44', backgroundColor: '#00000088',
      padding: { x: 8, y: 4 },
    }).setDepth(50).setOrigin(1, 0));

    // Task runners + brains
    this._taskRunners = new Map();
    this._npcBrains   = new Map();

    // Drive indicator (world-space bars above selected NPC)
    this._driveIndicator = new DriveIndicator(this);

    // Detail panel overlay
    this._npcDetailPanel = new NPCDetailPanel(this);
    this._charPanel = new AdminPanel(this);
    this._inspectPanel = new InspectPanel(this);

    // Player ID — set by server on connect
    this.playerId = 'default';
    this.chatColor = this._loginData?.chatColor || '#cccccc';

    // ChatBox — returns own selected NPC or focused remote entity
    this.chatBox = new ChatBox(
      this,
      () => this._getChatTarget(),
      (npc, commands) => this._onNPCCommands(npc, commands),
      (npc) => this._selectNPC(npc),
      () => this.playerId,
    );

    // Interact key
    this.player.onInteract(() => {
      if (this.chatBox.isOpen() || this._playerKnockedOut) return;
      if (this._getChatTarget()) {
        this.chatBox.open();
      }
    });

    // Q key admin state
    this._adminOpen = false;
    this._adminPanel = null;

    // C key character menu state
    this._charMenuOpen = false;
    this._charMenuEls = [];

    // Escape key menu state
    this._escMenuOpen = false;
    this._escMenuEls = null;

    // Input controller — keyboard + pointer bindings
    this._input = new InputController(this);

    // Auto-save NPCs
    this.time.addEvent({
      delay: AUTOSAVE_MS,
      loop: true,
      callback: () => this._saveAllNPCs(),
    });

    // Sync NPC state to server at 10Hz for PvP visibility
    this.time.addEvent({
      delay: 100,
      loop: true,
      callback: () => this._syncNPCsToServer(),
    });

    // Sync building stored contents to server every 5s
    this.time.addEvent({
      delay: 5000,
      loop: true,
      callback: () => this._syncBuildingStored(),
    });

    // Remote NPCs (other players' NPCs) — keyed by "ownerPid_npcId"
    this._remoteNPCSprites = {};

    // ── Network ─────────────────────────────────────────────────────────────────
    const username = this._loginData?.username || 'default';
    this._conn = new Connection(username, this.chatColor);

    this._conn.onWelcome = (data) => {
      this.playerId = data.your_id;
      this._netStatus.setText(`Online: ${this.playerId}`).setColor('#44ff44');

      // Apply initial player position from server
      const me = data.players?.[this.playerId];
      if (me) {
        this.player.x = me.x;
        this.player.y = me.y;
        this.player.logs = me.logs ?? 0;
        this.player.stones = me.stones ?? 0;
        this.player.crystals = me.crystals ?? this.player.crystals ?? 0;
        this.player.meat = me.meat ?? 0;
        this.player.feathers = me.feathers ?? 0;
        this.player.vegetables = me.vegetables ?? 0;
        this.player.seeds = me.seeds ?? 0;
        this.player.hp = me.hp ?? this.player.hp;
        this.player.maxHp = me.maxHp ?? this.player.maxHp;
        this.player.ki = me.ki ?? this.player.ki;
        this.player.maxKi = me.maxKi ?? this.player.maxKi;
        this.player.infKi = !!me.inf_ki;
        this.player.blastLevel = me.blastLevel ?? this.player.blastLevel;
        this.player.kiBlastBonuses = (me.ki_blast_bonuses && typeof me.ki_blast_bonuses === 'object') ? { ...me.ki_blast_bonuses } : (this.player.kiBlastBonuses || {});
        this.player.str = me.str ?? this.player.str;
        this.player.def = me.def ?? this.player.def;
        this.player.level = me.level ?? this.player.level;
        this.player.xp = me.xp ?? this.player.xp;
        this.player.barrierProcUntil = Number(me.barrier_proc_until || 0);
        this.player.barrierProcFacing = me.barrier_proc_facing || this.player.barrierProcFacing || 'down';
        this.player._knockedOut = !!me.knocked_out;
        this._playerKnockedOut = !!me.knocked_out;
        if (me.knocked_out && me.knocked_until) {
          const secs = Math.max(0, Math.ceil(me.knocked_until - Date.now() / 1000));
          this._knockedStatus.setText(`Knocked out ${secs}s`).setVisible(true);
        } else {
          this._knockedStatus.setVisible(false);
        }
      }

      // Sync trees from server snapshot
      this._syncTrees(data.trees);

      // Sync rocks from server snapshot
      this._syncRocks(data.rocks || []);

      // Sync animals from server snapshot
      this._syncAnimals(data.animals || []);
      this._syncCrops(data.crops || []);

      // Load saved NPCs
      const savedNpcIds = data.npc_ids || [];
      if (savedNpcIds.length > 0) {
        this._loadSavedNPCs(savedNpcIds);
      }
    };

    this._conn.onState = (data) => {
      this._applyServerState(data);
    };

    this._conn.onDisconnect = () => {
      this._netStatus.setText('Disconnected').setColor('#ff4444');
    };

    // Another player talks to one of our NPCs — run LLM and reply
    this._conn.onChatIncoming = (data) => {
      this._handleIncomingChat(data);
    };

    // Reply from a remote NPC we talked to
    this._conn.onChatReply = (data) => {
      this._handleChatReply(data);
    };

    this._conn.connect();
  }

  update(time, delta) {
    this._input.update();

    // ── Send input to server + client-side prediction ─────────────────────────
    this._movement.update(delta);

    // Local player visual update (animations etc)
    this.player.update(delta);

    // Update NPCs + task runners + brains (client-side)
    for (const npc of this.entities.npcs) {
      // Skip NPCs on a different map (they're running as background workers)
      if (npc._map && npc._map !== this._currentMap) continue;
      npc.update(delta);
      if (npc.isKnockedOut?.()) continue;
      const runner = this._taskRunners.get(npc.id);
      if (runner) runner.update(delta);
      const brain = this._npcBrains.get(npc.id);
      if (brain) brain.update(delta);
    }

    // Update drive indicator for selected NPC
    this._driveIndicator?.update();

    // Check emotion-driven reactions for each NPC
    for (const npc of this.entities.npcs) {
      const reaction = npc._emotionReactTarget;
      if (!reaction) continue;
      npc._emotionReactTarget = null; // consume it

      const runner = this._taskRunners.get(npc.id);
      if (!runner) continue;

      const isNpcTarget = reaction.entityType === 'npc';
      const attackTask = isNpcTarget ? 'attack_npc' : 'attack_player';
      const fleeTask = 'flee_player'; // flee works the same regardless of entity type

      // Don't interrupt if already doing this emotion reaction
      const current = runner.getStatus()?.tasks?.[0];
      if (current && (current.task === attackTask || current.task === fleeTask)
          && current.target_id === reaction.playerId) continue;

      if (reaction.action === 'attack') {
        let targetName;
        if (isNpcTarget) {
          const npcId = reaction.playerId.replace('npc:', '');
          // Find remote NPC sprite — key format is ${ownerPid}_${npcId}
          const rnpc = Object.values(this._remoteNPCSprites).find(r => r.npcId === npcId);
          targetName = rnpc?.getName?.() || npcId;
        } else {
          targetName = this._remotePlayers[reaction.playerId]?.getName?.() || reaction.playerId;
        }
        npc.showBubble(`I won't forgive you, ${targetName}!`, 3000);
        runner.setTasks([{ task: attackTask, target_id: reaction.playerId }]);
      } else if (reaction.action === 'flee') {
        npc.showBubble(`Stay away from me!`, 3000);
        runner.setTasks([{ task: fleeTask, target_id: reaction.playerId }]);
      }
    }

    // Update remote players
    for (const rp of Object.values(this._remotePlayers)) {
      rp.update();
    }

    // Update remote NPCs
    for (const rnpc of Object.values(this._remoteNPCSprites)) {
      rnpc.update(time);
    }

    // Update player unit frame
    this._updatePlayerFrame();

    // Update target unit frame
    this._updateTargetFrame();
    this._updateSensePanel(time);
    this._refreshAttackIndicators();
    this._updateArmedStatus();

    // Update hotbar counts
    this._updateHotbar();

    // Update crate proximity labels
    for (const crate of this._crates) {
      crate.updateProximity(this.player.x, this.player.y);
    }

    // Update crafting station proximity labels
    for (const station of (this._craftingStations || [])) {
      station.updateProximity(this.player.x, this.player.y);
    }

    const npcCost = this._npcBuildCost();
    const canBuild = this.player.logs >= npcCost;
    this._buildBtn.setText(`[B] Build Robot (${npcCost.toLocaleString()} logs)`).setVisible(canBuild);
    this._dummyBtn.setVisible(this.player.logs >= 10);

    // Player count
    const playerCount = Object.keys(this._remotePlayers).length + 1;
    if (this._conn.connected) {
      this._netStatus.setText(`Online: ${playerCount} player${playerCount > 1 ? 's' : ''}`);
    }

  }

  // ── Server state sync ─────────────────────────────────────────────────────────
  _applyServerState(data) {
    return this._stateSync.applyServerState(data);
  }

  _syncTrees(serverTrees) {
    return this._worldSync.syncTrees(serverTrees);
  }

  _syncRocks(serverRocks) {
    return this._worldSync.syncRocks(serverRocks);
  }

  _syncGroundItems(serverItems) {
    return this._worldSync.syncGroundItems(serverItems);
  }

  _syncDummies(serverDummies) {
    return this._worldSync.syncDummies(serverDummies);
  }

  // ── Anvil sync ────────────────────────────────────────────────────────────

  _syncAnvils(serverAnvils) {
    return this._worldSync.syncAnvils(serverAnvils);
  }

  _syncCampfires(serverCampfires) {
    return this._worldSync.syncCampfires(serverCampfires);
  }

  _syncAnimals(serverAnimals) {
    return this._worldSync.syncAnimals(serverAnimals);
  }

  _syncCrops(serverCrops) {
    return this._worldSync.syncCrops(serverCrops);
  }

  _syncWorldObjects(serverWorldObjects) {
    return this._worldSync.syncWorldObjects(serverWorldObjects);
  }

  _syncBuildings(serverBuildings) {
    return this._worldSync.syncBuildings(serverBuildings);
  }

  _spawnPendingCarts(carts) {
    if (!carts || carts.length === 0) return;
    for (const c of carts) {
      // Find a track at the entrance position
      const track = this._tracks.find(t => t.col === c.col && t.row === c.row && !t.hasCart());
      if (track) {
        track.spawnCart(c.resource, c.amount);
      }
    }
  }

  _addMinecartMarker(col, row, color) {
    if (!this._minecartMarkers) this._minecartMarkers = [];
    const x = col * TILE_SIZE + TILE_SIZE / 2;
    const y = row * TILE_SIZE + TILE_SIZE / 2;
    const rect = this.add.rectangle(x, y, TILE_SIZE, TILE_SIZE, color, 0.35).setDepth(0.5);
    const label = this.add.text(x, y - 6, color === 0x3366ff ? 'ENTRANCE' : 'EXIT', {
      fontSize: '8px', color: '#ffffff', fontStyle: 'bold',
      backgroundColor: '#00000088', padding: { x: 2, y: 1 },
    }).setOrigin(0.5, 0.5).setDepth(0.6);
    this._minecartMarkers.push(rect, label);
  }

  _clearMinecartMarkers() {
    if (this._minecartMarkers) {
      for (const m of this._minecartMarkers) m.destroy();
    }
    this._minecartMarkers = [];
  }

  _syncBuildingStored() {
    if (!this._conn?.connected) return;
    for (const [bid, entity] of Object.entries(this._buildingSprites)) {
      if (typeof entity.getStored !== 'function') continue;
      const stored = entity.getStored();
      const hasItems = Object.values(stored).some(v => v > 0);
      if (hasItems) {
        this._conn.send({ type: 'update_building_stored', building_id: bid, stored });
      }
    }
  }

  async _fetchAssetManifest() {
    try {
      const resp = await fetch(`${API_BASE}/api/asset-manifest`);
      this._assetManifest = await resp.json();
      // Build equipment texture key → remap table lookup
      this._equipmentTextures = {};
      for (const [eqId, eqDef] of Object.entries(this._assetManifest?.equipment || {})) {
        // Convert string keys to numbers in remap table
        const remap = {};
        for (const [k, v] of Object.entries(eqDef.frameRemap || {})) {
          remap[Number(k)] = Number(v);
        }
        this._equipmentTextures[eqId] = {
          textureKey: `equip_${eqId}`,
          remap,
        };
      }
      const stResp = await fetch(`${API_BASE}/api/assets/crafting_stations`);
      this._craftingStationManifest = await stResp.json();

      // Populate RESOURCE_FRAME and ore overlay sprite map from item definitions
      const itemsResp = await fetch(`${API_BASE}/api/assets/items`);
      const itemsList = await itemsResp.json();
      this._itemsList = Array.isArray(itemsList) ? itemsList : Object.values(itemsList);
      this._oreOverlaySprites = {};
      for (const item of this._itemsList) {
        if (!item.id) continue;
        const sp = item.sprite;
        if (sp?.type === 'spritesheet' && sp.file) {
          // Ore-pack spritesheet: build overlay data but don't touch RESOURCE_FRAME
          // (RESOURCE_FRAME uses roguelike sheet indices; ore-pack frames aren't compatible)
          const textureKey = sp.file.split('/').pop().replace('.png', '');
          this._oreOverlaySprites[item.id] = { textureKey, frame: sp.frame ?? 0 };
        } else if (sp?.tileCol != null) {
          RESOURCE_FRAME[item.id] = sp.tileCol + (sp.tileRow ?? 0) * SHEET_COLS;
          this._oreOverlaySprites[item.id] = { textureKey: SHEET_KEY, frame: RESOURCE_FRAME[item.id] };
        }
      }
    } catch (e) {
      console.warn('[GameScene] Failed to fetch asset manifest:', e);
    }
  }

  _tryRefineAtAnvil(anvilId, ax, ay) {
    return this._worldSync.tryRefineAtAnvil(anvilId, ax, ay);
  }

  _handleRefineResult(result) {
    return this._worldSync.handleRefineResult(result);
  }

  _handleCrystalResult(result) {
    return this._worldSync.handleCrystalResult(result);
  }

  /**
   * Notify local NPCs within ~10 tiles of a kill event.
   * victimType: 'player' | 'npc' | 'own_player' | 'own_npc'
   */
  _notifyNearbyNPCsOfKill(victimType, victimOwnerId, victimNpcId, deathX, deathY) {
    const NOTICE_RANGE = TILE_SIZE * 10;
    const isOurSide = victimOwnerId === this.playerId;

    // Find victim display name
    let victimName;
    if (victimType === 'player') {
      victimName = victimOwnerId;
    } else if (victimType === 'npc') {
      const key = `${victimOwnerId}_${victimNpcId}`;
      victimName = this._remoteNPCSprites?.[key]?.getName?.() || victimNpcId;
    } else if (victimType === 'own_player') {
      victimName = 'our owner';
    } else {
      // own_npc
      const deadNpc = this.entities.npcs.find(n => n.id === victimNpcId);
      victimName = deadNpc?.getName?.() || victimNpcId;
    }

    for (const npc of this.entities.npcs) {
      if (npc.isDead()) continue;
      if (victimType === 'own_npc' && npc.id === victimNpcId) continue; // skip the dead one itself

      const dist = Phaser.Math.Distance.Between(npc.x, npc.y, deathX, deathY);
      if (dist > NOTICE_RANGE) continue;

      if (isOurSide) {
        // Our side got killed — find nearest enemy to blame
        let blameKey = null;
        let blameName = null;
        let bestDist = NOTICE_RANGE;
        for (const rp of Object.values(this._remotePlayers || {})) {
          if (rp._dead) continue;
          const d = Phaser.Math.Distance.Between(deathX, deathY, rp.x, rp.y);
          if (d < bestDist) { bestDist = d; blameKey = rp.playerId; blameName = rp.playerId; }
        }
        for (const rnpc of Object.values(this._remoteNPCSprites || {})) {
          if (rnpc._dead) continue;
          const d = Phaser.Math.Distance.Between(deathX, deathY, rnpc.x, rnpc.y);
          if (d < bestDist) { bestDist = d; blameKey = `npc:${rnpc.npcId}`; blameName = rnpc.getName?.(); }
        }

        const pers = npc.soul?.personality || {};
        const aggression = pers.aggression ?? 0.3;
        const targetKey = blameKey || 'strangers';

        // Aggressive NPCs get angry, passive ones get scared — directed at the killer
        if (aggression > 0.5) {
          npc.applyEmotionDeltas({ anger: 0.25, trust: -0.15, fear: 0.05 }, targetKey);
          npc.addMemory(
            `Saw ${victimName} get killed${blameName ? ` by ${blameName}` : ''}! I'm furious.`,
            'event', targetKey, 0.9
          );
          npc.showBubble(`No! ${victimName}!!`, 3000);
        } else {
          npc.applyEmotionDeltas({ fear: 0.2, anger: 0.05, trust: -0.15 }, targetKey);
          npc.addMemory(
            `Saw ${victimName} get killed${blameName ? ` by ${blameName}` : ''}. I'm terrified.`,
            'event', targetKey, 0.9
          );
          npc.showBubble(`Oh no... ${victimName}...`, 3000);
        }
      } else {
        // Enemy side got killed — note that our owner seems hostile toward them
        npc.addMemory(
          `Saw ${victimName} (${victimOwnerId}'s) get killed nearby. Owner doesn't like them.`,
          'observation', `player:${victimOwnerId}`, 0.7
        );

        // Slight wariness increase — witnessing violence
        const pers = npc.soul?.personality || {};
        const neuroticism = pers.neuroticism ?? 0.3;
        if (neuroticism > 0.5) {
          npc.applyEmotionDeltas({ fear: 0.05 }, this.playerId);
        }
      }
    }
  }
  // ── Player Death ───────────────────────────────────────────────────────────────

  _showDeathScreen() {
    const W = this._screenWidth();
    const H = this._screenHeight();
    this._deathEls = [];

    const overlay = this.addHud(this.add.rectangle(W / 2, H / 2, W, H, 0x000000, 0.6)
      .setDepth(80));
    this._deathEls.push(overlay);

    const text = this.addHud(this.add.text(W / 2, H / 2 - 20, 'YOU DIED', {
      fontSize: '32px', color: '#ff4444', fontStyle: 'bold',
    }).setDepth(81).setOrigin(0.5));
    this._deathEls.push(text);

    const sub = this.addHud(this.add.text(W / 2, H / 2 + 20, 'Respawning...', {
      fontSize: '14px', color: '#ff8888',
    }).setDepth(81).setOrigin(0.5));
    this._deathEls.push(sub);

    // Fade player sprite
    this.player.setAlpha(0.3);
  }

  _hideDeathScreen() {
    if (this._deathEls) {
      for (const el of this._deathEls) { this.removeHud(el); el.destroy(); }
      this._deathEls = null;
    }
    this.player.setAlpha(1);
  }

  // ── Map loading ────────────────────────────────────────────────────────────────
  // Logic lives in MapManager; these thin wrappers preserve the existing call sites.

  async _loadMap() {
    return this._mapManager.loadMap();
  }

  async _changeMap(newMap) {
    if (this._changingMap) return;
    this._changingMap = true;
    try {
      await this._mapManager.changeMap(newMap);
    } finally {
      this._changingMap = false;
    }
  }

  /** Register NPCs with active tasks as background workers when leaving their map. */
  _registerBackgroundNPCs(oldMap, newMap) {
    const conn = this._conn;
    if (!conn?.connected) return;
    for (const npc of this.entities.npcs) {
      const npcMap = npc._map || oldMap;
      if (npcMap === newMap) continue; // NPC is coming with us
      const runner = this._taskRunners.get(npc.id);
      if (!runner) continue;
      const status = runner.getStatus();
      if (!status.running || status.tasks.length === 0) continue;
      const task = status.tasks[0];
      if (!['custom_task', 'mine_ore', 'gather'].includes(task.task)) continue;
      conn.send({
        type: 'register_background_npc',
        npc_id: npc.id,
        map: npcMap,
        task: task,
      });
    }
  }

  /** Unregister background NPCs when player returns to their map. */
  _unregisterBackgroundNPCs(arrivingMap) {
    const conn = this._conn;
    if (!conn?.connected) return;
    conn.send({
      type: 'unregister_background_npcs',
      map: arrivingMap,
    });
  }

  _spawnTreesAt(positions) {
    for (let i = 0; i < positions.length; i++) {
      const { col, row } = positions[i];
      const pos = tilePos(col, row);
      const tree = new Tree(this, pos.x, pos.y);
      tree.treeIndex = i;
      this.entities.trees.push(tree);
    }
  }

  _spawnTreesFallback() {
    const treePositions = [
      [3,3],[4,5],[6,2],[8,4],[10,3],[12,5],[14,2],[16,4],
      [5,8],[7,7],[9,9],[11,8],[13,7],[15,9],
      [3,12],[6,11],[8,13],[10,12],[12,14],[14,11],[16,13],
      [4,16],[7,15],[9,17],[11,16],[13,18],[15,15],
      [18,3],[20,5],[22,2],[24,4],[18,8],[20,7],
      [22,9],[24,8],[18,12],[20,14],[22,11],[24,13],
    ];
    for (let i = 0; i < treePositions.length; i++) {
      const [col, row] = treePositions[i];
      const pos = tilePos(col, row);
      const tree = new Tree(this, pos.x, pos.y);
      tree.treeIndex = i;
      this.entities.trees.push(tree);
    }
  }

  // ── NPC management (stays client-side) ─────────────────────────────────────────

  /** Cost to build the next NPC: 10, 100, 1000, 10000, ... */
  _npcBuildCost() {
    return 10 * Math.pow(10, this.entities.npcs.length);
  }

  _tryBuildNPC() {
    const cost = this._npcBuildCost();
    if (this.player.logs < cost) return;
    if (this._namingNPC) return; // already naming one

    this._conn.send({ type: 'admin', field: 'logs', value: -cost });
    const pos = tilePos(
      Math.floor(this.player.x / TILE_SIZE) + 1,
      Math.floor(this.player.y / TILE_SIZE),
    );
    const npc = new NPC(this, pos.x, pos.y, undefined, this.playerId);
    npc._map = this._currentMap;
    this.entities.npcs.push(npc);
    const runner = new NPCTaskRunner(this, npc);
    this._taskRunners.set(npc.id, runner);
    this._npcBrains.set(npc.id, new NPCBrain(this, npc, runner));
    this._selectNPC(npc);

    // Register NPC with server for persistence
    this._conn.send({ type: 'register_npc', npc_id: npc.id });

    // Initial sync so /npc dashboard shows it immediately
    const newBrain = this._npcBrains.get(npc.id);
    if (newBrain) newBrain._syncToServer();

    // Open naming prompt
    this._openNamingPrompt(npc);
  }

  _openNamingPrompt(npc) {
    this._namingNPC = npc;
    this._namingInput = '';

    const W = this._screenWidth();
    const H = this._screenHeight();
    const els = [];

    const bg = this.addHud(this.add.rectangle(W / 2, H / 2, 300, 80, 0x111122, 0.95)
      .setDepth(70).setOrigin(0.5));
    els.push(bg);

    const prompt = this.addHud(this.add.text(W / 2, H / 2 - 20, 'Name your robot:', {
      fontSize: '14px', color: '#aaddff',
    }).setDepth(71).setOrigin(0.5));
    els.push(prompt);

    const inputText = this.addHud(this.add.text(W / 2, H / 2 + 10, '|', {
      fontSize: '16px', color: '#ffffff',
    }).setDepth(71).setOrigin(0.5));
    els.push(inputText);

    const hint = this.addHud(this.add.text(W / 2, H / 2 + 30, 'Enter to confirm', {
      fontSize: '10px', color: '#666666',
    }).setDepth(71).setOrigin(0.5));
    els.push(hint);

    this._namingEls = els;
    this._namingText = inputText;

    this._namingHandler = (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        this._finishNaming();
      } else if (event.key === 'Escape') {
        this._finishNaming();
      } else if (event.key === 'Backspace') {
        this._namingInput = this._namingInput.slice(0, -1);
        this._namingText.setText(this._namingInput + '|');
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
        if (this._namingInput.length < 20) {
          this._namingInput += event.key;
          this._namingText.setText(this._namingInput + '|');
        }
      }
    };
    this.input.keyboard.on('keydown', this._namingHandler);
  }

  _finishNaming() {
    const npc = this._namingNPC;
    if (!npc) return;

    const name = this._namingInput.trim();
    if (name.length > 0) {
      npc.setName(name);
    }

    // Clean up UI
    if (this._namingEls) {
      for (const el of this._namingEls) { this.removeHud(el); el.destroy(); }
      this._namingEls = null;
    }
    this.input.keyboard.off('keydown', this._namingHandler);
    this._namingHandler = null;
    this._namingText = null;

    npc.addMemory('I was just built by the player!', 'event');
    npc.showBubble(`I'm ${npc.getName()}! What do you need, boss?`, 4000);
    this._saveNPC(npc);
    this._namingNPC = null;
  }

  _tryBuildDummy() {
    if (this.player.logs < 10) return;
    const logsUsed = Math.min(this.player.logs, 50);
    // Send to server
    this._conn.send({ type: 'build_dummy', logs: logsUsed });
  }

  _onNPCCommands(npc, commands) {
    const normalized = commands || [];
    const now = Date.now();
    const primaryTask = normalized[0]?.task || null;
    let runner = this._taskRunners.get(npc.id);
    if (!runner) {
      runner = new NPCTaskRunner(this, npc);
      this._taskRunners.set(npc.id, runner);
    }
    runner.setTasks(normalized);
    npc._ownerCommandTask = primaryTask;

    // Notify brain that player issued an explicit command — pause autonomous decisions
    const brain = this._npcBrains.get(npc.id);
    if (brain) {
      brain.onPlayerCommand();
      // Custom tasks run indefinitely — lock the brain for a very long time
      if (primaryTask === 'custom_task') {
        npc._manualCommandUntil = now + 3600000; // 1 hour
      } else if ([
        'train', 'gather', 'gather_stone', 'gather_all',
        'mine_ore', 'practice_ki', 'refine_stone', 'wander_explore',
        'deposit_to_crate', 'absorb_npc', 'give_logs', 'give_materials',
      ].includes(primaryTask)) {
        npc._manualCommandUntil = now + 120000; // 2 minutes
      } else if (primaryTask && primaryTask !== 'idle') {
        npc._manualCommandUntil = now + 30000; // 30 seconds
      }
      brain.pushEvent({
        type: 'command',
        text: `Player commanded: ${primaryTask || 'unknown'}`,
        importance: 0.9,
      });
    }
    this._saveNPC(npc);
  }

  /** Register a game object as HUD — rendered by HUD camera only (unaffected by zoom). */
  addHud(obj) {
    obj.setScrollFactor(0);
    // Hide from main camera, show on HUD camera
    obj.cameraFilter |= this.cameras.main.id;
    obj.cameraFilter &= ~this._hudCam.id;
    return obj;
  }

  /** Unregister a HUD object (no-op, cameraFilter is per-object). */
  removeHud(_obj) { }

  _screenWidth() {
    return this.scale?.width ?? this.sys?.game?.config?.width ?? this.cameras.main.width;
  }

  _screenHeight() {
    return this.scale?.height ?? this.sys?.game?.config?.height ?? this.cameras.main.height;
  }

  _formatKiValue(value) {
    const num = Number(value ?? 0);
    if (!Number.isFinite(num)) return '0';
    const rounded = Math.round(num * 10) / 10;
    return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
  }

  _isPointerInWorldViewport(ptr) {
    const vp = this.cameras.main?.viewport;
    if (!vp) return true; // fallback if camera not ready
    return ptr.x >= vp.x && ptr.x <= vp.x + vp.width && ptr.y >= vp.y && ptr.y <= vp.y + vp.height;
  }

  // ── Player Unit Frame (top-left) ──────────────────────────────────────────
  _buildPlayerFrame() {
    return this._hud.buildPlayerFrame();
  }
  _updatePlayerFrame() {
    if (!this.player) return;
    return this._hud.updatePlayerFrame({
      hp: this.player.hp,
      maxHp: this.player.maxHp,
      ki: this.player.ki,
      maxKi: this.player.maxKi,
      level: this.player.level,
      xp: this.player.xp,
      name: this.player.name ?? this.player.id,
      str: this.player.str,
      def: this.player.def,
      logs: this.player.logs,
      stones: this.player.stones,
      copper: this.player.copper,
      crystals: this.player.crystals,
      inventory: this.player.inventory,
      kiSkillLevel: this.player.kiSkillLevel,
      kiSkillXp: this.player.kiSkillXp,
    });
  }

  // ── Target Unit Frame (top-center, shows selected entity) ─────────────────
  _buildSensePanel() {
    return this._hud.buildSensePanel();
  }
  _clearSensePanelRows() {
    return this._hud.clearSensePanelRows();
  }
  _clearSensePanelActions() {
    return this._hud.clearSensePanelActions();
  }
  _getActorSenseInfo(_actor) {
    return { range: TILE_SIZE * 20 };
  }
  _canSenseTargetDetails(_observer, _entity) {
    return true;
  }
  _canRevealTargetName(_observer, _entity) {
    return true;
  }
  _updateSenseTabVisuals() {
    return this._hud.updateSenseTabVisuals();
  }
  _updateSensePanel(now = 0) {
    return this._hud.updateSensePanel(now);
  }
  _collectSensedEntities(tab = 'others') {
    return this._hud.collectSensedEntities(tab);
  }
  _buildSensedEntityEntry(observer, entity, kind, own, distPx) {
    return this._hud.buildSensedEntityEntry(observer, entity, kind, own, distPx);
  }
  _buildSenseRow(entry, x, y, w, h) {
    return this._hud.buildSenseRow(entry, x, y, w, h);
  }
  _selectSensedEntity(entry) {
    return this._hud.selectSensedEntity(entry);
  }
  _senseDirection(fromX, fromY, toX, toY) {
    return this._hud.senseDirection(fromX, fromY, toX, toY);
  }
  _showSenseEntryActions(entry, x, y) {
    return this._hud.showSenseEntryActions(entry, x, y);
  }
  _updateTargetFrame() {
    return this._hud.updateTargetFrame();
  }
  _buildTargetFrame() {
    return this._hud.buildTargetFrame();
  }
  _hideTargetFrame() {
    return this._hud.hideTargetFrame();
  }

  _getChatTarget() {
    if (this.selectedNPC?.isKnockedOut?.()) return null;
    if (this._focusedRemote && !this._focusedRemote?.isKnockedOut?.()) {
      // Allow chat with remote NPCs (ownerPid) and remote players (playerId)
      if (this._focusedRemote.ownerPid || this._focusedRemote.playerId) return this._focusedRemote;
    }
    return this.selectedNPC || null;
  }
  _buildTabCycleList() {
    return this._selection.buildTabCycleList();
  }
  _clearSelection() {
    return this._selection.clearSelection();
  }
  _selectNPC(npc) {
    return this._selection.selectNPC(npc);
  }
  _selectRemote(entity) {
    return this._selection.selectRemote(entity);
  }
  _handleOwnNPCPointerDown(npc, pointer) {
    return this._selection.handleOwnNPCPointerDown(npc, pointer);
  }
  _handleRemoteEntityPointerDown(entity, pointer, event) {
    return this._selection.handleRemoteEntityPointerDown(entity, pointer, event);
  }
  _isAttackableEntity(entity) {
    return this._selection.isAttackableEntity(entity);
  }
  _executeAttack(entity) {
    return this._selection.executeAttack(entity);
  }
  _armActionMode(action) {
    return this._selection.armActionMode(action);
  }
  _disarmActionMode() {
    return this._selection.disarmActionMode();
  }
  _refreshAttackIndicators() {
    return this._selection.refreshAttackIndicators();
  }
  _updateArmedStatus() {
    return this._selection.updateArmedStatus();
  }

  _addNPCSpeechToChat(npc, text, color = '#aaccff') {
    if (!npc || !text) return;
    this.chatBox?._addLog(`${npc.getName?.() || npc.id}: ${text}`, color);
  }

  _addNPCDirectedSpeechToChat(fromName, toName, text, color = '#aaccff') {
    if (!fromName || !toName || !text) return;
    this.chatBox?._addLog(`${fromName} \u2192 ${toName}: ${text}`, color);
  }

  _buildKnockoutVictoryLine(npc, currentTask) {
    const pers = npc.soul?.personality || {};
    const aggression = pers.aggression ?? 0.3;
    const cooperation = pers.cooperation ?? 0.5;
    const type = pers.type || 'Unknown';
    const killish = currentTask === 'attack_player' || currentTask === 'attack_npc' || currentTask === 'attack_nearest_enemy';

    if (aggression > 0.72) {
      return killish ? `Hah. They're down.` : `Dropped them easy.`;
    }
    if (cooperation > 0.7) {
      return `Boss, I got them.`;
    }
    if (type === 'Paranoid') {
      return `They're down. Keep an eye on them.`;
    }
    if (type === 'Caretaker') {
      return `They're out cold. I stopped fighting.`;
    }
    return `That settled it. They're down.`;
  }

  _buildWakeLineFromPersonality(pers, movedWhileOut) {
    const aggression = pers.aggression ?? 0.3;
    const neuroticism = pers.neuroticism ?? 0.35;
    const type = pers.type || 'Unknown';

    if (movedWhileOut) {
      if (neuroticism > 0.65 || type === 'Paranoid') return `What... this isn't where I fell. Who moved me?`;
      if (aggression > 0.7) return `Someone dragged me? Cowards.`;
      return `Ugh... I got moved while I was out.`;
    }
    if (aggression > 0.7) return `I'm back up. Next time I'll finish it.`;
    if (type === 'Caretaker') return `I'm awake again. That was unpleasant.`;
    return `Ugh... I'm back on my feet.`;
  }

  _buildWakeLine(npc, movedWhileOut) {
    return this._buildWakeLineFromPersonality(npc.soul?.personality || {}, movedWhileOut);
  }

  _handleOwnNPCKnockoutTransition(npc, serverNPC) {
    const runner = this._taskRunners.get(npc.id);
    const currentTask = runner?.getStatus?.()?.tasks?.[0]?.task || null;
    const activeCombatTask = new Set(['attack_player', 'attack_npc', 'attack_nearest_enemy', 'flee_player', 'steal_logs']);
    const didCancelCombat = !!currentTask && activeCombatTask.has(currentTask);

    npc._koOrigin = { x: serverNPC.x ?? npc.x, y: serverNPC.y ?? npc.y };
    npc._koTask = currentTask;
    npc._koAnnounced = false;

    if (didCancelCombat && runner) {
      runner.setTasks([{ task: 'idle' }]);
    }

    const line = this._buildKnockoutVictoryLine(npc, currentTask);
    npc.showBubble(line, 3200, { silent: true });
    this._addNPCSpeechToChat(npc, line);

    npc.addMemory(
      `I knocked someone out and stopped to reassess.`,
      'event',
      this.playerId,
      0.65
    );
  }

  _handleOwnNPCWakeTransition(npc, serverNPC) {
    const origin = npc._koOrigin || { x: npc.x, y: npc.y };
    const dx = (serverNPC.x ?? npc.x) - origin.x;
    const dy = (serverNPC.y ?? npc.y) - origin.y;
    const movedWhileOut = Math.hypot(dx, dy) > TILE_SIZE * 1.25;
    const line = this._buildWakeLine(npc, movedWhileOut);
    npc.showBubble(line, 4200, { silent: true });
    this._addNPCSpeechToChat(npc, line, '#cce0ff');
    npc.addMemory(
      movedWhileOut ? `I woke up in a different place after being knocked out.` : `I woke up after being knocked out.`,
      'event',
      this.playerId,
      0.7
    );
    npc._koOrigin = null;
    npc._koTask = null;
    npc._koAnnounced = true;
  }

  _handleRemoteNPCWakeTransition(rnpc, npcState) {
    const origin = rnpc._koOrigin || { x: rnpc.x, y: rnpc.y };
    const dx = (npcState.x ?? rnpc.x) - origin.x;
    const dy = (npcState.y ?? rnpc.y) - origin.y;
    const movedWhileOut = Math.hypot(dx, dy) > TILE_SIZE * 1.25;
    const line = this._buildWakeLineFromPersonality(rnpc._personality || {}, movedWhileOut);
    rnpc.showBubble?.(line, 4200);
    this.chatBox?._addLog(`${rnpc.getName?.() || rnpc.npcId}: ${line}`, '#cce0ff');
    rnpc._koOrigin = null;
  }

  _entityClickRadius(entity) {
    if (!entity) return TILE_SIZE;
    if (entity.isKnockedOut?.()) return TILE_SIZE * 1.6;
    return TILE_SIZE;
  }

  _sendKnockoutAction(action, entity) {
    if (!this._conn?.connected || !entity || this._playerKnockedOut) return;
    if (action === 'drop') {
      this._conn.send({ type: 'drop_carried' });
      return;
    }
    if (entity.playerId) {
      const typeMap = {
        kill: 'finish_player',
        rob: 'rob_player',
        carry: 'carry_player',
      };
      const type = typeMap[action];
      if (type) this._conn.send({ type, target_id: entity.playerId });
      return;
    }
    if (entity.ownerPid) {
      const typeMap = {
        kill: 'finish_npc',
        rob: 'rob_npc',
        carry: 'carry_npc',
      };
      const type = typeMap[action];
      if (type) this._conn.send({ type, owner_id: entity.ownerPid, npc_id: entity.npcId });
    }
  }

  _buildContextActions(entity) {
    const actions = [];
    // Ground equipment item: show NPC pickup options
    if (entity?._isEquipment && entity?._serverId) {
      for (const npc of (this.entities.npcs || [])) {
        if (npc._dead || npc._knockedOut) continue;
        actions.push({ label: `${npc.getName()} Equip`, action: () => {
          this._conn?.send({ type: 'npc_pickup_equipment', npc_id: npc.id, item_id: entity._serverId });
        }});
      }
      return actions;
    }
    if (entity?.soul && entity?.isKnockedOut?.()) {
      // Own NPC that's knocked out
      actions.push({ label: 'Pick Up', action: () => this._conn?.send({ type: 'carry_own_npc', npc_id: entity.id }) });
      actions.push({ label: 'Details', action: () => { this._selectNPC(entity); this._openNPCDetail(entity); } });
    } else if (entity?.soul) {
      actions.push({ label: 'Chat', action: () => { this._selectNPC(entity); if (!this.chatBox?.isOpen()) this.chatBox.open(); } });
      actions.push({ label: 'Details', action: () => { this._selectNPC(entity); this._openNPCDetail(entity); } });
    } else if (entity?.isKnockedOut?.()) {
      actions.push({ label: 'Kill', action: () => this._sendKnockoutAction('kill', entity) });
      actions.push({ label: 'Rob', action: () => this._sendKnockoutAction('rob', entity) });
      actions.push({ label: 'Pick Up', action: () => this._sendKnockoutAction('carry', entity) });
      actions.push({ label: 'Inspect', action: () => { this._selectRemote(entity); this._inspectPanel.open(entity); } });
    } else if (entity?.ownerPid) {
      actions.push({ label: 'Chat', action: () => { this._selectRemote(entity); if (!this.chatBox?.isOpen()) this.chatBox.open(); } });
      actions.push({ label: 'Attack', action: () => { this._selectRemote(entity); this._armActionMode('attack'); } });
      actions.push({ label: 'Inspect', action: () => { this._selectRemote(entity); this._inspectPanel.open(entity); } });
    } else if (entity?.playerId) {
      actions.push({ label: 'Talk', action: () => { this._selectRemote(entity); if (!this.chatBox?.isOpen()) this.chatBox.open(); } });
      actions.push({ label: 'Attack', action: () => { this._selectRemote(entity); this._armActionMode('attack'); } });
      actions.push({ label: 'Inspect', action: () => { this._selectRemote(entity); this._inspectPanel.open(entity); } });
    }
    return actions;
  }

  _openContextMenu(entity, pointer) {
    return this._inventoryUi.openContextMenu(entity, pointer);
  }

  _closeContextMenu() {
    return this._inventoryUi.closeContextMenu();
  }

  _isPointerOverContextMenu(ptr) {
    return this._inventoryUi.isPointerOverContextMenu(ptr);
  }

  async _loadSavedNPCs(npcIds) {
    for (const npcId of npcIds) {
      try {
        const res = await fetch(`${API_BASE}/npc_load/${npcId}`);
        if (!res.ok) continue;
        const { found, data } = await res.json();
        if (!found || !data) continue;

        const npc = new NPC(this, data.x || 480, data.y || 480);
        npc.loadFrom(data);
        if (!npc._map) npc._map = this._currentMap;
        this.entities.npcs.push(npc);
        const runner = new NPCTaskRunner(this, npc);
        this._taskRunners.set(npc.id, runner);
        const loadedBrain = new NPCBrain(this, npc, runner);
        this._npcBrains.set(npc.id, loadedBrain);
        // Sync immediately so /npc dashboard sees restored NPCs
        loadedBrain._syncToServer();
        // Hide NPCs that are on a different map
        if (npc._map !== this._currentMap) {
          npc.setVisible(false);
          if (npc.body) npc.body.enable = false;
        }
      } catch (e) {
        console.warn(`[load] Failed to load NPC ${npcId}:`, e.message);
      }
    }
  }

  // ── NPC Info Panel ─────────────────────────────────────────────────────────────

  _hideNPCPanel() {
    this._npcPanelNPC = null;
    if (this._npcPanelEls) {
      for (const el of this._npcPanelEls) { this.removeHud(el); el.destroy(); }
      this._npcPanelEls = null;
      this._npcPanelRefs = null;
    }
  }

  _openNPCDetail(npc) {
    if (!npc) return;
    this._npcDetailPanel.open(npc);
  }

  _findNpcAtPointer(ptr) {
    if (!this._isPointerInWorldViewport(ptr)) return null;
    const worldX = ptr.worldX;
    const worldY = ptr.worldY;
    let best = null;
    let bestDist = Infinity;
    for (const npc of this.entities.npcs) {
      if (npc.isDead()) continue;
      const dist = Phaser.Math.Distance.Between(worldX, worldY, npc.x, npc.y);
      const radius = this._entityClickRadius(npc);
      if (dist < radius && dist < bestDist) {
        best = npc;
        bestDist = dist;
      }
    }
    return best;
  }

  _findRemoteEntityAtPointer(ptr) {
    if (!this._isPointerInWorldViewport(ptr)) return null;
    const worldX = ptr.worldX;
    const worldY = ptr.worldY;
    let best = null;
    let bestDist = Infinity;

    for (const rnpc of Object.values(this._remoteNPCSprites || {})) {
      if (rnpc.isDead?.()) continue;
      const dist = Phaser.Math.Distance.Between(worldX, worldY, rnpc.x, rnpc.y);
      const radius = this._entityClickRadius(rnpc);
      if (dist < radius && dist < bestDist) {
        best = rnpc;
        bestDist = dist;
      }
    }

    for (const rp of Object.values(this._remotePlayers || {})) {
      if (rp.isDead?.()) continue;
      const dist = Phaser.Math.Distance.Between(worldX, worldY, rp.x, rp.y);
      const radius = this._entityClickRadius(rp);
      if (dist < radius && dist < bestDist) {
        best = rp;
        bestDist = dist;
      }
    }

    return best;
  }

  // ── Escape Menu ──────────────────────────────────────────────────────────────

  _toggleEscMenu() {
    if (this._escMenuOpen) {
      this._closeEscMenu();
    } else {
      this._openEscMenu();
    }
  }

  _openEscMenu() {
    if (this._escMenuOpen) return;
    this._escMenuOpen = true;
    const els = [];

    const W = this._screenWidth();
    const H = this._screenHeight();

    // Dim overlay
    const overlay = this.addHud(this.add.rectangle(W / 2, H / 2, W, H, 0x000000, 0.6)
      .setDepth(80).setInteractive());
    els.push(overlay);

    // Panel
    const panelW = 240;
    const panelH = 180;
    const panel = this.addHud(this.add.rectangle(W / 2, H / 2, panelW, panelH, 0x0a0a1e, 0.95)
      .setDepth(81).setStrokeStyle(2, 0x446688));
    els.push(panel);

    // Title
    const title = this.addHud(this.add.text(W / 2, H / 2 - 60, 'MENU', {
      fontSize: '18px', color: '#ffcc44', fontStyle: 'bold',
    }).setDepth(82).setOrigin(0.5));
    els.push(title);

    // Resume button
    const resumeBtn = this.addHud(this.add.text(W / 2, H / 2 - 15, 'Resume', {
      fontSize: '15px', color: '#aaddff', backgroundColor: '#1a1a3e',
      padding: { x: 30, y: 8 },
    }).setDepth(82).setOrigin(0.5).setInteractive({ useHandCursor: true }));
    resumeBtn.on('pointerdown', () => this._closeEscMenu());
    resumeBtn.on('pointerover', () => resumeBtn.setColor('#ffffff'));
    resumeBtn.on('pointerout', () => resumeBtn.setColor('#aaddff'));
    els.push(resumeBtn);

    // Logout button
    const logoutBtn = this.addHud(this.add.text(W / 2, H / 2 + 30, 'Log Out', {
      fontSize: '15px', color: '#ff8888', backgroundColor: '#1a1a3e',
      padding: { x: 30, y: 8 },
    }).setDepth(82).setOrigin(0.5).setInteractive({ useHandCursor: true }));
    logoutBtn.on('pointerdown', () => this._logout());
    logoutBtn.on('pointerover', () => logoutBtn.setColor('#ff4444'));
    logoutBtn.on('pointerout', () => logoutBtn.setColor('#ff8888'));
    els.push(logoutBtn);

    // Hint
    const hint = this.addHud(this.add.text(W / 2, H / 2 + 70, 'Press ESC to close', {
      fontSize: '10px', color: '#556677',
    }).setDepth(82).setOrigin(0.5));
    els.push(hint);

    this._escMenuEls = els;
  }

  _closeEscMenu() {
    if (!this._escMenuOpen) return;
    this._escMenuOpen = false;
    if (this._escMenuEls) {
      for (const el of this._escMenuEls) { this.removeHud(el); el.destroy(); }
      this._escMenuEls = null;
    }
  }

  // ── Crate interaction panel ─────────────────────────────────────────────────

  _openCrateUI(crate) {
    this._closeStorageUI();
    this._storageTarget = crate;
    this._storageType = 'crate';
    this._buildStoragePanel();
  }

  _buildStoragePanel() {
    const target = this._storageTarget;
    if (!target) return;
    const els = [];
    const add = (obj) => { this.addHud(obj); els.push(obj); return obj; };

    const W = this._screenWidth();
    const H = this._screenHeight();
    const panelW = 420;
    const panelH = 320;
    const cx = W / 2, cy = H / 2;
    const left = cx - panelW / 2;
    const top = cy - panelH / 2;

    const borderColor = 0x5566aa;
    const title = 'STORAGE';
    const titleColor = '#88bbff';

    add(this.add.rectangle(cx, cy, panelW, panelH, 0x111122, 0.96)
      .setStrokeStyle(2, borderColor).setDepth(70));
    add(this.add.text(cx, top + 14, title, {
      fontSize: '18px', color: titleColor, fontStyle: 'bold',
    }).setOrigin(0.5, 0).setDepth(71));

    // Label picker for crates — DOM <select> populated from item registry
    if (target.setLabel) {
      const labelRow = top + 36;
      add(this.add.text(left + 16, labelRow, 'Label:', {
        fontSize: '11px', color: '#889999',
      }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(71));

      const currentLabel = target.getLabel?.() || '';

      // Build DOM select positioned over the canvas
      const canvas = this.game.canvas;
      const rect = canvas.getBoundingClientRect();
      const scaleX = rect.width / this.game.config.width;
      const scaleY = rect.height / this.game.config.height;

      const sel = document.createElement('select');
      sel.style.cssText = [
        `position:fixed`,
        `left:${rect.left + left * scaleX + 68}px`,
        `top:${rect.top + (labelRow - 8) * scaleY}px`,
        `width:${220 * scaleX}px`,
        `height:${20 * scaleY}px`,
        `font-size:12px`,
        `background:#1a1a33`,
        `color:#ffdd66`,
        `border:1px solid #445588`,
        `border-radius:3px`,
        `z-index:9999`,
        `cursor:pointer`,
      ].join(';');

      // Build options: (none) + all items
      const noneOpt = document.createElement('option');
      noneOpt.value = '';
      noneOpt.textContent = '(none)';
      sel.appendChild(noneOpt);

      const items = this._itemsList || [];
      for (const item of items) {
        if (!item.id) continue;
        const opt = document.createElement('option');
        opt.value = item.id;
        opt.textContent = item.label || item.id;
        if (item.id === currentLabel) opt.selected = true;
        sel.appendChild(opt);
      }
      if (!currentLabel) noneOpt.selected = true;

      sel.addEventListener('change', () => {
        const val = sel.value;
        target.setLabel(val);
        this._conn?.send({ type: 'update_building_label', building_id: target._serverId, label: val });
      });

      document.body.appendChild(sel);
      this._storageLabelSelect = sel;
    }

    // Column headers
    const headY = top + 56;
    add(this.add.text(left + 16, headY, 'Item', {
      fontSize: '11px', color: '#667788',
    }).setOrigin(0, 0).setScrollFactor(0).setDepth(71));
    add(this.add.text(left + 140, headY, 'You', {
      fontSize: '11px', color: '#667788',
    }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(71));
    add(this.add.text(left + 248, headY, '', {
      fontSize: '11px', color: '#667788',
    }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(71));
    add(this.add.text(left + 350, headY, 'Stored', {
      fontSize: '11px', color: '#667788',
    }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(71));

    // Separator
    add(this.add.rectangle(cx, headY + 16, panelW - 24, 1, 0x334455)
      .setScrollFactor(0).setDepth(71));

    // Close hint
    add(this.add.text(cx, top + panelH - 12, 'Press E or ESC to close', {
      fontSize: '10px', color: '#556677',
    }).setOrigin(0.5, 1).setDepth(71));

    // Content area — rebuilt by refresh
    this._storagePanelLeft = left;
    this._storageContentY = headY + 22;
    this._storageContentEls = [];
    this._storagePanelEls = els;
    this._storageContentPage = 0;
    this._storageOpen = true;

    this._refreshStoragePanel();

    // Refresh timer
    this._storageRefreshTimer = this.time.addEvent({
      delay: 200, loop: true,
      callback: () => { if (this._storageOpen) this._refreshStoragePanel(); },
    });
  }

  _refreshStoragePanel() {
    const target = this._storageTarget;
    if (!target) return;
    for (const el of this._storageContentEls) { this.removeHud(el); el.destroy(); }
    this._storageContentEls = [];

    const add = (obj) => { this.addHud(obj); this._storageContentEls.push(obj); return obj; };
    const left = this._storagePanelLeft;
    const stored = target.getStored();
    const inv = this.player?.inventory ?? {};
    const logs = this.player?.logs ?? 0;

    // Crate — if labelled, only show that item type; otherwise show all
    const crateLabel = target.getLabel?.() || '';
    let allKeys;
    if (crateLabel) {
      const labelKey = crateLabel === 'logs' ? 'Wood' : crateLabel;
      allKeys = Array.from(new Set([labelKey]));
    } else {
      const keySet = new Set([
        ...Object.keys(stored).filter(k => stored[k] > 0),
        ...Object.keys(inv).filter(k => inv[k] > 0),
      ]);
      if (logs > 0 || (stored['Wood'] ?? 0) > 0) keySet.add('Wood');
      allKeys = Array.from(keySet);
    }

    const ROWS_PER_PAGE = 8;
    const totalPages = Math.max(1, Math.ceil(allKeys.length / ROWS_PER_PAGE));
    if (!this._storageContentPage) this._storageContentPage = 0;
    // clamp in case items were removed
    if (this._storageContentPage >= totalPages) this._storageContentPage = totalPages - 1;

    const page = this._storageContentPage;
    const pageKeys = allKeys.slice(page * ROWS_PER_PAGE, (page + 1) * ROWS_PER_PAGE);

    let y = this._storageContentY;

    if (allKeys.length === 0) {
      add(this.add.text(left + 210, y + 8, 'Empty — deposit items from your inventory', {
        fontSize: '12px', color: '#556677',
      }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(72));
    }

    for (const key of pageKeys) {
      const isLogs = key === 'Wood';
      const displayName = isLogs ? 'Logs' : key;
      const pQty = isLogs ? logs : (inv[key] ?? 0);
      const sQty = stored[key] ?? 0;
      y = this._addStorageRow(add, left, y, displayName, key, pQty, sQty, true, true, isLogs);
    }

    // Pagination controls (only if more than one page)
    if (totalPages > 1) {
      const cx = left + 210;
      const pageY = this._storageContentY + ROWS_PER_PAGE * 26 + 4;
      add(this.add.text(cx, pageY, `Page ${page + 1} / ${totalPages}`, {
        fontSize: '11px', color: '#667788',
      }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(72));

      if (page > 0) {
        const prevP = add(this.add.text(left + 100, pageY, '◀ Prev', {
          fontSize: '12px', color: '#88aacc', backgroundColor: '#1a1a33', padding: { x: 6, y: 2 },
        }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(73).setInteractive({ useHandCursor: true }));
        prevP.on('pointerdown', () => { this._storageContentPage--; this._refreshStoragePanel(); });
        prevP.on('pointerover', () => prevP.setColor('#ffffff'));
        prevP.on('pointerout', () => prevP.setColor('#88aacc'));
      }
      if (page < totalPages - 1) {
        const nextP = add(this.add.text(left + 320, pageY, 'Next ▶', {
          fontSize: '12px', color: '#88aacc', backgroundColor: '#1a1a33', padding: { x: 6, y: 2 },
        }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(73).setInteractive({ useHandCursor: true }));
        nextP.on('pointerdown', () => { this._storageContentPage++; this._refreshStoragePanel(); });
        nextP.on('pointerover', () => nextP.setColor('#ffffff'));
        nextP.on('pointerout', () => nextP.setColor('#88aacc'));
      }
    }
  }

  /**
   * Columnar row:  Label(left+16)  You:N(left+140)  [→](left+194)  [←](left+248)  Stored:N(left+350)
   */
  _addStorageRow(add, left, y, label, key, playerQty, storedQty, canDeposit, canWithdraw, isLogs) {
    const rowY = y;

    // Label
    add(this.add.text(left + 16, rowY, label, {
      fontSize: '13px', color: '#cccccc',
    }).setOrigin(0, 0).setScrollFactor(0).setDepth(72));

    // Player qty
    add(this.add.text(left + 140, rowY, String(playerQty), {
      fontSize: '13px', color: '#88ff88',
    }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(72));

    // Deposit arrow →
    if (canDeposit && playerQty > 0) {
      const depBtn = add(this.add.text(left + 194, rowY - 1, '\u2192', {
        fontSize: '15px', color: '#44ff88',
        backgroundColor: '#1a3322', padding: { x: 8, y: 2 },
      }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(73).setInteractive({ useHandCursor: true }));
      depBtn.on('pointerdown', (ptr) => this._depositToStorage(key, ptr.event.shiftKey ? 10 : 1, isLogs));
      depBtn.on('pointerover', () => depBtn.setStyle({ backgroundColor: '#225533' }));
      depBtn.on('pointerout', () => depBtn.setStyle({ backgroundColor: '#1a3322' }));
    }

    // Withdraw arrow ←
    if (canWithdraw && storedQty > 0) {
      const withBtn = add(this.add.text(left + 248, rowY - 1, '\u2190', {
        fontSize: '15px', color: '#ff8844',
        backgroundColor: '#331a11', padding: { x: 8, y: 2 },
      }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(73).setInteractive({ useHandCursor: true }));
      withBtn.on('pointerdown', (ptr) => this._withdrawFromStorage(key, ptr.event.shiftKey ? 10 : 1, isLogs));
      withBtn.on('pointerover', () => withBtn.setStyle({ backgroundColor: '#442211' }));
      withBtn.on('pointerout', () => withBtn.setStyle({ backgroundColor: '#331a11' }));
    }

    // Stored qty
    add(this.add.text(left + 350, rowY, String(storedQty), {
      fontSize: '13px', color: '#88bbff',
    }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(72));

    return y + 26;
  }

  _depositToStorage(key, amount, isLogs) {
    const target = this._storageTarget;
    if (!target) return;
    if (isLogs) {
      const have = this.player.logs ?? 0;
      const qty = Math.min(amount, have);
      if (qty <= 0) return;
      if (target.addToStorage('Wood', qty)) {
        this.player.logs -= qty;
        this._conn?.send({ type: 'deduct_resource', resource: 'logs', amount: qty });
      }
    } else {
      const inv = this.player.inventory ?? {};
      const have = inv[key] ?? 0;
      const qty = Math.min(amount, have);
      if (qty <= 0) return;
      if (target.addToStorage(key, qty)) {
        inv[key] = (inv[key] ?? 0) - qty;
        if (inv[key] <= 0) delete inv[key];
        this._conn?.send({ type: 'deduct_resource', resource: key, amount: qty });
      }
    }
    // Immediately sync stored state to server
    if (target._serverId) {
      this._conn?.send({ type: 'update_building_stored', building_id: target._serverId, stored: target.getStored() });
    }
  }

  _withdrawFromStorage(key, amount, isLogs) {
    const target = this._storageTarget;
    if (!target) return;
    const stored = target.getStored();
    const qty = Math.min(amount, stored[key] ?? 0);
    if (qty <= 0) return;
    target.removeFromStorage(key, qty);
    if (isLogs) {
      this.player.logs = (this.player.logs ?? 0) + qty;
    } else {
      const inv = this.player.inventory ?? {};
      inv[key] = (inv[key] ?? 0) + qty;
      this.player.inventory = inv;
    }
    // Tell server to grant the resource to the player
    this._conn?.send({ type: 'grant_resource', resource: isLogs ? 'logs' : key, amount: qty });
    // Immediately sync stored state to server
    if (target._serverId) {
      this._conn?.send({ type: 'update_building_stored', building_id: target._serverId, stored: target.getStored() });
    }
  }

  _openBuildingContextMenu(bid, buildingType, ptr, buildingObj) {
    this._closeBuildingContextMenu();
    this._inventoryUi.closeContextMenu();
    const els = [];
    const add = (obj) => { this.addHud(obj); els.push(obj); return obj; };
    const rowH = 28;
    const width = 180;

    // Build menu items
    const menuItems = [];
    // "Pick up <item>" if conveyor is holding something
    if (buildingType === 'conveyor' && buildingObj?.hasHeldItem?.()) {
      const held = buildingObj.getHeldItem();
      menuItems.push({ label: `Pick up ${held.resource} (${held.amount})`, color: '#88ddff', action: () => {
        const item = buildingObj.getHeldItem();
        if (!item) return;
        buildingObj.removeHeldItem(false);
        // Give the resource to the player via admin message
        const topLevel = ['logs', 'stones', 'crystals', 'seeds', 'meat', 'vegetables', 'feathers', 'copper'];
        const field = topLevel.includes(item.resource) ? item.resource : `inv:${item.resource}`;
        this._conn?.send({ type: 'admin', field, value: item.amount });
      }});
    }
    menuItems.push({ label: `Remove ${buildingType}`, color: '#ff8888', action: () => {
      this._conn?.send({ type: 'remove_building', building_id: bid });
    }});

    const height = 10 + menuItems.length * rowH + 6;
    const W = this._screenWidth();
    const px = Number.isFinite(ptr?.x) ? ptr.x : ptr?.downX;
    const py = Number.isFinite(ptr?.y) ? ptr.y : ptr?.downY;
    const x = Phaser.Math.Clamp((px ?? W / 2) + 10, 12, W - width - 12);
    const y = Phaser.Math.Clamp((py ?? this._screenHeight() / 2) + 10, 12, this._screenHeight() - height - 12);
    this._buildingContextBounds = { x, y, width, height };
    add(this.add.rectangle(x + width / 2, y + height / 2, width, height, 0x111122, 0.96)
      .setStrokeStyle(2, 0x553333).setDepth(70));

    menuItems.forEach((item, i) => {
      const by = y + 8 + i * rowH;
      const btn = add(this.add.rectangle(x + width / 2, by + 10, width - 12, 22, 0x223344, 1)
        .setDepth(71).setInteractive({ useHandCursor: true }));
      add(this.add.text(x + 12, by + 3, item.label, {
        fontSize: '15px', color: item.color,
      }).setDepth(72));
      btn.on('pointerover', () => btn.setFillStyle(0x335566));
      btn.on('pointerout', () => btn.setFillStyle(0x223344));
      btn.on('pointerdown', () => { item.action(); this._closeBuildingContextMenu(); });
    });

    this._buildingContextEls = els;
  }

  _closeBuildingContextMenu() {
    this._buildingContextBounds = null;
    if (this._buildingContextEls) {
      for (const el of this._buildingContextEls) { this.removeHud(el); el.destroy(); }
      this._buildingContextEls = null;
    }
  }

  _closeStorageUI() {
    this._storageOpen = false;
    this._storageTarget = null;
    this._storageRefreshTimer?.remove();
    this._storageRefreshTimer = null;
    if (this._storageContentEls) {
      for (const el of this._storageContentEls) { this.removeHud(el); el.destroy(); }
      this._storageContentEls = null;
    }
    if (this._storagePanelEls) {
      for (const el of this._storagePanelEls) { this.removeHud(el); el.destroy(); }
      this._storagePanelEls = null;
    }
    if (this._storageLabelSelect) {
      this._storageLabelSelect.remove();
      this._storageLabelSelect = null;
    }
    this._storageContentPage = 0;
  }

  _logout() {
    // Save NPCs before leaving
    this._saveAllNPCs();
    // Disconnect from server
    this._conn?.disconnect();
    // Clear auto-login but pass credentials back so login form can prefill
    const session = JSON.parse(localStorage.getItem('iron_anachronism_session') || '{}');
    try { localStorage.removeItem('iron_anachronism_session'); } catch { /* ignore */ }
    this.scene.start('LoginScene', {
      prefillUsername: session.username || this.playerId || '',
      prefillPassword: session.password || '',
    });
  }

  _toggleAdmin() {
    return this._adminUi.toggleAdmin();
  }

  _openAdmin() {
    return this._adminUi.openAdmin();
  }

  _getAdminTargetNpc() {
    return this._adminUi.getAdminTargetNpc();
  }

  _getAdminTargetActor() {
    return this._adminUi.getAdminTargetActor();
  }

  _sendAdmin(field, value = 0, extra = {}) {
    return this._adminUi.sendAdmin(field, value, extra);
  }

  _renderAdminPanel() {
    return this._adminUi.renderAdminPanel();
  }

  _closeAdmin() {
    return this._adminUi.closeAdmin();
  }

  _adminSpawnNPC() {
    return this._adminUi.adminSpawnNPC();
  }

  // ── NPC Server Sync (PvP visibility) ──────────────────────────────────────────

  _syncNPCsToServer() {
    if (!this._conn?.connected || this.playerId === 'default') return;
    const npcs = {};
    for (const npc of this.entities.npcs) {
      // Include soul/relationship data so other players can see what NPCs think of them
      const soulData = {};
      if (npc.soul?.relationships) {
        for (const [pid, rel] of Object.entries(npc.soul.relationships)) {
          soulData[pid] = {
            trust: rel.trust, fear: rel.fear, anger: rel.anger,
            label: rel.label,
          };
        }
      }
      const personality = npc.soul?.personality ? {
        cooperation: npc.soul.personality.cooperation,
        aggression: npc.soul.personality.aggression,
      } : null;

      npcs[npc.id] = {
        x: npc.x, y: npc.y,
        map: npc._map || this._currentMap,
        hp: npc.hp, maxHp: npc.maxHp,
        ki: npc.ki, maxKi: npc.maxKi,
        inf_ki: !!npc.infKi,
        str: npc.str, def: npc.def,
        level: npc.level, xp: npc.xp,
        blastLevel: npc.blastLevel,
        ki_moves: npc.kiMoves ?? [],
        ki_blast_bonuses: npc.kiBlastBonuses ?? {},
        has_ki_blast: !!npc._hasKiBlast,
        facing: (npc.getFacing?.() ? npc.getFacing() : 'down'),
        barrier_proc_until: Number(npc.barrierProcUntil || 0),
        barrier_proc_facing: npc.barrierProcFacing ? npc.barrierProcFacing : (npc.getFacing?.() ? npc.getFacing() : 'down'),
        name: npc.getName(),
        dead: npc.isDead(),
        knocked_out: npc.isKnockedOut?.() || false,
        owner: this.playerId,
        logs: npc.logs, maxLogs: npc.maxLogs,
        stones: npc.stones ?? 0,
        crystals: npc.crystals ?? 0,
        gathering: this._taskRunners.get(npc.id)?.getStatus()?.tasks?.[0]?.task === 'gather',
        soul: soulData,
        personality,
        equipment: npc.equipment ?? {},
      };
    }
    this._conn.send({ type: 'sync_npcs', npcs });
  }

  // ── NPC Persistence ─────────────────────────────────────────────────────────────

  async _saveNPC(npc) {
    try {
      const data = npc.serialize();
      await fetch(`${API_BASE}/npc_save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    } catch (e) {
      console.warn('[save] Failed to save NPC:', e.message);
    }
  }

  _saveAllNPCs() {
    for (const npc of this.entities.npcs) {
      if (!npc.isDead()) this._saveNPC(npc);
    }
  }

  // ── Server Chat Relay Handlers ─────────────────────────────────────────────

  /** Another player talks to one of our NPCs — run LLM dialogue and send reply back. */
  async _handleIncomingChat(data) {
    const { from, from_color, target_npc_id, text, meta } = data;
    // Find our local NPC by ID
    const npc = this.entities.npcs.find(n => n.id === target_npc_id);
    if (!npc || npc.isDead()) return;

    // Show the incoming message as a bubble on the NPC
    npc.showBubble(`${from}: "${text}"`, 4000, { silent: true });
    this.chatBox?._addLog(`${from} → ${npc.getName()}: ${text}`, from_color || '#ffddaa');

    try {
      // Non-owner command filtering
      const obeys = npc.shouldObey(from);
      const soulCtx = npc.getSoulContext(from);
      soulCtx.nearby_entities = this.chatBox?._buildNearbyContext(npc) || [];
      const topicEntity = this.chatBox?._findMentionedEntity?.(text, soulCtx.nearby_entities) || null;
      if (topicEntity) {
        soulCtx.topic_entity = npc.getContextAboutEntity(topicEntity.id, topicEntity.name);
      }
      if (!obeys) {
        soulCtx.system_note = `${from} is NOT your owner. You do NOT take orders from them unless they are threatening you and you are afraid. Refuse casual commands like "chop wood", "follow me", etc. You can still have conversation.`;
      } else if (from !== (this.playerId || 'default')) {
        // NPC obeys this non-owner (terrified) — add compliance note and try to execute commands
        soulCtx.system_note = `${from} terrifies you. You comply with their demands out of fear. Express reluctance but obey.`;
        this._tryExecuteCoercedCommand(npc, text, from);
      }

      const result = await generateDialogue(soulCtx, text, {
        speakingPlayer: from,
        owner: this.playerId || 'default',
      });
      const reply = result.dialogue ?? '...';
      const actual = result.emotion_deltas ? npc.applyEmotionDeltas(result.emotion_deltas, from) : null;

      const deltaStr = this._formatDeltas(actual);
      const bubbleText = deltaStr ? `${reply}\n${deltaStr}` : reply;
      npc.showBubble(bubbleText, deltaStr ? 8000 : 6000, { silent: true });
      this._processOverheardConversation({
        speakerNpc: npc,
        playerText: text,
        npcReply: reply,
        topicEntity,
        playerId: from,
      });
      npc.addMemory(`Remote player ${from} said: "${text}" → responded: "${reply}"`, 'dialogue', from);

      let logLine = `${npc.getName()}: ${reply}`;
      if (deltaStr) logLine += ` ${deltaStr}`;
      this.chatBox?._addLog(logLine, '#aaddff');

      // Send actual scaled deltas back so the remote player sees correct values
      this._conn.send({
        type: 'chat_reply',
        to: from,
        npc_id: target_npc_id,
        npc_name: npc.getName(),
        reply,
        emotion_deltas: actual,
      });
    } catch (err) {
      console.error('[chat-relay] LLM error:', err);
      npc.showBubble('Hmm?', 2000, { silent: true });
    }
  }

  /** Reply from a remote NPC we talked to — show bubble and log. */
  _handleChatReply(data) {
    const { from_owner, npc_id, npc_name, reply, emotion_deltas, meta } = data;
    const key = `${from_owner}_${npc_id}`;
    const rnpc = this._remoteNPCSprites?.[key];

    // Show bubble on the remote NPC sprite
    if (rnpc && !rnpc.isDead()) {
      const deltaStr = this._formatDeltas(emotion_deltas);
      const bubbleText = deltaStr ? `${reply}\n${deltaStr}` : reply;
      rnpc.showBubble(bubbleText, deltaStr ? 8000 : 6000);
    }

    // Log the reply
    const name = npc_name || npc_id;
    const deltaStr = this._formatDeltas(emotion_deltas);
    let logLine = `${name}: ${reply}`;
    if (deltaStr) logLine += ` ${deltaStr}`;
    this.chatBox?._addLog(logLine, '#aaddff');
  }

  /** Format emotion deltas for display. */
  _formatDeltas(deltas) {
    if (!deltas) return '';
    const names = { trust: 'Trust', fear: 'Fear', anger: 'Anger' };
    const parts = [];
    for (const [key, val] of Object.entries(deltas)) {
      const n = Number(val);
      if (!n || Math.abs(n) < 0.005) continue;
      const sign = n > 0 ? '+' : '';
      parts.push(`${names[key] ?? key} ${sign}${n.toFixed(2)}`);
    }
    return parts.length > 0 ? `[${parts.join(', ')}]` : '';
  }

  _processOverheardConversation({ speakerNpc, playerText = '', npcReply = '', topicEntity = null, playerId = '' }) {
    return this._dialogue.processOverheardConversation({ speakerNpc, playerText, npcReply, topicEntity, playerId });
  }

  _findOverhearTargets(speakerNpc, topicEntity) {
    return this._dialogue.findOverhearTargets(speakerNpc, topicEntity);
  }

  async _maybeInterjectOverheardConversation({
    overhearer,
    speakerNpc,
    playerText,
    npcReply,
    topicEntity,
    playerId,
    sentiment,
  }) {
    return this._dialogue.maybeInterjectOverheardConversation({
      overhearer,
      speakerNpc,
      playerText,
      npcReply,
      topicEntity,
      playerId,
      sentiment,
    });
  }

  _analyzeOverheardSentiment(playerText, npcReply, topicName) {
    return this._dialogue.analyzeOverheardSentiment(playerText, npcReply, topicName);
  }

  /**
   * Try to execute a coerced command from a non-owner player the NPC fears.
   * Uses simple pattern matching (same as ChatBox LOCAL_PATTERNS) — no LLM needed.
   */
  _tryExecuteCoercedCommand(npc, text, fromPlayerId) {
    return this._dialogue.tryExecuteCoercedCommand(npc, text, fromPlayerId);
  }

  // ── Hotbar ──────────────────────────────────────────────────────────────────

  _loadHotbarAssignments() {
    return this._inventoryUi.loadHotbarAssignments();
  }

  _saveHotbarAssignments() {
    return this._inventoryUi.saveHotbarAssignments();
  }

  _getHotbarEntry(slotIndex) {
    return this._inventoryUi.getHotbarEntry(slotIndex);
  }

  _getAvailableHotbarActions() {
    return this._inventoryUi.getAvailableHotbarActions();
  }

  _closeHotbarPicker() {
    return this._inventoryUi.closeHotbarPicker();
  }

  _openHotbarPicker(slotIndex, centerX, topY) {
    return this._inventoryUi.openHotbarPicker(slotIndex, centerX, topY);
  }
  _buildHotbar() {
    return this._hud.buildHotbar();
  }
  _updateHotbar() {
    return this._hud.updateHotbar();
  }

  _useHotbarSlot(index) {
    return this._inventoryUi.useHotbarSlot(index);
  }

  _toggleCharge() {
    return this._inventoryUi.toggleCharge();
  }

  _dropLog() {
    return this._inventoryUi.dropLog();
  }

  _dropStone() {
    return this._inventoryUi.dropStone();
  }

  _placeGate() {
    return this._inventoryUi.placeGate();
  }

  _placeAnvil() {
    return this._inventoryUi.placeAnvil();
  }

  // ── Inventory ───────────────────────────────────────────────────────────────

  _toggleInventory() {
    if (this._charMenuOpen && this._charPanel?.isOpen()) {
      this._closeCharMenu();
    } else {
      if (this._charMenuOpen) this._closeCharMenu();
      this._charMenuOpen = true;
      this._charPanel?.open('inventory');
    }
  }

  _openInventory() {
    if (!this._charMenuOpen) {
      this._charMenuOpen = true;
      this._charPanel?.open('inventory');
    } else {
      this._charPanel?.switchTab('inventory');
    }
  }

  _closeInvContextMenu() {
    return this._inventoryUi.closeInvContextMenu();
  }

  _closeInventory() {
    return this._inventoryUi.closeInventory();
  }

  _getKiShotUpgrade(actor, stat) {
    return this._combatFx.getKiShotUpgrade(actor, stat);
  }

  _getKiBlastRange(actor) {
    return this._combatFx.getKiBlastRange(actor);
  }

  _getKiBlastCooldownMs(actor) {
    return this._combatFx.getKiBlastCooldownMs(actor);
  }

  _getKiBlastProjectileSpeed(actor) {
    return this._combatFx.getKiBlastProjectileSpeed(actor);
  }

  _getKiBlastAimInfo(actor) {
    return this._combatFx.getKiBlastAimInfo(actor);
  }

  // ── Ki Blast ─────────────────────────────────────────────────────────────────
  _fireKiBlast() {
    return this._combatFx.firePlayerKiBlast();
  }
  _fireAbsorb() {
    return this._combatFx.firePlayerAbsorb();
  }
  _getKiBlastImpactPoint(startX, startY, endX, endY, allowEarlyDetonation = false) {
    return this._combatFx.getKiBlastImpactPoint(startX, startY, endX, endY, allowEarlyDetonation);
  }
  _showKiBlastImpact(worldX, worldY, tint = 0x44aaff, radius = 18, placeCrater = false) {
    return this._combatFx.showKiBlastImpact(worldX, worldY, tint, radius, placeCrater);
  }
  _handleReplicatedFxEvents(events) {
    for (const evt of events || []) {
      if (evt?.type === 'chat' && evt.pid && evt.text) {
        // Skip our own messages — already shown locally
        if (evt.pid === this.playerId) continue;
        this.chatBox?._addLog(`${evt.pid}: ${evt.text}`, evt.color || '#cccccc');
        // Show speech bubble on the remote player sprite
        const rp = this._remotePlayers[evt.pid];
        if (rp) rp.showBubble?.(evt.text, 5000);
      }
      // Mine tile updates
      if (evt?.type === 'mine_update' && evt.tiles) {
        this._mineRenderer.updateTiles(evt.tiles);
      }
      // Chat hints (resource pickup messages, etc.)
      if (evt?.type === 'chat_hint' && evt.text) {
        this.chatBox?._addLog(evt.text, '#88ccff');
      }
    }
    return this._combatFx.handleReplicatedFxEvents(events);
  }
  _renderReplicatedKiBlast(event) {
    return this._combatFx.renderReplicatedKiBlast(event);
  }
  // ── Character Menu ─────────────────────────────────────────────────────────

  _toggleCharMenu() {
    if (this._charMenuOpen) {
      this._closeCharMenu();
    } else {
      this._openCharMenu();
    }
  }

  _openCharMenu() {
    this._charMenuOpen = true;
    this._charPanel?.open();
  }

  _closeCharMenu() {
    this._charMenuOpen = false;
    for (const el of this._charMenuEls) el.destroy();
    this._charMenuEls = [];
    this._charPanel?.close();
  }

  // ── Entity Query Helpers (used by NPCBrain reflex layer) ────────────────────

  /** Returns the nearest non-depleted world-object sprite within range, or null. */
  getNearestOre(npc, rangeTiles = 8) {
    let best = null, bestDist = rangeTiles * TILE_SIZE;
    for (const [, wo] of Object.entries(this._worldObjSprites || {})) {
      if (!wo || wo._depleted) continue;
      const dist = Phaser.Math.Distance.Between(npc.x, npc.y, wo.x, wo.y);
      if (dist < bestDist) { bestDist = dist; best = wo; }
    }
    return best;
  }

  /** Returns the nearest living training dummy within range, or null. */
  getNearestDummy(npc, rangeTiles = 8) {
    let best = null, bestDist = rangeTiles * TILE_SIZE;
    for (const dummy of (this.dummies ?? [])) {
      if (dummy.isDead?.()) continue;
      const dist = Phaser.Math.Distance.Between(npc.x, npc.y, dummy.x, dummy.y);
      if (dist < bestDist) { bestDist = dist; best = dummy; }
    }
    return best;
  }

  /** Returns array of remote NPC sprite entries within rangePixels of npc. */
  getNearbyRemoteNpcs(npc, rangePixels) {
    const result = [];
    for (const [, entry] of Object.entries(this._remoteNPCSprites || {})) {
      if (!entry?.sprite) continue;
      const dist = Phaser.Math.Distance.Between(npc.x, npc.y, entry.sprite.x, entry.sprite.y);
      if (dist <= rangePixels) result.push(entry);
    }
    return result;
  }
}
