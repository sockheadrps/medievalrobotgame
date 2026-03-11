import Phaser from 'phaser';
import { buildTilemap, buildTilemapFromData } from '../systems/TilemapBuilder.js';
import { Player }       from '../entities/Player.js';
import { RemotePlayer } from '../entities/RemotePlayer.js';
import { Tree }         from '../entities/Tree.js';
import { GridSystem }   from '../systems/GridSystem.js';
import { GroundItem }   from '../entities/GroundItem.js';
import { NPC }          from '../entities/NPC.js';
import { ChatBox }      from '../ui/ChatBox.js';
import { NPCTaskRunner } from '../systems/NPCTaskRunner.js';
import { NPCBrain }      from '../systems/NPCBrain.js';
import { TrainingDummy } from '../entities/TrainingDummy.js';
import { RemoteNPC }    from '../entities/RemoteNPC.js';
import { Fence }        from '../entities/Fence.js';
import { Connection }   from '../net/Connection.js';
import { generateDialogue } from '../net/LLMClient.js';
import { NPCDetailPanel } from '../ui/NPCDetailPanel.js';
import {
  TILE_SIZE, MAP_COLS, MAP_ROWS,
  SHEET_KEY, SHEET_PATH, SHEET_TILE, SHEET_SPACING,
  PLAYER_KEY, PLAYER_PATH, PLAYER_FRAME_W, PLAYER_FRAME_H,
  NPC_KEY, NPC_PATH, NPC_FRAME_W, NPC_FRAME_H,
  INTERACT_DIST, tilePos,
  LOG1_KEY, LOG1_PATH, LOG2_KEY, LOG2_PATH, LOG3_KEY, LOG3_PATH,
  FRAME_FENCE_T1, FRAME_FENCE_T2, FRAME_FENCE_T3, FRAME_GATE,
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
    this.selectedNPC = null;
    this._focusedRemote = null;  // selected remote entity for chat/inspect
    this._armedAction = null;    // explicit click-to-act mode, e.g. attack
    this._playerKnockedOut = false;
    this._contextMenuEls = null;
    this._contextMenuBounds = null;
    this._overhearInterjectCooldowns = {};
    this._remotePlayers = {};

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
    this._inventoryOpen = false;
    this._inventoryEls = [];
    this._hotbarItems = [
      { id: 'log', label: 'Log', frame: 526, action: 'drop_log' },
      { id: 'gate', label: 'Gate', frame: FRAME_GATE, action: 'place_gate', cost: 10 },
    ];
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

      if (isRightClick) {
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

    // Number keys — hotbar actions (1-5)
    this.input.keyboard.on('keydown', (event) => {
      if (this.chatBox?.isOpen() || this._namingNPC || this._escMenuOpen || this._inventoryOpen || this._playerKnockedOut) return;
      const slot = parseInt(event.key, 10);
      if (slot >= 1 && slot <= 5) {
        this._useHotbarSlot(slot - 1);
      }
    });

    // I key — toggle inventory
    this.input.keyboard.on('keydown-I', () => {
      if (this.chatBox?.isOpen() || this._namingNPC || this._escMenuOpen || this._playerKnockedOut) return;
      this._toggleInventory();
    });

    // Escape key — toggle pause/menu
    this._escMenuOpen = false;
    this._escMenuEls = null;
    this.input.keyboard.on('keydown-ESC', () => {
      if (this.chatBox?.isOpen() || this._namingNPC) return;
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
        this.player.hp = me.hp ?? this.player.hp;
        this.player.maxHp = me.maxHp ?? this.player.maxHp;
        this.player.str = me.str ?? this.player.str;
        this.player.def = me.def ?? this.player.def;
        this.player.level = me.level ?? this.player.level;
        this.player.xp = me.xp ?? this.player.xp;
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
    // ── Send input to server + client-side prediction ─────────────────────────
    if (this._conn.connected && !this.chatBox?.isOpen() && !this.player._punching && !this._namingNPC && !this._playerDead && !this._playerKnockedOut && !this._escMenuOpen) {
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

    // Update target unit frame
    this._updateTargetFrame();
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
    this._lastServerState = data;
    // Don't process state until we know our player ID
    if (this.playerId === 'default') return;

    const players = data.players || {};

    // Update local player from server (authoritative position)
    const me = players[this.playerId];
    if (me) {
      // Smooth lerp to server position (client prediction reconciliation)
      this.player.x += (me.x - this.player.x) * 0.3;
      this.player.y += (me.y - this.player.y) * 0.3;
      this.player.logs = me.logs ?? 0;
      this.player.hp = me.hp ?? this.player.hp;
      this.player.maxHp = me.maxHp ?? this.player.maxHp;
      this.player.str = me.str ?? this.player.str;
      this.player.def = me.def ?? this.player.def;
      this.player.level = me.level ?? this.player.level;
      this.player.xp = me.xp ?? this.player.xp;
      if (me.carrying) {
        const offsetY = TILE_SIZE * 0.35;
        if (me.carrying.type === 'player') {
          const carried = this._remotePlayers?.[me.carrying.id];
          if (carried) {
            carried._targetX = this.player.x;
            carried._targetY = this.player.y + offsetY;
          }
        } else if (me.carrying.type === 'npc') {
          const key = `${me.carrying.owner}_${me.carrying.id}`;
          const carried = this._remoteNPCSprites?.[key];
          if (carried) {
            carried._targetX = this.player.x;
            carried._targetY = this.player.y + offsetY;
          }
        }
      }
    }

    // Update/create/remove remote players
    const seenPids = new Set();
    for (const [pid, pState] of Object.entries(players)) {
      if (pid === this.playerId) continue;
      seenPids.add(pid);

      let rp = this._remotePlayers[pid];
      if (!rp) {
        rp = new RemotePlayer(this, pState.x, pState.y, pid);
        this._remotePlayers[pid] = rp;
      }
      const wasDead = rp._dead;
      rp.applyState(pState);
      // Detect remote player just died
      if (pState.dead && !wasDead) {
        this._notifyNearbyNPCsOfKill('player', pid, null, rp.x, rp.y);
      }
    }

    // Remove disconnected remote players
    for (const pid of Object.keys(this._remotePlayers)) {
      if (!seenPids.has(pid)) {
        this._remotePlayers[pid].destroy();
        delete this._remotePlayers[pid];
      }
    }

    // Sync trees
    if (data.trees) {
      this._syncTrees(data.trees);
    }

    // Sync ground items
    this._syncGroundItems(data.ground_items || []);

    // Sync dummies
    this._syncDummies(data.dummies || {});

    // Sync fences/gates
    this._syncFences(data.fences || {});

    // Sync remote NPCs from other players
    this._syncRemoteNPCs(players);

    // Apply server-side damage and log theft to our own NPCs
    const myData = players[this.playerId];
    if (myData?.npcs) {
      if (!this._lastServerNPCLogs) this._lastServerNPCLogs = {};
      for (const npc of this.npcs) {
        const serverNPC = myData.npcs[npc.id];
        if (!serverNPC) continue;
        const wasKnocked = npc.isKnockedOut?.() || false;
        npc.maxHp = serverNPC.maxHp ?? npc.maxHp;
        npc.str = serverNPC.str ?? npc.str;
        npc.def = serverNPC.def ?? npc.def;
        npc.level = serverNPC.level ?? npc.level;
        npc.xp = serverNPC.xp ?? npc.xp;
        npc.maxLogs = serverNPC.maxLogs ?? npc.maxLogs;
        npc.setKnockedOut?.(!!serverNPC.knocked_out, {
          knockedUntil: serverNPC.knocked_until ?? 0,
          carriedBy: serverNPC.carried_by ?? null,
        });
        if (serverNPC.knocked_out && !wasKnocked) {
          this._handleOwnNPCKnockoutTransition(npc, serverNPC);
        } else if (!serverNPC.knocked_out && wasKnocked) {
          this._handleOwnNPCWakeTransition(npc, serverNPC);
        }
        if (!serverNPC.knocked_out && wasKnocked) {
          npc.hp = serverNPC.hp ?? npc.hp;
        }
        if (serverNPC.hp > npc.hp) {
          npc.hp = serverNPC.hp;
        }
        if (serverNPC.knocked_out || serverNPC.carried_by) {
          npc.x = serverNPC.x ?? npc.x;
          npc.y = serverNPC.y ?? npc.y;
        }

        // Detect HP damage from server
        if (serverNPC.hp < npc.hp) {
          const prevHp = npc.hp;
          npc.hp = serverNPC.hp;

          // If an attacker is stamped, use assessThreat to decide fight or flee
          const attackedBy = serverNPC._last_attacked_by;
          if (attackedBy && attackedBy.id !== this.playerId) {
            const isNpcAttacker = attackedBy.type === 'npc';
            const relKey = isNpcAttacker ? `npc:${attackedBy.id}` : attackedBy.id;

            // Build attacker info for assessThreat
            let attackerInfo;
            if (isNpcAttacker) {
              const spriteKey = attackedBy.owner ? `${attackedBy.owner}_${attackedBy.id}` : attackedBy.id;
              const rnpc = this._remoteNPCSprites[spriteKey];
              attackerInfo = {
                type: 'npc', id: attackedBy.id,
                level: rnpc?.level, str: rnpc?.str, def: rnpc?.def,
                hp: rnpc?.hp, maxHp: rnpc?.maxHp,
              };
            } else {
              const rp = this._remotePlayers[attackedBy.id];
              attackerInfo = {
                type: 'player', id: attackedBy.id,
                level: rp?.level, str: rp?.str, def: rp?.def,
                hp: rp?._hp, maxHp: rp?._maxHp,
              };
            }

            // Push 'attacked' event to brain
            const brain = this._npcBrains.get(npc.id);
            if (brain) {
              brain.pushEvent({
                type: 'attacked',
                attacker_type: attackedBy.type,
                attacker_id: attackedBy.id,
                damage: prevHp - npc.hp,
                hp_remaining: npc.hp,
              });
            }

            // Apply emotion based on damage severity
            const hpPct = npc.hp / npc.maxHp;
            if (hpPct > 0) {
              // Grow anger toward attacker (being hit makes you mad)
              npc.applyEmotionDeltas({ anger: 0.12, fear: 0.05 }, relKey);

              const assessment = npc.assessThreat(attackerInfo);
              const runner = this._taskRunners.get(npc.id);
              if (runner) {
                if (assessment.action === 'fight') {
                  npc.applyEmotionDeltas({ anger: 0.15, fear: -0.1 }, relKey);
                  npc.showBubble(`You'll regret that!`, 3000);
                  if (isNpcAttacker) {
                    runner.setTasks([{
                      task: 'attack_npc',
                      target_owner: attackedBy.owner,
                      target_npc_id: attackedBy.id,
                    }]);
                  } else {
                    runner.setTasks([{ task: 'attack_player', target_id: attackedBy.id }]);
                  }
                } else {
                  npc.applyEmotionDeltas({ fear: 0.25, anger: -0.1 }, relKey);
                  npc.showBubble(`I can't take much more of this!`, 3000);
                  runner.setTasks([{
                    task: 'flee_player',
                    target_id: relKey,
                    target_owner: attackedBy.owner,
                    target_npc_id: isNpcAttacker ? attackedBy.id : null,
                  }]);
                }
              }
            }
          }

          if (serverNPC.dead && !npc.isDead()) {
            npc._triggerDeath();
            // Our own NPC was killed — notify other local NPCs
            this._notifyNearbyNPCsOfKill('own_npc', this.playerId, npc.id, npc.x, npc.y);
          }
        }

        // Detect log theft — only when server value *dropped* from its previous known value
        const serverLogs = serverNPC.logs ?? 0;
        const prevServerLogs = this._lastServerNPCLogs[npc.id] ?? serverLogs;
        if (serverLogs < prevServerLogs) {
          // Skip if NPC voluntarily gave logs to the player
          if (npc._givingLogs) {
            npc._givingLogs = false;
          } else {
            const stolen = prevServerLogs - serverLogs;
            npc.logs = Math.max(0, npc.logs - stolen);

            // Identify the thief from server-stamped data
            const robbedBy = serverNPC._last_robbed_by;
            let thiefName = 'Someone';
            let thiefNpcId = null;
            if (robbedBy && robbedBy.npc_id) {
              thiefNpcId = robbedBy.npc_id;
              // Try to find the thief's display name from remote NPC sprites
              const thiefKey = `${robbedBy.owner}_${robbedBy.npc_id}`;
              const thiefSprite = this._remoteNPCSprites?.[thiefKey];
              thiefName = thiefSprite?.getName?.() || `${robbedBy.owner}'s NPC`;
            }

            const robbedLine = `${thiefName} stole ${stolen} log${stolen > 1 ? 's' : ''} from me!`;
            npc.showBubble(robbedLine, 4000, { silent: true });
            this._addNPCSpeechToChat(npc, robbedLine, '#ffaaaa');

            // Push grudge event to brain
            const brain = this._npcBrains?.get(npc.id);
            const relKey = thiefNpcId ? `npc:${thiefNpcId}` : 'strangers';
            if (brain) {
              brain.pushEvent({
                type: 'robbed',
                text: `${thiefName} stole ${stolen} log(s) from me!`,
                importance: 0.9,
              });
              npc.applyEmotionDeltas({ anger: 0.15, trust: -0.1 }, relKey);
            }
            npc.addMemory(
              `${thiefName} stole ${stolen} log(s) from me while I was gathering wood.`,
              'event', relKey, 0.9
            );
          }
        }
        this._lastServerNPCLogs[npc.id] = serverLogs;
      }
    }

    // Handle local player death from server
    if (me?.dead && !this._playerDead) {
      this._playerDead = true;
      this._notifyNearbyNPCsOfKill('own_player', this.playerId, null, this.player.x, this.player.y);
      this._showDeathScreen();
    } else if (me && !me.dead && this._playerDead) {
      this._playerDead = false;
      this._hideDeathScreen();
    }
  }

  _syncTrees(serverTrees) {
    if (!serverTrees) return;
    for (const st of serverTrees) {
      const tree = this.trees[st.id];
      if (!tree) continue;
      tree.setChopped(st.chopped);
    }
  }

  _syncGroundItems(serverItems) {
    const seenIds = new Set();
    for (const si of serverItems) {
      seenIds.add(si.id);
      if (!this._groundItemSprites[si.id]) {
        // Create visual for this ground item
        const gi = new GroundItem(this, si.x, si.y, si.resource, si.amount, !!si._placed);
        gi._serverId = si.id;
        this._groundItemSprites[si.id] = gi;
      } else {
        // Update amount (log stacking)
        this._groundItemSprites[si.id].updateAmount(si.amount);
      }
    }

    // Remove items no longer on server (picked up)
    for (const [id, gi] of Object.entries(this._groundItemSprites)) {
      if (!seenIds.has(id)) {
        // Remove from groundItems array
        const idx = this.groundItems.indexOf(gi);
        if (idx >= 0) this.groundItems.splice(idx, 1);
        gi.destroy();
        delete this._groundItemSprites[id];
      }
    }
  }

  _syncDummies(serverDummies) {
    const seenIds = new Set();
    for (const [did, sd] of Object.entries(serverDummies)) {
      seenIds.add(did);
      let dummy = this._dummySprites[did];
      if (!dummy) {
        // Create visual dummy
        dummy = new TrainingDummy(this, sd.x, sd.y, Math.ceil(sd.maxHp / 5));
        dummy._serverId = did;
        this._dummySprites[did] = dummy;
        this.dummies.push(dummy);
      }
      // Sync HP
      dummy.hp = sd.hp;
      dummy.maxHp = sd.maxHp;
      dummy._updateHpBar();
    }

    // Remove dummies not on server
    for (const [did, dummy] of Object.entries(this._dummySprites)) {
      if (!seenIds.has(did)) {
        const idx = this.dummies.indexOf(dummy);
        if (idx >= 0) this.dummies.splice(idx, 1);
        dummy.destroy();
        delete this._dummySprites[did];
      }
    }
  }

  _syncFences(serverFences) {
    const seenIds = new Set();
    for (const [fid, sf] of Object.entries(serverFences)) {
      seenIds.add(fid);
      let fence = this._fenceSprites[fid];
      if (!fence) {
        fence = new Fence(this, sf.x, sf.y, sf);
        this._fenceSprites[fid] = fence;
      }
      fence.applyState(sf);
    }

    // Remove fences not on server (destroyed)
    for (const [fid, fence] of Object.entries(this._fenceSprites)) {
      if (!seenIds.has(fid)) {
        fence.destroy();
        delete this._fenceSprites[fid];
      }
    }
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
    const seenKeys = new Set();
    for (const [pid, pState] of Object.entries(players)) {
      if (pid === this.playerId) continue;
      const npcs = pState.npcs || {};
      for (const [npcId, npcState] of Object.entries(npcs)) {
        const key = `${pid}_${npcId}`;
        seenKeys.add(key);
        let rnpc = this._remoteNPCSprites[key];
        if (!rnpc) {
          rnpc = new RemoteNPC(this, npcState.x, npcState.y, npcId, pid, npcState.name);
          this._remoteNPCSprites[key] = rnpc;
        }
        const wasDead = rnpc._dead;
        const wasKnocked = rnpc.isKnockedOut?.() || false;
        rnpc.applyState(npcState);
        // Apply owner's chat color to NPC labels
        const ownerColor = pState.chatColor || '#cccccc';
        rnpc.setOwnerColor(ownerColor);
        if (npcState.knocked_out && !wasKnocked) {
          rnpc._koOrigin = { x: npcState.x ?? rnpc.x, y: npcState.y ?? rnpc.y };
        } else if (!npcState.knocked_out && wasKnocked) {
          this._handleRemoteNPCWakeTransition(rnpc, npcState);
        }
        // Detect remote NPC just died
        if (npcState.dead && !wasDead) {
          this._notifyNearbyNPCsOfKill('npc', pid, npcId, rnpc.x, rnpc.y);
        }
      }
    }

    // Remove remote NPCs no longer present
    for (const [key, rnpc] of Object.entries(this._remoteNPCSprites)) {
      if (!seenKeys.has(key)) {
        rnpc.destroy();
        delete this._remoteNPCSprites[key];
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

  async _loadMap() {
    try {
      const res = await fetch(`${API_BASE}/load-map?name=level1`);
      if (!res.ok) throw new Error(`Map load failed: ${res.status}`);
      const mapData = await res.json();

      const { treePositions, width, height } = buildTilemapFromData(this, mapData);

      // Update world bounds to match map
      this._mapCols = width;
      this._mapRows = height;
      const worldW = width * TILE_SIZE;
      const worldH = height * TILE_SIZE;
      this.physics.world.setBounds(0, 0, worldW, worldH);
      this.cameras.main.setBounds(0, 0, worldW, worldH);

      // Spawn trees at positions found in the map
      this._spawnTreesAt(treePositions);

      console.log(`[map] Loaded level1: ${width}x${height}, ${treePositions.length} trees`);
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
    let runner = this._taskRunners.get(npc.id);
    if (!runner) {
      runner = new NPCTaskRunner(this, npc);
      this._taskRunners.set(npc.id, runner);
    }
    runner.setTasks(commands);

    // Notify brain that player issued an explicit command — pause autonomous decisions
    const brain = this._npcBrains.get(npc.id);
    if (brain) {
      brain.onPlayerCommand();
      brain.pushEvent({
        type: 'command',
        text: `Player commanded: ${commands[0]?.task || 'unknown'}`,
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

  _isPointerInWorldViewport(ptr) {
    const vp = this.cameras.main?.viewport;
    if (!vp) return true; // fallback if camera not ready
    return ptr.x >= vp.x && ptr.x <= vp.x + vp.width && ptr.y >= vp.y && ptr.y <= vp.y + vp.height;
  }

  // ── Player Unit Frame (top-left) ──────────────────────────────────────────

  _buildPlayerFrame() {
    const s = PLAYER_FRAME_SCALE;
    const x = 10, y = 10, w = Math.round(510 * s), h = Math.round(150 * s);

    // Background panel
    this._pf_bg = this.addHud(this.add.rectangle(x + w / 2, y + h / 2, w, h, 0x111122, 0.88)
      .setStrokeStyle(2, 0x334466).setDepth(50));

    // Portrait — player sprite face-down frame
    const portraitSize = Math.round(96 * s);
    const portraitPad = Math.round(18 * s);
    const portraitX = x + portraitPad + portraitSize / 2;
    const portraitY = y + h / 2;
    this._pf_portrait = this.addHud(
      this.add.sprite(portraitX, portraitY, PLAYER_KEY, 0)
        .setScale(4.2 * s).setDepth(51)
    );
    // Portrait border
    this._pf_portraitBorder = this.addHud(
      this.add.rectangle(portraitX, portraitY, portraitSize, portraitSize, 0x000000, 0)
        .setStrokeStyle(2, 0x556688).setDepth(51)
    );

    const textX = x + portraitPad + portraitSize + portraitPad;

    // Name
    this._pf_name = this.addHud(this.add.text(textX, y + 12, '', {
      fontSize: `${Math.round(24 * s)}px`, color: '#ffffff', fontStyle: 'bold',
    }).setDepth(51));

    // Level
    this._pf_level = this.addHud(this.add.text(x + w - 18, y + 12, '', {
      fontSize: `${Math.round(20 * s)}px`, color: '#aabb99',
    }).setDepth(51).setOrigin(1, 0));

    // HP bar
    const barX = textX, barY = y + Math.round(48 * s), barW = w - textX + x - Math.round(20 * s), barH = Math.round(30 * s);
    this._pf_hpBg = this.addHud(this.add.rectangle(barX + barW / 2, barY + barH / 2, barW, barH, 0x331111)
      .setStrokeStyle(1, 0x442222).setDepth(51));
    this._pf_hpBar = this.addHud(this.add.rectangle(barX, barY, barW, barH, 0x44cc44)
      .setOrigin(0, 0).setDepth(52));
    this._pf_hpText = this.addHud(this.add.text(barX + barW / 2, barY + barH / 2, '', {
      fontSize: `${Math.round(20 * s)}px`, color: '#ffffff', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(53));
    this._pf_barW = barW;
    this._pf_barH = barH;

    // Stats line
    this._pf_stats = this.addHud(this.add.text(textX, y + Math.round(87 * s), '', {
      fontSize: `${Math.round(20 * s)}px`, color: '#99aacc',
    }).setDepth(51));

    // XP line
    this._pf_xp = this.addHud(this.add.text(textX, y + Math.round(117 * s), '', {
      fontSize: `${Math.round(18 * s)}px`, color: '#778899',
    }).setDepth(51));
  }

  _updatePlayerFrame() {
    const p = this.player;
    this._pf_name.setText(this.playerId || 'Player');
    this._pf_level.setText(`Lv ${p.level}`);

    const hpPct = p.hp / p.maxHp;
    this._pf_hpBar.setDisplaySize(this._pf_barW * Math.max(0, hpPct), this._pf_barH);
    const hpColor = hpPct > 0.5 ? 0x44cc44 : hpPct > 0.25 ? 0xddaa22 : 0xcc3333;
    this._pf_hpBar.setFillStyle(hpColor);
    this._pf_hpText.setText(`${p.hp} / ${p.maxHp}`);

    this._pf_stats.setText(`STR: ${p.str}   DEF: ${p.def}   Logs: ${p.logs}`);
    this._pf_xp.setText(`XP: ${p.xp} / ${p.level * 20}`);
  }

  // ── Target Unit Frame (top-center, shows selected entity) ─────────────────

  _updateTargetFrame() {
    const target = this._focusedRemote || this.selectedNPC;

    if (!target || target.isDead?.()) {
      this._hideTargetFrame();
      return;
    }

    if (!this._targetFrame) this._buildTargetFrame();

    let name = '', hp = 0, maxHp = 1, spriteKey = '', frame = 0;
    let extra = '';

    if (target.playerId) {
      name = target.playerId;
      hp = target._hp ?? 0;
      maxHp = target._maxHp ?? 1;
      spriteKey = PLAYER_KEY;
    } else if (target.ownerPid) {
      name = `${target.getName?.()} [${target.ownerPid}]`;
      hp = target.hp ?? 0;
      maxHp = target.maxHp ?? 1;
      spriteKey = NPC_KEY;
      extra = `STR: ${target.str ?? '?'}  DEF: ${target.def ?? '?'}  Logs: ${target.logs ?? 0}`;
    } else if (target.getName) {
      name = target.getName();
      hp = target.hp ?? 0;
      maxHp = target.maxHp ?? 1;
      spriteKey = NPC_KEY;
      extra = `STR: ${target.str ?? '?'}  DEF: ${target.def ?? '?'}  Logs: ${target.logs ?? 0}`;
    }

    this._tf_name.setText(name);
    if (target.isKnockedOut?.()) {
      this._tf_name.setText(`${name} [KO]`);
    }
    const hpPct = maxHp > 0 ? hp / maxHp : 0;
    this._tf_hpBar.setDisplaySize(this._tf_barW * Math.max(0, hpPct), this._tf_barH);
    const hpColor = hpPct > 0.5 ? 0x44cc44 : hpPct > 0.25 ? 0xddaa22 : 0xcc3333;
    this._tf_hpBar.setFillStyle(hpColor);
    this._tf_hpText.setText(`${hp} / ${maxHp}`);
    this._tf_extra.setText(extra);

    // Show soul/relationship info for NPCs
    let soulInfo = '';
    if (target.soul && target._getRelationship) {
      // Own NPC — pull from local soul
      const es = target.getEmotionalState(this.playerId);
      const relLabel = target.getRelationshipLabel?.(this.playerId) || '?';
      soulInfo = [
        `Feels: ${relLabel}`,
        `Trust ${es.trust.toFixed(2)}   Fear ${es.fear.toFixed(2)}   Anger ${es.anger.toFixed(2)}`,
        `Coop ${target.soul.personality.cooperation.toFixed(2)}   Aggro ${target.soul.personality.aggression.toFixed(2)}`,
      ].join('\n');
    } else if (target._soul) {
      // Remote NPC — pull from synced soul data
      const rel = target._soul[this.playerId];
      const pers = target._personality;
      if (rel) {
        soulInfo = [
          `Feels: ${rel.label}`,
          `Trust ${rel.trust.toFixed(2)}   Fear ${rel.fear.toFixed(2)}   Anger ${rel.anger.toFixed(2)}`,
        ].join('\n');
        if (pers) soulInfo += `\nCoop ${pers.cooperation.toFixed(2)}   Aggro ${pers.aggression.toFixed(2)}`;
      } else if (pers) {
        soulInfo = `Coop ${pers.cooperation.toFixed(2)}   Aggro ${pers.aggression.toFixed(2)}`;
      }
    }
    this._tf_soul.setText(soulInfo);

    // Reposition hint below soul text and resize background to fit
    const soulBottom = soulInfo ? this._tf_soul.y + this._tf_soul.height + 4 : this._tf_extra.y + this._tf_extra.height + 4;
    this._tf_hint.setY(soulBottom);
    const baseY = this._tfBaseY ?? 10;
    const totalH = soulBottom + this._tf_hint.height + 8 - baseY;
    this._tf_bg.setSize(this._tf_bg.width, totalH);
    this._tf_bg.setPosition(this._tf_bg.x, baseY + totalH / 2);

    if (this._tf_portrait.texture.key !== spriteKey) {
      this._tf_portrait.setTexture(spriteKey, frame);
    }

    const borderColor = target === this._focusedRemote ? 0xff5555 : 0x44eeff;
    this._tf_portraitBorder.setStrokeStyle(3, borderColor);
    this._tf_bg.setStrokeStyle(3, borderColor, 0.95);
    if (target.ownerPid) this._tf_hint.setText(this._armedAction === 'attack' ? 'Attack armed - left click a red target' : 'Left click selects, right click opens actions');
    else if (target.playerId) this._tf_hint.setText(this._armedAction === 'attack' ? 'Attack armed - left click a red target' : 'Right click opens actions');
    else this._tf_hint.setText('Left click selects, right click opens actions');

    for (const el of this._targetFrameElements) el.setVisible(true);
  }

  _buildTargetFrame() {
    const s = PLAYER_FRAME_SCALE * TARGET_FRAME_RELATIVE_TO_PLAYER;
    const x = this._screenWidth() - RIGHT_HUD_MARGIN + 12;
    const y = TOP_HUD_MARGIN + 12;
    const w = RIGHT_HUD_MARGIN - 24;
    const h = Math.round(270 * s);

    const els = [];
    const add = (obj) => { this.addHud(obj); els.push(obj); return obj; };
    this._tfBaseY = y;

    this._tf_bg = add(this.add.rectangle(x + w / 2, y + h / 2, w, h, 0x111122, 0.88)
      .setStrokeStyle(2, 0x334466).setDepth(50)
      .setInteractive({ useHandCursor: true }));
    this._tf_bg.on('pointerdown', () => {
      if (this.selectedNPC && !this._focusedRemote) this._openNPCDetail(this.selectedNPC);
    });

    const portraitSize = Math.round(92 * s);
    const portraitPad = Math.round(16 * s);
    const portraitX = x + portraitPad + portraitSize / 2;
    const portraitY = y + Math.round(78 * s);
    this._tf_portrait = add(
      this.add.sprite(portraitX, portraitY, PLAYER_KEY, 0).setScale(3.5 * s).setDepth(51)
    );
    this._tf_portraitBorder = add(
      this.add.rectangle(portraitX, portraitY, portraitSize, portraitSize, 0x000000, 0)
        .setStrokeStyle(2, 0x556688).setDepth(51)
    );

    const textX = x + portraitPad + portraitSize + portraitPad;
    const textMaxW = w - (textX - x) - Math.round(18 * s);

    this._tf_name = add(this.add.text(textX, y + Math.round(10 * s), '', {
      fontSize: `${Math.round(22 * s)}px`, color: '#ffffff', fontStyle: 'bold',
      wordWrap: { width: textMaxW },
    }).setDepth(51));

    const barX = textX, barY = y + Math.round(46 * s);
    this._tf_barW = textMaxW;
    this._tf_barH = Math.round(26 * s);
    this._tf_hpBg = add(this.add.rectangle(barX + this._tf_barW / 2, barY + this._tf_barH / 2, this._tf_barW, this._tf_barH, 0x331111)
      .setStrokeStyle(1, 0x442222).setDepth(51));
    this._tf_hpBar = add(this.add.rectangle(barX, barY, this._tf_barW, this._tf_barH, 0x44cc44)
      .setOrigin(0, 0).setDepth(52));
    this._tf_hpText = add(this.add.text(barX + this._tf_barW / 2, barY + this._tf_barH / 2, '', {
      fontSize: `${Math.round(16 * s)}px`, color: '#ffffff', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(53));

    this._tf_extra = add(this.add.text(textX, y + Math.round(86 * s), '', {
      fontSize: `${Math.round(15 * s)}px`, color: '#a8c0df',
      wordWrap: { width: textMaxW },
    }).setDepth(51));

    this._tf_soul = add(this.add.text(textX, y + Math.round(122 * s), '', {
      fontSize: `${Math.round(14 * s)}px`, color: '#d2d9f0', lineSpacing: Math.max(2, Math.round(4 * s)),
      wordWrap: { width: textMaxW },
    }).setDepth(51));

    this._tf_hint = add(this.add.text(textX, y + Math.round(222 * s), 'Click panel for details · right click world target for actions', {
      fontSize: `${Math.round(13 * s)}px`, color: '#7f8fa8',
    }).setDepth(51));

    this._targetFrame = true;
    this._targetFrameElements = els;
  }

  _hideTargetFrame() {
    if (!this._targetFrame) return;
    for (const el of this._targetFrameElements) el.setVisible(false);
  }

  _getChatTarget() {
    if (this.selectedNPC?.isKnockedOut?.()) return null;
    if (this._focusedRemote?.ownerPid && !this._focusedRemote?.isKnockedOut?.()) return this._focusedRemote;
    return this.selectedNPC || null;
  }

  _buildTabCycleList() {
    const px = this.player?.x ?? 0;
    const py = this.player?.y ?? 0;
    const distToPlayer = (entity) => Phaser.Math.Distance.Between(px, py, entity.x, entity.y);

    const own = (this.npcs || [])
      .filter(n => !n.isDead?.() && !n.isKnockedOut?.())
      .map(entity => ({ kind: 'own_npc', entity, distance: distToPlayer(entity) }))
      .sort((a, b) => a.distance - b.distance);

    const remotePlayers = Object.values(this._remotePlayers || {})
      .filter(p => !p.isDead?.() && !p.isKnockedOut?.())
      .map(entity => ({ kind: 'remote_player', entity, distance: distToPlayer(entity) }));

    const remoteNpcs = Object.values(this._remoteNPCSprites || {})
      .filter(n => !n.isDead?.() && !n.isKnockedOut?.())
      .map(entity => ({ kind: 'remote_npc', entity, distance: distToPlayer(entity) }));

    const remote = [...remotePlayers, ...remoteNpcs]
      .sort((a, b) => a.distance - b.distance);

    return [...own, ...remote];
  }

  _clearSelection() {
    if (this.selectedNPC) this.selectedNPC.deselect();
    if (this._focusedRemote?.setSelected) this._focusedRemote.setSelected(false);
    this.selectedNPC = null;
    this._focusedRemote = null;
    this._hideNPCPanel();
  }

  _selectNPC(npc) {
    if (this.selectedNPC === npc && !this._focusedRemote) return;
    this._clearSelection();
    this.selectedNPC = npc;
    if (npc) {
      npc.select();
    }
  }

  _selectRemote(entity) {
    if (this._focusedRemote === entity && !this.selectedNPC) return;
    this._clearSelection();
    this._focusedRemote = entity;
    entity?.setSelected?.(true);
  }

  _handleOwnNPCPointerDown(npc, pointer) {
    const isRightClick = pointer.rightButtonDown() || pointer.button === 2;
    if (isRightClick) {
      this._selectNPC(npc);
      this._openContextMenu(npc, pointer);
      return;
    }

    this._closeContextMenu();
    if (this._armedAction) this._disarmActionMode();

    this._selectNPC(npc);
  }

  _handleRemoteEntityPointerDown(entity, pointer, event) {
    event?.stopPropagation?.();
    if (pointer._fgHandled) return;
    const isRightClick = pointer.rightButtonDown() || pointer.button === 2;
    if (isRightClick) {
      this._selectRemote(entity);
      this._openContextMenu(entity, pointer);
      pointer._fgHandled = true;
      return;
    }

    this._closeContextMenu();

    if (this._armedAction === 'attack') {
      pointer._fgHandled = true;
      if (this._isAttackableEntity(entity)) this._executeAttack(entity);
      this._disarmActionMode();
      return;
    }

    this._selectRemote(entity);
  }

  _isAttackableEntity(entity) {
    if (!entity || entity.isDead?.() || entity.isKnockedOut?.()) return false;
    return !!(entity.playerId || entity.ownerPid);
  }

  _executeAttack(entity) {
    if (this._playerKnockedOut || !this._isAttackableEntity(entity)) return;
    entity._onAttackClicked?.();
  }

  _armActionMode(action) {
    this._armedAction = action;
    this._closeContextMenu();
  }

  _disarmActionMode() {
    this._armedAction = null;
  }

  _refreshAttackIndicators() {
    const armed = this._armedAction === 'attack';
    for (const rp of Object.values(this._remotePlayers || {})) {
      rp.setAttackable?.(armed && !rp.isDead?.());
    }
    for (const rnpc of Object.values(this._remoteNPCSprites || {})) {
      rnpc.setAttackable?.(armed && !rnpc.isDead?.());
    }
  }

  _updateArmedStatus() {
    if (this._armedAction === 'attack') {
      this._armedStatus.setText('Attack Mode - left click a red target, Esc to cancel').setVisible(true);
    } else {
      this._armedStatus.setVisible(false);
    }
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
    this._closeContextMenu();
    const actions = this._buildContextActions(entity);
    if (actions.length === 0) return;

    const els = [];
    const add = (obj) => { this.addHud(obj); els.push(obj); return obj; };
    const rowH = 28;
    const width = 150;
    const height = 10 + actions.length * rowH + 6;
    const W = this._screenWidth();
    const H = this._screenHeight();
    const px = Number.isFinite(pointer?.x) ? pointer.x : pointer?.downX;
    const py = Number.isFinite(pointer?.y) ? pointer.y : pointer?.downY;
    const x = Phaser.Math.Clamp((px ?? W / 2) + 10, 12, W - width - 12);
    const y = Phaser.Math.Clamp((py ?? H / 2) + 10, 12, H - height - 12);
    this._contextMenuBounds = { x, y, width, height };

    add(this.add.rectangle(x + width / 2, y + height / 2, width, height, 0x111122, 0.96)
      .setStrokeStyle(2, 0x553333).setDepth(70));

    actions.forEach((item, idx) => {
      const by = y + 8 + idx * rowH;
      const btn = add(this.add.rectangle(x + width / 2, by + 10, width - 12, 22, 0x223344, 1)
        .setDepth(71).setInteractive({ useHandCursor: true }));
      const lbl = add(this.add.text(x + 12, by + 3, item.label, {
        fontSize: '15px', color: '#dde8ff',
      }).setDepth(72));
      btn.on('pointerover', () => btn.setFillStyle(0x335566));
      btn.on('pointerout', () => btn.setFillStyle(0x223344));
      btn.on('pointerdown', () => {
        this._closeContextMenu();
        item.action();
      });
    });

    this._contextMenuEls = els;
  }

  _closeContextMenu() {
    this._contextMenuBounds = null;
    if (!this._contextMenuEls) return;
    for (const el of this._contextMenuEls) {
      this.removeHud?.(el);
      el.destroy();
    }
    this._contextMenuEls = null;
  }

  _isPointerOverContextMenu(ptr) {
    if (!this._contextMenuBounds) return false;
    const { x, y, width, height } = this._contextMenuBounds;
    return ptr.x >= x && ptr.x <= x + width && ptr.y >= y && ptr.y <= y + height;
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
    if (this._adminOpen) {
      this._closeAdmin();
    } else {
      this._openAdmin();
    }
  }

  _openAdmin() {
    this._adminOpen = true;
    const W = this._screenWidth();
    const H = this._screenHeight();
    const panelW = 240;
    const panelH = 316;
    const px = W / 2 - panelW / 2;
    const py = H / 2 - panelH / 2;

    const admin = (field, value) => this._conn.send({ type: 'admin', field, value });
    const items = [
      { label: '+10 Logs',       action: () => admin('logs', 10) },
      { label: '+50 Logs',       action: () => admin('logs', 50) },
      { label: 'Full HP',        action: () => admin('full_hp', 0) },
      { label: '+5 Max HP',      action: () => admin('maxHp', 5) },
      { label: '+1 STR',         action: () => admin('str', 1) },
      { label: '+1 DEF',         action: () => admin('def', 1) },
      { label: 'Spawn NPC',      action: () => { this._adminSpawnNPC(); } },
      { label: 'Heal NPC',       action: () => { for (const n of this.npcs) { n.hp = n.maxHp; } } },
      { label: 'Spawn Dummy',    action: () => { this._conn.send({ type: 'build_dummy', logs: 20 }); } },
    ];

    const els = [];

    const bg = this.addHud(this.add.rectangle(px, py, panelW, panelH, 0x111122, 0.95)
      .setDepth(60).setOrigin(0, 0));
    els.push(bg);

    const title = this.addHud(this.add.text(px + panelW / 2, py + 12, 'ADMIN  [Q to close]', {
      fontSize: '13px', color: '#ffcc44',
    }).setDepth(61).setOrigin(0.5, 0));
    els.push(title);

    const btnH = 28;
    const btnW = panelW - 24;
    items.forEach((item, i) => {
      const by = py + 38 + i * (btnH + 4);
      const btn = this.addHud(this.add.rectangle(px + 12, by, btnW, btnH, 0x223344, 1)
        .setDepth(61).setOrigin(0, 0)
        .setInteractive({ useHandCursor: true }));

      const lbl = this.addHud(this.add.text(px + 12 + btnW / 2, by + btnH / 2, item.label, {
        fontSize: '13px', color: '#ccddff',
      }).setDepth(62).setOrigin(0.5, 0.5));

      btn.on('pointerover', () => { btn.setFillStyle(0x335566); lbl.setColor('#ffffff'); });
      btn.on('pointerout',  () => { btn.setFillStyle(0x223344); lbl.setColor('#ccddff'); });
      btn.on('pointerdown', () => { item.action(); });

      els.push(btn, lbl);
    });

    this._adminPanel = els;
  }

  _closeAdmin() {
    this._adminOpen = false;
    if (this._adminPanel) {
      for (const el of this._adminPanel) { this.removeHud(el); el.destroy(); }
      this._adminPanel = null;
    }
  }

  _adminSpawnNPC() {
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
    this._conn.send({ type: 'register_npc', npc_id: npc.id });
    npc.showBubble('Admin spawned me!', 3000);
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
        str: npc.str, def: npc.def,
        level: npc.level, xp: npc.xp,
        name: npc.getName(),
        dead: npc.isDead(),
        knocked_out: npc.isKnockedOut?.() || false,
        owner: this.playerId,
        logs: npc.logs, maxLogs: npc.maxLogs,
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
    const { from, from_color, target_npc_id, text } = data;
    // Find our local NPC by ID
    const npc = this.npcs.find(n => n.id === target_npc_id);
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
    const { from_owner, npc_id, npc_name, reply, emotion_deltas } = data;
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
    if (!speakerNpc || !topicEntity?.id) return;

    const overhearers = this._findOverhearTargets(speakerNpc, topicEntity);
    if (overhearers.length === 0) return;

    const sentiment = this._analyzeOverheardSentiment(playerText, npcReply, topicEntity.name || '');
    if (sentiment.kind === 'neutral') return;

    const transcript = `${playerId || 'Player'}: ${playerText} | ${speakerNpc.getName?.() || 'NPC'}: ${npcReply}`.slice(0, 180);

    for (const heard of overhearers) {
      if (heard.kind === 'local_npc') {
        const targetNpc = heard.entity;
        targetNpc.addMemory(
          `Overheard ${transcript}`,
          'dialogue',
          playerId || 'default',
          sentiment.importance
        );
        targetNpc.applyEmotionDeltas(sentiment.playerDeltas, playerId || 'default');
        if (speakerNpc?.id && speakerNpc !== targetNpc) {
          targetNpc.applyEmotionDeltas(sentiment.npcDeltas, `npc:${speakerNpc.id}`);
        }
        if (Math.random() < sentiment.interjectChance) {
          this._maybeInterjectOverheardConversation({
            overhearer: targetNpc,
            speakerNpc,
            playerText,
            npcReply,
            topicEntity,
            playerId: playerId || 'default',
            sentiment,
          });
        } else if (Math.random() < sentiment.replyChance) {
          targetNpc.showBubble(sentiment.localBubble, 2600, { silent: true });
        }
      } else if (heard.kind === 'remote_npc') {
        if (Math.random() < sentiment.replyChance) {
          heard.entity.showBubble(sentiment.remoteBubble, 2400);
        }
      }
    }
  }

  _findOverhearTargets(speakerNpc, topicEntity) {
    const results = [];
    const heardRange = TILE_SIZE * 10;
    const inRange = (ent) => Phaser.Math.Distance.Between(speakerNpc.x, speakerNpc.y, ent.x, ent.y) <= heardRange;

    if (topicEntity.type === 'npc') {
      const local = this.npcs.find(n => `npc:${n.id}` === topicEntity.id && n !== speakerNpc && !n.isDead?.());
      if (local && inRange(local)) results.push({ kind: 'local_npc', entity: local });

      const remote = Object.values(this._remoteNPCSprites || {}).find(r => `npc:${r.npcId}` === topicEntity.id && !r.isDead?.());
      if (remote && inRange(remote)) results.push({ kind: 'remote_npc', entity: remote });
    } else if (topicEntity.type === 'player') {
      for (const rnpc of Object.values(this._remoteNPCSprites || {})) {
        if (rnpc.ownerPid === topicEntity.id && !rnpc.isDead?.() && inRange(rnpc)) {
          results.push({ kind: 'remote_npc', entity: rnpc });
        }
      }
      for (const npc of this.npcs) {
        if (npc !== speakerNpc && !npc.isDead?.() && inRange(npc) && npc.soul?.relationships?.[topicEntity.id]) {
          results.push({ kind: 'local_npc', entity: npc });
        }
      }
    }

    return results;
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
    if (!overhearer || overhearer.isDead?.()) return;

    const key = `${overhearer.id}|${topicEntity.id}|${playerId}`;
    const now = Date.now();
    const last = this._overhearInterjectCooldowns[key] ?? 0;
    if (now - last < 15000) return;
    this._overhearInterjectCooldowns[key] = now;

    try {
      const soulCtx = overhearer.getSoulContext(playerId || 'default');
      soulCtx.nearby_entities = this.chatBox?._buildNearbyContext(overhearer) || [];
      soulCtx.topic_entity = overhearer.getContextAboutEntity(topicEntity.id, topicEntity.name);
      soulCtx.system_note = [
        `You overheard ${playerId} talking with ${speakerNpc.getName?.() || 'another NPC'} about ${topicEntity.name}.`,
        'Give a single short interjection into the conversation.',
        'Keep it under 10 words.',
        'Do not describe actions or explain yourself.',
        'Only speak as the overhearing NPC.',
      ].join(' ');

      const prompt = `Overheard conversation:\n${playerId}: ${playerText}\n${speakerNpc.getName?.() || 'NPC'}: ${npcReply}\n\nInterject briefly.`;
      const data = await generateDialogue(soulCtx, prompt, {
        speakingPlayer: playerId || 'default',
        owner: this.playerId || 'default',
      });

      const line = (data?.dialogue || '').trim();
      if (!line || line === '...') return;

      const actual = data.emotion_deltas
        ? overhearer.applyEmotionDeltas(data.emotion_deltas, playerId || 'default')
        : null;
      const deltaStr = this._formatDeltas(actual);
      const bubbleText = deltaStr ? `${line}\n${deltaStr}` : line;
      overhearer.showBubble(bubbleText, deltaStr ? 7000 : 4500, { silent: true });
      this.chatBox?._addLog(`${overhearer.getName()}: ${line}`, '#ffccaa');
      overhearer.addMemory(
        `I interrupted after overhearing talk about ${topicEntity.name}: "${line}"`,
        'dialogue',
        playerId || 'default',
        Math.min(0.9, sentiment.importance + 0.08),
      );
    } catch {
      overhearer.showBubble(sentiment.localBubble, 2200, { silent: true });
    }
  }

  _analyzeOverheardSentiment(playerText, npcReply, topicName) {
    const text = `${playerText} ${npcReply}`.toLowerCase();
    const escapedName = String(topicName || '').toLowerCase();
    const directlyNamed = escapedName && text.includes(escapedName);
    if (!directlyNamed) {
      return { kind: 'neutral' };
    }

    const threat = /\b(kill|attack|hurt|smash|destroy|beat|rob|steal from)\b/i.test(text);
    const negative = /\b(hate|stupid|idiot|dumb|loser|trash|clanker|jerk|sucks?|thief|coward)\b/i.test(text) || threat;
    const positive = /\b(friend|ally|trust|like|good|nice|helpful|kind|brave|cool|best|loyal)\b/i.test(text);

    if (negative) {
      return {
        kind: 'negative',
        importance: threat ? 0.85 : 0.72,
        playerDeltas: { trust: -0.05, anger: 0.06, fear: threat ? 0.04 : 0.01 },
        npcDeltas: { trust: -0.02, anger: 0.03 },
        replyChance: threat ? 0.8 : 0.55,
        interjectChance: threat ? 0.45 : 0.25,
        localBubble: threat ? 'I heard that.' : 'Watch your mouth.',
        remoteBubble: threat ? 'Back off.' : 'I heard that.',
      };
    }
    if (positive) {
      return {
        kind: 'positive',
        importance: 0.62,
        playerDeltas: { trust: 0.04, anger: -0.02, fear: 0 },
        npcDeltas: { trust: 0.02, anger: -0.01 },
        replyChance: 0.35,
        interjectChance: 0.15,
        localBubble: 'Heh. Good.',
        remoteBubble: '...Noted.',
      };
    }

    return { kind: 'neutral' };
  }

  /**
   * Try to execute a coerced command from a non-owner player the NPC fears.
   * Uses simple pattern matching (same as ChatBox LOCAL_PATTERNS) — no LLM needed.
   */
  _tryExecuteCoercedCommand(npc, text, fromPlayerId) {
    const runner = this._taskRunners.get(npc.id);
    if (!runner) return;

    const lower = text.toLowerCase();

    // Give/drop logs
    if (/\b(give|hand|drop|surrender)\b.*\b(log|wood|stuff|inventory|item|everything)\b/i.test(lower) ||
        /\b(give|hand\s+over|drop)\b.*\b(me|here)\b/i.test(lower)) {
      const logCount = npc.logs;
      if (logCount > 0) {
        // Drop logs on the ground (NPC can't deliver to a remote player)
        npc.logs = 0;
        const conn = this._conn;
        if (conn?.connected) {
          conn.send({ type: 'admin', field: 'logs', value: -logCount }); // remove from NPC
          // Spawn ground items at NPC position
          conn.send({ type: 'drop_item', item: 'log', amount: logCount, x: npc.x, y: npc.y });
        }
        npc.showBubble(`F-fine! Take them! (dropped ${logCount} log${logCount > 1 ? 's' : ''})`, 5000, { silent: true });
        this.chatBox?._addLog(`${npc.getName()} dropped ${logCount} log${logCount > 1 ? 's' : ''} out of fear of ${fromPlayerId}!`, '#ff8866');
        // Send feedback to the threatening player
        this._conn?.send({
          type: 'chat_reply',
          to: fromPlayerId,
          npc_id: npc.id,
          npc_name: npc.getName(),
          reply: `*trembling* F-fine! Here! (dropped ${logCount} log${logCount > 1 ? 's' : ''})`,
          emotion_deltas: null,
        });
      } else {
        npc.showBubble(`I don't have any logs!`, 3000, { silent: true });
        this._conn?.send({
          type: 'chat_reply',
          to: fromPlayerId,
          npc_id: npc.id,
          npc_name: npc.getName(),
          reply: `I-I don't have anything! Please don't hurt me!`,
          emotion_deltas: null,
        });
      }
      runner.setTasks([{ task: 'idle' }]);
      return;
    }
    // Stop / idle
    if (/\b(stop|stay|wait|don't move|freeze)\b/i.test(lower)) {
      runner.setTasks([{ task: 'idle' }]);
      npc.showBubble(`O-okay! I won't move!`, 3000, { silent: true });
      this.chatBox?._addLog(`${npc.getName()} froze in fear of ${fromPlayerId}`, '#ff8866');
      return;
    }
    // Follow
    if (/\b(follow|come\s+with|come\s+here)\b/i.test(lower)) {
      runner.setTasks([{ task: 'idle' }]);
      npc.showBubble(`I-I can't leave my post...`, 3000, { silent: true });
      return;
    }
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

  _buildHotbar() {
    const W = this._screenWidth();
    const H = this._screenHeight();
    const slotSize = 72;
    const padding = 6;
    const items = this._hotbarItems;
    const totalW = items.length * (slotSize + padding) - padding;
    const rightPaneX = W - RIGHT_HUD_MARGIN + Math.floor((RIGHT_HUD_MARGIN - totalW) / 2);
    const startX = Math.max(W - RIGHT_HUD_MARGIN + 12, rightPaneX);
    const bottomMargin = 18;
    const y = H - slotSize - bottomMargin;

    // Clear old
    for (const el of this._hotbarEls) el.destroy();
    this._hotbarEls = [];

    const add = (obj) => { this.addHud(obj); this._hotbarEls.push(obj); return obj; };

    for (let i = 0; i < items.length; i++) {
      const x = startX + i * (slotSize + padding);
      const item = items[i];

      // Slot background
      add(this.add.rectangle(x + slotSize / 2, y + slotSize / 2, slotSize, slotSize, 0x111122, 0.85)
        .setStrokeStyle(1, 0x334466).setDepth(50));

      // Sprite icon
      add(this.add.image(x + slotSize / 2, y + slotSize / 2, SHEET_KEY, item.frame)
        .setScale(3).setDepth(51));

      // Key number
      add(this.add.text(x + 4, y + 3, `${i + 1}`, {
        fontSize: '15px', color: '#ffcc44', fontStyle: 'bold',
      }).setDepth(52));

      // Label
      add(this.add.text(x + slotSize / 2, y + slotSize - 3, item.label, {
        fontSize: '12px', color: '#aabbcc',
      }).setOrigin(0.5, 1).setDepth(52));

      // Count text (updated each frame)
      const countText = add(this.add.text(x + slotSize - 4, y + 3, '', {
        fontSize: '15px', color: '#ffffff', fontStyle: 'bold',
      }).setOrigin(1, 0).setDepth(52));
      item._countText = countText;
    }
  }

  _updateHotbar() {
    const p = this.player;
    if (!p) return;
    const logs = p.logs ?? 0;

    for (const item of this._hotbarItems) {
      if (!item._countText) continue;
      if (item.id === 'log') {
        item._countText.setText(logs > 0 ? `${logs}` : '');
      } else if (item.id === 'gate') {
        const canCraft = logs >= (item.cost || 10);
        item._countText.setText(canCraft ? '1' : '');
      }
    }
  }

  _useHotbarSlot(index) {
    const item = this._hotbarItems[index];
    if (!item) return;

    if (item.action === 'drop_log') {
      this._dropLog();
    } else if (item.action === 'place_gate') {
      this._placeGate();
    }
  }

  _dropLog() {
    const p = this.player;
    if (!p || this._playerDead) return;
    if ((p.logs ?? 0) < 1) {
      this.chatBox?._addLog('No logs to drop.', '#ff4444');
      return;
    }
    const conn = this._conn;
    if (conn?.connected) {
      conn.send({ type: 'drop_item', item: 'log', amount: 1 });
    }
  }

  _placeGate() {
    const p = this.player;
    if (!p || this._playerDead) return;
    if ((p.logs ?? 0) < 10) {
      this.chatBox?._addLog('Need 10 logs to build a gate.', '#ff4444');
      return;
    }
    const conn = this._conn;
    if (conn?.connected) {
      conn.send({ type: 'build_gate' });
      this.chatBox?._addLog('Building fence gate...', '#88bbff');
    }
  }

  // ── Inventory ───────────────────────────────────────────────────────────────

  _toggleInventory() {
    if (this._inventoryOpen) {
      this._closeInventory();
    } else {
      this._openInventory();
    }
  }

  _openInventory() {
    this._inventoryOpen = true;
    const W = this._screenWidth();
    const H = this._screenHeight();
    const panelW = 390, panelH = 300;
    const x = Math.floor(W / 2 - panelW / 2);
    const y = Math.floor(H / 2 - panelH / 2);

    const add = (obj) => { this.addHud(obj); this._inventoryEls.push(obj); return obj; };

    // Background
    add(this.add.rectangle(W / 2, H / 2, panelW, panelH, 0x111122, 0.95)
      .setStrokeStyle(2, 0x334466).setDepth(60));

    // Title
    add(this.add.text(W / 2, y + 18, 'Inventory [I]', {
      fontSize: '21px', color: '#ffcc44', fontStyle: 'bold',
    }).setOrigin(0.5, 0).setDepth(61));

    // Log count
    const logs = this.player?.logs ?? 0;
    add(this.add.text(x + 30, y + 60, `Logs: ${logs}`, {
      fontSize: '20px', color: '#ccaa77',
    }).setDepth(61));

    // Crafting recipes
    add(this.add.text(x + 30, y + 100, 'Crafting:', {
      fontSize: '18px', color: '#aabbcc', fontStyle: 'bold',
    }).setDepth(61));

    // Gate recipe
    const canGate = logs >= 10;
    const gateBtn = add(this.add.text(x + 45, y + 135, `[Gate] - 10 logs ${canGate ? '' : '(need more)'}`, {
      fontSize: '18px', color: canGate ? '#88bbff' : '#666666',
      backgroundColor: canGate ? '#22334488' : '#11111188',
      padding: { x: 8, y: 6 },
    }).setDepth(61));
    if (canGate) {
      gateBtn.setInteractive({ useHandCursor: true });
      gateBtn.on('pointerdown', () => {
        this._placeGate();
        this._closeInventory();
      });
      gateBtn.on('pointerover', () => gateBtn.setColor('#aaddff'));
      gateBtn.on('pointerout', () => gateBtn.setColor('#88bbff'));
    }

    // Instructions
    add(this.add.text(x + 30, y + 195, 'Drop logs on ground (key 1),\nthen tell NPC to build fence.\n3 logs on a tile = strongest fence.', {
      fontSize: '15px', color: '#667788', wordWrap: { width: panelW - 60 },
    }).setDepth(61));

    // Close hint
    add(this.add.text(W / 2, y + panelH - 18, 'Press I to close', {
      fontSize: '15px', color: '#556677',
    }).setOrigin(0.5, 1).setDepth(61));
  }

  _closeInventory() {
    this._inventoryOpen = false;
    for (const el of this._inventoryEls) el.destroy();
    this._inventoryEls = [];
  }
}
