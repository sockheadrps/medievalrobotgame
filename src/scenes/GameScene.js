import Phaser from 'phaser';
import { buildTilemap, buildWestZone } from '../systems/TilemapBuilder.js';
import { Inventory }       from '../systems/Inventory.js';
import { Player }          from '../entities/Player.js';
import { MotherMachine }   from '../entities/MotherMachine.js';
import { Tree }            from '../entities/Tree.js';
import { HUD }             from '../ui/HUD.js';
import { CraftingPanel }   from '../ui/CraftingPanel.js';
import { StoragePanel }    from '../ui/StoragePanel.js';
import { DevMenu }         from '../ui/DevMenu.js';
import { BuildMenu }       from '../ui/BuildMenu.js';
import { ContextMenu }     from '../ui/ContextMenu.js';
import { GridSystem }      from '../systems/GridSystem.js';
import { PlacementSystem } from '../systems/PlacementSystem.js';
import { GroundItem }      from '../entities/GroundItem.js';
import { Furnace }         from '../entities/Furnace.js';
import { FurnacePanel }    from '../ui/FurnacePanel.js';
import { Quarry }          from '../entities/Quarry.js';
import { OreCrusher }      from '../entities/OreCrusher.js';
import { SaveSystem }      from '../systems/SaveSystem.js';
import { Flywheel }        from '../entities/Flywheel.js';
import { Anvil }           from '../entities/Anvil.js';
import { NPC }             from '../entities/NPC.js';
import { npNPC } from '../entities/npNPC.js';
import { Chicken }         from '../entities/Chicken.js';
import { ChatBox }         from '../ui/ChatBox.js';
import { Bow, BOW_KEY, BOW_PATH } from '../entities/Bow.js';
import { ARROW_PROJ_KEY, ARROW_PROJ_PATH } from '../entities/ArrowProjectile.js';
import { NPCTaskRunner }   from '../systems/NPCTaskRunner.js';
import { SmithingPanel }   from '../ui/SmithingPanel.js';
import { SkillSystem }     from '../systems/SkillSystem.js';
import { SkillsPanel }     from '../ui/SkillsPanel.js';
import { NPCSkillsPanel }  from '../ui/NPCSkillsPanel.js';
import { NPCTaskPanel }    from '../ui/NPCTaskPanel.js';
import { HPBar }          from '../ui/HPBar.js';
import { MachinePanel }   from '../ui/MachinePanel.js';
import { NPCUpgradePanel } from '../ui/NPCUpgradePanel.js';
import { CombatSystem }   from '../systems/CombatSystem.js';
import { Enemy }          from '../entities/Enemy.js';
import { CraftingBench }  from '../entities/CraftingBench.js';
import { CraftingBenchPanel } from '../ui/CraftingBenchPanel.js';
import { PlacedStructure } from '../entities/PlacedStructure.js';
import { Door }           from '../entities/Door.js';
import { MineRock }      from '../entities/MineRock.js';
import { CrateFilterPanel } from '../ui/CrateFilterPanel.js';
import { NPCHUDPanel } from '../ui/NPCHUDPanel.js';
import { NPCCommandPanel }   from '../ui/NPCCommandPanel.js';
import { SocialChatPanel, triggerNPCThought } from '../ui/SocialChatPanel.js';
import { NPCSoulPanel }      from '../ui/NPCSoulPanel.js';
import { WoodCraftingTablePanel } from '../ui/WoodCraftingTablePanel.js';
import { getItem } from '../data/items.js';
import {
  TILE_SIZE, MAP_COLS, MAP_ROWS,
  SHEET_KEY, SHEET_PATH, SHEET_TILE, SHEET_SPACING,
  PLAYER_KEY, PLAYER_PATH, PLAYER_FRAME_W, PLAYER_FRAME_H,
  CHICKEN_KEY, CHICKEN_PATH, CHICKEN_FRAME_W, CHICKEN_FRAME_H,
  tilePos, WEST_ZONE_OFFSET_X, WEST_ZONE_COLS,
  CARRY_PER_ATHLETICS_LEVEL, BASE_CARRY_CAPACITY,
} from '../constants.js';

export class GameScene extends Phaser.Scene {
  constructor() {
    super({ key: 'GameScene' });
  }

