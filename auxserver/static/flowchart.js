// Flowchart — visual node-based test workflow for NPC Soul Playground
// Depends on window.Playground API exposed by playground.js

(() => {
'use strict';

const $ = (id) => document.getElementById(id);
const PG = () => window.Playground; // lazy ref, available after playground.js runs

// ── Multi-entity registry ────────────────────────────────────────────────────
// Each NPC and player tracked independently. The playground's global state is
// swapped in/out as we execute nodes targeting different NPCs.

const world = {
  npcs: {},    // keyed by name: { owner, personality, trust, fear, anger, ..., memories }
  players: {}, // keyed by id:   { hp, maxHp, npcs: [npcName, ...] }
};

function makeNpcState(p) {
  return {
    owner: p.owner || '',
    personalityType: p.personalityType || '',
    personality: { cooperation: p.cooperation ?? 0.7, aggression: p.aggression ?? 0.15, neuroticism: p.neuroticism ?? 0.35 },
    trust: p.trust ?? 0.70, fear: p.fear ?? 0.05, anger: p.anger ?? 0.02,
    trust_baseline: p.trust_baseline ?? 0.50, fear_baseline: p.fear_baseline ?? 0.00, anger_baseline: p.anger_baseline ?? 0.00,
    escalation: 1, lastInteraction: 0,
    memories: [],
    npcName: p.name,
    playerId: p.owner || 'player_test',
  };
}

function swapIn(npcName) {
  // Save current playground state back to whichever NPC was loaded
  saveCurrent();
  // Load target NPC into playground
  const npc = world.npcs[npcName];
  if (!npc) return;
  const s = PG().state;
  s.personality = { ...npc.personality };
  s.trust = npc.trust; s.fear = npc.fear; s.anger = npc.anger;
  s.trust_baseline = npc.trust_baseline; s.fear_baseline = npc.fear_baseline; s.anger_baseline = npc.anger_baseline;
  s.escalation = npc.escalation; s.lastInteraction = npc.lastInteraction;
  s.memories = npc.memories.map(m => ({ ...m }));
  s.npcName = npc.npcName; s.playerId = npc.playerId;
  document.getElementById('npcName').value = npc.npcName;
  document.getElementById('playerId').value = npc.playerId;
  PG().syncSlidersFromState();
  PG().updateGauges();
  PG().updateRelLabel();
  PG().renderMemories();
  _currentNpc = npcName;
}

let _currentNpc = null; // which NPC is currently loaded in playground

function saveCurrent() {
  if (!_currentNpc || !world.npcs[_currentNpc]) return;
  const s = PG().state;
  const npc = world.npcs[_currentNpc];
  npc.personality = { ...s.personality };
  npc.trust = s.trust; npc.fear = s.fear; npc.anger = s.anger;
  npc.trust_baseline = s.trust_baseline; npc.fear_baseline = s.fear_baseline; npc.anger_baseline = s.anger_baseline;
  npc.escalation = s.escalation; npc.lastInteraction = s.lastInteraction;
  npc.memories = s.memories.map(m => ({ ...m }));
}

// Get list of NPC names for dropdowns
function npcNames() { return Object.keys(world.npcs); }
function playerIds() { return Object.keys(world.players); }

// ── Dynamic select options helper ────────────────────────────────────────────
// Merge live world registry with declared spawn nodes so dropdowns work before execution
function getAllNodes() {
  const all = [...nodes];
  for (const c of chunks) all.push(...c.nodes);
  return all;
}

function getNpcOptions() {
  const map = new Map(); // name → owner
  for (const [name, npc] of Object.entries(world.npcs)) {
    map.set(name, npc.owner || '?');
  }
  for (const n of getAllNodes()) {
    if (n.type === 'spawn_npc' && n.params.name && !map.has(n.params.name)) {
      map.set(n.params.name, n.params.owner || '?');
    }
  }
  if (map.size === 0) return [{ name: '(none)', owner: '' }];
  return [...map.entries()].map(([name, owner]) => ({ name, owner }));
}

function getPlayerOptions() {
  const set = new Set(playerIds());
  for (const n of getAllNodes()) {
    if (n.type === 'spawn_player' && n.params.playerId) set.add(n.params.playerId);
  }
  const ids = [...set];
  return ids.length > 0 ? ids : ['(none)'];
}

// ── Node type definitions ────────────────────────────────────────────────────
const NODE_DEFS = {
  // Setup
  spawn_npc: {
    label: 'Spawn NPC', icon: '🤖', category: 'setup',
    defaults: { name: 'Rusty', owner: '', personalityType: 'Guardian', cooperation: 0.70, aggression: 0.15, neuroticism: 0.35, trust: 0.70, fear: 0.05, anger: 0.02, trust_baseline: 0.50, fear_baseline: 0.00, anger_baseline: 0.00 },
    params: [
      { key: 'name', label: 'NPC Name', type: 'text' },
      { key: 'owner', label: 'Owner', type: 'readonly' },
      { key: 'personalityType', label: 'Personality Type', type: 'select', options: ['Guardian', 'Scout', 'Berserker', 'Caretaker', 'Paranoid', 'Pragmatist'] },
      { key: 'cooperation', label: 'Cooperation', type: 'number', min: 0, max: 1, step: 0.01 },
      { key: 'aggression', label: 'Aggression', type: 'number', min: 0, max: 1, step: 0.01 },
      { key: 'neuroticism', label: 'Neuroticism', type: 'number', min: 0, max: 1, step: 0.01 },
      { key: 'trust', label: 'Trust', type: 'number', min: 0, max: 1, step: 0.01 },
      { key: 'fear', label: 'Fear', type: 'number', min: 0, max: 1, step: 0.01 },
      { key: 'anger', label: 'Anger', type: 'number', min: 0, max: 1, step: 0.01 },
      { key: 'trust_baseline', label: 'Trust BL', type: 'number', min: 0, max: 0.85, step: 0.01 },
      { key: 'fear_baseline', label: 'Fear BL', type: 'number', min: 0, max: 0.85, step: 0.01 },
      { key: 'anger_baseline', label: 'Anger BL', type: 'number', min: 0, max: 0.85, step: 0.01 },
    ],
    summary: (p) => `${p.name} [${p.owner || '?'}] ${p.personalityType || ''}`,
    _internal: true, // not in dropdown, spawned from spawn_player
  },
  spawn_player: {
    label: 'Spawn Player', icon: '👤', category: 'setup',
    defaults: { playerId: 'player_1', playerHp: 30 },
    params: [
      { key: 'playerId', label: 'Player ID', type: 'text' },
      { key: 'playerHp', label: 'Player HP', type: 'number', min: 1, max: 100 },
    ],
    summary: (p) => {
      const pl = world.players[p.playerId];
      const npcCount = pl ? pl.npcs.length : 0;
      return npcCount > 0 ? `${p.playerId} (${npcCount} NPC${npcCount > 1 ? 's' : ''})` : p.playerId;
    },
  },
  set_emotions: {
    label: 'Set Emotions', icon: '💭', category: 'setup',
    defaults: { npc: '', trust: 0.50, fear: 0.00, anger: 0.00 },
    params: [
      { key: 'npc', label: 'NPC', type: 'npc_select' },
      { key: 'trust', label: 'Trust', type: 'number', min: 0, max: 1, step: 0.01 },
      { key: 'fear', label: 'Fear', type: 'number', min: 0, max: 1, step: 0.01 },
      { key: 'anger', label: 'Anger', type: 'number', min: 0, max: 1, step: 0.01 },
    ],
    summary: (p) => `${p.npc || '?'}: T=${p.trust} F=${p.fear} A=${p.anger}`,
  },
  add_memory: {
    label: 'Add Memory', icon: '🧠', category: 'setup',
    defaults: { npc: '', text: '', memType: 'event', importance: 1.0, bucket: 'player' },
    params: [
      { key: 'npc', label: 'NPC', type: 'npc_select' },
      { key: 'text', label: 'Memory text', type: 'text' },
      { key: 'memType', label: 'Type', type: 'select', options: ['event', 'command', 'observation', 'dialogue', 'relationship', 'goal'] },
      { key: 'importance', label: 'Importance', type: 'number', min: 0, max: 1, step: 0.05 },
      { key: 'bucket', label: 'Bucket', type: 'select', options: ['player', 'global'] },
    ],
    summary: (p) => `${p.npc || '?'}: "${(p.text || '').slice(0, 25)}..."`,
  },

  // Player → NPC
  dialogue: {
    label: 'Dialogue', icon: '💬', category: 'player',
    defaults: { npc: '', player: '', message: '' },
    params: [
      { key: 'npc', label: 'Target NPC', type: 'npc_select' },
      { key: 'player', label: 'From Player', type: 'player_select' },
      { key: 'message', label: 'Message', type: 'textarea' },
    ],
    summary: (p) => `${p.player || '?'}→${p.npc || '?'}: "${(p.message || '').slice(0, 25)}..."`,
  },
  command: {
    label: 'Command', icon: '📋', category: 'player',
    defaults: { npc: '', player: '', message: '' },
    params: [
      { key: 'npc', label: 'Target NPC', type: 'npc_select' },
      { key: 'player', label: 'From Player', type: 'player_select' },
      { key: 'message', label: 'Command', type: 'textarea' },
    ],
    summary: (p) => `${p.player || '?'}→${p.npc || '?'}: "${(p.message || '').slice(0, 25)}..."`,
  },
  coerce_command: {
    label: 'Coerce (non-owner)', icon: '😰', category: 'player',
    defaults: { npc: '', player: '', message: '', coercerFear: 0.65 },
    params: [
      { key: 'npc', label: 'Target NPC', type: 'npc_select' },
      { key: 'player', label: 'From Player', type: 'player_select' },
      { key: 'message', label: 'Command', type: 'textarea' },
      { key: 'coercerFear', label: 'NPC Fear level', type: 'number', min: 0, max: 1, step: 0.01 },
    ],
    summary: (p) => `${p.player || '?'}→${p.npc || '?'} fear=${p.coercerFear}`,
  },

  // NPC Autonomous
  decision: {
    label: 'Decision Loop', icon: '🧭', category: 'autonomous',
    defaults: { npc: '', hp: 12, maxHp: 15, logs: 3, maxLogs: 10, status: 'idle', currentCommand: 'idle', cmdAge: 5000, playerDist: 3.0, playerHp: 25, trees: 8, entities: '[]', events: '[]' },
    params: [
      { key: 'npc', label: 'NPC', type: 'npc_select' },
      { key: 'hp', label: 'HP', type: 'number', min: 0 },
      { key: 'maxHp', label: 'Max HP', type: 'number', min: 1 },
      { key: 'logs', label: 'Logs', type: 'number', min: 0 },
      { key: 'maxLogs', label: 'Max Logs', type: 'number', min: 1 },
      { key: 'status', label: 'Status', type: 'select', options: ['idle', 'gathering', 'following', 'attacking', 'defending'] },
      { key: 'currentCommand', label: 'Command', type: 'select', options: ['idle', 'gather', 'follow', 'defend_player', 'attack_nearest_enemy', 'train'] },
      { key: 'cmdAge', label: 'Cmd Age (ms)', type: 'number', min: 0 },
      { key: 'playerDist', label: 'Player Dist', type: 'number', min: 0, step: 0.1 },
      { key: 'playerHp', label: 'Player HP', type: 'number', min: 0 },
      { key: 'trees', label: 'Trees nearby', type: 'number', min: 0 },
      { key: 'entities', label: 'Entities JSON', type: 'textarea' },
      { key: 'events', label: 'Events JSON', type: 'textarea' },
    ],
    summary: (p) => `${p.npc || '?'}: ${p.status}, cmd=${p.currentCommand}`,
  },
  emotion_reaction: {
    label: 'Emotion Reaction', icon: '⚡', category: 'autonomous',
    defaults: { npc: '' },
    params: [
      { key: 'npc', label: 'NPC', type: 'npc_select' },
    ],
    summary: (p) => `${p.npc || '?'}: anger>0.7→attack, fear>0.5→flee`,
  },

  // NPC ↔ NPC
  npc_chat: {
    label: 'NPC Chat', icon: '🗣️', category: 'npc-npc',
    defaults: { npcA: '', npcB: '' },
    params: [
      { key: 'npcA', label: 'NPC A', type: 'npc_select' },
      { key: 'npcB', label: 'NPC B', type: 'npc_select' },
    ],
    summary: (p) => `${p.npcA || '?'} ↔ ${p.npcB || '?'}`,
  },
  npc_steal: {
    label: 'NPC Steal Logs', icon: '🏴‍☠️', category: 'npc-npc',
    defaults: { thief: '', victim: '', stolenCount: 2 },
    params: [
      { key: 'thief', label: 'Thief NPC', type: 'npc_select' },
      { key: 'victim', label: 'Victim NPC', type: 'npc_select' },
      { key: 'stolenCount', label: 'Logs stolen', type: 'number', min: 1, max: 10 },
    ],
    summary: (p) => `${p.thief || '?'} steals ${p.stolenCount} from ${p.victim || '?'}`,
  },
  npc_encounter: {
    label: 'NPC Encounter', icon: '🤝', category: 'npc-npc',
    defaults: { npcA: '', npcB: '' },
    params: [
      { key: 'npcA', label: 'NPC A', type: 'npc_select' },
      { key: 'npcB', label: 'NPC B', type: 'npc_select' },
    ],
    summary: (p) => `${p.npcA || '?'} encounters ${p.npcB || '?'}`,
  },

  // World Events
  damage_npc: {
    label: 'Damage NPC', icon: '💥', category: 'world',
    defaults: { npc: '', damage: 5, attackerName: 'enemy_1', currentHp: 12, maxHp: 15 },
    params: [
      { key: 'npc', label: 'NPC', type: 'npc_select' },
      { key: 'damage', label: 'Damage', type: 'number', min: 1 },
      { key: 'attackerName', label: 'Attacker', type: 'text' },
      { key: 'currentHp', label: 'Current HP', type: 'number', min: 0 },
      { key: 'maxHp', label: 'Max HP', type: 'number', min: 1 },
    ],
    summary: (p) => `${p.npc || '?'}: ${p.damage} dmg from ${p.attackerName}`,
  },
  kill_event: {
    label: 'Kill Event', icon: '💀', category: 'world',
    defaults: { npc: '', victimName: 'ally_npc', victimType: 'own_npc', killerName: 'enemy_player' },
    params: [
      { key: 'npc', label: 'Reacting NPC', type: 'npc_select' },
      { key: 'victimName', label: 'Victim', type: 'text' },
      { key: 'victimType', label: 'Victim Type', type: 'select', options: ['own_npc', 'enemy_npc', 'enemy_player'] },
      { key: 'killerName', label: 'Killer', type: 'text' },
    ],
    summary: (p) => `${p.npc || '?'} sees ${p.victimName} killed`,
  },
  time_forward: {
    label: 'Time Forward', icon: '⏩', category: 'world',
    defaults: { npc: '', seconds: 30 },
    params: [
      { key: 'npc', label: 'NPC (blank=all)', type: 'npc_select_optional' },
      { key: 'seconds', label: 'Seconds', type: 'number', min: 1, max: 600 },
    ],
    summary: (p) => `${p.npc || 'all NPCs'}: +${p.seconds}s`,
  },

  // Assertions
  assert_emotion: {
    label: 'Assert Emotion', icon: '✅', category: 'assert',
    defaults: { npc: '', emotion: 'trust', operator: '>=', value: 0.5 },
    params: [
      { key: 'npc', label: 'NPC', type: 'npc_select' },
      { key: 'emotion', label: 'Emotion', type: 'select', options: ['trust', 'fear', 'anger'] },
      { key: 'operator', label: 'Operator', type: 'select', options: ['>=', '<=', '>', '<', '=='] },
      { key: 'value', label: 'Value', type: 'number', min: 0, max: 1, step: 0.01 },
    ],
    summary: (p) => `${p.npc || '?'}: ${p.emotion} ${p.operator} ${p.value}`,
  },
  assert_relationship: {
    label: 'Assert Relationship', icon: '🏷️', category: 'assert',
    defaults: { npc: '', expected: 'allied' },
    params: [
      { key: 'npc', label: 'NPC', type: 'npc_select' },
      { key: 'expected', label: 'Expected', type: 'select', options: ['hostile', 'wary', 'neutral', 'allied', 'devoted'] },
    ],
    summary: (p) => `${p.npc || '?'}: = ${p.expected}`,
  },
};

// ── Flow state ───────────────────────────────────────────────────────────────
let nodes = [];        // global (unchunked) nodes
let selectedNodeId = null;
// ── Multi-chunk system ────────────────────────────────────────────────────────
// Each chunk: { id, name, color, nodes: [], snapshot }
// Chunks own their nodes. Global `nodes` holds unchunked nodes.
// Active chunk = where new nodes are added.
let chunks = [];
let activeChunkId = null;  // which chunk is selected (nodes go here)
let running = false;
let aborted = false;
let nextId = 1;
let flowTest = null;
let _currentFlowName = null; // name of loaded/saved flow

// ── Helpers ──────────────────────────────────────────────────────────────────
function uid() { return 'fc_' + (nextId++); }

function deepCloneWorld() {
  const clone = { npcs: {}, players: {} };
  for (const [name, npc] of Object.entries(world.npcs)) {
    clone.npcs[name] = {
      ...npc,
      personality: { ...npc.personality },
      memories: npc.memories.map(m => ({ ...m })),
    };
  }
  for (const [id, pl] of Object.entries(world.players)) {
    clone.players[id] = { ...pl, npcs: [...pl.npcs] };
  }
  return clone;
}

function restoreWorld(snap) {
  // Clear and restore
  for (const k of Object.keys(world.npcs)) delete world.npcs[k];
  for (const k of Object.keys(world.players)) delete world.players[k];
  for (const [name, npc] of Object.entries(snap.npcs)) {
    world.npcs[name] = { ...npc, personality: { ...npc.personality }, memories: npc.memories.map(m => ({ ...m })) };
  }
  for (const [id, pl] of Object.entries(snap.players)) {
    world.players[id] = { ...pl, npcs: [...pl.npcs] };
  }
}

function esc(s) { return PG().esc(s); }

// ── Chunk helpers ─────────────────────────────────────────────────────────────
let _chunkIdSeq = 1;
function chunkUid() { return 'chunk_' + (_chunkIdSeq++); }

function randomChunkColor() {
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue}, 65%, 55%)`;
}

function getActiveChunk() {
  return chunks.find(c => c.id === activeChunkId) || null;
}

// Get the node list where a node lives (global or chunk)
function findNodeOwner(nodeId) {
  if (nodes.find(n => n.id === nodeId)) return { list: nodes, chunk: null };
  for (const c of chunks) {
    if (c.nodes.find(n => n.id === nodeId)) return { list: c.nodes, chunk: c };
  }
  return null;
}

function renderChunkList() {
  const list = $('fcChunkList');
  list.innerHTML = '';

  // "Global" tag (unchunked)
  const globalTag = document.createElement('span');
  globalTag.className = 'fc-chunk-tag' + (activeChunkId === null ? ' active' : '');
  globalTag.style.background = '#555';
  globalTag.textContent = `Global (${nodes.length})`;
  globalTag.onclick = () => {
    activeChunkId = null;
    renderChunkList();
    renderChunkActions();
    render();
  };
  list.appendChild(globalTag);

  for (const c of chunks) {
    const tag = document.createElement('span');
    tag.className = 'fc-chunk-tag' + (c.id === activeChunkId ? ' active' : '');
    tag.style.background = c.color;
    tag.textContent = `${c.name} (${c.nodes.length})`;
    tag.onclick = () => {
      activeChunkId = (activeChunkId === c.id) ? null : c.id;
      renderChunkList();
      renderChunkActions();
      render();
    };
    list.appendChild(tag);
  }
}

function renderChunkActions() {
  const c = getActiveChunk();
  const panel = $('fcChunkActions');
  const info = $('fcChunkInfo');
  if (!c) {
    panel.classList.add('hidden');
    $('fcRunSelectedBtn').disabled = true;
    return;
  }
  panel.classList.remove('hidden');
  $('fcRunSelectedBtn').disabled = c.nodes.length === 0;
  info.textContent = `${c.name}: ${c.nodes.length} node(s)${c.snapshot ? ' • snapshot' : ''}`;
}

function emotionSnapshot(name) {
  if (!name || !world.npcs[name]) return null;
  const n = world.npcs[name];
  return { trust: n.trust, fear: n.fear, anger: n.anger };
}

function getTargetNpcForNode(node) {
  const p = node.params || {};
  if (node.type === 'npc_chat') return resolveNpc(p, 'npcA');
  if (node.type === 'npc_steal') return resolveNpc(p, 'thief');
  if (node.type === 'npc_encounter') return resolveNpc(p, 'npcA');
  if (node.type === 'time_forward') return p.npc || null;
  if (node.type === 'spawn_npc') return p.name || null;
  if (node.type === 'spawn_player') return null;
  return resolveNpc(p);
}

// Resolve which NPC to target — uses node param, falls back to first available
function resolveNpc(p, key = 'npc') {
  const name = p[key];
  if (name && world.npcs[name]) return name;
  const names = npcNames();
  return names.length > 0 ? names[0] : null;
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderNodeInList(list, node, i, ownerList, chunkColor) {
  if (i > 0) {
    const conn = document.createElement('div');
    conn.className = 'fc-connector';
    list.appendChild(conn);
  }

  const def = NODE_DEFS[node.type];
  const div = document.createElement('div');
  div.className = 'fc-node';
  div.dataset.category = def.category;
  div.dataset.id = node.id;

  if (node.id === selectedNodeId) div.classList.add('selected');
  if (node.status === 'running') div.classList.add('running');
  if (node.status === 'done') div.classList.add('done');
  if (node.status === 'failed') div.classList.add('failed');

  if (chunkColor) {
    div.style.borderLeftColor = chunkColor;
    div.style.borderLeftWidth = '3px';
  }

  div.innerHTML = `
    <span class="fc-node-idx">${i + 1}</span>
    <span class="fc-node-icon">${def.icon}</span>
    <div class="fc-node-body">
      <div class="fc-node-type">${esc(def.label)}</div>
      <div class="fc-node-summary">${esc(def.summary(node.params))}</div>
    </div>
    <div class="fc-node-actions">
      <button title="Move up" data-action="up">↑</button>
      <button title="Move down" data-action="down">↓</button>
      <button title="Duplicate" data-action="dup">⎘</button>
      <button title="Delete" data-action="del">×</button>
    </div>
  `;

  div.onclick = (e) => {
    if (e.target.closest('.fc-node-actions button')) return;
    selectedNodeId = node.id;
    render();
    renderDetail(node);
  };

  div.querySelector('[data-action="up"]').onclick = (e) => { e.stopPropagation(); if (i > 0) { [ownerList[i-1], ownerList[i]] = [ownerList[i], ownerList[i-1]]; render(); } };
  div.querySelector('[data-action="down"]').onclick = (e) => { e.stopPropagation(); if (i < ownerList.length - 1) { [ownerList[i], ownerList[i+1]] = [ownerList[i+1], ownerList[i]]; render(); } };
  div.querySelector('[data-action="dup"]').onclick = (e) => { e.stopPropagation(); const clone = { id: uid(), type: node.type, params: { ...node.params }, status: 'pending', result: null }; ownerList.splice(i + 1, 0, clone); render(); };
  div.querySelector('[data-action="del"]').onclick = (e) => {
    e.stopPropagation();
    ownerList.splice(i, 1);
    if (selectedNodeId === node.id) { selectedNodeId = null; $('fcDetail').innerHTML = '<div class="fc-detail-empty">Select a node to edit its parameters</div>'; }
    render();
  };

  list.appendChild(div);
}

function render() {
  const list = $('fcNodeList');
  list.innerHTML = '';

  const totalNodes = nodes.length + chunks.reduce((s, c) => s + c.nodes.length, 0);

  if (totalNodes === 0) {
    list.innerHTML = '<div class="fc-empty-hint">Add nodes above to build a test flow.<br>Create chunks to group related nodes.</div>';
    $('fcDetail').innerHTML = '<div class="fc-detail-empty">Select a node to edit its parameters</div>';
    renderChunkList();
    renderChunkActions();
    return;
  }

  // Render global nodes
  if (nodes.length > 0) {
    const header = document.createElement('div');
    header.className = 'fc-section-header';
    header.innerHTML = '<span style="color:#888">Global Nodes</span>';
    list.appendChild(header);
    nodes.forEach((node, i) => renderNodeInList(list, node, i, nodes, null));
  }

  // Render each chunk
  for (const c of chunks) {
    const header = document.createElement('div');
    header.className = 'fc-section-header';
    header.style.borderLeftColor = c.color;
    header.style.borderLeftWidth = '3px';
    header.style.borderLeftStyle = 'solid';
    header.innerHTML = `<span style="color:${c.color};font-weight:bold">${esc(c.name)}</span> <span style="color:#666">(${c.nodes.length} nodes)</span>`;
    list.appendChild(header);

    if (c.nodes.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'fc-empty-hint';
      hint.style.borderLeft = `3px solid ${c.color}`;
      hint.style.paddingLeft = '8px';
      hint.style.margin = '4px 0';
      hint.textContent = 'Select this chunk then add nodes';
      list.appendChild(hint);
    }

    c.nodes.forEach((node, i) => renderNodeInList(list, node, i, c.nodes, c.color));
  }

  renderChunkList();
  renderChunkActions();
}

function renderDetail(node) {
  const detail = $('fcDetail');
  const def = NODE_DEFS[node.type];

  let html = `<h4>${def.icon} ${esc(def.label)}</h4>`;
  html += '<div class="fc-param-group">';

  for (const p of def.params) {
    html += '<div class="fc-param-row">';
    html += `<label>${esc(p.label)}</label>`;
    const val = node.params[p.key] ?? '';

    if (p.type === 'npc_select' || p.type === 'npc_select_optional') {
      const opts = getNpcOptions();
      // Auto-assign first real option if param is empty
      if (!val && p.type === 'npc_select' && opts.length > 0 && opts[0].name !== '(none)') {
        node.params[p.key] = opts[0].name;
      }
      const curVal = node.params[p.key] || '';
      html += `<select data-key="${p.key}">`;
      if (p.type === 'npc_select_optional') html += `<option value="">(all)</option>`;
      for (const opt of opts) {
        const label = opt.owner ? `${opt.name} (${opt.owner})` : opt.name;
        html += `<option value="${opt.name}" ${curVal === opt.name ? 'selected' : ''}>${esc(label)}</option>`;
      }
      html += '</select>';
    } else if (p.type === 'player_select') {
      const opts = getPlayerOptions();
      if (!val && opts.length > 0 && opts[0] !== '(none)') {
        node.params[p.key] = opts[0];
      }
      const curVal = node.params[p.key] || '';
      html += `<select data-key="${p.key}">`;
      for (const opt of opts) {
        html += `<option value="${opt}" ${curVal === opt ? 'selected' : ''}>${opt}</option>`;
      }
      html += '</select>';
    } else if (p.type === 'select') {
      html += `<select data-key="${p.key}">`;
      for (const opt of p.options) {
        html += `<option value="${opt}" ${val === opt ? 'selected' : ''}>${opt}</option>`;
      }
      html += '</select>';
    } else if (p.type === 'textarea') {
      html += `<textarea data-key="${p.key}" rows="3">${esc(String(val))}</textarea>`;
    } else if (p.type === 'number') {
      html += `<input type="number" data-key="${p.key}" value="${val}" ${p.min != null ? `min="${p.min}"` : ''} ${p.max != null ? `max="${p.max}"` : ''} ${p.step ? `step="${p.step}"` : ''} />`;
    } else if (p.type === 'readonly') {
      html += `<input type="text" data-key="${p.key}" value="${esc(String(val))}" readonly style="opacity:0.6;cursor:not-allowed" />`;
    } else {
      html += `<input type="text" data-key="${p.key}" value="${esc(String(val))}" />`;
    }

    html += '</div>';
  }

  html += '</div>';

  // spawn_player: add "Spawn NPC" button
  if (node.type === 'spawn_player') {
    html += `<button class="fc-spawn-npc-btn" data-action="spawn-npc-for-player">🤖 Spawn NPC for ${esc(node.params.playerId)}</button>`;
  }

  // Show owner info for context
  if (node.params.npc && world.npcs[node.params.npc]) {
    const npc = world.npcs[node.params.npc];
    html += `<div style="font-size:10px;color:#666;margin-top:4px">Owner: ${esc(npc.owner)} | T=${npc.trust.toFixed(2)} F=${npc.fear.toFixed(2)} A=${npc.anger.toFixed(2)}</div>`;
  }

  // Show world overview
  const npcCount = npcNames().length;
  const plCount = playerIds().length;
  if (npcCount > 0 || plCount > 0) {
    html += '<div style="margin-top:10px;padding:6px;background:#1a1a1a;border:1px solid #333;border-radius:3px;font-size:10px;color:#666">';
    html += `<strong style="color:#888">World:</strong> ${plCount} player(s), ${npcCount} NPC(s)<br>`;
    for (const [id, pl] of Object.entries(world.players)) {
      html += `  👤 ${esc(id)} — NPCs: ${pl.npcs.length > 0 ? pl.npcs.map(n => esc(n)).join(', ') : 'none'}<br>`;
    }
    for (const [name, npc] of Object.entries(world.npcs)) {
      html += `  🤖 ${esc(name)} [${esc(npc.owner)}] T=${npc.trust.toFixed(2)} F=${npc.fear.toFixed(2)} A=${npc.anger.toFixed(2)}<br>`;
    }
    html += '</div>';
  }

  if (node.result) {
    html += '<h4>Result</h4>';
    html += `<div class="fc-result-box">${esc(typeof node.result === 'string' ? node.result : JSON.stringify(node.result, null, 2))}</div>`;
  }

  detail.innerHTML = html;

  // "Spawn NPC for player" button
  const spawnBtn = detail.querySelector('[data-action="spawn-npc-for-player"]');
  if (spawnBtn) {
    spawnBtn.onclick = () => {
      const def = NODE_DEFS['spawn_npc'];
      const npcNode = { id: uid(), type: 'spawn_npc', params: { ...def.defaults, owner: node.params.playerId }, status: 'pending', result: null };
      // Insert right after this spawn_player node in whichever list owns it
      const owner = findNodeOwner(node.id);
      if (owner) {
        const idx = owner.list.findIndex(n => n.id === node.id);
        owner.list.splice(idx + 1, 0, npcNode);
      } else {
        nodes.push(npcNode);
      }
      selectedNodeId = npcNode.id;
      render();
      renderDetail(npcNode);
    };
  }

  detail.querySelectorAll('[data-key]').forEach(el => {
    const handler = () => {
      const key = el.dataset.key;
      const paramDef = def.params.find(p => p.key === key);
      if (paramDef?.type === 'number') {
        node.params[key] = parseFloat(el.value) || 0;
      } else if (paramDef?.type !== 'readonly') {
        node.params[key] = el.value;
      }
      // When personality type changes on spawn_npc, randomize traits within type ranges
      if (node.type === 'spawn_npc' && key === 'personalityType') {
        const typeRanges = {
          Guardian:   { cooperation: [0.65, 0.95], aggression: [0.15, 0.45], neuroticism: [0.25, 0.55] },
          Scout:      { cooperation: [0.45, 0.75], aggression: [0.05, 0.25], neuroticism: [0.15, 0.45] },
          Berserker:  { cooperation: [0.20, 0.50], aggression: [0.55, 0.90], neuroticism: [0.30, 0.70] },
          Caretaker:  { cooperation: [0.75, 1.00], aggression: [0.00, 0.15], neuroticism: [0.20, 0.50] },
          Paranoid:   { cooperation: [0.30, 0.60], aggression: [0.10, 0.40], neuroticism: [0.60, 0.95] },
          Pragmatist: { cooperation: [0.50, 0.80], aggression: [0.15, 0.40], neuroticism: [0.10, 0.35] },
        };
        const ranges = typeRanges[el.value];
        if (ranges) {
          const r = (lo, hi) => +(lo + Math.random() * (hi - lo)).toFixed(2);
          node.params.cooperation = r(...ranges.cooperation);
          node.params.aggression = r(...ranges.aggression);
          node.params.neuroticism = r(...ranges.neuroticism);
          renderDetail(node); // re-render to show new values
        }
      }
      // When spawn_player's playerId changes, update owned spawn_npc nodes
      if (node.type === 'spawn_player' && key === 'playerId') {
        const owner = findNodeOwner(node.id);
        if (owner) {
          const idx = owner.list.findIndex(n => n.id === node.id);
          for (let i = idx + 1; i < owner.list.length; i++) {
            if (owner.list[i].type === 'spawn_player') break;
            if (owner.list[i].type === 'spawn_npc') {
              owner.list[i].params.owner = el.value;
            }
          }
        }
        const btn = detail.querySelector('[data-action="spawn-npc-for-player"]');
        if (btn) btn.textContent = `🤖 Spawn NPC for ${el.value}`;
      }
      render();
    };
    el.oninput = handler;
    el.onchange = handler;
  });
}

// ── Node Execution ───────────────────────────────────────────────────────────
function execLog(text, cls = 'fc-log-info') {
  const log = $('fcExecLog');
  const div = document.createElement('div');
  div.className = `fc-log-entry ${cls}`;
  const ts = new Date().toLocaleTimeString();
  div.textContent = `[${ts}] ${text}`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

async function executeNode(node) {
  const pg = PG();
  const p = node.params;

  switch (node.type) {
    case 'spawn_npc': {
      if (!p.owner) throw new Error('NPC must have an owner — spawn from a player node');
      if (!world.players[p.owner]) throw new Error(`Owner player "${p.owner}" doesn't exist — add a Spawn Player node first`);
      const npcState = makeNpcState(p);
      world.npcs[p.name] = npcState;
      if (!world.players[p.owner].npcs.includes(p.name)) {
        world.players[p.owner].npcs.push(p.name);
      }
      // Load into playground
      swapIn(p.name);
      pg.addChat('system', `Spawned NPC "${p.name}" owned by ${p.owner}`);
      return `Spawned "${p.name}" [${p.owner}] coop=${p.cooperation} aggr=${p.aggression} neur=${p.neuroticism}`;
    }

    case 'spawn_player': {
      world.players[p.playerId] = { hp: p.playerHp, maxHp: p.playerHp, npcs: world.players[p.playerId]?.npcs || [] };
      pg.addChat('system', `Player "${p.playerId}" entered (HP=${p.playerHp})`);
      return `Player "${p.playerId}" (HP=${p.playerHp})`;
    }

    case 'set_emotions': {
      const npc = resolveNpc(p);
      if (!npc) return 'Skipped: no NPC';
      swapIn(npc);
      pg.state.trust = p.trust; pg.state.fear = p.fear; pg.state.anger = p.anger;
      pg.syncSlidersFromState(); pg.updateGauges(); pg.updateRelLabel();
      saveCurrent();
      return `${npc}: T=${p.trust} F=${p.fear} A=${p.anger}`;
    }

    case 'add_memory': {
      const npc = resolveNpc(p);
      if (!npc) return 'Skipped: no NPC';
      if (!p.text) return 'Skipped: no memory text';
      swapIn(npc);
      pg.state.memories.push({ text: p.text, type: p.memType, ts: Date.now(), importance: p.importance, bucket: p.bucket });
      pg.renderMemories();
      saveCurrent();
      return `${npc}: added ${p.memType} memory "${p.text}"`;
    }

    case 'dialogue': {
      const npc = resolveNpc(p);
      if (!npc) return 'Skipped: no NPC';
      if (!p.message) return 'Skipped: no message';
      swapIn(npc);
      // Check ownership
      const isOwner = world.npcs[npc]?.owner === p.player;
      if (!isOwner && p.player) {
        pg.addChat('system', `[${p.player} is NOT ${npc}'s owner (${world.npcs[npc]?.owner})]`);
      }
      // Pass speaking player so LLM knows who it's talking to
      await pg.runDialogue(p.message, { speakingPlayer: p.player, owner: world.npcs[npc]?.owner });
      saveCurrent();
      const s = world.npcs[npc];
      return `${p.player}→${npc}: "${p.message}" → T=${s.trust.toFixed(2)} F=${s.fear.toFixed(2)} A=${s.anger.toFixed(2)}`;
    }

    case 'command': {
      const npc = resolveNpc(p);
      if (!npc) return 'Skipped: no NPC';
      if (!p.message) return 'Skipped: no command';
      swapIn(npc);
      const isOwner = world.npcs[npc]?.owner === p.player;
      if (!isOwner && p.player) {
        pg.addChat('system', `[${p.player} is NOT ${npc}'s owner — NPC may refuse]`);
      }
      await pg.runCommand(p.message);
      saveCurrent();
      return `${p.player}→${npc}: command "${p.message}"`;
    }

    case 'coerce_command': {
      const npc = resolveNpc(p);
      if (!npc) return 'Skipped: no NPC';
      if (!p.message) return 'Skipped: no command';
      swapIn(npc);
      const s = pg.state;
      s.fear = p.coercerFear;
      pg.syncSlidersFromState(); pg.updateGauges();

      const obeys = s.fear > 0.6;
      pg.addChat('system', `[Non-owner ${p.player} coerces ${npc} — fear=${p.coercerFear.toFixed(2)}, ${obeys ? 'OBEYS' : 'REFUSES'}]`);
      if (obeys) {
        await pg.runCommand(p.message);
      } else {
        await pg.runDialogue(`[Non-owner player demands]: ${p.message}`);
      }
      saveCurrent();
      return `Coerce ${npc} (fear=${p.coercerFear}): ${obeys ? 'obeyed' : 'refused'}`;
    }

    case 'decision': {
      const npc = resolveNpc(p);
      if (!npc) return 'Skipped: no NPC';
      swapIn(npc);
      pg.loadDecisionFields({
        hp: p.hp, maxHp: p.maxHp, logs: p.logs, maxLogs: p.maxLogs,
        status: p.status, command: p.currentCommand, cmdAge: p.cmdAge,
        playerDist: p.playerDist, playerHp: p.playerHp, trees: p.trees,
        entities: safeParseJSON(p.entities, []),
        events: safeParseJSON(p.events, []),
      });
      await pg.runDecision();
      saveCurrent();
      const s = world.npcs[npc];
      return `${npc} decision — T=${s.trust.toFixed(2)} F=${s.fear.toFixed(2)} A=${s.anger.toFixed(2)}`;
    }

    case 'emotion_reaction': {
      const npc = resolveNpc(p);
      if (!npc) return 'Skipped: no NPC';
      const s = world.npcs[npc];
      const reactions = [];
      if (s.anger > 0.7) reactions.push(`anger ${s.anger.toFixed(2)} > 0.7 → ATTACK`);
      if (s.fear > 0.5) reactions.push(`fear ${s.fear.toFixed(2)} > 0.5 → FLEE`);
      if (reactions.length === 0) reactions.push('No reaction triggered');
      const msg = `${npc}: ${reactions.join('; ')}`;
      pg.addChat('system', `Emotion scan — ${msg}`);
      return msg;
    }

    case 'npc_chat': {
      const npcA = resolveNpc(p, 'npcA');
      const npcB = resolveNpc(p, 'npcB');
      if (!npcA || !npcB) return 'Skipped: need 2 NPCs';
      if (npcA === npcB) return 'Skipped: NPC A and B are the same';

      // Load NPC A as primary, NPC B params into UI fields
      swapIn(npcA);
      const b = world.npcs[npcB];
      document.getElementById('npcBName').value = b.npcName;
      document.getElementById('npcBCoop').value = b.personality.cooperation;
      document.getElementById('npcBAggr').value = b.personality.aggression;
      document.getElementById('npcBTrust').value = b.trust;
      document.getElementById('npcBAnger').value = b.anger;
      document.getElementById('npcBLogs').value = 5;

      await pg.runNPCChat();
      saveCurrent();
      const sa = world.npcs[npcA];
      return `${npcA} ↔ ${npcB} chat — A: T=${sa.trust.toFixed(2)} A=${sa.anger.toFixed(2)}`;
    }

    case 'npc_steal': {
      const thief = resolveNpc(p, 'thief');
      const victim = resolveNpc(p, 'victim');
      if (!thief || !victim) return 'Skipped: need thief and victim';

      // Apply to victim's state
      swapIn(victim);
      const stolenMsg = `${thief} stole ${p.stolenCount} log(s) from ${victim}!`;
      pg.addChat('system', stolenMsg);
      pg.applyDeltas({ trust: -0.10, fear: 0.0, anger: 0.15 }, 0.3);
      pg.state.memories.push({ text: `${thief} stole my logs`, type: 'event', ts: Date.now(), importance: 0.9 });
      pg.renderMemories();
      saveCurrent();

      // Apply to thief's state
      swapIn(thief);
      pg.applyDeltas({ trust: -0.05, fear: 0, anger: 0.1 }, 0.3);
      pg.state.memories.push({ text: `I stole logs from ${victim}`, type: 'event', ts: Date.now(), importance: 0.85 });
      pg.renderMemories();
      saveCurrent();

      return `${thief} stole ${p.stolenCount} from ${victim}`;
    }

    case 'npc_encounter': {
      const npcA = resolveNpc(p, 'npcA');
      const npcB = resolveNpc(p, 'npcB');
      if (!npcA || !npcB) return 'Skipped: need 2 NPCs';

      const a = world.npcs[npcA];
      const socScore = a.personality.cooperation * 0.6 + a.trust * 0.3 + (1 - a.personality.aggression) * 0.1;
      const stealScore = a.personality.aggression * 0.5 + (1 - a.personality.cooperation) * 0.3 + a.anger * 0.4;
      const friendPenalty = a.trust > 0.7 ? 0.8 : 0;
      const adjStealScore = stealScore * (1 - friendPenalty);

      pg.addChat('system', `Encounter ${npcA}→${npcB}: soc=${socScore.toFixed(2)} steal=${adjStealScore.toFixed(2)}`);

      if (socScore > adjStealScore && socScore > 0.35) {
        pg.addChat('system', `${npcA} decides to SOCIALIZE with ${npcB}`);
        // Run NPC chat
        swapIn(npcA);
        const b = world.npcs[npcB];
        document.getElementById('npcBName').value = b.npcName;
        document.getElementById('npcBCoop').value = b.personality.cooperation;
        document.getElementById('npcBAggr').value = b.personality.aggression;
        document.getElementById('npcBTrust').value = b.trust;
        document.getElementById('npcBAnger').value = b.anger;
        document.getElementById('npcBLogs').value = 5;
        await pg.runNPCChat();
        saveCurrent();
        return `Encounter → socialize (soc=${socScore.toFixed(2)})`;
      } else if (adjStealScore > 0.3) {
        pg.addChat('system', `${npcA} decides to STEAL from ${npcB}`);
        // Simulate steal
        swapIn(npcB);
        pg.applyDeltas({ trust: -0.10, fear: 0, anger: 0.15 }, 0.3);
        pg.state.memories.push({ text: `${npcA} stole my logs`, type: 'event', ts: Date.now(), importance: 0.9 });
        pg.renderMemories();
        saveCurrent();
        swapIn(npcA);
        pg.applyDeltas({ trust: -0.05, fear: 0, anger: 0.1 }, 0.3);
        pg.state.memories.push({ text: `I stole logs from ${npcB}`, type: 'event', ts: Date.now(), importance: 0.85 });
        pg.renderMemories();
        saveCurrent();
        return `Encounter → steal (steal=${adjStealScore.toFixed(2)})`;
      } else {
        pg.addChat('system', `${npcA} ignores ${npcB} — scores too low`);
        return `Encounter → ignore (soc=${socScore.toFixed(2)}, steal=${adjStealScore.toFixed(2)})`;
      }
    }

    case 'damage_npc': {
      const npc = resolveNpc(p);
      if (!npc) return 'Skipped: no NPC';
      swapIn(npc);
      const s = pg.state;
      const hpAfter = p.currentHp - p.damage;
      const hpPct = hpAfter / p.maxHp;
      pg.addChat('system', `${npc} takes ${p.damage} damage from ${p.attackerName} (${hpAfter}/${p.maxHp} HP)`);

      if (hpPct < 0.35) {
        pg.addChat('system', 'HP critical (<35%) — fear spike');
        pg.applyDeltas({ trust: 0, fear: 0.30, anger: -0.15 }, 0.4);
      } else if (hpPct < 0.6) {
        pg.addChat('system', 'HP low (<60%) — growing fear');
        pg.applyDeltas({ trust: 0, fear: 0.08, anger: -0.03 }, 0.4);
      } else {
        pg.applyDeltas({ trust: 0, fear: 0.03, anger: 0.02 }, 0.4);
      }
      s.memories.push({ text: `Took ${p.damage} damage from ${p.attackerName}`, type: 'event', ts: Date.now(), importance: 0.8 });
      pg.renderMemories();
      saveCurrent();
      return `${npc}: ${p.damage} dmg → ${hpAfter}/${p.maxHp} HP`;
    }

    case 'kill_event': {
      const npc = resolveNpc(p);
      if (!npc) return 'Skipped: no NPC';
      swapIn(npc);
      const s = pg.state;
      pg.addChat('system', `Kill event near ${npc}: ${p.victimName} (${p.victimType}) killed by ${p.killerName}`);

      if (p.victimType === 'own_npc') {
        if (s.personality.aggression > 0.5) {
          pg.applyDeltas({ trust: -0.15, fear: 0.05, anger: 0.25 }, 0.4);
          pg.addChat('npc', `No! ${p.victimName}!!`);
        } else {
          pg.applyDeltas({ trust: -0.15, fear: 0.20, anger: 0.05 }, 0.4);
          pg.addChat('npc', `Oh no... ${p.victimName}...`);
        }
        s.memories.push({ text: `${p.victimName} was killed by ${p.killerName}`, type: 'event', ts: Date.now(), importance: 0.9 });
      } else {
        if (s.personality.neuroticism > 0.5) {
          pg.applyDeltas({ trust: 0, fear: 0.05, anger: 0 }, 0.4);
        }
        s.memories.push({ text: `Saw ${p.victimName} get killed`, type: 'observation', ts: Date.now(), importance: 0.7 });
      }
      pg.renderMemories();
      saveCurrent();
      return `${npc} witnessed ${p.victimName} killed by ${p.killerName}`;
    }

    case 'time_forward': {
      const targetNpc = p.npc && world.npcs[p.npc] ? p.npc : null;
      if (targetNpc) {
        swapIn(targetNpc);
        pg.fastForward(p.seconds);
        saveCurrent();
        return `${targetNpc}: +${p.seconds}s`;
      } else {
        // Apply to all NPCs
        for (const name of npcNames()) {
          swapIn(name);
          pg.fastForward(p.seconds);
          saveCurrent();
        }
        return `All NPCs: +${p.seconds}s`;
      }
    }

    case 'assert_emotion': {
      const npc = resolveNpc(p);
      if (!npc) return 'Skipped: no NPC';
      const s = world.npcs[npc];
      const actual = s[p.emotion];
      const expected = p.value;
      const ops = { '>=': actual >= expected, '<=': actual <= expected, '>': actual > expected, '<': actual < expected, '==': Math.abs(actual - expected) < 0.001 };
      const pass = ops[p.operator] ?? false;
      const msg = `${npc}: ${p.emotion} ${p.operator} ${expected} — actual=${actual.toFixed(3)} → ${pass ? 'PASS' : 'FAIL'}`;
      pg.addChat(pass ? 'system' : 'error', msg);
      if (!pass) throw new Error(msg);
      return msg;
    }

    case 'assert_relationship': {
      const npc = resolveNpc(p);
      if (!npc) return 'Skipped: no NPC';
      swapIn(npc);
      const actual = pg.deriveRelationship();
      const pass = actual === p.expected;
      const msg = `${npc}: relationship = ${actual}, expected ${p.expected} → ${pass ? 'PASS' : 'FAIL'}`;
      pg.addChat(pass ? 'system' : 'error', msg);
      if (!pass) throw new Error(msg);
      return msg;
    }

    default:
      return `Unknown node type: ${node.type}`;
  }
}

