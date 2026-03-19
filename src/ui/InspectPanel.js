// InspectPanel — shows stats, ki bonuses, and skills for remote players/NPCs.
// Opens on right-click → Inspect or via the Inspect context action.

const BONUS_LABELS = {
  blast_speed: 'Blast Speed',
  blast_range: 'Blast Range',
  blast_dmg: 'Blast Damage',
  blast_cooldown: 'Blast Cooldown',
  barrier_duration: 'Barrier Duration',
  barrier_cooldown: 'Barrier Cooldown',
};

const MOVE_LABELS = {
  ki_shot: 'Ki Shot',
  scatter_shot: 'Scatter Shot',
  explosive_shot: 'Explosive Shot',
  barrier: 'Barrier',
  sense_ki: 'Sense Ki',
};

export class InspectPanel {
  constructor(scene) {
    this._scene = scene;
    this._el = null;
    this._target = null;
    this._timer = null;
  }

  isOpen() { return !!this._el; }

  open(entity) {
    if (this._el) this.close();
    this._target = entity;
    this._build();
    this._refresh();
    this._timer = setInterval(() => this._refresh(), 500);
  }

  close() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._el) { this._el.remove(); this._el = null; }
    this._target = null;
  }

  _build() {
    const el = document.createElement('div');
    el.id = 'inspect-panel';
    el.innerHTML = `
      <div class="ip-backdrop"></div>
      <div class="ip-shell">
        <div class="ip-header">
          <div class="ip-title"></div>
          <button class="ip-close">X</button>
        </div>
        <div class="ip-body">
          <div class="ip-section ip-stats"></div>
          <div class="ip-section ip-resources"></div>
          <div class="ip-section ip-ki"></div>
          <div class="ip-section ip-bonuses"></div>
          <div class="ip-section ip-moves"></div>
        </div>
      </div>
    `;
    document.body.appendChild(el);
    this._el = el;
    this._injectStyles();
    el.querySelector('.ip-close')?.addEventListener('click', () => this.close());
    el.querySelector('.ip-backdrop')?.addEventListener('click', () => this.close());
    el.querySelector('.ip-shell')?.addEventListener('click', (e) => e.stopPropagation());
    el.querySelector('.ip-shell')?.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  _refresh() {
    if (!this._el || !this._target) return;
    const t = this._target;
    const isPlayer = !!t.playerId;
    const isNPC = !!t.ownerPid || !!t.npcId;

    // Name / title
    let name = '';
    if (isPlayer) {
      name = t.playerId + (t.isAIRival ? ' [AI]' : '');
    } else if (isNPC) {
      name = (t.getName?.() || t._name || t.npcId || 'NPC') + ` [${t.ownerPid}]`;
    }
    const level = t.level ?? t._level ?? '?';
    this._el.querySelector('.ip-title').textContent = `${name}  —  Level ${level}`;

    // Stats
    const hp = isPlayer ? (t._hp ?? 0) : (t.hp ?? 0);
    const maxHp = isPlayer ? (t._maxHp ?? 1) : (t.maxHp ?? 1);
    const ki = isPlayer ? (t._ki ?? 0) : (t.ki ?? 0);
    const maxKi = isPlayer ? (t._maxKi ?? 1) : (t.maxKi ?? 1);
    const str = t.str ?? '?';
    const def = t.def ?? '?';
    const xp = t.xp ?? 0;
    const xpNeeded = (t.level ?? 1) * 20;
    const hpPct = maxHp > 0 ? (hp / maxHp * 100) : 0;
    const kiPct = maxKi > 0 ? (ki / maxKi * 100) : 0;

    this._el.querySelector('.ip-stats').innerHTML = `
      <h3>Stats</h3>
      ${this._bar('HP', hp, maxHp, hpPct, hpPct > 50 ? '#59d66f' : hpPct > 25 ? '#d6aa44' : '#d65c5c')}
      ${this._bar('Ki', ki, maxKi, kiPct, kiPct > 50 ? '#4f98ff' : kiPct > 25 ? '#6c63ff' : '#9557ff')}
      <div class="ip-stat-grid">
        <div class="ip-big-stat"><span>STR</span><strong>${str}</strong></div>
        <div class="ip-big-stat"><span>DEF</span><strong>${def}</strong></div>
        <div class="ip-big-stat"><span>Level</span><strong>${level}</strong></div>
        <div class="ip-big-stat"><span>XP</span><strong>${xp}/${xpNeeded}</strong></div>
      </div>
    `;

    // Resources
    const logs = t.logs ?? 0;
    const stones = t.stones ?? 0;
    const crystals = t.crystals ?? 0;
    this._el.querySelector('.ip-resources').innerHTML = `
      <h3>Resources</h3>
      <div class="ip-res-grid">
        <span>Logs: ${logs}</span>
        <span>Stone: ${stones}</span>
        <span>Crystals: ${crystals}</span>
      </div>
    `;

    // Ki info
    const blastLevel = t.blastLevel ?? 0;
    const kiSkillLevel = t.kiSkillLevel ?? 1;
    const hasKiBlast = isNPC ? (t.has_ki_blast || t._hasKiBlast) : true;
    this._el.querySelector('.ip-ki').innerHTML = `
      <h3>Ki</h3>
      <div class="ip-ki-grid">
        <div class="ip-ki-row"><span>Ki Skill Level</span><span>${kiSkillLevel}</span></div>
        <div class="ip-ki-row"><span>Blast Level</span><span>${blastLevel}</span></div>
        ${isNPC ? `<div class="ip-ki-row"><span>Has Ki Blast</span><span style="color:${hasKiBlast ? '#5f5' : '#f55'}">${hasKiBlast ? 'Yes' : 'No'}</span></div>` : ''}
      </div>
    `;

    // Crystal bonuses
    const bonuses = t.kiBlastBonuses || {};
    const bonusEntries = Object.entries(BONUS_LABELS)
      .map(([key, label]) => {
        const val = Number(bonuses[key] ?? 0);
        return { label, val };
      })
      .filter(b => b.val !== 0);

    if (bonusEntries.length > 0) {
      this._el.querySelector('.ip-bonuses').innerHTML = `
        <h3>Crystal Bonuses</h3>
        <div class="ip-ki-grid">
          ${bonusEntries.map(b => `<div class="ip-ki-row"><span>${b.label}</span><span class="ip-bonus">+${b.val}%</span></div>`).join('')}
        </div>
      `;
    } else {
      this._el.querySelector('.ip-bonuses').innerHTML = `
        <h3>Crystal Bonuses</h3>
        <div class="ip-empty">No crystal bonuses yet.</div>
      `;
    }

    // Ki moves
    const moves = t.kiMoves || [];
    if (moves.length > 0) {
      this._el.querySelector('.ip-moves').innerHTML = `
        <h3>Learned Moves</h3>
        <div class="ip-move-list">
          ${moves.map(m => `<span class="ip-move-tag">${MOVE_LABELS[m] || m}</span>`).join('')}
        </div>
      `;
    } else {
      this._el.querySelector('.ip-moves').innerHTML = `
        <h3>Learned Moves</h3>
        <div class="ip-empty">No ki moves learned.</div>
      `;
    }
  }

  _bar(label, current, max, pct, color) {
    return `
      <div class="ip-stat">
        <div class="ip-stat-top"><span>${label}</span><span>${current}/${max}</span></div>
        <div class="ip-bar-wrap"><div class="ip-bar" style="width:${pct}%;background:${color}"></div></div>
      </div>
    `;
  }

  _injectStyles() {
    if (document.getElementById('inspect-panel-styles')) return;
    const style = document.createElement('style');
    style.id = 'inspect-panel-styles';
    style.textContent = `
      #inspect-panel { position: fixed; inset: 0; z-index: 4000; font-family: Georgia, serif; }
      #inspect-panel .ip-backdrop { position: absolute; inset: 0; background: rgba(4,8,18,0.65); backdrop-filter: blur(2px); }
      #inspect-panel .ip-shell {
        position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
        width: min(420px, calc(100vw - 40px)); max-height: min(600px, calc(100vh - 40px));
        background: linear-gradient(180deg, #111a2c 0%, #0a1020 100%);
        border: 1px solid #33506d; box-shadow: 0 18px 60px rgba(0,0,0,0.45);
        color: #dce7f2; display: flex; flex-direction: column; overflow: hidden;
      }
      #inspect-panel .ip-header {
        display: flex; justify-content: space-between; align-items: center;
        padding: 14px 16px; border-bottom: 1px solid #23354b;
      }
      #inspect-panel .ip-title { font-size: 18px; color: #f6cf61; font-weight: 700; }
      #inspect-panel .ip-close { border: 1px solid #46627f; background: #122034; color: #dce7f2; width: 30px; height: 30px; cursor: pointer; font-size: 14px; }
      #inspect-panel .ip-body { padding: 12px 16px; overflow-y: auto; flex: 1; }
      #inspect-panel .ip-section { margin-bottom: 14px; background: rgba(20,30,46,0.88); border: 1px solid #263b55; padding: 12px; }
      #inspect-panel .ip-section h3 { margin: 0 0 10px; font-size: 14px; color: #a8d3ff; text-transform: uppercase; letter-spacing: 0.06em; }
      #inspect-panel .ip-stat { margin-bottom: 8px; }
      #inspect-panel .ip-stat-top { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 3px; color: #c8d8e8; }
      #inspect-panel .ip-bar-wrap { height: 10px; background: #0b1220; border: 1px solid #1e3249; }
      #inspect-panel .ip-bar { height: 100%; }
      #inspect-panel .ip-stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
      #inspect-panel .ip-big-stat { background: #0d1625; border: 1px solid #21354d; padding: 8px; display: flex; flex-direction: column; gap: 4px; text-align: center; }
      #inspect-panel .ip-big-stat span { font-size: 10px; color: #8ca2b8; text-transform: uppercase; letter-spacing: 0.08em; }
      #inspect-panel .ip-big-stat strong { font-size: 16px; color: #f3f7fb; }
      #inspect-panel .ip-res-grid { display: flex; gap: 16px; font-size: 14px; color: #d1e0ee; }
      #inspect-panel .ip-ki-grid { display: flex; flex-direction: column; }
      #inspect-panel .ip-ki-row { display: flex; justify-content: space-between; font-size: 13px; padding: 5px 0; border-bottom: 1px solid rgba(75,107,139,0.18); color: #d1e0ee; }
      #inspect-panel .ip-ki-row:last-child { border-bottom: 0; }
      #inspect-panel .ip-bonus { color: #5fe85f; font-weight: bold; }
      #inspect-panel .ip-move-list { display: flex; flex-wrap: wrap; gap: 6px; }
      #inspect-panel .ip-move-tag { background: #1a2a44; border: 1px solid #3a6090; color: #8cf; padding: 4px 10px; font-size: 13px; border-radius: 3px; }
      #inspect-panel .ip-empty { font-size: 13px; color: #73879b; font-style: italic; }
    `;
    document.head.appendChild(style);
  }
}
