// ChatBox — bottom-of-screen chat input.
// Press Enter to open (only when an NPC is selected).
// Type a command, press Enter to send, Escape to cancel.
// Shows a "thinking…" bubble over the NPC while waiting for the server.
// Quick-command menu appears above the input when opened.

import Phaser from 'phaser';
import QUICK_COMMANDS from '../data/quickChatCommands.json';

const SERVER_URL = 'http://127.0.0.1:8001/parse_command';

const ITEM_H    = 28;
const ITEM_W    = 460;
const MENU_PAD  = 6;

export class ChatBox {
  /**
   * @param {Phaser.Scene} scene
   * @param {() => NPC|null} getSelectedNPC  returns the currently-selected NPC, or null
   * @param {(npc, commands) => void} onCommands  called with parsed command list
   * @param {() => {x:number,y:number}|null} [getPlayer]  player sprite, for proximity auto-select
   * @param {() => NPC[]} [getNpcs]  live NPC array, for proximity auto-select
   * @param {(npc: NPC) => void} [selectNPC]  selects an NPC externally
   */
  constructor(scene, getSelectedNPC, onCommands, getPlayer, getNpcs, selectNPC) {
    this._scene          = scene;
    this._getSelectedNPC = getSelectedNPC;
    this._onCommands     = onCommands;
    this._getPlayer      = getPlayer  ?? (() => null);
    this._getNpcs        = getNpcs    ?? (() => []);
    this._selectNPC      = selectNPC  ?? (() => {});
    this._open           = false;
    this._input          = '';

    const W = scene.cameras.main.width;
    const H = scene.cameras.main.height;

    // Background bar
    this._bg = scene.add.rectangle(W / 2, H - 28, W - 40, 40, 0x000000, 0.85)
      .setScrollFactor(0).setDepth(50).setOrigin(0.5, 0.5).setVisible(false);

    // Prompt label
    this._label = scene.add.text(24, H - 28, 'Say to NPC: ', {
      fontSize: '14px', color: '#88ccff',
    }).setScrollFactor(0).setDepth(51).setOrigin(0, 0.5).setVisible(false);

    // Input text
    this._text = scene.add.text(130, H - 28, '', {
      fontSize: '14px', color: '#ffffff',
    }).setScrollFactor(0).setDepth(51).setOrigin(0, 0.5).setVisible(false);

    // Cursor blink
    this._cursor = scene.add.text(130, H - 28, '|', {
      fontSize: '14px', color: '#ffffff',
    }).setScrollFactor(0).setDepth(51).setOrigin(0, 0.5).setVisible(false);
    scene.time.addEvent({ delay: 500, loop: true, callback: () => {
      if (this._open) this._cursor.setVisible(!this._cursor.visible);
    }});

    // Status bar (shows "Thinking…" / error)
    this._status = scene.add.text(W / 2, H - 56, '', {
      fontSize: '12px', color: '#ffcc44', backgroundColor: '#00000099',
      padding: { x: 6, y: 3 },
    }).setScrollFactor(0).setDepth(51).setOrigin(0.5, 1).setVisible(false);

    // Hint when no NPC selected
    this._hint = scene.add.text(W / 2, H - 12, 'Select an NPC (click) then press Enter to give orders', {
      fontSize: '11px', color: '#888888',
    }).setScrollFactor(0).setDepth(51).setOrigin(0.5, 1).setVisible(false);

    // ── Quick-command menu ────────────────────────────────────────────────────
    this._menuItems = [];
    const menuTotalH = QUICK_COMMANDS.length * ITEM_H + MENU_PAD * 2;
    const menuX      = 20; // left-aligned, same margin as the bar
    const menuBottom = H - 56; // sits just above the status/bar area

    // Menu background
    this._menuBg = scene.add.rectangle(
      menuX, menuBottom - menuTotalH,
      ITEM_W + MENU_PAD * 2, menuTotalH,
      0x0a0a14, 0.93,
    ).setScrollFactor(0).setDepth(52).setOrigin(0, 0).setVisible(false);

    QUICK_COMMANDS.forEach((cmd, i) => {
      const iy = menuBottom - menuTotalH + MENU_PAD + i * ITEM_H;

      const btn = scene.add.rectangle(
        menuX + MENU_PAD, iy,
        ITEM_W, ITEM_H - 2,
        0x111122, 1,
      ).setScrollFactor(0).setDepth(53).setOrigin(0, 0).setVisible(false)
        .setInteractive({ useHandCursor: true });

      const lbl = scene.add.text(
        menuX + MENU_PAD + 10, iy + (ITEM_H - 2) / 2,
        cmd.label, {
          fontSize: '13px', color: '#ccddff',
        },
      ).setScrollFactor(0).setDepth(54).setOrigin(0, 0.5).setVisible(false);

      btn.on('pointerover', () => { btn.setFillStyle(0x223355); lbl.setColor('#ffffff'); });
      btn.on('pointerout',  () => { btn.setFillStyle(0x111122); lbl.setColor('#ccddff'); });
      btn.on('pointerdown', () => {
        this._input = cmd.text;
        this._hideMenu();
        this._submit();
      });

      this._menuItems.push({ btn, lbl });
    });
    // ─────────────────────────────────────────────────────────────────────────

    // Keyboard capture — handles both open-on-Enter and typed input
    scene.input.keyboard.on('keydown', this._onKey, this);
  }

