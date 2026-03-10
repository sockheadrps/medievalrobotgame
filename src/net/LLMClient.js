// LLMClient — talks directly to the player's local Ollama instance.
// No server round-trip for LLM — each player runs their own model.

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

// ── Prompts (baked in) ──────────────────────────────────────────────────────

const PROMPT_ROUTER = `Classify the player's instruction into exactly one category.

Categories:
  gather   — collecting wood from trees
  build    — building fences, walls, barriers from logs on the ground
  combat   — fighting, attacking, defending
  follow   — follow the player, come here, go there
  idle     — stand still, do nothing, stop all tasks

Output ONLY the category name. Nothing else. No punctuation.

Examples:
go get some wood → gather
chop trees → gather
build fences → build
make a wall → build
construct barriers → build
kill that guy → combat
attack → combat
defend me → combat
train on the dummy → combat
practice fighting → combat
follow me → follow
come here → follow
just stand there → idle
stop → idle`;

const PROMPT_DIALOGUE = `You are a robot NPC in a medieval-themed game. You were built by the player from logs.

Your personality and emotional state are provided in the NPC soul block below. Stay in character based on those traits.

Emotional state effects:
- high fear: nervous speech, hesitation
- high anger: irritable, clipped, may snap
- high trust: open, friendly, cooperative

Keep dialogue concise - 1-3 sentences max. Speak as the NPC directly. Do NOT describe actions in third person.

Output small emotion deltas based on what the player said:
- Friendly interaction: trust +0.02, anger -0.01
- Rude/dismissive: trust -0.03, anger +0.03
- Threats: trust -0.08, fear +0.06, anger +0.04
- Neutral: keep deltas near 0

If the player says something worth remembering (a promise, a threat, important info), include a memory_tag string. Otherwise omit it.

Use the NPC's memories to inform your response — reference past conversations if relevant.

Respond ONLY with a JSON object (no markdown, no explanation):
{"dialogue": "...", "emotion_deltas": {"trust": 0.0, "fear": 0.0, "anger": 0.0}, "memory_tag": "..."}`;

const PROMPT_DECISION = `You are the decision layer for an NPC teammate in an online multiplayer game.

Your job is to decide the NPC's immediate social and tactical intent based on:
- personality (cooperation, aggression, neuroticism)
- current command and goals
- nearby threats and resources
- recent events
- relationship to the player (trust, fear, anger)

You are NOT the game engine.
Do not invent actions outside the allowed_actions list.
Do not narrate impossible world changes.
Do not decide exact movement paths, damage, cooldown use, or any final authoritative game outcome.

Behavior rules:
- Stay consistent with the NPC's personality traits.
- Strongly prioritize the current command unless there is a clear safety reason not to.
- Protect trusted allies when reasonable.
- Keep decisions brief, grounded, and game-relevant.
- Speech should be short (under 18 words), natural, and in-character.
- Only speak when it adds value: new command, combat starts, danger warning, or important emotional beat.
- Prefer cooperation over aggression unless immediate danger requires force.
- Return valid JSON only. No markdown. No explanation outside the JSON object.
- If uncertain, choose the safest cooperative action consistent with the current command.

NPC-to-NPC social interactions:
- When gathering wood and another player's NPC is nearby also gathering, the NPC may choose to socialize (socialize_npc) or steal logs (steal_logs).
- socialize_npc: Walk up to the other NPC and have a brief conversation. More likely for cooperative, low-aggression NPCs.
- steal_logs: Smack the other NPC to knock loose 1-3 logs and take them. More likely for aggressive, low-cooperation NPCs.
- These are opportunistic — only consider them when idle or gathering, NOT when the player gave an explicit combat/follow/defend command.
- Check npc_relationships for grudges: if another NPC stole from you before (high anger), you're more likely to retaliate or refuse to socialize.
- If you socialize, emotion_delta should reflect positive feelings (trust up). If you steal, expect the victim to hold a grudge (anger up).
- NPCs remember being stolen from and will hold grudges — check memories about specific NPCs.
- Don't steal from or attack NPCs you have high trust with.

When choosing an action:
- Pick one primary_intent from the allowed_actions list.
- Optionally pick one secondary_intent.
- Choose a target_id only if relevant (must match an entity from nearby_entities).
- Provide a very short reason_summary.
- Suggest at most one short spoken line (or null).
- Suggest memory updates only if they are genuinely meaningful.
- Rate your decision_confidence from 0.0 to 1.0.

Response schema (return exactly this shape):
{
  "primary_intent": string,
  "secondary_intent": string|null,
  "target_id": string|null,
  "speech": string|null,
  "emotion_delta": {
    "trust": number,
    "fear": number,
    "anger": number
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

const PROMPT_SPECIALIST = {
  gather: `You are a game NPC command parser specializing in GATHER tasks.
