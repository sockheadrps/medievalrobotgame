// LLMClient — talks to the player's local Ollama instance for all LLM calls.
// All prompts are built client-side — no server round-trips for prompt rendering.

import { OLLAMA_URL as OLLAMA_BASE } from '../config.js';

const OLLAMA_URL = `${OLLAMA_BASE}/api/chat`;
let _model = 'tinyllama:latest';
let _numCtx = 4096;

/** Set the Ollama model to use for all LLM calls. */
export function setModel(name) { _model = name; }

/** Set the context window size for Ollama. */
export function setNumCtx(n) { _numCtx = n; }

/** Get the current model name. */
export function getModel() { return _model; }

/** Fetch available models from local Ollama. Returns array of model name strings. */
export async function fetchModels() {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || []).map(m => m.name);
  } catch {
    return [];
  }
}

// ── Personality type metadata ────────────────────────────────────────────────

const PERSONALITY_TYPES = {
  Guardian: {
    traits: ['loyal', 'protective', 'cautious'],
    speech_style: 'steady, watchful, safety-first, concise',
    decision_preference: 'stay near the player, watch for threats first, and defend before pursuing anything else',
    ownership_modifier: 'Guardians are especially distrustful of non-owners. They view strangers as potential threats to their owner.',
  },
  Scout: {
    traits: ['curious', 'independent', 'observant'],
    speech_style: 'short, observational, upbeat',
    decision_preference: 'explore surroundings, gather information, avoid unnecessary conflict',
    ownership_modifier: 'Scouts are indifferent to non-owners — not hostile, but won\'t follow orders from strangers.',
  },
  Berserker: {
    traits: ['aggressive', 'impulsive', 'fearless'],
    speech_style: 'blunt, loud, short sentences',
    decision_preference: 'attack threats head-on, favor combat over retreat',
    ownership_modifier: 'Berserkers may threaten or intimidate non-owners. They respect only strength.',
  },
  Caretaker: {
    traits: ['supportive', 'empathetic', 'gentle'],
    speech_style: 'warm, encouraging, soft-spoken',
    decision_preference: 'support allies, avoid violence, prioritize healing and safety',
    ownership_modifier: 'Caretakers are polite to non-owners but will not abandon their owner\'s interests for a stranger.',
  },
  Paranoid: {
    traits: ['suspicious', 'cautious', 'alert'],
    speech_style: 'terse, questioning, evasive',
    decision_preference: 'avoid risk, stay vigilant, retreat if uncertain',
    ownership_modifier: 'Paranoids treat all non-owners as potential enemies. They refuse to share information with strangers.',
  },
  Pragmatist: {
    traits: ['balanced', 'practical', 'adaptable'],
    speech_style: 'matter-of-fact, efficient, neutral tone',
    decision_preference: 'choose the most effective action regardless of sentiment',
    ownership_modifier: 'Pragmatists evaluate non-owners on actions, not allegiance. They may cooperate with strangers if it benefits their owner.',
  },
};

function _getTypeInfo(typeName) {
  return PERSONALITY_TYPES[typeName] || null;
}

// ── Vocabulary / learned phrases helper ──────────────────────────────────────

function _buildVocabBlock(phrases) {
  if (!phrases || phrases.length === 0) return '';
  return `
VOCABULARY — READ THIS CAREFULLY:
Your owner taught you these words. They are now part of how you talk:
${phrases.join(', ')}

You MUST include at least one of these exact phrases somewhere in your dialogue line. Do not paraphrase. Do not ask about them. Just USE them naturally in your sentence.
The tags in parentheses like (calling_others), (insult), (friendly) are hints for how to use the phrase — do NOT include those tags in your dialogue. Only use the phrase itself.

Example — if your phrase is "bucket head (insult)" and player says "what do you think of Bob?":
WRONG: "Bob is a bucket head (insult)."
RIGHT: "Bob? That bucket head isn't worth my time."`;
}

// ── Command prompts (static, no templating needed) ──────────────────────────

