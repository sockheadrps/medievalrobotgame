import Phaser from 'phaser';
import { API_BASE } from '../config.js';

export class AdminPanel {
  constructor(scene) {
    this._scene = scene;
    this._el = null;
    this._timer = null;
    this._assetRegistry = null;
    this._giveItemsContainer = null;
  }

  isOpen() { return !!this._el; }

  open(tab = null) {
    if (this._el) {
      if (tab) this.switchTab(tab);
      return;
    }
    this._build();
    this._refresh();
    if (tab) this.switchTab(tab);
    this._timer = setInterval(() => this._refresh(), 400);
    // Load asset registry for dynamic Give Items UI (fire-and-forget)
    if (!this._assetRegistry) {
      fetch(`${API_BASE}/api/assets/items`)
        .then(r => r.json())
        .then(items => {
          this._assetRegistry = items;
          this._buildGiveItemsUI();
        })
        .catch(e => console.warn('AdminPanel: failed to load asset registry', e));
    }
  }

  switchTab(tab) {
    if (!this._el) return;
    this._el.querySelectorAll('.pdp-tab').forEach(t => t.classList.remove('active'));
    this._el.querySelectorAll('.pdp-pane').forEach(p => p.classList.remove('active'));
    this._el.querySelector(`.pdp-tab[data-tab="${tab}"]`)?.classList.add('active');
    this._el.querySelector(`.pdp-pane[data-pane="${tab}"]`)?.classList.add('active');
  }