  isOpen() { return this._open; }

  // ── Private ───────────────────────────────────────────────────────────────

  _onKey(event) {
    // ChatBox no longer self-opens on Enter — NPCDialoguePanel owns that key.
    if (!this._open) return;

    if (event.key === 'Escape') {
      this._closeAndDeselect();
      return;
    }

    if (event.key === 'Enter') {
      this._submit();
      return;
    }

    if (event.key === 'Backspace') {
      this._input = this._input.slice(0, -1);
      this._refresh();
      return;
    }

    // Ctrl+V — paste from clipboard
    if ((event.ctrlKey || event.metaKey) && event.key === 'v') {
      navigator.clipboard.readText().then(text => {
        this._input += text.replace(/[\r\n]+/g, ' ');
        this._refresh();
      }).catch(() => {});
      return;
    }

    // Printable characters only (skip other ctrl/meta combos)
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
      this._input += event.key;
      // Hide menu once the player starts typing
      this._hideMenu();
      this._refresh();
    }
  }

  _refresh() {
    this._text.setText(this._input);
    // Reposition cursor after text
    this._cursor.setX(this._text.x + this._text.width + 2);
  }

  async _submit() {
    const text = this._input.trim();
    if (!text) { this._closeAndDeselect(); return; }

    const npc = this._getSelectedNPC();
    if (!npc) { this._close(); return; }

    this._close();

    // "Your name is ___" — rename the NPC immediately, no server needed
    const nameMatch = _matchNameCommand(text);
    if (nameMatch) {
      npc.setName(nameMatch);
      const replies = [
        `Oh shit, yeah I almost forgot I'm ${nameMatch}`,
        `Goddammit I thought my name was sunshine, I'm ${nameMatch}`,
        `Yeah, I'm ${nameMatch}, no shit sherlock`,
      ];
      npc.showBubble(replies[Math.floor(Math.random() * replies.length)]);
      return;
    }

    // Try local pattern matching first — avoids server round-trip for known workflows
    const localCommands = _matchLocalCommand(text, npc);
    if (localCommands) {
      npc.showBubble(_describeLocalCommand(text, npc));
      this._onCommands(npc, localCommands);
      return;
    }

    // Show thinking bubble
    npc.showBubble('Thinking…');
    this._status.setText('Contacting NPC server…').setVisible(true);

    // Build world context
    const scene = this._scene;
    const worldContext = {
      trees:    (scene.trees    ?? []).filter(t => !t._chopped).length,
      furnaces: (scene.furnaces ?? []).length,
      crates:   (scene.crates  ?? []).length,
      quarries: (scene.quarries ?? []).length,
      crushers: (scene.crushers ?? []).length,
    };

    // Build per-NPC context — inventory, skills, assigned targets
    const npcContext = _buildNpcContext(npc);

    try {
      const res = await fetch(SERVER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, npc_id: npc.id, world_context: worldContext, npc_context: npcContext }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      npc.hideBubble();
      this._status.setVisible(false);
      this._onCommands(npc, data.commands ?? []);
    } catch (err) {
      console.error('ChatBox fetch error:', err);
      npc.showBubble('(server error)');
      this._status.setText('Server error — is auxserver running?').setVisible(true);
      this._scene.time.delayedCall(3000, () => this._status.setVisible(false));
    }
  }

  _close() {
    this._open = false;
    this._input = '';
    this._setVisible(false);
    this._cursor.setVisible(false);
    this._hideMenu();
  }

  _closeAndDeselect() {
    this._close();
    this._selectNPC(null);
  }

  _setVisible(v) {
    this._bg.setVisible(v);
    this._label.setVisible(v);
    this._text.setVisible(v);
    this._cursor.setVisible(v);
  }

  _showMenu() {
    this._menuBg.setVisible(true);
    for (const { btn, lbl } of this._menuItems) {
      btn.setVisible(true);
      lbl.setVisible(true);
    }
  }

  _hideMenu() {
    this._menuBg.setVisible(false);
    for (const { btn, lbl } of this._menuItems) {
      btn.setVisible(false);
      lbl.setVisible(false);
    }
  }

  _showHint() {
    this._hint.setVisible(true);
    this._scene.time.delayedCall(2500, () => this._hint.setVisible(false));
  }
}