  // ── preload ────────────────────────────────────────────────────────────────
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
    this.load.spritesheet(CHICKEN_KEY, CHICKEN_PATH, {
      frameWidth:  CHICKEN_FRAME_W,
      frameHeight: CHICKEN_FRAME_H,
    });
    this.load.image(BOW_KEY,        BOW_PATH);
    this.load.image(ARROW_PROJ_KEY, ARROW_PROJ_PATH);
  }

  // ── create ─────────────────────────────────────────────────────────────────
  create() {
    const worldW = MAP_COLS * TILE_SIZE;
    const worldH = MAP_ROWS * TILE_SIZE;
    const westZoneW = WEST_ZONE_COLS * TILE_SIZE;
    const totalW    = westZoneW + worldW;

    buildTilemap(this);
    buildWestZone(this);
    this.physics.world.setBounds(WEST_ZONE_OFFSET_X, 0, totalW, worldH);

    this.grid = new GridSystem();
    this.inventory = new Inventory();

    // Player spawns at tile (2,2)
    const playerStart = tilePos(2, 2);
    this.player = new Player(this, playerStart.x, playerStart.y);
    this.player.onInteract(() => this._handleInteract());

    // Bow
    this.bow = new Bow(this, this.player, this.cameras.main);

    this.labelsVisible = true;

    // X key — toggle bow
    this.input.keyboard.on('keydown-X', () => {
      if (this.chatBox?.isOpen() || this.dialoguePanel?.isOpen()) return;
      this.bow.toggle();
    });

    // Ctrl key — toggle entity name/status labels
    this.input.keyboard.on('keydown-CTRL', () => {
      this.labelsVisible = !this.labelsVisible;
      for (const npc of [...(this.npcs ?? []), ...(this.npNPCs ?? [])]) npc.refreshLabels(this.labelsVisible);
      const entities = [
        ...( this.furnaces  ?? []),
        ...( this.quarries  ?? []),
        ...( this.crushers  ?? []),
        ...( this.flywheels ?? []),
        ...( this.crates    ?? []),
        ...( this.anvils    ?? []),
        ...( this.woodCraftingTables ?? []),
      ];
      for (const e of entities) e.refreshLabels?.(this.labelsVisible);
    });

    // Left-click — fire arrow
    this.input.on('pointerdown', (ptr) => {
      const clickedNpc = this._findNpcAtPointer(ptr);
      if (clickedNpc) {
        if (ptr.rightButtonDown()) this.events.emit('npc-right-clicked', { npc: clickedNpc, ptr });
        else this.events.emit('npc-clicked', clickedNpc);
        return;
      }

      if (ptr.rightButtonDown()) return;
      if (!this.bow.isEquipped()) return;
      if (this.chatBox?.isOpen() || this.dialoguePanel?.isOpen()) return;
      const hits = this.input.hitTestPointer(ptr);
      if (hits.length > 0) return;
      this.bow.fire(this.inventory, this.chickens, this.skillSystem);
    });

    // Mother Machine
    const machinePos = tilePos(14, 9);
    this.machine = new MotherMachine(this, machinePos.x, machinePos.y);
    this.grid.place(14, 9, this.machine);

    // ── Skill system ────────────────────────────────────────────────────────
    this.skillSystem = new SkillSystem();

    // ── HUD (must be created before panels that register with it) ───────────
    this.hud = new HUD(this);
    this.hud.updateTier(1);

    // Get the tab zone from HUD for panel positioning
    const zone = this.hud.getTabZone();

    // ── Panels — all receive zone coordinates ───────────────────────────────
    this.skillsPanel        = new SkillsPanel(this, this.skillSystem, this.inventory, zone);
    this.buildMenu          = new BuildMenu(this, (id) => {
      this.placement.startPlacing(id);
    }, zone);
    this.craftingPanel      = new CraftingPanel(this, this.inventory);
    this.craftingBenchPanel = new CraftingBenchPanel(this, this.inventory, zone);
    this.woodCraftingTablePanel = new WoodCraftingTablePanel(this, this.inventory, this.skillSystem);
    this.storagePanel       = new StoragePanel(this, this.inventory);
    this.crateFilterPanel   = new CrateFilterPanel(this);
    this.furnacePanel       = new FurnacePanel(this, this.inventory);
    this.smithingPanel      = new SmithingPanel(this, this.inventory, zone);
    this.npcSkillsPanel     = new NPCSkillsPanel(this);
    this.npcTaskPanel       = new NPCTaskPanel(this);
    this.npcHudPanel        = new NPCHUDPanel(
      this,
      this.hud,
      () => this._selectedNPC,
      this.skillsPanel,
      this.inventory,
      this.skillSystem
    );
    this.npcCommandPanel    = new NPCCommandPanel(
      this,
      zone,
      () => this._selectedNPC,
    );

    // Register panels with HUD tab system
    this.hud.registerPanel('skills', this.skillsPanel);
    this.hud.registerPanel('build',  this.buildMenu);
    this.hud.registerPanel('npc',    this.npcHudPanel);
    this.hud.registerPanel('command', this.npcCommandPanel);
    this.npcSoulPanel = new NPCSoulPanel(this);
    this.hud.registerPanel('soul', this.npcSoulPanel);
    this.hud.setDataSources({ inventory: this.inventory, skillSystem: this.skillSystem });

    // Wire Constitution level-ups → player maxHp
    this.skillSystem.on('level-up', ({ skillId, level }) => {
      if (skillId === 'constitution') this.player.setConstitutionLevel(level);
      if (skillId === 'athletics') {
        this.inventory.setWeightCapacity(BASE_CARRY_CAPACITY + level * CARRY_PER_ATHLETICS_LEVEL);
        this.player.setAthleticsLevel(level);
      }
    });

    // Player HP bar
    this._playerHPBar = new HPBar(this, { width: 30, depth: 5 });
    this._playerHPBar.update(this.player.hp, this.player.maxHp);

    // Inventory + skill events → HUD
    this.inventory.on('change', () => {
      if (this.hud.getActiveTab() !== 'npc') this.hud.updateInventoryGrid(this.inventory);
    });
    this.hud.on('inventory-slot-clicked', (slotIdx) => {
      if (this.hud.getActiveTab() === 'npc') return;
      const slot = this.inventory.getSlot?.(slotIdx);
      if (!slot) return;
      const def = getItem(slot.itemKey);
      if (!def?.placeable) return;
      if ((this.inventory.get(slot.itemKey) ?? 0) < 1) return;
      this.placement.startPlacingFromInventory(def.placeable, slot.itemKey);
    });
    this.hud.on('inventory-slot-right-clicked', (slotIdx, dropAll) => {
      if (this.hud.getActiveTab() === 'npc') return;
      const slot = this.inventory.getSlot?.(slotIdx);
      if (!slot) return;
      const key = slot.itemKey;
      const total = this.inventory.get(key);
      if (total <= 0) return;
      const amount = dropAll ? total : 1;
      const removed = this.inventory.remove(key, amount);
      if (removed <= 0) return;
      new GroundItem(this, this.player.x, this.player.y, key, removed);
    });
    this.skillSystem.on('xp-gained', () => {
      if (this.hud.getActiveTab() !== 'npc') this.hud.updateSkills(this.skillSystem);
    });

    this.devMenu = new DevMenu(this, this.inventory);

    // Mother Machine tier
    this.motherMachineTier = 1;
    this.machinePanel = new MachinePanel(this, this.machine, this.inventory);
    this.npcUpgradePanel = new NPCUpgradePanel(this, this.inventory);
    this.combatSystem = new CombatSystem(this);

    this.conveyors       = [];
    this.furnaces        = [];
    this.quarries        = [];
    this.crushers        = [];
    this.crates          = [];
    this.flywheels       = [];
    this.anvils          = [];
    this.craftingBenches = [];
    this.woodCraftingTables = [];
    this.structures      = [];
    this.doors           = [];
    this.mineRocks       = [];
    this.woodRobotPods   = [];
    this.groundItems     = [];
    this.chickens        = [];
    this.enemies         = [];

    this.structureGroup = this.physics.add.staticGroup();
    this.physics.add.collider(this.player, this.structureGroup);
    this._selectedChicken = null;

    // ── NPCs ────────────────────────────────────────────────────────────────
    this.npcs         = [];
    this._selectedNPC = null;
    this._nextNpcId   = 0;
    this._nextWoodRobotId = 0;

    // ── Rival NPCs ───────────────────────────────────────────────────────────
    this.npNPCs         = [];
    this._nextRivalId   = 0;

    this.placement = new PlacementSystem(this, this.grid, this.conveyors);

    // ── Hotkeys for HUD tabs ────────────────────────────────────────────────
    this.input.keyboard.on('keydown-C', () => {
      if (this.chatBox?.isOpen()) return;
      const cur = this.hud.getActiveTab();
      this.hud.setActiveTab(cur === 'skills' ? null : 'skills');
    });
    this.input.keyboard.on('keydown-B', () => {
      if (this.chatBox?.isOpen()) return;
      if (!this.hud.hasTab('build')) return;
      const cur = this.hud.getActiveTab();
      this.hud.setActiveTab(cur === 'build' ? null : 'build');
    });
    this.input.keyboard.on('keydown-ESC', () => {
      if (this.hud.getActiveTab()) {
        this.hud.setActiveTab(null);
      }
    });

    // Save system
    this.saveSystem = new SaveSystem(this);
    this.saveSystem.load();

    // Spawn default NPC if save didn't restore any
    if (this.npcs.length === 0) {
      this._spawnNPC(tilePos(18, 9).x, tilePos(18, 9).y);
    }

    // Chickens
    const chickenSpawns = [tilePos(12, 4), tilePos(14, 4), tilePos(16, 4)];
    for (const pos of chickenSpawns) {
      const chicken = new Chicken(this, pos.x, pos.y);
      this.chickens.push(chicken);
    }

    // Chicken selection
    this.events.on('chicken-clicked', (chicken) => {
      if (this._selectedNPC) {
        this._selectedNPC.setSelected(false);
        this._selectedNPC = null;
        this.hud.hideContextTab('npc');
        this.hud.hideContextTab('command');
        this.hud.hideContextTab('soul');
        this.hud.setBuildTabVisible(true);
        this.hud.setDataSources({ inventory: this.inventory, skillSystem: this.skillSystem });
        this.skillsPanel.setSkillSystem(this.skillSystem);
        this.skillsPanel.setInventory(this.inventory);
      }
      if (this._selectedChicken && this._selectedChicken !== chicken) {
        this._selectedChicken.setSelected(false);
      }
      const wasSelected = chicken.isSelected();
      chicken.setSelected(!wasSelected);
      this._selectedChicken = wasSelected ? null : chicken;
    });

    this.events.on('chicken-died', ({ chicken, spawnX, spawnY }) => {
      const i = this.chickens.indexOf(chicken);
      if (i !== -1) this.chickens.splice(i, 1);
      if (this._selectedChicken === chicken) this._selectedChicken = null;
      const respawnMs = Phaser.Math.Between(30_000, 45_000);
      this.time.delayedCall(respawnMs, () => {
        const newChicken = new Chicken(this, spawnX, spawnY);
        this.chickens.push(newChicken);
      });
    });

    this.events.on('enemy-died', (enemy) => {
      const i = this.enemies.indexOf(enemy);
      if (i !== -1) this.enemies.splice(i, 1);
    });

    // NPC selection
    this.events.on('npc-clicked', (npc) => {
      for (const n of [...this.npcs, ...this.npNPCs]) n.setSelected(n === npc);
      this._selectedNPC = npc;
      this.npcTaskPanel.show(npc);
      this.npcSoulPanel.setNPC(npc);
      this.hud.showContextTab('npc', this._npcDisplayName(npc));
      this.hud.showContextTab('command', 'Command');
      this.hud.showContextTab('soul', 'Soul');
      this.hud.setBuildTabVisible(false);
      this.hud.setActiveTab('npc');
    });

    this.events.on('wood-pod-hatched', ({ pod }) => {
      this._spawnWoodRobotFromPod(pod);
    });

    this.events.on('object-ctrl-clicked', ({ type, obj }) => {
      if (this._selectedNPC) {
        const consumed = this.npcCommandPanel?.handleCtrlClicked(type, obj);
        if (consumed) return;
        this._selectedNPC.assignTarget(type, obj);
        const label = obj._cfg?.label ?? obj._rockType ?? type;
        this._selectedNPC.showBubble(`Assigned: ${label}`);
      }
    });

    // Anvil left-click
    this.events.on('anvil-clicked', (anvil) => {
      this.smithingPanel.open(anvil);
    });

    // Crafting bench left-click
    this.events.on('crafting-bench-clicked', (bench) => {
      this.craftingBenchPanel.open(bench);
    });
    this.events.on('wood-crafting-table-clicked', (table) => {
      this.woodCraftingTablePanel.open(table);
    });

    // Right-click context menu
    this.contextMenu = new ContextMenu(this);
    this.game.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.events.on('object-right-clicked', ({ type, obj, ptr }) => {
      if (this.placement?.isPlacing()) return;
      this._emotionMenuNpc = null;
      if (type === 'conveyor' || type?.includes?.('conveyor') || typeof obj?.hasHeldItem === 'function') {
        const items = [];
        if (obj?.hasHeldItem?.()) {
          items.push({
            label: 'Remove Item',
            callback: () => obj.removeHeldItem?.(false),
          });
        }
        items.push({ label: 'Delete', callback: () => this._deleteObject('conveyor', obj) });
        this.contextMenu.show(ptr.x, ptr.y, items);
        return;
      }
      this.contextMenu.show(ptr.x, ptr.y, this._buildContextMenu(type, obj));
    });

    // Mining XP
    this.events.on('ore-mined', ({ source, xp }) => {
      const assignedNpc = this.npcs.find(n =>
        n.assignedTargets?.quarry === source ||
        n.assignedTargets?.crusher === source
      );
      if (assignedNpc) assignedNpc.skills.awardXP('mining', xp, this);
      else this.skillSystem.awardXP('mining', xp, this);
    });

    this.events.on('npc-right-clicked', ({ npc, ptr }) => {
      if (this.placement?.isPlacing()) return;
      this._emotionMenuNpc = null;
      this.contextMenu.show(ptr.x, ptr.y, [
        { label: 'Inspect Skills', callback: () => this.npcSkillsPanel.open(npc) },
        { label: 'Upgrades',       callback: () => this.npcUpgradePanel.open(npc) },
        { label: 'Emotion Sources', callback: () => {
          const px = ptr?.x ?? 0;
          const py = ptr?.y ?? 0;
          this.time.delayedCall(0, () => this._showEmotionSourceMenu(npc, { x: px, y: py }));
        } },
        { label: 'Remove all orders', callback: () => { npc.taskRunner?.stop(); npc.showBubble('Orders cleared.'); } },
        { label: `Delete ${npc.id}`, callback: () => this._deleteNPC(npc) },
      ]);
    });

    this._emotionMenuNpc = null;
    this._emotionMenuPos = null;
    this._emotionMenuTicker = this.time.addEvent({
      delay: 400,
      loop: true,
      callback: () => {
        if (!this._emotionMenuNpc) return;
        if (!this.contextMenu?.isOpen()) {
          this._emotionMenuNpc = null;
          this._emotionMenuPos = null;
          return;
        }
        this._renderEmotionSourceMenu();
      },
    });

    // Double-click deselect NPC
    this._lastClickTime = 0;
    this._lastClickX    = 0;
    this._lastClickY    = 0;
    this.input.on('pointerdown', (ptr) => {
      if (ptr.rightButtonDown()) return;
      if (!this._selectedNPC) return;
      const now  = Date.now();
      const dx   = ptr.x - this._lastClickX;
      const dy   = ptr.y - this._lastClickY;
      const near = Math.hypot(dx, dy) < 20;
      const fast = (now - this._lastClickTime) < 350;
      if (fast && near) {
        const hits   = this.input.hitTestPointer(ptr);
        const hitNPC = hits.some(h => [...this.npcs, ...this.npNPCs].some(n => n._sprite === h));
        if (!hitNPC) {
          this._selectedNPC.setSelected(false);
          this._selectedNPC = null;
          this.npcTaskPanel.hide();
          this.hud.hideContextTab('npc');
          this.hud.hideContextTab('command');
          this.hud.hideContextTab('soul');
          this.hud.setBuildTabVisible(true);
          this.hud.setDataSources({ inventory: this.inventory, skillSystem: this.skillSystem });
          this.skillsPanel.setSkillSystem(this.skillSystem);
          this.skillsPanel.setInventory(this.inventory);
        }
        this._lastClickTime = 0;
      } else {
        this._lastClickTime = now;
        this._lastClickX    = ptr.x;
        this._lastClickY    = ptr.y;
      }
    });

    this.chatBox = new ChatBox(
      this,
      () => this._selectedNPC,
      (npc, commands) => {
        npc.taskRunner.setTasks(commands);
        npc.showBubble(_describeCommands(commands));
        this.npcTaskPanel.show(npc);
      },
      () => this.player,
      () => this.npcs,
      (npc) => {
        for (const n of [...this.npcs, ...this.npNPCs]) n.setSelected(n === npc);
        this._selectedNPC = npc;
        if (npc) {
          this.npcTaskPanel.show(npc);
          this.npcSoulPanel.setNPC(npc);
          this.hud.showContextTab('npc', this._npcDisplayName(npc));
          this.hud.showContextTab('command', 'Command');
          this.hud.showContextTab('soul', 'Soul');
          this.hud.setBuildTabVisible(false);
          this.hud.setActiveTab('npc');
        } else {
          this.npcTaskPanel.hide();
          this.hud.hideContextTab('npc');
          this.hud.hideContextTab('command');
          this.hud.hideContextTab('soul');
          this.hud.setBuildTabVisible(true);
          this.hud.setDataSources({ inventory: this.inventory, skillSystem: this.skillSystem });
          this.skillsPanel.setSkillSystem(this.skillSystem);
          this.skillsPanel.setInventory(this.inventory);
        }
      }
    );

    // NPC Dialogue panel (personality/conversation — separate from job commands)
    this.socialChat = this.dialoguePanel = new SocialChatPanel(
      this,
      () => this._selectedNPC,
      () => this.player,
      () => [...this.npcs, ...this.npNPCs],
      (npc) => {
        for (const n of [...this.npcs, ...this.npNPCs]) n.setSelected(n === npc);
        this._selectedNPC = npc;
        if (npc) {
          this.npcTaskPanel.show(npc);
          this.npcSoulPanel.setNPC(npc);
          this.hud.showContextTab('npc', this._npcDisplayName(npc));
          this.hud.showContextTab('command', 'Command');
          this.hud.showContextTab('soul', 'Soul');
          this.hud.setBuildTabVisible(false);
          this.hud.setActiveTab('npc');
        }
      },
    );

    // Enter key handled by SocialChatPanel directly

    // Autonomous NPC thoughts — rotates through all NPCs + rivals every 15 s
    this._npcThoughtCursor = 0;
    this.time.addEvent({
      delay: 15_000,
      loop: true,
      callback: () => {
        const all = [...(this.npcs ?? []), ...(this.npNPCs ?? [])];
        if (!all.length) return;
        const npc = all[this._npcThoughtCursor % all.length];
        this._npcThoughtCursor++;
        if (!npc?.soul) return;
        const status = npc.taskRunner?.getStatus?.();
        const isIdle = !status?.running || status.tasks[0]?.task === 'idle';
        const event  = isIdle
          ? 'has been idle for a while'
          : `is working on: ${status.tasks[0]?.task ?? 'a task'}`;
        triggerNPCThought(npc, event);
      },
    });

    // Cross-faction reactions — every 20 s check proximity between factions
    this._factionReactCursor = 0;
    this._aggressionLogCooldown = new Map();
    this.time.addEvent({
      delay: 20_000,
      loop: true,
      callback: () => this._tickFactionReactions(),
    });

    // Trees
    const treeTiles = [
      [2,1],[4,1],[6,1],
      [2,3],[6,5],[10,2],
      [12,3],[18,6],[20,7],
      [5,9],[8,10],[14,5],
      [16,10],[22,3],[24,9],
    ];
    this.trees = treeTiles.map(([col, row]) => {
      const pos = tilePos(col, row);
      const tree = new Tree(this, pos.x, pos.y, this.inventory);
      this.grid.place(col, row, tree);
      return tree;
    });

    // Mine rocks
    const rockPos = (zoneCol, row) => ({
      x: WEST_ZONE_OFFSET_X + zoneCol * TILE_SIZE + TILE_SIZE / 2,
      y: row * TILE_SIZE + TILE_SIZE / 2,
    });
    const rockDefs = [
      { type: 'CopperOre', ...rockPos(3, 3) },
      { type: 'CopperOre', ...rockPos(4, 4) },
      { type: 'CopperOre', ...rockPos(3, 5) },
      { type: 'TinOre',    ...rockPos(7, 3) },
      { type: 'TinOre',    ...rockPos(8, 4) },
      { type: 'TinOre',    ...rockPos(7, 5) },
      { type: 'GoldOre',   ...rockPos(10, 7) },
      { type: 'GoldOre',   ...rockPos(11, 8) },
      { type: 'Coal',      ...rockPos(4, 12) },
      { type: 'Coal',      ...rockPos(5, 13) },
      { type: 'Coal',      ...rockPos(4, 14) },
      { type: 'CopperOre', ...rockPos(14, 5) },
      { type: 'TinOre',    ...rockPos(15, 10) },
      { type: 'Coal',      ...rockPos(13, 14) },
    ];
    for (const def of rockDefs) {
      const rock = new MineRock(this, def.x, def.y, def.type, this.inventory);
      this.mineRocks.push(rock);
    }

    // Space key
    this._spaceKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    this._crankingFlywheel = null;

    this._spaceKey.on('down', () => {
      if (this.chatBox?.isOpen()) return;
      if (this._selectedChicken) {
        this._tryAttackChicken();
      } else if (this.skillsPanel.isOpen()) {
        this._trySkillCraft();
      } else if (!this._trySmithCraft() && !this._tryBenchCraft()) {
        this._tryAttackStructure();
      }
    });

    this.cameras.main.setBounds(WEST_ZONE_OFFSET_X, 0, totalW, worldH);
    this.cameras.main.startFollow(this.player, true, 0.1, 0.1);
    this.cameras.main.setViewport(0, 0, 1280, 960);

    const hint = this.add.text(640, 40,
      'WASD: Move   E: Interact   Click trees to chop   Click NPC then T to give orders', {
      fontSize: '13px', color: '#aaaaaa', backgroundColor: '#00000088',
      padding: { x: 8, y: 4 }
    }).setOrigin(0.5, 0).setDepth(10).setScrollFactor(0);

    this.time.delayedCall(3500, () => {
      this.tweens.add({ targets: hint, alpha: 0, duration: 800,
        onComplete: () => hint.destroy() });
    });
  }

  // ── update ─────────────────────────────────────────────────────────────────
  update(_time, delta) {
    if (!this.chatBox?.isOpen() && !this.dialoguePanel?.isOpen()) this.player.update(delta);

    // Player HP bar
    this._playerHPBar.setPosition(this.player.x, this.player.y - 56);
    this._playerHPBar.update(this.player.hp, this.player.maxHp);
    this.hud.updateHP(this.player.hp, this.player.maxHp);
    if (this.hud.getActiveTab() === 'npc') {
      this._npcHudRefreshAccum = (this._npcHudRefreshAccum ?? 0) + delta;
      if (this._npcHudRefreshAccum >= 150) {
        this._npcHudRefreshAccum = 0;
        this.hud.refreshData();
      }
    } else {
      this._npcHudRefreshAccum = 0;
    }

    if (this.player.hp <= 0) this.combatSystem.handlePlayerDeath();

    for (const npc of (this.npcs ?? [])) npc.update(delta);
    for (const npc of (this.npNPCs ?? [])) npc.update(delta);
    this._separateActors(delta);

    const nearMachine = this.machine.updateProximity(this.player.x, this.player.y);
    if (!nearMachine && this.craftingPanel.isOpen()) {
      this.craftingPanel.hide();
    }

    for (const cr of this.crates) cr.updateProximity(this.player.x, this.player.y);
    for (const f of this.furnaces) {
      f.updateProximity(this.player.x, this.player.y);
      f.tick();
    }
    for (const q of this.quarries) {
      q.updateProximity(this.player.x, this.player.y);
      q.tick();
    }
    for (const c of this.crushers) {
      c.updateProximity(this.player.x, this.player.y);
      c.tick();
    }

    for (const fw of this.flywheels) {
      fw.update(delta);
      fw.updateProximity(this.player.x, this.player.y);
    }
    this._handleCrank();

    for (const av of this.anvils) av.updateProximity(this.player.x, this.player.y);
    for (const b of this.craftingBenches) b.updateProximity(this.player.x, this.player.y);
    for (const t of this.woodCraftingTables) t.updateProximity(this.player.x, this.player.y);
    for (const d of this.doors) d.updateProximity(this.player.x, this.player.y);
    for (const r of this.mineRocks) r.updateProximity(this.player.x, this.player.y);
    for (const p of this.woodRobotPods) p.updateProximity(this.player.x, this.player.y);

    this.bow.update();

    for (const ch of this.chickens) ch.update(delta);
    for (const en of this.enemies) en.update(delta);
    for (const p of this.woodRobotPods) p.update(delta);
    for (const t of this.woodCraftingTables) t.update(delta);

    // Ground item pickup
    for (let i = this.groundItems.length - 1; i >= 0; i--) {
      const item = this.groundItems[i];
      if (!item.active) { this.groundItems.splice(i, 1); continue; }
      const picked = item.tryPickup(this.player.x, this.player.y);
      if (picked) {
        const added = this.inventory.add(picked.resource, picked.amount);
        if (added < picked.amount) {
          // Couldn't fit all — drop remainder back
          new GroundItem(this, item.x, item.y, picked.resource, picked.amount - added);
        }
        this.groundItems.splice(i, 1);
      }
    }
  }

  // ── private ────────────────────────────────────────────────────────────────

  spawnEnemy(x, y, opts) {
    const enemy = new Enemy(this, x, y, opts);
    this.enemies.push(enemy);
    return enemy;
  }

  _spawnNPC(x, y, id, profileId = 'standard') {
    const npcId = id ?? `npc_${this._nextNpcId}`;
    if (npcId.startsWith('npc_')) {
      const parsed = parseInt(npcId.slice(4), 10);
      if (Number.isFinite(parsed)) {
        this._nextNpcId = Math.max(this._nextNpcId, parsed + 1);
      }
    }
    const npc = new NPC(this, x, y, npcId);
    npc.setProfile?.(profileId);
    new NPCTaskRunner(this, npc);
    this.npcs.push(npc);

    npc.skills.on('level-up', ({ skillId, level }) => {
      if (skillId === 'constitution') npc.setConstitutionLevel(level);
    });

    return npc;
  }

  _npcDisplayName(npc) {
    return npc?.getName?.() ?? npc?.id ?? 'npc';
  }

  _spawnNpNPC(x, y) {
    const id = `rival_${this._nextRivalId++}`;
    const rival = new npNPC(this, x, y, id);
    new NPCTaskRunner(this, rival);
    this.npNPCs.push(rival);
    rival.showBubble('Scouting this area.', 4000);
    return rival;
  }

  /**
   * Tick cross-faction reactions every 20s.
   * Picks one player NPC + one rival per tick (rotating cursor).
   * If they are within NOTICE_DIST, one of three things happens:
   *   1. Already in an encounter → skip (cooldown)
   *   2. Within ENGAGE_DIST     → trigger a full encounter exchange
   *   3. Within NOTICE_DIST     → walk toward each other, mutter a spot quip
   * Hostile rivals (factionTrust < 0.15) always attack without diplomacy.
   */
  _tickFactionReactions() {
    const NOTICE_DIST = 8 * TILE_SIZE;   // start walking toward each other
    const ENGAGE_DIST = 2.5 * TILE_SIZE; // close enough for dialogue exchange

    const playerNPC = this.npcs?.[(this._factionReactCursor ?? 0) % Math.max(1, this.npcs?.length ?? 1)];
    const rival     = this.npNPCs?.[(this._factionReactCursor ?? 0) % Math.max(1, this.npNPCs?.length ?? 1)];
    this._factionReactCursor = ((this._factionReactCursor ?? 0) + 1);

    if (!rival || rival._dead) return;

    // Hostile rivals can target either nearby player NPCs or the player directly.
    if (rival.isHostileToFaction?.()) {
      const hostileTargets = [
        ...(this.npcs ?? []).filter(n => !n?._dead),
        this.player,
      ].filter(Boolean);
      if (!hostileTargets.length) return;

      const status = rival.taskRunner?.getStatus?.();
      const activeAttack = status?.tasks?.[0];
      const activeTarget = activeAttack?.task === 'attack_nearest_enemy'
        ? activeAttack.target
        : null;
      if (activeTarget && activeTarget.isDead?.() !== true) return;

      const target = rival.selectCatalystTarget?.(hostileTargets) ?? hostileTargets[0];
      if (!target) return;
      const hostileDist = Phaser.Math.Distance.Between(rival.x, rival.y, target.x, target.y);
      if (hostileDist <= NOTICE_DIST) {
        rival.addIntent?.(`I am done talking. Attacking ${target.getName?.() ?? target.id ?? 'the player'}.`);
        rival.taskRunner?.pushTask?.({ task: 'attack_nearest_enemy', target, range: NOTICE_DIST });
        this._logViolentAggression(rival, target, 'hostile_faction_escalation');
      }
      return;
    }

    if (!playerNPC || playerNPC._dead) return;

    const dist = Phaser.Math.Distance.Between(playerNPC.x, playerNPC.y, rival.x, rival.y);
    if (dist > NOTICE_DIST) return;

    // Skip if either NPC is already busy in an encounter cooldown
    if (playerNPC._encounterCooldown || rival._encounterCooldown) return;

    if (dist <= ENGAGE_DIST) {
      // --- Full encounter exchange ---
      // Mark both as in cooldown so they don't re-trigger for 45s
      playerNPC._encounterCooldown = true;
      rival._encounterCooldown     = true;
      this.time.delayedCall(45_000, () => {
        playerNPC._encounterCooldown = false;
        rival._encounterCooldown     = false;
      });

      // Randomly pick which NPC is the opener
      const [opener, responder] = Math.random() < 0.5
        ? [playerNPC, rival]
        : [rival, playerNPC];
      opener.getRelationshipMetrics?.(responder.id);
      responder.getRelationshipMetrics?.(opener.id);

      fetch('http://127.0.0.1:8001/npc_encounter', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          opener_id:    opener.id,
          responder_id: responder.id,
          opener_soul:   opener.getSoulContext?.()    ?? {},
          responder_soul: responder.getSoulContext?.() ?? {},
        }),
      })
      .then(r => r.json())
      .then(data => {
        if (opener._dead || responder._dead) return;

        const { opener_line, reply_line, outcome,
                aggressor,
                opener_emotion_deltas, responder_emotion_deltas,
                opener_relationship_deltas, responder_relationship_deltas } = data;

        // Show opener line immediately
        if (opener_line) {
          opener.showBubble(opener_line, 5000);
          responder.recordSocialStimulus?.({
            sourceId: opener.id,
            sourceName: opener.getName?.() ?? opener.id,
            text: opener_line,
            tags: _inferCatalystTags(opener_line),
            intensity: _inferCatalystIntensity(opener_line),
            targeted: true,
          });
          triggerNPCThought(responder, `${opener.getName?.() ?? opener.id} said to me: "${_shortForThought(opener_line)}"`);
        }

        // Reply appears 2s later
        this.time.delayedCall(2000, () => {
          if (!responder._dead && reply_line) {
            responder.showBubble(reply_line, 5000);
            opener.recordSocialStimulus?.({
              sourceId: responder.id,
              sourceName: responder.getName?.() ?? responder.id,
              text: reply_line,
              tags: _inferCatalystTags(reply_line),
              intensity: _inferCatalystIntensity(reply_line),
              targeted: true,
            });
            triggerNPCThought(opener, `${responder.getName?.() ?? responder.id} said to me: "${_shortForThought(reply_line)}"`);
          }
        });

        // Apply emotion deltas
        if (opener_emotion_deltas)    opener.applyEmotionDeltas?.(opener_emotion_deltas);
        if (responder_emotion_deltas) responder.applyEmotionDeltas?.(responder_emotion_deltas);
        if (opener_relationship_deltas) {
          opener.applyRelationshipDeltas?.(responder.id, opener_relationship_deltas, responder.getName?.());
        }
        if (responder_relationship_deltas) {
          responder.applyRelationshipDeltas?.(opener.id, responder_relationship_deltas, opener.getName?.());
        }

        // Adjust rival factionTrust based on outcome
        const rivalNPC = (opener.faction === 'rival') ? opener : responder;
        if (outcome === 'friendly') {
          rivalNPC.adjustFactionTrust?.(0.05);
        } else if (outcome === 'argue') {
          rivalNPC.adjustFactionTrust?.(-0.05);
        } else if (outcome === 'fight') {
          rivalNPC.adjustFactionTrust?.(-0.15);
          // 3s after reply, trigger combat
          this.time.delayedCall(3000, () => {
            if (!responder._dead && !opener._dead) {
              let attacker = null;
              let victim = null;
              if (aggressor === 'opener') {
                opener.addIntent?.(`That's all I can take. Time to teach ${responder.getName?.() ?? responder.id} a lesson.`);
                opener.taskRunner?.pushTask?.({ task: 'attack_nearest_enemy', target: responder });
                attacker = opener;
                victim = responder;
              } else if (aggressor === 'responder') {
                responder.addIntent?.(`That's all I can take. Time to teach ${opener.getName?.() ?? opener.id} a lesson.`);
                responder.taskRunner?.pushTask?.({ task: 'attack_nearest_enemy', target: opener });
                attacker = responder;
                victim = opener;
              } else if (rivalNPC === opener) {
                opener.addIntent?.(`That's all I can take. Time to teach ${responder.getName?.() ?? responder.id} a lesson.`);
                opener.taskRunner?.pushTask?.({ task: 'attack_nearest_enemy', target: responder });
                attacker = opener;
                victim = responder;
              } else {
                responder.addIntent?.(`That's all I can take. Time to teach ${opener.getName?.() ?? opener.id} a lesson.`);
                responder.taskRunner?.pushTask?.({ task: 'attack_nearest_enemy', target: opener });
                attacker = responder;
                victim = opener;
              }
              if (attacker && victim) {
                this._logViolentAggression(attacker, victim, 'encounter_fight', [opener_line, reply_line]);
              }
            }
          });
        }
      })
      .catch(() => {});

    } else {
      // --- Notice range: walk toward each other + spot quip (30% chance each) ---
      // Walk toward each other
      const midX = (playerNPC.x + rival.x) / 2;
      const midY = (playerNPC.y + rival.y) / 2;
      playerNPC.moveTo(midX, midY, null);
      rival.moveTo(midX, midY, null);

      // Spot quips (independent, low probability to avoid spam)
      if (Math.random() < 0.3) {
        fetch('http://127.0.0.1:8001/npc_quip', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            npc_id:     playerNPC.id,
            soul:       playerNPC.getSoulContext?.() ?? {},
            situation:  'rival_nearby',
            other_name: rival.getName(),
          }),
        }).then(r => r.json()).then(d => {
          if (d.quip && !playerNPC._dead) playerNPC.showBubble(d.quip, 5000);
        }).catch(() => {});
      }

      if (Math.random() < 0.3) {
        fetch('http://127.0.0.1:8001/npc_quip', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            npc_id:     rival.id,
            soul:       rival.getSoulContext?.() ?? {},
            situation:  'rival_spotted',
            other_name: playerNPC.getName(),
          }),
        }).then(r => r.json()).then(d => {
          if (d.quip && !rival._dead) rival.showBubble(d.quip, 5000);
        }).catch(() => {});
      }
    }
  }

  _spawnWoodRobotFromPod(pod) {
    if (!pod || !pod.active) return null;
    const { x, y } = pod;
    this._deleteObject('wood_robot_pod', pod);

    const idx = this._nextWoodRobotId++;
    const npc = this._spawnNPC(x, y, `wood_robot_${idx}`, 'wood_robot');
    npc.setName(`Wood Robot ${idx}`);
    npc.showBubble('Boot complete.');
    return npc;
  }

  _findNpcAtPointer(ptr) {
    const cam = this.cameras?.main;
    if (!cam) return null;
    const world = cam.getWorldPoint(ptr.x, ptr.y);
    const wx = world.x;
    const wy = world.y;

    let best = null;
    let bestD2 = Infinity;
    const candidates = [...(this.npcs ?? []), ...(this.npNPCs ?? [])];
    for (const npc of candidates) {
      if (!npc || npc._dead || !npc.visible) continue;
      const dx = wx - npc.x;
      const dy = wy - (npc.y - TILE_SIZE * 0.5);

      // Clickable body region around each NPC sprite.
      if (Math.abs(dx) > 14 || Math.abs(dy) > 26) continue;

      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        best = npc;
        bestD2 = d2;
      }
    }
    return best;
  }

  _logViolentAggression(attacker, target, trigger = 'unknown', fallbackStatements = []) {
    if (!attacker || !target) return;
    const attackerId = String(attacker?.id ?? '');
    const targetId = String(target?.id ?? 'player');
    if (!attackerId || !targetId) return;

    const now = Date.now();
    const key = `${attackerId}->${targetId}`;
    const last = Number(this._aggressionLogCooldown?.get?.(key) ?? 0);
    if ((now - last) < 30_000) return;
    this._aggressionLogCooldown.set(key, now);

    const topCatalysts = attacker.getTopCatalystStatements?.(targetId, 3) ?? [];
    const all = [...topCatalysts, ...(Array.isArray(fallbackStatements) ? fallbackStatements : [])];
    const worstStatements = [];
    const seen = new Set();
    for (const s of all) {
      const text = String(s ?? '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const dedupeKey = text.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      worstStatements.push(text);
      if (worstStatements.length >= 3) break;
    }

    const payload = {
      aggressor_id: attackerId,
      aggressor_name: attacker.getName?.() ?? attackerId,
      target_id: targetId,
      target_name: target.getName?.() ?? (targetId === 'player' ? 'Player' : targetId),
      trigger,
      worst_statements: worstStatements,
    };

    fetch('http://127.0.0.1:8001/npc_memory_log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {});
  }

  _handleCrank() {
    if (this.chatBox?.isOpen() || this.dialoguePanel?.isOpen()) return;
    const spaceDown = this._spaceKey.isDown;

    if (spaceDown) {
      if (!this._crankingFlywheel) {
        for (const fw of this.flywheels) {
          if (fw.updateProximity(this.player.x, this.player.y)) {
            this._crankingFlywheel = fw;
            fw.startCrank();
            break;
          }
        }
      }
    } else {
      if (this._crankingFlywheel) {
        this._crankingFlywheel.stopCrank();
        this._crankingFlywheel = null;
      }
    }
  }

  /**
   * Prevent player/NPC/npNPC overlap so actors don't stack on top of each other.
   * Lightweight N^2 pass; actor counts are low in this scene.
   */
  _separateActors(delta = 16) {
    this._separateActorsAccum = (this._separateActorsAccum ?? 0) + delta;
    if (this._separateActorsAccum < 80) return;
    this._separateActorsAccum = 0;

    const MIN_DIST = 18;
    const MIN_DIST_SQ = MIN_DIST * MIN_DIST;
    const bounds = this.physics?.world?.bounds;

    const actors = [];
    if (this.player && Number.isFinite(this.player.x) && Number.isFinite(this.player.y)) {
      actors.push({ obj: this.player, kind: 'player' });
    }
    for (const n of (this.npcs ?? [])) {
      if (!n || n._dead || !Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
      actors.push({ obj: n, kind: 'npc' });
    }
    for (const n of (this.npNPCs ?? [])) {
      if (!n || n._dead || !Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
      actors.push({ obj: n, kind: 'npc' });
    }
    if (actors.length < 2) return;

    const moveActor = (actor, dx, dy) => {
      if (!dx && !dy) return;
      let nx = actor.x + dx;
      let ny = actor.y + dy;
      if (bounds) {
        nx = Phaser.Math.Clamp(nx, bounds.left + 8, bounds.right - 8);
        ny = Phaser.Math.Clamp(ny, bounds.top + 8, bounds.bottom - 8);
      }
      actor.x = nx;
      actor.y = ny;
    };

    for (let i = 0; i < actors.length; i++) {
      for (let j = i + 1; j < actors.length; j++) {
        const a = actors[i];
        const b = actors[j];
        let dx = b.obj.x - a.obj.x;
        let dy = b.obj.y - a.obj.y;
        let d2 = dx * dx + dy * dy;
        if (d2 >= MIN_DIST_SQ) continue;

        // Perfect overlap: choose a stable fallback direction.
        if (d2 < 0.0001) {
          dx = 1;
          dy = ((i + j) % 2 === 0) ? 1 : -1;
          d2 = dx * dx + dy * dy;
        }

        const d = Math.sqrt(d2);
        const overlap = MIN_DIST - d;
        const nx = dx / d;
        const ny = dy / d;

        // Keep player responsive: push NPCs away from player, not the reverse.
        if (a.kind === 'player' && b.kind === 'npc') {
          moveActor(b.obj, nx * overlap, ny * overlap);
        } else if (a.kind === 'npc' && b.kind === 'player') {
          moveActor(a.obj, -nx * overlap, -ny * overlap);
        } else {
          moveActor(a.obj, -nx * overlap * 0.5, -ny * overlap * 0.5);
          moveActor(b.obj,  nx * overlap * 0.5,  ny * overlap * 0.5);
        }
      }
    }
  }

  _showEmotionSourceMenu(npc, ptr) {
    this._emotionMenuNpc = npc ?? null;
    this._emotionMenuPos = { x: (ptr?.x ?? 0), y: (ptr?.y ?? 0) };
    this._renderEmotionSourceMenu();
  }

  _renderEmotionSourceMenu() {
    const npc = this._emotionMenuNpc;
    const ptr = this._emotionMenuPos;
    if (!npc || !ptr) return;
    const rows = npc?.getEmotionSourceTotals?.() ?? [];
    const items = [];
    if (rows.length === 0) {
      items.push({ label: 'No source deltas recorded yet.', callback: () => {} });
    } else {
      const top = rows.slice(0, 10);
      for (const r of top) {
        const name = this._resolveSpeakerName(r.sourceId, r.sourceName);
        const t = _fmtDelta(r.trust);
        const f = _fmtDelta(r.fear);
        const a = _fmtDelta(r.anger);
        const net = _fmtDelta((r.anger + r.fear) - r.trust);
        items.push({ label: `${name} | T:${t} F:${f} A:${a} | Net:${net} | n=${r.samples ?? 0}`, callback: () => {} });
      }
      if (rows.length > top.length) {
        items.push({ label: `...and ${rows.length - top.length} more`, callback: () => {} });
      }
    }
    this.contextMenu.show((ptr?.x ?? 0) + 10, (ptr?.y ?? 0) + 10, items, {
      width: 500,
      closeOnItemClick: false,
      closeOnOutsideClick: false,
    });
  }

  _resolveSpeakerName(sourceId, fallback = '') {
    if (sourceId === 'player') return 'Player';
    const npc = [...(this.npcs ?? []), ...(this.npNPCs ?? [])].find(n => n?.id === sourceId);
    return npc?.getName?.() ?? fallback ?? sourceId;
  }

  _buildContextMenu(type, obj) {
    const items = [];

    if (type === 'furnace') {
      items.push({ label: 'Open', callback: () => obj.openPanel() });
    } else if (type === 'wood_robot_pod') {
      // no panel for pod yet
    } else if (type === 'crate') {
      items.push({ label: 'Open',       callback: () => obj.openPanel() });
      items.push({ label: 'Set Filter', callback: () => this.crateFilterPanel.open(obj) });
    } else if (type === 'wood_crafting_table') {
      items.push({ label: 'Open', callback: () => obj.openPanel() });
    } else if (type === 'crusher') {
      items.push({ label: 'Open', callback: () => obj.openPanel() });
    } else if (type === 'anvil') {
      items.push({ label: 'Open', callback: () => obj.openPanel() });
    } else if (type === 'structure' || type === 'door') {
      items.push({ label: 'Delete', callback: () => this._deleteObject(type, obj) });
      return items;
    }

    if (this._selectedNPC) {
      items.push({
        label: `Assign to ${this._selectedNPC.id}`,
        callback: () => this._selectedNPC.assignTarget(type, obj),
      });
    }

    items.push({ label: 'Delete', callback: () => this._deleteObject(type, obj) });
    return items;
  }

  _deleteObject(type, obj) {
    const arrMap = {
      furnace: 'furnaces', crate: 'crates', quarry: 'quarries',
      crusher: 'crushers', flywheel: 'flywheels', conveyor: 'conveyors', anvil: 'anvils',
      structure: 'structures', door: 'doors', wood_robot_pod: 'woodRobotPods',
      wood_crafting_table: 'woodCraftingTables',
    };
    const arr = this[arrMap[type]];
    if (arr) {
      const i = arr.indexOf(obj);
      if (i !== -1) arr.splice(i, 1);
    }
    if (type === 'structure' || type === 'door') {
      this.structureGroup?.remove(obj, true, true);
    }
    if (type !== 'conveyor') this.grid.remove(obj.col, obj.row);
    for (const npc of this.npcs) npc.unassignTarget(type, obj);
    obj.destroy();
  }

  _deleteNPC(npc) {
    const i = this.npcs.indexOf(npc);
    if (i !== -1) this.npcs.splice(i, 1);
    if (this._selectedNPC === npc) {
      this._selectedNPC = null;
      this.npcTaskPanel.hide();
      this.hud.hideContextTab('npc');
      this.hud.hideContextTab('command');
      this.hud.hideContextTab('soul');
      this.hud.setBuildTabVisible(true);
      this.hud.setDataSources({ inventory: this.inventory, skillSystem: this.skillSystem });
      this.skillsPanel.setSkillSystem(this.skillSystem);
      this.skillsPanel.setInventory(this.inventory);
    }
    npc.taskRunner?.stop();
    npc.destroy();
  }

  _tryAttackChicken() {
    const chicken = this._selectedChicken;
    if (!chicken || chicken.isDead()) { this._selectedChicken = null; return; }
    this.combatSystem.playerMeleeAttack(chicken);
  }

  _trySkillCraft() {
    if (this.hud.getActiveTab() === 'npc') return;
    const active = this.skillsPanel.getActiveRecipe();
    if (!active) return;
    this.skillSystem.startCraft(
      active.skillId, active.recipe.id,
      this, this.inventory, null
    );
  }

  _trySmithCraft() {
    for (const av of this.anvils) {
      if (av.updateProximity(this.player.x, this.player.y)) {
        av.startCraft(this.inventory, null);
        return true;
      }
    }
    return false;
  }

  _tryBenchCraft() {
    for (const b of this.craftingBenches) {
      if (b.updateProximity(this.player.x, this.player.y)) {
        b.startCraft(this.inventory, null);
        return true;
      }
    }
    return false;
  }

  _tryAttackStructure() {
    const range = TILE_SIZE * 1.5;
    const targets = [...(this.structures ?? []), ...(this.doors ?? [])];
    for (const s of targets) {
      if (s.isDead()) continue;
      const d = Phaser.Math.Distance.Between(this.player.x, this.player.y, s.x, s.y);
      if (d <= range) {
        const strLvl = this.skillSystem?.getLevel('strength') ?? 1;
        const dmg = Phaser.Math.Between(1, Math.floor(strLvl * 1.2) + 1);
        s.takeDamage(dmg);
        break;
      }
    }
  }

  _handleInteract() {
    if (this.chatBox?.isOpen()) return;

    // If any panel is open, E closes it
    if (this.crateFilterPanel.isOpen())   { this.crateFilterPanel.hide();   return; }
    if (this.storagePanel.isOpen())       { this.storagePanel.hide();       return; }
    if (this.craftingPanel.isOpen())      { this.craftingPanel.hide();      return; }
    if (this.machinePanel.isOpen())       { this.machinePanel.hide();       return; }
    if (this.furnacePanel.isOpen())       { this.furnacePanel.hide();       return; }
    if (this.smithingPanel.isOpen())      { this.smithingPanel.hide();      return; }
    if (this.craftingBenchPanel.isOpen()) { this.craftingBenchPanel.hide(); return; }
    if (this.woodCraftingTablePanel.isOpen()) { this.woodCraftingTablePanel.hide(); return; }
    if (this.npcSkillsPanel.isOpen())     { this.npcSkillsPanel.hide();     return; }
    if (this.npcUpgradePanel.isOpen())    { this.npcUpgradePanel.hide();    return; }

    // Close any HUD tab on E
    if (this.hud.getActiveTab()) {
      this.hud.setActiveTab(null);
      return;
    }

    // Otherwise open whichever entity is in range
    if (this.machine.updateProximity(this.player.x, this.player.y)) {
      this.machinePanel.show();
      return;
    }
    for (const f of this.furnaces) {
      if (f.updateProximity(this.player.x, this.player.y)) {
        f.openPanel();
        return;
      }
    }
    for (const c of this.crushers) {
      if (c.updateProximity(this.player.x, this.player.y)) {
        c.openPanel();
        return;
      }
    }
    for (const cr of this.crates) {
      if (cr.updateProximity(this.player.x, this.player.y)) {
        cr.openPanel();
        return;
      }
    }
    for (const av of this.anvils) {
      if (av.updateProximity(this.player.x, this.player.y)) {
        av.openPanel();
        return;
      }
    }
    for (const b of this.craftingBenches) {
      if (b.updateProximity(this.player.x, this.player.y)) {
        b.openPanel();
        return;
      }
    }
    for (const t of this.woodCraftingTables) {
      if (t.updateProximity(this.player.x, this.player.y)) {
        t.openPanel();
        return;
      }
    }
    for (const d of this.doors) {
      if (d.updateProximity(this.player.x, this.player.y)) {
        d.toggle();
        return;
      }
    }
  }
}

function _describeCommands(commands) {
  if (!commands || commands.length === 0) return 'Uh… okay?';
  const phrases = commands.map(c => {
    switch (c.task) {
      case 'gather':  return `gather ${c.item ?? 'stuff'}`;
      case 'deposit': return `deposit ${c.item ?? 'items'} in ${c.target ?? 'storage'}`;
      case 'fill':    return `fill ${c.target ?? 'furnace'} with ${c.item ?? 'iron'}`;
      case 'smelt':   return 'watch the furnace';
      case 'follow':  return 'follow you';
      case 'crank':   return 'crank the flywheel';
      case 'idle':    return 'stand by';
      case 'loop': {
        const goalNames = (c.goals ?? []).map(g => {
          switch (g.goal) {
            case 'fill_furnace_wood': return `keep furnace fuelled (>${g.threshold ?? 4} wood)`;
            case 'deposit_extra':     return `deposit extra ${g.item ?? 'items'}`;
            case 'gather':            return `gather ${g.item ?? 'stuff'} when needed`;
            default:                  return g.goal;
          }
        });
        return `loop: ${goalNames.join(', ')}`;
      }
      default: return c.task;
    }
  });
  return 'Got it! I\'ll ' + phrases.join(', then ') + '.';
}

function _shortForThought(text, max = 80) {
  const msg = String(text ?? '').replace(/\s+/g, ' ').trim();
  return msg.length > max ? `${msg.slice(0, max - 3)}...` : msg;
}

function _inferCatalystTags(text) {
  const msg = String(text ?? '').toLowerCase();
  const tags = [];
  if (/\b(stupid|idiot|dumb|worthless|hate|loser|moron|pathetic)\b/.test(msg)) tags.push('insult');
  if (/\b(kill|destroy|attack|hurt|break you|smash)\b/.test(msg)) tags.push('threat');
  if (/\b(thanks|thank you|nice|good|great|appreciate)\b/.test(msg)) tags.push('praise');
  if (/\b(sorry|apolog)\b/.test(msg)) tags.push('apology');
  if (/\b(respect|sir|maam)\b/.test(msg)) tags.push('respect');
  if (tags.length === 0) tags.push('neutral');
  return tags;
}

function _inferCatalystIntensity(text) {
  const msg = String(text ?? '');
  let score = 0.3;
  if (/[!?]{2,}/.test(msg)) score += 0.15;
  if (/\b(really|very|extremely|absolutely|now)\b/i.test(msg)) score += 0.1;
  if (msg === msg.toUpperCase() && /[A-Z]/.test(msg)) score += 0.2;
  return Phaser.Math.Clamp(score, 0.15, 1);
}

function _fmtDelta(v) {
  const n = Number(v ?? 0);
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
}

