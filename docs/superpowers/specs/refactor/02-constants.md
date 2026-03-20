# Spec 02: Shared Constants

## Goal
Eliminate duplicated constants between Python and JavaScript by creating a single JSON source of truth served via API, loaded at startup on both sides.

## Current State Audit

Constants like `TILE_SIZE`, `MAP_COLS`, `MAP_ROWS`, movement speeds, attack ranges, and cooldowns are hardcoded independently in `game_state.py` and `src/constants.js`. Any change requires updating both files. `src/constants.js` likely imports or re-declares values also present in the Python tick loop.

No shared constants file exists yet. No `/api/constants` endpoint exists.

## Gaps to Fill

- [ ] Create `auxserver/data/constants.json` with all shared values: `TILE_SIZE`, `MAP_COLS`, `MAP_ROWS`, speeds, attack ranges, cooldowns, frame indices
- [ ] Create `auxserver/core/constants.py` that loads from `constants.json` at import time
- [ ] Replace hardcoded values in `game_state.py` (and new service modules from spec 01) with imports from `constants.py`
- [ ] Add `GET /api/constants` endpoint in `main.py` that serves the JSON directly
- [ ] Update `src/constants.js` to fetch from `/api/constants` on load (or at build time if a build step exists)
- [ ] Replace hardcoded values in client code with the fetched constants

## Acceptance Criteria

- `auxserver/data/constants.json` exists and contains all values currently hardcoded in both Python and JS
- `auxserver/core/constants.py` loads cleanly from the JSON — no fallback hardcoded values
- `GET /api/constants` returns the JSON
- Client loads constants from the API before game init
- No constant value appears hardcoded in both `game_state.py` and `src/constants.js` after this work

## Risks & Notes

- **Load order on client**: constants must be fetched before `GameScene` initializes. Ensure the Phaser boot sequence awaits the fetch.
- **Build vs. runtime**: if there is no JS build step, use a fetch-on-load approach. If there is a build step, a code-gen approach (writing a JS file from the JSON) is cleaner but adds complexity — avoid it unless the build step already exists.
- **Incremental rollout**: constants can be migrated one group at a time (tile size first, then speeds, then frame indices) to reduce blast radius.