// ── Local command patterns ────────────────────────────────────────────────────
// Resolved with NPC context so patterns can use assigned targets.
// Returns null if no match → falls through to server.

// Map text keywords → internal ore key used by NPCTaskRunner
const ORE_KEYWORDS = {
  copper:    'copperore',
  tin:       'tinore',
  gold:      'goldore',
  coal:      'coal',
  ore:       'ore',
};

// Map internal ore key → display label
const ORE_LABELS = {
  copperore: 'copper ore',
  tinore:    'tin ore',
  goldore:   'gold ore',
  coal:      'coal',
  ore:       'ore',
};

// Map internal ore key → CamelCase resource key used in inventory
const ORE_RES_KEY = {
  copperore: 'CopperOre',
  tinore:    'TinOre',
  goldore:   'GoldOre',
  coal:      'Coal',
  ore:       'Ore',
};

/**
 * Try to resolve a mining command from text + NPC context.
 * Returns { oreKey, oreResKey, targetQty, loop, store } or null.
 */
function _parseMineIntent(text, npc) {
  const t = text.toLowerCase();

  // Detect loop/repeat intent
  const loop  = /\b(loop|repeat|keep|always|forever|continuously)\b/.test(t);
  // Detect store/deposit intent
  const store = /\b(store|deposit|drop off|put away|stash)\b/.test(t);
  // Detect quantity (e.g. "mine 10", "gather 5")
  const qtyMatch = t.match(/\b(\d+)\b/);
  const targetQty = qtyMatch ? parseInt(qtyMatch[1]) : null;

  // Detect ore type from text keywords
  let oreKey = null;
  for (const [kw, key] of Object.entries(ORE_KEYWORDS)) {
    if (new RegExp(`\\b${kw}\\b`).test(t)) { oreKey = key; break; }
  }

  // If no ore named but NPC has assigned rocks, infer type from them
  if (!oreKey) {
    const rocks = npc?.assignedTargets?.mine_rocks ?? [];
    if (rocks.length > 0) oreKey = _rockTypeToOreKey(rocks[0].rockType);
  }

  // Must have mine/gather intent
  const mineIntent = /\b(mine|dig|gather|collect|get|fetch|extract)\b/.test(t);
  if (!mineIntent && !oreKey) return null;
  if (!oreKey) return null;

  return { oreKey, oreResKey: ORE_RES_KEY[oreKey], targetQty, loop, store };
}

