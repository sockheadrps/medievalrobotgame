import Phaser from 'phaser';
import {
  CHARGE_STR_BONUS,
  CHARGE_DEF_BONUS,
  CHARGE_KI_ATTACK_BONUS,
  CHARGE_KI_REGEN_BONUS,
} from '../constants.js';
import { KI_DENOMINATIONS } from '../data/kiDenominations.js';

const KI_TIER_MOVES = [
  { tier: 1, moves: [{ id: 'ki_shot', label: 'Ki Shot' }, { id: 'charge', label: 'Charge' }, { id: 'sense_ki', label: 'Sense Ki' }] },
  { tier: 2, moves: [{ id: 'barrier', label: 'Barrier' }] },
];

const UPGRADE_LABELS = {
  ki_shot: {
    range: 'Range',
    cooldown: 'Cooldown',
    speed: 'Projectile Speed',
    damage: 'Damage',
  },
  charge: {
    ceiling: 'Charge Ceiling',
    decay: 'Decay Reduction',
    speed: 'Charge Speed',
  },
  barrier: {
    physical_block: 'Physical Block',
    ki_block: 'Ki Block',
  },
  sense_ki: {
    range_pct: 'Sense Range',
    level_delta: 'Level Gap Read',
  },
};

export class PlayerDetailPanel {
  constructor(scene) {
    this._scene = scene;
    this._el = null;
    this._timer = null;
    this._refreshSuspendUntil = 0;
  }

  isOpen() { return !!this._el; }

  open() {
    if (this._el) this.close();
    this._build();
    this._refresh();
    this._timer = setInterval(() => this._refresh(), 400);
  }

