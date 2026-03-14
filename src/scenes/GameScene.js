import Phaser from 'phaser';
import { buildTilemap, buildTilemapFromData } from '../systems/TilemapBuilder.js';
import { Player }       from '../entities/Player.js';
import { RemotePlayer } from '../entities/RemotePlayer.js';
import { Tree }         from '../entities/Tree.js';
import { Rock }         from '../entities/Rock.js';
import { GridSystem }   from '../systems/GridSystem.js';
import { GroundItem }   from '../entities/GroundItem.js';
import { NPC }          from '../entities/NPC.js';
import { ChatBox }      from '../ui/ChatBox.js';
import { NPCTaskRunner } from '../systems/NPCTaskRunner.js';
import { NPCBrain }      from '../systems/NPCBrain.js';
import { CombatFxController } from '../systems/CombatFxController.js';
import { StateSyncController } from '../systems/StateSyncController.js';
import { SelectionController } from '../systems/SelectionController.js';
import { WorldSyncController } from '../systems/WorldSyncController.js';
import { DialogueController } from '../systems/DialogueController.js';
import { TrainingDummy } from '../entities/TrainingDummy.js';
import { RemoteNPC }    from '../entities/RemoteNPC.js';
import { Fence }        from '../entities/Fence.js';
import { Connection }   from '../net/Connection.js';
import { NPCDetailPanel } from '../ui/NPCDetailPanel.js';
import { PlayerDetailPanel } from '../ui/PlayerDetailPanel.js';
import { HudController } from '../ui/HudController.js';
import { AdminPanelController } from '../ui/AdminPanelController.js';
import { InventoryController } from '../ui/InventoryController.js';
import {
  TILE_SIZE, MAP_COLS, MAP_ROWS,
  SHEET_KEY, SHEET_PATH, SHEET_TILE, SHEET_SPACING,
  PLAYER_KEY, PLAYER_PATH, PLAYER_FRAME_W, PLAYER_FRAME_H,
  NPC_KEY, NPC_PATH, NPC_FRAME_W, NPC_FRAME_H,
  INTERACT_DIST, tilePos,
  LOG1_KEY, LOG1_PATH, LOG2_KEY, LOG2_PATH, LOG3_KEY, LOG3_PATH,
  FIRE_KEY, FIRE_PATH, FIRE_JSON_PATH, FIRE_FRAME_W, FIRE_FRAME_H, CRATER_KEY, CRATER_PATH,
  ARMOR_ELITE_KEY, ARMOR_ELITE_PATH, ARMOR_ELITE_META_KEY, ARMOR_ELITE_META_PATH,
  ARMOR_ELITE_FRAME_W, ARMOR_ELITE_FRAME_H,
  AURA_KEY, AURA_PATH, AURA_FRAME_W, AURA_FRAME_H, BARRIER_KEY, BARRIER_PATH, BARRIER_FRAME_W, BARRIER_FRAME_H,
  FRAME_FENCE_T1, FRAME_FENCE_T2, FRAME_FENCE_T3, FRAME_GATE,
  FRAME_ROCK, FRAME_ANVIL, FRAME_CRYSTAL,
  NRG_KEY, NRG_PATH, NRG_FRAME_W, NRG_FRAME_H,
  KI_MAX_BASE, KI_REGEN_MS, KI_BLAST_BASE_COST, KI_BLAST_BASE_DMG, KI_BLAST_SCALE,
  CHARGE_STR_BONUS, CHARGE_DEF_BONUS,
  KI_SKILL_MEDITATE_UNLOCK_LEVEL, MEDITATION_POOR_MS, MEDITATION_NORMAL_MS, MEDITATION_PRISTINE_MS,
  worldToTile,
} from '../constants.js';

const DUMMY_KEY  = 'trainingdummy';
const DUMMY_PATH = 'assets/trainingdummy.png';
import { API_BASE } from '../config.js';
const AUTOSAVE_MS = 30000;
const HUD_SCALE = 0.7;
const PLAYER_FRAME_SCALE = 0.7;
const TARGET_FRAME_RELATIVE_TO_PLAYER = 1.2;
const TOP_HUD_MARGIN = Math.round(190 * HUD_SCALE);
const RIGHT_HUD_MARGIN = 360;
const HOTBAR_SLOT_COUNT = 6;
const KI_TIER_MOVES = [
  { tier: 1, moves: [{ id: 'ki_shot', label: 'Ki Shot' }, { id: 'charge', label: 'Charge' }, { id: 'sense_ki', label: 'Sense Ki' }] },
  { tier: 2, moves: [{ id: 'barrier', label: 'Barrier' }] },
];