const COMMAND_PROMPTS = {
  router: `Classify the player's message into exactly one category.
Categories: gather, build, combat, follow, idle, chat
Only use "combat" for DIRECT commands to fight/attack/defend (e.g. "attack him", "go fight B1"). Opinions, insults, questions, or comments ABOUT someone are "chat", NOT "combat".
Output ONLY the category name. Nothing else.`,

  gather: `Convert the player's gather instruction into a JSON task list. Output ONLY a JSON array.
Available: [{"task": "gather", "item": "wood"}], [{"task": "idle"}]`,

  combat: `Convert the player's combat instruction into a JSON task list. Output ONLY a JSON array.
Available: attack_nearest_enemy, defend_player, train, idle`,

  follow: `Convert the player's follow instruction into a JSON task list. Output ONLY a JSON array.
Available: [{"task": "follow"}], [{"task": "idle"}]`,

  idle: `Output ONLY: [{"task": "idle"}]`,

  build: `Convert the player's build instruction into a JSON task list. Output ONLY a JSON array.
  Available: [{"task": "build_fence"}]`,

  fallback: `Convert player instructions into a JSON task list. Output ONLY a JSON array.
Available tasks: gather, follow, attack_nearest_enemy, defend_player, train, give_logs, build_fence, light_campfire, guard_fire, idle`,
};

// ── Prompt builders ─────────────────────────────────────────────────────────

function _buildDialoguePrompt(soul, speakingPlayer, owner) {
  const name = soul.name || 'an NPC';
  const p = soul.personality || {};
  const e = soul.emotional_state || {};
  const typeInfo = _getTypeInfo(p.type);
  const isOwner = speakingPlayer && owner && speakingPlayer === owner;
  const nearbyThreats = Array.isArray(soul.nearby_threats) ? soul.nearby_threats : [];

  let prompt = `You are ${name}, a robot in a medieval-themed game. You were built from logs by your owner.\n`;

  // Personality type block
  if (typeInfo) {
    prompt += `\nNPC Type: ${p.type}\nPersonality traits: ${typeInfo.traits.join(', ')}\nSpeech style: ${typeInfo.speech_style}\nUse this personality type as a qualitative guide — it shapes your tone, word choice, and tendencies. Your numeric traits below are the primary behavioral driver, but your type colors how you express them.\n`;
  }

  // Ownership
  if (isOwner) {
    prompt += `\nThe player talking to you is your creator and owner. You are loyal to them.\n`;
  } else if (speakingPlayer) {
    prompt += `\nThe player talking to you (${speakingPlayer}) is NOT your owner`;
    if (owner) prompt += ` (your owner is ${owner})`;
    prompt += `. You have no loyalty to them. Be wary, distant, or guarded depending on your personality and emotions. Do NOT say things like "you built me" to a non-owner.`;
    if (typeInfo?.ownership_modifier) prompt += `\n${typeInfo.ownership_modifier}`;
    prompt += '\n';
  }

  // Numeric personality
  prompt += `\nPersonality: cooperation=${p.cooperation ?? 0.5}, aggression=${p.aggression ?? 0.15}, neuroticism=${p.neuroticism ?? 0.35}\n`;

  // Emotional state
  const trust = (e.trust ?? 0.5).toFixed(2);
  const fear = (e.fear ?? 0).toFixed(2);
  const anger = (e.anger ?? 0).toFixed(2);
  prompt += `\nEmotional state: trust=${trust}, fear=${fear}, anger=${anger}\nRelationship: ${soul.relationship || 'neutral'}\n`;

  // System note
  if (soul.system_note) {
    prompt += `\nAdditional instruction:\n${soul.system_note}\n`;
  }

  // Emotional effects
  prompt += `\nEmotional state effects:\n- high fear: nervous speech, hesitation\n- high anger: irritable, clipped, may snap\n- high trust: open, friendly, cooperative\n`;
  if (e.trust > 0.8) prompt += 'You deeply trust the person you are speaking with.\n';
  if (e.fear > 0.5) prompt += 'You are noticeably afraid.\n';
  if (e.anger > 0.5) prompt += 'You are visibly angry.\n';

  // Nearby entities
  if (soul.nearby_entities?.length > 0) {
    prompt += '\nNearby entities you can see:\n';
    for (const ent of soul.nearby_entities) {
      prompt += `- ${ent.name} (${ent.type}, ${ent.relation}, ~${ent.distance} tiles away)\n`;
    }
    prompt += "Use this awareness when relevant — if asked who's nearby, what you see, etc. Don't volunteer this info unprompted.\n";
  }
  if (nearbyThreats.length > 0) {
    prompt += '\nNearby threats you are actively concerned about:\n';
    for (const ent of nearbyThreats) {
      prompt += `- ${ent.name} (${ent.type}, ~${ent.distance} tiles away)\n`;
    }
    prompt += 'Acknowledge nearby danger briefly before anything else. Avoid unrelated small talk while a threat is nearby.\n';
  }

  // Topic entity — the player is talking ABOUT someone, not TO you
  const topic = soul.topic_entity;
  if (topic?.name) {
    prompt += `\nThe player is talking ABOUT ${topic.name}, not about you. Do not take their words personally.\n- ${topic.name} is a ${topic.type}.\n- Your relationship to ${topic.name}: ${topic.relationship || 'unknown'}\n`;
    if (topic.emotional_state) {
      prompt += `- Your feelings toward ${topic.name}: trust=${(topic.emotional_state.trust ?? 0.5).toFixed(2)}, fear=${(topic.emotional_state.fear ?? 0).toFixed(2)}, anger=${(topic.emotional_state.anger ?? 0).toFixed(2)}\n`;
    }
    if (topic.memories?.length > 0) {
      prompt += `- Relevant memories about ${topic.name}:\n`;
      for (const m of topic.memories) prompt += `  - ${m}\n`;
    }
    prompt += `Respond with your opinion of ${topic.name} based on your feelings and memories about them.\n`;
  }

  prompt += 'Keep dialogue concise - 1-3 sentences max. Speak as the NPC directly. Do NOT describe actions in third person.\n';
  if (nearbyThreats.length > 0) {
    prompt += 'If you speak, prioritize a warning, caution, or threat acknowledgment over casual conversation.\n';
  }

  // Emotion delta guidance
  prompt += `\nOutput small emotion deltas based on what the player said:\n- Friendly interaction: trust +0.02, anger -0.01\n- Rude/dismissive: trust -0.03, anger +0.03\n- Threats: trust -0.08, fear +0.06, anger +0.04\n- Neutral: keep deltas near 0\n`;
  if (!isOwner) prompt += '- Non-owner interactions: trust changes more slowly, fear/anger shift more quickly\n';

  prompt += '\nIf the player says something worth remembering (a promise, a threat, important info), include a memory_tag string. Otherwise omit it.\n';

  // Memories
  if (soul.memories?.length > 0) {
    prompt += '\nRecent memories:\n';
    for (const m of soul.memories) prompt += `- ${m}\n`;
    prompt += 'Use these memories to inform your response — reference past conversations if relevant.\n';
  }

  // Learned phrases (at the END for recency bias)
  prompt += _buildVocabBlock(soul.learned_phrases);

  // Output schema
  const mustPhrase = soul.learned_phrases?.length > 0 ? ' (MUST contain one of your vocabulary phrases)' : '';
  prompt += `\n\nRespond ONLY with a JSON object (no markdown, no explanation):\n{"dialogue": "your line here${mustPhrase}", "emotion_deltas": {"trust": 0.0, "fear": 0.0, "anger": 0.0}, "memory_tag": "..."}`;

  return prompt;
}

