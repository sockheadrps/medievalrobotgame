# Iron Anachronism — Feature Brainstorm & Architecture Roadmap

## Implementation Checklist

- [x] **Step 1** — Items system (`src/data/items.js`) — central item registry (weapons, armor, resources, building materials, consumables)
- [x] **Step 1b** — New skills in `skills.js` — Attack, Strength, Defence, Archery, Constitution + full Bronze/Iron/Steel weapon & armor smithing recipes
- [x] **Step 2** — HP & Combat stats — add `hp`/`maxHp` to Player and NPC, wire Constitution skill, HP bar UI above heads
- [x] **Step 3** — Mother Machine tier system — integer tier on GameScene, BuildMenu reads it, tier display in HUD
- [x] **Step 4** — NPC upgrades — `this.upgrades` on NPC, upgrade panel at Mother Machine, save/load
- [x] **Step 5** — CombatSystem — hit detection, damage calc, death/respawn handling
- [x] **Step 6** — Enemy entity — pathfinding to target, basic attack loop, loot drops
- [x] **Step 7** — NPC combat tasks — extend NPCTaskRunner with `attack_nearest_enemy`, `patrol_area`, `defend_player`, `defend_location` goals + auto-defend
- [x] **Step 8** — LLM/auxserver hardening — prompt consistency fixes, output validation, context filtering, unknown-category logging

**— Implement Later —**
- [ ] Wall / Tower / Pylon structures — new entity files (Wall.js, Tower.js, Pylon.js) following Furnace/Crate pattern
- [ ] HeatSystem — accumulate heat, trigger enemy spawns at thresholds
- [ ] WorldNPC entity — patrol routes, static merchants, aggression state machine
- [ ] FactionSystem + DiplomacySystem — reputation tracking, trade UI, chat routing to WorldNPCs
- [ ] Construction tasks — NPC carries materials to build site, `construct` goal in NPCTaskRunner

---

## What's Already Done (Skip Brainstorming)

The core loop is solid:
- Skills + XP (Woodcutting, Mining, Smithing, Fletching, Combat) — RS-style curve
- NPC task runner (gather, deposit, fill, smelt, crank, loop, follow)
- Furnace, Quarry, Crusher, Flywheel, Conveyor, Anvil, Crate
- Save/load (localStorage), per-NPC SkillSystem, ChatBox → LLM
- SkillsPanel, NPCTaskPanel, NPCSkillsPanel, ContextMenu

---

## 1. Skill System Extensions

### New Skills to Add
Add to `src/data/skills.js` as new entries in `SKILL_DEFS`:

| Skill | XP Sources | What It Unlocks |
|-------|------------|-----------------|
| **Attack** | Landing hits in melee | Melee weapon accuracy multiplier, melee weapon recipes |
| **Strength** | Melee hits | Melee damage, carrying capacity bonus at certain levels |
| **Defence** | Taking damage while in combat | Damage reduction %, armor recipes unlock |
| **Archery** | Bow shots that hit | Arrow damage bonus, bow crafting at higher levels |
| **Constitution** | Always ticking in combat, or per kill | Max HP increase per level (starts at 10 HP lvl 1, grows) |
| **Construction** | Placing buildings, upgrading structures | Unlocks higher-tier buildings, walls, defensive towers |
| **Herblore** | Mixing potions | Buff potions (speed, strength, regen) |
| **Agility** | Optional: running on stamina | Movement speed bonus, stamina bar (future) |

### How HP Works
- Base HP = `10 + (Constitution_level * 5)` — level 1 = 15 HP, level 99 = 505 HP
- HP regenerates slowly over time (1 HP every 30s out of combat, 1 HP every 5s in combat)
- HP displayed as a bar above the player head (and each NPC)
- Death: player respawns at Mother Machine with reduced inventory; NPCs respawn after 60s

### Level-Gated Crafting (already partially wired via `levelRequired`)
Every recipe in `SKILL_DEFS` already supports `levelRequired`. Extend pattern:

```js
// In src/data/skills.js
{ id: 'smithing', recipes: [
  { id: 'smith_arrowhead',    levelRequired: 1,  ... },
  { id: 'smith_iron_sword',   levelRequired: 10, ... },
  { id: 'smith_iron_shield',  levelRequired: 15, ... },
  { id: 'smith_steel_sword',  levelRequired: 30, ... }, // requires SteelBar (new ore tier)
  { id: 'smith_plate_helm',   levelRequired: 40, ... },
]}
```

