# IMPL 2: Desire-Driven Autonomy (Moderate Restructure)

> **Philosophy**: Replace the "LLM picks from 16 intents every N seconds" model with a **continuous desire system** where NPCs have internal drives that build up over time and compete for control. The LLM becomes a *narrator* and *tiebreaker*, not the sole decision-maker. NPCs feel alive because they *want things* independent of being told.

## The Core Problem This Solves

NPCs currently have no *wants*. They wait for an LLM call, the LLM picks an intent from a fixed list, and the NPC executes it until the next LLM call. Between calls, they're zombies. The LLM is doing the heavy lifting of "deciding what to do" but it has no persistent state about what the NPC *cares about* — it just sees a snapshot and picks an action. This is why they feel fake: **they have no inner life**.

## The Desire System

### Core Concept: Competing Drives

Every NPC maintains a set of **drives** — numeric values (0.0 to 1.0) that increase over time and decrease when satisfied. The highest drive wins and determines behavior. No LLM call needed for routine actions.

```javascript
const DRIVES = {
  hunger_for_action:  0.0,  // increases when idle, satisfied by combat/training
  loyalty:            0.0,  // increases with distance from player, satisfied by proximity
  curiosity:          0.0,  // increases over time, satisfied by exploring new areas
  greed:              0.0,  // increases when seeing uncollected resources, satisfied by gathering
  social:             0.0,  // increases over time, satisfied by talking to NPCs/players
  self_preservation:  0.0,  // spikes when HP is low or threats nearby
  ambition:           0.0,  // increases with XP/level, pushes toward training/crystal use
};
```

### Personality Sets the Drive Growth Rates

Instead of personality being prompt-only, it directly controls which drives grow faster:

```javascript
const DRIVE_RATES = {
  Guardian: {
    hunger_for_action: 0.01, loyalty: 0.08, curiosity: 0.01,
    greed: 0.02, social: 0.02, self_preservation: 0.06, ambition: 0.02,
  },
  Berserker: {
    hunger_for_action: 0.09, loyalty: 0.01, curiosity: 0.02,
    greed: 0.03, social: 0.01, self_preservation: 0.01, ambition: 0.06,
  },
  Scout: {
    hunger_for_action: 0.03, loyalty: 0.02, curiosity: 0.09,
    greed: 0.04, social: 0.03, self_preservation: 0.04, ambition: 0.03,
  },
  Caretaker: {
    hunger_for_action: 0.01, loyalty: 0.07, curiosity: 0.02,
    greed: 0.01, social: 0.08, self_preservation: 0.03, ambition: 0.01,
  },
  Paranoid: {
    hunger_for_action: 0.02, loyalty: 0.04, curiosity: 0.01,
    greed: 0.02, social: 0.01, self_preservation: 0.09, ambition: 0.02,
  },
  Pragmatist: {
    hunger_for_action: 0.03, loyalty: 0.03, curiosity: 0.03,
    greed: 0.06, social: 0.03, self_preservation: 0.04, ambition: 0.05,
  },
};
```

### Emotion Modifies Drive Rates

Emotions act as **multipliers** on drive growth:

```
fear     → self_preservation rate * 3.0, curiosity rate * 0.2
anger    → hunger_for_action rate * 2.5, social rate * 0.3
trust    → loyalty rate * 0.5 (less needy when trusting), curiosity rate * 1.5
```

### Drive → Action Mapping (No LLM Required)

Each drive maps to a **behavior subroutine** that activates when that drive is dominant:

```
hunger_for_action  → attack_nearest_enemy OR train (if no enemies nearby)
loyalty            → follow player, stay close
curiosity          → walk to unexplored area, observe entities
greed              → gather nearest resource (logs > stones > crystals based on scarcity)
social             → walk to nearest NPC, initiate socialize
self_preservation  → retreat toward player if threat, hold_position if safe
ambition           → train OR refine_stone OR consume_crystal (whichever advances stats most)
```

### When the LLM Actually Fires

The LLM is no longer called on a timer. It fires only in **interesting moments**:

1. **Drive conflict** — Two drives are within 0.05 of each other and both > 0.5. The NPC is genuinely torn. The LLM resolves the tie with personality context, and the NPC *speaks its reasoning aloud*.

   > "I want to go explore that ridge... but I shouldn't leave the boss alone." (curiosity vs loyalty tie)

2. **Social interaction** — When the NPC talks to a player or another NPC, the LLM generates dialogue. This is where personality shines — in what they *say*, not what they *do*.

3. **Novel stimulus** — Something unprecedented happens (first time seeing a new player, first knockout, first time player builds something). The LLM generates a reaction and optionally shifts drive rates permanently.

4. **Player command override** — Player tells NPC to do something that conflicts with their dominant drive. The LLM decides whether to comply (with personality-flavored pushback) or resist.

   > Berserker told to gather wood when hunger_for_action is high: "You want me to chop TREES? There's enemies right there!"

### What "Resist" Looks Like

