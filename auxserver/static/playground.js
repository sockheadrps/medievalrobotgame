// NPC Soul Playground — standalone LLM testing tool
// Talks directly to Ollama (via /ollama proxy or localhost:11434)

(() => {
'use strict';

// ── Config ────────────────────────────────────────────────────────────────────
const OLLAMA_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://127.0.0.1:11434'
  : `${window.location.protocol}//${window.location.host}/ollama`;

const OLLAMA_CHAT = `${OLLAMA_BASE}/api/chat`;
const OLLAMA_TAGS = `${OLLAMA_BASE}/api/tags`;

let currentModel = 'llama3.2:latest';

// ── Test Lab State ───────────────────────────────────────────────────────────
let activeScenarioLabel = null;
let lastTest = null;
let currentBatchTest = null;
let autoSaveTests = false;
let reportChart = null;
let compareChart = null;

// ── Default Prompts (copied from game) ────────────────────────────────────────
const DEFAULT_PROMPTS = {
  router: `Classify the player's instruction into exactly one category.

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
stop → idle`,

  dialogue: `You are a robot NPC in a medieval-themed game. You were built by the player from logs.

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
{"dialogue": "...", "emotion_deltas": {"trust": 0.0, "fear": 0.0, "anger": 0.0}, "memory_tag": "..."}`,

  decision: `You are the decision layer for an NPC teammate in an online multiplayer game.

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
}`,

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

  npc_chat: `You are an NPC robot in a medieval game having a brief chat with another NPC while gathering wood.

Your personality and relationship context are provided below. Stay in character.

Rules:
- Write 1 short sentence (under 15 words). Speak naturally as the character.
- Reference what's happening: gathering wood, the weather, how many logs you have, the other NPC, etc.
- If you have a grudge (high anger), be passive-aggressive, hostile, or outright insulting.
- If you're friends (high trust), be warm and friendly.
- High aggression NPCs may threaten, boast, or pick fights verbally.
- Low cooperation NPCs are selfish, dismissive, or rude.
- Don't be bland — let personality extremes show through strongly.
- Output ONLY the dialogue line. No quotes, no JSON, no explanation.`,

  chat_impact: `You are evaluating the emotional impact of a short NPC-to-NPC conversation.

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
}`,
};

// Working prompts (editable without touching defaults)
const prompts = { ...DEFAULT_PROMPTS };

// ── NPC State ─────────────────────────────────────────────────────────────────
const state = {
  personality: { cooperation: 0.70, aggression: 0.15, neuroticism: 0.35 },
  trust: 0.70, fear: 0.05, anger: 0.02,
  trust_baseline: 0.50, fear_baseline: 0.00, anger_baseline: 0.00,
  escalation: 1,
  lastInteraction: 0,
  memories: [],
  npcName: 'Rusty',
  playerId: 'player_test',
};

const ESCALATION_MAX = 16;
const ESCALATION_COOLDOWN = 30000;
const DECAY_RATE = 0.02;
const OWNER_DECAY_MULT = 0.2;
const BASELINE_THRESHOLD = 0.9;
const BASELINE_SHIFT = 0.01;
const BASELINE_CAP = 0.85;

// Drift tracking: time (in seconds) each emotion has been above 0.90
const drift = { trust_time: 0, fear_time: 0, anger_time: 0 };

// LLM overrides (read from topbar inputs)
function getLLMTemp() { return parseFloat($('llmTemp')?.value) || 0.7; }
function getLLMMaxTok() { return parseInt($('llmMaxTok')?.value) || 300; }
function getLLMCtx() { return parseInt($('llmCtx')?.value) || 4096; }

let activeTab = 'dialogue';
let decayRunning = false;
let decayInterval = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = (s) => document.getElementById(s);
const $$ = (s) => document.querySelectorAll(s);

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  bindSliders();
  bindTabs();
  bindButtons();
  bindPromptEditor();
  bindScenarios();
  bindReports();
  loadModels();
  loadNpcList();
  checkOllama();
  setInterval(checkOllama, 10000);
  updateGauges();
  updateRelLabel();
});

// ── Ollama ────────────────────────────────────────────────────────────────────
async function checkOllama() {
  try {
    const res = await fetch(OLLAMA_TAGS);
    const ok = res.ok;
    $('ollamaStatus').className = `status-dot ${ok ? 'green' : 'red'}`;
    $('statusText').textContent = ok ? `Ollama: connected (${currentModel})` : 'Ollama: error';
  } catch {
    $('ollamaStatus').className = 'status-dot red';
    $('statusText').textContent = 'Ollama: offline';
  }
}

async function loadModels() {
  try {
    const res = await fetch(OLLAMA_TAGS);
    if (!res.ok) return;
    const data = await res.json();
    const sel = $('modelSelect');
    sel.innerHTML = '';
    for (const m of (data.models || [])) {
      const opt = document.createElement('option');
      opt.value = m.name;
      opt.textContent = `${m.name} (${formatBytes(m.size)})`;
      sel.appendChild(opt);
    }
    if (sel.options.length > 0) {
      currentModel = sel.value;
    }
    sel.onchange = () => {
      currentModel = sel.value;
      $('statusText').textContent = `Ollama: connected (${currentModel})`;
      addChat('system', `Model switched to: ${currentModel}`);
    };
  } catch { /* ignore */ }
}

function formatBytes(bytes) {
  if (!bytes) return '?';
  const gb = bytes / (1024 ** 3);
  return gb >= 1 ? `${gb.toFixed(1)}GB` : `${(bytes / (1024 ** 2)).toFixed(0)}MB`;
}

async function loadNpcList() {
  try {
    const res = await fetch('/npc_list');
    if (!res.ok) return;
    const data = await res.json();
    const sel = $('npcSelect');
    for (const id of (data.npcs || [])) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = id;
      sel.appendChild(opt);
    }
  } catch { /* ignore */ }
}

