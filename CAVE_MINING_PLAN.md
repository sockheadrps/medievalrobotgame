# Cave Mining System

## Overview

Procedural underground mining system where players dig into rock walls at the edges of cave_01, opening tiles one at a time. Mined areas illuminate nearby tiles, revealing ore deposits that were pre-seeded at generation based on depth from the entrance. Each player + their NPCs share a mine instance; other players get separate instanced caves (deferred — single-player focus first).

## Map & State Model

### Tile data model

Each tile in the grid stores three independent properties:

- **tile_type**: `open | wall | hardwall | bedrock`
  - `open` — walkable floor
  - `wall` — standard rock, mineable with any pickaxe (depth 0-29)
  - `hardwall` — dense rock starting at depth 30+, requires iron pickaxe or better
  - `bedrock` — unbreakable, defines the outer boundary of the mine
- **tile_known**: `true | false` — has the player ever seen this tile? Known tiles render dimmed when not currently lit. Unknown tiles render as black.
- **tile_visible**: `true | false` — is this tile currently within a light radius? Visible tiles render at full brightness.

Additionally, each wall/hardwall tile stores pre-seeded hidden data:
- **ore_type**: `null | "stone" | "clay" | "coal" | "raw_iron_ore" | "raw_gold_ore" | "geode"` — what resource this tile yields when mined
- **ore_amount**: integer — how much drops
- **vein_id**: `null | string` — if part of a pure vein cluster, the shared vein ID

Ore data is assigned deterministically at grid generation (seed-based), not rolled on reveal. Revealing a tile exposes its pre-existing content. This prevents re-roll exploits and ensures world consistency.

### Cave mine grid

Server maintains a per-player grid persisted to DB (JSON blob or dedicated table keyed by player_id).

On first cave entry:
1. Initialize from `cave_01.json` existing tiles as `open`
2. Compute wall frontier — any tile adjacent to an open tile becomes `wall` or `hardwall` (based on depth)
3. Pre-seed ore data for all wall/hardwall tiles using depth-based distribution
4. Mark tiles beyond max bounds as `bedrock`

### Entry points

Three mine entrances at the edges of cave_01:
- **Top edge** (~col 20, row 0): north shaft
- **Bottom edge** (~col 20, row 39): south shaft
- **Left edge** (col 0, ~row 20): west shaft

Each entrance starts with 1-2 pre-placed wall tiles the player can begin mining. Visually marked with support beam sprites or lanterns.

### Expandable bounds

The base cave_01 is 40x40. The mineable area extends up to **70x70** (15 tiles beyond each edge). Beyond that: `bedrock` tiles (visible but unbreakable). The grid dynamically grows as players mine toward edges.

## Mining Mechanics

### Interaction

1. Player faces a wall/hardwall tile → click or action key → sends `mine_tile {col, row}` to server
2. Server validates: tile is wall/hardwall, player has required pickaxe, player is adjacent
3. Mining takes time based on pickaxe tier (progress bar on client)
4. On completion in one action: tile flips to `open`, player receives the tile's pre-seeded ore drop, new adjacent tiles become wall/hardwall frontier, visibility recalculates

Ore is a **wall modifier**, not a separate world object. Mining a wall tile that contains iron ore breaks the wall AND yields the iron ore in a single interaction. No double-click.

### Wall types

| Wall type | Depth | Appearance | Pickaxe required |
|-----------|-------|------------|-----------------|
| `wall` | 0-29 | Standard grey rock | Bronze (any) |
| `hardwall` | 30+ | Darker, cracked rock with visible veins | Iron or better |

Attempting to mine `hardwall` with a bronze pickaxe shows a message: "This rock is too dense for your pickaxe." This creates a natural progression gate — players must refine iron nuggets and craft an iron pickaxe before accessing the deep zone where pure veins and the best resources spawn.

### Pickaxe progression

