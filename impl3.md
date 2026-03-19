# IMPL 3: Perception-First Architecture (Radical Rewrite)

> **Philosophy**: Throw out the command/intent/task pipeline entirely. NPCs don't receive commands — they **perceive the world** as a stream of proximity events and **react** using a lightweight stimulus-response system with personality-weighted priorities. The LLM is used *only* for speech and social reasoning. All action decisions are emergent from what the NPC can "see."

## The Core Problem This Solves

The current architecture is **command-centric**: something (player or LLM) tells the NPC what to do, then the NPC robotically executes it. This is backwards. Real creatures don't wait for instructions — they **notice things** and **react** based on what kind of creature they are. The "robotic" feel comes from NPCs being puppets that need a puppeteer (LLM or player). Remove the puppeteer. Let them *see*.

## How It Works

### 1. The Perception Bubble

Every NPC has a **perception radius** (personality-dependent, ~4-8 tiles). Every frame, the NPC builds a list of everything it can perceive:

```javascript
// Built every frame from world state — zero LLM cost
const perception = {
  entities: [
    { type: 'tree', dist: 1.2, chopped: false },
    { type: 'tree', dist: 2.8, chopped: true },
    { type: 'rock', dist: 3.1, hits_left: 4 },
    { type: 'player', dist: 5.2, id: 'B1', hp: 15, hostile: false },
    { type: 'remote_npc', dist: 4.0, id: 'B1_npc_0', hp: 8 },
    { type: 'ground_item', dist: 1.5, resource: 'Stone' },
    { type: 'dummy', dist: 6.0, hp: 20 },
    { type: 'anvil', dist: 3.5 },
    { type: 'campfire', dist: 2.0, remaining: 15 },
    { type: 'owner', dist: 2.3, hp: 18, logs: 7 },
  ],
  self: { hp: 12, maxHp: 20, ki: 8, logs: 3, stones: 1, has_ki_blast: true, level: 3 },
  threats: [],  // entities that recently damaged me
  recent_events: [], // last 5 seconds of events (got hit, saw ki blast, etc.)
};
```

### 2. Stimulus-Response Tables (No LLM, No Timer)

Each perceived entity type generates a **pull score** — how much the NPC wants to interact with it. Personality determines the weights:

```javascript
// Each entry: [base_pull, personality_multiplier, emotion_modifier]
// Higher total pull = NPC moves toward and interacts

const STIMULUS_WEIGHTS = {
  Guardian: {
    owner_far:        8.0,   // strong pull toward distant owner
    owner_close:      0.0,   // satisfied when near owner
    threat_nearby:    9.0,   // highest priority: fight threats to owner
    tree_unchoped:    1.0,   // low interest in gathering
    enemy_player:     6.0,   // engage enemies proactively
    friendly_npc:     2.0,   // mild social interest
    ground_resource:  1.5,   // pick up resources opportunistically
    training_dummy:   3.0,   // moderate training interest
  },
  Berserker: {
    owner_far:        1.0,   // doesn't care about proximity
    owner_close:      0.0,
    threat_nearby:    10.0,  // drops everything to fight
    tree_unchoped:    0.5,   // hates gathering
    enemy_player:     9.0,   // actively seeks combat
    friendly_npc:     1.0,   // antisocial
    ground_resource:  0.5,   // ignores loot
    training_dummy:   7.0,   // loves training
  },
  Scout: {
    owner_far:        2.0,   // independent
    owner_close:     -1.0,   // NEGATIVE: actively moves away when too close
    threat_nearby:    5.0,   // cautious engagement
    tree_unchoped:    3.0,   // gathers on the way
    enemy_player:     3.0,   // observes, doesn't engage unless provoked
    friendly_npc:     4.0,   // curious about others
    ground_resource:  5.0,   // scavenges actively
    unexplored_area:  8.0,   // strongest pull: the unknown
    training_dummy:   2.0,   // prefers learning by doing
  },
  // ... Caretaker, Paranoid, Pragmatist
};
```

### 3. The Decision Loop (Every Frame, Zero LLM Cost)