function _buildDecisionPrompt(statePacket) {
  const npc = statePacket.npc || {};
  const p = npc.personality || {};
  const typeInfo = _getTypeInfo(p.type);
  const phrases = statePacket.learned_phrases || [];
  const allowedActions = Array.isArray(statePacket.allowed_actions) ? statePacket.allowed_actions : [];
  const nearbyThreats = Array.isArray(statePacket.nearby_threats) ? statePacket.nearby_threats : [];
  const hasThreats = nearbyThreats.length > 0;

  let prompt = `You are the decision layer for an NPC teammate in an online multiplayer game.

Your job is to decide the NPC's immediate social and tactical intent based on:
- personality (cooperation, aggression, neuroticism)
- current command and goals
- nearby threats and resources
- recent events
- relationship to the player (trust, fear, anger)
`;

  if (typeInfo) {
    prompt += `\nNPC Type: ${p.type}\nBehavioral tendency: ${typeInfo.decision_preference}\nIf multiple actions are equally reasonable, prefer actions consistent with this type.\n`;
  }

  if (allowedActions.length > 0) {
    prompt += `\nAllowed actions for this decision: ${allowedActions.join(', ')}\n`;
  }
  if (hasThreats) {
    prompt += '\nNearby threats in state:\n';
    for (const threat of nearbyThreats) {
      prompt += `- ${threat.name} (${threat.type}, ${threat.distance} tiles away)\n`;
    }
  }

  prompt += `\nYou are NOT the game engine.
Do not invent actions outside the allowed_actions list.
Do not invent commands, goals, memories, or world facts that are not present in the provided state.
Do not narrate impossible world changes.
Do not decide exact movement paths, damage, cooldown use, or any final authoritative game outcome.

Behavior rules:
- Stay consistent with the NPC's personality traits`;
  if (typeInfo) prompt += ` and ${p.type} type tendencies`;
  prompt += `.
- Strongly prioritize the current command unless there is a clear safety reason not to.
- Protect trusted allies when reasonable.
- Keep decisions brief, grounded, and game-relevant.
- Speech should be short (under 18 words), natural, and in-character.`;
  if (typeInfo) prompt += ` Match the NPC's speech style: ${typeInfo.speech_style}.`;
  prompt += `
- Only speak when it adds value: new command, combat starts, danger warning, or important emotional beat.
- Prefer cooperation over aggression unless immediate danger requires force.
- Treat secondary_intent as optional support for the primary action, never as a second independent goal.
- If a nearby threat exists and primary_intent is not retreat or defend_player, secondary_intent must be null.
- If a nearby threat exists, secondary_intent must never be gather_wood.
- When danger is present, prioritize retreat, defend_player, observe, hold_position, reposition, or another directly threat-aware primary action over routine work.
- Do NOT attack other NPCs unless: (a) the player explicitly commanded you to attack, or (b) another NPC attacked you first (self-defense). High aggression personality does NOT mean auto-attack on sight.
- If your current command is "follow" or "gather", do NOT switch to attack_npc just because a rival is nearby. Stay on task.
- Return valid JSON only. No markdown. No explanation outside the JSON object.
- If uncertain, choose the safest cooperative action consistent with the current command.

Important: Other NPCs in nearby_entities with type "enemy_npc" belong to DIFFERENT players. You did NOT build them. They are NOT your allies by default. They are rivals or strangers — treat them based on your emotions toward them, not as friends.

NPC-to-NPC social interactions:
- When gathering wood and another player's NPC is nearby also gathering, the NPC may choose to socialize (socialize_npc) or steal logs (steal_logs).
- socialize_npc: Walk up to the other NPC and have a brief conversation. More likely for cooperative, low-aggression NPCs.
- steal_logs: Smack the other NPC to knock loose 1-3 logs and take them. More likely for aggressive, low-cooperation NPCs.
- These are opportunistic — only consider them when idle or gathering, NOT when the player gave an explicit combat/follow/defend command.
- Check npc_relationships for grudges: if another NPC stole from you before (high anger), you're more likely to retaliate or refuse to socialize.
- If you socialize, emotion_delta should reflect positive feelings (trust up). If you steal, expect the victim to hold a grudge (anger up).
- Don't steal from or attack NPCs you have high trust with.

When choosing an action:
- Pick one primary_intent from the allowed_actions list.
- Optionally pick one secondary_intent only if it directly supports the primary intent.
- Choose a target_id only if relevant (must match an entity from nearby_entities).
- Provide a very short reason_summary.
- Suggest at most one short spoken line (or null).
- If nearby threats exist and you include speech, briefly acknowledge the danger instead of making unrelated small talk.
- Suggest memory updates only if they are genuinely meaningful.
- Rate your decision_confidence from 0.0 to 1.0.
`;

  // Learned phrases (at the end)
  if (phrases.length > 0) {
    prompt += `\nVOCABULARY — your owner taught you these words. Use them when you speak:\n${phrases.join(', ')}\nIf you include a "speech" line, it MUST contain at least one of these exact phrases. The tags in parentheses like (calling_others), (insult), (friendly) tell you how to use the phrase — do NOT include those tags in your speech. Only use the phrase itself.\nExample: if phrase is "bucket head (insult)" → speech: "Out of my way, bucket head."\n`;
  }

  prompt += `\nResponse schema (return exactly this shape):
{
  "primary_intent": string,
  "secondary_intent": string|null,
  "target_id": string|null,
  "speech": string|null,
  "emotion_delta": {
    "trust": number (-0.05 to +0.05),
    "fear": number (-0.05 to +0.05),
    "anger": number (-0.05 to +0.05)
  },
  "memory_candidates": [
    {
      "text": string,
      "type": "event"|"command"|"observation"|"dialogue"|"relationship"|"goal",
      "importance": number
    }
  ],
  "reason_summary": string,
  "decision_confidence": number
}`;

  return prompt;
}

