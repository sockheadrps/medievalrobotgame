# NPC Soul System — LLM-Powered Autonomous Companions

Iron Anachronism features a unique NPC system where each companion has a persistent personality, emotional relationships, and episodic memory — all driven by a local LLM running on each player's machine.

## Architecture Overview

```
Player's Browser                    Game Server (auxserver)
┌─────────────────────┐             ┌──────────────────┐
│  NPCBrain           │             │  WebSocket        │
│  (decision layer)   │──Ollama──►  │  (game state)     │
│                     │  localhost   │                   │
│  ChatBox            │             │  NPC Persistence   │
│  (dialogue layer)   │──Ollama──►  │  (save/load)      │
│                     │             │                   │
│  NPCTaskRunner      │             │  No LLM here!     │
│  (execution layer)  │             │                   │
└─────────────────────┘             └──────────────────┘
```

**Key design choice**: LLM inference runs on each player's local Ollama instance (`localhost:11434`). The game server never touches the LLM — it only handles multiplayer state and NPC persistence. This means:
- Zero server-side LLM cost
- Each player's NPC behaves slightly differently based on their local model
- Works offline (graceful fallback to deterministic follow behavior)

## The Soul

Every NPC has a `soul` object that persists across sessions:

```json
{
  "personality": {
    "cooperation": 0.53,
    "aggression": 0.07,
    "neuroticism": 0.39
  },
  "relationships": {
    "player_2c4fd18a": {
      "trust": 0.87,
      "fear": 0.29,
      "anger": 0.14,
      "cooperation_mod": 0,
      "aggression_mod": 0,
      "label": "devoted"
    }
  },
  "memories": {
    "player_2c4fd18a": [
      { "text": "I am designed to assist and protect my creator.", "type": "memory", "ts": 1772983291685 }
    ],
    "global": [
      { "text": "I was just built by the player!", "type": "event", "ts": 1772983295255 }
    ]
  }
}
```

### Personality (immutable base traits)

Generated randomly at creation. These define the NPC's core character:

| Trait | Range | Effect |
|-------|-------|--------|
| **Cooperation** | 0.0–1.0 | How willing the NPC is to help and follow orders |
| **Aggression** | 0.0–1.0 | How likely to choose combat over peaceful options |
| **Neuroticism** | 0.0–1.0 | How sensitive to emotional shifts (fear, stress) |

### Relationships (per-player emotional state)

Each player gets their own relationship entry. This is the core of the multiplayer NPC system — an NPC can be devoted to one player and wary of another:

| Axis | Range | Description |
|------|-------|-------------|
| **Trust** | 0.0–1.0 | Built through positive interactions, broken by threats |
| **Fear** | 0.0–1.0 | Increases from threats, reduces with reassurance |
| **Anger** | 0.0–1.0 | Triggered by rude/hostile behavior |
| **Cooperation mod** | -1.0–1.0 | Per-player adjustment to base cooperation |
| **Aggression mod** | -1.0–1.0 | Per-player adjustment to base aggression |

These axes combine to derive a **relationship label**:

| Label | Condition |
|-------|-----------|
| `hostile` | anger > 0.7, or trust < 0.2 and fear > 0.5 |
| `wary` | trust < 0.25, or anger > 0.4 |
| `neutral` | default |
| `allied` | trust >= 0.5 |
| `devoted` | trust >= 0.75 and anger < 0.15 |

### Emotion Decay (natural recovery)

Emotions are **not permanent** — they decay toward a per-relationship baseline every 2 seconds:

| Emotion | Starting Baseline | Decay rate | Effect |
|---------|-------------------|------------|--------|
| **Trust** | 0.50 | 0.02/2s | Slowly returns to baseline after positive or negative events |
| **Fear** | 0.00 | 0.02/2s | NPC naturally calms down after scary situations |
| **Anger** | 0.00 | 0.02/2s | Rage fades over time if not provoked again |

This means the NPC reacts strongly to current events (emotion deltas up to ±0.25) but naturally "recovers" if the situation changes. A threatening player who backs off will see the NPC's fear fade. But if they keep threatening, the emotions stay elevated because each LLM decision re-applies fresh deltas faster than decay removes them.

### Baseline Drift (permanent emotional imprinting)

If an emotion stays **above 0.90** for a sustained period, the baseline itself permanently shifts upward:

- Every **5 seconds** above the 0.90 threshold → baseline increases by **+0.01**
- Baselines are **capped at 0.85** — the NPC can never become permanently maxed out
- Baselines are **per-relationship** — an NPC can be permanently trusting of one player and permanently fearful of another
- Baselines **persist across sessions** (saved with the soul)

**Example**: A player who consistently earns trust (keeping it above 0.90) will see the NPC's trust baseline slowly rise from 0.50 → 0.51 → 0.52... After many positive interactions, the baseline might reach 0.70+, meaning the NPC naturally settles at high trust even without active reinforcement. But if another player terrorizes the NPC, its fear baseline toward *that* player rises — the NPC becomes permanently jumpy around them.

The NPC info panel shows current baselines: `Trust: 0.92 (base 0.63)`

### Memories (episodic, per-player + global)