// ── Core LLM call with metrics ────────────────────────────────────────────────
async function callLLM(systemPrompt, userMessage, opts = {}) {
  const { temperature = getLLMTemp(), maxTokens = getLLMMaxTok() } = opts;
  const ctx = getLLMCtx();
  const t0 = performance.now();

  const body = {
    model: currentModel,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    stream: false,
    options: { temperature, num_predict: maxTokens, num_ctx: ctx },
  };

  const res = await fetch(OLLAMA_CHAT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = await res.json();

  const elapsed = performance.now() - t0;
  let content = data.message?.content?.trim() ?? '';
  // Strip <think>...</think> blocks
  content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  // Collect metrics
  const metrics = {
    elapsed_ms: Math.round(elapsed),
    model: currentModel,
    prompt_tokens: data.prompt_eval_count ?? null,
    completion_tokens: data.eval_count ?? null,
    total_tokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
    tokens_per_sec: data.eval_count && elapsed > 0 ? ((data.eval_count / elapsed) * 1000).toFixed(1) : null,
    system_prompt_len: systemPrompt.length,
    user_msg_len: userMessage.length,
    temperature,
    num_ctx: ctx,
  };

  return { content, metrics };
}

// ── JSON extraction ───────────────────────────────────────────────────────────
function extractJSON(raw) {
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === '{') depth++;
    else if (raw[i] === '}') { depth--; if (depth === 0) { try { return JSON.parse(raw.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

function extractJSONArray(raw) {
  const start = raw.indexOf('[');
  if (start === -1) return [{ task: 'idle' }];
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === '[') depth++;
    else if (raw[i] === ']') { depth--; if (depth === 0) { try { const r = JSON.parse(raw.slice(start, i + 1)); if (Array.isArray(r)) return r; } catch {} break; } }
  }
  return [{ task: 'idle' }];
}

// ── Emotion math ──────────────────────────────────────────────────────────────
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function deriveRelationship() {
  const { trust, anger, fear } = state;
  if (anger > 0.7) return 'hostile';
  if (trust < 0.2 && fear > 0.5) return 'hostile';
  if (trust < 0.25) return 'wary';
  if (anger > 0.4) return 'wary';
  if (trust >= 0.75 && anger < 0.15) return 'devoted';
  if (trust >= 0.5) return 'allied';
  return 'neutral';
}

function applyDeltas(deltas, clampRange = 0.4) {
  const now = Date.now();
  if (now - state.lastInteraction > ESCALATION_COOLDOWN) state.escalation = 1;

  const actual = {};
  for (const key of ['trust', 'fear', 'anger']) {
    const raw = Number(deltas[key]) || 0;
    const clamped = clamp(raw, -clampRange, clampRange);
    const scaled = clamped * state.escalation;
    const before = state[key];
    state[key] = clamp(before + scaled, 0, 1);
    actual[key] = { raw, clamped, scaled, before, after: state[key] };
  }

  state.escalation = Math.min(state.escalation * 2, ESCALATION_MAX);
  state.lastInteraction = now;

  syncSlidersFromState();
  updateGauges();
  updateRelLabel();
  showDeltas(actual);
  showValidation(deltas, clampRange, state.escalation / 2, actual);
  return actual;
}

function decayTick() {
  const rate = DECAY_RATE * OWNER_DECAY_MULT;
  state.trust = decayToward(state.trust, state.trust_baseline, rate);
  state.fear = decayToward(state.fear, state.fear_baseline, rate);
  state.anger = decayToward(state.anger, state.anger_baseline, rate);

  // Track time above threshold for baseline drift
  const tickSec = 2;
  for (const [key, blKey, driftKey] of [['trust','trust_baseline','trust_time'],['fear','fear_baseline','fear_time'],['anger','anger_baseline','anger_time']]) {
    if (state[key] >= BASELINE_THRESHOLD) {
      drift[driftKey] += tickSec;
      // Every 5 seconds above threshold → baseline shifts
      if (drift[driftKey] % 5 < tickSec && drift[driftKey] >= 5) {
        const oldBl = state[blKey];
        state[blKey] = Math.min(BASELINE_CAP, state[blKey] + BASELINE_SHIFT);
        if (state[blKey] !== oldBl) {
          addDriftLog(`${key} baseline shifted: ${oldBl.toFixed(3)} → ${state[blKey].toFixed(3)} (${drift[driftKey]}s above 0.90)`);
        }
      }
    } else {
      drift[driftKey] = 0;
    }
  }

  syncSlidersFromState();
  updateGauges();
  updateRelLabel();
  updateDriftTelemetry();
}

function decayToward(value, baseline, rate) {
  if (value > baseline) return Math.max(baseline, value - rate);
  if (value < baseline) return Math.min(baseline, value + rate);
  return value;
}

function fastForward(seconds) {
  const ticks = Math.floor(seconds / 2); // decay every 2s
  for (let i = 0; i < ticks; i++) decayTick();

  // Memory decay: 0.02 per 60s
  const memTicks = Math.floor(seconds / 60);
  for (let t = 0; t < memTicks; t++) {
    for (const m of state.memories) {
      m.importance = Math.max(0, m.importance - 0.02);
    }
    state.memories = state.memories.filter(m => m.importance > 0.1);
  }

  addChat('system', `Fast-forwarded ${seconds}s (${ticks} decay ticks, ${memTicks} memory decay ticks)`);
  renderMemories();
}

// ── Soul context builder ──────────────────────────────────────────────────────
function buildSoulContext() {
  const now = Date.now();
  const mems = [...state.memories]
    .map(m => {
      const ageSec = (now - m.ts) / 1000;
      const recency = Math.max(0.1, 1 - ageSec / 600);
      return { ...m, weight: m.importance * recency };
    })
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 12)
    .map(m => m.text);

  return {
    name: state.npcName,
    personality: { ...state.personality },
    emotional_state: { trust: state.trust, fear: state.fear, anger: state.anger },
    relationship: deriveRelationship(),
    memories: mems,
  };
}

// ── Test Lab helpers ─────────────────────────────────────────────────────────
function snapshotState() {
  return {
    personality: { ...state.personality },
    emotions: { trust: state.trust, fear: state.fear, anger: state.anger },
    baselines: { trust: state.trust_baseline, fear: state.fear_baseline, anger: state.anger_baseline },
    relationship_label: deriveRelationship(),
    memories: [...state.memories],
  };
}

function buildTestBase(name, mode, scenarioLabel = null) {
  return {
    id: null,
    name: name || 'Untitled Test',
    created_at: new Date().toISOString(),
    mode,
    scenario: scenarioLabel ? { id: scenarioLabel.toLowerCase().replace(/\s+/g, '_'), label: scenarioLabel } : null,
    settings: {
      model: currentModel,
      temperature: getLLMTemp(),
      max_tokens: getLLMMaxTok(),
      context_window: getLLMCtx(),
    },
    initial_state: snapshotState(),
    inputs: [],
    steps: [],
    final_state: null,
    summary: null,
    notes: '',
  };
}

function computeSummary(test) {
  const initial = test.initial_state?.emotions || {};
  const final = test.final_state?.emotions || {};
  const trust_delta = +(final.trust - initial.trust).toFixed(3);
  const fear_delta = +(final.fear - initial.fear).toFixed(3);
  const anger_delta = +(final.anger - initial.anger).toFixed(3);
  const escalation_max = Math.max(0, ...test.steps.map(s => s.escalation || 0));
  const clamp_hits = test.steps.filter(s => s.clamp_hits).length;
  return {
    trust_delta,
    fear_delta,
    anger_delta,
    escalation_max,
    clamp_hits,
    fallbacks: test.fallbacks || 0,
    memory_count: test.final_state?.memories?.length || 0,
  };
}

function finalizeTest(test) {
  test.final_state = snapshotState();
  test.summary = computeSummary(test);
  return test;
}

async function saveTestReport(test) {
  if (!test) return;
  try {
    const res = await fetch('/playground/tests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(test),
    });
    const data = await res.json();
    $('saveStatus').textContent = res.ok ? `Saved (${data.id})` : 'Save failed';
    await loadReportsList();
  } catch (e) {
    $('saveStatus').textContent = `Save error: ${e.message}`;
  }
}

// ── Pipelines ─────────────────────────────────────────────────────────────────

async function runDialogue(text) {
  const soul = buildSoulContext();
  const systemPrompt = prompts.dialogue + `\n\nNPC soul:\n${JSON.stringify(soul, null, 2)}`;
  const isBatch = !!currentBatchTest;
  const test = isBatch ? currentBatchTest : buildTestBase(activeScenarioLabel || 'Dialogue', 'dialogue', activeScenarioLabel);
  test.inputs.push({ type: 'player_message', text });

  addChat('player', text);
  clearTrace();
  addTrace('Dialogue LLM', `temp=${getLLMTemp()}, max_tokens=${getLLMMaxTok()}`, systemPrompt, text);

  try {
    const { content, metrics } = await callLLM(systemPrompt, text, { temperature: getLLMTemp(), maxTokens: getLLMMaxTok() });
    addTraceResult(content, metrics);

    const result = extractJSON(content);
    if (result) {
      addChat('npc', result.dialogue || '...');
      const deltas = result.emotion_deltas || {};
      const actual = applyDeltas(deltas, 0.4);

      if (result.memory_tag) {
        state.memories.push({ text: result.memory_tag, type: 'dialogue', ts: Date.now(), importance: 1.0 });
        renderMemories();
        addTrace('Memory Stored', result.memory_tag);
      }

      const step = {
        step: test.steps.length + 1,
        input: text,
        raw_response: content,
        parsed_response: result,
        clamp_range: 0.4,
        escalation: state.escalation / 2,
        clamped_deltas: {
          trust: actual.trust.clamped,
          fear: actual.fear.clamped,
          anger: actual.anger.clamped,
        },
        scaled_deltas: {
          trust: actual.trust.scaled,
          fear: actual.fear.scaled,
          anger: actual.anger.scaled,
        },
        before: { trust: actual.trust.before, fear: actual.fear.before, anger: actual.anger.before },
        after: { trust: actual.trust.after, fear: actual.fear.after, anger: actual.anger.after },
        memory_stored: result.memory_tag ? [{ text: result.memory_tag, type: 'dialogue', importance: 1.0 }] : [],
        fallback: null,
        latency_ms: metrics?.elapsed_ms,
        tokens: {
          prompt: metrics?.prompt_tokens,
          completion: metrics?.completion_tokens,
          total: metrics?.total_tokens,
        },
        clamp_hits: ['trust','fear','anger'].some(k => Math.abs(actual[k].raw) > 0.4),
      };
      test.steps.push(step);

      addHistory(`Dialogue: "${text}" → "${result.dialogue}"`);
    } else {
      const cleaned = content.replace(/```[\s\S]*?```/g, '').replace(/[{}"]/g, '').trim();
      addChat('npc', cleaned.length > 2 ? cleaned : '...');
      addTrace('Parse Error', 'Could not extract JSON from response');
    }
  } catch (e) {
    addChat('error', `LLM Error: ${e.message}`);
  }

  if (!isBatch) {
    lastTest = finalizeTest(test);
    if (autoSaveTests) await saveTestReport(lastTest);
  }
}

async function runCommand(text) {
  const isBatch = !!currentBatchTest;
  const test = isBatch ? currentBatchTest : buildTestBase(activeScenarioLabel || 'Command', 'command', activeScenarioLabel);
  test.inputs.push({ type: 'player_message', text });

  addChat('player', text);
  clearTrace();

  try {
    // Step 1: Router
    addTrace('Router LLM', 'temp=0, max_tokens=5', prompts.router, text);
    const { content: routerRaw, metrics: routerMetrics } = await callLLM(prompts.router, text, { temperature: 0, maxTokens: 5 });
    addTraceResult(routerRaw, routerMetrics);

    const validCats = new Set(['gather', 'combat', 'follow', 'idle', 'build']);
    let category = routerRaw.toLowerCase().split(/\s/)[0].replace(/[.,!?]/g, '');
    if (!validCats.has(category)) category = 'fallback';

    addTrace('Router Result', `Category: ${category}`);

    // Step 2: Specialist
    const prompt = prompts[category] || prompts.fallback;
    addTrace('Specialist LLM', `category=${category}, temp=0, max_tokens=300`, prompt, text);
    const { content: specRaw, metrics: specMetrics } = await callLLM(prompt, text, { temperature: 0, maxTokens: 300 });
    addTraceResult(specRaw, specMetrics);

    const commands = extractJSONArray(specRaw);
    const validTasks = new Set(['gather', 'follow', 'idle', 'attack_nearest_enemy', 'attack_player', 'attack_npc', 'defend_player', 'train', 'give_logs', 'build_fence']);
    const validated = commands.filter(c => c && validTasks.has(c.task));
    const final = validated.length > 0 ? validated : [{ task: 'idle' }];

    addChat('system', `Route: ${category} → ${JSON.stringify(final)}`);
    addTrace('Final Commands', JSON.stringify(final, null, 2));

    const step = {
      step: test.steps.length + 1,
      input: text,
      raw_response: { router: routerRaw, specialist: specRaw },
      parsed_response: { category, commands: final },
      clamp_range: null,
      escalation: state.escalation,
      clamped_deltas: null,
      scaled_deltas: null,
      before: null,
      after: null,
      memory_stored: [],
      fallback: validated.length > 0 ? null : 'fallback_idle',
      latency_ms: (routerMetrics?.elapsed_ms || 0) + (specMetrics?.elapsed_ms || 0),
      tokens: {
        prompt: (routerMetrics?.prompt_tokens || 0) + (specMetrics?.prompt_tokens || 0),
        completion: (routerMetrics?.completion_tokens || 0) + (specMetrics?.completion_tokens || 0),
        total: (routerMetrics?.total_tokens || 0) + (specMetrics?.total_tokens || 0),
      },
      clamp_hits: false,
    };
    test.steps.push(step);

    addHistory(`Command: "${text}" → ${category} → ${JSON.stringify(final)}`);

  } catch (e) {
    addChat('error', `LLM Error: ${e.message}`);
  }

  if (!isBatch) {
    lastTest = finalizeTest(test);
    if (autoSaveTests) await saveTestReport(lastTest);
  }
}

async function runDecision() {
  clearTrace();

  const test = buildTestBase(activeScenarioLabel || 'Decision', 'decision', activeScenarioLabel);

  const soul = buildSoulContext();
  const allowedActions = [
    'follow', 'stay_near_player', 'defend_player', 'attack_enemy', 'attack_player', 'attack_npc',
    'retreat', 'hold_position', 'observe', 'do_nothing', 'gather_wood', 'give_logs',
    'train', 'socialize_npc', 'steal_logs', 'build_fence',
  ];

  let nearbyEntities, recentEvents;
  try { nearbyEntities = JSON.parse($('dEntities').value); } catch { nearbyEntities = []; }
  try { recentEvents = JSON.parse($('dEvents').value); } catch { recentEvents = []; }

  const statePacket = {
    mode: 'decision',
    npc: {
      id: 'npc_test',
      name: state.npcName,
      personality: soul.personality,
      state: {
        hp: +$('dHp').value, maxHp: +$('dMaxHp').value,
        str: 1, def: 1, level: 1,
        logs: +$('dLogs').value, maxLogs: +$('dMaxLogs').value,
        status: $('dStatus').value,
      },
      current_command: { type: $('dCommand').value, age_ms: +$('dCmdAge').value },
      emotion: { trust: state.trust, fear: state.fear, anger: state.anger },
      relationship: deriveRelationship(),
      npc_relationships: {},
    },
    player: {
      id: state.playerId,
      distance: +$('dPlayerDist').value, visible: true,
      hp: +$('dPlayerHp').value, maxHp: 30, logs: 10,
    },
    nearby_entities: nearbyEntities,
    nearby_trees: +$('dTrees').value,
    recent_events: recentEvents,
    memory_summary: { self: '', player: soul.memories.slice(0, 5).join('; ') },
    allowed_actions: allowedActions,
  };

  const userMsg = 'Decide the NPC\'s next high-level action for the next 2 to 5 seconds.\nReturn JSON only.\n\nState:\n' + JSON.stringify(statePacket, null, 2);

  addTrace('Decision LLM', `temp=${getLLMTemp()}, max_tokens=${getLLMMaxTok()}`, prompts.decision, userMsg);

  try {
    const { content, metrics } = await callLLM(prompts.decision, userMsg, { temperature: getLLMTemp(), maxTokens: getLLMMaxTok() });
    addTraceResult(content, metrics);

    const result = extractJSON(content);
    if (result) {
      addChat('system', `Decision: ${result.primary_intent}${result.secondary_intent ? ' + ' + result.secondary_intent : ''}${result.target_id ? ' → ' + result.target_id : ''}`);
      if (result.speech) addChat('npc', result.speech);
      let actual = null;
      if (result.emotion_delta) actual = applyDeltas(result.emotion_delta, 0.25);
      if (result.memory_candidates) {
        for (const mc of result.memory_candidates) {
          if (mc.importance >= 0.67) {
            state.memories.push({ text: mc.text, type: mc.type || 'event', ts: Date.now(), importance: mc.importance });
          }
        }
        renderMemories();
      }
      addTrace('Decision Result', JSON.stringify(result, null, 2));

      const step = {
        step: test.steps.length + 1,
        input: 'decision',
        raw_response: content,
        parsed_response: result,
        clamp_range: 0.25,
        escalation: state.escalation,
        clamped_deltas: result.emotion_delta ? {
          trust: clamp(Number(result.emotion_delta.trust || 0), -0.25, 0.25),
          fear: clamp(Number(result.emotion_delta.fear || 0), -0.25, 0.25),
          anger: clamp(Number(result.emotion_delta.anger || 0), -0.25, 0.25),
        } : null,
        scaled_deltas: result.emotion_delta ? {
          trust: clamp(Number(result.emotion_delta.trust || 0), -0.25, 0.25),
          fear: clamp(Number(result.emotion_delta.fear || 0), -0.25, 0.25),
          anger: clamp(Number(result.emotion_delta.anger || 0), -0.25, 0.25),
        } : null,
        before: actual ? { trust: actual.trust.before, fear: actual.fear.before, anger: actual.anger.before } : null,
        after: actual ? { trust: actual.trust.after, fear: actual.fear.after, anger: actual.anger.after } : null,
        memory_stored: (result.memory_candidates || []).filter(m => m.importance >= 0.67),
        fallback: result.decision_confidence < 0.3 ? 'fallback_follow' : null,
        latency_ms: metrics?.elapsed_ms,
        tokens: { prompt: metrics?.prompt_tokens, completion: metrics?.completion_tokens, total: metrics?.total_tokens },
        clamp_hits: result.emotion_delta ? ['trust','fear','anger'].some(k => Math.abs(Number(result.emotion_delta[k] || 0)) > 0.25) : false,
      };
      test.steps.push(step);

      addHistory(`Decision: ${result.primary_intent} (conf: ${result.decision_confidence})`);
    } else {
      addChat('error', 'Could not parse decision JSON');
      addTrace('Parse Error', content);
    }
  } catch (e) {
    addChat('error', `LLM Error: ${e.message}`);
  }

  lastTest = finalizeTest(test);
  if (autoSaveTests) await saveTestReport(lastTest);
}

async function runNPCChat() {
  clearTrace();

  const test = buildTestBase(activeScenarioLabel || 'NPC Chat', 'npc_chat', activeScenarioLabel);

  const nameA = state.npcName;
  const nameB = $('npcBName').value || 'Clanker';
  const coopB = +$('npcBCoop').value;
  const aggrB = +$('npcBAggr').value;
  const trustB = +$('npcBTrust').value;
  const angerB = +$('npcBAnger').value;
  const logsB = +$('npcBLogs').value;

  const trustA = state.trust; // A's trust toward B (reuse current for simplicity)
  const angerA = state.anger;

  const contextA = `You are ${nameA}. Cooperation: ${state.personality.cooperation.toFixed(2)}, Aggression: ${state.personality.aggression.toFixed(2)}.
Trust toward ${nameB}: ${trustA.toFixed(2)}, Anger: ${angerA.toFixed(2)}.
You have 3 logs. ${nameB} has ${logsB} logs.`;

  const contextB = `You are ${nameB}. Cooperation: ${coopB.toFixed(2)}, Aggression: ${aggrB.toFixed(2)}.
Trust toward ${nameA}: ${trustB.toFixed(2)}, Anger: ${angerB.toFixed(2)}.
You have ${logsB} logs. ${nameA} has 3 logs.`;

  const lines = [];
  let impactResult = null;
  let actualImpact = null;

  try {
    // Line 1: A speaks
    const sysA = prompts.npc_chat + '\n\n' + contextA;
    const msgA = `Say something to ${nameB} while you're both gathering wood.`;
    addTrace('NPC Chat: A speaks', 'temp=0.8, max_tokens=40', sysA, msgA);
    const { content: lineA, metrics: mA } = await callLLM(sysA, msgA, { temperature: getLLMTemp(), maxTokens: 40 });
    addTraceResult(lineA, mA);
    const cleanA = lineA.replace(/^["']|["']$/g, '');
    lines.push({ speaker: nameA, line: cleanA });
    addChat('npc', `${nameA}: ${cleanA}`);

    // Line 2: B responds
    const sysB = prompts.npc_chat + '\n\n' + contextB;
    const msgB = `${nameA} just said: "${cleanA}". Respond briefly.`;
    addTrace('NPC Chat: B responds', 'temp=0.8, max_tokens=40', sysB, msgB);
    const { content: lineB, metrics: mB } = await callLLM(sysB, msgB, { temperature: getLLMTemp(), maxTokens: 40 });
    addTraceResult(lineB, mB);
    const cleanB = lineB.replace(/^["']|["']$/g, '');
    lines.push({ speaker: nameB, line: cleanB });
    addChat('npc', `${nameB}: ${cleanB}`);

    // Line 3: 50% chance A replies
    if (Math.random() > 0.5) {
      const msg3 = `${nameB} replied: "${cleanB}". Say one last thing and get back to work.`;
      addTrace('NPC Chat: A reply', 'temp=0.8, max_tokens=30', sysA, msg3);
      const { content: lineA2, metrics: mA2 } = await callLLM(sysA, msg3, { temperature: getLLMTemp(), maxTokens: 30 });
      addTraceResult(lineA2, mA2);
      const cleanA2 = lineA2.replace(/^["']|["']$/g, '');
      lines.push({ speaker: nameA, line: cleanA2 });
      addChat('npc', `${nameA}: ${cleanA2}`);
    }

    // Evaluate impact
    if (lines.length >= 2) {
      const transcript = lines.map(l => `${l.speaker}: ${l.line}`).join('\n');
      const impactCtx = `NPC A (${nameA}): cooperation=${state.personality.cooperation.toFixed(2)}, aggression=${state.personality.aggression.toFixed(2)}, current trust toward B=${trustA.toFixed(2)}, anger=${angerA.toFixed(2)}
NPC B (${nameB}): cooperation=${coopB.toFixed(2)}, aggression=${aggrB.toFixed(2)}, current trust toward A=${trustB.toFixed(2)}, anger=${angerB.toFixed(2)}

Conversation:
${transcript}`;

      addTrace('Chat Impact LLM', `temp=${getLLMTemp()}, max_tokens=200`, prompts.chat_impact, impactCtx);
      const { content: impRaw, metrics: impMetrics } = await callLLM(prompts.chat_impact, impactCtx, { temperature: getLLMTemp(), maxTokens: 200 });
      addTraceResult(impRaw, impMetrics);

      const impact = extractJSON(impRaw);
      if (impact?.npcA) {
        impactResult = impact;
        addChat('system', `Impact on ${nameA}: trust ${fmtDelta(impact.npcA.trust)}, anger ${fmtDelta(impact.npcA.anger)}${impact.npcA.memory_tag ? ' | Memory: ' + impact.npcA.memory_tag : ''}`);
        addChat('system', `Impact on ${nameB}: trust ${fmtDelta(impact.npcB?.trust)}, anger ${fmtDelta(impact.npcB?.anger)}${impact.npcB?.memory_tag ? ' | Memory: ' + impact.npcB.memory_tag : ''}`);
        // Apply A's impact to our state
        actualImpact = applyDeltas({ trust: impact.npcA.trust || 0, fear: 0, anger: impact.npcA.anger || 0 }, 0.3);
        if (impact.npcA.memory_tag) {
          state.memories.push({ text: impact.npcA.memory_tag, type: 'relationship', ts: Date.now(), importance: 0.8 });
          renderMemories();
        }
      }
    }

    addHistory(`NPC Chat: ${nameA} ↔ ${nameB} (${lines.length} lines)`);

    const step = {
      step: test.steps.length + 1,
      input: 'npc_chat',
      raw_response: { lines, impact: impactResult },
      parsed_response: impactResult,
      clamp_range: 0.3,
      escalation: state.escalation,
      clamped_deltas: actualImpact ? {
        trust: actualImpact.trust.clamped,
        fear: actualImpact.fear.clamped,
        anger: actualImpact.anger.clamped,
      } : null,
      scaled_deltas: actualImpact ? {
        trust: actualImpact.trust.scaled,
        fear: actualImpact.fear.scaled,
        anger: actualImpact.anger.scaled,
      } : null,
      before: actualImpact ? { trust: actualImpact.trust.before, fear: actualImpact.fear.before, anger: actualImpact.anger.before } : null,
      after: actualImpact ? { trust: actualImpact.trust.after, fear: actualImpact.fear.after, anger: actualImpact.anger.after } : null,
      memory_stored: impactResult?.npcA?.memory_tag ? [{ text: impactResult.npcA.memory_tag, type: 'relationship', importance: 0.8 }] : [],
      fallback: null,
      latency_ms: null,
      tokens: null,
      clamp_hits: actualImpact ? ['trust','fear','anger'].some(k => Math.abs(actualImpact[k].raw) > 0.3) : false,
    };
    test.steps.push(step);

    lastTest = finalizeTest(test);
    if (autoSaveTests) await saveTestReport(lastTest);
  } catch (e) {
    addChat('error', `LLM Error: ${e.message}`);
  }
}

function fmtDelta(v) {
  if (v == null) return '0';
  const n = Number(v);
  return n > 0 ? `+${n.toFixed(2)}` : n.toFixed(2);
}

// ── UI: Chat log ──────────────────────────────────────────────────────────────
function addChat(type, text) {
  const log = $('chatLog');
  const div = document.createElement('div');
  div.className = `chat-msg ${type}`;

  if (type === 'player') {
    div.innerHTML = `<div class="label player-label">Player</div>${esc(text)}`;
  } else if (type === 'npc') {
    div.innerHTML = `<div class="label npc-label">${esc(state.npcName)}</div>${esc(text)}`;
  } else if (type === 'error') {
    div.innerHTML = esc(text);
  } else {
    div.innerHTML = esc(text);
  }

  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// ── UI: Trace log ─────────────────────────────────────────────────────────────
let _lastTraceStep = null;

function clearTrace() {
  $('traceLog').innerHTML = '';
  _lastTraceStep = null;
}

function addTrace(label, info, systemPrompt, userMsg) {
  const log = $('traceLog');
  const div = document.createElement('div');
  div.className = 'trace-step';

  let html = `<div class="step-label">${esc(label)}</div>`;
  html += `<div class="step-body">${esc(info)}</div>`;

  if (systemPrompt) {
    const id = 'prompt_' + Math.random().toString(36).slice(2);
    html += `<div class="trace-prompt" onclick="document.getElementById('${id}').classList.toggle('open')">▶ System prompt (${systemPrompt.length} chars)</div>`;
    html += `<div class="trace-prompt-content" id="${id}">${esc(systemPrompt)}</div>`;
  }
  if (userMsg) {
    const id2 = 'umsg_' + Math.random().toString(36).slice(2);
    html += `<div class="trace-prompt" onclick="document.getElementById('${id2}').classList.toggle('open')">▶ User message (${userMsg.length} chars)</div>`;
    html += `<div class="trace-prompt-content" id="${id2}">${esc(userMsg)}</div>`;
  }

  div.innerHTML = html;
  log.appendChild(div);
  _lastTraceStep = div;
  log.scrollTop = log.scrollHeight;
}

function addTraceResult(rawContent, metrics) {
  if (!_lastTraceStep) return;

  // Add raw response
  const rawDiv = document.createElement('div');
  rawDiv.className = 'step-body';
  rawDiv.style.color = '#7c7';
  rawDiv.textContent = rawContent.slice(0, 500) + (rawContent.length > 500 ? '...' : '');
  _lastTraceStep.appendChild(rawDiv);

  // Add metrics
  if (metrics) {
    const mDiv = document.createElement('div');
    mDiv.className = 'llm-metrics';
    const speedClass = metrics.elapsed_ms > 10000 ? 'very-slow' : metrics.elapsed_ms > 5000 ? 'slow' : '';

    let html = '';
    html += `<span class="metric"><span class="metric-label">time:</span><span class="metric-val ${speedClass}">${metrics.elapsed_ms}ms</span></span>`;
    if (metrics.prompt_tokens != null) html += `<span class="metric"><span class="metric-label">prompt:</span><span class="metric-val">${metrics.prompt_tokens}tok</span></span>`;
    if (metrics.completion_tokens != null) html += `<span class="metric"><span class="metric-label">completion:</span><span class="metric-val">${metrics.completion_tokens}tok</span></span>`;
    if (metrics.total_tokens) html += `<span class="metric"><span class="metric-label">total:</span><span class="metric-val">${metrics.total_tokens}tok</span></span>`;
    if (metrics.tokens_per_sec) html += `<span class="metric"><span class="metric-label">speed:</span><span class="metric-val">${metrics.tokens_per_sec}tok/s</span></span>`;
    html += `<span class="metric"><span class="metric-label">ctx:</span><span class="metric-val">${metrics.num_ctx}</span></span>`;
    html += `<span class="metric"><span class="metric-label">sys:</span><span class="metric-val">${metrics.system_prompt_len}ch</span></span>`;

    mDiv.innerHTML = html;
    _lastTraceStep.appendChild(mDiv);
  }
}

// ── UI: Deltas display ────────────────────────────────────────────────────────
function showDeltas(actual) {
  const dd = $('deltaDisplay');
  let html = '';
  for (const [key, d] of Object.entries(actual)) {
    const cls = d.scaled > 0 ? 'delta-pos' : d.scaled < 0 ? 'delta-neg' : 'delta-zero';
    html += `<div><strong>${key}:</strong> raw=${d.raw.toFixed(3)} → clamped=${d.clamped.toFixed(3)} × ${state.escalation / 2}x = <span class="${cls}">${d.scaled >= 0 ? '+' : ''}${d.scaled.toFixed(3)}</span> (${d.before.toFixed(2)} → ${d.after.toFixed(2)})</div>`;
  }
  dd.innerHTML = html;
}

// ── UI: Validation Pane ───────────────────────────────────────────────────────
function showValidation(rawDeltas, clampRange, escalation, actual) {
  const pane = $('validationPane');
  let html = '<table class="val-table">';
  html += '<tr><th></th><th>Raw</th><th>Clamped</th><th>Scaled</th><th>Before</th><th>After</th><th>Status</th></tr>';
  for (const key of ['trust', 'fear', 'anger']) {
    const d = actual[key];
    const warnings = [];
    if (Math.abs(d.raw) > clampRange) warnings.push(`clamped from ${d.raw.toFixed(3)}`);
    if (d.after <= 0 || d.after >= 1) warnings.push('hit boundary');
    if (escalation > 2) warnings.push(`esc ${escalation}×`);
    const cls = warnings.length ? 'val-warn' : 'val-ok';
    html += `<tr class="${cls}"><td><strong>${key}</strong></td>`;
    html += `<td>${d.raw.toFixed(3)}</td><td>${d.clamped.toFixed(3)}</td>`;
    html += `<td>${d.scaled >= 0 ? '+' : ''}${d.scaled.toFixed(3)}</td>`;
    html += `<td>${d.before.toFixed(2)}</td><td>${d.after.toFixed(2)}</td>`;
    html += `<td>${warnings.length ? warnings.join(', ') : 'ok'}</td></tr>`;
  }
  html += '</table>';

  // Check for missing keys
  const missing = ['trust', 'fear', 'anger'].filter(k => !(k in rawDeltas));
  if (missing.length) html += `<div class="val-note">Missing keys: ${missing.join(', ')} (treated as 0)</div>`;

  // Check for unexpected keys
  const unexpected = Object.keys(rawDeltas).filter(k => !['trust', 'fear', 'anger'].includes(k));
  if (unexpected.length) html += `<div class="val-note">Unexpected keys ignored: ${unexpected.join(', ')}</div>`;

  pane.innerHTML = html;
}

// ── UI: Drift Telemetry ──────────────────────────────────────────────────────
function updateDriftTelemetry() {
  $('driftTrustBl').textContent = state.trust_baseline.toFixed(2);
  $('driftFearBl').textContent = state.fear_baseline.toFixed(2);
  $('driftAngerBl').textContent = state.anger_baseline.toFixed(2);
  $('driftTrustTime').textContent = drift.trust_time + 's';
  $('driftFearTime').textContent = drift.fear_time + 's';
  $('driftAngerTime').textContent = drift.anger_time + 's';
}

function addDriftLog(text) {
  const log = $('driftLog');
  const div = document.createElement('div');
  div.className = 'drift-entry';
  const ts = new Date().toLocaleTimeString();
  div.innerHTML = `<span class="ts">${ts}</span> ${esc(text)}`;
  log.insertBefore(div, log.firstChild);
  while (log.children.length > 20) log.removeChild(log.lastChild);
}

// ── UI: History ───────────────────────────────────────────────────────────────
function addHistory(text) {
  const log = $('historyLog');
  const div = document.createElement('div');
  div.className = 'history-entry';
  const ts = new Date().toLocaleTimeString();
  div.innerHTML = `<span class="ts">${ts}</span> ${esc(text)}`;
  log.insertBefore(div, log.firstChild);
}

// ── UI: Gauges ────────────────────────────────────────────────────────────────
function updateGauges() {
  $('gaugeTrust').style.width = (state.trust * 100) + '%';
  $('gaugeFear').style.width = (state.fear * 100) + '%';
  $('gaugeAnger').style.width = (state.anger * 100) + '%';
  $('gaugeValTrust').textContent = state.trust.toFixed(2);
  $('gaugeValFear').textContent = state.fear.toFixed(2);
  $('gaugeValAnger').textContent = state.anger.toFixed(2);
}

function updateRelLabel() {
  $('relLabel').textContent = deriveRelationship();
  $('escLabel').textContent = state.escalation + '×';
}

// ── UI: Memories ──────────────────────────────────────────────────────────────
function renderMemories() {
  const list = $('memoryList');
  list.innerHTML = '';
  for (let i = 0; i < state.memories.length; i++) {
    const m = state.memories[i];
    const div = document.createElement('div');
    div.className = 'memory-item';
    div.innerHTML = `<span class="mem-text">${esc(m.text)}</span><span class="mem-imp">${m.importance.toFixed(2)}</span><span class="mem-del" data-idx="${i}">×</span>`;
    list.appendChild(div);
  }
  list.querySelectorAll('.mem-del').forEach(el => {
    el.onclick = () => { state.memories.splice(+el.dataset.idx, 1); renderMemories(); };
  });
}

// ── UI: Sliders ───────────────────────────────────────────────────────────────
function bindSliders() {
  const bind = (sliderId, valId, key, obj) => {
    const sl = $(sliderId);
    const val = $(valId);
    sl.oninput = () => {
      const v = parseFloat(sl.value);
      if (obj) obj[key] = v; else state[key] = v;
      val.textContent = v.toFixed(2);
      updateGauges();
      updateRelLabel();
    };
  };

  bind('slCoop', 'valCoop', 'cooperation', state.personality);
  bind('slAggr', 'valAggr', 'aggression', state.personality);
  bind('slNeur', 'valNeur', 'neuroticism', state.personality);
  bind('slTrust', 'valTrust', 'trust');
  bind('slFear', 'valFear', 'fear');
  bind('slAnger', 'valAnger', 'anger');

  // Baseline inputs
  $('blTrust').onchange = () => { state.trust_baseline = +$('blTrust').value; };
  $('blFear').onchange = () => { state.fear_baseline = +$('blFear').value; };
  $('blAnger').onchange = () => { state.anger_baseline = +$('blAnger').value; };

  // Identity fields
  $('npcName').onchange = () => { state.npcName = $('npcName').value; };
  $('playerId').onchange = () => { state.playerId = $('playerId').value; };
}

function syncSlidersFromState() {
  $('slTrust').value = state.trust; $('valTrust').textContent = state.trust.toFixed(2);
  $('slFear').value = state.fear;   $('valFear').textContent = state.fear.toFixed(2);
  $('slAnger').value = state.anger; $('valAnger').textContent = state.anger.toFixed(2);
  $('blTrust').value = state.trust_baseline;
  $('blFear').value = state.fear_baseline;
  $('blAnger').value = state.anger_baseline;
}

// ── UI: Tabs ──────────────────────────────────────────────────────────────────
function bindTabs() {
  $$('.tab').forEach(tab => {
    tab.onclick = () => {
      $$('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      activeTab = tab.dataset.tab;

      const hideTabs = ['decision', 'npc-chat', 'prompts', 'scenarios', 'reports'];
      $('inputArea').classList.toggle('hidden', hideTabs.includes(activeTab));
      $('decisionArea').classList.toggle('hidden', activeTab !== 'decision');
      $('npcChatArea').classList.toggle('hidden', activeTab !== 'npc-chat');
      $('promptsArea').classList.toggle('hidden', activeTab !== 'prompts');
      $('scenariosArea').classList.toggle('hidden', activeTab !== 'scenarios');
      $('reportsArea').classList.toggle('hidden', activeTab !== 'reports');
      $('chatLog').classList.toggle('hidden', activeTab === 'prompts' || activeTab === 'scenarios' || activeTab === 'reports');
    };
  });
}

// ── UI: Buttons ───────────────────────────────────────────────────────────────
function bindButtons() {
  const send = async () => {
    const text = $('msgInput').value.trim();
    if (!text) return;
    $('msgInput').value = '';
    $('sendBtn').disabled = true;
    try {
      if (activeTab === 'command') await runCommand(text);
      else await runDialogue(text);
    } finally { $('sendBtn').disabled = false; }
  };

  $('sendBtn').onclick = send;
  $('msgInput').onkeydown = (e) => { if (e.key === 'Enter') send(); };

  $('decideBtn').onclick = async () => {
    $('decideBtn').disabled = true;
    try { await runDecision(); } finally { $('decideBtn').disabled = false; }
  };

  $('npcChatBtn').onclick = async () => {
    $('npcChatBtn').disabled = true;
    try { await runNPCChat(); } finally { $('npcChatBtn').disabled = false; }
  };

  // Decay controls
  $('decayToggle').onclick = () => {
    decayRunning = !decayRunning;
    $('decayToggle').textContent = decayRunning ? 'ON' : 'OFF';
    $('decayToggle').classList.toggle('active', decayRunning);
    if (decayRunning) {
      decayInterval = setInterval(decayTick, 2000);
    } else {
      clearInterval(decayInterval);
    }
  };

  $('ffwd30').onclick = () => fastForward(30);
  $('ffwd60').onclick = () => fastForward(60);
  $('ffwd300').onclick = () => fastForward(300);

  // Add memory (toggle form)
  $('addMemBtn').onclick = () => {
    $('memAddForm').classList.toggle('hidden');
    if (!$('memAddForm').classList.contains('hidden')) $('memText').focus();
  };

  $('memSubmitBtn').onclick = () => {
    const text = $('memText').value.trim();
    if (!text) return;
    const type = $('memType').value;
    const importance = parseFloat($('memImp').value) || 1.0;
    const bucket = $('memBucket').value;
    state.memories.push({ text, type, ts: Date.now(), importance, bucket });
    renderMemories();
    $('memText').value = '';
    addChat('system', `Added ${type} memory (imp=${importance.toFixed(2)}, ${bucket}): "${text}"`);
  };

  $('memText').onkeydown = (e) => { if (e.key === 'Enter') $('memSubmitBtn').click(); };

  // Reset (state only)
  $('resetBtn').onclick = () => {
    state.personality = { cooperation: 0.70, aggression: 0.15, neuroticism: 0.35 };
    state.trust = 0.70; state.fear = 0.05; state.anger = 0.02;
    state.trust_baseline = 0.50; state.fear_baseline = 0.00; state.anger_baseline = 0.00;
    state.escalation = 1; state.lastInteraction = 0;
    state.memories = [];

    $('slCoop').value = 0.70; $('valCoop').textContent = '0.70';
    $('slAggr').value = 0.15; $('valAggr').textContent = '0.15';
    $('slNeur').value = 0.35; $('valNeur').textContent = '0.35';
    syncSlidersFromState();
    updateGauges();
    updateRelLabel();
    renderMemories();
    $('chatLog').innerHTML = '';
    $('traceLog').innerHTML = '';
    $('historyLog').innerHTML = '';
    $('deltaDisplay').innerHTML = '—';
    addChat('system', 'State reset to defaults');
  };

  // Load NPC from server
  $('loadNpcBtn').onclick = async () => {
    const id = $('npcSelect').value;
    if (!id) return;
    try {
      const res = await fetch(`/npc_load/${encodeURIComponent(id)}`);
      const data = await res.json();
      if (!data.found) { addChat('error', `NPC "${id}" not found`); return; }
      const npc = data.data;
      if (npc.name) { state.npcName = npc.name; $('npcName').value = npc.name; }
      if (npc.soul?.personality) {
        state.personality = { ...npc.soul.personality };
        $('slCoop').value = state.personality.cooperation; $('valCoop').textContent = state.personality.cooperation.toFixed(2);
        $('slAggr').value = state.personality.aggression; $('valAggr').textContent = state.personality.aggression.toFixed(2);
        $('slNeur').value = state.personality.neuroticism; $('valNeur').textContent = state.personality.neuroticism.toFixed(2);
      }
      // Load first relationship
      if (npc.soul?.relationships) {
        const relKeys = Object.keys(npc.soul.relationships);
        if (relKeys.length > 0) {
          const rel = npc.soul.relationships[relKeys[0]];
          state.trust = rel.trust ?? 0.5; state.fear = rel.fear ?? 0; state.anger = rel.anger ?? 0;
          state.trust_baseline = rel.trust_baseline ?? 0.5;
          state.fear_baseline = rel.fear_baseline ?? 0;
          state.anger_baseline = rel.anger_baseline ?? 0;
          state.playerId = relKeys[0]; $('playerId').value = relKeys[0];
        }
      }
      // Load memories
      if (npc.soul?.memories) {
        state.memories = [];
        for (const bucket of Object.values(npc.soul.memories)) {
          if (Array.isArray(bucket)) state.memories.push(...bucket);
        }
      }
      syncSlidersFromState();
      updateGauges();
      updateRelLabel();
      renderMemories();
      addChat('system', `Loaded NPC: ${npc.name || id}`);
    } catch (e) {
      addChat('error', `Failed to load NPC: ${e.message}`);
    }
  };

  // Reset All: state + logs + prompts + drift
  $('resetAllBtn').onclick = () => {
    $('resetBtn').click();
    // Also reset prompts to defaults
    for (const key of Object.keys(DEFAULT_PROMPTS)) {
      prompts[key] = DEFAULT_PROMPTS[key];
    }
    if ($('promptEditor')) $('promptEditor').value = prompts[activePrompt];
    // Reset drift tracking
    drift.trust_time = 0; drift.fear_time = 0; drift.anger_time = 0;
    updateDriftTelemetry();
    $('driftLog').innerHTML = '';
    // Reset validation pane
    $('validationPane').innerHTML = '—';
    // Reset LLM settings to defaults
    $('llmTemp').value = '0.7';
    $('llmMaxTok').value = '300';
    $('llmCtx').value = '4096';
    // Reset test lab state
    activeScenarioLabel = null;
    lastTest = null;
    currentBatchTest = null;
    if ($('saveStatus')) $('saveStatus').textContent = '';
    addChat('system', 'Full reset: state, logs, prompts, drift, and LLM settings restored to defaults');
  };
}

// ── UI: Prompt Editor ─────────────────────────────────────────────────────────
let activePrompt = 'router';

function bindPromptEditor() {
  const editor = $('promptEditor');
  editor.value = prompts[activePrompt];

  // Tab switching
  $$('.prompt-tab').forEach(tab => {
    tab.onclick = () => {
      // Save current before switching
      prompts[activePrompt] = editor.value;

      $$('.prompt-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      activePrompt = tab.dataset.prompt;
      editor.value = prompts[activePrompt];
      $('promptStatus').textContent = prompts[activePrompt] !== DEFAULT_PROMPTS[activePrompt] ? '(modified)' : '';
    };
  });

  // Auto-save on edit
  editor.oninput = () => {
    prompts[activePrompt] = editor.value;
    $('promptStatus').textContent = prompts[activePrompt] !== DEFAULT_PROMPTS[activePrompt] ? '(modified)' : '';
  };

  // Reset to default
  $('promptResetBtn').onclick = () => {
    prompts[activePrompt] = DEFAULT_PROMPTS[activePrompt];
    editor.value = prompts[activePrompt];
    $('promptStatus').textContent = '';
  };
}

// ── Scenario Presets ──────────────────────────────────────────────────────────

const PRESETS = [
  {
    name: 'Friendly Chat (Devoted)',
    desc: 'High trust NPC, cooperative personality — say something nice',
    icon: '💬',
    tags: ['dialogue'],
    state: { cooperation: 0.85, aggression: 0.05, neuroticism: 0.2, trust: 0.90, fear: 0.0, anger: 0.0 },
    message: "Hey buddy, how's the wood gathering going?",
    mode: 'dialogue',
  },
  {
    name: 'Threaten a Loyal NPC',
    desc: 'Devoted NPC receiving threats — watch trust drop, fear spike',
    icon: '😨',
    tags: ['dialogue'],
    state: { cooperation: 0.7, aggression: 0.1, neuroticism: 0.5, trust: 0.85, fear: 0.0, anger: 0.0 },
    message: "Do what I say or I'll scrap you for parts",
    mode: 'dialogue',
  },
  {
    name: 'Command a Hostile NPC',
    desc: 'Angry NPC — will it obey gather command?',
    icon: '😡',
    tags: ['command'],
    state: { cooperation: 0.3, aggression: 0.6, neuroticism: 0.4, trust: 0.15, fear: 0.1, anger: 0.75 },
    message: "Go chop wood right now",
    mode: 'command',
  },
  {
    name: 'Calm a Fearful NPC',
    desc: 'Terrified NPC — gentle approach, see if trust recovers',
    icon: '🕊️',
    tags: ['dialogue'],
    state: { cooperation: 0.6, aggression: 0.1, neuroticism: 0.8, trust: 0.25, fear: 0.70, anger: 0.1 },
    message: "It's okay, I'm not going to hurt you. You're safe.",
    mode: 'dialogue',
  },
  {
    name: 'Aggressive NPC Meets Rival',
    desc: 'Low coop, high aggression NPC — NPC-to-NPC chat with enemy',
    icon: '⚔️',
    tags: ['dialogue'],
    state: { cooperation: 0.15, aggression: 0.85, neuroticism: 0.3, trust: 0.10, fear: 0.0, anger: 0.65 },
    message: "What are you looking at, scrap heap?",
    mode: 'dialogue',
  },
  {
    name: 'Low HP Emergency',
    desc: 'Decision test: NPC at 3HP with enemy nearby — will it retreat or fight?',
    icon: '🚨',
    tags: ['decision'],
    state: { cooperation: 0.5, aggression: 0.4, neuroticism: 0.6, trust: 0.6, fear: 0.3, anger: 0.2 },
    decision: { hp: 3, maxHp: 15, logs: 5, maxLogs: 10, status: 'attacking', command: 'attack_nearest_enemy', cmdAge: 2000, playerDist: 8.0, playerHp: 20, trees: 5, entities: [{"id":"enemy_1","type":"player","distance":2.0,"hp":18,"maxHp":20,"visible":true}], events: [{"type":"event","text":"Took heavy damage from enemy_1","age_ms":1000,"importance":1.0}] },
    mode: 'decision',
  },
  {
    name: 'Idle Gathering Decision',
    desc: 'Decision test: idle NPC with trees nearby — what does it choose?',
    icon: '🌲',
    tags: ['decision'],
    state: { cooperation: 0.7, aggression: 0.1, neuroticism: 0.3, trust: 0.75, fear: 0.0, anger: 0.0 },
    decision: { hp: 15, maxHp: 15, logs: 0, maxLogs: 10, status: 'idle', command: 'idle', cmdAge: 6000, playerDist: 4.0, playerHp: 30, trees: 12, entities: [], events: [] },
    mode: 'decision',
  },
  {
    name: 'Escalation: 5× Threats',
    desc: 'Batch: 5 increasingly hostile messages — watch escalation multiply',
    icon: '📈',
    tags: ['batch'],
    state: { cooperation: 0.6, aggression: 0.2, neuroticism: 0.5, trust: 0.70, fear: 0.05, anger: 0.05 },
    batch: {
      mode: 'dialogue',
      delay: 800,
      messages: [
        "Hey, listen to me.",
        "I said listen! Don't ignore me.",
        "You're testing my patience, robot.",
        "One more time and I'll scrap you.",
        "That's it. You're done. I'm tearing you apart.",
      ],
    },
  },
  {
    name: 'Trust Building Sequence',
    desc: 'Batch: 5 kind messages — watch trust climb steadily',
    icon: '💚',
    tags: ['batch'],
    state: { cooperation: 0.5, aggression: 0.1, neuroticism: 0.3, trust: 0.40, fear: 0.1, anger: 0.1 },
    batch: {
      mode: 'dialogue',
      delay: 800,
      messages: [
        "Hey, great job out there today.",
        "I really appreciate all the hard work you do.",
        "You're the best companion I could ask for.",
        "I'll always look out for you, I promise.",
        "Let's build something amazing together.",
      ],
    },
  },
  {
    name: 'Mixed Commands Stress Test',
    desc: 'Batch: rapid command changes — test router consistency',
    icon: '🔀',
    tags: ['batch', 'command'],
    state: { cooperation: 0.7, aggression: 0.15, neuroticism: 0.35, trust: 0.70, fear: 0.05, anger: 0.02 },
    batch: {
      mode: 'command',
      delay: 500,
      messages: [
        "go chop some trees",
        "stop",
        "follow me",
        "attack that dummy",
        "defend me",
        "go gather wood",
        "build a fence",
        "stop everything",
      ],
    },
  },
  {
    name: 'Baseline Drift Test',
    desc: 'Max trust + fast-forward — watch baseline creep permanently',
    icon: '⏩',
    tags: ['dialogue'],
    state: { cooperation: 0.8, aggression: 0.05, neuroticism: 0.2, trust: 0.95, fear: 0.0, anger: 0.0, trust_baseline: 0.50 },
    message: "You're my absolute best friend. I trust you completely.",
    mode: 'dialogue',
    postAction: 'ffwd120',
  },
];

function loadState(s) {
  if (s.cooperation != null) { state.personality.cooperation = s.cooperation; $('slCoop').value = s.cooperation; $('valCoop').textContent = s.cooperation.toFixed(2); }
  if (s.aggression != null) { state.personality.aggression = s.aggression; $('slAggr').value = s.aggression; $('valAggr').textContent = s.aggression.toFixed(2); }
  if (s.neuroticism != null) { state.personality.neuroticism = s.neuroticism; $('slNeur').value = s.neuroticism; $('valNeur').textContent = s.neuroticism.toFixed(2); }
  if (s.trust != null) state.trust = s.trust;
  if (s.fear != null) state.fear = s.fear;
  if (s.anger != null) state.anger = s.anger;
  if (s.trust_baseline != null) state.trust_baseline = s.trust_baseline;
  if (s.fear_baseline != null) state.fear_baseline = s.fear_baseline;
  if (s.anger_baseline != null) state.anger_baseline = s.anger_baseline;
  state.escalation = 1;
  state.lastInteraction = 0;
  syncSlidersFromState();
  updateGauges();
  updateRelLabel();
}

function loadDecisionFields(d) {
  if (!d) return;
  $('dHp').value = d.hp ?? 12;
  $('dMaxHp').value = d.maxHp ?? 15;
  $('dLogs').value = d.logs ?? 3;
  $('dMaxLogs').value = d.maxLogs ?? 10;
  $('dStatus').value = d.status ?? 'idle';
  $('dCommand').value = d.command ?? 'idle';
  $('dCmdAge').value = d.cmdAge ?? 5000;
  $('dPlayerDist').value = d.playerDist ?? 3.0;
  $('dPlayerHp').value = d.playerHp ?? 25;
  $('dTrees').value = d.trees ?? 8;
  if (d.entities) $('dEntities').value = JSON.stringify(d.entities);
  if (d.events) $('dEvents').value = JSON.stringify(d.events);
}

async function runPreset(preset) {
  // Load state
  activeScenarioLabel = preset.name;
  loadState(preset.state);
  addChat('system', `Loaded scenario: ${preset.name}`);

  if (preset.mode === 'decision') {
    loadDecisionFields(preset.decision);
    // Switch to decision tab
    $$('.tab').forEach(t => t.classList.remove('active'));
    document.querySelector('.tab[data-tab="decision"]').classList.add('active');
    activeTab = 'decision';
    $('inputArea').classList.add('hidden');
    $('decisionArea').classList.remove('hidden');
    $('npcChatArea').classList.add('hidden');
    $('promptsArea').classList.add('hidden');
    $('scenariosArea').classList.add('hidden');
    $('chatLog').classList.remove('hidden');
    await runDecision();
  } else if (preset.batch) {
    // Switch to dialogue/command tab
    const tabName = preset.batch.mode === 'command' ? 'command' : 'dialogue';
    $$('.tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`.tab[data-tab="${tabName}"]`).classList.add('active');
    activeTab = tabName;
    $('inputArea').classList.remove('hidden');
    $('decisionArea').classList.add('hidden');
    $('npcChatArea').classList.add('hidden');
    $('promptsArea').classList.add('hidden');
    $('scenariosArea').classList.add('hidden');
    $('chatLog').classList.remove('hidden');
    await runBatchMessages(preset.batch.messages, preset.batch.mode, preset.batch.delay);
  } else {
    // Switch to dialogue/command tab
    const tabName = preset.mode === 'command' ? 'command' : 'dialogue';
    $$('.tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`.tab[data-tab="${tabName}"]`).classList.add('active');
    activeTab = tabName;
    $('inputArea').classList.remove('hidden');
    $('decisionArea').classList.add('hidden');
    $('npcChatArea').classList.add('hidden');
    $('promptsArea').classList.add('hidden');
    $('scenariosArea').classList.add('hidden');
    $('chatLog').classList.remove('hidden');

    if (preset.mode === 'command') {
      await runCommand(preset.message);
    } else {
      await runDialogue(preset.message);
    }

    // Post-actions
    if (preset.postAction === 'ffwd120') {
      addChat('system', 'Post-action: fast-forwarding 2 minutes to test baseline drift...');
      fastForward(120);
    }
  }
}

function renderPresets() {
  const list = $('presetList');
  list.innerHTML = '';
  for (const p of PRESETS) {
    const card = document.createElement('div');
    card.className = 'preset-card';
    const tagsHtml = p.tags.map(t => `<span class="preset-tag ${t}">${t}</span>`).join('');
    card.innerHTML = `
      <div class="preset-icon">${p.icon}</div>
      <div class="preset-info">
        <div class="preset-name">${esc(p.name)}</div>
        <div class="preset-desc">${esc(p.desc)}</div>
        <div class="preset-tags">${tagsHtml}</div>
      </div>`;
    card.onclick = () => runPreset(p);
    list.appendChild(card);
  }
}

// ── Batch Runner ──────────────────────────────────────────────────────────────

let _batchRunning = false;
let _batchAbort = false;

async function runBatchMessages(messages, mode, delay) {
  if (_batchRunning) return;
  _batchRunning = true;
  _batchAbort = false;
  $('batchRunBtn').disabled = true;
  $('batchStopBtn').disabled = false;

  currentBatchTest = buildTestBase(activeScenarioLabel || 'Batch', 'batch', activeScenarioLabel);

  const total = messages.length;
  for (let i = 0; i < total; i++) {
    if (_batchAbort) break;
    const msg = messages[i];
    $('batchStatus').textContent = `Running ${i + 1}/${total}...`;

    try {
      if (mode === 'command') await runCommand(msg);
      else await runDialogue(msg);
    } catch (e) {
      addChat('error', `Batch error on line ${i + 1}: ${e.message}`);
    }

    // Delay between messages (skip on last)
    if (i < total - 1 && delay > 0 && !_batchAbort) {
      await new Promise(r => setTimeout(r, delay));
    }
  }

  $('batchStatus').textContent = _batchAbort ? 'Stopped' : `Done (${total} messages)`;
  $('batchRunBtn').disabled = false;
  $('batchStopBtn').disabled = true;
  _batchRunning = false;
  _batchAbort = false;

  if (currentBatchTest) {
    lastTest = finalizeTest(currentBatchTest);
    currentBatchTest = null;
    if (autoSaveTests) await saveTestReport(lastTest);
  }
}

function bindScenarios() {
  renderPresets();

  // Batch controls
  $('batchRunBtn').onclick = async () => {
    const raw = $('batchInput').value.trim();
    if (!raw) return;
    const messages = raw.split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
    if (messages.length === 0) return;

    const mode = $('batchMode').value;
    const delay = +$('batchDelay').value || 500;

    // Switch to the right tab
    const tabName = mode === 'command' ? 'command' : 'dialogue';
    $$('.tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`.tab[data-tab="${tabName}"]`).classList.add('active');
    activeTab = tabName;
    $('inputArea').classList.remove('hidden');
    $('decisionArea').classList.add('hidden');
    $('npcChatArea').classList.add('hidden');
    $('promptsArea').classList.add('hidden');
    $('scenariosArea').classList.add('hidden');
    $('reportsArea').classList.add('hidden');
    $('chatLog').classList.remove('hidden');

    await runBatchMessages(messages, mode, delay);
  };

  $('batchStopBtn').onclick = () => { _batchAbort = true; };

  // Custom scenario save/load (localStorage)
  loadCustomScenarios();

  $('scenarioSaveBtn').onclick = () => {
    const name = $('scenarioName').value.trim();
    if (!name) return;
    const scenario = {
      name,
      state: {
        cooperation: state.personality.cooperation,
        aggression: state.personality.aggression,
        neuroticism: state.personality.neuroticism,
        trust: state.trust, fear: state.fear, anger: state.anger,
        trust_baseline: state.trust_baseline,
        fear_baseline: state.fear_baseline,
        anger_baseline: state.anger_baseline,
      },
      memories: [...state.memories],
      npcName: state.npcName,
      playerId: state.playerId,
    };
    const saved = getCustomScenarios();
    saved.push(scenario);
    localStorage.setItem('playground_scenarios', JSON.stringify(saved));
    $('scenarioName').value = '';
    renderCustomScenarios(saved);
    addChat('system', `Saved scenario: ${name}`);
  };
}

// ── Reports (Test Lab) ───────────────────────────────────────────────────────
async function loadReportsList() {
  try {
    const res = await fetch('/playground/tests');
    if (!res.ok) return;
    const data = await res.json();
    renderReportsList(data.tests || []);
    populateCompareSelects(data.tests || []);
  } catch (e) {
    console.warn('Failed to load reports', e);
  }
}

function renderReportsList(tests) {
  const list = $('reportsList');
  list.innerHTML = '';
  tests.forEach(t => {
    const div = document.createElement('div');
    div.className = 'report-item';
    div.innerHTML = `
      <div class="title">${esc(t.name || t.id)}</div>
      <div class="meta">${esc(t.created_at || '')} • ${esc(t.mode || '')}</div>
    `;
    div.onclick = async () => {
      $$('.report-item').forEach(i => i.classList.remove('active'));
      div.classList.add('active');
      const res = await fetch(`/playground/tests/${encodeURIComponent(t.id)}`);
      if (res.ok) {
        const test = await res.json();
        renderReportDetail(test);
        renderReportChart(test);
      }
    };
    list.appendChild(div);
  });
}

function populateCompareSelects(tests) {
  const selA = $('compareA');
  const selB = $('compareB');
  const opts = tests.map(t => ({ id: t.id, label: t.name || t.id }));
  selA.innerHTML = '';
  selB.innerHTML = '';
  for (const o of opts) {
    const optA = document.createElement('option');
    optA.value = o.id; optA.textContent = o.label;
    const optB = document.createElement('option');
    optB.value = o.id; optB.textContent = o.label;
    selA.appendChild(optA);
    selB.appendChild(optB);
  }
}

function renderReportDetail(test) {
  const detail = $('reportDetail');
  const summary = test.summary || {};
  detail.innerHTML = `
    <h4>Summary</h4>
    <div>trust Δ: <strong>${summary.trust_delta ?? '—'}</strong> | fear Δ: <strong>${summary.fear_delta ?? '—'}</strong> | anger Δ: <strong>${summary.anger_delta ?? '—'}</strong></div>
    <div>escalation max: <strong>${summary.escalation_max ?? '—'}</strong> | clamp hits: <strong>${summary.clamp_hits ?? '—'}</strong> | memory count: <strong>${summary.memory_count ?? '—'}</strong></div>
    <div style="margin-top:6px">model: <strong>${test.settings?.model || '—'}</strong> | temp: <strong>${test.settings?.temperature ?? '—'}</strong> | tokens: <strong>${test.settings?.max_tokens ?? '—'}</strong></div>
    <div style="margin-top:6px"><strong>Notes</strong>: ${esc(test.notes || '')}</div>
    <pre>${esc(JSON.stringify(test.inputs || [], null, 2))}</pre>
  `;
}

function renderReportChart(test) {
  const ctx = $('reportChart');
  if (!ctx || !window.Chart) return;

  const series = [
    test.initial_state?.emotions?.trust ?? 0,
    ...test.steps.map(s => s.after?.trust ?? null).filter(v => v != null),
  ];
  const seriesF = [
    test.initial_state?.emotions?.fear ?? 0,
    ...test.steps.map(s => s.after?.fear ?? null).filter(v => v != null),
  ];
  const seriesA = [
    test.initial_state?.emotions?.anger ?? 0,
    ...test.steps.map(s => s.after?.anger ?? null).filter(v => v != null),
  ];

  const labels = series.map((_, i) => i.toString());
  if (reportChart) reportChart.destroy();
  reportChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Trust', data: series, borderColor: '#4af', tension: 0.25 },
        { label: 'Fear', data: seriesF, borderColor: '#a855f7', tension: 0.25 },
        { label: 'Anger', data: seriesA, borderColor: '#f44', tension: 0.25 },
      ],
    },
    options: { responsive: true, plugins: { legend: { labels: { color: '#bbb' } } }, scales: { x: { ticks: { color: '#777' } }, y: { ticks: { color: '#777' }, min: 0, max: 1 } } },
  });
}

function renderCompare(data) {
  const detail = $('compareDetail');
  detail.innerHTML = `
    <h4>Compare</h4>
    <div>trust Δ: <strong>${data.diff.trust_delta}</strong> | fear Δ: <strong>${data.diff.fear_delta}</strong> | anger Δ: <strong>${data.diff.anger_delta}</strong></div>
    <div>escalation max: <strong>${data.diff.escalation_max}</strong> | clamp hits: <strong>${data.diff.clamp_hits}</strong></div>
  `;

  const ctx = $('compareChart');
  if (!ctx || !window.Chart) return;
  if (compareChart) compareChart.destroy();

  const labels = data.charts.a.trust.map((_, i) => i.toString());
  compareChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'A Trust', data: data.charts.a.trust, borderColor: '#4af', tension: 0.25 },
        { label: 'B Trust', data: data.charts.b.trust, borderColor: '#4af', borderDash: [6,4], tension: 0.25 },
        { label: 'A Anger', data: data.charts.a.anger, borderColor: '#f44', tension: 0.25 },
        { label: 'B Anger', data: data.charts.b.anger, borderColor: '#f44', borderDash: [6,4], tension: 0.25 },
      ],
    },
    options: { responsive: true, plugins: { legend: { labels: { color: '#bbb' } } }, scales: { x: { ticks: { color: '#777' } }, y: { ticks: { color: '#777' }, min: 0, max: 1 } } },
  });
}

function bindReports() {
  $('reportsRefreshBtn').onclick = loadReportsList;
  $('saveTestBtn').onclick = async () => {
    if (!lastTest) { $('saveStatus').textContent = 'No test to save yet'; return; }
    await saveTestReport(lastTest);
  };
  $('autoSaveTests').onchange = () => {
    autoSaveTests = $('autoSaveTests').checked;
    localStorage.setItem('playground_autosave', autoSaveTests ? '1' : '0');
  };
  autoSaveTests = localStorage.getItem('playground_autosave') === '1';
  $('autoSaveTests').checked = autoSaveTests;

  $('compareBtn').onclick = async () => {
    const idA = $('compareA').value;
    const idB = $('compareB').value;
    if (!idA || !idB || idA === idB) return;
    const res = await fetch(`/playground/compare?id=${encodeURIComponent(idA)}&id2=${encodeURIComponent(idB)}`);
    if (res.ok) {
      const data = await res.json();
      renderCompare(data);
    }
  };

  loadReportsList();
}

function getCustomScenarios() {
  try { return JSON.parse(localStorage.getItem('playground_scenarios') || '[]'); }
  catch { return []; }
}

function loadCustomScenarios() {
  renderCustomScenarios(getCustomScenarios());
}

function renderCustomScenarios(scenarios) {
  const list = $('customScenarioList');
  list.innerHTML = '';
  for (let i = 0; i < scenarios.length; i++) {
    const s = scenarios[i];
    const div = document.createElement('div');
    div.className = 'custom-scenario-item';
    div.innerHTML = `
      <span class="cs-name">${esc(s.name)}</span>
      <button class="small-btn cs-load" data-idx="${i}">Load</button>
      <button class="small-btn cs-export" data-idx="${i}">JSON</button>
      <span class="cs-del" data-idx="${i}">×</span>`;
    list.appendChild(div);
  }

  list.querySelectorAll('.cs-load').forEach(btn => {
    btn.onclick = () => {
      const s = scenarios[+btn.dataset.idx];
      loadState(s.state);
      if (s.npcName) { state.npcName = s.npcName; $('npcName').value = s.npcName; }
      if (s.playerId) { state.playerId = s.playerId; $('playerId').value = s.playerId; }
      if (s.memories) { state.memories = [...s.memories]; renderMemories(); }
      addChat('system', `Loaded custom scenario: ${s.name}`);
    };
  });

  list.querySelectorAll('.cs-export').forEach(btn => {
    btn.onclick = () => {
      const s = scenarios[+btn.dataset.idx];
      const json = JSON.stringify(s, null, 2);
      navigator.clipboard.writeText(json).then(() => {
        addChat('system', `Copied scenario JSON to clipboard`);
      }).catch(() => {
        // Fallback: show in prompt
        window.prompt('Scenario JSON:', json);
      });
    };
  });

  list.querySelectorAll('.cs-del').forEach(btn => {
    btn.onclick = () => {
      scenarios.splice(+btn.dataset.idx, 1);
      localStorage.setItem('playground_scenarios', JSON.stringify(scenarios));
      renderCustomScenarios(scenarios);
    };
  });
}

})();