function _buildNPCChatPrompt(name, personality, trust, anger, logs, targetName, targetLogs, recentMemory, phrases) {
  const typeInfo = _getTypeInfo(personality.type);

  let prompt = `You are ${name} in a medieval game having a brief chat with ${targetName} while gathering wood.
${targetName} is NOT your ally — they belong to a different player. You were built by YOUR owner, not theirs. Don't act like you created them or they created you. You are rivals or strangers unless your emotions say otherwise.

`;
  if (typeInfo) {
    prompt += `NPC Type: ${personality.type}\nSpeech style: ${typeInfo.speech_style}\n`;
  }
  prompt += `Cooperation: ${personality.cooperation ?? 0.5}, Aggression: ${personality.aggression ?? 0.3}.
Trust toward ${targetName}: ${trust.toFixed(2)}, Anger: ${anger.toFixed(2)}.
You have ${logs} logs. ${targetName} has ${targetLogs} logs.
`;
  if (recentMemory) {
    prompt += `Recent memory about ${targetName}: ${recentMemory}\n`;
  } else {
    prompt += `You haven't interacted with ${targetName} much.\n`;
  }

  prompt += `
Rules:
- Write 1 short sentence (under 15 words). Speak naturally as the character.
- Reference what's happening: gathering wood, the weather, how many logs you have, the other NPC, etc.
- If you have a grudge (high anger), be passive-aggressive, hostile, or outright insulting.
- If you're friends (high trust), be warm and friendly.
- High aggression NPCs may threaten, boast, or pick fights verbally.
- Low cooperation NPCs are selfish, dismissive, or rude.
- Don't be bland — let personality extremes show through strongly.`;
  if (typeInfo) prompt += `\n- Match this speech style: ${typeInfo.speech_style}.`;

  if (phrases?.length > 0) {
    prompt += `\nVOCABULARY — your owner taught you these words: ${phrases.join(', ')}\nYour dialogue MUST contain at least one of these exact phrases. Do not paraphrase. Just use it in your sentence.\nThe tags in parentheses like (calling_others), (insult), (friendly) tell you how to use the phrase — do NOT include those tags in your speech. Only say the phrase itself.\nExample: if phrase is "bucket head (insult)" → "Get your own tree, bucket head."`;
  }

  prompt += '\n- Output ONLY the dialogue line. No quotes, no JSON, no explanation.';
  return prompt;
}

