// NPCDetailPanel — full-screen detailed NPC info overlay.
// Uses DOM for rich layout since Phaser text is limited.

const TYPE_COLORS = {
  Guardian: '#4af', Scout: '#4fa', Berserker: '#f64',
  Caretaker: '#af4', Paranoid: '#c6f', Pragmatist: '#fa4',
};

const TYPE_DESCRIPTIONS = {
  Guardian:   'Loyal protector. Prefers defending allies over attacking.',
  Scout:      'Cautious observer. Avoids unnecessary conflict, gathers efficiently.',
  Berserker:  'Aggressive fighter. Charges in, low cooperation, high risk.',
  Caretaker:  'Gentle helper. Highly cooperative, avoids violence.',
  Paranoid:   'Nervous and suspicious. Startles easily, holds grudges.',
  Pragmatist: 'Balanced and practical. Adapts to the situation.',
};

const REL_COLORS = { devoted: '#4f4', allied: '#8f8', neutral: '#aaa', wary: '#fa0', hostile: '#f44' };

export class NPCDetailPanel {
  constructor(scene) {
    this._scene = scene;
    this._npc = null;
    this._el = null;
    this._updateTimer = null;
  }

  isOpen() { return !!this._el; }

  open(npc) {
    if (this._el) this.close();
    this._npc = npc;
    this._build();
    this._startUpdating();
  }

  close() {
    this._stopUpdating();
    if (this._el) {
      this._el.remove();
      this._el = null;
    }
    this._npc = null;
  }

  _build() {
    const el = document.createElement('div');
    el.id = 'npc-detail-panel';
    el.innerHTML = `
      <div class="ndp-backdrop"></div>
      <div class="ndp-container">
        <div class="ndp-header">
          <div class="ndp-header-left">
            <span class="ndp-name"></span>
            <span class="ndp-type-badge"></span>
          </div>
          <div class="ndp-header-btns">
            <button class="ndp-reset-btn" title="Wipe memories, phrases, and relationships">Reset Soul</button>
            <button class="ndp-delete-btn" title="Delete NPC">Delete</button>
            <button class="ndp-close-btn">X</button>
          </div>
        </div>
        <div class="ndp-body">
          <div class="ndp-col ndp-col-left">
            <div class="ndp-section ndp-stats">
              <h3>Stats</h3>
              <div class="ndp-stat-grid"></div>
            </div>
            <div class="ndp-section ndp-inventory">
              <h3>Inventory</h3>
              <div class="ndp-inv-bar-wrap">
                <div class="ndp-inv-bar"></div>
              </div>
              <div class="ndp-inv-label"></div>
              <button class="ndp-take-logs-btn">Take Logs</button>
            </div>
            <div class="ndp-section ndp-personality">
              <h3>Personality</h3>
              <div class="ndp-type-desc"></div>
              <div class="ndp-pers-bars"></div>
            </div>
            <div class="ndp-section ndp-emotions">
              <h3>Emotions <span class="ndp-emo-target">(You)</span></h3>
              <div class="ndp-emo-bars"></div>
              <div class="ndp-rel-label"></div>
            </div>
          </div>
          <div class="ndp-col ndp-col-right">
            <div class="ndp-tabs">
              <button class="ndp-tab active" data-tab="overview">Overview</button>
              <button class="ndp-tab" data-tab="memories">Memories</button>
              <button class="ndp-tab" data-tab="soul">Soul</button>
            </div>
            <div class="ndp-tab-content ndp-section" style="flex:1;overflow-y:auto;">
              <div class="ndp-tab-pane active" data-pane="overview">
                <div class="ndp-overview-content"></div>
              </div>
              <div class="ndp-tab-pane" data-pane="memories">
                <div class="ndp-mem-list"></div>
              </div>
              <div class="ndp-tab-pane" data-pane="soul">
                <div class="ndp-soul-content"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(el);
    this._el = el;

    this._injectStyles();

    // Events
    el.querySelector('.ndp-close-btn').addEventListener('click', () => this.close());
    el.querySelector('.ndp-backdrop').addEventListener('click', () => this.close());
    el.querySelector('.ndp-take-logs-btn').addEventListener('click', () => this._takeLogs());
    el.querySelector('.ndp-delete-btn').addEventListener('click', () => this._deleteNPC());
    el.querySelector('.ndp-reset-btn').addEventListener('click', () => this._resetSoul());

    // Delegate phrase button clicks (delete, +, -)
    el.querySelector('.ndp-soul-content').addEventListener('click', (e) => {
      if (!this._npc) return;
      const phrases = this._npc.soul.learned_phrases;
      if (!phrases) return;
      const playerId = this._scene?.player?.playerId || 'default';

      const delBtn = e.target.closest('.ndp-phrase-del');
      if (delBtn) {
        const idx = phrases.findIndex(p => p.phrase === delBtn.dataset.phrase);
        if (idx !== -1) { phrases.splice(idx, 1); this._refreshSoul(this._npc, playerId); }
        return;
      }

      const incBtn = e.target.closest('.ndp-phrase-inc');
      if (incBtn) {
        const p = phrases.find(p => p.phrase === incBtn.dataset.phrase);
        if (p) { p.uses = (p.uses || 1) + 1; this._refreshSoul(this._npc, playerId); }
        return;
      }

      const decBtn = e.target.closest('.ndp-phrase-dec');
      if (decBtn) {
        const p = phrases.find(p => p.phrase === decBtn.dataset.phrase);
        if (p && p.uses > 1) { p.uses -= 1; this._refreshSoul(this._npc, playerId); }
        return;
      }
    });

    // Tab switching
    for (const tab of el.querySelectorAll('.ndp-tab')) {
      tab.addEventListener('click', () => {
        el.querySelectorAll('.ndp-tab').forEach(t => t.classList.remove('active'));
        el.querySelectorAll('.ndp-tab-pane').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        el.querySelector(`.ndp-tab-pane[data-pane="${tab.dataset.tab}"]`).classList.add('active');
      });
    }

    this._refresh();
  }

  _takeLogs() {
    const npc = this._npc;
    if (!npc || npc.logs <= 0) return;
    const amount = npc.logs;
    npc.logs = 0;
    npc._givingLogs = true;
    const conn = this._scene._conn;
    if (conn?.connected) {
      conn.send({ type: 'admin', field: 'logs', value: amount });
    }
    npc.showBubble(`Here's ${amount} log${amount > 1 ? 's' : ''}!`, 3000);
    this._refresh();
  }