SkillsPanel already dims recipes below `levelRequired` — no UI changes needed.

### XP Scaling by Tier
Higher-tier materials give more XP:

| Action | XP |
|--------|----|
| Chop normal tree | 25 Woodcutting |
| Chop hardwood tree (future, req lvl 30) | 65 Woodcutting |
| Mine copper ore | 10 Mining |
| Mine iron ore | 17 Mining |
| Mine gold ore (future, req lvl 40) | 40 Mining |
| Kill chicken | 20 Combat, 15 Strength |
| Kill boar (future) | 50 Combat, 35 Strength |
| Smith arrowhead | 15 Smithing |
| Smith iron sword | 35 Smithing |

---

## 2. Weapons & Armor

### Ore Tiers → Weapon/Armor Tiers

```
Copper (new ore, shallow quarry) → Bronze weapons/armor (low stats)
Iron (existing)                  → Iron weapons/armor (mid stats)
Coal (new, quarry deep)          → needed to smelt Steel
Steel (Iron + Coal in furnace)   → Steel weapons/armor
Gold (future, rare)              → Gold jewelry (magic bonuses)
```

### Weapon Types & Stats

| Weapon | Inputs | Smithing Lvl | Attack bonus | Speed |
|--------|--------|-------------|--------------|-------|
| Bronze Sword | 2 BronzeBar | 1 | +5 | 1.2s |
| Iron Sword | 2 IronBar | 10 | +12 | 1.4s |
| Steel Sword | 2 SteelBar | 30 | +24 | 1.5s |
| Iron Dagger | 1 IronBar | 5 | +8 | 0.8s |
| Shortbow | 1 Wood (yew) | — | — | ranged |
| Longbow | 2 Wood (yew) | — | — | ranged, longer range |

Weapons are **items in inventory**. Player or NPC equips by having them selected.
- Player: Weapon selection via quick-slot UI (1, 2, 3 keys)
- NPC: Equipped via task/chat command ("equip iron sword")

### Armor Types & Stats

| Piece | Inputs | Smithing Lvl | Defence bonus |
|-------|--------|-------------|---------------|
| Iron Helmet | 1 IronBar | 15 | +5 |
| Iron Chestplate | 3 IronBar | 20 | +12 |
| Iron Legs | 2 IronBar | 18 | +9 |
| Iron Shield | 2 IronBar | 15 | +8 |

Defence stat → `damage_taken = base_damage * (1 - defence_bonus / 200)` (caps at 75% reduction)

### Where Weapons/Armor Are Stored
- New inventory item types: `BronzeSword`, `IronSword`, `IronHelmet`, etc.
- Stored in Crates, player inventory, or NPC inventory
- NPCs can be equipped from crate via task: `{ task: "equip", item: "IronSword" }`

---

## 3. NPC Crafting & Upgrades

### Crafting Additional NPCs
NPCs are physical entities, not spawned from thin air. Craft them at the Mother Machine:

```
NPC Blueprint (Basic) = 10 IronBar + 5 Wood + 3 Stone
  → Spawns a basic NPC with starting stats (Lvl 1 all skills, default speed/carry)
  → Requires: Mother Machine Tier 2 (see §7)
```

This means you're investing resources to grow your workforce — not just clicking "spawn".

### NPC Upgrade System
Upgrades are applied at the Mother Machine by interacting with a selected NPC:

| Upgrade | Materials | Effect |
|---------|-----------|--------|
| Speed Boost I | 5 IronBar + 2 Feather | +20% movement speed |
| Speed Boost II | 10 SteelBar + 5 Feather | +40% movement speed |
| Carry Capacity I | 5 IronBar + 3 Wood | +5 inventory slots / carry limit |
| Carry Capacity II | 10 SteelBar | +15 carry limit |
| Task Efficiency | 5 IronBar + cogwheel (new item) | -20% time on all timed tasks |
| Combat Module | 10 IronBar + 2 IronSword | NPC can engage enemies autonomously |
| Skill Chip (Woodcutting) | rare drop | Grants +10 levels to that NPC's woodcutting |

Implementation in NPC.js:
```js
this.upgrades = {
  speedTier: 0,          // 0-3, multiplied against base SPEED constant
  carryCapacity: 10,     // max items per resource type
  taskEfficiency: 1.0,   // multiplier on craft/gather timers
  combatEnabled: false,  // can fight autonomously
};
```

