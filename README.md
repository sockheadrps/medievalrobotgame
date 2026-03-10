# Iron Anachronism

A multiplayer browser game where NPCs are driven by local LLMs (Ollama) — each with persistent personalities, emotional memory, and emergent social behavior.

---

## NPC LLM System

### Soul (Persistent Identity)

Every NPC has a **soul** — a set of immutable personality traits plus mutable emotional state:

**Personality traits** (set at creation, never change):
- **Cooperation** (0–1): Willingness to help and follow orders
- **Aggression** (0–1): Preference for combat over peaceful options
- **Neuroticism** (0–1): Sensitivity to emotional shifts

These traits bias every LLM decision the NPC makes.

### Relationships (Per-Player)

Each NPC tracks **separate emotional state per player**:

| Emotion | Range | Effect |
|---------|-------|--------|
| Trust | 0–1 | Built through positive interaction, broken by threats |
| Fear | 0–1 | Raised by threats and violence, fades with reassurance |
| Anger | 0–1 | Triggered by hostility, sustained by repeated provocation |
| Cooperation mod | -1 to +1 | Per-player adjustment to base cooperation |
| Aggression mod | -1 to +1 | Per-player adjustment to base aggression |

These combine into a **relationship label**:
- **Hostile**: anger > 0.7 or (trust < 0.2 and fear > 0.5)
- **Wary**: trust < 0.25 or anger > 0.4
- **Neutral**: default
- **Allied**: trust >= 0.5
- **Devoted**: trust >= 0.75 and anger < 0.15

### Emotion Dynamics

**Decay**: Every 2 seconds, emotions drift toward their baseline (trust → 0.5, fear → 0, anger → 0) at 0.02/tick. NPCs calm down naturally.

**Baseline drift**: If an emotion stays above 0.90 for sustained periods, the baseline itself creeps up (+0.01/5s, capped at 0.85). A consistently trusted NPC becomes *permanently* trusting. A repeatedly bullied NPC becomes *permanently* fearful.

**Escalation**: Repeated interactions without a 30-second cooldown multiply emotion deltas (2x → 4x → 8x → 16x cap). Sustained aggression hits hard; backing off resets the multiplier.

### Memory

NPCs store episodic memories in per-player and global buckets:

- Each memory has `text`, `type` (event/command/observation/dialogue/relationship/goal), `timestamp`, and `importance` (starts at 1.0)
- Importance decays at 0.05 per 10 seconds — recent events dominate
- Below 0.1 importance → pruned. Max 30 per bucket
- Top 12 memories (ranked by importance × recency) are sent to the LLM as context

---

## How Players Interact With NPCs

### Chat Commands
Player text goes through a two-step LLM pipeline:
1. **Router** (temp 0): Classifies intent → `gather`, `combat`, `follow`, `idle`, `build`, or `fallback`
2. **Specialist** (temp 0): Parses into executable task JSON

Examples: "chop some trees", "follow me", "attack that dummy", "stay here", "build a fence"

### Dialogue
Non-command messages trigger dialogue generation (temp 0.7). The NPC responds in-character based on personality and current emotional state. Dialogue applies emotion deltas — friendly conversation builds trust, threats spike fear and anger.

### Direct Interaction
- **Ctrl+click**: Select/target an NPC
- Attacking an NPC raises its fear and anger toward you
- Giving items or positive commands builds trust

### Emotion Delta Ranges
All LLM-generated emotion changes are clamped:
- Client-side decisions: ±0.25 max per tick
- Server-side commands: ±0.10 max per tick
- Dialogue: ±0.40 max per response

---

## Autonomous NPC Behavior

### Decision Loop
`NPCBrain` fires an LLM decision call:
- Every **5 seconds** when idle
- Immediately on events: enemy appeared, HP dropped below 35%, player gave command
- Minimum **2-second** cooldown between calls

The LLM receives a full state packet: NPC personality, emotions, memories, nearby entities, trees, recent events, and a list of allowed actions. It returns:

```json
{
  "primary_intent": "defend_player",
  "target_id": "dummy_1",
  "speech": "I've got your back.",
  "emotion_delta": { "trust": 0.02, "fear": -0.01 },
  "memory_candidates": [{ "text": "Spotted threat near player", "type": "observation" }],
  "decision_confidence": 0.85
}
```

Low confidence (< 0.3) or malformed responses fall back to `follow`.

### Available Actions
| Intent | What it does |
|--------|-------------|
| `follow` / `stay_near_player` | Walk to owner, maintain 2-tile distance |
| `gather_wood` | Find nearest tree, walk to it, chop |
| `give_logs` | Walk to player, transfer all logs |
| `build_fence` | Collect ground logs, build fences |
| `defend_player` | Follow + attack threats within 6 tiles |
| `attack_enemy` | Attack nearest hostile entity |
| `attack_player` | Attack a specific player |
| `attack_npc` | Attack another NPC |
| `steal_logs` | Walk to NPC, smack them, take 1–3 logs |
| `socialize_npc` | Walk to NPC, have LLM conversation |
| `train` | Continuously attack training dummies |
| `retreat` | Flee from danger |
| `hold_position` / `do_nothing` | Stay put |

### NPC-to-NPC Interactions

When gathering wood, NPCs check for nearby NPCs every 10 seconds and make a **local** (no LLM) decision:

```
socialize_score = cooperation × 0.6 + trust × 0.3 + (1 - aggression) × 0.1
steal_score = aggression × 0.5 + (1 - cooperation) × 0.3 + anger × 0.4
```

- High cooperation + trust → socialize (LLM generates 2–3 dialogue lines, applies emotional impact to both NPCs)
- High aggression + anger → steal logs (victim records memory, anger toward thief increases)
- Trust > 0.7 reduces steal score by 80% — NPCs don't rob friends
- 30-second cooldown per NPC pair prevents spam

This creates emergent dynamics: cooperative NPCs befriend each other while aggressive ones develop rivalries. Stolen logs and insults compound through baseline drift into permanent grudges.

---

## Architecture

### Local LLM Design
Each player's client talks to their own local Ollama instance (`localhost:11434`). In production, requests proxy through the game server at `/ollama/*`.

- Zero server-side LLM cost
- No shared bottleneck
- Graceful offline fallback: NPCs silently default to `follow` behavior

### Server Authority
All combat damage, log transfers, and NPC state sync are server-authoritative. The server validates:
- HP can only decrease via server combat actions
- Stolen logs are protected from client overwrite for 2 seconds
- NPC positions rejected if inside enemy fences
- NPC state persisted to SQLite every 30 seconds

### Multiplayer Sync
- ~20Hz WebSocket tick broadcasts world state
- NPC soul/relationship data synced so all players see relationship labels
- Each player's NPCs are owned by that player's client (LLM runs locally)

---

## Deployment

```bash
# VPS
git clone <repo> && cd medievalrobotgame
git checkout mplayer
cp .env.example .env
# Start Ollama on host
sudo systemctl start ollama && ollama pull llama3.2:latest
# Build and run
docker compose up -d --build
```

Requires Nginx Proxy Manager on the `nginx-proxy-network` Docker network, with WebSocket support enabled.
