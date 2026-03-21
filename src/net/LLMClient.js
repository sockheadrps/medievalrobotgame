// LLMClient — talks to the player's local Ollama instance for all LLM calls.
// Prompts are fetched from /api/prompts/{name} — no inline prompt building here.
// PERSONALITY_TYPES metadata lives in NPCPersonality.js — import from there.

import { API_BASE } from '../config.js';
import {
  VALID_CATEGORIES,
  cleanResponse, extractJSON, extractPartialDecisionJSON,
  extractJSONArray, validateCommands, sanitizeDecision,
  processDialogueResult, formatPhrases, extractNPCPairContext,
  runNPCChatExchange,
} from './LLMUtils.js';

const LLM_CHAT_URL = `${API_BASE}/llm/chat/completions`;
const LLM_MODELS_URL = `${API_BASE}/llm/models`;
let _model = 'tinyllama:latest';

export function setModel(name) { _model = name; }
export function setNumCtx(n) { /* reserved for future use */ }
export function getModel() { return _model; }

/** Fetch available models from the aux server proxy. Returns array of model name strings. */
export async function fetchModels() {
  try {
    const res = await fetch(LLM_MODELS_URL);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || []).map(m => m.id || m.name).filter(Boolean);
  } catch {
    return [];
  }
}

const _promptCache = {};

/** Fetch a rendered prompt template from the server. Results are cached by name+params. */
export async function fetchPrompt(name, params = {}) {
  const key = name + JSON.stringify(params);
  if (!_promptCache[key]) {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`/api/prompts/${name}?${qs}`);
    const { prompt } = await res.json();
    _promptCache[key] = prompt;
  }
  return _promptCache[key];
}

// ── Core Ollama calls ───────────────────────────────────────────────────────
async function _llmFetch(messages, opts = {}) {
  const { temperature = 0.7, maxTokens = 300 } = opts;
  const res = await fetch(LLM_CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: _model, messages, stream: false, temperature, max_tokens: maxTokens }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const data = await res.json();
  return cleanResponse(data?.choices?.[0]?.message?.content?.trim() ?? '', _model);
}

async function _call(systemPrompt, userMessage, opts = {}) {
  return _llmFetch([{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }], opts);
}

/** Multi-turn call with conversation history */
async function _callWithHistory(systemPrompt, chatHistory, userMessage, opts = {}) {
  const messages = [{ role: 'system', content: systemPrompt }];
  for (const turn of chatHistory.slice(0, -1)) {
    messages.push({ role: turn.role === 'player' ? 'user' : 'assistant', content: turn.text });
  }
  messages.push({ role: 'user', content: userMessage });
  return _llmFetch(messages, opts);
}

/** Public transport wrapper — sends a single prompt string to the LLM and returns the raw response. */
export async function generate(prompt, model) {
  const prev = _model;
  if (model) _model = model;
  try {
    return await _call(prompt, '');
  } finally {
    if (model) _model = prev;
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Route a player message to a category, then parse into task commands. */
export async function parseCommand(text, worldContext = {}) {
  const routerPrompt = await fetchPrompt('command_router');
  const routerRaw = await _call(routerPrompt, text, { temperature: 0, maxTokens: 5 });
  let category = routerRaw.toLowerCase().split(/\s/)[0].replace(/[.,!?]/g, '');
  if (!VALID_CATEGORIES.has(category)) category = 'fallback';

  if (category === 'chat') return { category, commands: [{ task: 'idle' }] };

  const specialistPrompt = await fetchPrompt(`command_${category}`);
  let ctx = '';
  if (worldContext && Object.keys(worldContext).length > 0) {
    ctx = '\n\nWorld state: ' + JSON.stringify(worldContext);
  }
  const specialistRaw = await _call(specialistPrompt + ctx, text, { temperature: 0, maxTokens: 300 });
  const commands = validateCommands(extractJSONArray(specialistRaw));
  return { category, commands };
}

/** Generate dialogue response from NPC soul context. opts: { speakingPlayer, owner, chatHistory } */
export async function generateDialogue(soulContext, playerMessage, opts = {}) {
  const { speakingPlayer = '', owner = '', chatHistory = [] } = opts;
  const systemPrompt = await fetchPrompt('dialogue', {
    npc_name: soulContext.name,
    personality_type: soulContext.personality?.type,
    emotion: JSON.stringify(soulContext.emotional_state),
    memory_summary: (soulContext.memories || []).join('; '),
    speaking_player: speakingPlayer,
    owner,
    soul_json: JSON.stringify(soulContext),
  });

  const raw = chatHistory.length > 2
    ? await _callWithHistory(systemPrompt, chatHistory, playerMessage, { temperature: 0.7, maxTokens: 300 })
    : await _call(systemPrompt, playerMessage, { temperature: 0.7, maxTokens: 300 });
  return processDialogueResult(extractJSON(raw), raw);
}

/** Generate a high-level NPC decision from a state packet. */
export async function generateDecision(statePacket) {
  const systemPrompt = await fetchPrompt('decision', {
    personality_type: statePacket.npc?.personality?.type,
    state_json: JSON.stringify(statePacket),
  });
  const userMessage = 'Decide the NPC\'s next high-level action for the next 2 to 5 seconds.\nReturn JSON only.\n\nState:\n' + JSON.stringify(statePacket);
  const raw = await _call(systemPrompt, userMessage, { temperature: 0.4, maxTokens: 1024 });
  return sanitizeDecision(extractJSON(raw) || extractPartialDecisionJSON(raw), statePacket);
}

/** Generate a short NPC-to-NPC conversation (2-3 lines) with emotional impact. */
export async function generateNPCChat(npcA, npcB) {
  const { nameA, nameB, trust, anger, recentMem, trustB, angerB, recentMemB, persA, persB } = extractNPCPairContext(npcA, npcB);
  const [chatPromptA, chatPromptB, impactPrompt] = await Promise.all([
    fetchPrompt('npc_chat', { name: nameA, target_name: nameB, personality_json: JSON.stringify(persA), trust: trust.toFixed(2), anger: anger.toFixed(2), logs: npcA.logs ?? 0, target_logs: npcB.logs ?? 0, recent_memory: recentMem, phrases: formatPhrases(npcA.soul?.learned_phrases).join(', ') }),
    fetchPrompt('npc_chat', { name: nameB, target_name: nameA, personality_json: JSON.stringify(persB), trust: trustB.toFixed(2), anger: angerB.toFixed(2), logs: npcB.logs ?? 0, target_logs: npcA.logs ?? 0, recent_memory: recentMemB, phrases: formatPhrases(npcB.soul?.learned_phrases).join(', ') }),
    fetchPrompt('npc_chat_impact'),
  ]);
  return runNPCChatExchange(_call, npcA, npcB, chatPromptA, chatPromptB, impactPrompt);
}

/** Check if Ollama is reachable. */
export async function checkConnection() {
  try {
    const res = await fetch(LLM_MODELS_URL, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}
