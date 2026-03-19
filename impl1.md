# IMPL 1: Personality-Driven Behavioral Modifiers (Conservative)

> **Philosophy**: Keep the existing architecture but make personality and emotion *mechanically binding* instead of cosmetic. NPCs should feel different to play with because they **behave** differently, not just **talk** differently.

## The Core Problem This Solves

Right now personality is injected into LLM prompts but never touches the TaskRunner, movement speed, attack timing, decision cooldowns, or stimulus thresholds. A Berserker and a Caretaker are mechanically identical robots that just have different chat vibes.

## Changes

### 1. Personality Modulates Movement & Combat Timing

Instead of every NPC using the same constants:

```
Current (identical for all):
  _baseSpeed = 100
  ATTACK_COOLDOWN_MS = 1000
  KI_BLAST_COOLDOWN_MS = 1200
  FOLLOW_LEASH = TILE_SIZE * 1.2
```

Each personality type gets a **modifier table** applied at NPC creation:

```javascript
const PERSONALITY_MODIFIERS = {
  Guardian:   { speed: 0.9,  meleeCd: 1.1,  kiCd: 1.2,  followDist: 0.8,  decisionSpeed: 1.0 },
  Scout:      { speed: 1.2,  meleeCd: 1.0,  kiCd: 0.9,  followDist: 1.5,  decisionSpeed: 0.8 },
  Berserker:  { speed: 1.1,  meleeCd: 0.7,  kiCd: 0.8,  followDist: 2.0,  decisionSpeed: 0.6 },
  Caretaker:  { speed: 0.85, meleeCd: 1.3,  kiCd: 1.1,  followDist: 0.6,  decisionSpeed: 1.2 },
  Paranoid:   { speed: 1.0,  meleeCd: 0.9,  kiCd: 1.0,  followDist: 0.5,  decisionSpeed: 0.5 },
  Pragmatist: { speed: 1.0,  meleeCd: 1.0,  kiCd: 1.0,  followDist: 1.0,  decisionSpeed: 1.0 },
};
```

**What this changes in practice:**
- Berserker attacks 30% faster, wanders further from player, re-decides faster (impulsive)
- Caretaker stays close, attacks slowly, takes more time to think (deliberate)
- Scout moves fast, hangs back further, makes quick decisions (independent)
- Paranoid sticks extremely close, re-decides very fast (hypervigilant)

### 2. Emotion Modulates Behavior at Runtime

Currently emotions are narrative-only. With this change, emotions **multiply** the personality modifiers in real-time:

```javascript
// In NPCTaskRunner, before each action:
getEffectiveSpeed() {
  const base = this._npc._baseSpeed * this._personalityMod.speed;
  const fear = this._npc.emotionalState?.fear ?? 0;
  const anger = this._npc.emotionalState?.anger ?? 0;
  // Afraid NPCs move faster (fleeing instinct), angry NPCs move slightly faster (charging)
  return base * (1 + fear * 0.3 + anger * 0.15);
}

getEffectiveMeleeCooldown() {
  const base = ATTACK_COOLDOWN_MS * this._personalityMod.meleeCd;
  const anger = this._npc.emotionalState?.anger ?? 0;
  // Angry NPCs attack faster (reckless swings)
  return base * (1 - anger * 0.25);
}
```

**What this changes in practice:**
- A scared NPC visibly moves faster, jitters near the player
- An angry NPC attacks more rapidly, closes distance aggressively
- A trusting NPC wanders further (relaxed), a distrustful one sticks close
- Players can *see* the emotional state through movement, not just through speech bubbles

### 3. Personality-Specific Fallback Behaviors

Currently all NPCs default to `follow` when LLM fails or confidence is low. Replace with personality-driven fallbacks:

```javascript
const FALLBACK_BEHAVIOR = {
  Guardian:   'defend_player',    // stays close and fights threats
  Scout:      'observe',          // stops and watches surroundings
  Berserker:  'attack_nearest_enemy', // picks a fight
  Caretaker:  'follow',           // stays with player (current default)
  Paranoid:   'retreat',          // runs back to player
  Pragmatist: 'gather_wood',     // does something productive
};
```

**What this changes in practice:**
- When Ollama goes down or LLM returns garbage, NPCs don't all go limp. They do what their personality would do.
- A Berserker without orders starts fighting. A Scout wanders and watches. A Pragmatist gathers wood.

### 4. Emotion-Triggered Autonomous Actions (No LLM Required)

Add hard-coded behavioral triggers in NPCBrain that fire based on emotional thresholds, *without* waiting for an LLM call:

```javascript
// Check every frame in NPCBrain.update():
if (npc.emotionalState.fear > 0.7 && !this._isRetreating) {
  // Override current task: flee toward player
  this._taskRunner.clearTasks();
  this._taskRunner.pushTask({ task: 'follow' }); // retreat to player
  this._isRetreating = true;
  npc.showBubble(FEAR_LINES[personality.type], 2000);
}

if (npc.emotionalState.anger > 0.8 && personality.type === 'Berserker') {
  // Berserker rage: ignore current task, attack nearest
  this._taskRunner.clearTasks();
  this._taskRunner.pushTask({ task: 'attack_nearest_enemy' });
  npc.showBubble('RAAAGH!', 1500);
}
```

**What this changes in practice:**
- NPCs have genuine emotional reactions that happen instantly, not after a 4-15s LLM roundtrip
- High emotion states create visible behavioral shifts the player can read
- Different personality types "break" differently under stress

### 5. Remove Keyword Shortcuts for Player-NPC Chat

Currently ~18 patterns in ChatBox.js bypass the LLM with canned responses. Remove them. Let every player command go through the LLM so the NPC's personality shapes the response.

**Exception**: Keep only "stop" as a hard override (safety valve).

**What this changes:**
- Saying "gather wood" to a Berserker might get pushback ("*grumbles* Fine. But I'd rather fight.")
- Saying "follow me" to a Scout might get sass ("Yeah yeah, I'm coming. Saw something interesting over there though...")
- The NPC feels like it has opinions about the tasks you give it

### 6. Vary Speech Bubble Duration by Personality

Small but impactful:

```javascript
const SPEECH_DURATION_MOD = {
  Guardian:   1.0,  // normal
  Scout:      0.6,  // brief, clipped
  Berserker:  0.5,  // grunts
  Caretaker:  1.4,  // verbose
  Paranoid:   0.8,  // hurried
  Pragmatist: 0.7,  // efficient
};
```

---

## Files Changed

| File | Change |
|------|--------|
| `src/systems/NPCTaskRunner.js` | Speed/cooldown/distance now read from personality modifier table * emotion multipliers |
| `src/systems/NPCBrain.js` | Personality-specific fallbacks, emotion-triggered autonomous actions, personality-modulated decision cooldowns |
| `src/ui/ChatBox.js` | Remove 17 of 18 keyword shortcuts (keep "stop" only) |
| `src/net/LLMClient.js` | No changes (personality data already flows to prompts) |
| `src/entities/NPC.js` | Store personality modifier table on construction |
| `auxserver/services/decision_service.py` | No changes |

## Risk Level: Low

- No architectural changes
- Same LLM pipeline, same task system, same state sync
- Purely additive modifiers on top of existing constants
- Easy to tune: just adjust the modifier tables
- If something breaks, remove modifiers and you're back to current behavior

## Expected Feel

NPCs of different types will **move differently**, **fight differently**, **react to danger differently**, and **speak differently when given commands**. The player will start to have *preferences* about which personality type they want for which role (Berserker for combat, Pragmatist for gathering, etc.) instead of all NPCs being interchangeable.