  _deleteNPC() {
    const npc = this._npc;
    if (!npc) return;
    const scene = this._scene;

    if (scene._conn?.connected) {
      scene._conn.send({ type: 'unregister_npc', npc_id: npc.id });
    }

    const idx = scene.npcs.indexOf(npc);
    if (idx >= 0) scene.npcs.splice(idx, 1);
    scene._taskRunners.delete(npc.id);
    scene._npcBrains.delete(npc.id);
    if (scene.selectedNPC === npc) {
      scene.selectedNPC = null;
      scene._hideNPCPanel();
    }
    npc.destroy();
    this.close();
  }

  _resetSoul() {
    const npc = this._npc;
    if (!npc) return;
    // Keep personality type and numeric traits, wipe everything else
    npc.soul.memories = {};
    npc.soul.learned_phrases = [];
    // Reset all relationships to defaults
    const defaultRel = { trust: 0.5, fear: 0, anger: 0, trust_baseline: 0.5, fear_baseline: 0, anger_baseline: 0, cooperation_mod: 0, aggression_mod: 0, label: 'neutral' };
    for (const key of Object.keys(npc.soul.relationships)) {
      npc.soul.relationships[key] = { ...defaultRel };
    }
    npc.showBubble('*memory wiped*', 2000);
    this._refresh();
  }

  _startUpdating() {
    this._updateTimer = setInterval(() => {
      if (this._npc && this._el) this._refresh();
    }, 500);
  }

  _stopUpdating() {
    if (this._updateTimer) {
      clearInterval(this._updateTimer);
      this._updateTimer = null;
    }
  }

