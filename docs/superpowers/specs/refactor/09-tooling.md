# Spec 09: Tooling (Asset Editor, Map Maker, Playground)

## Goal
Light cleanup of the web tools at `http://127.0.0.1:8001/`. These tools work and are rarely modified — no structural changes, just targeted fixes.

## Current State Audit

- `asseteditor.js` — large single-file JS app. Tab-based UI for world objects, equipment, items, crafting stations. Save/load patterns may be inconsistent across asset types. No save feedback.
- `mapmaker.js` — map tile editor. Collision tile editing interacts with the cave_01 mine overlay system. Undo/redo status unknown.
- `playground.js` — testing tool. No changes needed.
- `asseteditor.css` — modified in current branch (noted in git status).

## Gaps to Fill

**Asset Editor:**
- [ ] If `asseteditor.js` exceeds 2,000 lines, split tab logic into separate functions or modules
- [ ] Ensure all asset types (world objects, equipment, items, crafting stations) use consistent save/load patterns
- [ ] Add visible validation feedback when saving (currently silent on success/failure)

**Map Maker:**
- [ ] Verify collision tile editing works correctly with the cave_01 mine overlay system
- [ ] Add undo/redo if not already present

**Playground:**
- No changes needed.

## Acceptance Criteria

- `asseteditor.js` is under 2,000 lines (split if over)
- Saving any asset type shows visible success or error feedback
- All asset types use the same save/load API pattern
- Map maker collision editing works with cave_01 overlays
- Map maker has undo/redo (Ctrl+Z / Ctrl+Y)

## Risks & Notes

- **Low priority** — do this last among structural work. Tools function correctly today.
- **asseteditor.css** has uncommitted changes in the current branch — coordinate with whatever work is pending there before touching the file.