```
1. Build perception list
2. For each perceived entity, calculate pull = base_weight * distance_falloff * emotion_mod
3. Pick highest-pull entity
4. Execute the appropriate micro-action:
   - tree with pull > threshold → walk toward, chop when close
   - enemy with pull > threshold → walk toward, attack when close
   - owner with pull > threshold → walk toward, stop at follow distance
   - ground item with pull > threshold → walk toward, pickup
   - nothing above threshold → wander randomly within perception radius
5. If currently executing a micro-action and a NEW stimulus has higher pull → interrupt and switch
```

**Key difference from current system**: There is no "task queue." There are no "commands." The NPC just gravitates toward whatever has the highest pull score *right now*. It can change direction mid-step if something more interesting appears.

### 4. Emergent Behaviors from Stimulus Weights

The beauty of this system is that complex behaviors **emerge from simple weights** without being programmed:

**Gathering**: NPC perceives unchoped tree → tree has positive pull → NPC walks to tree → chops → perceives ground log → log has positive pull → picks up → perceives more trees → continues. No "gather task" needed.

**Defending**: Guardian perceives owner is far → high pull toward owner → walks toward owner → perceives threat near owner → threat pull is higher → switches to attacking threat → threat dies → owner pull re-dominates → returns to owner. No "defend_player task" needed.

**Exploring**: Scout perceives no high-pull stimuli nearby → wanders → perceives unexplored tile → high pull → moves toward it → perceives entity in new area → reacts to it → wanders further. No "explore task" needed.

**Cowardice**: Paranoid perceives enemy → self_preservation pull competes with combat pull → self_preservation wins → NPC retreats toward owner → if owner is close, stands behind owner. No "retreat task" needed.

**Berserker Rage**: Berserker has anger > 0.5 → threat_nearby pull multiplied by 2.0 → even distant enemies draw the Berserker away from gathering → runs across map to fight. Player can see it happening and either let it go or command it back.

### 5. Player Commands as Pull Overrides

When a player tells an NPC to do something, it doesn't create a task — it **temporarily boosts the pull score** of the relevant stimulus type:

```javascript
// Player says "gather wood"
npc.pullOverrides.tree_unchopped = { bonus: 10.0, decay: 0.02 }; // decays over ~8 minutes

// Player says "follow me"
npc.pullOverrides.owner_far = { bonus: 15.0, decay: 0.01 };

// Player says "attack B1"
npc.pullOverrides['entity_B1'] = { bonus: 12.0, decay: 0.03 };
```

The override **decays over time**. This means:
- You tell a Berserker to gather → it gathers for a while → the override decays → its natural combat pull re-emerges → it starts drifting toward enemies again
- You tell a Scout to follow → it follows for a while → curiosity pull rebuilds → it starts wandering again
- You tell a Guardian to attack → it attacks → the override decays → loyalty pull brings it back to you

**NPCs "forget" orders gradually based on how well the order matches their personality.** A Caretaker told to follow has a slow decay (natural loyalty). A Berserker told to follow has a fast decay (unnatural passivity).

```javascript
const ORDER_DECAY_MODS = {
  Guardian:   { follow: 0.5, gather: 1.0, attack: 0.8, defend: 0.3 },
  Berserker:  { follow: 3.0, gather: 2.5, attack: 0.3, defend: 1.5 },
  Scout:      { follow: 2.0, gather: 0.8, attack: 1.5, defend: 2.0 },
  Caretaker:  { follow: 0.3, gather: 0.7, attack: 2.5, defend: 0.5 },
  Paranoid:   { follow: 0.4, gather: 1.5, attack: 1.0, defend: 0.4 },
  Pragmatist: { follow: 1.0, gather: 0.5, attack: 1.0, defend: 1.0 },
};
```

### 6. Where the LLM Fits

The LLM is no longer the decision-maker. It serves three roles:

**A) Narrator** — When the NPC switches behavior (highest pull changes), the LLM generates a one-line speech bubble explaining *why*, flavored by personality:

```
Berserker switches from gathering to chasing enemy:
→ LLM generates: "Enough with the trees. THAT guy needs a lesson."

Scout switches from following to exploring:
→ LLM generates: "What's over by those rocks? I'll be back."

Paranoid switches from idle to retreating:
→ LLM generates: "Something's wrong. I'm staying close."
```

These narration calls are **fire-and-forget**. The NPC doesn't wait for the response to act — it's already acting. The speech bubble arrives a second later as flavor text.