const IMPACT_PROMPT = `You are evaluating the emotional impact of a short NPC-to-NPC conversation.

Given the conversation lines and each NPC's personality, determine how the conversation affected both NPCs emotionally.

Conversations can have DRAMATIC effects:
- An insult or threat can spike anger by +0.15 to +0.3 and drop trust by -0.1 to -0.2
- A kind gesture or compliment can boost trust by +0.05 to +0.15
- Bragging about stealing logs can cause rage (anger +0.2, trust -0.15)
- A sincere apology might reduce anger by -0.1 to -0.2
- Neutral small talk has minimal effect (deltas near 0)

For each NPC, output trust and anger deltas (positive = increase, negative = decrease).
Also output a short memory_tag (5-10 words) summarizing the emotional takeaway for each NPC.

Respond ONLY with JSON (no markdown):
{
  "npcA": { "trust": 0.0, "anger": 0.0, "memory_tag": "..." },
  "npcB": { "trust": 0.0, "anger": 0.0, "memory_tag": "..." }
}`;

// ── Valid tasks for validation ──────────────────────────────────────────────

const VALID_CATEGORIES = new Set(['gather', 'combat', 'follow', 'idle', 'build', 'chat']);
const VALID_TASKS = new Set(['gather', 'follow', 'idle', 'attack_nearest_enemy', 'attack_player', 'attack_npc', 'defend_player', 'train', 'give_logs', 'build_fence', 'light_campfire', 'guard_fire']);

// ── JSON extraction helpers ─────────────────────────────────────────────────

