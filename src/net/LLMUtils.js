/**
 * LLMUtils — JSON parsing and validation helpers for LLM responses.
 * Exported as named functions; no class needed.
 */

// ── Valid tasks for validation ──────────────────────────────────────────────

export const VALID_CATEGORIES = new Set(['gather', 'combat', 'follow', 'idle', 'build', 'chat']);
export const VALID_TASKS = new Set(['gather', 'gather_stone', 'gather_all', 'follow', 'idle', 'attack_nearest_enemy', 'attack_player', 'attack_npc', 'absorb_npc', 'defend_player', 'train', 'give_logs']);

// ── String cleaning ─────────────────────────────────────────────────────────

/** Strip vocabulary tags like (insult), (calling_others), (friendly) from text */
export function stripVocabTags(str) {
  return str.replace(/\s*\((?:calling_others|insult|friendly)\)/gi, '').trim();
}

/** Strip <think>...</think> blocks and markdown fences from LLM output. */
export function cleanResponse(content, modelName = '') {
  if (content.includes('<think>')) {
    const thinkLen = content.length;
    content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    if (!content) console.warn(`[LLM] Model produced ${thinkLen} chars of <think> but no answer`);
  }
  content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  return content;
}

// ── JSON extraction ─────────────────────────────────────────────────────────

export function extractJSON(raw) {
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

export function extractPartialDecisionJSON(raw) {
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

export function extractJSONArray(raw) {
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

// ── Validation ──────────────────────────────────────────────────────────────

export function validateCommands(raw) {
  const out = [];
  for (const cmd of raw) {
    if (!cmd || typeof cmd !== 'object') continue;
    if (!VALID_TASKS.has(cmd.task)) continue;
    out.push(cmd);
  }
  return out.length > 0 ? out : [{ task: 'idle' }];
}

// ── Dialogue post-processing ────────────────────────────────────────────────

/**
 * Process a raw LLM dialogue result into a normalised response object.
 * Handles fallback when JSON extraction fails and clamps emotion deltas.
 */
export function processDialogueResult(result, raw) {
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

// ── NPC Chat helpers ────────────────────────────────────────────────────────

/** Format learned phrases for prompt context (top 6 by use-count). */
export function formatPhrases(arr) {
  return (arr || [])
    .slice().sort((a, b) => b.uses - a.uses).slice(0, 6)
    .map(p => {
      const tags = [];
      if (p.usage && p.usage !== 'catchphrase') tags.push(p.usage);
      if (p.tone && p.tone !== 'neutral') tags.push(p.tone);
      return tags.length > 0 ? `${p.phrase} (${tags.join(', ')})` : p.phrase;
    });
}

/**
 * Extract relationship values for both sides of an NPC pair.
 * Returns { nameA, nameB, trust, anger, recentMem, trustB, angerB, recentMemB, persA, persB }
 */
export function extractNPCPairContext(npcA, npcB) {
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
  return { nameA, nameB, trust, anger, recentMem, trustB, angerB, recentMemB, persA, persB };
}

/** Build the impact-scoring context string from an NPC conversation. */
export function buildImpactContext(ctx, lines) {
  const { nameA, nameB, persA, persB, trust, anger, trustB, angerB } = ctx;
  const transcript = lines.map(l => `${l.speaker}: ${l.line}`).join('\n');
  return `NPC A (${nameA}): cooperation=${(persA.cooperation ?? 0.5).toFixed(2)}, aggression=${(persA.aggression ?? 0.3).toFixed(2)}, current trust toward B=${trust.toFixed(2)}, anger=${anger.toFixed(2)}\nNPC B (${nameB}): cooperation=${(persB.cooperation ?? 0.5).toFixed(2)}, aggression=${(persB.aggression ?? 0.3).toFixed(2)}, current trust toward A=${trustB.toFixed(2)}, anger=${angerB.toFixed(2)}\n\nConversation:\n${transcript}`;
}

/**
 * Run the sequential NPC-to-NPC chat exchange and score emotional impact.
 * callFn is _call from LLMClient, passed in to keep transport out of utils.
 */
export async function runNPCChatExchange(callFn, npcA, npcB, chatPromptA, chatPromptB, impactPrompt) {
  const ctx = extractNPCPairContext(npcA, npcB);
  const { nameA, nameB } = ctx;
  const lines = [];
  const defaultImpact = {
    npcA: { trust: 0.03, anger: -0.01, memory_tag: null },
    npcB: { trust: 0.03, anger: -0.01, memory_tag: null },
  };

  try {
    const lineA = await callFn(chatPromptA, `Say something to ${nameB} while you're both gathering wood.`, { temperature: 0.8, maxTokens: 40 });
    if (lineA) lines.push({ speaker: nameA, speakerId: npcA.id, line: lineA.replace(/^["']|["']$/g, '') });

    const lineB = await callFn(chatPromptB, `${nameA} just said: "${lines[0]?.line}". Respond briefly.`, { temperature: 0.8, maxTokens: 40 });
    if (lineB) lines.push({ speaker: nameB, speakerId: npcB.id, line: lineB.replace(/^["']|["']$/g, '') });

    if (lines.length === 2 && Math.random() > 0.5) {
      const lineA2 = await callFn(chatPromptA, `${nameB} replied: "${lines[1]?.line}". Say one last thing and get back to work.`, { temperature: 0.8, maxTokens: 30 });
      if (lineA2) lines.push({ speaker: nameA, speakerId: npcA.id, line: lineA2.replace(/^["']|["']$/g, '') });
    }

    if (lines.length >= 2) {
      const impactRaw = await callFn(impactPrompt, buildImpactContext(ctx, lines), { temperature: 0.3, maxTokens: 200 });
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

export function sanitizeDecision(raw, statePacket) {
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