Save/load via `SaveSystem` — add to NPC serialise/deserialise.

---

## 4. Building Materials & Construction Skill

### New Material Pipeline
Walls, towers, and structures require **building supplies** (not raw resources):

```
Stone + Iron in Furnace → Reinforced Block
Wood + Iron Nails (2 IronBar → 20 Nails) → Wooden Frame
Reinforced Block + Wooden Frame → Wall Segment
```

This gives the Furnace and Anvil additional roles beyond just smelting iron.

### Placeable Structures (new building types)

| Structure | Cost | Construction Lvl | Function |
|-----------|------|-----------------|----------|
| Wooden Wall | 5 WoodenFrame | 1 | Impassable, blocks enemies |
| Stone Wall | 5 ReinforcedBlock | 10 | Higher HP, projectile-resistant |
| Gate | 3 IronBar + 2 WoodenFrame | 15 | Opens/closes, NPC + player pathfind around |
| Watch Tower | 10 WoodenFrame + 5 IronBar | 20 | Ranged NPC station, sees farther |
| Defensive Tower | 10 ReinforcedBlock + 5 IronBar | 35 | Fires arrows at enemies in range |
| Claimed Pylon | 5 IronBar + 1 GoldBar | 5 | Marks territory, prevents enemy spawns in radius |
| NPC Barracks | 15 WoodenFrame + 10 IronBar | 25 | Houses crafted NPCs, sets patrol routes |

### Construction Flow
1. Player places structure blueprint (ghost preview, like current BuildMenu)
2. NPC assigned to "construct" task carries materials from crate to site
3. NPC stands at site, slowly builds (like an NPC crafting animation)
4. On completion, structure appears as solid entity with HP

### Construction Task (NPCTaskRunner extension)
```js
{ task: "construct", target: { col, row }, structure: "stone_wall", materials: [...] }
```

---

## 5. NPC Combat

### Direct NPC Combat Commands
Via chat or context menu:
- `"Fight anything that comes near"` → `{ task: "loop", goals: [{ goal: "attack_nearest_enemy" }] }`
- `"Protect that area"` → `{ task: "loop", goals: [{ goal: "patrol_area", cx, cy, radius }] }`
- `"Guard me"` → `{ task: "loop", goals: [{ goal: "defend_player", range: 3 }] }`
- `"Kill the enemies at the east gate"` → router detects "combat", specialist builds `attack_area` goal

### NPC Combat Goal Types (extend `_evalGoal` in NPCTaskRunner)
```js
{ goal: "attack_nearest_enemy" }          // find closest enemy, walk to it, attack
{ goal: "patrol_area", cx, cy, radius }   // walk patrol circuit, attack any enemy in range
{ goal: "defend_player", range: 3 }       // follow player, engage anything within 3 tiles
{ goal: "defend_location", cx, cy, r }   // hold position, aggro anything entering radius
{ goal: "assist_npc", targetId }          // fight whatever another NPC is fighting
```

### NPC Combat Mechanics
- NPC has equipped weapon (determines attack speed, damage)
- If no weapon, unarmed: low damage, slow
- Attack range: melee (1 tile), ranged (depends on weapon — NPCs can use bows too)
- NPC health: `10 + (Defence_level * 3)` HP, same regen as player
- On death: NPC enters "defeated" state for 60s, then respawns at Mother Machine with 50% XP lost

### Combat Module Upgrade (required)
NPCs without the Combat Module upgrade won't autonomously engage enemies — they'll run away.
This is a deliberate gate so early NPCs stay safe, and you have to invest in the upgrade.

---

## 6. World NPCs — Faction & Diplomacy System

### Non-Player NPC (NPNPC) Types

| Type | Default Aggression | Notes |
|------|--------------------|-------|
| Peasant | Neutral (0) | Can trade, can be hired |
| Merchant | Friendly (-1) | Has a shop inventory, buys/sells |
| Guard | Wary (1) | Attacks if provoked or player looks hostile |
| Bandit | Hostile (3) | Always aggressive, never trades |
| Knight | Very Hostile (4) | Sends raiding parties |
| Wanderer | Curious (0) | Roams, has random loot, quirky dialogue |