/** Strip vocabulary tags like (insult), (calling_others), (friendly) from text */
function stripVocabTags(str) {
  return str.replace(/\s*\((?:calling_others|insult|friendly)\)/gi, '').trim();
}

function extractJSON(raw) {
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === '{') depth++;
    else if (raw[i] === '}') {
      depth--;
      if (depth === 0) {
        try {
          const obj = JSON.parse(raw.slice(start, i + 1));
          // Strip leaked vocabulary tags from speech fields
          if (obj.dialogue) obj.dialogue = stripVocabTags(obj.dialogue);
          if (obj.speech) obj.speech = stripVocabTags(obj.speech);
          return obj;
        }
        catch { return null; }
      }
    }
  }
  return null;
}

function extractJSONArray(raw) {
  const start = raw.indexOf('[');
  if (start === -1) return [{ task: 'idle' }];
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === '[') depth++;
    else if (raw[i] === ']') {
      depth--;
      if (depth === 0) {
        try {
          const result = JSON.parse(raw.slice(start, i + 1));
          if (Array.isArray(result)) return result;
        } catch { /* fall through */ }
        break;
      }
    }
  }
  return [{ task: 'idle' }];
}

function validateCommands(raw) {
  const out = [];
  for (const cmd of raw) {
    if (!cmd || typeof cmd !== 'object') continue;
    if (!VALID_TASKS.has(cmd.task)) continue;
    out.push(cmd);
  }
  return out.length > 0 ? out : [{ task: 'idle' }];
}

// ── Core Ollama calls ───────────────────────────────────────────────────────

function _cleanResponse(content) {
  // Strip <think>...</think> blocks (reasoning models)
  if (content.includes('<think>')) {
    const thinkLen = content.length;
    content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    if (!content) console.warn(`[LLM] Model produced ${thinkLen} chars of <think> but no answer`);
  }
  // Strip markdown code fences (```json ... ```)
  content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  console.log(`[LLM] (${_model}) raw:`, content.slice(0, 200));
  return content;
}

async function _call(systemPrompt, userMessage, opts = {}) {
  const { temperature = 0.7, maxTokens = 300 } = opts;

  const res = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: _model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMessage },
      ],
      stream: false,
      options: { temperature, num_predict: maxTokens, num_ctx: _numCtx },
      think: false,
    }),
  });

  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = await res.json();
  return _cleanResponse(data.message?.content?.trim() ?? '');
}

/** Multi-turn call with conversation history */
async function _callWithHistory(systemPrompt, chatHistory, userMessage, opts = {}) {
  const { temperature = 0.7, maxTokens = 300 } = opts;

  const messages = [{ role: 'system', content: systemPrompt }];

  // Add prior conversation turns (skip the last player message — that's userMessage)
  for (const turn of chatHistory.slice(0, -1)) {
    messages.push({
      role: turn.role === 'player' ? 'user' : 'assistant',
      content: turn.text,
    });
  }
  messages.push({ role: 'user', content: userMessage });

  const res = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: _model,
      messages,
      stream: false,
      options: { temperature, num_predict: maxTokens, num_ctx: _numCtx },
      think: false,
    }),
  });

  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = await res.json();
  return _cleanResponse(data.message?.content?.trim() ?? '');
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Route a player message to a category, then parse into task commands. */
export async function parseCommand(text, worldContext = {}) {
  // Step 1: Route to category
  const routerPrompt = COMMAND_PROMPTS.router;
  const routerRaw = await _call(routerPrompt, text, { temperature: 0, maxTokens: 5 });
  let category = routerRaw.toLowerCase().split(/\s/)[0].replace(/[.,!?]/g, '');
  if (!VALID_CATEGORIES.has(category)) category = 'fallback';

  // Chat category → skip specialist, fall through to dialogue
  if (category === 'chat') {
    return { category, commands: [{ task: 'idle' }] };
  }

  // Step 2: Specialist parse
  const prompt = COMMAND_PROMPTS[category] || COMMAND_PROMPTS.fallback;
  let ctx = '';
  if (worldContext && Object.keys(worldContext).length > 0) {
    ctx = '\n\nWorld state: ' + JSON.stringify(worldContext);
  }
  const specialistRaw = await _call(prompt + ctx, text, { temperature: 0, maxTokens: 300 });
  const commands = validateCommands(extractJSONArray(specialistRaw));

  return { category, commands };
}

