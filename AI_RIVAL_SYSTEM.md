# AI Rival Player System

Documentation of how the server-side AI rival player works. This system is separate from the NPC companion AI (which runs client-side via Ollama). The AI rival is a fully autonomous player controlled by LLM decisions on the server.

---

## Overview

The AI rival is a server-side "fake player" that thinks every 10 seconds, makes strategic decisions via LLM calls, and executes them through the same `game.handle_input()` interface real players use. It has persistent memory, relationships, and a multi-phase strategic plan.

**Entry point:** `auxserver/services/ai_player.py` (~2,385 lines)
**Memory file:** `auxserver/data/ai_rival_memory.json`
**Prompt template:** `auxserver/prompts/ai_player_decision.txt`
**Config:** Enabled via `AI_PLAYER_SPAWN=true` in `.env`

---

## Architecture

### Initialization
- Spawned in `api/ws.py` during server startup if `AI_PLAYER_SPAWN` is set
- Gets a fake player ID (e.g., `"ai_rival"`) and joins the game like any player
- Loads persistent memory from `ai_rival_memory.json` on startup

### Think Loop (10-second cycle)
```
1. Gather world state snapshot (nearby players, NPCs, resources, buildings)
2. Build context from memory (relationships, diary, strategic plan)
3. Construct LLM prompt with all context
4. Send to LLM gateway (server-side, uses configured API)
5. Parse LLM response → decision (goal + reason)
6. Execute decision via game.handle_input() calls
7. Log outcome to event log
8. Periodically write diary entries (LLM-summarized)
```

### Decision Types
The AI can choose from these actions:
- **gather_wood / gather_stone** — Move to resources, chop/mine
- **build_fence / build_gate** — Construct defenses
- **spawn_npc** — Create NPC followers
- **command_npc** — Direct NPCs to attack/defend/gather
- **attack_player** — Engage a player in combat
- **attack_npc** — Target another NPC
- **explore** — Move to unexplored areas
- **craft_equipment** — Build gear at anvils
- **retreat** — Fall back when low HP
- **idle** — Wait and observe

### Fallback Behavior
When LLM fails or times out, a hardcoded fallback decision tree kicks in:
- If HP < 30%: retreat
- If no NPCs: spawn one
- If low resources: gather
- Otherwise: idle/explore

---

## Memory System

### Event Log (Ring Buffer)
- Stores last 30 events with timestamps
- Events: "attacked player X", "gathered 5 logs", "NPC Kaito defeated", etc.
- Fed into LLM prompt for short-term context

### Diary Entries
- LLM-generated summaries of notable periods
- Created every ~5 think cycles
- Provides narrative continuity across sessions
- Persisted to JSON

### Relationships
Per-player tracking:
```json
{
  "player_id": {
    "attitude": "hostile",     // hostile | neutral | friendly
    "threat_score": 45,        // 0-100, based on combat history
    "escalation": 1.5,         // multiplier for repeated interactions
    "last_interaction": 1234,  // timestamp
    "notes": "Attacked me twice near the river"
  }
}
```

**Threat scoring:**
- +10 per attack received
- +20 per knockout
- +5 per NPC killed
- Decays slowly over time
- Escalation multiplier increases with repeated hostile contact

### Strategic Plan
Multi-phase progression:
- **early_game** — Gather resources, build basic defenses
- **mid_game** — Expand territory, recruit NPCs, craft equipment
- **late_game** — Dominate map, engage players, build army

The current phase is determined by resource thresholds and NPC count.

---

## NPC Army Management

The AI rival can spawn and command NPC followers:
- **NPC naming pool:** Kaito, Sora, Riku, Haru, Yuki, etc.
- NPCs are spawned via `game.handle_input({ type: 'spawn_npc' })`
- Commands sent as chat messages routed through the NPC brain
- AI tracks which NPCs are alive, their HP, and assignments

---

## Personality & Emotional Model

### Baseline Emotional Drift
The AI has slowly-drifting emotional baselines:
- **Trust** — How willing to cooperate with players
- **Fear** — How cautious/defensive behavior is
- **Anger** — How aggressive toward threats

These drift based on interactions and influence decision-making.

### Attitude Determination
Combines threat score + emotional baselines:
- High threat + high anger → hostile
- Low threat + high trust → friendly
- Mixed signals → neutral with cautious behavior

---

## Server Integration Points

### Input/Output
- **Input:** Calls `game.handle_input(pid, msg)` — same as real player WebSocket messages
- **Output:** Appears in world state broadcasts like any other player
- **Visibility:** Other players see the AI rival as a normal player sprite

### State in game_state.py
- Stored in `self.players` dict like any player
- Has same stats, inventory, equipment, position
- Subject to same physics, collision, combat rules

### Dashboard
- `main.py` serves an inline HTML dashboard at a route
- Shows AI memory, recent decisions, relationship scores
- Real-time refresh for debugging

---

## File References

| File | Purpose |
|------|---------|
| `auxserver/services/ai_player.py` | Main AI logic, think loop, memory |
| `auxserver/data/ai_rival_memory.json` | Persistent memory state |
| `auxserver/prompts/ai_player_decision.txt` | LLM prompt template |
| `auxserver/services/llm_gateway.py` | HTTP calls to LLM API |
| `auxserver/core/config.py` | LLM endpoint configuration |
| `auxserver/api/ws.py` | AI player initialization on startup |

---

## Notes for Future Rework

- The think loop is synchronous within a 10-second interval — could be made event-driven
- Memory JSON grows unbounded (diary entries) — needs pruning strategy
- Relationship tracking is per-player only — could extend to per-NPC or per-faction
- Strategic plan phases are threshold-based — could use LLM for phase transitions
- The AI uses the same combat system as players but doesn't benefit from client-side prediction
- NPC army management is rudimentary — no formation, patrol, or coordinated tactics yet
