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
let numCtx = 4096;

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
  const { temperature = 0.7, maxTokens = 300 } = opts;
  const t0 = performance.now();

  const body = {
    model: currentModel,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    stream: false,
    options: { temperature, num_predict: maxTokens, num_ctx: numCtx },
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
    num_ctx: numCtx,
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
  return actual;
}

function decayTick() {
  const rate = DECAY_RATE * OWNER_DECAY_MULT;
  state.trust = decayToward(state.trust, state.trust_baseline, rate);
  state.fear = decayToward(state.fear, state.fear_baseline, rate);
  state.anger = decayToward(state.anger, state.anger_baseline, rate);
  syncSlidersFromState();
  updateGauges();
  updateRelLabel();
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

// ── Pipelines ─────────────────────────────────────────────────────────────────

async function runDialogue(text) {
  const soul = buildSoulContext();
  const systemPrompt = prompts.dialogue + `\n\nNPC soul:\n${JSON.stringify(soul, null, 2)}`;

  addChat('player', text);
  clearTrace();
  addTrace('Dialogue LLM', `temp=0.7, max_tokens=300`, systemPrompt, text);

  try {
    const { content, metrics } = await callLLM(systemPrompt, text, { temperature: 0.7, maxTokens: 300 });
    addTraceResult(content, metrics);

    const result = extractJSON(content);
    if (result) {
      addChat('npc', result.dialogue || '...');
      const deltas = result.emotion_deltas || {};
      applyDeltas(deltas, 0.4);

      if (result.memory_tag) {
        state.memories.push({ text: result.memory_tag, type: 'dialogue', ts: Date.now(), importance: 1.0 });
        renderMemories();
        addTrace('Memory Stored', result.memory_tag);
      }

      addHistory(`Dialogue: "${text}" → "${result.dialogue}"`);
    } else {
      const cleaned = content.replace(/```[\s\S]*?```/g, '').replace(/[{}"]/g, '').trim();
      addChat('npc', cleaned.length > 2 ? cleaned : '...');
      addTrace('Parse Error', 'Could not extract JSON from response');
    }
  } catch (e) {
    addChat('error', `LLM Error: ${e.message}`);
  }
}

async function runCommand(text) {
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
    addHistory(`Command: "${text}" → ${category} → ${JSON.stringify(final)}`);

  } catch (e) {
    addChat('error', `LLM Error: ${e.message}`);
  }
}

async function runDecision() {
  clearTrace();

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

  addTrace('Decision LLM', 'temp=0.4, max_tokens=400', prompts.decision, userMsg);

  try {
    const { content, metrics } = await callLLM(prompts.decision, userMsg, { temperature: 0.4, maxTokens: 400 });
    addTraceResult(content, metrics);

    const result = extractJSON(content);
    if (result) {
      addChat('system', `Decision: ${result.primary_intent}${result.secondary_intent ? ' + ' + result.secondary_intent : ''}${result.target_id ? ' → ' + result.target_id : ''}`);
      if (result.speech) addChat('npc', result.speech);
      if (result.emotion_delta) applyDeltas(result.emotion_delta, 0.25);
      if (result.memory_candidates) {
        for (const mc of result.memory_candidates) {
          if (mc.importance >= 0.67) {
            state.memories.push({ text: mc.text, type: mc.type || 'event', ts: Date.now(), importance: mc.importance });
          }
        }
        renderMemories();
      }
      addTrace('Decision Result', JSON.stringify(result, null, 2));
      addHistory(`Decision: ${result.primary_intent} (conf: ${result.decision_confidence})`);
    } else {
      addChat('error', 'Could not parse decision JSON');
      addTrace('Parse Error', content);
    }
  } catch (e) {
    addChat('error', `LLM Error: ${e.message}`);
  }
}

async function runNPCChat() {
  clearTrace();

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

  try {
    // Line 1: A speaks
    const sysA = prompts.npc_chat + '\n\n' + contextA;
    const msgA = `Say something to ${nameB} while you're both gathering wood.`;
    addTrace('NPC Chat: A speaks', 'temp=0.8, max_tokens=40', sysA, msgA);
    const { content: lineA, metrics: mA } = await callLLM(sysA, msgA, { temperature: 0.8, maxTokens: 40 });
    addTraceResult(lineA, mA);
    const cleanA = lineA.replace(/^["']|["']$/g, '');
    lines.push({ speaker: nameA, line: cleanA });
    addChat('npc', `${nameA}: ${cleanA}`);

    // Line 2: B responds
    const sysB = prompts.npc_chat + '\n\n' + contextB;
    const msgB = `${nameA} just said: "${cleanA}". Respond briefly.`;
    addTrace('NPC Chat: B responds', 'temp=0.8, max_tokens=40', sysB, msgB);
    const { content: lineB, metrics: mB } = await callLLM(sysB, msgB, { temperature: 0.8, maxTokens: 40 });
    addTraceResult(lineB, mB);
    const cleanB = lineB.replace(/^["']|["']$/g, '');
    lines.push({ speaker: nameB, line: cleanB });
    addChat('npc', `${nameB}: ${cleanB}`);

    // Line 3: 50% chance A replies
    if (Math.random() > 0.5) {
      const msg3 = `${nameB} replied: "${cleanB}". Say one last thing and get back to work.`;
      addTrace('NPC Chat: A reply', 'temp=0.8, max_tokens=30', sysA, msg3);
      const { content: lineA2, metrics: mA2 } = await callLLM(sysA, msg3, { temperature: 0.8, maxTokens: 30 });
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

      addTrace('Chat Impact LLM', 'temp=0.3, max_tokens=200', prompts.chat_impact, impactCtx);
      const { content: impRaw, metrics: impMetrics } = await callLLM(prompts.chat_impact, impactCtx, { temperature: 0.3, maxTokens: 200 });
      addTraceResult(impRaw, impMetrics);

      const impact = extractJSON(impRaw);
      if (impact?.npcA) {
        addChat('system', `Impact on ${nameA}: trust ${fmtDelta(impact.npcA.trust)}, anger ${fmtDelta(impact.npcA.anger)}${impact.npcA.memory_tag ? ' | Memory: ' + impact.npcA.memory_tag : ''}`);
        addChat('system', `Impact on ${nameB}: trust ${fmtDelta(impact.npcB?.trust)}, anger ${fmtDelta(impact.npcB?.anger)}${impact.npcB?.memory_tag ? ' | Memory: ' + impact.npcB.memory_tag : ''}`);
        // Apply A's impact to our state
        applyDeltas({ trust: impact.npcA.trust || 0, fear: 0, anger: impact.npcA.anger || 0 }, 0.3);
        if (impact.npcA.memory_tag) {
          state.memories.push({ text: impact.npcA.memory_tag, type: 'relationship', ts: Date.now(), importance: 0.8 });
          renderMemories();
        }
      }
    }

    addHistory(`NPC Chat: ${nameA} ↔ ${nameB} (${lines.length} lines)`);
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

      $('inputArea').classList.toggle('hidden', activeTab === 'decision' || activeTab === 'npc-chat' || activeTab === 'prompts');
      $('decisionArea').classList.toggle('hidden', activeTab !== 'decision');
      $('npcChatArea').classList.toggle('hidden', activeTab !== 'npc-chat');
      $('promptsArea').classList.toggle('hidden', activeTab !== 'prompts');
      $('chatLog').classList.toggle('hidden', activeTab === 'prompts');
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

  // Add memory
  $('addMemBtn').onclick = () => {
    const text = prompt('Memory text:');
    if (!text) return;
    state.memories.push({ text, type: 'event', ts: Date.now(), importance: 1.0 });
    renderMemories();
  };

  // Reset
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

})();
