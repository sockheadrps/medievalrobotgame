# NPC AI Personality — Technical Reference

How chat messages flow through the LLM pipeline, get interpreted, and permanently shape NPC behavior.

---

## Message Flow: Player → NPC

```
Player types message
        │
        ▼
┌─────────────────┐
│  LLMClient._call │  POST to Ollama /api/chat
│  (local model)   │  (production: proxied via /ollama/api/chat)
└────────┬────────┘
         │
    ┌────▼─────┐
    │  Router   │  System prompt: PROMPT_ROUTER
    │  temp: 0  │  Max tokens: 5
    │  output:  │  Single word: gather | combat | follow | idle | build
    └────┬─────┘
         │
    Is it a command (gather/combat/follow/idle/build)?
    ├── YES ──────────────────────────────┐
    │                                     ▼
    │                            ┌─────────────────┐
    │                            │   Specialist     │  PROMPT_SPECIALIST[category]
    │                            │   temp: 0        │  Max tokens: 300
    │                            │   output: JSON   │  e.g. [{"task":"gather","item":"wood"}]
    │                            └────────┬────────┘
    │                                     │
    │                            validateCommands() — filter to VALID_TASKS set
    │                                     │
    │                                     ▼
    │                            NPCTaskRunner executes task deterministically
    │                            (walk to tree, chop, attack, follow, etc.)
    │
    └── NO (fallback/dialogue) ──┐
                                 ▼
                        ┌─────────────────┐
                        │   Dialogue LLM   │
                        │   temp: 0.7      │  Max tokens: 300
                        │   system prompt: │  PROMPT_DIALOGUE + NPC soul context
                        └────────┬────────┘
                                 │
                        extractJSON() from raw response
                                 │
                                 ▼
                        ┌─────────────────────────────────────────┐
                        │ { "dialogue": "Sure thing, boss!",      │
                        │   "emotion_deltas": {                    │
                        │     "trust": +0.02, "fear": 0, "anger": -0.01 │
                        │   },                                     │
                        │   "memory_tag": "Player asked about wood" │  (optional)
                        │ }                                        │
                        └────────┬────────────────────────────────┘
                                 │
                    ┌────────────┼────────────┐
                    ▼            ▼             ▼
              Show bubble   Apply deltas   Store memory
              in game       to NPC soul    (if memory_tag present)
```

---

## Soul Context Sent to LLM

Every LLM call involving personality receives `getSoulContext(playerId)`:

```json
{
  "name": "Rusty",
  "personality": {
    "cooperation": 0.72,    // base + per-player cooperation_mod
    "aggression": 0.15,     // base + per-player aggression_mod
    "neuroticism": 0.39     // immutable
  },
  "emotional_state": {
    "trust": 0.84,
    "fear": 0.05,
    "anger": 0.02
  },
  "relationship": "devoted",
  "memories": [
    "Player promised to build me a workshop",
    "We fought off a training dummy together",
    "Player gave me all their logs"
  ]
}
```

The LLM sees the NPC's effective personality (adjusted per-player), current emotions toward the speaking player, relationship label, and top 12 memories ranked by `importance × recency`.

---

## Emotion Delta Application

When the LLM returns `emotion_deltas`, they pass through:

### 1. Clamping
| Context | Clamp range |
|---------|-------------|
| Dialogue response | ±0.40 |
| Autonomous decision | ±0.25 |
| Server-side command | ±0.10 |
| NPC-to-NPC chat impact | ±0.30 |

### 2. Escalation Multiplier
Repeated interactions without a 30-second pause multiply deltas:

```
1st interaction:  1×
2nd interaction:  2×
3rd interaction:  4×
4th interaction:  8×
5th+ interaction: 16× (cap)
```

30 seconds of silence resets to 1×. This means rapid threats compound exponentially while casual conversation stays mild.

### 3. Storage
```javascript
rel[key] = Phaser.Math.Clamp(rel[key] + (delta × escalation), 0, 1)
```
Applied per-player. An NPC can be `devoted` to one player and `hostile` to another simultaneously.

---

## Memory System

### Storage
```javascript
npc.addMemory(text, type, playerId, importance)
```

- **Buckets**: Per-player (`playerId`) or `global` (visible to all)
- **Types**: `event`, `command`, `observation`, `dialogue`, `relationship`, `goal`
- **Max**: 30 memories per bucket, sorted by importance descending
- **Sources**: LLM `memory_tag` from dialogue, `memory_candidates` from decisions, hardcoded events (theft, combat)

### Decay
Every 60 seconds: `importance -= 0.02`
Below 0.1 importance → pruned.

### Retrieval for LLM
Top 12 memories across player + global buckets, ranked by:
```
weight = importance × recency
recency = max(0.1, 1 - age_seconds / 600)    // fades over 10 minutes
```
Recent high-importance memories dominate. Old memories fade unless they started very important.

---

## Autonomous Decision Loop