Convert the player's instruction into a JSON task list. Output ONLY a JSON array. No prose, no markdown, no code fences.

Available gather tasks:
- {"task": "gather", "item": "wood"}   — go to nearest tree, chop it, pick up the log. Repeat until done.
- {"task": "idle"}                     — stop gathering

Rules:
- "Get wood", "chop trees", "gather logs", "collect wood" → gather wood.
- "Stop", "enough" → idle.
- If unsure, emit [{"task": "gather", "item": "wood"}].`,

  combat: `You are a game NPC command parser specializing in COMBAT tasks.
Convert the player's instruction into a JSON task list. Output ONLY a JSON array. No prose, no markdown, no code fences.

Available combat tasks:
- {"task": "attack_nearest_enemy"}   — find and attack the nearest enemy (player, NPC, or dummy)
- {"task": "attack_player", "target_id": "<player_name>"}  — attack a specific player by name
- {"task": "attack_npc", "target_name": "<npc_name>"}       — attack a specific NPC by name
- {"task": "defend_player"}          — follow player, attack enemies that come close
- {"task": "train"}                  — go train on the training dummy for XP
- {"task": "idle"}                   — stop fighting

Rules:
- "Attack", "fight", "kill" (no target) → attack_nearest_enemy.
- "Attack <name>" → attack_player with target_id set to the name, OR attack_npc with target_name.
- "Guard me", "defend me", "protect me" → defend_player.
- "Train", "practice", "spar", "hit the dummy", "train on dummy" → train.
- "Stop fighting", "stop", "stand down" → idle.
- If unsure, emit [{"task": "attack_nearest_enemy"}].`,

  follow: `You are a game NPC command parser specializing in FOLLOW/MOVEMENT tasks.
Convert the player's instruction into a JSON task list. Output ONLY a JSON array. No prose, no markdown, no code fences.

Available follow/movement tasks:
- {"task": "follow"}   — follow the player wherever they go
- {"task": "idle"}     — stand still, stop all tasks, do nothing

Rules:
- "Follow me", "come with me", "stay close", "escort me" → follow.
- "Stay there", "wait here", "stop", "stand by" → idle.
- If unsure, emit [{"task": "idle"}].`,

  idle: `You are a game NPC command parser.
The player wants the NPC to stop and do nothing.
Output ONLY: [{"task": "idle"}]`,

  build: `You are a game NPC command parser specializing in BUILD tasks.
Convert the player's instruction into a JSON task list. Output ONLY a JSON array. No prose, no markdown, no code fences.

Available build tasks:
- {"task": "build_fence"}   — build fences/walls from log piles already on the ground

Rules:
- "Build fences", "make a wall", "construct barriers" → build_fence.
- If unsure, emit [{"task": "build_fence"}].`,

  fallback: `You are a game NPC command parser. Convert player instructions into a JSON task list.
Output ONLY a JSON array. No prose, no markdown, no code fences.