**B) Social Engine** — When two entities are in conversation range and the social pull is high enough, the LLM generates dialogue. This is the one place where the full personality prompt, memories, emotions, and relationship history matter. Conversations feel rich because the LLM has all the context and isn't wasting tokens on "should I gather or fight?"

**C) Memory Author** — After significant events (first kill, first knockout, seeing something new), the LLM writes a short memory entry that can permanently modify pull weights:

```javascript
// LLM writes: "B1 attacked me unprovoked. I don't trust them."
// System applies: npc.basePullMods['entity_B1'] += { enemy_player: +3.0 }
// Now this NPC always prioritizes fighting B1 over other enemies
```

### 7. What Gets Deleted

| Deleted | Why |
|---------|-----|
| `NPCBrain.js` decision loop | Replaced by stimulus-response (no timer-based LLM) |
| `decision_service.py` | No intent classification needed |
| `command_service.py` routing | No command categories needed |
| `router.txt` prompt | No routing step |
| `VALID_INTENTS` / `VALID_TASKS` whitelists | NPCs don't pick from lists; they react to stimuli |
| Task queue in `NPCTaskRunner.js` | Replaced by single-focus micro-actions |
| 18 keyword shortcuts in `ChatBox.js` | Replaced by pull overrides |
| `ai_player_decision.txt` prompt | AI player uses same stimulus system |

### 8. What Gets Created

| New | Purpose |
|-----|---------|
| `src/systems/PerceptionSystem.js` | Builds perception list from world state every frame |
| `src/systems/StimulusResponseEngine.js` | Calculates pull scores, picks action, handles transitions |
| `src/systems/NarrationQueue.js` | Queues LLM narration calls on behavior switches (fire-and-forget) |

### 9. AI Player Also Uses This

The AI rival player becomes **much simpler**. Instead of a complex plan/phase/strategy system with 10-second LLM calls, the AI player is just another entity with stimulus weights — tuned for a player-like role:

```javascript
const AI_PLAYER_WEIGHTS = {
  tree_unchopped:   4.0,  // gathers
  rock_unmine:      3.0,  // mines
  enemy_player:     7.0,  // fights players
  own_npc_hurt:     8.0,  // protects NPCs
  anvil_nearby:     5.0,  // refines when resources available
  build_threshold:  6.0,  // builds NPC when logs >= 10
};
```

No more `ai_player.py` with its 10-second LLM brain loop. The AI player reacts to the same stimuli as NPCs, just with different weights. It looks and feels like a real player because it's doing the same things a real player would do — reacting to what's around it — not executing a pre-planned strategy.

---

## Risk Level: High

- **Major rewrite** of the NPC decision layer (Brain, TaskRunner, DecisionService)
- Task queue removal means some complex multi-step behaviors (practice_ki: gather → build → step back → blast) need to be re-expressed as stimulus chains or special-cased
- Pull score tuning is critical — bad weights = NPCs that jitter between stimuli or get stuck
- LLM usage drops 80%+ which is great for performance but means less "intelligence" in routine actions
- Players accustomed to direct NPC control may find the pull-override-with-decay model frustrating at first

## Mitigations

- **Hold command**: Player can "lock" an NPC to a pull override with zero decay. NPC complies robotically. This is the "I need you to just do this" escape hatch.
- **Debug overlay**: Show pull scores visually during development so tuning is data-driven
- **Stimulus chains**: For multi-step behaviors like ki training, create composite stimuli (e.g., "ki_target_AND_no_ki_blast" generates a "watch_and_learn" pull)

## Expected Feel

NPCs feel like **animals or companions in an ecology**, not robots executing scripts. They drift toward things that interest them, react instantly to threats, and gradually "forget" your orders in favor of their nature. You learn to work *with* your NPCs' personalities instead of fighting against them. A Berserker is a weapon you point in a direction and hope it stays. A Scout is a treasure finder that brings you resources but won't stay put. A Guardian is a bodyguard that never leaves your side. The game becomes about **managing personalities** rather than issuing commands — which is far more interesting and far more human-feeling.

The AI player also benefits enormously: instead of a clunky 10-second LLM loop that generates robotic strategies, it's a reactive agent that plays the game the same way a human would — by looking at what's around it and doing the most appealing thing. Players will mistake the AI for another human because it *behaves* like one, not because an LLM is trying to *pretend* to be one.
