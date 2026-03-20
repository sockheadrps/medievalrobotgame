# Spec 05: NPC System Consolidation

## Goal
Clarify the responsibilities of `NPC.js`, `NPCBrain.js`, `NPCTaskRunner.js`, and `ChatBox.js` so each has a single clear purpose and no logic leaks between them.

## Current State Audit

**Existing files:**
- `NPC.js` — entity class, but also contains personality/emotion/memory/relationship logic
- `NPCBrain.js` — decision-making, but may contain some execution logic
- `NPCTaskRunner.js` — **2,433 lines** — task execution mixed with decision logic; this file is oversized and will need its own split in addition to the decision/execution cleanup
- `ChatBox.js` — UI display, but also handles NPC command routing and vocabulary learning
- `DriveSystem.js` — contains hardcoded per-personality-type data tables (`DRIVE_GROWTH_RATES`, `EMOTION_DRIVE_MULTS`, `COMMIT_DURATION`) that are a third location of personality metadata alongside `NPC.js` and `LLMClient.js`

No `NPCPersonality.js` exists yet. The brain→runner pipeline is not formally documented.

## Gaps to Fill

- [ ] Create `src/systems/NPCPersonality.js` — personality type metadata, emotion state, memory, relationship tracking, vocabulary/phrase learning. `NPC.js` holds a reference to its `NPCPersonality` instance but contains none of this logic. **Include the per-type drive tables from `DriveSystem.js`** (`DRIVE_GROWTH_RATES`, `EMOTION_DRIVE_MULTS`, `COMMIT_DURATION`) — remove them from `DriveSystem.js` and have it import from `NPCPersonality.js` instead.
- [ ] Audit `NPC.js` — move all personality/emotion/memory/relationship logic to `NPCPersonality.js`. `NPC.js` should only contain: sprite, stats, equipment overlays, animations.
- [ ] Audit `NPCBrain.js` — remove any task execution logic. Brain decides WHAT to do and produces a task descriptor.
- [ ] Audit `NPCTaskRunner.js` (2,433 lines) — first, remove decision-making logic; second, **produce a split plan** if the file remains over 600 lines after the logic cleanup. Do not deliver a >600-line file without a documented sub-split plan.
- [ ] Move NPC command routing from `ChatBox.js` to `NPCBrain.js` (it's a decision, not a UI concern)
- [ ] Move vocabulary learning from `ChatBox.js` to `NPCPersonality.js`
- [ ] `ChatBox.js` should only: display messages, capture input, forward raw commands to `NPCBrain`
- [ ] Add a comment block at the top of each file documenting its single responsibility and the brain→runner pipeline

## Acceptance Criteria

- `NPCPersonality.js` exists in `src/systems/` and is the single location for personality type metadata (drive tables, emotion multipliers, commit durations)
- `DriveSystem.js` imports personality data from `NPCPersonality.js` rather than defining it inline
- `NPC.js` contains no personality, emotion, memory, or relationship logic
- `NPCBrain.js` contains no task execution logic
- `NPCTaskRunner.js` contains no decision-making logic and is either under 600 lines or has a documented sub-split plan
- `ChatBox.js` contains no NPC command routing or vocabulary learning
- NPC dialogue, personality expression, and task execution all work correctly after the split
- The brain→runner pipeline is documented in both files

## Risks & Notes

- **Depends on spec 04**: `NPCPersonality.js` data may need to be accessed via `EntityManager` — complete spec 04 first.
- **Shared personality data**: `LLMClient.js` also contains personality type metadata (noted in spec 07). Coordinate with spec 07 to avoid duplicating the data into `NPCPersonality.js` and `LLMClient.js` separately.
- **State during refactor**: NPCs in the world hold live emotion/memory state. Ensure the move to `NPCPersonality.js` doesn't lose in-flight state.
