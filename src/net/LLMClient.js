// LLMClient — talks to the player's local Ollama instance for all LLM calls.
// Prompts are fetched from /api/prompts/{name} — no inline prompt building here.
// PERSONALITY_TYPES metadata lives in NPCPersonality.js — import from there.

import { API_BASE } from '../config.js';

const LLM_CHAT_URL = `${API_BASE}/llm/chat/completions`;
const LLM_MODELS_URL = `${API_BASE}/llm/models`;
let _model = 'tinyllama:latest';
let _numCtx = 4096;

/** Set the Ollama model to use for all LLM calls. */
export function setModel(name) { _model = name; }

/** Set the context window size for Ollama. */
export function setNumCtx(n) { _numCtx = n; }

/** Get the current model name. */
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

/** Fetch a rendered prompt template from the server. Results are cached by name+params. */
export async function fetchPrompt(name, params = {}) {
  this._promptCache ??= {};
  const key = name + JSON.stringify(params);
  if (!this._promptCache[key]) {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`/api/prompts/${name}?${qs}`);
    const { prompt } = await res.json();
    this._promptCache[key] = prompt;
  }
  return this._promptCache[key];
}

// ── Valid tasks for validation ──────────────────────────────────────────────

const VALID_CATEGORIES = new Set(['gather', 'combat', 'follow', 'idle', 'build', 'chat']);
const VALID_TASKS = new Set(['gather', 'gather_stone', 'gather_all', 'follow', 'idle', 'attack_nearest_enemy', 'attack_player', 'attack_npc', 'absorb_npc', 'defend_player', 'train', 'give_logs']);

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

function _extractQuotedStringField(raw, field) {
  const match = raw.match(new RegExp(`"${field}"\\s*:\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"`, 'i'));
  if (!match) return undefined;
  try { return JSON.parse(`"${match[1]}"`); } catch { return match[1]; }
}

function _extractNullableStringField(raw, field) {
  const nullMatch = raw.match(new RegExp(`"${field}"\\s*:\\s*null`, 'i'));
  if (nullMatch) return null;
  return _extractQuotedStringField(raw, field);
}

function _extractNumberField(raw, field) {
  const match = raw.match(new RegExp(`"${field}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`, 'i'));
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function extractPartialDecisionJSON(raw) {
  if (!raw || typeof raw !== 'string' || !raw.includes('{')) return null;
  const out = {};
  const primary = _extractQuotedStringField(raw, 'primary_intent');
  if (primary) out.primary_intent = primary;
  const secondary = _extractNullableStringField(raw, 'secondary_intent');
  if (secondary !== undefined) out.secondary_intent = secondary;
  const targetId = _extractNullableStringField(raw, 'target_id');
  if (targetId !== undefined) out.target_id = targetId;
  const speech = _extractNullableStringField(raw, 'speech');
  if (speech !== undefined) out.speech = typeof speech === 'string' ? stripVocabTags(speech) : speech;
  const reason = _extractNullableStringField(raw, 'reason_summary');
  if (reason !== undefined) out.reason_summary = reason;
  const confidence = _extractNumberField(raw, 'decision_confidence');
  if (confidence !== undefined) out.decision_confidence = confidence;
  const emotion = {};
  for (const key of ['trust', 'fear', 'anger']) {
    const value = _extractNumberField(raw, key);
    if (value !== undefined) emotion[key] = value;
  }
  if (Object.keys(emotion).length > 0) out.emotion_delta = emotion;
  return Object.keys(out).length > 0 ? out : null;
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
  if (content.includes('<think>')) {
    const thinkLen = content.length;
    content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    if (!content) console.warn(`[LLM] Model produced ${thinkLen} chars of <think> but no answer`);
  }
  content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  console.log(`[LLM] (${_model}) raw:`, content.slice(0, 200));
  return content;
}

async function _call(systemPrompt, userMessage, opts = {}) {
  const { temperature = 0.7, maxTokens = 300 } = opts;
  const res = await fetch(LLM_CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: _model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMessage },
      ],
      stream: false,
      temperature,
      max_tokens: maxTokens,
    }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const data = await res.json();
  return _cleanResponse(data?.choices?.[0]?.message?.content?.trim() ?? '');
}

