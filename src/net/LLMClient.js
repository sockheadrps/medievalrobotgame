// LLMClient — talks to the player's local Ollama instance for LLM calls,
// and to the auxserver for server-rendered prompt templates.
// Prompts are built server-side using the template renderer + personality types.

import { OLLAMA_URL as OLLAMA_BASE, API_BASE } from '../config.js';

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

// ── Fallback prompts (used when server is unreachable) ─────────────────────
// These are minimal versions — the server templates are much richer.

const FALLBACK_PROMPTS = {
  router: `Classify the player's message into exactly one category.
Categories: gather, build, combat, follow, idle, chat
Only use "combat" for DIRECT commands to fight/attack/defend (e.g. "attack him", "go fight B1"). Opinions, insults, questions, or comments ABOUT someone are "chat", NOT "combat".
Output ONLY the category name. Nothing else.`,

  dialogue: `You are a robot NPC in a medieval-themed game.
Keep dialogue concise - 1-3 sentences max. Speak as the NPC directly.
Respond ONLY with JSON: {"dialogue": "...", "emotion_deltas": {"trust": 0.0, "fear": 0.0, "anger": 0.0}, "memory_tag": "..."}`,

  decision: `You are the decision layer for an NPC teammate. Decide the NPC's immediate intent.
Do not invent actions outside the allowed_actions list.
Return valid JSON only: {"primary_intent": "", "secondary_intent": null, "target_id": null, "speech": null, "emotion_delta": {"trust": 0, "fear": 0, "anger": 0}, "memory_candidates": [], "reason_summary": "", "decision_confidence": 0.5}`,

  npc_chat: `You are an NPC robot having a brief chat with another NPC while gathering wood.
Write 1 short sentence (under 15 words). Output ONLY the dialogue line.`,

  chat_impact: `Evaluate the emotional impact of an NPC-to-NPC conversation.
Respond ONLY with JSON: {"npcA": {"trust": 0.0, "anger": 0.0, "memory_tag": "..."}, "npcB": {"trust": 0.0, "anger": 0.0, "memory_tag": "..."}}`,

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
Available tasks: gather, follow, attack_nearest_enemy, defend_player, train, give_logs, build_fence, idle`,
};

// ── Server prompt cache ─────────────────────────────────────────────────────
// Command prompts (router, specialists) are static — cache them once.
let _commandPromptCache = null;
let _commandPromptFetchPromise = null;

async function _fetchCommandPrompts() {
  if (_commandPromptCache) return _commandPromptCache;
  if (_commandPromptFetchPromise) return _commandPromptFetchPromise;

  _commandPromptFetchPromise = (async () => {
    try {
      const res = await fetch(`${API_BASE}/build_command_prompts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: 'router', context: {} }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.prompts) {
        _commandPromptCache = data.prompts;
        console.log('[LLM] Loaded server command prompts');
        return _commandPromptCache;
      }
    } catch (e) {
      console.warn('[LLM] Failed to fetch server command prompts, using fallbacks:', e.message);
    }
    _commandPromptFetchPromise = null;
    return null;
  })();

  return _commandPromptFetchPromise;
}

function _getCommandPrompt(category) {
  if (_commandPromptCache?.[category]) return _commandPromptCache[category];
  return FALLBACK_PROMPTS[category] || FALLBACK_PROMPTS.fallback;
}

// ── Server prompt rendering for dialogue/decision ──────────────────────────

async function _fetchDialoguePrompt(soulContext, speakingPlayer, owner) {
  try {
    const res = await fetch(`${API_BASE}/build_dialogue_prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: soulContext.name || 'NPC',
        personality: soulContext.personality || {},
        emotional_state: soulContext.emotional_state || {},
        relationship: soulContext.relationship || 'neutral',
        memories: soulContext.memories || [],
        learned_phrases: soulContext.learned_phrases || [],
        nearby_entities: soulContext.nearby_entities || [],
        system_note: soulContext.system_note || '',
        topic_entity: soulContext.topic_entity || {},
        speaking_player: speakingPlayer || '',
        owner: owner || '',
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.prompt) return data.prompt;
  } catch (e) {
    console.warn('[LLM] Failed to fetch dialogue prompt from server:', e.message);
  }
  return null;
}

async function _fetchDecisionPrompt(statePacket) {
  try {
    const res = await fetch(`${API_BASE}/build_decision_prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: statePacket }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.prompt) return data.prompt;
  } catch (e) {
    console.warn('[LLM] Failed to fetch decision prompt from server:', e.message);
  }
  return null;
}

