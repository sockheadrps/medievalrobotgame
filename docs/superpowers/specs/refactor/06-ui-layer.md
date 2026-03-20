# Spec 06: UI Layer Cleanup

## Goal
Standardize the lifecycle pattern across all UI panels and fix the two highest-value issues: rename `PlayerDetailPanel` to reflect its actual purpose and decouple `HudController` from the Phaser entity.

## Current State Audit

UI panels to audit (per REFACTOR_PLAN.md):
- `ChatBox.js` — being cleaned up in spec 05
- `HudController.js` — reads directly from the `Player` Phaser entity
- `PlayerDetailPanel.js` — misnamed; is actually the admin/cheat panel. Partially auto-generates crafting buttons from equipment manifest. Give Items rows are hardcoded.
- `NPCDetailPanel.js`, `InspectPanel.js`, `InventoryController.js`, `AdminPanelController.js` — lifecycle compliance unknown; **the implementer must audit these files at the start of this spec** and record which lifecycle methods each does and does not implement before making any changes.

No standardized lifecycle interface (`constructor(scene)`, `show(data)`, `hide()`, `destroy()`) is enforced across panels.

## Gaps to Fill

- [ ] Define the standard panel lifecycle: `constructor(scene)`, `show(data)`, `hide()`, `destroy()`
- [ ] Audit each panel (ChatBox, HudController, NPCDetailPanel, PlayerDetailPanel, InspectPanel, InventoryController, AdminPanelController) for lifecycle compliance
- [ ] Ensure all panels properly clean up DOM elements in `destroy()`
- [ ] Ensure panels don't directly mutate game entities — emit events or call scene methods instead
- [ ] Rename `PlayerDetailPanel.js` to `AdminPanel.js` (update all references)
- [ ] Group Give Items by category in `AdminPanel.js` (resources, crafting materials, equipment)
- [ ] Auto-generate Give Items rows from asset registry instead of hardcoding each item
- [ ] Update `HudController` to read from a plain player state object rather than the `Player` Phaser entity directly

## Acceptance Criteria

- All panels implement `constructor(scene)`, `show(data)`, `hide()`, `destroy()`
- All panels clean up their DOM elements in `destroy()`
- No panel directly mutates a game entity
- `PlayerDetailPanel.js` is renamed to `AdminPanel.js` with all references updated
- Give Items rows in `AdminPanel` are generated from the asset registry, not hardcoded
- `HudController` does not import or directly reference the `Player` class

## Risks & Notes

- **Depends on spec 04**: panels that interact with entity arrays should use `EntityManager` from spec 04.
- **Admin panel auto-generation**: asset registry is available via server API. The panel may need to fetch the registry on `show()` if it doesn't already have it cached.
- **HUD decoupling**: define a minimal `PlayerState` shape (plain object with HP, Ki, stats) that `HudController` reads from. `GameScene` is responsible for keeping this object updated.