  _refresh() {
    const npc = this._npc;
    if (!npc || !this._el) return;
    const scene = this._scene;
    const playerId = scene.playerId;

    // Header
    this._el.querySelector('.ndp-name').textContent = npc.getName();
    const pType = npc.soul.personality.type || 'Unknown';
    const typeBadge = this._el.querySelector('.ndp-type-badge');
    typeBadge.textContent = pType;
    typeBadge.style.color = TYPE_COLORS[pType] || '#888';
    typeBadge.style.borderColor = TYPE_COLORS[pType] || '#888';

    // Stats
    const hpPct = npc.maxHp > 0 ? (npc.hp / npc.maxHp * 100) : 0;
    const hpColor = hpPct > 50 ? '#4f4' : hpPct > 25 ? '#fa0' : '#f44';
    this._el.querySelector('.ndp-stat-grid').innerHTML = `
      <div class="ndp-stat">
        <span class="ndp-stat-label">HP</span>
        <div class="ndp-bar-wrap"><div class="ndp-bar" style="width:${hpPct}%;background:${hpColor}"></div></div>
        <span class="ndp-stat-val">${npc.hp}/${npc.maxHp}</span>
      </div>
      <div class="ndp-stat-row">
        <div class="ndp-stat-cell"><span class="ndp-stat-label">STR</span><span class="ndp-stat-big">${npc.str}</span></div>
        <div class="ndp-stat-cell"><span class="ndp-stat-label">DEF</span><span class="ndp-stat-big">${npc.def}</span></div>
        <div class="ndp-stat-cell"><span class="ndp-stat-label">Lv</span><span class="ndp-stat-big">${npc.level}</span></div>
        <div class="ndp-stat-cell"><span class="ndp-stat-label">XP</span><span class="ndp-stat-val">${npc.xp}</span></div>
      </div>
    `;

    // Inventory
    const fillPct = npc.maxLogs > 0 ? (npc.logs / npc.maxLogs * 100) : 0;
    const invColor = fillPct > 90 ? '#f44' : fillPct > 75 ? '#fa0' : '#4af';
    this._el.querySelector('.ndp-inv-bar').style.width = `${fillPct}%`;
    this._el.querySelector('.ndp-inv-bar').style.background = invColor;
    this._el.querySelector('.ndp-inv-label').textContent = `${npc.logs} / ${npc.maxLogs} logs`;
    const takeBtn = this._el.querySelector('.ndp-take-logs-btn');
    takeBtn.disabled = npc.logs <= 0;
    takeBtn.textContent = npc.logs > 0 ? `Take ${npc.logs} Log${npc.logs > 1 ? 's' : ''}` : 'No Logs';

    // Personality
    const pers = npc.soul.personality;
    const typeDesc = TYPE_DESCRIPTIONS[pType] || '';
    this._el.querySelector('.ndp-type-desc').textContent = typeDesc;
    this._el.querySelector('.ndp-pers-bars').innerHTML =
        this._makeBar('Cooperation', pers.cooperation, '#4af')
      + this._makeBar('Aggression', pers.aggression, '#f64')
      + this._makeBar('Neuroticism', pers.neuroticism, '#c6f');

    // Emotions
    const es = npc.getEmotionalState(playerId);
    const rel = npc._getRelationship(playerId);
    const tb = rel.trust_baseline ?? 0.5;
    const fb = rel.fear_baseline ?? 0;
    const ab = rel.anger_baseline ?? 0;
    this._el.querySelector('.ndp-emo-bars').innerHTML =
      this._makeEmoBar('Trust', es.trust, tb, '#4f4')
      + this._makeEmoBar('Fear', es.fear, fb, '#ff4')
      + this._makeEmoBar('Anger', es.anger, ab, '#f44');
    const relLabel = npc.getRelationshipLabel(playerId);
    const relColor = REL_COLORS[relLabel] || '#aaa';
    this._el.querySelector('.ndp-rel-label').innerHTML = `<span style="color:${relColor};font-weight:bold">${relLabel}</span>`;

    // ── Overview tab ──
    this._refreshOverview(npc, scene);

    // ── Memories tab ──
    this._refreshMemories(npc, playerId);

    // ── Soul tab ──
    this._refreshSoul(npc, playerId);
  }

