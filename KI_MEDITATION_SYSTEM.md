# Ki Meditation System

## Goal

Turn refined crystals into a long-term ki progression loop that:

- makes crystal quality meaningful,
- gives players and NPCs visible downtime/vulnerability,
- gates higher-tier ki moves behind progression,
- supports future "mind realm" maps without requiring them immediately,
- preserves the current loop where repeated ki-blast use reduces blast cost over time.

## Current State

- Refining stones at anvils can produce:
  - `bastalite`
  - `crystal_poor`
  - `crystal_normal`
  - `crystal_pristine`
- Players and NPCs already have:
  - `ki`
  - `maxKi`
  - `blastLevel`
- Ki blast usage already:
  - spends ki,
  - increases `blastLevel`,
  - reduces future blast cost,
  - is learned by NPCs via watching their owner use a ki target.

## Core Loop

1. Mine rocks.
2. Refine stone into ki crystals.
3. Use ki abilities in the normal world to gain `kiSkillXp`.
4. Raise `kiSkillLevel`.
5. At `kiSkillLevel >= 10`, unlock `Meditate`.
6. Spend crystals to meditate for a duration based on crystal quality.
7. While meditating:
   - the body stays in the world,
   - the body is immobile and vulnerable,
   - other players/NPCs can see a meditation pose and progress bar,
   - the mind is considered to be in a realm.
8. Realm completion grants:
   - move unlock offers,
   - or insight progress toward a guaranteed unlock at that tier,
   - or mastery progress for known ki moves.
9. Return to the normal world and use the unlocked moves to continue building `kiSkillLevel`.

## First Implementation Slice

This first slice should be implemented now:

- Add `kiSkillLevel` and `kiSkillXp` to players and NPCs.
- Award `kiSkillXp` from ki blast usage.
- Unlock meditation at `kiSkillLevel >= 10`.
- Allow players to start meditation by spending a crystal from inventory UI.
- Allow NPCs to start meditation from a chat command.
- Add server-authoritative meditation state:
  - `meditating`
  - `meditation_started_at`
  - `meditation_until`
  - `meditation_total_ms`
  - `meditation_crystal_quality`
  - `realm_tier`
- Show meditation state on-map:
  - visible progress bar above the entity,
  - frozen movement,
  - meditation pose if available, otherwise a clear visual substitute.
- Do not implement realm maps yet.
- When meditation completes in this first slice:
  - award placeholder `realmInsight`,
  - notify the client in chat/bubble,
  - record realm tier based on `kiSkillLevel`.

## Ki Skill Progression

### Fields

Each player/NPC should have:

- `kiSkillLevel`
- `kiSkillXp`
- `realmInsight`
- `unlockedKiTiers`
- `unlockedKiMoves`

For first slice, only `kiSkillLevel` and `kiSkillXp` are required.

### XP Rules

- Ki blast hit on player/NPC: `+2 kiSkillXp`
- Ki blast miss / empty cast: `+1 kiSkillXp`
- Ki target hit: `+3 kiSkillXp`
- Future moves can grant more:
  - Tier 2: `+3`
  - Tier 3: `+4`
  - Tier 4: `+5`
  - Tier 5: `+6`

### Level Curve

Use the same simple scaling style as current level XP:

- XP needed for next ki level = `kiSkillLevel * 20`

Example:

- L1 -> L2: 20
- L2 -> L3: 40
- L3 -> L4: 60

### Ki Skill Thresholds

- `Level 1`: base ki awareness
- `Level 10`: unlock `Meditate`
- `Level 20`: Tier 2 realm access
- `Level 35`: Tier 3 realm access
- `Level 50`: Tier 4 realm access
- `Level 70`: Tier 5 realm access

## Meditation

### Unlock

- `Meditate` becomes available at `kiSkillLevel >= 10`.

### Crystal Fuel

Crystal quality controls meditation duration and reward quality.

- `Poor crystal`
  - duration: `30s`
  - realm quality: low
  - insight reward: low
- `Normal crystal`
  - duration: `60s`
  - realm quality: medium
  - insight reward: medium
- `Pristine crystal`
  - duration: `90s`
  - realm quality: high
  - insight reward: high

Future:

- `bastalite` can become a realm stabilizer or reroll material.

