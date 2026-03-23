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
- **Assignment algorithm:** Pick random perimeter tile, check distance to all existing assignments, retry if too close (max 50 retries, then pick the position maximizing minimum distance). The 15-tile minimum is a soft constraint — when the perimeter fills up (~39 players), new portals are placed at the best available position even if closer than 15 tiles.
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
- Portal positions stored in player state JSON, loaded at server start.

### Dynamic Portal Registry
The current portal system uses a static `PORTALS` list loaded once at import time from `*_items.json` files. This cannot represent per-player portals that are created dynamically. Changes:

- `world_data.py` gains a mutable `_player_portals: list[dict]` alongside the static `PORTALS`.
- New function `register_player_portal(player_id, col, row)` appends to `_player_portals` and is called during player creation and server startup (for existing players).
- New function `get_all_portals(map_name) -> list` returns static portals + player portals filtered by `from_map`.
- `portals.py` `check_portal(actor)` changes from iterating the static `PORTALS` to calling `get_all_portals(actor_map)`.
- **Home template portals:** The `home.json` template has a portal labeled `portal:central:DYNAMIC` on the east edge. When the instance loads, this is resolved to the player's assigned `central_portal_col/row` and registered as a live portal. The template file itself stays generic.
- **Central map portals:** Each player's portal on the central perimeter is registered as `{from_map: "central", tile_col, tile_row, to_map: "home_{playerId}", spawn_col, spawn_row}`.

### `/load-map` API Endpoint
The client loads maps via `GET /load-map?name={mapName}`. For instanced maps:
- Requests for `home_{playerId}` serve the `home.json` template file (same terrain for all homes). The server resolves any `home_*` prefix to the `home.json` template.
- Requests for `cave_{playerId}` serve `cave_01.json` (until cave rework).
- The client caches the `home.json` response after first fetch. Subsequent `home_*` requests skip the network call and reuse the cached template. Cache key is `"home"` (not per-player).

## Instance State Management

### State Scoping
Currently world state (trees, buildings, ground items, dummies) is stored globally in `game_state.py`. For instanced maps, state is scoped by map key.

- **Trees:** `game_state.trees` changes from a flat `list` to `dict[str, list]` keyed by map name — `trees["home_test1"]`, `trees["central"]`, etc. Each list entry retains the existing tree dict shape (`{x, y, hp, maxHp, depleted, respawn_at}`).
  - `_init_trees()` loads central map trees from `central.json` template. Home map trees are loaded on-demand from `instance_state` DB when the instance activates.
  - `snapshot()` and per-client broadcast both filter `trees[recipient_map]` to send only the relevant list.
  - Tree tick (regrowth) iterates only loaded/active map keys.
- **Buildings, anvils, crates, campfires, dummies:** Same `dict[str, list]` pattern — keyed by map name.
- **Ground items:** Already have a `map` field per item. Broadcast filtering changes (see below), but data structure stays the same.
- **World objects (ore nodes, etc.):** Keyed by map name.

### Broadcast Layer Changes
The current `ws.py` broadcast loop has an `on_overworld = (recipient_map == "level_01")` guard that silently drops trees, rocks, ground items, animals, and crops for all non-`level_01` maps. This must be replaced:

- **Remove the `on_overworld` guard entirely.** Instead, send trees/rocks/ground-items for whatever map the recipient is on by reading from the per-map dict.
- Trees: `trees.get(recipient_map, [])` instead of conditional on `on_overworld`.
- Ground items: filter `[i for i in ground_items if i["map"] == recipient_map]` (already have map field, just remove the `on_overworld` gate).
- Rocks, animals, crops: same pattern — filter by `recipient_map`.
- The `welcome` snapshot (sent on join) must also be filtered by the player's current map, not sent unfiltered.

This applies to both the 20Hz tick broadcast and the initial welcome snapshot in `websocket_endpoint()`.

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
When a player disconnects, their NPCs on shared maps must be recalled before the player state is removed from memory.

- **Sequencing:** NPC recall happens BEFORE `game.remove_player(pid)` in the disconnect handler. The recall mutates the player's NPC state in-place, then `remove_player` saves and pops.
- **Recall scope:** Any NPC with `map` set to `central` or another player's home (`home_{otherPlayerId}`) gets recalled. NPCs already on `home_{ownPlayerId}` or `cave_{ownPlayerId}` stay put.
- **Recall action:** Set `npc["map"] = "home_{playerId}"`, set position to home spawn point, clear combat state (`punching`, `vx`, `vy`, target refs`).
- **Persistence:** The recalled state is included in the normal player save that `remove_player` triggers, so it survives server restart.

### Instance Loading Concurrency
Instance load/unload runs within the single-threaded async game loop tick. The load sequence:
1. Player enters a map → game tick detects map key not in active instances.
2. Synchronously read `instance_state` row from DB (SQLite is fast for single reads).
3. Deserialize into per-map entity dicts.
4. Mark instance as active.

If two players enter the same home on the same tick, the first load populates the cache; the second sees it already loaded. The 60-second unload timer is checked once per tick and only fires if the player count for that instance is zero.

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
| Client maps | `src/systems/MapManager.js` | Load home template, cache `home` key, `cave_01` check → `startsWith('cave_')` |
| Map API | `auxserver/api/misc.py` | `/load-map` resolves `home_*` → `home.json`, `cave_*` → `cave_01.json` |
| Map files | `auxserver/maps/` | New `home.json`, `central.json`, corresponding collision/items files |