  _refreshOverview(npc, scene) {
    const brain = scene._npcBrains.get(npc.id);
    const decision = brain?._lastDecision;
    const runner = scene._taskRunners.get(npc.id);
    const status = runner?.getStatus();
    const currentTask = status?.running ? status.tasks[0]?.task : 'idle';

    let html = '';

    // Current status
    html += `<div class="ndp-ov-section">`;
    html += `<div class="ndp-ov-row"><span class="ndp-ov-label">Status</span><span class="ndp-ov-val">${currentTask}</span></div>`;
    if (decision) {
      html += `<div class="ndp-ov-row"><span class="ndp-ov-label">Intent</span><span class="ndp-ov-val">${decision.primary_intent}</span></div>`;
      if (decision.reason_summary) {
        html += `<div class="ndp-ov-row"><span class="ndp-ov-label">Why</span><span class="ndp-ov-val ndp-ov-reason">${decision.reason_summary}</span></div>`;
      }
      if (decision.speech) {
        html += `<div class="ndp-ov-speech">"${decision.speech}"</div>`;
      }
      if (decision.decision_confidence != null) {
        const conf = Math.round(decision.decision_confidence * 100);
        html += `<div class="ndp-ov-row"><span class="ndp-ov-label">Confidence</span><span class="ndp-ov-val">${conf}%</span></div>`;
      }
    }
    html += `</div>`;

    // Recent events
    if (brain?._recentEvents?.length > 0) {
      const events = brain._recentEvents.slice(-5).reverse();
      html += `<div class="ndp-ov-section"><div class="ndp-ov-section-title">Recent Events</div>`;
      for (const e of events) {
        const age = Math.round((Date.now() - e.ts) / 1000);
        const ageStr = age < 60 ? `${age}s` : `${Math.round(age / 60)}m`;
        html += `<div class="ndp-event"><span class="ndp-event-age">${ageStr}</span> ${e.text || e.type}</div>`;
      }
      html += `</div>`;
    }

    this._el.querySelector('.ndp-overview-content').innerHTML = html;
  }