async function _fetchNPCChatPrompts(npcCtx) {
  try {
    const res = await fetch(`${API_BASE}/build_npc_chat_prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(npcCtx),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.chat_prompt) return data;
  } catch (e) {
    console.warn('[LLM] Failed to fetch NPC chat prompt from server:', e.message);
  }
  return null;
}

// ── Valid tasks for validation ──────────────────────────────────────────────

const VALID_CATEGORIES = new Set(['gather', 'combat', 'follow', 'idle', 'build', 'chat']);
const VALID_TASKS = new Set(['gather', 'follow', 'idle', 'attack_nearest_enemy', 'attack_player', 'attack_npc', 'defend_player', 'train', 'give_logs', 'build_fence']);

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
      think: false,
    }),
  });

  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = await res.json();
  let content = data.message?.content?.trim() ?? '';
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

// ── Public API ──────────────────────────────────────────────────────────────

/** Route a player message to a category, then parse into task commands. */
export async function parseCommand(text, worldContext = {}) {
  // Pre-fetch command prompts from server (non-blocking, cached after first call)
  await _fetchCommandPrompts();

  // Step 1: Route to category
  const routerPrompt = _getCommandPrompt('router');
  const routerRaw = await _call(routerPrompt, text, { temperature: 0, maxTokens: 5 });
  let category = routerRaw.toLowerCase().split(/\s/)[0].replace(/[.,!?]/g, '');
  if (!VALID_CATEGORIES.has(category)) category = 'fallback';

  // Chat category → skip specialist, fall through to dialogue
  if (category === 'chat') {
    return { category, commands: [{ task: 'idle' }] };
  }

  // Step 2: Specialist parse
  const prompt = _getCommandPrompt(category);
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
 * @param {object} soulContext - { name, personality, emotional_state, relationship, memories }
 * @param {string} playerMessage
 * @param {object} opts - { speakingPlayer, owner }
 */
export async function generateDialogue(soulContext, playerMessage, opts = {}) {
  const { speakingPlayer = '', owner = '' } = opts;

  // Try server-rendered prompt first (includes personality types, ownership logic, etc.)
  let systemPrompt = await _fetchDialoguePrompt(soulContext, speakingPlayer, owner);

  if (!systemPrompt) {
    // Fallback: use minimal prompt with soul block injection
    const soulBlock = JSON.stringify(soulContext, null, 2);
    systemPrompt = FALLBACK_PROMPTS.dialogue + `\n\nNPC soul:\n${soulBlock}`;
  }

  const raw = await _call(systemPrompt, playerMessage, { temperature: 0.7, maxTokens: 300 });
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
  // Try server-rendered prompt first (includes personality type context)
  let systemPrompt = await _fetchDecisionPrompt(statePacket);

  if (!systemPrompt) {
    systemPrompt = FALLBACK_PROMPTS.decision;
  }

  const userMessage = 'Decide the NPC\'s next high-level action for the next 2 to 5 seconds.\nReturn JSON only.\n\nState:\n' + JSON.stringify(statePacket);

  const raw = await _call(systemPrompt, userMessage, { temperature: 0.4, maxTokens: 1024 });
  return extractJSON(raw) || null;
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

  // Fetch server-rendered prompts for NPC A
  const serverA = await _fetchNPCChatPrompts({
    name: nameA,
    personality: persA,
    trust, anger,
    logs: npcA.logs ?? 0,
    target_name: nameB,
    target_logs: npcB.logs ?? 0,
    recent_memory: recentMem,
    learned_phrases: phrasesA,
  });

  // Fetch server-rendered prompts for NPC B
  const serverB = await _fetchNPCChatPrompts({
    name: nameB,
    personality: persB,
    trust: trustB, anger: angerB,
    logs: npcB.logs ?? 0,
    target_name: nameA,
    target_logs: npcA.logs ?? 0,
    recent_memory: recentMemB,
    learned_phrases: phrasesB,
  });

  const chatPromptA = serverA?.chat_prompt || (FALLBACK_PROMPTS.npc_chat + `\n\nYou are ${nameA}.`);
  const chatPromptB = serverB?.chat_prompt || (FALLBACK_PROMPTS.npc_chat + `\n\nYou are ${nameB}.`);
  const impactPrompt = serverA?.impact_prompt || FALLBACK_PROMPTS.chat_impact;

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

      const impactRaw = await _call(impactPrompt, impactCtx, { temperature: 0.3, maxTokens: 200 });
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
