# LLM Command Routing — Architecture Plan

## Problem

The current single monolithic system prompt in `auxserver/main.py` tries to handle every task type simultaneously. As tasks grow more complex (skills, assignments, multi-step workflows), this becomes unmaintainable — the prompt bloats, examples conflict, and the model makes ambiguous choices.

---

## Proposed Architecture: Router → Specialist

### Two-Stage LLM Pipeline

```
Player text
  → LOCAL_PATTERNS (instant, no server, ChatBox.js)
  → Stage 1: Router LLM  (classify intent → category slug)
  → Stage 2: Specialist LLM  (category prompt + NPC context → JSON task array)
  → NPCTaskRunner
```

Local patterns always fire first. LLM only called for unrecognized input.

---

## Stage 1 — Router (Intent Classification)

Small, fast call. Only job: return a single category slug.

**Prompt:** `auxserver/prompts/router.txt`

```
Classify the player's instruction into exactly one category.
Categories: gather, store, smelt, craft, crank, combat, assign, follow, idle
Output only the category name. Nothing else.
```

**Examples:**
- "go get some wood and store it" → `gather`
- "keep the flywheels spinning" → `crank`
- "kill chickens and make arrows" → `combat`
- "fill that furnace" → `assign` ← references a ctrl+clicked object
- "just stand there" → `idle`

**Config:** `temperature=0`, `num_predict=5` (one word output, very fast)

---

## Stage 2 — Specialist Prompts

Each category has its own focused prompt file. Knows deeply about its domain only.

```
auxserver/
  main.py
  prompts/
    router.txt        — classification only
    gather.txt        — Wood, Ore, Stone; carry limits; deposit directives
    store.txt         — deposit to crate/furnace; move-all vs partial
    smelt.txt         — furnace pipeline; iron→bar; fuel management
    craft.txt         — arrow making, arrowhead smithing, fletching combos
    crank.txt         — flywheel momentum thresholds, multi-flywheel loops
    combat.txt        — hunting chickens, feather collection, full arrow loop
    assign.txt        — resolves "that one", "the one I marked", ctrl+clicked refs
    follow.txt        — follow, patrol, idle variants
    fallback.txt      — behaves like current monolithic prompt; graceful degradation
```

Prompt files are plain text — editable without restarting the server. Each request hot-reloads the file.

---

## NPC Context Enrichment

Current `world_context` only sends global counts. Enrich with per-NPC state:

```json
{
  "npc_id": "npc_0",
  "npc_inventory": { "Wood": 3, "Arrow": 0 },
  "npc_skills": { "woodcutting": 4, "combat": 2, "fletching": 1 },
  "assigned": {
    "crate":     { "col": 5, "row": 3 },
    "furnace":   { "col": 8, "row": 4 },
    "flywheels": [{ "col": 12, "row": 6 }],
    "quarry":    null,
    "crusher":   null
  },
  "world": {
    "trees": 8, "chickens": 4, "furnaces": 2, "crates": 1, "flywheels": 2
  }
}
```

All of this is already tracked in the game — `ChatBox._submit()` just needs to pull from `npc.skills`, `npc._inventory`, and `npc.assignedTargets` before sending.

---

## Ctrl+Click Integration — The "assign" Category

When a player ctrl+clicks an object while an NPC is selected, that object is stored in `npc.assignedTargets`. The router detects "assign" intent from phrases like:
- "use that furnace", "fill the one I picked", "go to the storage I marked"

The `assign.txt` specialist resolves the reference by cross-checking the instruction against the NPC's assigned objects:

```
Context: NPC has assigned crate at (5,3), furnace at (8,4)
Player: "keep that furnace stocked with wood"
→ [{"task": "loop", "goals": [{"goal": "fill_furnace_wood", "threshold": 5}, {"goal": "gather", "item": "wood"}]}]
```

Ctrl+clicked assignments become semantic anchors the LLM can reference by name/type.

---

## Server Flow (Python)

```python
@app.post("/parse_command")
async def parse_command(request: ChatRequest):
    # 1. Route
    category = await _route(request.text)           # ~50ms, single word

    # 2. Load specialist prompt (hot-reload from file)
    prompt = load_prompt(category)                  # prompts/{category}.txt

    # 3. Build full context
    context = build_context(request)                # npc state + world + assigned

    # 4. Call specialist
    commands = await _specialist(prompt, context, request.text)

    return {"npc_id": request.npc_id, "commands": commands}
```

---

## Open Questions to Iterate On

| Question | Options |
|----------|---------|
| **One model or two?** | Router = small fast model (1b), Specialist = full model. Or same model both — simpler config. (same model)|
| **Category granularity** | 8–10 categories feels right. Too many → routing errors. Too few → specialists bloat again. (only implement as many as needed for now) |
| **Fallback behavior** | If router returns unknown → `fallback.txt` (current monolithic behavior). No silent failures. |
| **Streaming** | Specialist streams tokens → game shows them in NPC thought bubble in real time. Cosmetic but very readable. |
| **Skill-aware prompts** | Specialist checks `npc_skills` to suggest appropriate tasks. Low woodcutting NPC shouldn't be sent to chop ancient trees. Future extension. (implement later) |
| **Multi-NPC commands** | "Tell everyone to gather wood" — router detects broadcast intent, game fans out to all NPCs. |

---

## What Changes vs. Today

| Component | Now | After |
|-----------|-----|-------|
| `main.py` | One big SYSTEM_PROMPT string | Router fn + specialist loader + context builder |
| Prompt content | 1 file (inline string) | 9–10 `.txt` files, hot-reloadable |
| Context sent to LLM | Global counts only | NPC inventory + skills + assigned objects |
| ChatBox.js | Sends `world_context` with scene counts | Also sends `npc_context` from selected NPC |
| LOCAL_PATTERNS | Still first, unchanged | Still first, unchanged |
