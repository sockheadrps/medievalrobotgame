# NPCBrain Sub-Split Plan

**Goal:** Split `src/systems/NPCBrain.js` (~1267 lines) into focused files by responsibility.

**When to execute:** After Plan 05 is complete. Can be combined with 05a (NPCTaskRunner split).

## Proposed Split

Based on the current file structure:

- `src/systems/npc/PlayerCommandHandler.js` — `handlePlayerCommand`, `_dispatchPlayerCommands`, target resolution helpers (~230 lines)
- `src/systems/npc/NPCBrainData.js` — constants: `LOCAL_PATTERNS`, `PERSONALITY_TASK_REPLIES`, `FALLBACK_LINES`, `INTENT_TO_TASK` (~80 lines)
- `src/systems/NPCBrain.js` (reduced) — decision loop, world state, LLM request/response (~700-800 lines → needs further split or optimization)

## File Map

**Create:**
- `src/systems/npc/PlayerCommandHandler.js`
- `src/systems/npc/NPCBrainData.js`

**Modify:**
- `src/systems/NPCBrain.js` — reduce to core decision/LLM logic

## Tasks

### Task 1: Extract PlayerCommandHandler
- Move `handlePlayerCommand`, `_dispatchPlayerCommands`, `_resolveAttackTarget`, `_resolveSocializeTarget` to `PlayerCommandHandler.js`
- NPCBrain wires it as `this._commandHandler = new PlayerCommandHandler(this)`

### Task 2: Extract NPCBrainData constants
- Move `LOCAL_PATTERNS`, `PERSONALITY_TASK_REPLIES`, `FALLBACK_LINES`, `INTENT_TO_TASK` to `NPCBrainData.js`
- Both Brain and Handler import from it

### Task 3: Verify gate
- `wc -l` each file, all must be under 600
