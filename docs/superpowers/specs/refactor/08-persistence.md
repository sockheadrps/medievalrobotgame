# Spec 08: Data & Persistence

## Goal
Audit and tighten the database layer: remove unused tables, ensure save/load symmetry for all entity types, and add a startup manifest cache to `asset_registry.py`.

## Current State Audit

- `database.py` exists and manages SQLite persistence
- `asset_registry.py` scans `assets/` at startup — no caching, re-scans on every request
- Equipment frame remap building is in `asset_registry.py` — unknown whether it logs warnings for missing sprite files
- No known indexes on frequently-queried columns

## Gaps to Fill

- [ ] Audit `database.py` tables — identify and remove unused tables
- [ ] Ensure all entity types saved to DB have matching load functions (symmetric save/load)
- [ ] Add indexes on frequently-queried columns: player name, NPC map position
- [ ] Add a manifest cache to `asset_registry.py` so it doesn't re-scan `assets/` on every request
- [ ] Ensure `asset_registry.py` handles missing/malformed asset files gracefully (logs warning, skips file, does not crash)
- [ ] Add warning logs in equipment frame remap building for missing sprite files

## Acceptance Criteria

- No unused tables remain in the database schema
- Every entity type with a save function has a corresponding load function
- Indexes exist on player name and NPC map position columns
- `asset_registry.py` scans once at startup and serves from cache on subsequent requests
- A missing or malformed asset file logs a warning and does not prevent startup

## Risks & Notes

- **Independent of other specs** — can be done at any point after spec 01 is underway.
- **Schema migrations**: removing unused tables requires a migration. Use SQLite `DROP TABLE IF EXISTS` with a schema version check. Back up `game.db` before running.
- **Cache invalidation**: the asset manifest cache only needs invalidation on server restart (assets don't change at runtime). A simple module-level dict populated once in `startup()` is sufficient.