function _rockTypeToOreKey(rockType) {
  const map = { CopperOre: 'copperore', TinOre: 'tinore', GoldOre: 'goldore', Coal: 'coal', Ore: 'ore' };
  return map[rockType] ?? null;
}

/**
 * Extract all ore ResKeys the NPC should mine, in order.
 * Sources: unique rock types from assigned mine_rocks (in assignment order),
 * augmented by any ore names explicitly mentioned in text.
 */
function _inferAllOreResKeys(text, npc) {
  const seen = new Set();
  const result = [];

  // From assigned rocks (in ctrl+click order)
  for (const rock of (npc?.assignedTargets?.mine_rocks ?? [])) {
    const resKey = rock.rockType; // e.g. 'CopperOre'
    if (resKey && !seen.has(resKey)) { seen.add(resKey); result.push(resKey); }
  }

  // From text keywords (in order they appear)
  const t = text.toLowerCase();
  const ORE_ORDER = ['copper', 'tin', 'gold', 'coal', 'ore'];
  for (const kw of ORE_ORDER) {
    if (new RegExp(`\\b${kw}\\b`).test(t)) {
      const oreKey = ORE_KEYWORDS[kw];
      const resKey = ORE_RES_KEY[oreKey];
      if (resKey && !seen.has(resKey)) { seen.add(resKey); result.push(resKey); }
    }
  }

  return result;
}

/**
 * Parse "copper here, tin here" / "copper goes here tin goes here" to build
 * a crateOreMap: { oreResKey → crateIndex } using the order of ctrl+clicked crates.
 *
 * Examples that trigger this:
 *   "mine and store, copper here tin here"
 *   "copper here, tin here"
 *   "put copper here and tin here"
 *
 * Returns null if fewer than 2 crates assigned or no pattern detected.
 */
function _parseCrateOreMap(text, npc) {
  const crates = npc?.assignedTargets?.crates ?? [];
  if (crates.length < 2) return null; // need multiple crates for routing to matter

  const t = text.toLowerCase();

  // Find all "ORE here" mentions in text order
  // Pattern: optional "put/store/deposit" + oreName + optional filler + "here"
  const herePattern = /\b(copper|tin|gold|coal|ore)\b[^,\.!?]*?\bhere\b/g;
  const matches = [...t.matchAll(herePattern)];
  if (matches.length < 2) return null; // need at least 2 explicit routings

  const map = {};
  for (let i = 0; i < matches.length && i < crates.length; i++) {
    const kw     = matches[i][1]; // 'copper', 'tin', etc.
    const oreKey = ORE_KEYWORDS[kw];
    const resKey = ORE_RES_KEY[oreKey];
    if (resKey) map[resKey] = i; // map ore → crate index
  }

  return Object.keys(map).length > 0 ? map : null;
}

function _matchLocalCommand(text, npc) {
  // ── Mine / gather ore ──────────────────────────────────────────────────────
  const mine = _parseMineIntent(text, npc);
  if (mine) {
    const qty = mine.targetQty ?? 10;

    if (mine.loop || mine.store) {
      // Parse per-ore crate routing ("copper here, tin here") and write map onto NPC
      const crateOreMap = _parseCrateOreMap(text, npc);
      if (crateOreMap && Object.keys(crateOreMap).length > 0) {
        npc.assignedTargets.crateOreMap = crateOreMap;
      }

      // Collect all unique ore types being mined (from rocks + explicit text mentions)
      const oreResKeys = _inferAllOreResKeys(text, npc);
      const goals = [];
      for (const oreResKey of oreResKeys) {
        goals.push({ goal: 'gather_from_rocks', oreResKey, targetQty: qty });
        goals.push({ goal: 'deposit_ore',       oreResKey });
      }
      // Fallback: single ore from _parseMineIntent
      if (goals.length === 0) {
        goals.push({ goal: 'gather_from_rocks', oreResKey: mine.oreResKey, targetQty: qty });
        goals.push({ goal: 'deposit_ore',       oreResKey: mine.oreResKey });
      }
      return [{ task: 'loop', goals }];
    }

    // One-shot gather
    const tasks = [{ task: 'gather', item: mine.oreKey }];
    if (mine.store) tasks.push({ task: 'deposit', target: 'crate', item: mine.oreResKey, amount: 'all' });
    return tasks;
  }

  // ── Chicken + arrow workflow ───────────────────────────────────────────────
  if (/kill\s+chicken|hunt\s+chicken|kill.*arrow|chicken.*arrow/i.test(text)) {
    return [{
      task: 'loop',
      goals: [
        { goal: 'hunt_for_feathers',     targetQty: 10 },
        { goal: 'gather_wood_for_arrows', targetQty: 10 },
        { goal: 'smith_arrowheads',       arrowheadQty: 10, ironQty: 10, targetHeads: 30, qty: 10 },
        { goal: 'fetch_arrowheads',       qty: 10 },
        { goal: 'craft_arrows',           qty: 10 },
        { goal: 'deposit_arrows' },
      ],
    }];
  }

  return null;
}