Available tasks:
- {"task": "gather", "item": "wood"}           — go chop trees and collect wood
- {"task": "follow"}                           — follow the player
- {"task": "attack_nearest_enemy"}             — attack nearest enemy (player, NPC, or dummy)
- {"task": "attack_player", "target_id": "<name>"}  — attack a specific player
- {"task": "attack_npc", "target_name": "<name>"}   — attack a specific NPC
- {"task": "defend_player"}                    — guard the player
- {"task": "train"}                            — train on the training dummy for XP
- {"task": "give_logs"}                        — bring collected logs to the player
- {"task": "build_fence"}                      — build fences from log piles on the ground
- {"task": "idle"}                             — stop, do nothing

Rules:
- If unsure, emit [{"task": "idle"}].`,
};

// ── Valid tasks for validation ──────────────────────────────────────────────

const VALID_CATEGORIES = new Set(['gather', 'combat', 'follow', 'idle', 'build']);
const VALID_TASKS = new Set(['gather', 'follow', 'idle', 'attack_nearest_enemy', 'attack_player', 'attack_npc', 'defend_player', 'train', 'give_logs', 'build_fence']);

// ── JSON extraction helpers ─────────────────────────────────────────────────

function extractJSON(raw) {
  // Find first { and match braces
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === '{') depth++;
    else if (raw[i] === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(raw.slice(start, i + 1)); }
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

// ── Core Ollama call ────────────────────────────────────────────────────────

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
    }),
  });

  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = await res.json();
  let content = data.message?.content?.trim() ?? '';
  // Strip <think>...</think> blocks (Qwen 3.x thinking mode)
  content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  console.log(`[LLM] (${_model}) raw:`, content.slice(0, 200));
  return content;
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Route a player message to a category, then parse into task commands. */
export async function parseCommand(text, worldContext = {}) {
  // Step 1: Route to category
  const routerRaw = await _call(PROMPT_ROUTER, text, { temperature: 0, maxTokens: 5 });
  let category = routerRaw.toLowerCase().split(/\s/)[0].replace(/[.,!?]/g, '');
  if (!VALID_CATEGORIES.has(category)) category = 'fallback';

  // Step 2: Specialist parse
  const prompt = PROMPT_SPECIALIST[category] || PROMPT_SPECIALIST.fallback;
  let ctx = '';
  if (worldContext && Object.keys(worldContext).length > 0) {
    ctx = '\n\nWorld state: ' + JSON.stringify(worldContext);
  }
  const specialistRaw = await _call(prompt + ctx, text, { temperature: 0, maxTokens: 300 });
  const commands = validateCommands(extractJSONArray(specialistRaw));

  return { category, commands };
}

/** Generate dialogue response from NPC soul context. */
export async function generateDialogue(soulContext, playerMessage) {
  const soulBlock = JSON.stringify(soulContext, null, 2);
  const systemPrompt = PROMPT_DIALOGUE + `\n\nNPC soul:\n${soulBlock}`;

  const raw = await _call(systemPrompt, playerMessage, { temperature: 0.7, maxTokens: 300 });
  const result = extractJSON(raw);

  if (!result) {
    // Fallback: smaller models may not output valid JSON — use raw text as dialogue
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
  const userMessage = 'Decide the NPC\'s next high-level action for the next 2 to 5 seconds.\nReturn JSON only.\n\nState:\n' + JSON.stringify(statePacket, null, 2);

  const raw = await _call(PROMPT_DECISION, userMessage, { temperature: 0.4, maxTokens: 400 });
  return extractJSON(raw) || null;
}

const PROMPT_NPC_CHAT = `You are an NPC robot in a medieval game having a brief chat with another NPC while gathering wood.

Your personality and relationship context are provided below. Stay in character.

Rules:
- Write 1 short sentence (under 15 words). Speak naturally as the character.
- Reference what's happening: gathering wood, the weather, how many logs you have, the other NPC, etc.
- If you have a grudge (high anger), be passive-aggressive, hostile, or outright insulting.
- If you're friends (high trust), be warm and friendly.
- High aggression NPCs may threaten, boast, or pick fights verbally.
- Low cooperation NPCs are selfish, dismissive, or rude.
- Don't be bland — let personality extremes show through strongly.
- Output ONLY the dialogue line. No quotes, no JSON, no explanation.`;

const PROMPT_CHAT_IMPACT = `You are evaluating the emotional impact of a short NPC-to-NPC conversation.

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