### Aggression Scale (0–5)
```
0 = Neutral   — ignores player/NPCs unless attacked
1 = Wary      — watches player, will attack if player enters their zone
2 = Suspicious — slowly approaches, demands explanation, escalates if no dialogue
3 = Hostile   — attacks player's NPCs on sight
4 = Aggressive — attacks player and NPCs on sight
5 = Berserk   — ignores self-preservation, doesn't stop until dead
```

Stored per NPNPC instance: `this.aggression = 0` (modified by interactions).

### How Aggression Changes
| Event | Aggression delta |
|-------|-----------------|
| Player talks politely | -1 |
| Player insults NPNPC | +1 |
| Player kills an NPNPC ally | +2 |
| Player steals from NPNPC | +2 |
| Player trades fairly | -1 |
| Player gives gift/bribe | -2 |
| Player's NPC attacks NPNPC | +3 |
| NPNPC attacked but wins | +1 |
| Time passes (global decay) | -0.1 per minute, min 0 (for neutral NPCs) |

Aggression is **per-NPNPC** but also influences faction-wide rep (all Guards in the region get +1 if you attack one guard).

### Chat Interaction via ChatBox
World NPCs respond to the player's chat input just like player-NPCs, but with different personalities. The LLM router needs a new category: `"diplomacy"` — handled by `auxserver/prompts/diplomacy.txt`.

The diplomacy specialist:
1. Reads the NPNPC's current aggression level
2. Generates a response (text bubble over NPNPC head)
3. Optionally returns a trade offer or aggression delta

```json
// Response format from diplomacy specialist
{
  "speech": "Aye, I'll trade ye that iron for yer arrows, stranger.",
  "aggression_delta": -1,
  "trade_offer": { "give": {"Arrow": 5}, "receive": {"IronBar": 2} }
}
```

### Trade System
- **Player initiates**: Right-click NPNPC → "Talk" → opens ChatBox targeting the NPNPC
- **NPNPC has inventory**: Persistent goods (Merchant restocks on a timer)
- **Offer/counter-offer**: ChatBox input goes to LLM diplomacy specialist, which models reasonable medieval bartering
- **NPC Trade**: Player's NPC can be sent to trade autonomously: `{ task: "trade", targetNpc: id, give: {...}, receive: {...} }` — NPC walks to NPNPC, executes trade if deal acceptable

### NPNPC Patrol & Spawn System
- World NPCs walk randomized patrol routes between waypoints
- Spawn on map edges (simulating arriving from beyond the map)
- Some are persistent (stationary merchants, camp guards); some are transient (wanderers)
- Aggression-5 NPNPCs form raiding parties if player's "heat" is high

### Heat System
Heat = how much attention the player has drawn from the outside world.

Sources:
- Placing buildings: +1 heat per building
- Killing NPNPCs: +5 heat per kill
- Having many armed NPCs: +2 heat per combat-module NPC
- Trading: -1 heat per completed trade
- Having claim pylons: -0.5 heat per pylon (looks "settled and peaceful")

Consequences by heat level:
```
0–10:   Occasional wanderers arrive
10–20:  Merchant caravans appear (trade opportunity)
20–40:  Guards start patrolling near your base perimeter
40–60:  Bandits start raiding storage crates at night
60–80:  Knight-led raiding parties attack your base
80–100: Siege — sustained assault until heat drops or you're destroyed
```

---

## 7. Mother Machine Tier Progression

The Mother Machine is the tech gate. Upgrading it unlocks new capabilities.

| Tier | Unlock Materials | Unlocks |
|------|-----------------|---------|
| **Tier 1** (start) | — | Basic gather/deposit NPC tasks, Quarry, Crusher, Furnace, Flywheel, Conveyor, Crate |
| **Tier 2** | 20 IronBar + 10 Stone + 5 Wood | NPC crafting, Anvil upgrades, BuildMenu: Walls, Towers, Gate; NPC Blueprint recipe |
| **Tier 3** | 30 SteelBar + 20 ReinforcedBlock + 10 GoldBar | Advanced ores, NPC combat modules, diplomacy tools, Defensive Tower, Barracks |
| **Tier 4** | rare quest materials | Automated defense systems, long-range scouts, deep quarries |

Tier is stored in `GameScene` as `this.motherMachineTier` and checked by `BuildMenu` and recipe lists to show/hide unlocked content.

---

## 8. File & Architecture Map for New Features

Where to add each new system, keeping the existing pattern:

### New Files