### On-Map Rules

While meditating:

- cannot move,
- cannot attack,
- cannot use ki moves,
- remains targetable and damageable,
- stays in the world at the same position,
- shows:
  - meditation status text,
  - progress bar,
  - meditation pose / visual state.

If interrupted by knockout/death:

- meditation ends immediately,
- no realm reward is granted,
- crystal is consumed.

## Realm Tier Mapping

Realm tier should be derived from `kiSkillLevel`.

- Tier 1: `10-19`
- Tier 2: `20-34`
- Tier 3: `35-49`
- Tier 4: `50-69`
- Tier 5: `70+`

## Future Realm Loop

Each meditation sends the player/NPC mentally into a tier-specific realm map.

### Structure

Each realm run should be short and repeatable:

- 1 to 3 trial encounters depending on crystal quality
- choice/reward room after successful completion
- possibility of failure without total loss of progress

### Trial Types

- `Focus`
  - hold concentration while hazards try to break it
- `Timing`
  - parry or redirect spirit bolts
- `Control`
  - hit correct targets, avoid false targets
- `Power`
  - break crystal nodes efficiently
- `Motion`
  - use dash / movement abilities to cross gaps
- `Restraint`
  - avoid collateral damage in illusion encounters

### Reward Model

Avoid pure RNG. Use:

- `unlock offer` chance,
- `insight progress` fallback,
- `mastery reward` for already-known moves.

Recommended behavior:

- Poor crystal: mostly insight, low offer chance
- Normal crystal: balanced insight and offers
- Pristine crystal: high offer chance, better rare move odds

## Ki Move Tiers

### Tier 1

- Ki Blast
- Charge
- Sense Ki

### Tier 2

- Rapid Shot
- Piercing Shot
- Ki Dash

### Tier 3

- Barrier
- Push Wave
- Homing Shot

### Tier 4

- Beam
- Split Shot
- Drain Pulse

### Tier 5

- Ultimate blast variants
- Aura states
- Domain/control abilities

## NPC-Specific Rules

NPCs should also use the same meditation system.

### Commands

Supported owner commands:

- `meditate`
- `meditate with poor crystal`
- `meditate with crystal`
- `meditate with pristine crystal`

### Behavior

- NPCs require `kiSkillLevel >= 10`
- NPCs choose the best available crystal unless explicitly told otherwise
- NPCs remain on-map while meditating
- Other NPCs can guard them
- Their personality should bias future unlock offers:
  - aggressive -> offense
  - cooperative -> support/defense
  - fearful/neurotic -> escape/control

## UI Requirements

### Character Menu

Show:

- `Ki Skill Lv`
- `Ki Skill XP`
- current tier
- meditation unlocked state

### Inventory

Show meditation actions:

- `Meditate (Poor)` if poor crystals > 0
- `Meditate (Crystal)` if normal crystals > 0
- `Meditate (Pristine)` if pristine crystals > 0

These actions are only enabled at `kiSkillLevel >= 10`.

### World View

Meditating entities show:

- status label,
- progress bar,
- tier/realm hint optionally later.

## Data Model Additions

### Player / NPC state

- `kiSkillLevel: int`
- `kiSkillXp: int`
- `meditating: bool`
- `meditation_started_at: float | None`
- `meditation_until: float | None`
- `meditation_total_ms: int`
- `meditation_crystal_quality: str | None`
- `realm_tier: int`
- `realmInsight: int`

## First Slice Acceptance Criteria

- Players gain `kiSkillXp` from using ki blast.
- Players and NPCs can display `kiSkillLevel`.
- Meditation unlocks at `kiSkillLevel >= 10`.
- Players can spend a crystal to meditate from UI.
- NPCs can meditate via owner command.
- Meditating players/NPCs visibly remain in-world with progress bars.
- Meditating entities cannot act or move.
- Meditation completes server-side after the crystal duration.
- Completion grants a placeholder reward message and updates realm tier state.

## Follow-Up Implementation Phases

### Phase 2

- Realm insight system
- Tier 1 unlock choices
- Move unlock persistence

### Phase 3

- First actual realm map
- Realm entry/exit scene flow
- Reward selection UI

### Phase 4

- Multi-tier move trees
- NPC unlock preference logic
- Bastalite stabilization mechanics