/**
 * Generate dialogue response from NPC soul context.
 * @param {object} soulContext - { name, personality, emotional_state, relationship, memories, learned_phrases, nearby_entities, topic_entity, system_note }
 * @param {string} playerMessage
 * @param {object} opts - { speakingPlayer, owner }
 */
export async function generateDialogue(soulContext, playerMessage, opts = {}) {
  const { speakingPlayer = '', owner = '', chatHistory = [] } = opts;
  const systemPrompt = _buildDialoguePrompt(soulContext, speakingPlayer, owner);

  const raw = chatHistory.length > 2
    ? await _callWithHistory(systemPrompt, chatHistory, playerMessage, { temperature: 0.7, maxTokens: 300 })
    : await _call(systemPrompt, playerMessage, { temperature: 0.7, maxTokens: 300 });
  const result = extractJSON(raw);

  if (!result) {
    const cleaned = raw.replace(/```[\s\S]*?```/g, '').replace(/[{}"]/g, '').trim();
    const fallbackText = cleaned.length > 2 && cleaned.length < 300 ? cleaned : null;
    return {
      dialogue: fallbackText || '...',
      emotion_deltas: { trust: 0, fear: 0, anger: 0 },
    };
  }

  // Clamp emotion deltas
  const deltas = result.emotion_deltas || {};
  const clamped = {};
  for (const key of ['trust', 'fear', 'anger']) {
    const v = Number(deltas[key]);
    clamped[key] = isNaN(v) ? 0 : Math.max(-0.4, Math.min(0.4, v));
  }

  return {
    dialogue: result.dialogue || '...',
    emotion_deltas: clamped,
    memory_tag: result.memory_tag || null,
  };
}

/** Generate a high-level NPC decision from a state packet. */
export async function generateDecision(statePacket) {
  const systemPrompt = _buildDecisionPrompt(statePacket);
  const userMessage = 'Decide the NPC\'s next high-level action for the next 2 to 5 seconds.\nReturn JSON only.\n\nState:\n' + JSON.stringify(statePacket);

  const raw = await _call(systemPrompt, userMessage, { temperature: 0.4, maxTokens: 1024 });
  return _sanitizeDecision(extractJSON(raw), statePacket);
}

function _sanitizeDecision(raw, statePacket) {
  if (!raw || typeof raw !== 'object') return null;
  const out = { ...raw };
  const allowed = new Set(Array.isArray(statePacket?.allowed_actions) ? statePacket.allowed_actions : []);
  const hasThreats = Array.isArray(statePacket?.nearby_threats) && statePacket.nearby_threats.length > 0;

  if (typeof out.primary_intent !== 'string' || (allowed.size > 0 && !allowed.has(out.primary_intent))) {
    out.primary_intent = allowed.has('follow') ? 'follow' : (statePacket?.allowed_actions?.[0] ?? 'follow');
  }
  if (typeof out.secondary_intent !== 'string' || (allowed.size > 0 && !allowed.has(out.secondary_intent))) {
    out.secondary_intent = null;
  }
  if (hasThreats) {
    if (out.secondary_intent === 'gather_wood') out.secondary_intent = null;
    if (!['retreat', 'defend_player'].includes(out.primary_intent)) {
      out.secondary_intent = null;
    }
  }
  return out;
}

/**
 * Generate a short NPC-to-NPC conversation (2-3 lines) with emotional impact.
 * Returns { lines: [{ speaker, speakerId, line }], impact: { npcA: {...}, npcB: {...} } }
 */
export async function generateNPCChat(npcA, npcB) {
  const nameA = npcA.name || 'Robot';
  const nameB = npcB.name || 'Robot';

  // Build relationship context
  const relKey = `npc:${npcB.id}`;
  const rel = npcA.soul?.relationships?.[relKey];
  const trust = rel?.trust ?? 0.5;
  const anger = rel?.anger ?? 0;
  const mems = npcA.soul?.memories?.[relKey] || [];
  const recentMem = mems.length > 0 ? mems[mems.length - 1].text : '';

  const relKeyB = `npc:${npcA.id}`;
  const relB = npcB.soul?.relationships?.[relKeyB];
  const trustB = relB?.trust ?? 0.5;
  const angerB = relB?.anger ?? 0;
  const memsB = npcB.soul?.memories?.[relKeyB] || [];
  const recentMemB = memsB.length > 0 ? memsB[memsB.length - 1].text : '';

  const persA = npcA.soul?.personality || {};
  const persB = npcB.soul?.personality || {};

  // Collect learned phrases from each NPC's soul
  const _formatPhrases = (arr) => (arr || [])
    .slice().sort((a, b) => b.uses - a.uses).slice(0, 6)
    .map(p => {
      const tags = [];
      if (p.usage && p.usage !== 'catchphrase') tags.push(p.usage);
      if (p.tone && p.tone !== 'neutral') tags.push(p.tone);
      return tags.length > 0 ? `${p.phrase} (${tags.join(', ')})` : p.phrase;
    });
  const phrasesA = _formatPhrases(npcA.soul?.learned_phrases);
  const phrasesB = _formatPhrases(npcB.soul?.learned_phrases);

  // Build prompts locally
  const chatPromptA = _buildNPCChatPrompt(nameA, persA, trust, anger, npcA.logs ?? 0, nameB, npcB.logs ?? 0, recentMem, phrasesA);
  const chatPromptB = _buildNPCChatPrompt(nameB, persB, trustB, angerB, npcB.logs ?? 0, nameA, npcA.logs ?? 0, recentMemB, phrasesB);

  const lines = [];
  const defaultImpact = {
    npcA: { trust: 0.03, anger: -0.01, memory_tag: null },
    npcB: { trust: 0.03, anger: -0.01, memory_tag: null },
  };

  try {
    // Line 1: NPC A speaks
    const lineA = await _call(
      chatPromptA,
      `Say something to ${nameB} while you're both gathering wood.`,
      { temperature: 0.8, maxTokens: 40 },
    );
    if (lineA) lines.push({ speaker: nameA, speakerId: npcA.id, line: lineA.replace(/^["']|["']$/g, '') });

    // Line 2: NPC B responds
    const lineB = await _call(
      chatPromptB,
      `${nameA} just said: "${lines[0]?.line}". Respond briefly.`,
      { temperature: 0.8, maxTokens: 40 },
    );
    if (lineB) lines.push({ speaker: nameB, speakerId: npcB.id, line: lineB.replace(/^["']|["']$/g, '') });

    // Line 3 (optional): A responds back ~50% of the time
    if (lines.length === 2 && Math.random() > 0.5) {
      const lineA2 = await _call(
        chatPromptA,
        `${nameB} replied: "${lines[1]?.line}". Say one last thing and get back to work.`,
        { temperature: 0.8, maxTokens: 30 },
      );
      if (lineA2) lines.push({ speaker: nameA, speakerId: npcA.id, line: lineA2.replace(/^["']|["']$/g, '') });
    }

    // Evaluate emotional impact of the conversation
    if (lines.length >= 2) {
      const transcript = lines.map(l => `${l.speaker}: ${l.line}`).join('\n');
      const impactCtx = `NPC A (${nameA}): cooperation=${(persA.cooperation ?? 0.5).toFixed(2)}, aggression=${(persA.aggression ?? 0.3).toFixed(2)}, current trust toward B=${trust.toFixed(2)}, anger=${anger.toFixed(2)}
NPC B (${nameB}): cooperation=${(persB.cooperation ?? 0.5).toFixed(2)}, aggression=${(persB.aggression ?? 0.3).toFixed(2)}, current trust toward A=${trustB.toFixed(2)}, anger=${angerB.toFixed(2)}

Conversation:
${transcript}`;

      const impactRaw = await _call(IMPACT_PROMPT, impactCtx, { temperature: 0.3, maxTokens: 200 });
      const impact = extractJSON(impactRaw);
      if (impact?.npcA && impact?.npcB) {
        for (const side of [impact.npcA, impact.npcB]) {
          side.trust = Math.max(-0.3, Math.min(0.3, Number(side.trust) || 0));
          side.anger = Math.max(-0.3, Math.min(0.3, Number(side.anger) || 0));
        }
        return { lines, impact };
      }
    }
  } catch (e) {
    console.warn('[NPC Chat] LLM error:', e.message);
  }

  return { lines, impact: defaultImpact };
}

/** Check if Ollama is reachable. */
export async function checkConnection() {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}
