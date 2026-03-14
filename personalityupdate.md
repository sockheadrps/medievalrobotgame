# Design Doc: Lightweight NPC Personality Type Layer

## Overview

This design introduces a **lightweight NPC personality type system** layered on top of an existing numeric trait model. The goal is to improve **LLM prompt consistency, narrative identity, and player readability** while keeping the underlying behavior system unchanged.

The type system acts as **qualitative shorthand** for NPC behavior. Numeric traits remain the source of truth for simulation and emotion math, while types provide **prompting guidance and soft behavioral bias**.

This ensures NPCs feel distinct without requiring a rewrite of existing systems.

---

# Core Principle

**Numeric traits drive behavior.  
Personality types describe tendencies.**

Types are not rigid classes. They represent **biases and narrative identity**, but current emotions, relationships, and context can override them.

---

# Goals

- Improve **LLM dialogue consistency**
- Provide **readable personality labels** for NPCs
- Maintain the **existing numeric personality system**
- Require **minimal engineering changes**
- Add **soft behavioral tendencies**, not rigid rules

---

# Non-Goals

This system intentionally does **not**:

- Replace numeric personality traits
- Introduce complex AI behavior trees
- Add rigid class-based NPC logic
- Override emotional or relationship systems

---

# Existing Personality System

NPC personalities are currently defined using numeric traits:

```json
"personality": {
  "cooperation": 0.82,
  "aggression": 0.28,
  "neuroticism": 0.41
}
```

These traits drive:

- emotional changes
- decision making
- relationship responses
- behavioral reactions

This system remains the **primary behavioral model**.

---

# Personality Type Layer

A new optional field is added:

```json
"soul": {
  "personality": {
    "type": "Guardian",
    "cooperation": 0.82,
    "aggression": 0.28,
    "neuroticism": 0.41
  }
}
```

The type acts as a **high-level behavioral archetype** used mainly for prompting and identity.

---

# Example Types

Recommended system size: **4–6 types**

Example set:

| Type | Core Idea |
|-----|-----|
| Guardian | Protective, loyal defender |
| Scout | Curious explorer |
| Berserker | Aggressive combatant |
| Caretaker | Supportive and empathetic |
| Paranoid | Suspicious and cautious |
| Pragmatist | Balanced and practical |

Types are intentionally broad so they remain flexible.

---

# Type Definition Structure

Each type defines only a small set of properties:

```json
{
  "type": "Guardian",
  "traits": ["loyal", "protective", "cautious"],
  "speech_style": "steady, reassuring, concise",
  "decision_preference": "defend allies and protect the player",
  "base_ranges": {
    "cooperation": [0.65, 0.95],
    "aggression": [0.15, 0.45],
    "neuroticism": [0.25, 0.55]
  }
}
```

These values are used primarily for **prompting and spawn initialization**.

---

# How Types Affect Behavior

Types influence behavior in **three limited ways**.

## 1. Prompt Flavor

The NPC type is injected into prompts to guide LLM responses.

Example:

```
NPC Type: Guardian
Personality traits: loyal, protective, cautious
Speech style: steady, reassuring, concise
```

This gives the model a **qualitative anchor** alongside numeric traits.

---

## 2. Decision Tie-Breakers

Types influence decisions only when multiple actions are similarly valid.

Example guidance:

```
Type preference: Guardian

Guardians tend to prioritize defending allies and protecting the player.
If choices are similar, prefer protective actions.
```

This prevents types from overriding game logic while still shaping behavior.

---

## 3. Spawn Personality Bias

Types provide **default ranges for numeric traits** when NPCs are created.

Example:

Guardian spawn template:

```json
{
  "cooperation": [0.65, 0.95],
  "aggression": [0.15, 0.45],
  "neuroticism": [0.25, 0.55]
}
```

Random values are generated within these ranges at spawn time.

After spawning, numeric traits behave normally.

---

# Prompt Integration

Types primarily affect **two prompts**:

## Dialogue Prompt Example

```
NPC Type: Scout
Personality traits: curious, independent, lightly playful
Speech style: short, observational, upbeat

Use this personality as a qualitative guide alongside numeric personality traits.
```

---

## Decision Prompt Example

```
NPC Type: Berserker

Behavior tendency:
Berserkers favor aggressive action and combat.

If multiple actions are equally reasonable, prefer attacking or confronting threats.
```

---

# Design Principles

### Types Are Tendencies

Personality types **bias behavior** but never fully control it.

Situational factors such as:

- current emotions
- trust levels
- recent memories
- immediate threats

can override type tendencies.

---

### Numeric Traits Remain Primary

All core behavior systems still depend on:

- cooperation
- aggression
- neuroticism
- emotion state
- relationship state

Types only provide **interpretive context**.

---

### Simplicity First

The system intentionally avoids:

- complex tone vectors
- emotion delta tables
- deep subtype hierarchies

These can be added later if needed.

---

# Advantages

## Player Readability

Labels like **Guardian** or **Scout** are easier for players to understand than numeric personality values.

---

## LLM Consistency

Qualitative descriptors help anchor the LLM’s interpretation of personality.

This reduces behavioral drift in dialogue.

---

## Minimal Engineering Cost

Implementation requires only:

- adding a type field
- defining type templates
- injecting type descriptors into prompts

The existing systems remain unchanged.

---

# Example NPC

```json
{
  "name": "Robot-1",
  "type": "Guardian",
  "traits": {
    "cooperation": 0.84,
    "aggression": 0.21,
    "neuroticism": 0.38
  }
}
```

Dialogue prompts then include:

```
NPC Type: Guardian
Personality traits: loyal, protective, cautious
Speech style: steady, reassuring, concise
```

---

# Future Extensions (Optional)

These features can be added later if needed:

- dynamic personality evolution
- hybrid personality types
- experience-driven personality drift
- type modifiers from relationships
- emergent personality shifts

These are intentionally **not part of the initial system**.

---

# Summary

This design introduces a **simple personality type layer** that enhances NPC identity and LLM prompting without replacing existing systems.

Numeric traits continue to drive simulation and emotional behavior, while personality types provide:

- narrative shorthand
- dialogue tone guidance
- soft decision biases
- spawn personality templates

The result is a **more readable, consistent, and expressive NPC system** with minimal implementation complexity.