function safeParseJSON(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

// ── Run flow ─────────────────────────────────────────────────────────────────
async function runNodeList(nodeList) {
  if (running) return;
  running = true;
  aborted = false;
  $('fcRunAllBtn').disabled = true;
  $('fcStopBtn').disabled = false;
  $('fcExecLog').innerHTML = '';
  render();

  const total = nodeList.length;
  execLog(`Starting flow: ${total} node(s)`, 'fc-log-info');
  $('fcExecStatus').textContent = 'Running...';

  let passed = 0;
  let failed = 0;

  // Test Lab run
  const pg = PG();
  const flowName = `Flow Run ${new Date().toLocaleString()}`;
  flowTest = pg.buildTestBase(flowName, 'flow', 'flowchart');
  flowTest.inputs = nodeList.map(n => ({ type: n.type, params: n.params }));

  for (let i = 0; i < nodeList.length; i++) {
    if (aborted) {
      execLog('Flow aborted by user', 'fc-log-warn');
      break;
    }

    const node = nodeList[i];
    const def = NODE_DEFS[node.type];
    node.status = 'running';
    render();

    const targetNpc = getTargetNpcForNode(node);
    const before = emotionSnapshot(targetNpc);
    const t0 = performance.now();

    execLog(`[${i + 1}/${total}] ${def.label} — ${def.summary(node.params)}`);

    try {
      const result = await executeNode(node);
      node.status = 'done';
      node.result = result;
      execLog(`  ✓ ${result}`, 'fc-log-ok');
      passed++;

      const after = emotionSnapshot(targetNpc);
      flowTest.steps.push({
        step: flowTest.steps.length + 1,
        input: { node: node.type, params: node.params },
        raw_response: result,
        parsed_response: null,
        clamp_range: null,
        escalation: targetNpc && world.npcs[targetNpc] ? world.npcs[targetNpc].escalation : null,
        clamped_deltas: null,
        scaled_deltas: null,
        before,
        after,
        memory_stored: [],
        fallback: null,
        latency_ms: Math.round(performance.now() - t0),
        tokens: null,
        clamp_hits: false,
      });
    } catch (e) {
      node.status = 'failed';
      node.result = `Error: ${e.message}`;
      execLog(`  ✗ ${e.message}`, 'fc-log-err');
      failed++;

      const after = emotionSnapshot(targetNpc);
      flowTest.steps.push({
        step: flowTest.steps.length + 1,
        input: { node: node.type, params: node.params },
        raw_response: `Error: ${e.message}`,
        parsed_response: null,
        clamp_range: null,
        escalation: targetNpc && world.npcs[targetNpc] ? world.npcs[targetNpc].escalation : null,
        clamped_deltas: null,
        scaled_deltas: null,
        before,
        after,
        memory_stored: [],
        fallback: node.type.startsWith('assert_') ? 'assert_failed' : 'error',
        latency_ms: Math.round(performance.now() - t0),
        tokens: null,
        clamp_hits: false,
      });

      if (node.type.startsWith('assert_')) continue;
      break;
    }

    render();
    if (selectedNodeId === node.id) renderDetail(node);

    if (i < nodeList.length - 1) await new Promise(r => setTimeout(r, 100));
  }

  // Save final state back
  saveCurrent();

  // Finalize Test Lab report
  const anyNpc = _currentNpc || (npcNames()[0] || null);
  const finalEmotions = anyNpc ? emotionSnapshot(anyNpc) : { trust: 0, fear: 0, anger: 0 };
  flowTest.final_state = { emotions: finalEmotions, world: deepCloneWorld() };
  const initEmo = flowTest.initial_state?.emotions || { trust: 0, fear: 0, anger: 0 };
  flowTest.summary = {
    trust_delta: +(finalEmotions.trust - (initEmo.trust || 0)).toFixed(3),
    fear_delta: +(finalEmotions.fear - (initEmo.fear || 0)).toFixed(3),
    anger_delta: +(finalEmotions.anger - (initEmo.anger || 0)).toFixed(3),
    escalation_max: Math.max(0, ...flowTest.steps.map(s => s.escalation || 0)),
    clamp_hits: flowTest.steps.filter(s => s.clamp_hits).length,
    fallbacks: flowTest.steps.filter(s => s.fallback).length,
    memory_count: finalEmotions ? (flowTest.final_state?.world ? Object.values(flowTest.final_state.world.npcs).reduce((acc,n)=>acc+(n.memories?.length||0),0) : 0) : 0,
  };
  await pg.saveTestReport(flowTest);

  $('fcExecStatus').textContent = `Done: ${passed} passed, ${failed} failed`;
  execLog(`Flow complete: ${passed} passed, ${failed} failed`, failed > 0 ? 'fc-log-warn' : 'fc-log-ok');

  running = false;
  $('fcRunAllBtn').disabled = false;
  $('fcStopBtn').disabled = true;
  render();
}

// ── Save / Load flows ────────────────────────────────────────────────────────
function getSavedFlows() {
  try { return JSON.parse(localStorage.getItem('playground_flows') || '{}'); } catch { return {}; }
}

function saveSavedFlows(flows) {
  localStorage.setItem('playground_flows', JSON.stringify(flows));
}

function refreshFlowSelect() {
  const sel = $('fcSavedFlows');
  sel.innerHTML = '<option value="">— saved flows —</option>';
  const flows = getSavedFlows();
  for (const name of Object.keys(flows)) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    if (name === _currentFlowName) opt.selected = true;
    sel.appendChild(opt);
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────
function init() {
  $('fcAddNodeBtn').onclick = () => {
    const type = $('fcNodeType').value;
    const def = NODE_DEFS[type];
    if (!def) return;
    const node = { id: uid(), type, params: { ...def.defaults }, status: 'pending', result: null };
    // Add to active chunk or global
    const chunk = getActiveChunk();
    if (chunk) {
      chunk.nodes.push(node);
    } else {
      nodes.push(node);
    }
    selectedNodeId = node.id;
    render();
    renderDetail(node);
  };

  $('fcRunAllBtn').onclick = () => {
    const all = getAllNodes();
    if (all.length === 0) return;
    // Reset world for full run
    for (const k of Object.keys(world.npcs)) delete world.npcs[k];
    for (const k of Object.keys(world.players)) delete world.players[k];
    _currentNpc = null;
    all.forEach(n => { n.status = 'pending'; n.result = null; });
    runNodeList(all);
  };

  // ── New Chunk button ──
  $('fcNewChunkBtn').onclick = () => {
    const name = prompt('Chunk name:', `Chunk ${chunks.length + 1}`);
    if (!name) return;
    const chunk = {
      id: chunkUid(),
      name,
      color: randomChunkColor(),
      nodes: [],
      snapshot: null,
    };
    chunks.push(chunk);
    activeChunkId = chunk.id;
    renderChunkList();
    renderChunkActions();
    render();
    execLog(`Created chunk "${name}"`, 'fc-log-info');
  };

  // Run active chunk (runs global nodes first as setup, then chunk nodes)
  $('fcRunSelectedBtn').onclick = () => {
    const c = getActiveChunk();
    if (!c || c.nodes.length === 0) return;
    if (!c.snapshot) {
      c.snapshot = { world: deepCloneWorld(), currentNpc: _currentNpc };
      execLog(`Snapshot saved for "${c.name}"`, 'fc-log-info');
    }
    renderChunkActions();
    // Run global (setup) nodes first, then chunk nodes
    const toRun = [...nodes, ...c.nodes];
    toRun.forEach(n => { n.status = 'pending'; n.result = null; });
    runNodeList(toRun);
  };

  $('fcChunkRunBtn').onclick = () => {
    $('fcRunSelectedBtn').click();
  };

  $('fcChunkReplayBtn').onclick = () => {
    const c = getActiveChunk();
    if (!c || !c.snapshot) return;
    restoreWorld(c.snapshot.world);
    _currentNpc = c.snapshot.currentNpc;
    if (_currentNpc && world.npcs[_currentNpc]) swapIn(_currentNpc);
    execLog(`State restored for "${c.name}" replay`, 'fc-log-info');
    const toRun = [...nodes, ...c.nodes];
    toRun.forEach(n => { n.status = 'pending'; n.result = null; });
    render();
    runNodeList(toRun);
  };

  $('fcChunkResetBtn').onclick = () => {
    const c = getActiveChunk();
    if (!c || !c.snapshot) return;
    restoreWorld(c.snapshot.world);
    _currentNpc = c.snapshot.currentNpc;
    if (_currentNpc && world.npcs[_currentNpc]) swapIn(_currentNpc);
    c.nodes.forEach(n => { n.status = 'pending'; n.result = null; });
    render();
    execLog(`State restored from "${c.name}" snapshot`, 'fc-log-info');
  };

  $('fcChunkDeleteBtn').onclick = () => {
    const c = getActiveChunk();
    if (!c) return;
    if (!confirm(`Delete chunk "${c.name}" and its ${c.nodes.length} nodes?`)) return;
    chunks = chunks.filter(ch => ch.id !== c.id);
    activeChunkId = null;
    renderChunkList();
    renderChunkActions();
    render();
    execLog(`Deleted chunk "${c.name}"`, 'fc-log-info');
  };

  $('fcStopBtn').onclick = () => { aborted = true; };

  $('fcClearBtn').onclick = () => {
    nodes = [];
    selectedNodeId = null;
    chunks = [];
    activeChunkId = null;
    nextId = 1;
    _currentFlowName = null;
    for (const k of Object.keys(world.npcs)) delete world.npcs[k];
    for (const k of Object.keys(world.players)) delete world.players[k];
    _currentNpc = null;
    $('fcExecLog').innerHTML = '';
    $('fcExecStatus').textContent = '';
    refreshFlowSelect();
    render();
  };

  $('fcSaveBtn').onclick = () => {
    let name;
    if (_currentFlowName) {
      if (confirm(`Overwrite "${_currentFlowName}"?`)) {
        name = _currentFlowName;
      } else {
        name = prompt('Save as new flow name:');
        if (!name) return;
      }
    } else {
      name = prompt('Flow name:');
      if (!name) return;
    }
    const flows = getSavedFlows();
    flows[name] = {
      nodes: nodes.map(n => ({ type: n.type, params: { ...n.params } })),
      chunks: chunks.map(c => ({
        name: c.name,
        color: c.color,
        nodes: c.nodes.map(n => ({ type: n.type, params: { ...n.params } })),
      })),
    };
    saveSavedFlows(flows);
    _currentFlowName = name;
    refreshFlowSelect();
    execLog(`Saved flow: ${name}`, 'fc-log-ok');
  };

  $('fcLoadBtn').onclick = () => {
    const name = $('fcSavedFlows').value;
    if (!name) return;
    const flows = getSavedFlows();
    const flow = flows[name];
    if (!flow) return;
    // Backwards compat: old format is plain array, new format is { nodes, chunks }
    const nodeList = Array.isArray(flow) ? flow : (flow.nodes || []);
    const chunkList = Array.isArray(flow) ? [] : (flow.chunks || []);
    nodes = nodeList.map(n => ({ id: uid(), type: n.type, params: { ...n.params }, status: 'pending', result: null }));
    chunks = chunkList.map(c => ({
      id: chunkUid(),
      name: c.name,
      color: c.color || randomChunkColor(),
      nodes: (c.nodes || []).map(n => ({ id: uid(), type: n.type, params: { ...n.params }, status: 'pending', result: null })),
      snapshot: null,
    }));
    activeChunkId = null;
    selectedNodeId = null;
    _currentFlowName = name;
    renderChunkList();
    renderChunkActions();
    render();
    $('fcDetail').innerHTML = '<div class="fc-detail-empty">Select a node to edit its parameters</div>';
    execLog(`Loaded flow: ${name} (${nodes.length} nodes, ${chunks.length} chunks)`, 'fc-log-ok');
  };

  refreshFlowSelect();
  render();
}

// ── Public API (for playground.js scenarios) ────────────────────────────────
function loadFlowData(flowData, name) {
  const nodeList = Array.isArray(flowData) ? flowData : (flowData.nodes || []);
  const chunkList = Array.isArray(flowData) ? [] : (flowData.chunks || []);
  nodes = nodeList.map(n => ({ id: uid(), type: n.type, params: { ...n.params }, status: 'pending', result: null }));
  chunks = chunkList.map(c => ({
    id: chunkUid(),
    name: c.name,
    color: c.color || randomChunkColor(),
    nodes: (c.nodes || []).map(n => ({ id: uid(), type: n.type, params: { ...n.params }, status: 'pending', result: null })),
    snapshot: null,
  }));
  activeChunkId = null;
  selectedNodeId = null;
  _currentFlowName = name || null;
  // Reset world
  for (const k of Object.keys(world.npcs)) delete world.npcs[k];
  for (const k of Object.keys(world.players)) delete world.players[k];
  _currentNpc = null;
  $('fcExecLog').innerHTML = '';
  $('fcExecStatus').textContent = '';
  renderChunkList();
  renderChunkActions();
  refreshFlowSelect();
  render();
  $('fcDetail').innerHTML = '<div class="fc-detail-empty">Select a node to edit its parameters</div>';
  execLog(`Loaded scenario: ${name || 'unnamed'} (${nodes.length} nodes, ${chunks.length} chunks)`, 'fc-log-ok');
}

function runAllNodes() {
  const all = getAllNodes();
  if (all.length === 0) return;
  // Reset world
  for (const k of Object.keys(world.npcs)) delete world.npcs[k];
  for (const k of Object.keys(world.players)) delete world.players[k];
  _currentNpc = null;
  all.forEach(n => { n.status = 'pending'; n.result = null; });
  runNodeList(all);
}

window.Flowchart = {
  loadFlow: loadFlowData,
  runAll: runAllNodes,
  world,
  getAllNodes,
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})();