NPCs can now **partially comply** or **refuse** based on personality + drive state:

```javascript
// When player issues a command:
const dominantDrive = getHighestDrive(npc);
const commandDrive = TASK_TO_DRIVE[command]; // e.g., 'gather' → 'greed'

if (dominantDrive.value - npc.drives[commandDrive] > 0.4) {
  // NPC's dominant desire strongly opposes this command
  // Personality determines response:
  if (personality === 'Guardian') comply(reluctantly);     // "If you say so..."
  if (personality === 'Berserker') refuse(50% chance);      // "No. I'm fighting."
  if (personality === 'Scout') comply(then wander off after); // does it but gets distracted
  if (personality === 'Caretaker') comply(happily);          // always helpful
  if (personality === 'Paranoid') comply(suspicious);        // "Fine, but I don't like this..."
  if (personality === 'Pragmatist') comply(if logical);      // evaluates ROI
}
```

### Observable Behavior Differences

With this system, players will see things like:

- **A Berserker NPC** that keeps wandering toward enemies even when told to gather. It gathers for a bit, then drifts toward combat. You have to keep redirecting it, or just let it fight.
- **A Scout NPC** that wanders off to explore corners of the map you haven't been to. It comes back with observations ("Saw two players fighting near the rocks").
- **A Caretaker NPC** that follows you closely and keeps trying to talk to your other NPCs. It socializes on its own without being told.
- **A Paranoid NPC** that refuses to go far from you. If you send it to gather, it gathers from the nearest tree only and comes right back. High self_preservation means it retreats at the first sign of danger.
- **A Pragmatist NPC** that autonomously optimizes: gathers when resources are low, trains when there's a dummy nearby, refines when it has stones. Efficient, boring, reliable.

### Drive Visualization

Add a small **drive indicator** visible when NPC is selected — a tiny bar chart or colored dots showing which drive is dominant. Players learn to read their NPCs' "mood" at a glance:

```
[Selected: Kira (Berserker)]
  Action ████████░░  ← dominant, wants to fight
  Loyalty ██░░░░░░░░
  Greed ███░░░░░░░
```

---

## Architecture Changes

### Remove / Replace

| Removed | Replaced With |
|---------|--------------|
| `DECISION_COOLDOWN_MS` timer-based LLM calls | Drive system updates every frame, LLM fires on events only |
| `VALID_INTENTS` 16-item whitelist | Drive→action mapping (same actions but chosen by drive priority, not LLM) |
| Keyword shortcuts in ChatBox.js | Player commands go to compliance check → LLM for personality response |
| `decision_service.py` LLM-every-N-seconds | Server-side drive ticking (lightweight, no LLM) |
| Identical movement/attack constants | Personality modifier table (same as impl1) |

### Keep

| Kept | Why |
|------|-----|
| Soul service / emotion system | Emotions now *multiply* drive rates instead of being cosmetic |
| Memory system | Memories can permanently shift drive baselines ("I remember player abandoned me" → loyalty baseline drops) |
| TaskRunner task execution | The *what* NPCs do stays the same; the *why* changes from "LLM said so" to "internal drive" |
| LLM dialogue generation | Dialogue is where personality still shines — but now NPCs have *reasons* to speak |

### New Files

| File | Purpose |
|------|---------|
| `src/systems/DriveSystem.js` | Tick drives, resolve dominant drive, handle conflicts, map drives to tasks |
| `src/ui/DriveIndicator.js` | Optional visual showing NPC's current drive state |

### Modified Files

| File | Change |
|------|--------|
| `src/systems/NPCBrain.js` | Replace timer-based LLM with drive system + event-triggered LLM |
| `src/systems/NPCTaskRunner.js` | Add personality speed/cooldown modifiers |
| `src/entities/NPC.js` | Add `drives` state alongside `emotionalState` |
| `src/ui/ChatBox.js` | Remove keyword shortcuts, add compliance check flow |
| `auxserver/services/decision_service.py` | Simplify: only called for tie-breaks and social interactions |
| `auxserver/services/soul_service.py` | Memories can shift drive baselines |

---

## Risk Level: Medium

- The drive system is deterministic and cheap (no LLM cost for routine behavior)
- LLM calls drop dramatically (only on events, not timers) — better for Ollama performance
- NPCs may occasionally do things the player doesn't want (Berserker refusing to gather) — this is a *feature* but could frustrate some players
- Needs tuning: drive growth rates, satisfaction decay, emotion multipliers
- Fallback is clean: if drives break, fall back to personality-specific default (same as impl1)

## Expected Feel

NPCs feel like they have **inner lives**. They don't just wait for orders — they have desires that build up and occasionally override what you tell them. You learn your NPC's personality through *watching what it does on its own*, not by reading a label. A Berserker that keeps drifting toward fights feels genuinely aggressive. A Scout that wanders off and comes back with intel feels genuinely curious. The LLM fires less often but at *meaningful moments* — when the NPC is torn, or when it pushes back on a command — making those moments feel significant rather than routine.
