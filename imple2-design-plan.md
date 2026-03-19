IMPL 3: Motivational Autonomy System

Philosophy: NPCs maintain continuous internal motivations that drive behavior without constant LLM decisions. The simulation handles routine actions while the LLM is reserved for meaningful moments: social interaction, internal conflict, and novel events.

The goal is for NPCs to feel like they want things over time, not just react to prompts.

Core Concept

NPCs maintain persistent motivations (“drives”) that increase or decrease over time.
The strongest motivation determines the NPC’s current intention.

The system operates continuously and deterministically.

The LLM is only used for:

resolving internal conflicts

generating dialogue

responding to novel events

handling player command resistance

Routine gameplay never requires the LLM.

Drive Model

Each NPC stores a set of drives ranging from 0.0–1.0.

const DRIVES = {
  aggression:        0.0, // desire to fight or train
  attachment:        0.0, // desire to stay near player
  curiosity:         0.0, // desire to explore unknown areas
  greed:             0.0, // desire to gather resources
  social:            0.0, // desire to interact with others
  ambition:          0.0, // desire to improve stats or equipment
  survival:          0.0, // emergency response to threats or low HP
};

Drives increase continuously and decay when satisfied.

Example:

curiosity += rate * deltaTime
curiosity -= satisfaction * explorationProgress

Drives never fully reset — they decay gradually to preserve continuity.

Priority Bands

Not all drives compete equally. Some represent urgent survival states.

Drives are grouped into priority bands:

Priority	Drives	Behavior
Emergency	survival	overrides all other drives
Attachment	attachment	keeps NPC near player
Activity	aggression, greed, ambition	purposeful tasks
Curiosity	curiosity, social	exploratory or expressive

Higher priority bands always override lower ones.

Example:

low HP → survival dominates even if curiosity is high
Personality Defines Drive Growth

Personality controls how quickly drives accumulate.

const DRIVE_RATES = {
  Guardian: {
    aggression: 0.02,
    attachment: 0.08,
    curiosity: 0.01,
    greed: 0.02,
    social: 0.02,
    survival: 0.05,
    ambition: 0.02
  },

  Berserker: {
    aggression: 0.09,
    attachment: 0.01,
    curiosity: 0.02,
    greed: 0.03,
    social: 0.01,
    survival: 0.02,
    ambition: 0.05
  },

  Scout: {
    aggression: 0.03,
    attachment: 0.02,
    curiosity: 0.09,
    greed: 0.04,
    social: 0.03,
    survival: 0.04,
    ambition: 0.03
  }
};

Personality therefore affects what desires emerge naturally over time.

Emotion Modifiers

Emotions temporarily modify drive growth.

Example multipliers:

fear:
  survival × 3
  curiosity × 0.2

anger:
  aggression × 2.5
  social × 0.3

trust:
  attachment × 0.5
  curiosity × 1.5

Emotions therefore bias motivations, but do not directly control actions.

Intention Selection

The system runs continuously:

Compute current drive levels

Select highest drive within priority band

Map drive → intention

Score possible actions for that intention

Execute best action

Example:

dominant drive: greed
candidate actions:
  gather nearby tree
  gather distant crystal
  collect dropped logs

utility scoring chooses best option

This prevents simplistic behaviors like always gathering the nearest object.

Action Commitment

To prevent rapid oscillation, NPCs commit to chosen intentions.

Rules:

minimum intention duration: 6–12 seconds
switch allowed only if:
  new drive exceeds current by margin OR
  emergency state triggers

This makes NPC behavior appear deliberate rather than twitchy.

Drive → Intention Mapping

Drives produce high-level intentions, not raw actions.

Drive	Intention
aggression	fight enemies or train
attachment	stay near player
curiosity	explore unknown territory
greed	gather resources
social	approach and talk to characters
ambition	improve stats or equipment
survival	retreat or defend

The TaskRunner then executes the appropriate multi-step behavior.

Drive Satisfaction

Actions partially reduce the associated drive.

Example:

combat reduces aggression gradually
gathering reduces greed
exploration reduces curiosity
conversation reduces social

Drives decay gradually rather than instantly resetting.

This preserves personality consistency.

Player Commands

Player commands interact with the drive system.

Process:

1. map command → associated drive
2. compare with NPC's dominant drive
3. determine compliance level

Example:

player command: gather
associated drive: greed

NPC dominant drive: aggression
difference: large

Personality determines reaction.

Possible responses:

Response	Behavior
eager compliance	immediately obey
reluctant compliance	obey but complain
partial compliance	perform briefly then revert
refusal	decline and explain

Hard refusals are rare and only occur when drives strongly conflict.

Players can override with higher authority commands if necessary.

LLM Usage

The LLM is only invoked for meaningful moments.

1. Drive Conflict

When two drives are close:

|driveA − driveB| < 0.05
AND both > 0.5

The LLM narrates the NPC’s reasoning and selects the outcome.

Example dialogue:

“I want to scout ahead… but leaving you alone might be dangerous.”

2. Social Interaction

When NPCs converse with players or other NPCs.

The LLM generates personality-appropriate dialogue.

3. Novel Events

First-time experiences trigger reactions.

Examples:

first enemy encounter

first defeat

witnessing unusual player behavior

The LLM can optionally adjust long-term motivations or memories.

4. Command Resistance

If an NPC resists a player command, the LLM generates the response dialogue.

Memory Integration

Memories influence drive baselines.

Example:

memory: "player abandoned me in combat"

attachment baseline −0.2
survival baseline +0.1

Memories shift tendencies within bounded ranges to prevent personality drift.

Player Feedback

When selecting an NPC, a small drive indicator is shown.

Example:

Kira (Berserker)

Aggression ████████░░
Attachment ██░░░░░░░░
Greed ███░░░░░░░░░

Optional tooltips explain behavior:

"Moving toward enemies: aggression high"
"Staying near player: attachment active"

This makes NPC behavior understandable.

Architecture Changes
Remove
Removed	Reason
Timer-based LLM decision loop	replaced by continuous motivation system
Intent whitelist	replaced by drive-based intention mapping
Frequent LLM task selection	LLM used only for events
Keep
System	Purpose
TaskRunner	executes behaviors
Emotion system	modifies drive growth
Memory system	adjusts drive baselines
Dialogue generation	LLM handles expression
New Files
File	Purpose
DriveSystem.js	updates drives and selects intentions
UtilityScorer.js	evaluates candidate actions
DriveIndicator.js	visualizes NPC motivations
Expected Gameplay Feel

NPCs feel autonomous because they maintain ongoing motivations rather than waiting for instructions.

Players observe consistent behavioral patterns:

Berserkers drift toward combat

Scouts wander and report discoveries

Guardians remain near the player

Pragmatists optimize resource use

The LLM appears during meaningful moments, making dialogue and internal conflict feel intentional instead of routine.

NPCs therefore appear to possess continuous internal lives, not just scripted reactions.