function _describeLocalCommand(text, npc) {
  const mine = _parseMineIntent(text, npc);
  if (mine) {
    const qty  = mine.targetQty ? ` (×${mine.targetQty})` : '';
    const loop = (mine.loop || mine.store) ? ', looping' : '';

    if (mine.loop || mine.store) {
      // Describe all ore types being mined
      const oreResKeys = _inferAllOreResKeys(text, npc);
      const crateOreMap = _parseCrateOreMap(text, npc);
      if (oreResKeys.length > 1) {
        const labels = oreResKeys.map((k, i) => {
          const oreKey = _rockTypeToOreKey(k) ?? k.toLowerCase().replace('ore', '');
          const lbl = ORE_LABELS[oreKey] ?? k;
          const crateIdx = crateOreMap?.[k] ?? (npc.assignedTargets?.crates?.length > 1 ? i : null);
          return crateIdx != null ? `${lbl}→crate${crateIdx + 1}` : lbl;
        });
        return `Mining ${labels.join(', ')}${qty}${loop}…`;
      }
      const label = ORE_LABELS[mine.oreKey] ?? mine.oreKey;
      return `Mining ${label}${qty} → store${loop}…`;
    }

    const label = ORE_LABELS[mine.oreKey] ?? mine.oreKey;
    return `Mining ${label}${qty}…`;
  }
  if (/kill\s+chicken|hunt\s+chicken|kill.*arrow|chicken.*arrow/i.test(text)) {
    return 'Hunting chickens & crafting arrows…';
  }
  return 'Working…';
}

// Returns the name string if text matches "your name is ___", else null
function _matchNameCommand(text) {
  const m = text.match(/^your\s+name\s+is\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// Builds the npc_context payload from a live NPC object
function _buildNpcContext(npc) {
  const ctx = {};

  // Inventory
  if (npc._inventory) {
    ctx.inventory = { ...npc._inventory };
  }

  // Skills — send level per skill (not raw XP, easier for the LLM to reason about)
  if (npc.skills) {
    const skillLevels = {};
    for (const id of Object.keys(npc.skills._xp ?? {})) {
      skillLevels[id] = npc.skills.getLevel(id);
    }
    ctx.skills = skillLevels;
  }

  // Assigned targets — include type + grid position if available
  if (npc.assignedTargets) {
    const assigned = {};
    for (const [key, val] of Object.entries(npc.assignedTargets)) {
      if (!val) continue;
      if (Array.isArray(val)) {
        if (val.length > 0) assigned[key] = val.map(o => _targetPos(o));
      } else {
        assigned[key] = _targetPos(val);
      }
    }
    if (Object.keys(assigned).length > 0) ctx.assigned = assigned;
  }

  return ctx;
}

function _targetPos(obj) {
  if (!obj) return null;
  const pos = {
    col: obj.col ?? Math.round(obj.x / 32),
    row: obj.row ?? Math.round(obj.y / 32),
  };
  // Include extra type info for mine rocks so the LLM knows which ore to gather
  if (obj.rockType) pos.rockType = obj.rockType;
  return pos;
}