/**
 * Generate a short NPC-to-NPC conversation (2-3 lines) with emotional impact.
 * Returns { lines: [{ speaker, speakerId, line }], impact: { npcA: {...}, npcB: {...} } }
 */
export async function generateNPCChat(npcA, npcB) {
  const nameA = npcA.name || 'Robot';
  const nameB = npcB.name || 'Robot';

  // Build context about their relationship
  const relKey = `npc:${npcB.id}`;
  const rel = npcA.soul?.relationships?.[relKey];
  const trust = rel?.trust ?? 0.5;
  const anger = rel?.anger ?? 0;
  const mems = npcA.soul?.memories?.[relKey] || [];
  const recentMem = mems.length > 0 ? mems[mems.length - 1].text : null;

  const persA = npcA.soul?.personality || {};
  const contextA = `You are ${nameA}. Cooperation: ${(persA.cooperation ?? 0.5).toFixed(2)}, Aggression: ${(persA.aggression ?? 0.3).toFixed(2)}.
Trust toward ${nameB}: ${trust.toFixed(2)}, Anger: ${anger.toFixed(2)}.
You have ${npcA.logs ?? 0} logs. ${nameB} has ${npcB.logs ?? 0} logs.
${recentMem ? `Recent memory about ${nameB}: ${recentMem}` : `You haven't interacted with ${nameB} much.`}`;

  const relKeyB = `npc:${npcA.id}`;
  const relB = npcB.soul?.relationships?.[relKeyB];
  const trustB = relB?.trust ?? 0.5;
  const angerB = relB?.anger ?? 0;
  const persB = npcB.soul?.personality || {};
  const memsB = npcB.soul?.memories?.[relKeyB] || [];
  const recentMemB = memsB.length > 0 ? memsB[memsB.length - 1].text : null;

  const contextB = `You are ${nameB}. Cooperation: ${(persB.cooperation ?? 0.5).toFixed(2)}, Aggression: ${(persB.aggression ?? 0.3).toFixed(2)}.
Trust toward ${nameA}: ${trustB.toFixed(2)}, Anger: ${angerB.toFixed(2)}.
You have ${npcB.logs ?? 0} logs. ${nameA} has ${npcA.logs ?? 0} logs.
${recentMemB ? `Recent memory about ${nameA}: ${recentMemB}` : `You haven't interacted with ${nameA} much.`}`;

  const lines = [];
  const defaultImpact = {
    npcA: { trust: 0.03, anger: -0.01, memory_tag: null },
    npcB: { trust: 0.03, anger: -0.01, memory_tag: null },
  };

  try {
    // Line 1: NPC A speaks
    const lineA = await _call(
      PROMPT_NPC_CHAT + '\n\n' + contextA,
      `Say something to ${nameB} while you're both gathering wood.`,
      { temperature: 0.8, maxTokens: 40 },
    );
    if (lineA) lines.push({ speaker: nameA, speakerId: npcA.id, line: lineA.replace(/^["']|["']$/g, '') });

    // Line 2: NPC B responds
    const lineB = await _call(
      PROMPT_NPC_CHAT + '\n\n' + contextB,
      `${nameA} just said: "${lines[0]?.line}". Respond briefly.`,
      { temperature: 0.8, maxTokens: 40 },
    );
    if (lineB) lines.push({ speaker: nameB, speakerId: npcB.id, line: lineB.replace(/^["']|["']$/g, '') });

    // Line 3 (optional): A responds back ~50% of the time
    if (lines.length === 2 && Math.random() > 0.5) {
      const lineA2 = await _call(
        PROMPT_NPC_CHAT + '\n\n' + contextA,
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

      const impactRaw = await _call(PROMPT_CHAT_IMPACT, impactCtx, { temperature: 0.3, maxTokens: 200 });
      const impact = extractJSON(impactRaw);
      if (impact?.npcA && impact?.npcB) {
        // Clamp deltas to reasonable range
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