Separate from player chat. `NPCBrain` periodically asks the LLM what the NPC should do next.

### Triggers
- **Idle refresh**: Every 5 seconds with nothing to do
- **Events**: Enemy appeared, HP < 35%, new player command
- **Minimum cooldown**: 2 seconds between LLM calls

### State Packet → LLM
```json
{
  "mode": "decision",
  "npc": {
    "personality": { "cooperation": 0.72, "aggression": 0.15, "neuroticism": 0.39 },
    "state": { "hp": 12, "maxHp": 15, "logs": 3, "maxLogs": 10, "status": "gathering" },
    "current_command": { "type": "gather", "age_ms": 8000 },
    "emotion": { "trust": 0.84, "fear": 0.05, "anger": 0.02 },
    "relationship": "devoted",
    "npc_relationships": {
      "npc_2": { "name": "Rival", "trust": 0.3, "anger": 0.6, "label": "wary" }
    }
  },
  "player": { "distance": 3.2, "visible": true, "hp": 22, "maxHp": 30 },
  "nearby_entities": [
    { "type": "training_dummy", "distance": 5.1, "hp": 40 },
    { "type": "player", "distance": 8.5, "hp": 10 }
  ],
  "nearby_trees": 8,
  "recent_events": [ { "text": "Player commanded: gather", "age_ms": 8000, "importance": 0.9 } ],
  "allowed_actions": [ "follow", "gather_wood", "defend_player", "attack_enemy", "steal_logs", "socialize_npc", ... ]
}
```

### LLM Response (temp 0.4, 400 tokens)
```json
{
  "primary_intent": "gather_wood",
  "secondary_intent": "stay_near_player",
  "target_id": null,
  "speech": "Almost full on logs.",
  "emotion_delta": { "trust": 0.01, "fear": 0, "anger": 0 },
  "memory_candidates": [],
  "reason_summary": "Continuing gather command, nearly at capacity.",
  "decision_confidence": 0.9
}
```

Validation: confidence < 0.3 → fallback to `follow`. Malformed JSON → `follow`, no speech. Speech capped at 80 chars. Memory candidates require importance ≥ 0.67.

---

## NPC-to-NPC Chat Pipeline

When two NPCs meet while gathering, the local client runs a multi-step LLM conversation:

```
Step 1: NPC A speaks (temp 0.8, 40 tokens)
        System: PROMPT_NPC_CHAT + personality/relationship context
        User: "Say something to [NPC B] while gathering wood."

Step 2: NPC B responds (temp 0.8, 40 tokens)
        System: PROMPT_NPC_CHAT + B's personality context
        User: "[NPC A] just said: '...'. Respond briefly."

Step 3: (50% chance) NPC A replies once more (temp 0.8, 30 tokens)

Step 4: Evaluate emotional impact (temp 0.3, 200 tokens)
        System: PROMPT_CHAT_IMPACT
        User: Full transcript + both NPCs' personality stats
        Output: { npcA: { trust, anger, memory_tag }, npcB: { trust, anger, memory_tag } }
```

Each NPC stores a memory of the conversation. Emotion deltas (clamped ±0.3) are applied to the NPC-to-NPC relationship, shaping future interactions.

---

## Emotion Decay & Baseline Drift

### Decay (every 2 seconds)
```
trust → decays toward trust_baseline (default 0.50) at 0.02/tick × decay_mult
fear  → decays toward fear_baseline  (default 0.00)
anger → decays toward anger_baseline (default 0.00)

decay_mult:
  owner's emotions:        0.2  (slow — ~4 min full decay)
  other players' emotions: 0.15 (slower — ~11 min full decay)
```

### Baseline Drift (permanent personality change)
If any emotion stays above **0.90** for 5+ seconds:
- Baseline increases by **+0.01** per 5-second tick
- Capped at **0.85** (never fully maxed)
- Per-relationship (one player can permanently shift trust without affecting others)
- Persisted to database across sessions

This means:
- A player who consistently earns trust → NPC naturally settles at high trust even without reinforcement
- Repeated abuse → NPC becomes permanently fearful/angry toward that player
- The NPC develops a "character arc" shaped by its history

---

## Emotion-Driven Autonomous Reactions

Every 2 seconds, NPC scans nearby remote players within 6 tiles:
- **anger > 0.7** toward a player → `attack` on sight
- **fear > 0.5** toward a player → `flee`

These override the current task. An NPC that holds a grudge will attack the offending player whenever they come near, even if commanded to gather.

### Obedience Check
- Owner: always obeyed
- Non-owner: only obeyed if **fear > 0.6** (coercion)

---

## Persistence

NPC state (position, stats, full soul including all relationships and memories) is:
- Serialized via `npc.serialize()`
- Sent to server via `/npc_save`
- Stored in SQLite database
- Restored on login via `npc.loadFrom(data)`

All baselines, memories, and per-player relationships survive server restarts.