| File | Purpose |
|------|---------|
| `src/systems/CombatSystem.js` | Hit detection, damage calc, death/respawn, HP tracking (player + NPCs + enemies) |
| `src/systems/HeatSystem.js` | Tracks global heat, triggers events (raids, merchants, patrols) |
| `src/systems/FactionSystem.js` | Per-faction aggression scores, reputation tracking |
| `src/systems/DiplomacySystem.js` | Trade logic, NPNPC response parsing from LLM |
| `src/entities/WorldNPC.js` | Non-player NPC: patrol, aggression, inventory, dialogue state |
| `src/entities/Enemy.js` | Hostile entity: pathfinds to target, attacks, drops loot |
| `src/entities/Wall.js` | Placeable structure: HP, blocks movement |
| `src/entities/Tower.js` | Ranged defensive structure, targets nearest enemy in range |
| `src/entities/Pylon.js` | Territory claim, heat reduction radius |
| `src/entities/Barracks.js` | NPC housing, patrol assignment |
| `src/entities/Gate.js` | Passable wall for player/owned NPCs, closed to enemies |
| `src/ui/HPBar.js` | Reusable HP bar component used by player, NPCs, enemies |
| `src/ui/DiplomacyPanel.js` | Trade UI: shows NPNPC inventory, trade offer/counter |
| `src/ui/EquipmentPanel.js` | Player/NPC equipped items and slots |
| `src/ui/NPCUpgradePanel.js` | Shows NPC upgrade options at Mother Machine |
| `src/data/items.js` | All item definitions: weapons, armor, building materials, consumables |
| `src/data/buildings.js` | All buildable structure definitions (moved from BuildMenu inline data) |
| `src/data/factions.js` | Faction definitions: starting aggression, patrol routes, dialogue styles |
| `auxserver/prompts/diplomacy.txt` | LLM specialist for NPNPC chat interaction |
| `auxserver/prompts/combat.txt` | LLM specialist for directing NPC combat |

### Modified Files (extend, don't rewrite)

| File | What to Add |
|------|-------------|
| `src/data/skills.js` | Add Attack, Strength, Defence, Archery, Constitution, Construction skill defs + recipes |
| `src/entities/NPC.js` | `this.upgrades`, `this.hp`, `this.maxHp`, equipped weapon/armor slots |
| `src/systems/NPCTaskRunner.js` | New goal types: `attack_nearest_enemy`, `patrol_area`, `defend_player`, `construct`, `trade`, `equip` |
| `src/systems/SaveSystem.js` | Save NPC upgrades, WorldNPC state, buildings (Wall/Tower/Pylon), heat level, faction rep |
| `src/scenes/GameScene.js` | Spawn WorldNPCs/Enemies on heat events, wire CombatSystem/HeatSystem, Mother Machine tier check |
| `src/ui/BuildMenu.js` | Filter shown buildings by Mother Machine tier |
| `src/ui/ChatBox.js` | Detect if target is WorldNPC → route to DiplomacySystem instead of NPCTaskRunner |
| `auxserver/main.py` | Add `diplomacy` to valid categories, pass NPNPC context to LLM |

---

## 9. Data Model Extensions

### Item Definition (new: `src/data/items.js`)
All items defined centrally, referenced everywhere by string key:

```js
export const ITEMS = {
  // Resources (already exist as strings)
  Wood: { name: 'Wood', type: 'resource', stackable: true },
  IronBar: { name: 'Iron Bar', type: 'resource', stackable: true },

  // Weapons
  IronSword: {
    name: 'Iron Sword', type: 'weapon',
    attackBonus: 12, speed: 1.4,
    stackable: false,
    equipSlot: 'mainhand',
  },

  // Armor
  IronHelmet: {
    name: 'Iron Helmet', type: 'armor',
    defenceBonus: 5,
    stackable: false,
    equipSlot: 'head',
  },

  // Building materials
  WoodenFrame: { name: 'Wooden Frame', type: 'building_material', stackable: true },
  ReinforcedBlock: { name: 'Reinforced Block', type: 'building_material', stackable: true },

  // Consumables
  HealingPotion: { name: 'Healing Potion', type: 'consumable', effect: 'heal', value: 20 },
};
```

### NPC Serialization Shape (extended)
```js
// What SaveSystem should write per NPC
{
  id, x, y,
  inventory: { Wood: 3, ... },
  skills: { xp: { woodcutting: 500, ... } },
  upgrades: { speedTier: 1, carryCapacity: 15, taskEfficiency: 0.8, combatEnabled: true },
  equipment: { mainhand: 'IronSword', head: null, chest: null, legs: null },
  hp: 35,
  tasks: [],   // future: persist task queue
}
```