  close() {
    if (this._scene) this._scene._charMenuOpen = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this._el) {
      this._el.remove();
      this._el = null;
    }
  }

  _build() {
    const denominationTabs = Object.values(KI_DENOMINATIONS).map((denomination) => (
      `<button class="pdp-tab" data-tab="${this._getDenominationPaneKey(denomination.id)}">${denomination.label}</button>`
    )).join('');
    const denominationPanes = Object.values(KI_DENOMINATIONS).map((denomination) => (
      `<div class="pdp-pane" data-pane="${this._getDenominationPaneKey(denomination.id)}"></div>`
    )).join('');
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
          <button class="pdp-close">X</button>
        </div>
        <div class="pdp-body">
          <div class="pdp-left">
            <div class="pdp-section">
              <h3>Stats</h3>
              <div class="pdp-stats"></div>
            </div>
            <div class="pdp-section">
              <h3>Resources</h3>
              <div class="pdp-resources"></div>
            </div>
            <div class="pdp-section">
              <h3>Equipment</h3>
              <div class="pdp-equipment"></div>
            </div>
          </div>
          <div class="pdp-right">
            <div class="pdp-tabs">
              <button class="pdp-tab active" data-tab="overview">Overview</button>
              <button class="pdp-tab" data-tab="ki">Ki Skills</button>
              ${denominationTabs}
            </div>
            <div class="pdp-content">
              <div class="pdp-pane active" data-pane="overview"></div>
              <div class="pdp-pane" data-pane="ki"></div>
              ${denominationPanes}
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(el);
    this._el = el;
    this._injectStyles();
    el.querySelector('.pdp-close')?.addEventListener('click', () => this.close());
    el.querySelector('.pdp-backdrop')?.addEventListener('click', () => this.close());
    el.querySelector('.pdp-shell')?.addEventListener('click', (event) => event.stopPropagation());
    el.querySelector('.pdp-shell')?.addEventListener('pointerdown', (event) => event.stopPropagation());
    el.querySelector('.pdp-content')?.addEventListener('pointerdown', (event) => this._handleContentPointerDown(event));
    el.querySelector('.pdp-content')?.addEventListener('input', (event) => this._handleContentInput(event));
    el.querySelector('.pdp-content')?.addEventListener('click', (event) => this._handleContentClick(event));
    el.querySelector('.pdp-content')?.addEventListener('change', (event) => this._handleContentChange(event));
    for (const tab of el.querySelectorAll('.pdp-tab')) {
      tab.addEventListener('click', () => {
        el.querySelectorAll('.pdp-tab').forEach((node) => node.classList.remove('active'));
        el.querySelectorAll('.pdp-pane').forEach((node) => node.classList.remove('active'));
        tab.classList.add('active');
        el.querySelector(`.pdp-pane[data-pane="${tab.dataset.tab}"]`)?.classList.add('active');
      });
    }
  }

  _refresh() {
    if (!this._el) return;
    if (Date.now() < this._refreshSuspendUntil) return;
    const scene = this._scene;
    const p = scene.player;
    if (!p) return;

    this._el.querySelector('.pdp-subtitle').textContent = `${scene.playerId || 'Player'}  Level ${p.level}`;

    const hpPct = p.maxHp > 0 ? (p.hp / p.maxHp) * 100 : 0;
    const kiPct = p.maxKi > 0 ? (p.ki / p.maxKi) * 100 : 0;
    const chargePower = this._getChargePower(p);
    const chargePct = Math.round(chargePower * 100);
    const effectiveStr = this._getChargedStat(p.str, chargePower, CHARGE_STR_BONUS);
    const effectiveDef = this._getChargedStat(p.def, chargePower, CHARGE_DEF_BONUS);
    const attackMult = this._getChargeMultiplier(chargePower, CHARGE_KI_ATTACK_BONUS);
    const regenMult = this._getChargeMultiplier(chargePower, CHARGE_KI_REGEN_BONUS);
    const senseRangeLevel = this._getSenseRangeLevel(p);
    const senseRangePct = Number(p.kiUpgrades?.sense_ki?.range_pct || 0);
    const senseTiles = [8, 16, 24, 32][senseRangeLevel] || 8;
    this._el.querySelector('.pdp-stats').innerHTML = `
      ${this._barStat('HP', p.hp, p.maxHp, hpPct, hpPct > 50 ? '#59d66f' : hpPct > 25 ? '#d6aa44' : '#d65c5c')}
      ${this._barStat(`Ki${chargePct > 0 ? ` (Charge ${chargePct}%)` : ''}`, p.ki, p.maxKi, kiPct, kiPct > 50 ? '#4f98ff' : kiPct > 25 ? '#6c63ff' : '#9557ff')}
      <div class="pdp-stat-grid">
        ${this._bigStat('STR', chargePct > 0 ? `${effectiveStr} (${p.str})` : p.str)}
        ${this._bigStat('DEF', chargePct > 0 ? `${effectiveDef} (${p.def})` : p.def)}
        ${this._bigStat('Lv', p.level)}
        ${this._bigStat('XP', `${p.xp}/${p.level * 20}`)}
        ${this._bigStat('Ki Skill', p.kiSkillLevel ?? 1)}
        ${this._bigStat('Ki XP', `${p.kiSkillXp ?? 0}/${(p.kiSkillLevel ?? 1) * 20}`)}
        ${this._bigStat('Realm', p.realmTier ?? 0)}
        ${this._bigStat('Inf Ki', p.infKi ? 'On' : 'Off')}
        ${this._bigStat('Ki Dmg', `${attackMult.toFixed(2)}x`)}
        ${this._bigStat('Ki Regen', `${regenMult.toFixed(2)}x`)}
      </div>
    `;

    this._el.querySelector('.pdp-resources').innerHTML = `
      <div class="pdp-lines">
        <div>Logs: ${p.logs ?? 0}</div>
        <div>Stone: ${p.stones ?? 0}</div>
        <div>Bastalite: ${p.bastalite ?? 0}</div>
        <div>Pristine Crystal: ${p.crystalPristine ?? 0}</div>
        <div>Ki Crystal: ${p.crystalNormal ?? 0}</div>
        <div>Cracked Crystal: ${p.crystalPoor ?? 0}</div>
        <div>Realm Crystal T1: ${p.realmCrystalT1 ?? 0}</div>
      </div>
    `;

    this._el.querySelector('.pdp-equipment').innerHTML = `
      <div class="pdp-lines">
        <div>Armor: ${p.armorElite ? 'Elite Armor [Equipped]' : p.armorEliteInv ? 'Elite Armor [In Bag]' : 'None'}</div>
      </div>
    `;

    const learnedMoves = Array.isArray(p.kiMoves) ? p.kiMoves : [];
    const overview = this._el.querySelector('.pdp-pane[data-pane="overview"]');
    overview.innerHTML = `
      <div class="pdp-card-grid">
        <div class="pdp-card">
          <div class="pdp-card-title">Meditation</div>
          <div class="pdp-card-body">${(p.kiSkillLevel ?? 1) >= 10 ? 'Unlocked' : 'Locked until Ki Skill 10'}</div>
        </div>
        <div class="pdp-card">
          <div class="pdp-card-title">Blast</div>
          <div class="pdp-card-body">Level ${p.blastLevel ?? 0}<br>Damage ${p.getBlastDmg?.() ?? '?'}<br>Cost ${p.getBlastCost?.() ?? '?'} Ki</div>
        </div>
        <div class="pdp-card">
          <div class="pdp-card-title">Charge</div>
          <div class="pdp-card-body">${p.charging ? 'Charging now' : chargePct > 0 ? 'Stored charge' : 'Inactive'}<br>Power ${chargePct}%<br>STR ${effectiveStr} / DEF ${effectiveDef}</div>
        </div>
        <div class="pdp-card">
          <div class="pdp-card-title">Aura Color</div>
          <div class="pdp-card-body">
            <label class="pdp-color-row">
              <input type="color" value="${this._tintToHex(p.auraTint)}" data-action="aura-color">
              <span>${this._tintToHex(p.auraTint)}</span>
            </label>
            <label class="pdp-range-row">
              <span>Opacity</span>
              <input type="range" min="0" max="100" step="1" value="${this._alphaToPercent(p.auraAlpha)}" data-action="aura-alpha">
              <strong data-role="aura-alpha-value">${this._alphaToPercent(p.auraAlpha)}%</strong>
            </label>
          </div>
        </div>
        <div class="pdp-card">
          <div class="pdp-card-title">Learned Moves</div>
          <div class="pdp-card-body">${learnedMoves.length ? learnedMoves.map((m) => this._formatMove(m)).join(', ') : 'None yet'}</div>
        </div>
        <div class="pdp-card">
          <div class="pdp-card-title">Sense Ki</div>
          <div class="pdp-card-body">Sense ${senseRangeLevel} / 3 (${senseTiles} tiles base, +${senseRangePct}% range)<br>Gap Read +${Number(p.kiUpgrades?.sense_ki?.level_delta || 0)}</div>
        </div>
      </div>
    `;

    const kiPane = this._el.querySelector('.pdp-pane[data-pane="ki"]');
    kiPane.innerHTML = `
      <div class="pdp-ki-summary">
        <div class="pdp-ki-row"><span>Ki Skill</span><span>${p.kiSkillLevel ?? 1}</span></div>
        <div class="pdp-ki-row"><span>Ki XP</span><span>${p.kiSkillXp ?? 0}/${(p.kiSkillLevel ?? 1) * 20}</span></div>
        <div class="pdp-ki-row"><span>Blast Level</span><span>${p.blastLevel ?? 0}</span></div>
        <div class="pdp-ki-row"><span>Charge Power</span><span>${chargePct}%</span></div>
        <div class="pdp-ki-row"><span>Effective STR / DEF</span><span>${effectiveStr} / ${effectiveDef}</span></div>
        <div class="pdp-ki-row"><span>Realm Tier</span><span>${p.realmTier ?? 0}</span></div>
        <div class="pdp-ki-row"><span>Learned Moves</span><span>${learnedMoves.length ? learnedMoves.map((m) => this._formatMove(m)).join(', ') : 'None'}</span></div>
      </div>
      <div class="pdp-upgrade-block">
        <div class="pdp-upgrade-title">Current Shrine Upgrades</div>
        ${this._renderKnownUpgradeSummary(p)}
      </div>
    `;

    for (const denomination of Object.values(KI_DENOMINATIONS)) {
      const pane = this._el.querySelector(`.pdp-pane[data-pane="${this._getDenominationPaneKey(denomination.id)}"]`);
      if (!pane) continue;
      pane.innerHTML = this._renderDenominationPane(p, denomination);
    }
  }

  _renderKnownUpgradeSummary(player) {
    const blocks = [];
    for (const tier of KI_TIER_MOVES) {
      for (const move of tier.moves) {
        if (!(player.kiMoves || []).includes(move.id)) continue;
        const rows = this._upgradeRows(player, move.id);
        if (!rows.length) continue;
        blocks.push(`
          <div class="pdp-upgrade-summary-card">
            <div class="pdp-upgrade-summary-title">${move.label}</div>
            ${rows.map((row) => `<div class="pdp-upgrade-row"><span>${row.label}</span><span>${row.value}</span></div>`).join('')}
          </div>
        `);
      }
    }
    return blocks.length ? blocks.join('') : '<div class="pdp-empty">No shrine upgrades yet.</div>';
  }

  _renderTierMoveCard(player, move) {
    const unlocked = (player.kiMoves || []).includes(move.id);
    const rows = this._upgradeRows(player, move.id);
    return `
      <div class="pdp-move-card ${unlocked ? 'unlocked' : 'locked'}">
        <div class="pdp-move-header">
          <div>
            <span class="pdp-move-name">${move.label}</span>
            <span class="pdp-move-state">${unlocked ? 'Learned' : 'Unlearned'}</span>
          </div>
          <div class="pdp-move-actions">
            <button class="pdp-test-btn" data-action="move-toggle" data-move="${move.id}">
              ${unlocked ? 'Unlearn' : 'Learn'}
            </button>
          </div>
        </div>
        <div class="pdp-move-body">
          ${rows.length
            ? rows.map((row) => `
              <div class="pdp-upgrade-row">
                <span>${row.label}</span>
                <div class="pdp-upgrade-controls">
                  <button class="pdp-stepper-btn" data-action="upgrade-adjust" data-move="${move.id}" data-stat="${row.statId}" data-delta="-1">-</button>
                  <span>${row.value}</span>
                  <button class="pdp-stepper-btn" data-action="upgrade-adjust" data-move="${move.id}" data-stat="${row.statId}" data-delta="1">+</button>
                </div>
              </div>
            `).join('')
            : '<div class="pdp-empty">No shrine modifiers for this move.</div>'}
        </div>
      </div>
    `;
  }

  _upgradeRows(player, moveId) {
    const upgrades = player.kiUpgrades?.[moveId] || {};
    const labels = UPGRADE_LABELS[moveId] || {};
    return Object.keys(labels).map((key) => {
      const raw = Number(upgrades[key] || 0);
      let value = `+${raw}%`;
      if (key === 'level_delta') value = `+${raw}`;
      if (moveId === 'barrier' && (key === 'physical_block' || key === 'ki_block')) value = `+${raw}%`;
      return { label: labels[key], value, statId: key };
    });
  }

  _getSenseRangeLevel(player) {
    const known = new Set(player?.kiKnownAugments?.sense_ki || []);
    let level = 0;
    if (known.has('sense_1')) level += 1;
    if (known.has('sense_2')) level += 1;
    if (known.has('sense_3')) level += 1;
    if (level <= 0) {
      level = Phaser.Math.Clamp(Number(player?.kiUpgrades?.sense_ki?.range || 0), 0, 3);
    }
    return level;
  }

  _handleContentClick(event) {
    const btn = event.target.closest('button[data-action]');
    if (!btn || !this._scene?._conn) return;
    const action = btn.dataset.action;
    if (action === 'progression-unlock') {
      this._scene._conn.send({
        type: 'ki_progress_unlock',
        kind: btn.dataset.kind,
        denomination_id: btn.dataset.denomination || null,
        move_id: btn.dataset.move || null,
        augment_id: btn.dataset.augment || null,
      });
      this._refreshSoon();
      return;
    }
    if (action === 'progression-equip') {
      this._scene._conn.send({
        type: 'ki_progress_equip',
        move_id: btn.dataset.move || null,
        augment_id: btn.dataset.augment || null,
      });
      this._refreshSoon();
      return;
    }
    if (action === 'move-toggle') {
      const moveId = btn.dataset.move;
      if (!moveId) return;
      this._scene._conn.send({
        type: 'admin',
        field: 'ki_move_toggle',
        value: 0,
        target_npc_id: null,
        move_id: moveId,
      });
      this._refreshSoon();
      return;
    }
    if (action === 'upgrade-adjust') {
      const moveId = btn.dataset.move;
      const statId = btn.dataset.stat;
      const delta = Number(btn.dataset.delta || 0);
      if (!moveId || !statId || !delta) return;
      this._scene._conn.send({
        type: 'admin',
        field: 'ki_upgrade_adjust',
        value: delta,
        delta,
        target_npc_id: null,
        move_id: moveId,
        stat_id: statId,
      });
      this._refreshSoon();
    }
  }

  _handleContentPointerDown(event) {
    if (event.target.closest('input[data-action="aura-color"], input[data-action="aura-alpha"]')) {
      this._refreshSuspendUntil = Date.now() + 10000;
    }
  }

  _handleContentInput(event) {
    const slider = event.target.closest('input[data-action="aura-alpha"]');
    if (!slider || !this._scene?.player) return;
    const percent = Phaser.Math.Clamp(Number(slider.value || 0), 0, 100);
    this._scene.player.auraAlpha = percent / 100;
    this._refreshSuspendUntil = Date.now() + 10000;
    const label = this._el?.querySelector('[data-role="aura-alpha-value"]');
    if (label) label.textContent = `${Math.round(percent)}%`;
  }

  _handleContentChange(event) {
    const input = event.target.closest('input[data-action="aura-color"]');
    if (input && this._scene?._conn) {
      const color = String(input.value || '').trim();
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) return;
      this._refreshSuspendUntil = Date.now() + 300;
      this._scene.player.auraTint = parseInt(color.slice(1), 16);
      this._scene._conn.send({
        type: 'admin',
        field: 'aura_tint',
        value: color,
        target_npc_id: null,
      });
      this._refreshSoon();
      return;
    }
    const slider = event.target.closest('input[data-action="aura-alpha"]');
    if (!slider || !this._scene?._conn) return;
    const percent = Phaser.Math.Clamp(Number(slider.value || 0), 0, 100);
    const alpha = percent / 100;
    this._refreshSuspendUntil = Date.now() + 300;
    this._scene.player.auraAlpha = alpha;
    this._scene._conn.send({
      type: 'admin',
      field: 'aura_alpha',
      value: alpha,
      target_npc_id: null,
    });
    this._refreshSoon();
  }

  _refreshSoon() {
    if (!this._el) return;
    window.setTimeout(() => this._refresh(), 60);
  }

  _formatMove(moveId) {
    return String(moveId || '').replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
  }

  _barStat(label, current, max, pct, color) {
    return `
      <div class="pdp-stat">
        <div class="pdp-stat-top"><span>${label}</span><span>${current}/${max}</span></div>
        <div class="pdp-bar-wrap"><div class="pdp-bar" style="width:${pct}%;background:${color}"></div></div>
      </div>
    `;
  }

  _bigStat(label, value) {
    return `<div class="pdp-big-stat"><span>${label}</span><strong>${value}</strong></div>`;
  }

  _renderDenominationPane(player, denomination) {
    return `
      <div class="pdp-path-currency">Realm Crystals: <strong>${Number(player.realmCrystalT1 ?? 0)}</strong></div>
      ${this._renderDenominationCard(player, denomination)}
    `;
  }

  _renderDenominationCard(player, denomination) {
    const knownDenomination = player.hasKiDenomination?.(denomination.id);
    const unlockBtn = knownDenomination
      ? '<span class="pdp-path-owned">Unlocked</span>'
      : `<button class="pdp-test-btn" data-action="progression-unlock" data-kind="denomination" data-denomination="${denomination.id}">Unlock (${denomination.cost ?? 0})</button>`;
    return `
      <div class="pdp-path-card">
        <div class="pdp-path-header">
          <div>
            <div class="pdp-path-title">${denomination.label}</div>
            <div class="pdp-path-theme">${denomination.theme}</div>
          </div>
          <div class="pdp-path-actions">${unlockBtn}</div>
        </div>
        ${Object.values(denomination.moves || {}).map((move) => this._renderProgressionMove(player, denomination, move)).join('')}
      </div>
    `;
  }

  _renderProgressionMove(player, denomination, move) {
    const knownDenomination = player.hasKiDenomination?.(denomination.id);
    const knownMove = player.hasKiMove?.(move.id);
    const moveState = knownMove
      ? '<span class="pdp-path-owned">Learned</span>'
      : knownDenomination
        ? `<button class="pdp-test-btn" data-action="progression-unlock" data-kind="move" data-denomination="${denomination.id}" data-move="${move.id}">Learn (${move.cost ?? 0})</button>`
        : '<span class="pdp-empty">Unlock the denomination first</span>';
    const augments = Object.values(move.augments || {});
    return `
      <div class="pdp-path-move">
        <div class="pdp-path-move-header">
          <span class="pdp-path-move-name">${move.label}</span>
          <span>${moveState}</span>
        </div>
        ${knownMove ? this._renderProgressionUpgradeControls(player, move.id) : ''}
        ${augments.length ? augments.map((augment) => this._renderProgressionAugment(player, move, augment)).join('') : '<div class="pdp-empty">No augments yet.</div>'}
      </div>
    `;
  }

  _renderProgressionUpgradeControls(player, moveId) {
    const rows = this._upgradeRows(player, moveId);
    if (!rows.length) return '';
    return `
      <div class="pdp-upgrade-summary-card">
        <div class="pdp-upgrade-summary-title">Dev Upgrades</div>
        ${rows.map((row) => `
          <div class="pdp-upgrade-row">
            <span>${row.label}</span>
            <div class="pdp-upgrade-controls">
              <button class="pdp-stepper-btn" data-action="upgrade-adjust" data-move="${moveId}" data-stat="${row.statId}" data-delta="-1">-</button>
              <span>${row.value}</span>
              <button class="pdp-stepper-btn" data-action="upgrade-adjust" data-move="${moveId}" data-stat="${row.statId}" data-delta="1">+</button>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  _renderProgressionAugment(player, move, augment) {
    const knownMove = player.hasKiMove?.(move.id);
    const knownAugment = player.hasKiAugment?.(move.id, augment.id);
    const equippedAugment = player.getEquippedKiAugment?.(move.id);
    let actionHtml = '<span class="pdp-empty">Learn the move first</span>';
    if (knownMove && !knownAugment) {
      actionHtml = `<button class="pdp-test-btn" data-action="progression-unlock" data-kind="augment" data-move="${move.id}" data-augment="${augment.id}">Unlock (${augment.cost ?? 0})</button>`;
    } else if (knownAugment && augment.kind === 'slottable') {
      actionHtml = equippedAugment === augment.id
        ? `<button class="pdp-test-btn" data-action="progression-equip" data-move="${move.id}" data-augment="">Unequip</button>`
        : `<button class="pdp-test-btn" data-action="progression-equip" data-move="${move.id}" data-augment="${augment.id}">Equip</button>`;
    } else if (knownAugment) {
      actionHtml = '<span class="pdp-path-owned">Passive</span>';
    }
    return `
      <div class="pdp-path-augment">
        <div>
          <div class="pdp-path-augment-name">${augment.label}</div>
          <div class="pdp-path-augment-meta">${augment.kind === 'slottable' ? 'Slottable' : 'Passive'}</div>
        </div>
        <div class="pdp-path-actions">${actionHtml}</div>
      </div>
    `;
  }

  _getDenominationPaneKey(denominationId) {
    return `denomination-${String(denominationId || '').trim()}`;
  }

  _getChargePower(player) {
    return Math.max(0, Math.min(1, Number(player?.chargePower || 0)));
  }

  _getChargeMultiplier(chargePower, fullBonus) {
    return 1 + this._getChargePower({ chargePower }) * Number(fullBonus || 0);
  }

  _getChargedStat(base, chargePower, fullBonus) {
    return Math.max(1, Math.round(Number(base || 1) * this._getChargeMultiplier(chargePower, fullBonus)));
  }

  _tintToHex(value) {
    return `#${(Number(value ?? 0x4fd6ff) >>> 0).toString(16).padStart(6, '0').slice(-6)}`;
  }

  _alphaToPercent(value) {
    return Math.round(Phaser.Math.Clamp(Number(value ?? 0.42), 0, 1) * 100);
  }

  _injectStyles() {
    if (document.getElementById('player-detail-panel-styles')) return;
    const style = document.createElement('style');
    style.id = 'player-detail-panel-styles';
    style.textContent = `
      #player-detail-panel { position: fixed; inset: 0; z-index: 4000; font-family: Georgia, serif; }
      #player-detail-panel .pdp-backdrop { position: absolute; inset: 0; background: rgba(4,8,18,0.72); backdrop-filter: blur(3px); }
      #player-detail-panel .pdp-shell { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(1080px, calc(100vw - 40px)); height: min(760px, calc(100vh - 40px)); background: linear-gradient(180deg, #111a2c 0%, #0a1020 100%); border: 1px solid #33506d; box-shadow: 0 18px 60px rgba(0,0,0,0.45); color: #dce7f2; display: flex; flex-direction: column; }
      #player-detail-panel .pdp-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 18px; border-bottom: 1px solid #23354b; }
      #player-detail-panel .pdp-title { font-size: 28px; color: #f6cf61; font-weight: 700; }
      #player-detail-panel .pdp-subtitle { font-size: 14px; color: #8ca2b8; margin-top: 3px; }
      #player-detail-panel .pdp-close { border: 1px solid #46627f; background: #122034; color: #dce7f2; width: 34px; height: 34px; cursor: pointer; }
      #player-detail-panel .pdp-body { display: flex; gap: 16px; padding: 16px; min-height: 0; flex: 1; }
      #player-detail-panel .pdp-left { width: 320px; display: flex; flex-direction: column; gap: 12px; }
      #player-detail-panel .pdp-right { flex: 1; min-width: 0; display: flex; flex-direction: column; }
      #player-detail-panel .pdp-section { background: rgba(20,30,46,0.88); border: 1px solid #263b55; padding: 14px; }
      #player-detail-panel .pdp-section h3 { margin: 0 0 12px; font-size: 16px; color: #a8d3ff; }
      #player-detail-panel .pdp-stat { margin-bottom: 10px; }
      #player-detail-panel .pdp-stat-top { display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 4px; }
      #player-detail-panel .pdp-bar-wrap { height: 11px; background: #0b1220; border: 1px solid #1e3249; }
      #player-detail-panel .pdp-bar { height: 100%; }
      #player-detail-panel .pdp-stat-grid { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 10px; }
      #player-detail-panel .pdp-big-stat { background: #0d1625; border: 1px solid #21354d; padding: 10px; display: flex; flex-direction: column; gap: 6px; }
      #player-detail-panel .pdp-big-stat span { font-size: 11px; color: #8ca2b8; text-transform: uppercase; letter-spacing: 0.08em; }
      #player-detail-panel .pdp-big-stat strong { font-size: 18px; color: #f3f7fb; }
      #player-detail-panel .pdp-lines { display: grid; gap: 8px; font-size: 14px; color: #d1e0ee; }
      #player-detail-panel .pdp-tabs { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
      #player-detail-panel .pdp-tab { background: #111a28; border: 1px solid #29415c; color: #9fb9d3; padding: 8px 12px; cursor: pointer; }
      #player-detail-panel .pdp-tab.active { color: #e7f5ff; border-color: #60cfff; background: #153149; }
      #player-detail-panel .pdp-content { flex: 1; min-height: 0; background: rgba(20,30,46,0.88); border: 1px solid #263b55; padding: 14px; overflow: hidden; }
      #player-detail-panel .pdp-pane { display: none; height: 100%; overflow-y: auto; }
      #player-detail-panel .pdp-pane.active { display: block; }
      #player-detail-panel .pdp-card-grid { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 12px; }
      #player-detail-panel .pdp-card { background: #0d1625; border: 1px solid #22354c; padding: 12px; }
      #player-detail-panel .pdp-card-title { font-size: 12px; color: #8fb6da; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px; }
      #player-detail-panel .pdp-card-body { font-size: 14px; line-height: 1.45; color: #edf5fb; }
      #player-detail-panel .pdp-color-row { display: flex; align-items: center; gap: 10px; }
      #player-detail-panel .pdp-color-row input { width: 42px; height: 28px; border: 1px solid #355979; background: #12243a; padding: 0; cursor: pointer; }
      #player-detail-panel .pdp-color-row span { font-family: Consolas, monospace; color: #9fd8ff; }
      #player-detail-panel .pdp-range-row { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 10px; margin-top: 10px; }
      #player-detail-panel .pdp-range-row span { color: #9fb9d3; font-size: 13px; }
      #player-detail-panel .pdp-range-row input { width: 100%; }
      #player-detail-panel .pdp-range-row strong { color: #9fd8ff; font-family: Consolas, monospace; }
      #player-detail-panel .pdp-ki-summary, #player-detail-panel .pdp-upgrade-summary-card, #player-detail-panel .pdp-move-card { background: #0d1625; border: 1px solid #22354c; padding: 12px; margin-bottom: 12px; }
      #player-detail-panel .pdp-path-currency { margin-bottom: 12px; font-size: 14px; color: #9fd8ff; }
      #player-detail-panel .pdp-path-card { background: #0d1625; border: 1px solid #22354c; padding: 12px; margin-bottom: 12px; }
      #player-detail-panel .pdp-path-header, #player-detail-panel .pdp-path-move-header, #player-detail-panel .pdp-path-augment { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
      #player-detail-panel .pdp-path-title { font-size: 18px; color: #eef6fc; }
      #player-detail-panel .pdp-path-theme { margin-top: 4px; font-size: 13px; color: #7fa0ba; }
      #player-detail-panel .pdp-path-move { margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(75,107,139,0.18); }
      #player-detail-panel .pdp-path-move-name { font-size: 15px; color: #dce7f2; }
      #player-detail-panel .pdp-path-augment { margin-top: 8px; padding: 8px 10px; background: rgba(18,36,58,0.55); border: 1px solid #203549; }
      #player-detail-panel .pdp-path-augment-name { color: #e7f5ff; font-size: 14px; }
      #player-detail-panel .pdp-path-augment-meta { color: #7fa0ba; font-size: 12px; }
      #player-detail-panel .pdp-path-owned { color: #79f0ad; font-size: 13px; font-weight: 700; }
      #player-detail-panel .pdp-ki-row, #player-detail-panel .pdp-upgrade-row { display: flex; justify-content: space-between; gap: 12px; font-size: 14px; padding: 6px 0; border-bottom: 1px solid rgba(75,107,139,0.18); }
      #player-detail-panel .pdp-ki-row:last-child, #player-detail-panel .pdp-upgrade-row:last-child { border-bottom: 0; }
      #player-detail-panel .pdp-upgrade-title, #player-detail-panel .pdp-upgrade-summary-title { font-size: 13px; color: #89e1ff; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px; }
      #player-detail-panel .pdp-move-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 10px; }
      #player-detail-panel .pdp-move-name { font-size: 18px; color: #eef6fc; }
      #player-detail-panel .pdp-move-state { display: block; margin-top: 4px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: #8ca2b8; }
      #player-detail-panel .pdp-move-card.unlocked .pdp-move-state { color: #79f0ad; }
      #player-detail-panel .pdp-move-card.locked .pdp-move-state { color: #cc8f8f; }
      #player-detail-panel .pdp-move-actions, #player-detail-panel .pdp-upgrade-controls { display: flex; align-items: center; gap: 8px; }
      #player-detail-panel .pdp-test-btn, #player-detail-panel .pdp-stepper-btn { border: 1px solid #355979; background: #12243a; color: #dce7f2; cursor: pointer; }
      #player-detail-panel .pdp-test-btn { min-width: 72px; padding: 6px 10px; }
      #player-detail-panel .pdp-stepper-btn { width: 28px; height: 24px; padding: 0; font-size: 16px; line-height: 1; }
      #player-detail-panel .pdp-test-btn:hover, #player-detail-panel .pdp-stepper-btn:hover { background: #173554; border-color: #60cfff; }
      #player-detail-panel .pdp-empty { font-size: 13px; color: #73879b; }
      @media (max-width: 900px) {
        #player-detail-panel .pdp-shell { width: calc(100vw - 18px); height: calc(100vh - 18px); }
        #player-detail-panel .pdp-body { flex-direction: column; }
        #player-detail-panel .pdp-left { width: auto; }
        #player-detail-panel .pdp-card-grid { grid-template-columns: 1fr; }
      }
    `;
    document.head.appendChild(style);
  }
}