  close() {
    if (this._scene) this._scene._charMenuOpen = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._el) { this._el.remove(); this._el = null; }
  }

  hide() {
    if (this._el) this._el.style.display = 'none';
  }

  destroy() {
    if (this._el && this._el.parentNode) {
      this._el.parentNode.removeChild(this._el);
    }
    this._el = null;
  }

  _send(field, value = 0, extra = {}) {
    this._scene._conn?.send({ type: 'admin', field, value, target_npc_id: null, ...extra });
  }

  _build() {
    const el = document.createElement('div');
    el.id = 'player-detail-panel';
    el.innerHTML = `
      <div class="pdp-backdrop"></div>
      <div class="pdp-shell">
        <div class="pdp-header">
          <div>
            <div class="pdp-title">Character</div>
            <div class="pdp-subtitle"></div>
          </div>
          <button class="pdp-close">✕</button>
        </div>
        <div class="pdp-tabs">
          <button class="pdp-tab active" data-tab="stats">Stats</button>
          <button class="pdp-tab" data-tab="inventory">Inventory</button>
          <button class="pdp-tab" data-tab="ki">Ki</button>
        </div>
        <div class="pdp-body">
          <div class="pdp-pane active" data-pane="stats">
            <div class="pdp-two-col">
              <div class="pdp-col-left">
                <div class="pdp-section">
                  <h3>Vitals</h3>
                  <div class="pdp-vitals"></div>
                </div>
                <div class="pdp-section">
                  <h3>Combat</h3>
                  <div class="pdp-combat-stats"></div>
                </div>
                <div class="pdp-section">
                  <h3>Level</h3>
                  <div class="pdp-level-stats"></div>
                </div>
              </div>
              <div class="pdp-col-right">
                <div class="pdp-section">
                  <h3>Adjustments</h3>
                  <div class="pdp-adj"></div>
                </div>
              </div>
            </div>
          </div>

          <div class="pdp-pane" data-pane="inventory">
            <div class="pdp-two-col">
              <div class="pdp-col-left">
                <div class="pdp-section">
                  <h3>Resources</h3>
                  <div class="pdp-res"></div>
                </div>
                <div class="pdp-section">
                  <h3>Drops</h3>
                  <div class="pdp-drops"></div>
                </div>
                <div class="pdp-section">
                  <h3>Farming</h3>
                  <div class="pdp-farming"></div>
                </div>
                <div class="pdp-section">
                  <h3>Items</h3>
                  <div class="pdp-inventory-dynamic"></div>
                </div>
                <div class="pdp-section">
                  <h3>Equipment</h3>
                  <div class="pdp-equipment-section"></div>
                </div>
              </div>
              <div class="pdp-col-right">
                <div class="pdp-section">
                  <h3>Give Items</h3>
                  <div class="pdp-give"></div>
                </div>
                <div class="pdp-section">
                  <h3>Crafting</h3>
                  <div class="pdp-craft"></div>
                </div>
              </div>
            </div>
          </div>

          <div class="pdp-pane" data-pane="ki">
            <div class="pdp-two-col">
              <div class="pdp-col-left">
                <div class="pdp-section">
                  <h3>Ki Pool</h3>
                  <div class="pdp-ki-pool"></div>
                </div>
                <div class="pdp-section">
                  <h3>Ki Blast</h3>
                  <div class="pdp-ki-blast"></div>
                </div>
                <div class="pdp-section">
                  <h3>Barrier</h3>
                  <div class="pdp-ki-barrier"></div>
                </div>
              </div>
              <div class="pdp-col-right">
                <div class="pdp-section">
                  <h3>Ki Adjustments</h3>
                  <div class="pdp-ki-adj"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(el);
    this._el = el;
    this._giveItemsContainer = el.querySelector('.pdp-give');
    this._injectStyles();

    el.querySelector('.pdp-close').addEventListener('click', () => this.close());
    el.querySelector('.pdp-backdrop').addEventListener('click', () => this.close());
    el.querySelector('.pdp-shell').addEventListener('click', (e) => e.stopPropagation());
    el.querySelector('.pdp-shell').addEventListener('pointerdown', (e) => e.stopPropagation());

    for (const tab of el.querySelectorAll('.pdp-tab')) {
      tab.addEventListener('click', () => {
        el.querySelectorAll('.pdp-tab').forEach(t => t.classList.remove('active'));
        el.querySelectorAll('.pdp-pane').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        el.querySelector(`.pdp-pane[data-pane="${tab.dataset.tab}"]`)?.classList.add('active');
      });
    }

    // Combat mode toggle (delegated — buttons re-render each refresh)
    el.querySelector('.pdp-combat-stats').addEventListener('click', (e) => {
      const btn = e.target.closest('.pdp-cm-btn');
      if (!btn) return;
      const mode = btn.dataset.cm;
      this._scene._conn?.send({ type: 'set_combat_mode', mode });
    });
  }

  _refresh() {
    if (!this._el) return;
    const scene = this._scene;
    const p = scene.player;
    if (!p) return;

    this._el.querySelector('.pdp-subtitle').textContent = `${scene.playerId || 'Player'}  ·  Level ${p.level}`;

    this._refreshStats(p);
    this._refreshInventory(p);
    this._refreshKi(p);
  }

  _refreshStats(p) {
    const hpPct = p.maxHp > 0 ? (p.hp / p.maxHp) * 100 : 0;

    // Vitals
    this._el.querySelector('.pdp-vitals').innerHTML = `
      ${this._barRow('HP', p.hp, p.maxHp, hpPct, hpPct > 50 ? '#59d66f' : hpPct > 25 ? '#d6aa44' : '#d65c5c')}
    `;

    // Combat stats
    const cMode = p.combatMode || 'kill';
    this._el.querySelector('.pdp-combat-stats').innerHTML = `
      <div class="pdp-stat-grid">
        ${this._statCell('STR', p.str)}
        ${this._statCell('DEF', p.def)}
      </div>
      <div class="pdp-combat-mode">
        <span style="font-size:10px;color:#aaa;">Attack Mode:</span>
        <button class="pdp-cm-btn${cMode === 'kill' ? ' active' : ''}" data-cm="kill">Kill</button>
        <button class="pdp-cm-btn${cMode === 'ko' ? ' active' : ''}" data-cm="ko">KO</button>
      </div>
    `;

    // Level stats
    const xpNeeded = p.level * 20;
    const xpPct = xpNeeded > 0 ? Math.min(100, (p.xp / xpNeeded) * 100) : 0;
    this._el.querySelector('.pdp-level-stats').innerHTML = `
      ${this._statCell('Level', p.level, true)}
      ${this._barRow('XP', p.xp, xpNeeded, xpPct, '#f6cf61')}
    `;

    // Adjustments panel — +/- buttons
    const adj = this._el.querySelector('.pdp-adj');
    if (!adj._built) {
      adj._built = true;
      adj.innerHTML = `
        ${this._adjRow('Max HP', 'maxHp', 5, '#59d66f')}
        ${this._adjRow('Full HP', 'full_hp', 0, '#59d66f', 'Restore', true)}
        ${this._adjRow('STR', 'str', 1, '#ff9944')}
        ${this._adjRow('DEF', 'def', 1, '#44bbff')}
        ${this._adjRow('Spawn NPC', '_spawn_npc', 0, '#cc88ff', 'Spawn', true)}
        ${this._adjRow('Spawn Dummy', '_spawn_dummy', 0, '#888', 'Spawn', true)}
        ${this._adjRow('Heal All NPCs', '_heal_npcs', 0, '#59d66f', 'Heal', true)}
      `;
      this._bindAdjButtons(adj);
    }
  }

  _refreshInventory(p) {
    const crystals = Number(p.crystals ?? 0);

    this._el.querySelector('.pdp-res').innerHTML = `
      <div class="pdp-inv-grid">
        ${this._invCell('Logs', p.logs ?? 0, '#d4aa66')}
        ${this._invCell('Stone', p.stones ?? 0, '#aabbcc')}
        ${this._invCell('Copper', p.copper ?? 0, '#cc8844')}
        ${this._invCell('Crystals', crystals, '#44eeff')}
      </div>
    `;

    this._el.querySelector('.pdp-drops').innerHTML = `
      <div class="pdp-inv-grid">
        ${this._invCell('Meat', p.meat ?? 0, '#ff8866')}
        ${this._invCell('Feathers', p.feathers ?? 0, '#ffffaa')}
        ${this._invCell('Veg', p.vegetables ?? 0, '#88ff66')}
      </div>
    `;

    this._el.querySelector('.pdp-farming').innerHTML = `
      <div class="pdp-inv-grid">
        ${this._invCell('Seeds', p.seeds ?? 0, '#ccff88')}
      </div>
    `;

    // Data-driven inventory items (separate equipment from regular items)
    const inv = p.inventory ?? {};
    const eqManifest = this._scene._assetManifest?.equipment || {};
    const regularEntries = Object.entries(inv).filter(([id, qty]) => qty > 0 && !eqManifest[id]);
    const eqInvEntries = Object.entries(inv).filter(([id, qty]) => qty > 0 && eqManifest[id]);
    const invEl = this._el.querySelector('.pdp-inventory-dynamic');
    if (invEl) {
      invEl.innerHTML = regularEntries.length > 0
        ? `<div class="pdp-inv-grid">${regularEntries.map(([id, qty]) => this._invCell(id, qty, '#aaccee')).join('')}</div>`
        : '';
    }

    // Equipment section: equipped + inventory equipment
    const eqSection = this._el.querySelector('.pdp-equipment-section');
    if (eqSection) {
      let html = '';
      const equipped = p.equipment || {};
      // Show equipped items
      for (const [slot, eqId] of Object.entries(equipped)) {
        const def = eqManifest[eqId];
        const label = def?.label || eqId;
        html += `<div class="pdp-eq-row">
          <span class="pdp-eq-label" style="color:#88ff88">[${slot}] ${label}</span>
          <button class="pdp-eq-btn" data-unequip-slot="${slot}">Unequip</button>
        </div>`;
      }
      // Show equipment in inventory
      for (const [eqId, qty] of eqInvEntries) {
        const def = eqManifest[eqId];
        const label = def?.label || eqId;
        html += `<div class="pdp-eq-row">
          <span class="pdp-eq-label" style="color:#aaccee">${label} x${qty}</span>
          <button class="pdp-eq-btn" data-equip-inv="${eqId}">Equip</button>
          <button class="pdp-eq-btn" data-drop-eq="${eqId}">Drop</button>
        </div>`;
      }
      if (!html) html = '<span style="color:#667788;font-size:12px">No equipment</span>';
      eqSection.innerHTML = html;
      // Bind buttons
      eqSection.querySelectorAll('[data-unequip-slot]').forEach(btn => {
        btn.addEventListener('click', () => {
          this._scene._conn?.send({ type: 'unequip_item', slot: btn.dataset.unequipSlot });
        });
      });
      eqSection.querySelectorAll('[data-equip-inv]').forEach(btn => {
        btn.addEventListener('click', () => {
          this._scene._conn?.send({ type: 'equip_item', equipment_id: btn.dataset.equipInv });
        });
      });
      eqSection.querySelectorAll('[data-drop-eq]').forEach(btn => {
        btn.addEventListener('click', () => {
          this._scene._conn?.send({ type: 'drop_equipment', equipment_id: btn.dataset.dropEq });
        });
      });
    }

    // Give items — rebuild only once (static resources; dynamic items appended by _buildGiveItemsUI)
    const give = this._el.querySelector('.pdp-give');
    if (!give._built) {
      give._built = true;
      give.innerHTML = `
        ${this._adjRow('Logs', 'logs', 10, '#d4aa66')}
        ${this._adjRow('Stone', 'stones', 10, '#aabbcc')}
        ${this._adjRow('Copper', 'copper', 10, '#cc8844')}
        ${this._adjRow('Crystals', 'crystals', 10, '#44eeff')}
        ${this._adjRow('Meat', 'meat', 10, '#ff8866')}
        ${this._adjRow('Feathers', 'feathers', 10, '#ffffaa')}
        ${this._adjRow('Veg', 'vegetables', 10, '#88ff66')}
        ${this._adjRow('Seeds', 'seeds', 10, '#ccff88')}
      `;
      this._bindAdjButtons(give);
      // Append dynamic asset items if already loaded; otherwise _buildGiveItemsUI will append them later
      if (this._assetRegistry) this._buildGiveItemsUI();
    }

    // Crafting
    const craft = this._el.querySelector('.pdp-craft');
    if (!craft._built) {
      craft._built = true;
    }
    const canAnvil = (p.stones ?? 0) >= 5;
    const canCrystal = Number(p.crystals ?? 0) > 0;
    // Build equipment craft buttons from manifest
    let eqBtns = '';
    for (const [eqId, eqDef] of Object.entries(eqManifest)) {
      const recipe = eqDef.recipe || {};
      const ingredients = recipe.ingredients || {};
      const costParts = Object.entries(ingredients).map(([res, amt]) => `${amt} ${res}`).join(', ');
      const getResCount = (res) => p[res] ?? p.inventory?.[res] ?? 0;
      const canCraft = Object.entries(ingredients).every(([res, amt]) => getResCount(res) >= amt);
      eqBtns += `
        <button class="pdp-craft-btn" data-equip="${eqId}" ${canCraft ? '' : 'disabled'}>
          ${eqDef.label}<br><span class="pdp-craft-cost">${costParts}</span>
        </button>`;
    }
    craft.innerHTML = `
      <div class="pdp-craft-btns">
        <button class="pdp-craft-btn" data-action="anvil" ${canAnvil ? '' : 'disabled'}>
          Anvil<br><span class="pdp-craft-cost">5 stone</span>
        </button>
        <button class="pdp-craft-btn" data-action="crystal" ${canCrystal ? '' : 'disabled'}>
          Use Crystal<br><span class="pdp-craft-cost">${Number(p.crystals ?? 0)} avail</span>
        </button>
        ${eqBtns}
      </div>
    `;
    craft.querySelector('[data-action="anvil"]')?.addEventListener('click', () => {
      if ((this._scene.player?.stones ?? 0) >= 5) {
        this._scene._conn?.send({ type: 'build_anvil' });
        this._scene.chatBox?._addLog('Placing anvil...', '#88bbff');
      }
    });
    craft.querySelector('[data-action="crystal"]')?.addEventListener('click', () => {
      if (Number(this._scene.player?.crystals ?? 0) > 0) {
        this._scene._conn?.send({ type: 'consume_crystal' });
        this._scene.chatBox?._addLog('Using crystal...', '#44eeff');
      }
    });
    craft.querySelectorAll('[data-equip]').forEach(btn => {
      btn.addEventListener('click', () => {
        const eqId = btn.getAttribute('data-equip');
        this._scene._conn?.send({ type: 'craft_equipment', equipment_id: eqId });
      });
    });
  }

  _refreshKi(p) {
    const kiPct = p.maxKi > 0 ? (p.ki / p.maxKi) * 100 : 0;
    const bonuses = (p.kiBlastBonuses && typeof p.kiBlastBonuses === 'object') ? p.kiBlastBonuses : {};
    const blastCooldownBonus = Number(bonuses.blast_cooldown ?? 0);
    const barrierDurationBonus = Number(bonuses.barrier_duration ?? 0);
    const barrierCooldownBonus = Number(bonuses.barrier_cooldown ?? 0);
    const blastCooldownSec = Math.max(0.15, 1.2 - blastCooldownBonus * 0.05).toFixed(2);
    const barrierDurationMult = (1 + barrierDurationBonus * 0.01).toFixed(2);
    const barrierCooldownMult = Math.max(0.1, 1 - barrierCooldownBonus * 0.01).toFixed(2);

    this._el.querySelector('.pdp-ki-pool').innerHTML = `
      ${this._barRow('Ki', p.ki, p.maxKi, kiPct, '#4f98ff')}
      <div class="pdp-inv-grid" style="margin-top:8px">
        ${this._statCell('Max Ki', p.maxKi ?? 0)}
        ${this._statCell('Ki Lv', p.kiSkillLevel ?? 1)}
      </div>
    `;

    const KI_SHOT_MODES = [
      { id: 'ki_shot', label: 'Ki Shot', desc: 'Single blast' },
      { id: 'scatter_shot', label: 'Scatter Shot', desc: '3-way spread, 2× cost' },
      { id: 'explosive_shot', label: 'Explosive Shot', desc: 'AoE blast, 3× cost' },
    ];
    const activeMode = p.activeKiMode || 'ki_shot';
    const learnedMoves = p.kiMoves || [];
    const modeButtons = KI_SHOT_MODES.map(m => {
      const learned = m.id === 'ki_shot' || learnedMoves.includes(m.id);
      if (!learned) return `<div class="pdp-ki-mode locked" title="Not learned">${m.label} 🔒</div>`;
      const active = m.id === activeMode ? ' active' : '';
      return `<div class="pdp-ki-mode selectable${active}" data-mode="${m.id}" title="${m.desc}">${m.label}</div>`;
    }).join('');

    this._el.querySelector('.pdp-ki-blast').innerHTML = `
      <div class="pdp-kv-list">
        ${this._kv('Blast Level', p.blastLevel ?? 0)}
        ${this._kv('Damage', p.getBlastDmg?.() ?? '?')}
        ${this._kv('Cost', `${p.getBlastCost?.() ?? '?'} Ki`)}
        ${this._kv('Cooldown', `${blastCooldownSec}s`)}
        ${this._kv('Crystal Haste', this._signedPct(blastCooldownBonus))}
      </div>
      <h4 style="margin:8px 0 4px;color:#88bbff;font-size:12px">Shot Type</h4>
      <div class="pdp-ki-modes">${modeButtons}</div>
    `;

    for (const btn of this._el.querySelectorAll('.pdp-ki-mode.selectable')) {
      btn.addEventListener('click', () => {
        p.activeKiMode = btn.dataset.mode;
        this._refreshKi(p);
      });
    }

    this._el.querySelector('.pdp-ki-barrier').innerHTML = `
      <div class="pdp-kv-list">
        ${this._kv('Punch Block', '10%')}
        ${this._kv('Ki Block', '10%')}
        ${this._kv('Proc Cost', '3 Ki')}
        ${this._kv('Duration Mult', `×${barrierDurationMult}`)}
        ${this._kv('Cooldown Mult', `×${barrierCooldownMult}`)}
      </div>
    `;

    const kiAdj = this._el.querySelector('.pdp-ki-adj');
    if (!kiAdj._built) {
      kiAdj._built = true;
      kiAdj.innerHTML = `
        ${this._adjRow('Max Ki', 'maxKi', 5, '#4f98ff')}
        ${this._adjRow('Full Ki', 'full_ki', 0, '#4f98ff', 'Restore', true)}
        ${this._adjRow('∞ Ki', 'inf_ki', 0, '#9557ff', 'Toggle', true)}
        ${this._adjRow('Ki Level', 'ki_level', 1, '#9f8fff')}
        ${this._adjRow('Blast Level', 'blastLevel', 1, '#66ddff')}
      `;
      this._bindAdjButtons(kiAdj);
    }
  }

  // Dynamically populate the Give Items container with items from the asset registry
  _buildGiveItemsUI() {
    const container = this._giveItemsContainer;
    if (!container || !this._assetRegistry) return;
    // Remove any previously appended dynamic section
    const prev = container.querySelector('.pdp-give-dynamic');
    if (prev) prev.remove();

    const items = Array.isArray(this._assetRegistry) ? this._assetRegistry : Object.values(this._assetRegistry);
    if (!items.length) return;

    // Group by category
    const categories = {};
    for (const item of items) {
      const cat = item.category ?? 'misc';
      if (!categories[cat]) categories[cat] = [];
      categories[cat].push(item);
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'pdp-give-dynamic';

    for (const [cat, catItems] of Object.entries(categories)) {
      const heading = document.createElement('h4');
      heading.textContent = cat;
      heading.style.cssText = 'margin:6px 0 2px;color:#99bbcc;font-size:11px;text-transform:uppercase;';
      wrapper.appendChild(heading);

      const adjHtml = catItems.map(item => {
        const field = `inv:${item.id}`;
        const label = item.label ?? item.name ?? item.id;
        const step = item.stackable === false ? 1 : 1;
        return this._adjRow(label, field, step, '#aaccee');
      }).join('');

      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = adjHtml;
      while (tempDiv.firstChild) wrapper.appendChild(tempDiv.firstChild);
    }

    container.appendChild(wrapper);
    this._bindAdjButtons(wrapper);
  }

  _onGiveItem(itemId) {
    this._send(`inv:${itemId}`, 1);
  }

  // Build an adjustment row with +/- buttons or a single action button
  _adjRow(label, field, step, color, btnLabel = null, single = false) {
    if (single) {
      return `<div class="pdp-adj-row">
        <span class="pdp-adj-label" style="color:${color}">${label}</span>
        <button class="pdp-adj-btn pdp-adj-action" data-field="${field}" data-step="${step}" style="border-color:${color}">${btnLabel || label}</button>
      </div>`;
    }
    return `<div class="pdp-adj-row">
      <span class="pdp-adj-label" style="color:${color}">${label}</span>
      <div class="pdp-adj-btns">
        <button class="pdp-adj-btn pdp-adj-minus" data-field="${field}" data-step="${step}" style="border-color:${color}">−</button>
        <button class="pdp-adj-btn pdp-adj-plus" data-field="${field}" data-step="${step}" style="border-color:${color}">+${step}</button>
      </div>
    </div>`;
  }

  _bindAdjButtons(container) {
    container.querySelectorAll('.pdp-adj-plus').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const field = btn.dataset.field;
        const step = Number(btn.dataset.step) || 1;
        this._send(field, e.shiftKey ? step * 10 : step);
      });
    });
    container.querySelectorAll('.pdp-adj-minus').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const field = btn.dataset.field;
        const step = Number(btn.dataset.step) || 1;
        this._send(field, e.shiftKey ? -step * 10 : -step);
      });
    });
    container.querySelectorAll('.pdp-adj-action').forEach(btn => {
      btn.addEventListener('click', () => {
        const field = btn.dataset.field;
        const step = Number(btn.dataset.step) || 0;
        if (field === '_spawn_npc') {
          this._scene._adminUi?.adminSpawnNPC?.();
        } else if (field === '_spawn_dummy') {
          this._scene._conn?.send({ type: 'build_dummy', logs: 20 });
        } else if (field === '_heal_npcs') {
          for (const npc of (this._scene.npcs || [])) {
            if (!npc.isDead?.()) this._scene._conn?.send({ type: 'admin', field: 'full_hp', value: 0, target_npc_id: npc.id });
          }
        } else {
          this._send(field, step);
        }
      });
    });
  }

  _barRow(label, current, max, pct, color) {
    return `<div class="pdp-bar-stat">
      <div class="pdp-bar-top"><span>${label}</span><span>${current}/${max}</span></div>
      <div class="pdp-bar-wrap"><div class="pdp-bar" style="width:${pct}%;background:${color}"></div></div>
    </div>`;
  }

  _statCell(label, value, wide = false) {
    return `<div class="pdp-stat-cell ${wide ? 'pdp-stat-wide' : ''}">
      <span class="pdp-stat-lbl">${label}</span>
      <strong class="pdp-stat-val">${value}</strong>
    </div>`;
  }

  _invCell(label, value, color = '#ccc') {
    return `<div class="pdp-inv-cell">
      <span class="pdp-inv-lbl">${label}</span>
      <strong class="pdp-inv-val" style="color:${color}">${value}</strong>
    </div>`;
  }

  _kv(label, value) {
    return `<div class="pdp-kv-row"><span>${label}</span><span>${value}</span></div>`;
  }

  _signedPct(v) {
    const n = Number(v ?? 0);
    return `${n >= 0 ? '+' : ''}${n}%`;
  }

  _injectStyles() {
    if (document.getElementById('player-detail-panel-styles')) return;
    const style = document.createElement('style');
    style.id = 'player-detail-panel-styles';
    style.textContent = `
      #player-detail-panel { position: fixed; inset: 0; z-index: 4000; font-family: Georgia, serif; }
      #player-detail-panel .pdp-backdrop { position: absolute; inset: 0; background: rgba(4,8,18,0.75); backdrop-filter: blur(3px); }
      #player-detail-panel .pdp-shell { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
        width: min(860px, calc(100vw - 32px)); height: min(620px, calc(100vh - 32px));
        background: linear-gradient(180deg,#111a2c 0%,#0a1020 100%); border: 1px solid #33506d;
        box-shadow: 0 18px 60px rgba(0,0,0,0.5); color: #dce7f2; display: flex; flex-direction: column; }
      #player-detail-panel .pdp-header { display: flex; justify-content: space-between; align-items: center;
        padding: 14px 18px 10px; border-bottom: 1px solid #23354b; flex-shrink: 0; }
      #player-detail-panel .pdp-title { font-size: 26px; color: #f6cf61; font-weight: 700; }
      #player-detail-panel .pdp-subtitle { font-size: 13px; color: #8ca2b8; margin-top: 2px; }
      #player-detail-panel .pdp-close { border: 1px solid #46627f; background: #122034; color: #dce7f2;
        width: 32px; height: 32px; cursor: pointer; font-size: 16px; }
      #player-detail-panel .pdp-tabs { display: flex; gap: 0; border-bottom: 1px solid #23354b; flex-shrink: 0; }
      #player-detail-panel .pdp-tab { background: #0c1524; border: none; border-right: 1px solid #23354b;
        color: #7a99b8; padding: 9px 20px; cursor: pointer; font-size: 14px; font-family: inherit; }
      #player-detail-panel .pdp-tab.active { color: #e7f5ff; background: #132540; border-bottom: 2px solid #60cfff; }
      #player-detail-panel .pdp-body { flex: 1; min-height: 0; overflow: hidden; }
      #player-detail-panel .pdp-pane { display: none; height: 100%; overflow-y: auto; padding: 14px; box-sizing: border-box; }
      #player-detail-panel .pdp-pane.active { display: block; }
      #player-detail-panel .pdp-two-col { display: grid; grid-template-columns: 280px 1fr; gap: 14px; }
      #player-detail-panel .pdp-col-left, #player-detail-panel .pdp-col-right { display: flex; flex-direction: column; gap: 12px; }
      #player-detail-panel .pdp-section { background: rgba(20,30,46,0.9); border: 1px solid #263b55; padding: 12px; }
      #player-detail-panel .pdp-section h3 { margin: 0 0 10px; font-size: 13px; color: #7ab0d8;
        text-transform: uppercase; letter-spacing: 0.08em; }

      /* Bars */
      #player-detail-panel .pdp-bar-stat { margin-bottom: 8px; }
      #player-detail-panel .pdp-bar-top { display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 3px; }
      #player-detail-panel .pdp-bar-wrap { height: 10px; background: #0b1220; border: 1px solid #1e3249; }
      #player-detail-panel .pdp-bar { height: 100%; transition: width 0.2s; }

      /* Stat cells */
      #player-detail-panel .pdp-stat-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin-top: 8px; }
      #player-detail-panel .pdp-stat-cell { background: #0d1625; border: 1px solid #21354d; padding: 8px 10px;
        display: flex; justify-content: space-between; align-items: center; }
      #player-detail-panel .pdp-stat-wide { grid-column: 1 / -1; }
      #player-detail-panel .pdp-stat-lbl { font-size: 11px; color: #8ca2b8; text-transform: uppercase; }
      #player-detail-panel .pdp-stat-val { font-size: 17px; color: #f3f7fb; }

      /* Inventory cells */
      #player-detail-panel .pdp-inv-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
      #player-detail-panel .pdp-inv-cell { background: #0d1625; border: 1px solid #21354d; padding: 8px 10px;
        display: flex; flex-direction: column; gap: 4px; }
      #player-detail-panel .pdp-inv-lbl { font-size: 11px; color: #8ca2b8; text-transform: uppercase; }
      #player-detail-panel .pdp-inv-val { font-size: 20px; }

      /* Adj rows */
      #player-detail-panel .pdp-adj-row { display: flex; align-items: center; justify-content: space-between;
        padding: 5px 0; border-bottom: 1px solid rgba(75,107,139,0.12); }
      #player-detail-panel .pdp-adj-row:last-child { border-bottom: 0; }
      #player-detail-panel .pdp-adj-label { font-size: 13px; min-width: 80px; }
      #player-detail-panel .pdp-adj-btns { display: flex; gap: 4px; }
      #player-detail-panel .pdp-adj-btn { background: #0d1625; color: #cde; border: 1px solid #335;
        padding: 3px 10px; cursor: pointer; font-size: 13px; font-family: inherit; min-width: 36px; }
      #player-detail-panel .pdp-adj-btn:hover { background: #152540; color: #fff; }
      #player-detail-panel .pdp-adj-action { min-width: 72px; }

      /* Craft buttons */
      #player-detail-panel .pdp-craft-btns { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
      #player-detail-panel .pdp-craft-btn { background: #0d1625; border: 1px solid #335566; color: #c8e0f4;
        padding: 10px 6px; cursor: pointer; font-size: 13px; font-family: inherit; text-align: center; line-height: 1.4; }
      #player-detail-panel .pdp-craft-btn:hover:not([disabled]) { background: #152540; color: #fff; }
      #player-detail-panel .pdp-craft-btn[disabled] { opacity: 0.4; cursor: default; }
      #player-detail-panel .pdp-craft-cost { font-size: 11px; color: #7a99b8; }

      /* Equipment rows */
      #player-detail-panel .pdp-eq-row { display: flex; align-items: center; gap: 8px;
        padding: 5px 0; border-bottom: 1px solid rgba(75,107,139,0.12); }
      #player-detail-panel .pdp-eq-row:last-child { border-bottom: 0; }
      #player-detail-panel .pdp-eq-label { flex: 1; font-size: 13px; }
      #player-detail-panel .pdp-eq-btn { background: #0d1625; color: #cde; border: 1px solid #335;
        padding: 3px 10px; cursor: pointer; font-size: 12px; font-family: inherit; }
      #player-detail-panel .pdp-eq-btn:hover { background: #152540; color: #fff; }

      /* Combat mode toggle */
      #player-detail-panel .pdp-combat-mode { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
      #player-detail-panel .pdp-cm-btn { font-size: 11px; padding: 3px 12px; border-radius: 4px;
        border: 1px solid rgba(75,107,139,0.3); background: rgba(20,30,50,0.6); color: #8899aa;
        cursor: pointer; font-family: inherit; }
      #player-detail-panel .pdp-cm-btn:hover { background: rgba(40,60,100,0.6); border-color: #4488cc; color: #cde; }
      #player-detail-panel .pdp-cm-btn.active[data-cm="kill"] { background: rgba(150,40,40,0.5);
        border-color: #ff4444; color: #ffaaaa; box-shadow: 0 0 6px rgba(255,68,68,0.3); }
      #player-detail-panel .pdp-cm-btn.active[data-cm="ko"] { background: rgba(40,100,150,0.5);
        border-color: #44aaff; color: #aaddff; box-shadow: 0 0 6px rgba(68,170,255,0.3); }

      /* KV rows */
      #player-detail-panel .pdp-kv-list { display: flex; flex-direction: column; gap: 0; }
      #player-detail-panel .pdp-kv-row { display: flex; justify-content: space-between; gap: 8px;
        font-size: 13px; padding: 5px 0; border-bottom: 1px solid rgba(75,107,139,0.12); }
      #player-detail-panel .pdp-kv-row:last-child { border-bottom: 0; }

      #player-detail-panel .pdp-ki-modes { display: flex; gap: 6px; flex-wrap: wrap; }
      #player-detail-panel .pdp-ki-mode { font-size: 12px; padding: 4px 10px; border-radius: 4px;
        border: 1px solid rgba(75,107,139,0.3); background: rgba(20,30,50,0.6); color: #8899aa; }
      #player-detail-panel .pdp-ki-mode.locked { opacity: 0.4; cursor: default; }
      #player-detail-panel .pdp-ki-mode.selectable { cursor: pointer; color: #aaccee; }
      #player-detail-panel .pdp-ki-mode.selectable:hover { background: rgba(40,60,100,0.6); border-color: #4488cc; }
      #player-detail-panel .pdp-ki-mode.selectable.active { background: rgba(40,80,150,0.5);
        border-color: #44aaff; color: #ffffff; box-shadow: 0 0 6px rgba(68,170,255,0.3); }

      @media (max-width: 860px) {
        #player-detail-panel .pdp-shell { width: calc(100vw - 16px); height: calc(100vh - 16px); }
        #player-detail-panel .pdp-two-col { grid-template-columns: 1fr; }
      }
    `;
    document.head.appendChild(style);
  }
}
