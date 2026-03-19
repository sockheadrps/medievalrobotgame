# AI Player NPC — Action Tree

## Phase Detection

```
EARLY GAME (0-10 logs, 0 NPCs)
├── ECONOMIC GROWTH (default)
├── AGGRESSIVE EXPANSION (if threatened)
└── DEFENSIVE FORTIFICATION (if under attack)

MID GAME (10+ logs, 1+ NPCs)
├── NPC SWARM (mass NPC building)
├── CRYSTAL OPTIMIZATION (stat stacking)
└── AGGRESSIVE EXPANSION (PvP dominance)

LATE GAME (crystals, leveled NPCs)
├── CRYSTAL OPTIMIZATION
├── AGGRESSIVE EXPANSION
└── DEFENSIVE FORTIFICATION
```

## Resource Actions

```
GATHER
├── gather_logs → find tree → chop (1.5s) → pickup log → inventory full? → give_logs to self
├── gather_stones → find rock → mine (1.5s, 5 hits) → pickup stone
└── refine → walk to anvil → spend 1 stone → 30% crystal drop
    └── consume_crystal → 50% chance boost one of 6 stats:
        ├── blast_speed
        ├── blast_range
        ├── blast_dmg
        ├── cooldown_reduction
        ├── barrier_duration
        └── barrier_cooldown
```

## Building Actions

```
BUILD
├── build_npc (10 logs) → new NPC companion → assign tasks
├── build_dummy (5 logs) → training target for NPCs
├── build_anvil (5 stones) → enables stone→crystal refinement
└── build_ki_target → ki blast practice target
```

## Combat Actions

```
COMBAT (self)
├── attack_player → find target → melee (0.8s cd, 1.2 tile range) OR ki blast (1.2s cd, 4 tile range, 8 ki)
└── train_combat → practice on dummy → gain XP

COMBAT (NPC commands)
├── attack_nearest_enemy → closest hostile
├── attack_player → specific player target
├── attack_npc → specific NPC target
├── defend_player → stay within 6 tiles, engage threats
└── train / practice_ki → dummy/ki_target for XP
```

## Social Actions

```
TALK
├── talk to player → assess relationship → update attitude (neutral/hostile/friendly)
│   ├── threaten → shift to hostile
│   ├── negotiate → possible alliance
│   └── taunt → provoke response
└── (NPC commands)
    └── socialize_npc → walk to NPC → chat 2s → emotion deltas applied
```

## NPC Management (issued as npc_commands)

```
NPC ORDERS (up to N NPCs simultaneously)
├── gather / gather_stones / gather_all
├── follow
├── idle (stop)
├── attack_nearest_enemy / attack_player / attack_npc
├── defend_player
├── train / practice_ki
├── give_logs / give_materials
├── steal_logs (rob another NPC)
├── pickup_stone / refine_stone
└── socialize_npc
```

## Movement / Positioning

```
EXPLORE → discover new territory / find resources
```

## Memory & Strategy (internal, drives decisions)

```
MEMORY SYSTEM
├── Event Log (30 entries) → raw game events
├── Diary (10 entries) → LLM-summarized strategy notes
├── Relationships (per player)
│   ├── attitude: neutral | hostile | friendly
│   ├── threat_score (0-10)
│   ├── attacks_on_me / attacks_on_npcs counters
│   └── notes (LLM-generated observations)
└── Plan
    ├── phase: early | mid | late
    ├── strategy_type: economic | aggressive | defensive | crystal | swarm
    ├── current_objective (multi-turn goal)
    ├── resource_targets {logs, stones, crystals}
    ├── threats[] / alliances[]
    └── objectives[] with progress tracking
```

## Core Game Loops the AI Can Execute

| Loop | Sequence | Goal |
|------|----------|------|
| **Resource** | gather → stockpile → build | Accumulate materials |
| **Army** | gather 10 logs → build_npc → repeat | NPC swarm |
| **Crystal** | gather stones → build anvil → refine → consume | Stat stacking |
| **Training** | build dummy → train NPCs → level up | Power scaling |
| **PvP** | scout → assess threat → attack/ally/avoid | Domination |
| **Economy→War** | early gather → mid army build → late crystal+attack | Full progression |

## Key Decision Branching Points

The LLM decides every **10 seconds** based on:

- **Inventory state** — logs/stones/crystals counts vs targets
- **Nearby threats** — players within range, their level/NPC count
- **Relationship history** — past attacks, alliances, encounters
- **NPC count & health** — army strength assessment
- **Phase assessment** — early/mid/late game triggers strategy shift

The non-deterministic element is the LLM choosing *which* valid action to take at each tick — but the action space is bounded to the ~25 commands listed above, and the game loop funnels toward: **gather → build → power up → fight**.
