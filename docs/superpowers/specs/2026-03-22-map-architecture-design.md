# Map Architecture: Per-Player Home Maps + Shared Central Map

**Date:** 2026-03-22
**Status:** Approved
**Branch:** ai-rival-simplify

## Overview

Restructure the game's map system from a single shared overworld into a three-layer architecture: personal home maps, a shared central map, and personal caves. This creates territorial multiplayer gameplay where players have safe home bases but must venture into contested shared space for resources.

## Map Topology

### Home Map (`home_{playerId}`)
- **Template:** Single `home.json` file (50x50 tiles), instanced per player
- **Contents:** ~15-20 trees, a few rock spawns, no ore nodes
- **Portals:** Cave entrance (west edge), central map exit (east edge), spawn point (center)
- **Tree respawn:** 5-minute timer after chop
- **Purpose:** Safe starting area, NPC base, crafting hub. Not self-sufficient for resources long-term.

### Central Map (`central`)
- **Size:** 150x150 tiles
- **Contents:** Dense trees, ore nodes, geode deposits, future Ki Alchemy altar spawns
- **Player portals:** Line the perimeter — each player has a persistent 2-3 tile portal on the edge
- **Tree respawn:** 10-minute timer
- **Ore respawn:** 15-minute timer
- **Purpose:** Shared PvP/PvE resource competition zone. Main source of ores, geodes, and rare spawns.

### Personal Cave (`cave_{playerId}`)
- **Size:** Smaller than current cave_01 (deferred to cave rework spec — current cave_01 used until then)
- **Access:** From home map via existing minecart/portal system
- **Purpose:** Limited personal mining. Cave rework spec will cover reduced size and 30-min ore regeneration.

## Portal & Connectivity System

### Home → Central Portal
- On first login (account creation), the server assigns a random perimeter tile on the central map.
- **Minimum distance:** 15 tiles between any two player portals.
- **Assignment algorithm:** Pick random perimeter tile, check distance to all existing assignments, retry if too close (max 50 retries, then pick the position maximizing minimum distance).
- Position saved to player DB record as `central_portal_col`, `central_portal_row`. Never changes.
- Home map template has a fixed portal on the east edge linking to the player's assigned central coordinates.
- Central map has a visible portal sprite at each player's assigned position, linking back to that player's home.

### Home → Cave Portal
- Fixed position on home map west edge.
- Links to `cave_{playerId}` instance.
- Works identically to current level_01 → cave_01 system.

### Visiting Other Homes
- Walk into any player's portal on the central map perimeter → load their home instance.
- Server sets `player["map"] = "home_{targetPlayerId}"`.
- Client loads `home.json` template (cached) and receives instance-specific state (trees, buildings, items, NPCs).
- Visitor can interact with everything — fight NPCs, steal items, destroy buildings.
- Defense is handled by existing NPC commands (defend_player, attack_enemy, hold_position). No lock/door mechanic.

### Portal Data Model
- `player_manager.py` `add_player()` gains fields: `central_portal_col: int`, `central_portal_row: int`.
- `world_data.py` gains `get_player_portals() -> list[dict]` returning all registered portal positions for the central map.
- Portal positions stored in player state JSON, loaded at server start.

## Instance State Management

### State Scoping
Currently world state (trees, buildings, ground items, dummies) is stored globally in `game_state.py`. For instanced maps, state is scoped by map key.

- **Trees:** `game_state.trees` keyed by map — `trees["home_test1"]`, `trees["central"]`.
- **Buildings, anvils, crates, campfires, dummies:** Same pattern — dict keyed by map name.
- **Ground items:** Already have a `map` field per item. No structural change.
- **World objects (ore nodes, etc.):** Keyed by map name.

The server already filters by map in `ws.py` (lines 246-301), so this extends naturally.