/** Multi-turn call with conversation history */
async function _callWithHistory(systemPrompt, chatHistory, userMessage, opts = {}) {
  const { temperature = 0.7, maxTokens = 300 } = opts;
  const messages = [{ role: 'system', content: systemPrompt }];
  for (const turn of chatHistory.slice(0, -1)) {
    messages.push({ role: turn.role === 'player' ? 'user' : 'assistant', content: turn.text });
  }
  messages.push({ role: 'user', content: userMessage });
  const res = await fetch(LLM_CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: _model, messages, stream: false, temperature, max_tokens: maxTokens }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const data = await res.json();
  return _cleanResponse(data?.choices?.[0]?.message?.content?.trim() ?? '');
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

/**
 * Generate dialogue response from NPC soul context.
 * @param {object} soulContext - { name, personality, emotional_state, relationship, memories, learned_phrases, nearby_entities, topic_entity, system_note }
 * @param {string} playerMessage
 * @param {object} opts - { speakingPlayer, owner, chatHistory }
 */
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
  const result = extractJSON(raw);

  if (!result) {
    const cleaned = raw.replace(/```[\s\S]*?```/g, '').replace(/[{}"]/g, '').trim();
    const fallbackText = cleaned.length > 2 && cleaned.length < 300 ? cleaned : null;
    return { dialogue: fallbackText || '...', emotion_deltas: { trust: 0, fear: 0, anger: 0 } };
  }

  const deltas = result.emotion_deltas || {};
  const clamped = {};
  for (const key of ['trust', 'fear', 'anger']) {
    const v = Number(deltas[key]);
    clamped[key] = isNaN(v) ? 0 : Math.max(-0.4, Math.min(0.4, v));
  }
  return { dialogue: result.dialogue || '...', emotion_deltas: clamped, memory_tag: result.memory_tag || null };
}

/** Generate a high-level NPC decision from a state packet. */
export async function generateDecision(statePacket) {
  const systemPrompt = await fetchPrompt('decision', {
    personality_type: statePacket.npc?.personality?.type,
    state_json: JSON.stringify(statePacket),
  });
  const userMessage = 'Decide the NPC\'s next high-level action for the next 2 to 5 seconds.\nReturn JSON only.\n\nState:\n' + JSON.stringify(statePacket);
  const raw = await _call(systemPrompt, userMessage, { temperature: 0.4, maxTokens: 1024 });
  return _sanitizeDecision(extractJSON(raw) || extractPartialDecisionJSON(raw), statePacket);
}

function _sanitizeDecision(raw, statePacket) {
  if (!raw || typeof raw !== 'object') return null;
  const out = { ...raw };
  const allowed = new Set(Array.isArray(statePacket?.allowed_actions) ? statePacket.allowed_actions : []);
  const hasThreats = Array.isArray(statePacket?.nearby_threats) && statePacket.nearby_threats.length > 0;
  if (typeof out.primary_intent !== 'string' || (allowed.size > 0 && !allowed.has(out.primary_intent))) {
    if (allowed.has('wander_explore')) out.primary_intent = 'wander_explore';
    else if (allowed.has('gather_wood')) out.primary_intent = 'gather_wood';
    else if (allowed.has('observe')) out.primary_intent = 'observe';
    else if (allowed.has('follow')) out.primary_intent = 'follow';
    else out.primary_intent = statePacket?.allowed_actions?.[0] ?? 'wander_explore';
  }
  if (typeof out.secondary_intent !== 'string' || (allowed.size > 0 && !allowed.has(out.secondary_intent))) {
    out.secondary_intent = null;
  }
  if (hasThreats) {
    if (out.secondary_intent === 'gather_wood') out.secondary_intent = null;
    if (!['retreat', 'defend_player'].includes(out.primary_intent)) out.secondary_intent = null;
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

  const _formatPhrases = (arr) => (arr || [])
    .slice().sort((a, b) => b.uses - a.uses).slice(0, 6)
    .map(p => {
      const tags = [];
      if (p.usage && p.usage !== 'catchphrase') tags.push(p.usage);
      if (p.tone && p.tone !== 'neutral') tags.push(p.tone);
      return tags.length > 0 ? `${p.phrase} (${tags.join(', ')})` : p.phrase;
    });

  const [chatPromptA, chatPromptB, impactPrompt] = await Promise.all([
    fetchPrompt('npc_chat', { name: nameA, target_name: nameB, personality_json: JSON.stringify(persA), trust: trust.toFixed(2), anger: anger.toFixed(2), logs: npcA.logs ?? 0, target_logs: npcB.logs ?? 0, recent_memory: recentMem, phrases: _formatPhrases(npcA.soul?.learned_phrases).join(', ') }),
    fetchPrompt('npc_chat', { name: nameB, target_name: nameA, personality_json: JSON.stringify(persB), trust: trustB.toFixed(2), anger: angerB.toFixed(2), logs: npcB.logs ?? 0, target_logs: npcA.logs ?? 0, recent_memory: recentMemB, phrases: _formatPhrases(npcB.soul?.learned_phrases).join(', ') }),
    fetchPrompt('npc_chat_impact'),
  ]);

  const lines = [];
  const defaultImpact = {
    npcA: { trust: 0.03, anger: -0.01, memory_tag: null },
    npcB: { trust: 0.03, anger: -0.01, memory_tag: null },
  };

  try {
    const lineA = await _call(chatPromptA, `Say something to ${nameB} while you're both gathering wood.`, { temperature: 0.8, maxTokens: 40 });
    if (lineA) lines.push({ speaker: nameA, speakerId: npcA.id, line: lineA.replace(/^["']|["']$/g, '') });

    const lineB = await _call(chatPromptB, `${nameA} just said: "${lines[0]?.line}". Respond briefly.`, { temperature: 0.8, maxTokens: 40 });
    if (lineB) lines.push({ speaker: nameB, speakerId: npcB.id, line: lineB.replace(/^["']|["']$/g, '') });

    if (lines.length === 2 && Math.random() > 0.5) {
      const lineA2 = await _call(chatPromptA, `${nameB} replied: "${lines[1]?.line}". Say one last thing and get back to work.`, { temperature: 0.8, maxTokens: 30 });
      if (lineA2) lines.push({ speaker: nameA, speakerId: npcA.id, line: lineA2.replace(/^["']|["']$/g, '') });
    }

    if (lines.length >= 2) {
      const transcript = lines.map(l => `${l.speaker}: ${l.line}`).join('\n');
      const impactCtx = `NPC A (${nameA}): cooperation=${(persA.cooperation ?? 0.5).toFixed(2)}, aggression=${(persA.aggression ?? 0.3).toFixed(2)}, current trust toward B=${trust.toFixed(2)}, anger=${anger.toFixed(2)}\nNPC B (${nameB}): cooperation=${(persB.cooperation ?? 0.5).toFixed(2)}, aggression=${(persB.aggression ?? 0.3).toFixed(2)}, current trust toward A=${trustB.toFixed(2)}, anger=${angerB.toFixed(2)}\n\nConversation:\n${transcript}`;
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
    const res = await fetch(LLM_MODELS_URL, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}
