# Iron Anachronism — Game Reference

A Phaser 3 browser game about building an autonomous industrial base. You direct worker NPCs via natural language, wire up machine chains with conveyor belts, and defend your base from increasingly hostile enemies.

---

## Table of Contents

1. [World & Controls](#world--controls)
2. [Player](#player)
3. [Skills & Progression](#skills--progression)
4. [Items](#items)
5. [Machines & Structures](#machines--structures)
6. [NPCs](#npcs)
7. [Combat](#combat)
8. [LLM Chat System](#llm-chat-system)
9. [Building & Placement](#building--placement)
10. [Save System](#save-system)
11. [Numbers Reference](#numbers-reference)

---

## World & Controls

### Map
- **Main zone**: 30 × 20 tiles (1440 × 960 px), tile size 48 px
- **West zone**: 20 × 20 tile extension (ore rocks, mine rocks)
- **Tileset**: `roguelikeSheet_transparent.png`, 57 cols, 16 px base frames

### Keyboard
| Key | Action |
|-----|--------|
| W / A / S / D | Move |
| Shift | Toggle run (160 → 280 px/s) |
| E | Interact with nearest object |
| Space (hold) | Crank flywheel; press once to melee attack / smith / fletch |
| X | Toggle bow |
| B | Open build menu |
| I | Toggle inventory panel |
| Enter | Open chat to selected NPC |
| Ctrl | Toggle entity labels |
| Ctrl + S | Manual save |
| Ctrl + click | Assign target machine / crate to selected NPC |
| Shift + click (conveyor) | Drop held item from conveyor as ground item |
| Right-click | Context menu (delete, open panel, set filter…) |
| Esc | Close open panel |

---

## Player

| Stat | Value |
|------|-------|
| Walk speed | 160 px/s |
| Run speed | 280 px/s |
| Interaction distance | 90 px |
| Melee cooldown | 1 400 ms |
| Base HP (Constitution 1) | 15 |
| HP formula | 10 + (Constitution level × 5) |
| HP regen (out of combat) | 1 HP / 30 s |
| HP regen (in combat) | 1 HP / 5 s |

**Death** — drops ~50 % of inventory as ground items at the death location; respawns at the Mother Machine with 1 HP.

**Bow** — X to equip; left-click to fire toward cursor; consumes 1 Arrow per shot. Requires arrows in inventory.

---

## Skills & Progression

Seven skills, each with an XP → level curve (RuneScape-style).

### Gathering

| Skill | XP Sources |
|-------|-----------|
| Woodcutting | 25 XP per tree chopped |
| Mining | 10 XP per ore (quarry), 15 XP per iron crushed (crusher) |

### Production (has recipes)

**Smithing** — 19 recipes at the Anvil / Crafting Bench:

| Recipe | Inputs | Output | Time | Level |
|--------|--------|--------|------|-------|
| Iron Arrowheads | 1 IronBar | 3 IronArrowhead | 1 s | 1 |
| Iron Nails | 2 IronBar | 20 IronNail | 1.5 s | 1 |
| Bronze Sword | 2 BronzeBar | 1 BronzeSword | — | 1 |
| Iron Dagger | 1 IronBar | 1 IronDagger | — | 5 |
| Iron Sword | 2 IronBar | 1 IronSword | — | 10 |
| Iron Spear | 2 IronBar | 1 IronSpear | — | 12 |
| Steel Sword | 2 SteelBar | 1 SteelSword | — | 30 |
| Iron Helmet | 1 IronBar | 1 IronHelmet | — | 15 |
| Iron Chestplate | 3 IronBar | 1 IronChestplate | — | 20 |
| Iron Legs | 2 IronBar | 1 IronLegs | — | 18 |
| Iron Shield | 2 IronBar | 1 IronShield | — | 15 |
| Steel Chestplate | 5 SteelBar | 1 SteelChestplate | 8 s | 40 |
| *(full bronze/steel armor set unlocked progressively)* | | | | |

**Fletching** — 1 recipe, no station required:

| Recipe | Inputs | Output | Time | Level |
|--------|--------|--------|------|-------|
| Arrow | 1 Wood + 2 Feather + 1 IronArrowhead | 1 Arrow | 0.5 s | 1 |

### Combat Skills (no recipes — XP from actions)

| Skill | XP Source | Effect |
|-------|-----------|--------|
| Attack | 2 XP miss / 4 XP hit | Melee accuracy multiplier |
| Strength | 4 XP per hit | Melee damage; +1 carry cap per 10 levels |
| Defence | Varies from hits received | Damage reduction: `damage × (1 − defenceBonus / 200)`, cap 75 % |
| Archery | 15 XP per arrow hit | Arrow damage + accuracy bonus |
| Constitution | Passive from any combat | Max HP; formula: 10 + (level × 5) |

---

## Items

### Resources (stackable)
Wood, Stone, Ore, Iron, Coal, IronBar, IronArrowhead, Feather, Arrow, CopperOre, TinOre, GoldOre, GoldBar, SteelBar, BronzeBar, CopperBar

### Building Materials (stackable)
IronNail, WoodenFrame, ReinforcedBlock, Door, Cogwheel *(rare drop from quarries/crushers — used for NPC Task Efficiency upgrade)*

### Weapons (equip: mainhand)

| Item | Attack | Strength | Speed | Smithing Level |
|------|--------|----------|-------|----------------|
| Fist | 0 | 0 | 1.5 s | — |
| BronzeSword | 5 | 3 | 1.2 s | 1 |
| IronDagger | 8 | 2 | 0.8 s | 5 |
| IronSword | 12 | 8 | 1.4 s | 10 |
| IronSpear | 10 | 6 | 1.8 s | 12 |
| SteelSword | 24 | 16 | 1.5 s | 30 |
| Shortbow | 8 | 0 | 1.2 s | 1 (ranged) |
| Longbow | 16 | 0 | 1.6 s | 20 (ranged) |

### Armor (equip: head / chest / legs / offhand)
Bronze set (defence 3–7, Smithing 1–3), Iron set (defence 5–12, Smithing 15–20), Steel set (defence 10–22, Smithing 30–40)

### Consumables
HealingPotion — restores 20 HP on use

---

## Machines & Structures

### Mother Machine
The central upgrade hub. Placed at tile (14, 9) at game start.

| Tier | Upgrade Cost | Unlocks |
|------|-------------|---------|
| 1 (default) | — | All Tier 1 buildings; basic NPC tasks |
| 2 | 20 IronBar + 10 Stone + 5 Wood | Walls, Gates, NPC Blueprint recipe |
| 3 | 30 SteelBar + 20 ReinforcedBlock + 10 GoldBar | Towers, Pylons, advanced ores, combat modules |
| 4 | 50 SteelBar + 25 GoldBar + 20 IronBar | Automated defense, long-range scouts, deep quarries |

### Quarry
Powers from an adjacent Flywheel. Produces 1 Ore per flywheel tick. Awards 10 Mining XP to the assigned NPC per ore.

### Ore Crusher
Requires adjacent powered Flywheel. Converts 5 Ore → 1–3 Iron (random). Awards 15 Mining XP per iron to assigned NPC.

### Furnaces (three types)

| Type | Recipe | Fuel | Smelt Time | Label color |
|------|--------|------|-----------|-------------|
| Iron Furnace | 5 Iron → 1 IronBar | Wood (max 10) | 5 s | #ff9944 |
| Steel Furnace | 1 IronBar + 2 Coal → 1 SteelBar | Coal (also reagent) | 5 s | #aabbdd |
| Bronze Furnace | 1 CopperOre + 1 TinOre → 1 BronzeBar | Wood (max 10) | 5 s | #ddaa55 |

All furnaces: 5 input slots, 20 bar output capacity. Conveyors cannot pull from furnaces — must be filled manually or via NPC fill task.

### Flywheel
Hold Space nearby to charge. Powers the adjacent Quarry or Ore Crusher.

| Property | Value |
|----------|-------|
| Momentum range | 0 – 100 % |
| Activation threshold | 20 % |
| Charge rate (cranking) | +6 per 300 ms tick (~20 / s) |
| Decay rate (idle) | −3 % / s |

NPCs can crank flywheels autonomously via the `crank` or `crank_flywheel` goal.

### Anvil
Blacksmithing station. Press E to open the Smithing panel; Space to craft when a recipe is selected. NPC can use it for the `smith_arrowheads` goal.

### Crafting Bench
Construction material station. Same interaction pattern as Anvil (E to open, Space to craft). Recipes: Stone → ReinforcedBlock, Wood → WoodenFrame.

### Crate (Storage)
Unlimited storage capacity. Any resource type accepted by default.

**Accept-List Filter** — right-click a crate → "Set Filter" to choose which items it will accept. NPCs automatically route deposits to crates that accept the item being deposited. A yellow label above the crate shows the active filter.

### Conveyor Belt
Moves one item at a time between tiles (1 000 ms transfer tick). Frames auto-select for straight runs and curves. Shift + left-click to drop the held item. Right-click to delete the conveyor.

### PlacedStructure (Reinforced Block / Wood Frame)
Solid walls placed on the grid. Block player, NPC, and enemy movement via Arcade static physics.

| Type | HP | Drop on break |
|------|----|---------------|
| WoodFrame | 25 | 2 Wood (50 %) |
| ReinforcedBlock | 60 | 5 Stone (50 %) |

Enemies attack walls blocking their path.

### Door
Opens / closes with E when the player is within 90 px. NPCs auto-open when pathing through and close behind themselves after ~600 ms. Enemies cannot open doors — they attack them instead.

| Property | Value |
|----------|-------|
| HP | 30 |
| Open state | Removed from grid / collision group |

---

## NPCs

Workers controlled by a JSON task queue. Spawn near the Mother Machine.

### Stats

| Property | Value |
|----------|-------|
| Base speed | 100 px/s |
| Speed Tier 1 upgrade | × 1.2 |
| Speed Tier 2 upgrade | × 1.4 |
| Carry capacity (default) | 10 per resource type |
| Arrive distance | 8 px |
| HP | 10 + (Constitution level × 5) |
| Death recovery | 60 s respawn at Mother Machine |
| Chat bubble duration | 6 s |
| Task evaluation rate | 200 ms |

### Upgrades (applied at Mother Machine)

| Upgrade | Effect |
|---------|--------|
| Speed Tier (0/1/2) | Movement speed ×1.0 / ×1.2 / ×1.4 |
| Carry Capacity | Max items per resource type (default 10) |
| Task Efficiency | Multiplier on crafting durations (lower = faster) |
| Combat Module | NPC engages enemies autonomously without a manual combat goal |

### Assigned Targets (Ctrl + click)
Each NPC can have one assigned furnace, quarry, crusher, and anvil, plus an ordered list of crates and flywheel(s). A `crateOreMap` can route specific ore types to specific crates (e.g. CopperOre → crate 0, TinOre → crate 1).

### Task Queue
Tasks are set via the chat interface or the NPC Task Panel. The queue is evaluated every 200 ms. One-shot tasks dequeue when complete; **loop** tasks run forever until replaced.

#### One-Shot Tasks

| Task | Description |
|------|-------------|
| gather | Walk to tree / quarry, gather until carry capacity |
| deposit | Walk to crate, deposit item (amount or "all") |
| fill | Walk to furnace, load wood or ore |
| smelt | Wait at furnace until smelting finishes |
| follow | Stay within 1 tile of player, fight nearby threats |
| crank | Walk to flywheel, crank until momentum ≥ 80 % |
| attack / attack_nearest_enemy | Fight target or nearest enemy |
| patrol_area | Wander random circuit within radius, interrupt for enemies |
| defend_player | Circle player, fight threats within 4-tile range |
| defend_location | Guard fixed point, return if drifted, fight intruders |
| fletch | Craft arrows using NPC's own inventory |
| smith_arrowheads | Walk to anvil, convert IronBars → IronArrowheads |
| fetch_from_crate | Take quantity of item from crate into NPC inventory |

#### Loop Goals (combined in a `loop` task, evaluated in priority order)

| Goal | Key Params | Description |
|------|-----------|-------------|
| fill_furnace_wood | threshold (default 5) | Keep furnace wood supply above threshold |
| gather | item | Gather if NPC has none of item |
| gather_from_rocks | oreResKey, targetQty | Mine specific ore until qty reached |
| deposit_extra | item | Dump surplus of item into crate |
| deposit_ore | oreResKey | Deposit ore using crateOreMap routing |
| crank_flywheel | threshold (default 20) | Crank whichever flywheel is lowest |
| hunt_for_feathers | targetQty (default 10) | Kill chickens, collect feathers |
| gather_wood_for_arrows | targetQty | Gather wood for fletching |
| smith_arrowheads | arrowheadQty, ironQty, targetHeads | Smith at anvil |
| fetch_arrowheads | qty | Collect arrowheads from crate |
| craft_arrows | qty | Fletch arrows at anvil |
| deposit_arrows | — | Deposit finished arrows to crate |
| attack_nearest_enemy | range (8 tiles) | Combat loop |
| defend_player | range (4 tiles) | Follow player, fight threats |
| defend_location | x, y, range (5 tiles) | Guard fixed point |

---

## Combat

### Melee Damage Formula

```
maxHit   = floor(strengthLevel × 1.2) + 1
rawDamage = random(0, maxHit)          // 0 = miss
final    = max(0, rawDamage − defenceBonus)
```

Level 1 Strength → max hit 2. Level 10 → max hit 13.

### Enemy Stats (default chicken-variant)

| Stat | Value |
|------|-------|
| HP | 10 |
| Damage | 2 per hit |
| Speed | 70 px/s |
| Aggro range | 8 tiles (384 px) |
| Attack range | ~0.9 tiles (43 px) |
| Attack cooldown | 1 800 ms |

**Loot drops on death**: 70 % → 1–3 Ore; 40 % → 1–2 Iron; 20 % → 1–2 Feather.

### XP Per Hit
| Action | XP |
|--------|----|
| Melee miss | 2 Attack |
| Melee hit | 4 Attack + 4 Strength |
| Arrow hit | 15 Archery |

---

## LLM Chat System

The chat system lets you give any NPC a plain-English instruction. It translates the instruction into a structured JSON task list and loads it into the NPC's task queue.

### How It Works — End to End

```
Player types command
       │
       ▼
ChatBox.js   ─── builds payload ──────────────────────────────────────────┐
                                                                           │
                  POST /parse_command (FastAPI, port 8000)                 │
                       │                                                   │
                       ▼                                                   │
               _route()  ─ llama3.2 reads router.txt prompt               │
                          ─ outputs one category word:                     │
                            gather | store | smelt | craft |               │
                            crank | combat | follow | idle                 │
                       │                                                   │
                       ▼                                                   │
               _specialist() ─ loads <category>.txt prompt                │
                             ─ llama3.2 outputs JSON array                 │
                             ─ _extract_json() pulls out the [ ]           │
                             ─ _validate_commands() drops unknown           │
                               tasks / goals, logs dropped items           │
                       │                                                   │
                       ▼                                                   │
              { "commands": [...] }  ◄─────────────────────────────────────┘
                       │
                       ▼
         npc.taskRunner.setTasks(commands)
```

### Payload Sent to Server

```json
{
  "text": "keep the flywheel spinning",
  "npc_id": "npc_0",
  "world_context": {
    "trees": 5, "furnaces": 2, "crates": 3,
    "quarries": 1, "crushers": 1
  },
  "npc_context": {
    "inventory": { "Wood": 5, "Iron": 2 },
    "skills": { "mining": 3, "attack": 1 },
    "assigned": {
      "furnace": { "col": 5, "row": 10 },
      "crates": [{ "col": 3, "row": 8 }],
      "mine_rocks": [{ "col": -5, "row": 3, "rockType": "CopperOre" }]
    }
  }
}
```

### Server — Router (`router.txt`)
`llama3.2` at temperature 0 reads the instruction and the list of valid categories, outputs exactly one word. Categories: `gather`, `store`, `smelt`, `craft`, `crank`, `combat`, `follow`, `idle`. Unknown categories are logged and fall back to `fallback.txt` (which returns `[{"task":"idle"}]`).

### Server — Specialist Prompts

Each specialist prompt file contains:
- A system description of its domain
- The available tasks / loop goals with their JSON shapes
- Mapping rules (e.g. "Kill chickens" → `hunt_for_feathers` goal)
- Negation rules ("stop …" → `[{"task":"idle"}]`)
- Few-shot examples (input → output JSON)

| Prompt file | Handles |
|-------------|---------|
| `gather.txt` | Mining, ore gathering, rock-specific goals (`gather_from_rocks`, `deposit_ore`) |
| `store.txt` | Depositing items, crate routing, `deposit_extra`, `deposit_ore` |
| `smelt.txt` | Furnace filling, smelting cycles, wood/ore loops, `deposit_extra` |
| `craft.txt` | Full arrow production pipeline (feathers → wood → smith → fetch → fletch → deposit) |
| `crank.txt` | Flywheel charging, one-shot and loop maintenance |
| `combat.txt` | `hunt_for_feathers`, `attack_nearest_enemy`, `defend_player`, `defend_location` |
| `follow.txt` | Follow player, guard, stand down |
| `fallback.txt` | Any unrecognised category → idle |

### Output Validation (`_validate_commands`)
Before the commands reach the game, the server validates every item:
- Drops any `task` not in the known set
- Drops any loop `goal` not in the known set (logs the dropped item)
- Returns `[{"task":"idle"}]` if nothing valid remains

### Local Pattern Matching (no server needed)
Some inputs are parsed directly in `ChatBox.js` without hitting the server:

| Pattern | Action |
|---------|--------|
| `"your name is <name>"` | Immediately renames the NPC |
| Mine / gather + ore type + optional "loop" + optional "store" | Builds a `gather_from_rocks` (+ `deposit_ore`) loop task with crateOreMap routing |
| `"kill chickens and make arrows"` | Full arrow-production loop goal sequence |

### Quick-Command Menu
When chat opens, a menu of preset commands appears above the input. Commands are loaded from `src/data/quickChatCommands.json`. Single-click to pre-fill the input.

### NPC Context Sent Per Request
- NPC inventory (resource → amount)
- Skill levels (not raw XP)
- Assigned targets (furnace, crates[], mine_rocks[] with `rockType`)
- World counts (trees, furnaces, crates, quarries, crushers)

This context helps the specialist choose correct loop parameters (e.g. which ore to mine, which crate to target).

---

## Building & Placement

Open with **B**. Locked items (tier too high) appear greyed-out.

### All Buildables

| ID | Label | Tier | Notes |
|----|-------|------|-------|
| conveyor | Conveyor Belt | 1 | Multi-tile runs; curves auto-generated |
| quarry | Quarry | 1 | Needs adjacent powered flywheel |
| crusher | Ore Crusher | 1 | Needs adjacent powered flywheel |
| furnace | Iron Furnace | 1 | |
| steel_furnace | Steel Furnace | 1 | |
| bronze_furnace | Bronze Furnace | 1 | |
| crate | Storage Crate | 1 | Unlimited capacity |
| flywheel | Flywheel | 1 | |
| anvil | Anvil | 1 | Smithing station |
| crafting_bench | Crafting Bench | 1 | Construction materials |
| reinforced_block | Reinforced Block | 1 | Wall; costs 1 ReinforcedBlock |
| wood_frame | Wood Frame | 1 | Light wall; costs 1 WoodenFrame |
| door | Door | 1 | Costs 1 Door item |
| wall | Wooden Wall | 2 | |
| gate | Gate | 2 | |
| tower | Watch Tower | 3 | |
| pylon | Claim Pylon | 3 | |

### Placement Flow
1. Select buildable from menu
2. Ghost preview follows mouse (blue = free, red = occupied)
3. Click to place (conveyors: click start then end tile for a run)
4. ESC or B to cancel

Conveyors snap to horizontal or vertical runs. Curve frames are automatically computed from input/output direction combinations.

---

## Save System

Auto-saves to `localStorage['futuregame_save']` every 30 seconds. Manual save: Ctrl + S.

### What Is Saved

| Category | Data |
|----------|------|
| Meta | version, motherMachineTier |
| Player | inventory |
| Conveyors | col, row, direction, outDir, held item |
| Crates | col, row, stored items map, acceptList filter |
| Furnaces | col, row, type, input slots, bars, wood, smelt/burn state |
| Quarries | col, row, ore count |
| Crushers | col, row, ore/iron, crushing state |
| Flywheels | col, row, momentum (0–100) |
| Anvils | col, row, active recipe ID |
| Crafting Benches | col, row, active recipe ID |
| Structures (walls) | col, row, type, current HP |
| Doors | col, row, current HP, open state |
| Ground Items | x, y, resource, amount |
| NPCs | id, x, y, name, inventory, skills, upgrades, task queue, assigned targets |

Object references are serialised as positional keys (col/row or x/y). Task queues are JSON-cloned (no live object refs). Damaged structures restore their HP bar on load.

---

## Numbers Reference

| Constant | Value |
|----------|-------|
| Tile size | 48 px |
| Main map | 30 × 20 tiles |
| West zone | 20 × 20 tiles |
| Player walk | 160 px/s |
| Player run | 280 px/s |
| NPC base speed | 100 px/s |
| Interact distance | 90 px |
| Tree chop distance | 80 px |
| Tree regrow | 15 000 – 30 000 ms |
| Conveyor tick | 1 000 ms |
| Player melee cooldown | 1 400 ms |
| Enemy attack cooldown | 1 800 ms |
| Enemy aggro range | 8 tiles / 384 px |
| Flywheel max momentum | 100 |
| Flywheel activate threshold | 20 % |
| Flywheel charge (cranking) | +6 per 300 ms ≈ 20 / s |
| Flywheel decay (idle) | −3 / s |
| Furnace smelt time | 5 000 ms |
| NPC carry capacity | 10 per resource (default) |
| NPC respawn | 60 s |
| Chicken respawn | 30 – 45 s |
| HP regen (out of combat) | 1 HP / 30 s |
| HP regen (in combat) | 1 HP / 5 s |
| Auto-save interval | 30 s |
| NPC task eval rate | 200 ms |
| Chat bubble duration | 6 s |
| Auxserver address | 127.0.0.1:8000 |
| Ollama model | llama3.2:latest |