### WorldNPC State Shape
```js
{
  id, x, y,
  faction: 'guard',
  aggression: 1,
  patrol: [{ x, y }, ...],
  inventory: { IronBar: 5, Arrow: 20 },
  dialogue: { style: 'formal', memory: [] }, // memory = past interactions
}
```

---

## 10. LLM Prompt Extensions

### New Specialist Prompts Needed

| File | When Used | What It Does |
|------|-----------|-------------|
| `auxserver/prompts/diplomacy.txt` | Player talks to WorldNPC | Generates response text + aggression delta + optional trade offer |
| `auxserver/prompts/build.txt` | "Build a wall around the base" | Generates a list of construction tasks + material list |
| `auxserver/prompts/equip.txt` | "Equip your best weapon" | Returns equip task targeting best available weapon in NPC inventory/crate |
| `auxserver/prompts/upgrade.txt` | "Upgrade this NPC" | Suggests appropriate upgrade based on NPC current stats + available materials |

### NPC Context Enrichment (extend what ChatBox already sends)
Already partially implemented (`npc_context` in ChatBox). Extend with:
```json
{
  "npc_id": "npc_0",
  "npc_inventory": { "Wood": 3 },
  "npc_skills": { "woodcutting": 4, "combat": 2 },
  "npc_upgrades": { "speedTier": 1, "combatEnabled": true },
  "npc_equipment": { "mainhand": "IronSword" },
  "npc_hp": { "current": 35, "max": 50 },
  "assigned": { "crate": { "col": 5, "row": 3 }, "furnace": null },
  "world": { "trees": 8, "enemies_nearby": 2, "heat": 45 }
}
```

---

## 11. Suggested Implementation Order

Work from the inside out — don't add world NPCs before HP exists:

1. **Items system** (`src/data/items.js`) — centralizes all item definitions, cleans up string constants scattered across files
2. **HP & Combat stats** — add to Player and NPC, wire Constitution skill, add HP bar UI
3. **New skills** — Attack, Strength, Defence, Archery, Constitution in `skills.js` (the wiring is already there)
4. **New weapon/armor recipes** — entries in `skills.js`, no new systems needed
5. **Mother Machine tier system** — simple integer gate on `GameScene`, BuildMenu reads it
6. **NPC upgrades** — `this.upgrades` on NPC, upgrade panel at Mother Machine, save/load
7. **Wall/Tower/Pylon structures** — new entity files following existing Furnace/Crate pattern
8. **CombatSystem** — hit detection, damage, death handling
9. **Enemy entity** — simple pathfinding to target, basic attack loop
10. **HeatSystem** — accumulate heat, trigger enemy spawns
11. **WorldNPC entity** — patrol, static merchants, aggression state machine
12. **FactionSystem + DiplomacySystem** — reputation, trade, chat routing to WorldNPCs
13. **NPC combat tasks** — extend NPCTaskRunner with combat goals
14. **Construction tasks** — build system for walls/towers via NPC

---

## 12. Quick Wins (Low Effort, High Value)

Things that don't require new systems — just data or small code changes:

- **Add Attack/Strength/Defence/Constitution to `skills.js`** — 20 lines, immediately shows in SkillsPanel
- **Wire Archery XP to ArrowProjectile hits** — 2 lines in ArrowProjectile.js
- **Add more tree/ore types** — extend Tree.js with a `tier` prop, different XP amounts
- **Add `levelRequired` to existing recipes** — e.g. require Fletching 5 to fletch arrows
- **NPC HP bar** — add a thin red bar above NPC head, rendered with HP% width
- **Mother Machine tier display** — show current tier in HUD, grey out Tier 2 buildings until met
- **Rename skill "Mining" to "Mining" and add Stone mining XP** — 1 line
- **Add `cogwheel` as a rare quarry/crusher drop** — enables NPC Task Efficiency upgrade craftable from day 1

---

## 13. LLM / Auxserver Hardening

Current router+specialist pipeline is solid. These targeted improvements close known gaps without rearchitecting anything.

### Prompt Consistency Fixes (quick wins, high impact)