Memories are stored in buckets:
- **Per-player**: Things that happened between this NPC and a specific player
- **Global**: Events that all players would know about

Each memory has:
- `text` — what happened
- `type` — `event`, `command`, `observation`, `dialogue`, `relationship`, `goal`
- `ts` — timestamp for ordering
- `importance` — starts at 1.0, decays by 0.05 every 10 seconds

**Decay system**: Memories lose importance over time (0.05 per 10s). When importance drops below 0.1, the memory is pruned. Max 30 memories per bucket, sorted by importance — high-impact recent events dominate, old routine observations fade away.

When building LLM context, memories are ranked by `importance * recency` (recency fades over 10 minutes), and the top 12 are sent. This means the NPC is heavily focused on what's happening *right now*.

## The Brain (Autonomous Decision Layer)

`NPCBrain` runs every frame and periodically asks the LLM what the NPC should do. It fires on:

- **Idle refresh** — every 5 seconds when the NPC has nothing to do
- **Event triggers** — enemy appeared, player gave command, HP dropped
- **Cooldown** — minimum 2 seconds between LLM calls

### State Packet

The brain builds a curated context packet (not raw world state) and sends it to the LLM:

```json
{
  "mode": "decision",
  "npc": {
    "id": "npc_1",
    "name": "Rusty",
    "personality": { "cooperation": 0.53, "aggression": 0.07, "neuroticism": 0.39 },
    "state": { "hp": 15, "maxHp": 15, "str": 1, "status": "idle" },
    "emotion": { "trust": 0.87, "fear": 0.29, "anger": 0.14 },
    "relationship": "devoted"
  },
  "player": {
    "id": "player_2c4fd18a",
    "distance": 3.2,
    "hp": 22, "maxHp": 30, "logs": 15
  },
  "nearby_entities": [
    { "id": "dummy_1", "type": "training_dummy", "distance": 5.1, "hp": 40 }
  ],
  "nearby_trees": 8,
  "recent_events": [
    { "type": "command", "text": "Player commanded: follow", "age_ms": 2500, "importance": 0.9 }
  ],
  "allowed_actions": [
    "follow", "defend_player", "attack_enemy", "gather_wood", "train", "do_nothing"
  ]
}
```

### LLM Response

The LLM returns a structured decision:

```json
{
  "primary_intent": "defend_player",
  "secondary_intent": "stay_near_player",
  "target_id": "dummy_1",
  "speech": "I've got your back.",
  "emotion_delta": { "trust": 0.02, "fear": -0.01, "anger": 0.0 },
  "memory_candidates": [
    { "text": "Spotted a training dummy near the player.", "type": "observation", "importance": 0.67 }
  ],
  "reason_summary": "Player is trusted ally, staying close for protection.",
  "decision_confidence": 0.85
}
```

### Validation Layer

Every LLM response is validated before use:
- `primary_intent` must be in the allowed enum
- `speech` capped at 80 characters
- `emotion_delta` values clamped to [-0.25, +0.25] per decision
- `memory_candidates` max 2, importance must be >= 0.65 to be stored
- Duplicate memories are filtered out
- `decision_confidence` below 0.3 falls back to `follow`
- Malformed JSON returns a safe fallback (follow player, no speech)

## Dialogue System

When the player chats with an NPC, the flow is:

1. **Local pattern matching** — simple commands like "follow me", "chop wood" are handled instantly without LLM
2. **Command parsing** — two-step LLM pipeline: router classifies intent (gather/combat/follow/idle), then specialist generates task JSON
3. **Dialogue** — if not a command, the LLM generates conversational response with emotion deltas

Dialogue responses include emotion shifts that are displayed in the chat log:

```
You: You're doing great out there
Rusty: Thanks boss, means a lot! [Trust +0.02, Anger -0.01]
```

## Execution Layer (NPCTaskRunner)

The brain decides *what* to do. The TaskRunner handles *how*:

| Intent | Task | Behavior |
|--------|------|----------|
| `follow` | Walk to player, maintain 2 tiles distance |
| `gather_wood` | Find nearest tree, walk to it, chop via server |
| `attack_enemy` | Find nearest dummy, walk in range, attack |
| `train` | Same as attack but never dequeues (continuous) |
| `defend_player` | Follow + attack nearby threats |
| `hold_position` / `do_nothing` | Stop moving |

The TaskRunner handles all deterministic game logic: pathfinding, distance checks, cooldowns, facing. The LLM never controls exact movement or damage.

## Persistence

NPC state (stats, soul, position) auto-saves to the server every 30 seconds:

```
POST /npc_save → auxserver/data/npcs/npc_1.json
GET  /npc_load/npc_1 → restore on reconnect
```

This means an NPC remembers its relationship with each player across sessions.

## Setup

Each player needs [Ollama](https://ollama.ai) running locally:

```bash
# Install Ollama, then:
ollama pull llama3.2:latest

# Start with CORS enabled (PowerShell):
$env:OLLAMA_ORIGINS="*"; ollama serve

# Or on Mac/Linux:
OLLAMA_ORIGINS="*" ollama serve
```

If Ollama isn't running, NPCs fall back to deterministic follow behavior — no crash, no error popup. The chat shows "(LLM offline — start Ollama)" and the brain silently defaults.