### Loading & Unloading
- **Central map:** Always loaded. State persists in memory and DB.
- **Home maps:** Loaded into memory when any player is present (owner or visitor). Saved to DB and unloaded after 60 seconds with no players present.
- **Personal caves:** Same lazy load/unload as home maps.

### DB Schema
New table `instance_state`:
```sql
CREATE TABLE instance_state (
    map_key TEXT PRIMARY KEY,
    state_json TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```
- `state_json` contains serialized trees, buildings, ground items for that instance.
- Load: Deserialize on first player entry.
- Save: Serialize and upsert. Runs on the existing 30-second auto-save cycle.
- Central map always has an entry. Home maps created on first player login.

### NPC Behavior on Logout
- When a player disconnects, any of their NPCs stationed on the central map teleport back to their home map.
- Server iterates `player["npcs"]`, checks each NPC's `map` field. If on `central`, set `map = "home_{playerId}"` and position to home spawn.
- Existing `ws.py` disconnect handler (lines 507-511) extended with this NPC recall step.

### Resource Respawn (Central Map)
- Trees: Respawn at original template positions on a 10-minute timer after being chopped.
- Ore nodes: Respawn on a 15-minute timer after depletion.
- Tracked via `respawn_at` timestamp per resource. The world objects system already uses this pattern for rocks in `world_data.py`.

## Home Map Template

### `home.json` — 50x50 tile template
- Grass/dirt terrain
- ~15-20 trees scattered throughout
- A few rock spawn tiles
- Cave entrance portal on west edge
- Central map exit portal on east edge
- Spawn point at center
- No ore nodes (forces cave or central map for ore)

### First Login Instance Initialization
1. Server creates `home_{playerId}` entry in `instance_state` table
2. Copies tree positions and rock spawns from `home.json` template
3. Assigns central map portal position (random perimeter, 15-tile min distance)
4. Player spawns at center spawn point

### What Persists Per-Instance
- Tree state (alive/chopped, respawn timers)
- All player-built structures (anvils, crates, furnaces, dummies, ki targets)
- Ground items
- NPC positions and task assignments

### What Does NOT Vary (for now)
- Terrain layout, tile art, collision tiles — all homes use same template
- Portal positions — fixed in template
- Designed so procedural terrain variation can be added later without changing the instance state layer

## Migration Path

- Current `level_01` continues working during development.
- New system developed alongside, activated via a feature flag or config toggle.
- When ready to swap: existing players get a home instance seeded from their current buildings/NPCs on level_01, and are assigned a central map portal position.
- `rivalmap` absorbed into central map or kept as a separate arena zone.

## Deferred to Separate Specs

- **Cave rework:** Shrinking cave grid, 30-min ore regeneration cooldown.
- **Ki Alchemy system:** Crystal-powered ability unlocking/modification, random spawning altar on central map.
- **Central map content design:** Tile art, landmarks, resource zone layout, ore distribution.
- **Procedural home variation:** Randomized tree/rock/terrain per home.
- **Scaling beyond ~30 players:** Larger central map, sharding.

## Key Files Affected

| Area | File | Change |
|------|------|--------|
| State scoping | `auxserver/services/game_state.py` | Key all entity dicts by map name |
| Instance load/save | `auxserver/services/database.py` | New `instance_state` table, load/save/unload helpers |
| Portal assignment | `auxserver/services/player_manager.py` | Portal position fields, assignment algorithm |
| Portal registry | `auxserver/services/world_data.py` | `get_player_portals()`, per-instance portal loading |
| Portal detection | `auxserver/services/portals.py` | Support dynamic player portals on central map |
| State broadcast | `auxserver/api/ws.py` | Instance-aware state filtering |
| NPC recall | `auxserver/api/ws.py` | Disconnect hook for NPC teleport |
| Client maps | `src/systems/MapManager.js` | Load home template, instance-aware map changes |
| Map files | `auxserver/maps/` | New `home.json`, `central.json`, corresponding collision/items files |