| Pickaxe | Mining time (wall) | Mining time (hardwall) | Recipe | Required level |
|---------|-------------------|----------------------|--------|----------------|
| Bronze  | 3s | cannot mine | starter / 2 raw_copper + 1 wood | 1 |
| Iron    | 2s | 3.5s | 5 iron_nugget + 2 wood | 10 |
| Steel   | 1.5s | 2.5s | 5 iron_nugget + 3 coal | 20 |
| Mithril | 1s | 1.5s | 5 gold_nugget + 5 iron_nugget | 35 |

Players start with a bronze pickaxe. Pickaxe is an equipment item (slot: "tool") following the existing `assets/equipment/` pattern.

### Visibility & illumination

**Light radius:** When a tile becomes open, mark all tiles within a radius as `tile_visible = true`:
- Open tiles: full visibility, 5-tile radius
- Wall/hardwall tiles: revealed at 2-3 tile radius from nearest open tile (keeps exploration tense)

**Fog of war rendering:**
- `tile_visible = true` → full brightness
- `tile_known = true, tile_visible = false` → dimmed/darkened (player has seen before but not currently lit)
- `tile_known = false` → black (never seen)

Previously discovered tiles never go fully black again. This prevents disorientation when backtracking through tunnels.

Server only sends tile data for `tile_known = true` tiles to the client. Unknown tiles are omitted entirely.

## Ore Generation

### Depth calculation

"Depth" = Euclidean distance from the nearest entrance tile to the target tile, rounded down. This produces natural circular resource zones instead of the diamond shapes Manhattan distance would create.

Depth is precomputed as a field across the grid at generation time.

### Depth zones

| Depth | Wall type | Available ores |
|-------|-----------|---------------|
| 0-5 | wall | stone (common), clay (common), coal (uncommon) |
| 5-15 | wall | above + raw_iron_ore (rare → uncommon) |
| 15-30 | wall | raw_iron_ore (uncommon → common), raw_gold_ore (rare, ramps linearly), geode (rare, ramps linearly) |
| 30+ | **hardwall** | frequencies cap at depth-30 values; **pure veins** begin spawning rarely; geodes continue at capped rate |

All ore data is assigned at grid generation, not on reveal. Each wall/hardwall tile gets its ore_type and ore_amount from a seeded RNG based on (player_id, col, row).

### Ore as wall modifier

Ore exists as a property of the wall tile, not as a separate world object. When a wall tile is revealed (becomes `tile_known`), the client renders the wall sprite with an ore overlay if ore_type is non-null (e.g., copper-flecked rock, gold-veined rock). Mining the tile breaks the wall and yields the ore in one action.

This replaces the previous design of spawning `worldobj:` entities on revealed walls.

### Pure veins (30+ depth, hardwall only)

Generated via "vein anchor" system at grid init:
1. For each hardwall tile, roll anchor chance (~2% iron, ~0.5% gold)
2. If anchored, flood-fill 3-5 connected hardwall tiles to form the cluster
3. No overlap check — if a tile is already claimed by a vein, skip it
4. All tiles in a vein share a `vein_id` and yield **nuggets directly** (skip raw ore)
5. When any tile in a vein cluster becomes `tile_known`, all tiles in that vein illuminate at once (dramatic reveal)

**Pity system:** Track tiles mined since last vein discovery. After 40 tiles with no vein, double the anchor chance. After 60, triple it. Resets on discovery.

## Resources & Refining

### Raw ore → nuggets

| Input | Output | Station |
|-------|--------|---------|
| 10 raw_iron_ore | 2-5 iron_nugget | furnace |
| 10 raw_gold_ore | 2-5 gold_nugget | furnace |

Guaranteed minimum of 2 nuggets per smelt. UI shows expected yield range at current metallurgy level (e.g., "Expected: 2-4 iron nuggets").

### Geodes

Geodes are opaque inventory items found while mining at depth 15+. They cannot be opened in the field — they must be brought back and processed at a **rock crusher** station.

**Processing:** Player places geode in rock crusher → processing time (~5s) → output revealed:

| Output | Chance | Notes |
|--------|--------|-------|
| Empty (rubble) | ~25% | dud, yields 1-2 stone |
| Common crystal | ~40% | |
| Rare crystal | ~20% | visually distinct color |
| Gem (ruby, sapphire, emerald) | ~12% | random gem type |
| Pristine gem | ~3% | highest value, crafting ingredient |

Geode output chances improve with metallurgy skill (dud chance decreases, gem chances increase). At metallurgy level 10, dud chance drops to ~10% and pristine gem chance rises to ~8%.

**Rock crusher station:**
- Buildable structure, placed in the cave or overworld
- Recipe: 10 stone + 5 iron_nugget
- Simple interaction: click with geode selected → progress bar → output
- Future upgrade tiers could process faster or batch-process multiple geodes

### Metallurgy skill

- Gains XP on each smelt/refine action AND each geode processed
- Levels 1-10; each level shifts nugget and geode output distributions upward
- Level 1: average ~2.5 nuggets per smelt; Level 10: average ~4.5 nuggets
- Displayed in player stats panel

### Furnace tiers (deferred)

Multiple furnace unlocks planned — higher tiers improve:
- Smelt speed
- Nugget output probability
- Unlocks at metallurgy skill thresholds

Details TBD when implementing the refining game loop.

## NPC Support

- Extend existing `mine_ore` NPC task with `mine_wall` variant
- Player directs NPC: "mine north/south/west" → NPC searches for nearest wall tile in that direction within a 10-tile search radius
- If no valid wall found, NPC reports back and idles
- NPCs contribute to `tile_known` / `tile_visible` with their own light radius as they dig
- NPCs respect pickaxe requirements — NPC must have an iron+ pickaxe equipped to mine hardwall
- NPC drops go to NPC inventory (existing behavior)
- NPCs will not path through other NPCs currently mining (avoid stacking)

## Implementation Phases

### Phase 1: Core mine state + mining action
- Server: tile data model (type, known, visible, ore_type, ore_amount, vein_id)
- Server: grid init from cave_01.json, wall frontier computation, bedrock bounds
- Server: deterministic ore seeding with depth-based distribution
- Server: `mine_tile` handler with adjacency + pickaxe validation
- Client: send `mine_tile` on wall click, render mining progress bar
- Client: receive updated tile data, render open/wall/hardwall/bedrock tiles
- Bronze pickaxe equipment asset

### Phase 2: Visibility & fog of war
- Server: light radius calculation (5 for open, 2-3 for wall reveal)
- Server: tile_known / tile_visible tracking, only send known tiles to client
- Client: full brightness / dimmed / black rendering based on visibility state
- Client: ore overlay sprites on wall tiles that have ore_type
- Entry point markers (support beams / lanterns)

### Phase 3: Ore drops + hardwall
- Ore drop on mine completion (pre-seeded, not rolled)
- Hardwall tiles at depth 30+ with different sprite
- Pickaxe gating — bronze cannot mine hardwall
- Stone, clay, coal, raw_iron_ore, raw_gold_ore, geode as inventory items
- Iron pickaxe equipment asset + recipe

### Phase 4: Geodes + rock crusher
- Geode as inventory item (opaque, unprocessed)
- Rock crusher station — buildable structure, recipe, placement
- Geode processing interaction with output table
- Crystal and gem item definitions (common crystal, rare crystal, ruby, sapphire, emerald, pristine gem)

### Phase 5: Pure veins + refining
- Vein anchor generation at grid init, flood-fill clusters
- Pity system for vein discovery
- Vein dramatic reveal (all tiles illuminate on first discovery)
- Raw ore → nugget refining action (basic furnace interaction)
- Guaranteed minimum output (2 nuggets), visible expected yield
- Metallurgy skill XP and leveling (covers smelting + geode processing)

### Phase 6: NPC mining
- `mine_wall` NPC task with directional search
- NPC pickaxe requirements for hardwall
- NPC fog-of-war contribution
- Fallback behavior when no valid wall found
- Path blocking avoidance

### Phase 7 (deferred): Multi-player instancing
- Per-player mine state keyed by player_id
- Separate cave instances on map transition
- Furnace tier unlocks and progression