**Problem: `deposit_extra` goal is defined in `gather.txt` but missing from the "Available tasks" list in `smelt.txt` and `craft.txt`.**
The last example in `smelt.txt` already uses it, but since it's not listed as a valid goal, the model sometimes omits it for similar requests in those categories.
- Fix: add `{"goal": "deposit_extra", "item": "..."}` to the loop goals section in `smelt.txt` and `craft.txt`.

**Problem: `combat.txt` few-shot inconsistency.**
The rules state "Default targetQty is 10" but the first example uses 50 ("kill all the chickens"). The model learns from examples more than rules, so it over-produces.
- Fix: change the "kill all the chickens" example to targetQty 50 is intentional (player said "all"), but add a note: *only use 50+ if player says "all" or gives an explicit large number.* Otherwise, keep examples aligned with the stated default.

**Problem: Negations ("stop smelting", "stop gathering") only handled in `follow.txt`.**
Other specialists will return an unhelpful response or hallucinate a task.
- Fix: add a negation rule + example to each specialist: `"stop [action]" → [{"task": "idle"}]`

### Output Validation (medium effort, strong robustness)

Currently `_extract_json` in `main.py` parses whatever the LLM emits but doesn't check if the result is game-executable. An NPC receiving `{"task": "gather", "item": "fish"}` (item doesn't exist) or a loop goal missing `"goal"` key will silently fail or crash.

**Proposed: Pydantic schema validation after extraction.**

```python
# In main.py, after _extract_json():

from pydantic import BaseModel
from typing import Optional, List, Any

class GoalSchema(BaseModel):
    goal: str
    item: Optional[str] = None
    targetQty: Optional[int] = None
    qty: Optional[int] = None
    threshold: Optional[int] = None

class CommandSchema(BaseModel):
    task: str
    item: Optional[str] = None
    target: Optional[str] = None
    goals: Optional[List[GoalSchema]] = None

VALID_TASKS = {"gather", "store", "fill", "smelt", "loop", "crank", "follow", "idle"}

def _validate_commands(raw: list) -> list:
    out = []
    for cmd in raw:
        try:
            validated = CommandSchema(**cmd)
            if validated.task not in VALID_TASKS:
                continue   # drop unknown task silently
            out.append(cmd)
        except Exception:
            continue
    return out if out else [{"task": "idle"}]
```

This ensures the game never receives malformed commands regardless of what the LLM emits.

### Unknown-Category Logging (trivial, very useful)

Currently unknown router outputs silently fall back to `fallback.txt`. Add a log line so you can discover when players are asking for things that need a new specialist.

```python
# In _route(), replace:
return category if category in VALID_CATEGORIES else "fallback"

# With:
if category not in VALID_CATEGORIES:
    print(f"[Router] UNKNOWN category '{category}' for input: {text!r}")
    return "fallback"
return category
```

Over time, patterns in these logs reveal when you need a new specialist (e.g., "equip", "build", "trade").

### Radius-Filtered Context (defer until ≥10 NPCs)

As buildings multiply, `world_context` grows and bloats the specialist prompt. When you have many buildings, filter to only objects within ~300px of the NPC before sending:

```js
// In ChatBox._buildNpcContext() (ChatBox.js):
// Filter world objects by distance to NPC before including in context.
// ~300px radius keeps the context small and relevant.
const NPC_CONTEXT_RADIUS = 300;
// ... filter trees, quarries, furnaces etc. by Math.hypot(obj.x - npc.x, obj.y - npc.y) < NPC_CONTEXT_RADIUS
```

Not worth doing until world_context is actually large enough to matter.

### What Was Considered and Skipped

**"Desired state" LLM approach (task list → goal state):** The suggestion is to have the LLM output a *desired world state* and let the game engine plan the task sequence. This is a sound idea architecturally (it's basically GOAP), but it requires a planning system in `NPCTaskRunner` that doesn't exist yet. The current approach — LLM generates explicit goal sequences — works fine for a small goal vocabulary. Revisit after Step 11 (NPC combat tasks) once `NPCTaskRunner` is more complex.

**Batched `/parse_command`:** Premature optimization. HTTP overhead only matters when many NPCs are issuing commands simultaneously (rarely true in practice since commands are player-triggered). Revisit if profiling shows it's a bottleneck.

**Router logprobs confidence scoring:** `llama3.2` via Ollama doesn't expose calibrated logprobs in a useful way. The router's `temperature=0` + single-word output already gives near-deterministic behavior. Not actionable without a different model/API.