  _refreshMemories(npc, playerId) {
    const allMems = [];
    for (const [bucket, mems] of Object.entries(npc.soul.memories || {})) {
      if (!Array.isArray(mems)) continue;
      let scopeLabel;
      if (bucket === 'global') scopeLabel = 'global';
      else if (bucket === playerId) scopeLabel = 'you';
      else if (bucket.startsWith('npc:')) scopeLabel = bucket.replace('npc:', '');
      else scopeLabel = bucket;
      for (const m of mems) {
        allMems.push({ ...m, scope: scopeLabel });
      }
    }
    allMems.sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));

    if (allMems.length === 0) {
      this._el.querySelector('.ndp-mem-list').innerHTML = '<div class="ndp-empty">No memories yet.</div>';
    } else {
      let html = '';
      for (const m of allMems) {
        const imp = ((m.importance ?? 0.5) * 100).toFixed(0);
        const impColor = imp > 70 ? '#ff8' : imp > 40 ? '#aaa' : '#666';
        const age = Math.round((Date.now() - m.ts) / 1000);
        const ageStr = age < 60 ? `${age}s` : age < 3600 ? `${Math.round(age / 60)}m` : `${Math.round(age / 3600)}h`;
        const scopeColor = m.scope === 'you' ? '#4af' : m.scope === 'global' ? '#888' : '#fa0';
        html += `<div class="ndp-mem-item">
          <div class="ndp-mem-text">${m.text}</div>
          <div class="ndp-mem-meta">
            <span style="color:${impColor}">${imp}%</span>
            <span class="ndp-mem-age">${ageStr}</span>
            <span style="color:${scopeColor}">${m.scope}</span>
            <span style="color:#556">${m.type || ''}</span>
          </div>
        </div>`;
      }
      this._el.querySelector('.ndp-mem-list').innerHTML = html;
    }
  }

  _refreshSoul(npc, playerId) {
    let html = '';

    // Learned phrases
    const phrases = npc.soul.learned_phrases || [];
    html += `<div class="ndp-soul-section"><div class="ndp-soul-title">Learned Phrases</div>`;
    if (phrases.length === 0) {
      html += `<div class="ndp-empty">No phrases learned yet. Talk to your NPCs!</div>`;
    } else {
      const sorted = [...phrases].sort((a, b) => b.uses - a.uses);
      for (const p of sorted) {
        const bar = Math.min(100, p.uses * 15);
        const toneClass = p.tone === 'insult' ? 'ndp-tone-insult' : p.tone === 'friendly' ? 'ndp-tone-friendly' : '';
        const toneLabel = p.tone && p.tone !== 'neutral' ? `<span class="ndp-phrase-tone ${toneClass}">${p.tone}</span>` : '';
        const usageLabel = p.usage && p.usage !== 'catchphrase' ? `<span class="ndp-phrase-usage">${p.usage.replace('_', ' ')}</span>` : '';
        const safePhrase = p.phrase.replace(/"/g, '&quot;');
        html += `<div class="ndp-phrase">
          <button class="ndp-phrase-del" data-phrase="${safePhrase}" title="Remove phrase">x</button>
          <span class="ndp-phrase-text">"${p.phrase}"</span>${toneLabel}${usageLabel}
          <div class="ndp-phrase-bar-wrap"><div class="ndp-phrase-bar" style="width:${bar}%"></div></div>
          <button class="ndp-phrase-dec" data-phrase="${safePhrase}" title="Decrease uses">-</button>
          <span class="ndp-phrase-uses">x${p.uses}</span>
          <button class="ndp-phrase-inc" data-phrase="${safePhrase}" title="Increase uses">+</button>
        </div>`;
      }
    }
    html += `</div>`;

    // Relationships
    const allRels = Object.entries(npc.soul.relationships || {});
    html += `<div class="ndp-soul-section"><div class="ndp-soul-title">Relationships</div>`;
    if (allRels.length === 0) {
      html += `<div class="ndp-empty">No relationships yet.</div>`;
    } else {
      for (const [key, r] of allRels) {
        let displayName;
        if (key === playerId) displayName = `${key} (You)`;
        else if (key === 'default') displayName = 'Default';
        else if (key === 'strangers') displayName = 'Strangers';
        else if (key.startsWith('npc:')) displayName = key.replace('npc:', '') + ' (NPC)';
        else displayName = key;

        const label = r.label || 'neutral';
        const labelColor = REL_COLORS[label] || '#aaa';

        // Memories for this relationship
        const relMems = npc.soul.memories[key] || [];
        let memSnippets = '';
        if (relMems.length > 0) {
          const topMems = relMems.slice(-3).reverse();
          memSnippets = topMems.map(m => {
            const age = Math.round((Date.now() - m.ts) / 1000);
            const ageStr = age < 60 ? `${age}s` : age < 3600 ? `${Math.round(age / 60)}m` : `${Math.round(age / 3600)}h`;
            return `<div class="ndp-rel-mem">${m.text} <span class="ndp-rel-mem-age">(${ageStr})</span></div>`;
          }).join('');
        }

        html += `<div class="ndp-rel-entry">
          <div class="ndp-rel-entry-header">
            <span class="ndp-rel-entry-name">${displayName}</span>
            <span style="color:${labelColor};font-size:10px;font-weight:bold">${label}</span>
          </div>
          <div class="ndp-rel-entry-bars">
            ${this._makeSmallBar('T', r.trust ?? 0.5, r.trust_baseline ?? 0.5, '#4f4')}
            ${this._makeSmallBar('F', r.fear ?? 0, r.fear_baseline ?? 0, '#ff4')}
            ${this._makeSmallBar('A', r.anger ?? 0, r.anger_baseline ?? 0, '#f44')}
          </div>
          ${memSnippets ? `<div class="ndp-rel-entry-mems">${memSnippets}</div>` : ''}
        </div>`;
      }
    }
    html += `</div>`;

    this._el.querySelector('.ndp-soul-content').innerHTML = html;
  }

  _makeBar(label, value, color) {
    const pct = (value * 100).toFixed(0);
    return `<div class="ndp-trait">
      <span class="ndp-trait-label">${label}</span>
      <div class="ndp-bar-wrap"><div class="ndp-bar" style="width:${pct}%;background:${color}"></div></div>
      <span class="ndp-trait-val">${value.toFixed(2)}</span>
    </div>`;
  }

  _makeSmallBar(label, value, baseline, color) {
    const pct = (value * 100).toFixed(0);
    const basePct = (baseline * 100).toFixed(0);
    return `<div class="ndp-rel-bar-row">
      <span class="ndp-rel-bar-label">${label}</span>
      <div class="ndp-bar-wrap" style="height:5px">
        <div class="ndp-bar" style="width:${pct}%;background:${color}"></div>
        <div class="ndp-baseline-marker" style="left:${basePct}%"></div>
      </div>
      <span class="ndp-rel-bar-val">${value.toFixed(2)}</span>
    </div>`;
  }

  _makeEmoBar(label, value, baseline, color) {
    const pct = (value * 100).toFixed(0);
    const basePct = (baseline * 100).toFixed(0);
    return `<div class="ndp-trait">
      <span class="ndp-trait-label">${label}</span>
      <div class="ndp-bar-wrap">
        <div class="ndp-bar" style="width:${pct}%;background:${color}"></div>
        <div class="ndp-baseline-marker" style="left:${basePct}%"></div>
      </div>
      <span class="ndp-trait-val">${value.toFixed(2)} <span style="color:#556;font-size:9px">(${baseline.toFixed(2)})</span></span>
    </div>`;
  }

  _injectStyles() {
    if (document.getElementById('ndp-styles')) return;
    const style = document.createElement('style');
    style.id = 'ndp-styles';
    style.textContent = `
      #npc-detail-panel { position:fixed; inset:0; z-index:9999; font-family:'Segoe UI',system-ui,sans-serif; }
      .ndp-backdrop { position:absolute; inset:0; background:rgba(0,0,0,0.65); }
      .ndp-container {
        position:absolute; top:50%; left:50%; transform:translate(-50%,-50%);
        width:640px; max-width:95vw; max-height:85vh;
        background:#0d0d1a; border:1px solid #334; border-radius:8px;
        display:flex; flex-direction:column; overflow:hidden;
        box-shadow: 0 8px 32px rgba(0,0,0,0.6);
      }
      .ndp-header {
        display:flex; justify-content:space-between; align-items:center;
        padding:10px 14px; background:#111128; border-bottom:1px solid #223;
      }
      .ndp-header-left { display:flex; align-items:center; gap:10px; }
      .ndp-name { font-size:16px; font-weight:bold; color:#adf; }
      .ndp-type-badge {
        font-size:10px; padding:2px 8px; border-radius:10px;
        border:1px solid; font-weight:bold; text-transform:uppercase;
        letter-spacing:0.5px;
      }
      .ndp-header-btns { display:flex; gap:6px; }
      .ndp-close-btn, .ndp-delete-btn, .ndp-reset-btn {
        border:none; border-radius:4px; cursor:pointer;
        padding:3px 8px; font-size:12px;
      }
      .ndp-close-btn { background:#223; color:#aaa; }
      .ndp-close-btn:hover { background:#334; color:#fff; }
      .ndp-delete-btn { background:#411; color:#f66; font-size:11px; }
      .ndp-delete-btn:hover { background:#622; color:#faa; }
      .ndp-reset-btn { background:#331a00; color:#fa4; font-size:11px; }
      .ndp-reset-btn:hover { background:#552a00; color:#fc6; }
      .ndp-body {
        display:flex; gap:10px; padding:10px; overflow-y:auto; flex:1;
      }
      .ndp-col-left { width:220px; min-width:220px; display:flex; flex-direction:column; gap:8px; }
      .ndp-col-right { flex:1; display:flex; flex-direction:column; gap:0; min-width:0; }
      .ndp-section {
        background:#111125; border:1px solid #1a1a33; border-radius:5px; padding:8px;
      }
      .ndp-section h3 {
        margin:0 0 6px 0; font-size:10px; text-transform:uppercase;
        color:#668; letter-spacing:1px; border-bottom:1px solid #1a1a33;
        padding-bottom:3px;
      }

      /* Stats */
      .ndp-stat { display:flex; align-items:center; gap:5px; margin-bottom:4px; }
      .ndp-stat-label { color:#889; font-size:10px; min-width:24px; }
      .ndp-stat-val { color:#cdc; font-size:11px; font-weight:bold; }
      .ndp-stat-row { display:flex; gap:4px; justify-content:space-between; margin-top:4px; }
      .ndp-stat-cell { display:flex; flex-direction:column; align-items:center; gap:1px; }
      .ndp-stat-big { font-size:15px; color:#efe; font-weight:bold; }

      /* Bars */
      .ndp-bar-wrap {
        flex:1; height:7px; background:#1a1a2e; border-radius:3px;
        overflow:hidden; position:relative;
      }
      .ndp-bar { height:100%; border-radius:3px; transition:width 0.3s; }
      .ndp-baseline-marker {
        position:absolute; top:-1px; bottom:-1px; width:2px;
        background:#fff8; border-radius:1px;
      }

      /* Traits / Emotions */
      .ndp-trait { display:flex; align-items:center; gap:5px; margin-bottom:3px; }
      .ndp-trait-label { color:#889; font-size:10px; min-width:70px; }
      .ndp-trait-val { color:#ccc; font-size:10px; min-width:55px; text-align:right; }

      /* Type description */
      .ndp-type-desc { font-size:10px; color:#889; margin-bottom:6px; font-style:italic; }

      /* Inventory */
      .ndp-inventory .ndp-bar-wrap { height:10px; margin-bottom:3px; }
      .ndp-inv-label { color:#8aa; font-size:10px; text-align:center; margin-bottom:4px; }
      .ndp-take-logs-btn {
        width:100%; padding:4px; border:1px solid #2a4; border-radius:3px;
        background:#1a2a1a; color:#4f4; font-size:11px; cursor:pointer;
      }
      .ndp-take-logs-btn:hover:not(:disabled) { background:#2a3a2a; }
      .ndp-take-logs-btn:disabled { opacity:0.4; cursor:default; color:#666; border-color:#333; }

      /* Relationship label */
      .ndp-rel-label { margin-top:4px; font-size:11px; color:#aaa; text-align:center; }
      .ndp-emo-target { color:#556; font-size:9px; text-transform:none; letter-spacing:0; }

      /* Tabs */
      .ndp-tabs { display:flex; gap:2px; margin-bottom:0; }
      .ndp-tab {
        flex:1; padding:5px 0; border:none; border-radius:4px 4px 0 0;
        background:#111125; color:#668; font-size:10px; cursor:pointer;
        text-transform:uppercase; letter-spacing:0.5px; font-weight:bold;
      }
      .ndp-tab:hover { color:#aab; background:#16162a; }
      .ndp-tab.active { color:#adf; background:#1a1a33; }
      .ndp-tab-content { border-radius:0 0 5px 5px; min-height:200px; }
      .ndp-tab-pane { display:none; }
      .ndp-tab-pane.active { display:block; }

      /* Overview */
      .ndp-ov-section { margin-bottom:8px; }
      .ndp-ov-section-title { font-size:10px; color:#668; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px; border-bottom:1px solid #1a1a33; padding-bottom:2px; }
      .ndp-ov-row { display:flex; gap:6px; margin-bottom:3px; font-size:11px; }
      .ndp-ov-label { color:#668; font-weight:bold; min-width:70px; }
      .ndp-ov-val { color:#bbb; }
      .ndp-ov-reason { color:#999; font-style:italic; }
      .ndp-ov-speech { color:#ff8; font-style:italic; margin:4px 0; font-size:11px; padding-left:8px; border-left:2px solid #442; }
      .ndp-event { font-size:10px; color:#888; margin-bottom:2px; }
      .ndp-event-age { color:#556; font-size:9px; margin-right:4px; display:inline-block; min-width:24px; }

      /* Memories */
      .ndp-mem-list { max-height:350px; overflow-y:auto; }
      .ndp-mem-item { padding:3px 0; border-bottom:1px solid #111; }
      .ndp-mem-text { font-size:10px; color:#bbb; }
      .ndp-mem-meta { display:flex; gap:6px; margin-top:1px; font-size:9px; }
      .ndp-mem-age { color:#556; }
      .ndp-empty { color:#556; font-size:10px; font-style:italic; padding:4px 0; }

      /* Soul tab */
      .ndp-soul-section { margin-bottom:10px; }
      .ndp-soul-title { font-size:10px; color:#668; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px; border-bottom:1px solid #1a1a33; padding-bottom:2px; }

      /* Learned phrases */
      .ndp-phrase { display:flex; align-items:center; gap:5px; margin-bottom:3px; }
      .ndp-phrase-text { font-size:10px; color:#fa8; min-width:100px; max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .ndp-phrase-bar-wrap { flex:1; height:4px; background:#1a1a2e; border-radius:2px; overflow:hidden; }
      .ndp-phrase-bar { height:100%; background:#fa8; border-radius:2px; }
      .ndp-phrase-uses { font-size:9px; color:#886; min-width:20px; text-align:right; }
      .ndp-phrase-del { background:none; border:1px solid #533; color:#a66; font-size:9px; width:14px; height:14px; padding:0; cursor:pointer; border-radius:3px; line-height:12px; flex-shrink:0; }
      .ndp-phrase-del:hover { background:#522; color:#f88; border-color:#a44; }
      .ndp-phrase-inc, .ndp-phrase-dec { background:none; border:1px solid #335; color:#8af; font-size:10px; width:16px; height:14px; padding:0; cursor:pointer; border-radius:3px; line-height:12px; flex-shrink:0; font-weight:bold; }
      .ndp-phrase-inc:hover, .ndp-phrase-dec:hover { background:#224; color:#adf; border-color:#55a; }
      .ndp-phrase-tone, .ndp-phrase-usage { font-size:8px; padding:1px 4px; border-radius:3px; white-space:nowrap; }
      .ndp-tone-insult { background:#622; color:#f88; }
      .ndp-tone-friendly { background:#264; color:#8f8; }
      .ndp-phrase-usage { background:#234; color:#8bf; }

      /* Relationship entries */
      .ndp-rel-entry { padding:5px 0; border-bottom:1px solid #1a1a33; }
      .ndp-rel-entry:last-child { border-bottom:none; }
      .ndp-rel-entry-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:3px; }
      .ndp-rel-entry-name { color:#ccc; font-size:11px; font-weight:bold; }
      .ndp-rel-entry-bars { display:flex; gap:6px; }
      .ndp-rel-bar-row { display:flex; align-items:center; gap:3px; flex:1; }
      .ndp-rel-bar-label { color:#668; font-size:8px; font-weight:bold; width:8px; }
      .ndp-rel-bar-val { color:#888; font-size:9px; width:26px; text-align:right; }
      .ndp-rel-entry-mems { margin-top:3px; padding-left:6px; border-left:2px solid #1a1a33; }
      .ndp-rel-mem { font-size:9px; color:#999; margin-bottom:1px; }
      .ndp-rel-mem-age { color:#556; font-size:8px; }

      /* Scrollbar */
      .ndp-mem-list::-webkit-scrollbar, .ndp-soul-content::-webkit-scrollbar { width:4px; }
      .ndp-mem-list::-webkit-scrollbar-track, .ndp-soul-content::-webkit-scrollbar-track { background:#0d0d1a; }
      .ndp-mem-list::-webkit-scrollbar-thumb, .ndp-soul-content::-webkit-scrollbar-thumb { background:#334; border-radius:2px; }
      .ndp-body::-webkit-scrollbar { width:4px; }
      .ndp-body::-webkit-scrollbar-track { background:#0d0d1a; }
      .ndp-body::-webkit-scrollbar-thumb { background:#334; border-radius:2px; }
      .ndp-soul-content { max-height:350px; overflow-y:auto; }
    `;
    document.head.appendChild(style);
  }
}