export default class GameScene extends Phaser.Scene {
  constructor() {
    super('GameScene');
  }

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
    this.load.image(CRATER_KEY, CRATER_PATH);
    this.load.json(`${FIRE_KEY}_meta`, FIRE_JSON_PATH);
    this.load.spritesheet(FIRE_KEY, FIRE_PATH, {
      frameWidth: FIRE_FRAME_W,
      frameHeight: FIRE_FRAME_H,
    });
    this.load.json(ARMOR_ELITE_META_KEY, ARMOR_ELITE_META_PATH);
    this.load.spritesheet(ARMOR_ELITE_KEY, ARMOR_ELITE_PATH, {
      frameWidth: ARMOR_ELITE_FRAME_W,
      frameHeight: ARMOR_ELITE_FRAME_H,
    });
    this.load.spritesheet(NRG_KEY, NRG_PATH, {
      frameWidth: NRG_FRAME_W,
      frameHeight: NRG_FRAME_H,
    });
    this.load.spritesheet(AURA_KEY, AURA_PATH, {
      frameWidth: AURA_FRAME_W,
      frameHeight: AURA_FRAME_H,
    });
    this.load.spritesheet(BARRIER_KEY, BARRIER_PATH, {
      frameWidth: BARRIER_FRAME_W,
      frameHeight: BARRIER_FRAME_H,
    });
  }

  init(data) {
    // Receive login data from LoginScene
    this._loginData = data || {};
  }

  create() {
    // Entity arrays (init early so map loading can populate trees)
    this.trees       = [];
    this.groundItems = [];
    this.npcs        = [];
    this.dummies     = [];
    this._rockSprites = {}; // rock_id -> Rock entity
    this._kiBlastCraters = new Map(); // "col,row" -> crater sprite
    this.selectedNPC = null;
    this._focusedRemote = null;  // selected remote entity for chat/inspect
    this._armedAction = null;    // explicit click-to-act mode, e.g. attack
    this._playerKnockedOut = false;
    this._contextMenuEls = null;
    this._contextMenuBounds = null;
    this._overhearInterjectCooldowns = {};
    this._remotePlayers = {};
    this._activeMeditationRealmActorKey = null;
    this._suppressMeditationRealmActorKey = null;
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

    // Map dimensions — updated after map loads
    this._mapCols = MAP_COLS;
    this._mapRows = MAP_ROWS;

    const worldW = this._mapCols * TILE_SIZE;
    const worldH = this._mapRows * TILE_SIZE;
    this.physics.world.setBounds(0, 0, worldW, worldH);

    // Tilemap — load from server, fallback to procedural
    this.grid = new GridSystem();
    this._loadMap();

    // Player — will be repositioned by server
    const sp = tilePos(10, 10);
    this.player = new Player(this, sp.x, sp.y);

    // Track ground item visuals by server ID
    this._groundItemSprites = {};

    // Track dummy visuals by server ID
    this._dummySprites = {};

    // Track fence/gate visuals by server ID
    this._fenceSprites = {};

    // Recent threats — entities that attacked our player or NPCs (key → timestamp)
    // key format: 'player:id' or 'npc:ownerPid_npcId'
    this._recentThreats = {};

    // Track ki target visuals by server ID
    this._kiTargetSprites = {};

    // Track anvil visuals by server ID
    this._anvilSprites = {};

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

    // Scroll-wheel zoom (current zoom=1 is the max-out; scroll to zoom in)
    this._zoomLevel = 1;
    this.input.mouse?.disableContextMenu();
    this.input.on('wheel', (_pointer, _gos, _dx, dy) => {
      if (this.chatBox?.isOpen()) return; // don't zoom while typing
      const step = 0.1;
      this._zoomLevel += dy < 0 ? step : -step;
      this._zoomLevel = Phaser.Math.Clamp(this._zoomLevel, 1, 3);
      this.cameras.main.setZoom(this._zoomLevel);
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

    // NPC double-click selection
    this.input.on('pointerdown', (ptr) => {
      if (ptr._fgHandled) {
        ptr._fgHandled = false;
        return;
      }
      if (this._hotbarPickerSlot != null) this._closeHotbarPicker();
      if (this._isPointerOverContextMenu(ptr)) return;
      if (!this._isPointerInWorldViewport(ptr)) {
        if (ptr.rightButtonDown() || ptr.button === 2) this._closeContextMenu();
        return;
      }
      const isRightClick = ptr.rightButtonDown() || ptr.button === 2;
      if (!isRightClick && this._isCarryingSomeone()) {
        this._closeContextMenu();
        this._conn?.send({ type: 'drop_carried' });
        return;
      }
      const npc = this._findNpcAtPointer(ptr);
      const remoteEntity = !npc ? this._findRemoteEntityAtPointer(ptr) : null;
      const carriedEntity = !npc && !remoteEntity && isRightClick ? this._getCarriedEntityByPlayer() : null;

      if (npc) {
        this._handleOwnNPCPointerDown(npc, ptr);
        return;
      }

      if (remoteEntity && isRightClick) {
        this._selectRemote(remoteEntity);
        this._openContextMenu(remoteEntity, ptr);
        return;
      }

      if (carriedEntity && isRightClick) {
        if (carriedEntity.soul) this._selectNPC(carriedEntity);
        else this._selectRemote(carriedEntity);
        this._openContextMenu(carriedEntity, ptr);
        return;
      }

      if (remoteEntity && this._armedAction === 'attack' && !isRightClick) {
        ptr._fgHandled = true;
        if (this._isAttackableEntity(remoteEntity)) this._executeAttack(remoteEntity);
        this._disarmActionMode();
        return;
      }

      // Right-click on dummy or ki target — delete it
      if (isRightClick) {
        const worldX = ptr.worldX;
        const worldY = ptr.worldY;
        const clickRange = TILE_SIZE * 0.8;

        // Check dummies
        for (const dummy of (this.dummies ?? [])) {
          if (dummy.isDead?.()) continue;
          const d = Phaser.Math.Distance.Between(worldX, worldY, dummy.x, dummy.y);
          if (d < clickRange && dummy._serverId) {
            this._conn?.send({ type: 'delete_dummy', dummy_id: dummy._serverId });
            this._closeContextMenu();
            return;
          }
        }

        // Check ki targets
        for (const [ktid, ktSprite] of Object.entries(this._kiTargetSprites || {})) {
          const d = Phaser.Math.Distance.Between(worldX, worldY, ktSprite.x, ktSprite.y);
          if (d < clickRange) {
            this._conn?.send({ type: 'delete_ki_target', target_id: ktid });
            this._closeContextMenu();
            return;
          }
        }

        this._closeContextMenu();
        return;
      }

      this._closeContextMenu();
      if (this._armedAction) {
        this._disarmActionMode();
      }
    });

    // Task runners + brains
    this._taskRunners = new Map();
    this._npcBrains   = new Map();

    // Detail panel overlay
    this._npcDetailPanel = new NPCDetailPanel(this);
    this._playerDetailPanel = new PlayerDetailPanel(this);

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

    // Enter key — open chat
    this.input.keyboard.on('keydown', (event) => {
      if (this._namingNPC || this._escMenuOpen || this._playerKnockedOut) return;
      if (event.key === 'Enter' && !this.chatBox.isOpen()) {
        if (this._getChatTarget()) this.chatBox.open();
      }
    });

    // Tab key — cycle through nearby targets.
    // Priority: own NPCs by distance, then remote players/NPCs by distance.
    this.input.keyboard.on('keydown-TAB', (event) => {
      event.preventDefault();
      if (this.chatBox?.isOpen() || this._namingNPC || this._escMenuOpen || this._playerKnockedOut) return;
      const cycle = this._buildTabCycleList();
      if (cycle.length === 0) return;

      const current = this._focusedRemote || this.selectedNPC || null;
      const curIdx = current ? cycle.findIndex(entry => entry.entity === current) : -1;
      const next = cycle[(curIdx + 1 + cycle.length) % cycle.length];
      if (!next) return;

      if (next.kind === 'own_npc') this._selectNPC(next.entity);
      else this._selectRemote(next.entity);
    });

    // B key — build NPC (client-side, NPCs stay local)
    this.input.keyboard.on('keydown-B', () => {
      if (this.chatBox?.isOpen() || this._namingNPC || this._escMenuOpen || this._playerKnockedOut) return;
      this._tryBuildNPC();
    });

    // T key — build training dummy (server-side)
    this.input.keyboard.on('keydown-T', () => {
      if (this.chatBox?.isOpen() || this._namingNPC || this._escMenuOpen || this._playerKnockedOut) return;
      this._tryBuildDummy();
    });

    // Q key — admin menu
    this._adminOpen = false;
    this._adminPanel = null;
    this.input.keyboard.on('keydown-Q', () => {
      if (this.chatBox?.isOpen() || this._namingNPC || this._escMenuOpen) return;
      this._toggleAdmin();
    });
    this.input.keyboard.on('keydown-LEFT', () => {
      if (!this._adminOpen) return;
      this._adminPage = Math.max(1, (this._adminPage || 1) - 1);
      this._renderAdminPanel();
    });
    this.input.keyboard.on('keydown-RIGHT', () => {
      if (!this._adminOpen) return;
      this._adminPage = Math.min(2, (this._adminPage || 1) + 1);
      this._renderAdminPanel();
    });

    // Number keys — hotbar actions (1-6)
    this.input.keyboard.on('keydown', (event) => {
      if (this.chatBox?.isOpen() || this._namingNPC || this._escMenuOpen || this._inventoryOpen || this._playerKnockedOut) return;
      const slot = parseInt(event.key, 10);
      if (slot >= 1 && slot <= HOTBAR_SLOT_COUNT) {
        this._useHotbarSlot(slot - 1);
      }
    });

    // I key — toggle inventory
    this.input.keyboard.on('keydown-I', () => {
      if (this.chatBox?.isOpen() || this._namingNPC || this._escMenuOpen || this._playerKnockedOut) return;
      this._toggleInventory();
    });

    // Space bar — fire ki blast
    this.input.keyboard.on('keydown-SPACE', (event) => {
      if (this.chatBox?.isOpen() || this._namingNPC || this._escMenuOpen || this._inventoryOpen || this._charMenuOpen || this._playerKnockedOut) return;
      event.preventDefault();
      this._fireKiBlast();
    });

    // C key — toggle character menu
    this._charMenuOpen = false;
    this._charMenuEls = [];
    this.input.keyboard.on('keydown-C', () => {
      if (this.chatBox?.isOpen() || this._namingNPC || this._escMenuOpen || this._inventoryOpen || this._playerKnockedOut) return;
      this._toggleCharMenu();
    });

    // Escape key — toggle pause/menu
    this._escMenuOpen = false;
    this._escMenuEls = null;
    this.input.keyboard.on('keydown-ESC', () => {
      if (this.chatBox?.isOpen() || this._namingNPC) return;
      if (this._charMenuOpen) { this._closeCharMenu(); return; }
      if (this._inventoryOpen) { this._closeInventory(); return; }
      if (this._contextMenuEls) { this._closeContextMenu(); return; }
      if (this._armedAction) { this._disarmActionMode(); return; }
      if (this.selectedNPC || this._focusedRemote) { this._clearSelection(); return; }
      this._toggleEscMenu();
    });

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
        this.player.bastalite = me.bastalite ?? 0;
        this.player.crystalPristine = me.crystal_pristine ?? 0;
        this.player.crystalNormal = me.crystal_normal ?? 0;
        this.player.crystalPoor = me.crystal_poor ?? 0;
        this.player.setArmorElite?.(!!me.armor_elite);
        this.player.armorEliteInv = !!me.armor_elite_inv;
        this.player.hp = me.hp ?? this.player.hp;
        this.player.maxHp = me.maxHp ?? this.player.maxHp;
        this.player.ki = me.ki ?? this.player.ki;
        this.player.maxKi = me.maxKi ?? this.player.maxKi;
        this.player.infKi = !!me.inf_ki;
        this.player.blastLevel = me.blastLevel ?? this.player.blastLevel;
        this.player.auraTint = me.aura_tint ?? this.player.auraTint;
        this.player.auraAlpha = me.aura_alpha ?? this.player.auraAlpha;
        this.player.kiSkillLevel = me.kiSkillLevel ?? this.player.kiSkillLevel;
        this.player.kiSkillXp = me.kiSkillXp ?? this.player.kiSkillXp;
        this.player.realmTier = me.realm_tier ?? me.realmTier ?? this.player.realmTier;
        this.player.realmCrystalT1 = me.realm_crystal_t1 ?? this.player.realmCrystalT1 ?? 0;
        this.player.kiUpgrades = (me.ki_upgrades && typeof me.ki_upgrades === 'object') ? { ...me.ki_upgrades } : (this.player.kiUpgrades || {});
        this.player.kiMoves = Array.isArray(me.ki_moves) ? [...me.ki_moves] : (this.player.kiMoves || []);
        this.player.kiDenominations = Array.isArray(me.ki_denominations) ? [...me.ki_denominations] : (this.player.kiDenominations || []);
        this.player.kiKnownAugments = (me.ki_known_augments && typeof me.ki_known_augments === 'object') ? { ...me.ki_known_augments } : (this.player.kiKnownAugments || {});
        this.player.kiEquippedAugments = (me.ki_equipped_augments && typeof me.ki_equipped_augments === 'object') ? { ...me.ki_equipped_augments } : (this.player.kiEquippedAugments || {});
        this.player.str = me.str ?? this.player.str;
        this.player.def = me.def ?? this.player.def;
        this.player.level = me.level ?? this.player.level;
        this.player.xp = me.xp ?? this.player.xp;
        this.player.setMeditationState?.(me);
        this.player.setChargeState?.(me);
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

    this.input.keyboard?.on('keydown-V', () => this._toggleClairvoyance());

    this._conn.connect();
  }

  update(time, delta) {
    // ── Send input to server + client-side prediction ─────────────────────────
    if (this._conn.connected && !this.chatBox?.isOpen() && !this.player._punching && !this.player.meditating && !this._namingNPC && !this._playerDead && !this._playerKnockedOut && !this._escMenuOpen && !this._inventoryOpen && !this._charMenuOpen) {
      const keys = this.player._keys;
      let dx = 0, dy = 0;
      if (keys.left.isDown)  dx -= 1;
      if (keys.right.isDown) dx += 1;
      if (keys.up.isDown)    dy -= 1;
      if (keys.down.isDown)  dy += 1;
      const running = keys.run.isDown;
      this._conn.sendMove(dx, dy, running);

      // Client-side prediction: move locally for responsive feel
      if (dx !== 0 || dy !== 0) {
        const speed = running ? 280 : 160;
        let mx = dx, my = dy;
        if (mx !== 0 && my !== 0) { mx /= Math.SQRT2; my /= Math.SQRT2; }
        const dt = delta / 1000;
        this.player.x += mx * speed * dt;
        this.player.y += my * speed * dt;
        // Clamp to world bounds
        const worldW = MAP_COLS * TILE_SIZE;
        const worldH = MAP_ROWS * TILE_SIZE;
        this.player.x = Math.max(0, Math.min(worldW, this.player.x));
        this.player.y = Math.max(0, Math.min(worldH, this.player.y));
      }
    } else if (this._conn.connected) {
      this._conn.sendMove(0, 0, false);
    }

    // Local player visual update (animations etc)
    this.player.update(delta);

    // Update NPCs + task runners + brains (client-side)
    for (const npc of this.npcs) {
      npc.update(delta);
      if (npc.isKnockedOut?.()) continue;
      const runner = this._taskRunners.get(npc.id);
      if (runner) runner.update(delta);
      const brain = this._npcBrains.get(npc.id);
      if (brain) brain.update(delta);
    }

    // Check emotion-driven reactions for each NPC
    for (const npc of this.npcs) {
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
    this._updateClairvoyanceCamera();

    // Update target unit frame
    this._updateTargetFrame();
    this._updateSensePanel(time);
    this._refreshAttackIndicators();
    this._updateArmedStatus();

    // Update hotbar counts
    this._updateHotbar();

    const npcCost = this._npcBuildCost();
    const canBuild = this.player.logs >= npcCost;
    this._buildBtn.setText(`[B] Build Robot (${npcCost.toLocaleString()} logs)`).setVisible(canBuild);
    this._dummyBtn.setVisible(this.player.logs >= 10);

    // Player count
    const playerCount = Object.keys(this._remotePlayers).length + 1;
    if (this._conn.connected) {
      this._netStatus.setText(`Online: ${playerCount} player${playerCount > 1 ? 's' : ''}`);
    }

    this._updateNPCPanel();
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

  _isCampfireLog(item) {
    return this._worldSync.isCampfireLog(item);
  }

  _isCampfireStone(item) {
    return this._worldSync.isCampfireStone(item);
  }

  _groundItemTile(item) {
    return this._worldSync.groundItemTile(item);
  }

  _canLightCampfire(item) {
    return this._worldSync.canLightCampfire(item);
  }

  _tryLightCampfire(item, npc = null) {
    return this._worldSync.tryLightCampfire(item, npc);
  }

  _tryUseKiShrine(item, npc = null) {
    return this._worldSync.tryUseKiShrine(item, npc);
  }

  _getLitCampfires() {
    return this._worldSync.getLitCampfires();
  }

  _findNearestLitCampfire(x, y, maxTiles = Infinity) {
    return this._worldSync.findNearestLitCampfire(x, y, maxTiles);
  }

  _syncDummies(serverDummies) {
    return this._worldSync.syncDummies(serverDummies);
  }

  _syncFences(serverFences) {
    return this._worldSync.syncFences(serverFences);
  }

  // ── Ki Target sync ──────────────────────────────────────────────────────────

  _syncKiTargets(serverKiTargets) {
    return this._worldSync.syncKiTargets(serverKiTargets);
  }

  // ── Anvil sync ────────────────────────────────────────────────────────────

  _syncAnvils(serverAnvils) {
    return this._worldSync.syncAnvils(serverAnvils);
  }

  _tryRefineAtAnvil(anvilId, ax, ay) {
    return this._worldSync.tryRefineAtAnvil(anvilId, ax, ay);
  }

  _handleRefineResult(result) {
    return this._worldSync.handleRefineResult(result);
  }

  _handleMeditationResult(result) {
    return this._worldSync.handleMeditationResult(result);
  }

  _formatKiMoveLabel(moveId) {
    for (const tier of KI_TIER_MOVES) {
      const found = tier.moves.find((move) => move.id === moveId);
      if (found) return found.label;
    }
    return String(moveId || '').replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
  }

  _formatKiUpgradeStat(moveId, statId) {
    const labels = {
      ki_shot: { range: 'range', cooldown: 'cooldown', speed: 'speed', damage: 'damage' },
      charge: { ceiling: 'charge ceiling', decay: 'decay reduction', speed: 'charge speed' },
      barrier: { physical_block: 'physical block', ki_block: 'ki block' },
      sense_ki: { range_pct: 'sense range', level_delta: 'level gap read' },
    };
    return labels[moveId]?.[statId] || this._formatKiMoveLabel(statId);
  }

  _getSenseRangeLevel(actor) {
    const known = new Set(actor?.kiKnownAugments?.sense_ki || []);
    let level = 0;
    if (known.has('sense_1')) level += 1;
    if (known.has('sense_2')) level += 1;
    if (known.has('sense_3')) level += 1;
    if (level <= 0) {
      level = Phaser.Math.Clamp(Number(actor?.kiUpgrades?.sense_ki?.range || 0), 0, 3);
    }
    return level;
  }

  _getActorSenseInfo(actor) {
    const upgrades = actor?.kiUpgrades || {};
    const rangeLevel = this._getSenseRangeLevel(actor);
    const rangePct = Number(upgrades?.sense_ki?.range_pct || 0);
    const deltaBonus = Number(upgrades?.sense_ki?.level_delta || 0);
    const senseTiles = [8, 16, 24, 32][rangeLevel] || 8;
    return {
      range: TILE_SIZE * senseTiles * (1 + rangePct * 0.01),
      maxDelta: 10 + deltaBonus,
    };
  }

  _canSenseTargetDetails(observer, target) {
    if (!observer || !target) return false;
    const info = this._getActorSenseInfo(observer);
    const distance = Phaser.Math.Distance.Between(observer.x, observer.y, target.x, target.y);
    if (distance > info.range) return false;
    const targetLevel = target.level ?? target._level ?? 1;
    const observerLevel = observer.level ?? 1;
    return (targetLevel - observerLevel) <= info.maxDelta;
  }

  _canRevealTargetName(observer, target) {
    if (!observer || !target) return false;
    if (!observer.hasKiMove?.('sense_ki')) return false;
    if (!observer.hasKiAugment?.('sense_ki', 'reveal_name')) return false;
    const info = this._getActorSenseInfo(observer);
    return Phaser.Math.Distance.Between(observer.x, observer.y, target.x, target.y) <= info.range;
  }

  _toggleClairvoyance() {
    const p = this.player;
    const target = this._focusedRemote;
    if (!p || !this._conn?.connected) return;
    if (p.getEquippedKiAugment?.('sense_ki') !== 'clairvoyance') return;
    if (p.clairvoyanceActive) {
      this._conn.send({
        type: 'toggle_clairvoyance',
        target_type: null,
        target_owner: null,
        target_id: null,
      });
      return;
    }
    if (!target || (!target.playerId && !target.ownerPid)) return;
    this._conn.send({
      type: 'toggle_clairvoyance',
      target_type: target.playerId ? 'player' : 'npc',
      target_owner: target.ownerPid || null,
      target_id: target.playerId || target.npcId || null,
    });
  }

  _resolveClairvoyanceTarget() {
    const p = this.player;
    if (!p?.clairvoyanceActive) return null;
    if (p.clairvoyanceTargetType === 'player') {
      return this._remotePlayers?.[p.clairvoyanceTargetId] || null;
    }
    if (p.clairvoyanceTargetType === 'npc') {
      return this._remoteNPCSprites?.[`${p.clairvoyanceTargetOwner}_${p.clairvoyanceTargetId}`] || null;
    }
    return null;
  }

  _updateClairvoyanceCamera() {
    const cam = this.cameras.main;
    const target = this._resolveClairvoyanceTarget();
    if (target) {
      if (cam._clairvoyanceTarget !== target) {
        cam.startFollow(target, true, 0.12, 0.12);
        cam._clairvoyanceTarget = target;
      }
      return;
    }
    if (cam._clairvoyanceTarget) {
      cam.startFollow(this.player, true, 0.1, 0.1);
      cam._clairvoyanceTarget = null;
    }
  }

  _handleShrineResult(result) {
    if (!result) return;
    const who = !result.who || result.who === this.playerId ? 'You' : result.who;
    if (!result.success) {
      this.chatBox?._addLog(`${who}: ${result.reason || 'The shrine did nothing.'}`, '#99bbcc');
      return;
    }
    const detail = `${this._formatKiUpgradeStat(result.move, result.stat)} +1 (${result.value} total)`;
    this.chatBox?._addLog(
      `${who}: ${this._formatKiMoveLabel(result.move)} ${detail}.`,
      '#88ffcc'
    );
  }

  _syncMeditationRealmScene() {
    return this._worldSync.syncMeditationRealmScene();
  }

  _handleKiTargetResult(result) {
    return this._worldSync.handleKiTargetResult(result);
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
      const deadNpc = this.npcs.find(n => n.id === victimNpcId);
      victimName = deadNpc?.getName?.() || victimNpcId;
    }

    for (const npc of this.npcs) {
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
  _syncRemoteNPCs(players) {
    return this._stateSync.syncRemoteNPCs(players);
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

  async _loadMap() {
    try {
      const res = await fetch(`${API_BASE}/load-map?name=level1`);
      if (!res.ok) throw new Error(`Map load failed: ${res.status}`);
      const mapData = await res.json();

      const { treePositions, rockSpawnTiles, width, height } = buildTilemapFromData(this, mapData);

      // Update world bounds to match map
      this._mapCols = width;
      this._mapRows = height;
      const worldW = width * TILE_SIZE;
      const worldH = height * TILE_SIZE;
      this.physics.world.setBounds(0, 0, worldW, worldH);
      this.cameras.main.setBounds(0, 0, worldW, worldH);

      // Spawn trees at positions found in the map
      this._spawnTreesAt(treePositions);

      console.log(`[map] Loaded level1: ${width}x${height}, ${treePositions.length} trees, ${rockSpawnTiles.length} rock spawn tiles`);
    } catch (e) {
      console.warn('[map] Failed to load level1, using fallback:', e.message);
      buildTilemap(this, this._mapCols, this._mapRows);
      this._spawnTreesFallback();
    }
  }

  _spawnTreesAt(positions) {
    for (let i = 0; i < positions.length; i++) {
      const { col, row } = positions[i];
      const pos = tilePos(col, row);
      const tree = new Tree(this, pos.x, pos.y);
      tree.treeIndex = i;
      this.trees.push(tree);
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
      this.trees.push(tree);
    }
  }

  // ── NPC management (stays client-side) ─────────────────────────────────────────

  /** Cost to build the next NPC: 10, 100, 1000, 10000, ... */
  _npcBuildCost() {
    return 10 * Math.pow(10, this.npcs.length);
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
    this.npcs.push(npc);
    const runner = new NPCTaskRunner(this, npc);
    this._taskRunners.set(npc.id, runner);
    this._npcBrains.set(npc.id, new NPCBrain(this, npc, runner));
    this._selectNPC(npc);

    // Register NPC with server for persistence
    this._conn.send({ type: 'register_npc', npc_id: npc.id });

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
    const normalized = (commands || []).map(cmd => {
      if (cmd?.task !== 'guard_fire') return cmd;
      const fire = this._findNearestLitCampfire?.(npc.x, npc.y, 12);
      return fire ? { ...cmd, fire_item_id: fire._serverId } : { ...cmd };
    });
    let runner = this._taskRunners.get(npc.id);
    if (!runner) {
      runner = new NPCTaskRunner(this, npc);
      this._taskRunners.set(npc.id, runner);
    }
    runner.setTasks(normalized);

    // Notify brain that player issued an explicit command — pause autonomous decisions
    const brain = this._npcBrains.get(npc.id);
    if (brain) {
      brain.onPlayerCommand();
      brain.pushEvent({
        type: 'command',
        text: `Player commanded: ${normalized[0]?.task || 'unknown'}`,
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
    return this._hud.updatePlayerFrame();
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
    if (this._focusedRemote?.ownerPid && !this._focusedRemote?.isKnockedOut?.()) return this._focusedRemote;
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

  _isEntityCarriedByPlayer(entity) {
    const me = this._lastServerState?.players?.[this.playerId];
    if (!entity || !me?.carrying) return false;
    if (entity.playerId && me.carrying.type === 'player') return me.carrying.id === entity.playerId;
    if (entity.ownerPid && me.carrying.type === 'npc') {
      return me.carrying.owner === entity.ownerPid && me.carrying.id === entity.npcId;
    }
    return false;
  }

  _isCarryingSomeone() {
    const me = this._lastServerState?.players?.[this.playerId];
    return !!me?.carrying;
  }

  _getCarriedEntityByPlayer() {
    const me = this._lastServerState?.players?.[this.playerId];
    const carried = me?.carrying;
    if (!carried) return null;
    if (carried.type === 'player') return this._remotePlayers?.[carried.id] ?? null;
    if (carried.type === 'npc') {
      if (carried.owner === this.playerId) {
        return (this.npcs || []).find(n => n.id === carried.id) ?? null;
      }
      const key = `${carried.owner}_${carried.id}`;
      return this._remoteNPCSprites?.[key] ?? null;
    }
    return null;
  }

  _entityClickRadius(entity) {
    if (!entity) return TILE_SIZE;
    if (entity.isKnockedOut?.() || entity._carriedBy) return TILE_SIZE * 1.6;
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
    if (entity?.soul) {
      actions.push({ label: 'Chat', action: () => { this._selectNPC(entity); if (!this.chatBox?.isOpen()) this.chatBox.open(); } });
      actions.push({ label: 'Details', action: () => { this._selectNPC(entity); this._openNPCDetail(entity); } });
    } else if (entity?.isKnockedOut?.()) {
      actions.push({ label: 'Kill', action: () => this._sendKnockoutAction('kill', entity) });
      actions.push({ label: 'Rob', action: () => this._sendKnockoutAction('rob', entity) });
      if (this._isEntityCarriedByPlayer(entity)) {
        actions.push({ label: 'Set Down', action: () => this._sendKnockoutAction('drop', entity) });
      } else if (!entity._carriedBy) {
        actions.push({ label: 'Carry', action: () => this._sendKnockoutAction('carry', entity) });
      }
      actions.push({ label: 'Inspect', action: () => { this._selectRemote(entity); } });
    } else if (entity?.ownerPid) {
      actions.push({ label: 'Chat', action: () => { this._selectRemote(entity); if (!this.chatBox?.isOpen()) this.chatBox.open(); } });
      actions.push({ label: 'Attack', action: () => { this._selectRemote(entity); this._armActionMode('attack'); } });
      actions.push({ label: 'Inspect', action: () => { this._selectRemote(entity); } });
    } else if (entity?.playerId) {
      actions.push({ label: 'Attack', action: () => { this._selectRemote(entity); this._armActionMode('attack'); } });
      actions.push({ label: 'Inspect', action: () => { this._selectRemote(entity); } });
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
        this.npcs.push(npc);
        const runner = new NPCTaskRunner(this, npc);
        this._taskRunners.set(npc.id, runner);
        this._npcBrains.set(npc.id, new NPCBrain(this, npc, runner));
        console.log(`[load] Restored NPC ${npc.id} (${npc.getName()})`);
      } catch (e) {
        console.warn(`[load] Failed to load NPC ${npcId}:`, e.message);
      }
    }
  }

  // ── NPC Info Panel ─────────────────────────────────────────────────────────────

  _showNPCPanel(npc) {
    this._hideNPCPanel();
    this._npcPanelNPC = npc ?? null;
  }

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

  _updateNPCPanel() {
    return;
  }

  _findNpcAtPointer(ptr) {
    if (!this._isPointerInWorldViewport(ptr)) return null;
    const worldX = ptr.worldX;
    const worldY = ptr.worldY;
    let best = null;
    let bestDist = Infinity;
    for (const npc of this.npcs) {
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

  // ── Admin Menu ──────────────────────────────────────────────────────────────────

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
    for (const npc of this.npcs) {
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
        hp: npc.hp, maxHp: npc.maxHp,
        ki: npc.ki, maxKi: npc.maxKi,
        inf_ki: !!npc.infKi,
        str: npc.str, def: npc.def,
        level: npc.level, xp: npc.xp,
        blastLevel: npc.blastLevel,
        kiSkillLevel: npc.kiSkillLevel ?? 1,
        kiSkillXp: npc.kiSkillXp ?? 0,
        realm_tier: npc.realmTier ?? 0,
        ki_moves: npc.kiMoves ?? [],
        ki_denominations: npc.kiDenominations ?? [],
        ki_known_augments: npc.kiKnownAugments ?? {},
        ki_equipped_augments: npc.kiEquippedAugments ?? {},
        ki_upgrades: npc.kiUpgrades ?? {},
        facing: (npc.getFacing?.() ? npc.getFacing() : 'down'),
        barrier_proc_until: Number(npc.barrierProcUntil || 0),
        barrier_proc_facing: npc.barrierProcFacing ? npc.barrierProcFacing : (npc.getFacing?.() ? npc.getFacing() : 'down'),
        aura_tint: npc.auraTint != null ? npc.auraTint : 0x4fd6ff,
        aura_alpha: npc.auraAlpha != null ? npc.auraAlpha : 0.42,
        name: npc.getName(),
        dead: npc.isDead(),
        knocked_out: npc.isKnockedOut?.() || false,
        meditating: !!npc.meditating,
        meditation_started_at: npc.meditationStartedAt ?? 0,
        meditation_until: npc.meditationUntil ?? 0,
        meditation_total_ms: npc.meditationTotalMs ?? 0,
        meditation_crystal_quality: npc.meditationCrystalQuality ?? null,
        owner: this.playerId,
        logs: npc.logs, maxLogs: npc.maxLogs,
        stones: npc.stones ?? 0,
        bastalite: npc.bastalite ?? 0,
        crystal_pristine: npc.crystalPristine ?? 0,
        crystal_normal: npc.crystalNormal ?? 0,
        crystal_poor: npc.crystalPoor ?? 0,
        realm_crystal_t1: npc.realmCrystalT1 ?? 0,
        armor_elite: !!npc.armorElite,
        gathering: this._taskRunners.get(npc.id)?.getStatus()?.tasks?.[0]?.task === 'gather',
        soul: soulData,
        personality,
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
    for (const npc of this.npcs) {
      if (!npc.isDead()) this._saveNPC(npc);
    }
  }

  // ── Server Chat Relay Handlers ─────────────────────────────────────────────

  /** Another player talks to one of our NPCs — run LLM dialogue and send reply back. */
  async _handleIncomingChat(data) {
    const { from, from_color, target_npc_id, text, meta } = data;
    // Find our local NPC by ID
    const npc = this.npcs.find(n => n.id === target_npc_id);
    if (!npc || npc.isDead()) return;

    // Show the incoming message as a bubble on the NPC
    npc.showBubble(`${from}: "${text}"`, 4000, { silent: true });
    this.chatBox?._addLog(`${from} → ${npc.getName()}: ${text}`, from_color || '#ffddaa');

    try {
      if (meta?.type === 'fire_warning') {
        const runner = this._taskRunners.get(npc.id);
        const personality = npc.soul?.personality || {};
        const cooperation = personality.cooperation ?? 0.5;
        const aggression = personality.aggression ?? 0.3;
        const neuroticism = personality.neuroticism ?? 0.3;
        const complies = (cooperation + neuroticism * 0.35) >= (aggression + 0.15);
        const reply = complies
          ? (aggression > 0.55 ? 'Fine. I will leave the fire alone.' : 'Alright, I will leave the fire area.')
          : (aggression > 0.6 ? 'No. I need this fire.' : 'I just need to heal.');

        if (complies && runner) {
          const existingTasks = runner.getStatus()?.tasks || [];
          runner.setTasks([
            {
              task: 'move_away_from_fire',
              fire_x: Number(meta.fire_x || 0),
              fire_y: Number(meta.fire_y || 0),
              min_distance: TILE_SIZE * Math.max(3, Number(meta.leave_distance_tiles || 5)),
              duration_ms: 5000,
            },
            ...existingTasks,
          ]);
        }

        npc.showBubble(reply, 3200, { silent: true });
        this.chatBox?._addLog(`${npc.getName()}: ${reply}`, '#aaddff');
        this._conn.send({
          type: 'chat_reply',
          to: from,
          npc_id: target_npc_id,
          npc_name: npc.getName(),
          reply,
          meta: {
            type: 'fire_warning_reply',
            complies,
            fire_item_id: meta.fire_item_id || null,
          },
        });
        return;
      }

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
    if (meta?.type === 'fire_warning_reply') {
      for (const runner of this._taskRunners.values()) {
        runner.handleFireWarningReply?.(key, { complies: !!meta.complies, reply });
      }
    }
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

  async _tryLoadNPC(npcId, npc) {
    try {
      const res = await fetch(`${API_BASE}/npc_load/${npcId}`);
      if (!res.ok) return false;
      const { found, data } = await res.json();
      if (found && data) {
        npc.loadFrom(data);
        console.log(`[load] Restored NPC ${npcId}`);
        return true;
      }
    } catch (e) {
      console.warn('[load] Failed to load NPC:', e.message);
    }
    return false;
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

  _placeKiShrine() {
    return this._inventoryUi.placeKiShrine();
  }

  // ── Inventory ───────────────────────────────────────────────────────────────

  _toggleInventory() {
    return this._inventoryUi.toggleInventory();
  }

  _openInventory() {
    return this._inventoryUi.openInventory();
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
  _getKiBlastImpactPoint(startX, startY, endX, endY, allowEarlyDetonation = false) {
    return this._combatFx.getKiBlastImpactPoint(startX, startY, endX, endY, allowEarlyDetonation);
  }
  _showKiBlastImpact(worldX, worldY, tint = 0x44aaff, radius = 18, placeCrater = false) {
    return this._combatFx.showKiBlastImpact(worldX, worldY, tint, radius, placeCrater);
  }
  _handleReplicatedFxEvents(events) {
    return this._combatFx.handleReplicatedFxEvents(events);
  }
  _renderReplicatedKiBlast(event) {
    return this._combatFx.renderReplicatedKiBlast(event);
  }
  _placeTemporaryCrater(worldX, worldY) {
    return this._combatFx.placeTemporaryCrater(worldX, worldY);
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
    this._playerDetailPanel?.open();
  }

  _closeCharMenu() {
    this._charMenuOpen = false;
    for (const el of this._charMenuEls) el.destroy();
    this._charMenuEls = [];
    this._playerDetailPanel?.close();
  }
}
