// NPCDetailPanel — full-screen detailed NPC info overlay.
// Uses DOM for rich layout since Phaser text is limited.

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
          <span class="ndp-name"></span>
          <div class="ndp-header-btns">
            <button class="ndp-delete-btn" title="Delete NPC">Delete</button>
            <button class="ndp-close-btn">✕</button>
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
              <div class="ndp-pers-bars"></div>
            </div>
          </div>
          <div class="ndp-col ndp-col-right">
            <div class="ndp-section ndp-emotions">
              <h3>Emotions (You)</h3>
              <div class="ndp-emo-bars"></div>
              <div class="ndp-rel-label"></div>
            </div>
            <div class="ndp-tabs">
              <button class="ndp-tab active" data-tab="thoughts">Thoughts</button>
              <button class="ndp-tab" data-tab="memories">Memories</button>
              <button class="ndp-tab" data-tab="relationships">Relationships</button>
            </div>
            <div class="ndp-tab-content ndp-section" style="flex:1;overflow-y:auto;">
              <div class="ndp-tab-pane active" data-pane="thoughts">
                <div class="ndp-thought-content"></div>
              </div>
              <div class="ndp-tab-pane" data-pane="memories">
                <div class="ndp-mem-list"></div>
              </div>
              <div class="ndp-tab-pane" data-pane="relationships">
                <div class="ndp-rel-list"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(el);
    this._el = el;

    // Style
    this._injectStyles();

    // Events
    el.querySelector('.ndp-close-btn').addEventListener('click', () => this.close());
    el.querySelector('.ndp-backdrop').addEventListener('click', () => this.close());
    el.querySelector('.ndp-take-logs-btn').addEventListener('click', () => this._takeLogs());
    el.querySelector('.ndp-delete-btn').addEventListener('click', () => this._deleteNPC());

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

    // Tell server to remove this NPC ID from saved npc_ids
    if (scene._conn?.connected) {
      scene._conn.send({ type: 'unregister_npc', npc_id: npc.id });
    }

    // Remove from arrays
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

    // Name
    this._el.querySelector('.ndp-name').textContent = npc.getName();

    // Stats grid
    const hpPct = npc.maxHp > 0 ? (npc.hp / npc.maxHp * 100) : 0;
    const hpColor = hpPct > 50 ? '#4f4' : hpPct > 25 ? '#fa0' : '#f44';
    this._el.querySelector('.ndp-stat-grid').innerHTML = `
      <div class="ndp-stat">
        <span class="ndp-stat-label">HP</span>
        <div class="ndp-bar-wrap"><div class="ndp-bar" style="width:${hpPct}%;background:${hpColor}"></div></div>
        <span class="ndp-stat-val">${npc.hp}/${npc.maxHp}</span>
      </div>
      <div class="ndp-stat">
        <span class="ndp-stat-label">STR</span>
        <span class="ndp-stat-val ndp-stat-big">${npc.str}</span>
      </div>
      <div class="ndp-stat">
        <span class="ndp-stat-label">DEF</span>
        <span class="ndp-stat-val ndp-stat-big">${npc.def}</span>
      </div>
      <div class="ndp-stat">
        <span class="ndp-stat-label">Level</span>
        <span class="ndp-stat-val ndp-stat-big">${npc.level}</span>
      </div>
      <div class="ndp-stat">
        <span class="ndp-stat-label">XP</span>
        <span class="ndp-stat-val">${npc.xp}</span>
      </div>
      <div class="ndp-stat">
        <span class="ndp-stat-label">Speed</span>
        <span class="ndp-stat-val">${Math.round(npc.getSpeed())}</span>
      </div>
    `;

    // Inventory
    const fillPct = npc.maxLogs > 0 ? (npc.logs / npc.maxLogs * 100) : 0;
    const invColor = fillPct > 90 ? '#f44' : fillPct > 75 ? '#fa0' : '#4af';
    this._el.querySelector('.ndp-inv-bar').style.width = `${fillPct}%`;
    this._el.querySelector('.ndp-inv-bar').style.background = invColor;
    this._el.querySelector('.ndp-inv-label').textContent = `${npc.logs} / ${npc.maxLogs} logs (${Math.round(fillPct)}%)`;
    const takeBtn = this._el.querySelector('.ndp-take-logs-btn');
    takeBtn.disabled = npc.logs <= 0;
    takeBtn.textContent = npc.logs > 0 ? `Take ${npc.logs} Log${npc.logs > 1 ? 's' : ''}` : 'No Logs';

    // Personality bars
    const pers = npc.soul.personality;
    this._el.querySelector('.ndp-pers-bars').innerHTML = this._makeBar('Cooperation', pers.cooperation, '#4af')
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
    const relColor = { devoted: '#4f4', allied: '#8f8', neutral: '#aaa', wary: '#fa0', hostile: '#f44' }[relLabel] || '#aaa';
    this._el.querySelector('.ndp-rel-label').innerHTML = `Relationship: <span style="color:${relColor};font-weight:bold">${relLabel}</span>`;

    // Thoughts
    const brain = scene._npcBrains.get(npc.id);
    const decision = brain?._lastDecision;
    const runner = scene._taskRunners.get(npc.id);
    const status = runner?.getStatus();
    const currentTask = status?.running ? status.tasks[0]?.task : 'idle';

    let thoughtHtml = `<div class="ndp-thought-item"><span class="ndp-thought-label">Status:</span> ${currentTask}</div>`;
    if (decision) {
      thoughtHtml += `<div class="ndp-thought-item"><span class="ndp-thought-label">Intent:</span> ${decision.primary_intent}</div>`;
      if (decision.reason_summary) {
        thoughtHtml += `<div class="ndp-thought-item"><span class="ndp-thought-label">Reasoning:</span> ${decision.reason_summary}</div>`;
      }
      if (decision.speech) {
        thoughtHtml += `<div class="ndp-thought-item ndp-speech">"${decision.speech}"</div>`;
      }
    }
    // Recent events
    if (brain?._recentEvents?.length > 0) {
      const events = brain._recentEvents.slice(-5).reverse();
      thoughtHtml += '<div class="ndp-thought-events">';
      for (const e of events) {
        const age = Math.round((Date.now() - e.ts) / 1000);
        thoughtHtml += `<div class="ndp-event"><span class="ndp-event-age">${age}s ago</span> ${e.text}</div>`;
      }
      thoughtHtml += '</div>';
    }
    this._el.querySelector('.ndp-thought-content').innerHTML = thoughtHtml;

    // Memories — collect from all scopes (player, global, npc:*, etc.)
    const allMems = [];
    for (const [bucket, mems] of Object.entries(npc.soul.memories || {})) {
      if (!Array.isArray(mems)) continue;
      let scopeLabel;
      if (bucket === 'global') scopeLabel = 'global';
      else if (bucket === playerId) scopeLabel = 'player';
      else if (bucket.startsWith('npc:')) scopeLabel = bucket.replace('npc:', '');
      else scopeLabel = bucket;
      for (const m of mems) {
        allMems.push({ ...m, scope: scopeLabel });
      }
    }
    allMems.sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));

    if (allMems.length === 0) {
      this._el.querySelector('.ndp-mem-list').innerHTML = '<div class="ndp-mem-empty">No memories yet.</div>';
    } else {
      let memHtml = '';
      for (const m of allMems) {
        const imp = ((m.importance ?? 0.5) * 100).toFixed(0);
        const impColor = imp > 70 ? '#ff8' : imp > 40 ? '#aaa' : '#666';
        const age = Math.round((Date.now() - m.ts) / 1000);
        const ageStr = age < 60 ? `${age}s` : age < 3600 ? `${Math.round(age / 60)}m` : `${Math.round(age / 3600)}h`;
        const scopeColor = m.scope === 'player' ? '#4af' : m.scope === 'global' ? '#888' : '#fa0';
        memHtml += `<div class="ndp-mem-item">
          <div class="ndp-mem-text">${m.text}</div>
          <div class="ndp-mem-meta">
            <span class="ndp-mem-imp" style="color:${impColor}">${imp}%</span>
            <span class="ndp-mem-age">${ageStr} ago</span>
            <span class="ndp-mem-scope" style="color:${scopeColor}">${m.scope}</span>
            <span class="ndp-mem-type" style="color:#556">${m.type || ''}</span>
          </div>
        </div>`;
      }
      this._el.querySelector('.ndp-mem-list').innerHTML = memHtml;
    }

    // Relationships tab — show all relationships with emotion bars and memories
    const allRels = Object.entries(npc.soul.relationships || {});
    if (allRels.length === 0) {
      this._el.querySelector('.ndp-rel-list').innerHTML = '<div class="ndp-mem-empty">No relationships yet.</div>';
    } else {
      let relListHtml = '';
      for (const [key, r] of allRels) {
        let displayName;
        if (key === playerId) displayName = `${key} (You)`;
        else if (key === 'default') displayName = 'Default';
        else if (key === 'strangers') displayName = 'Strangers';
        else if (key.startsWith('npc:')) displayName = key.replace('npc:', '') + ' (NPC)';
        else displayName = key;

        const label = r.label || 'neutral';
        const labelColor = { devoted: '#4f4', allied: '#8f8', neutral: '#aaa', wary: '#fa0', hostile: '#f44' }[label] || '#aaa';

        // Get memories for this relationship
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

        relListHtml += `<div class="ndp-rel-entry">
          <div class="ndp-rel-entry-header">
            <span class="ndp-rel-entry-name">${displayName}</span>
            <span class="ndp-rel-entry-label" style="color:${labelColor}">${label}</span>
          </div>
          <div class="ndp-rel-entry-bars">
            ${this._makeSmallBar('Trust', r.trust ?? 0.5, r.trust_baseline ?? 0.5, '#4f4')}
            ${this._makeSmallBar('Fear', r.fear ?? 0, r.fear_baseline ?? 0, '#ff4')}
            ${this._makeSmallBar('Anger', r.anger ?? 0, r.anger_baseline ?? 0, '#f44')}
          </div>
          ${memSnippets ? `<div class="ndp-rel-entry-mems">${memSnippets}</div>` : ''}
        </div>`;
      }
      this._el.querySelector('.ndp-rel-list').innerHTML = relListHtml;
    }
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
      <span class="ndp-rel-bar-label">${label[0]}</span>
      <div class="ndp-bar-wrap" style="height:6px">
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
      <span class="ndp-trait-val">${value.toFixed(2)} <span style="color:#888;font-size:10px">(${baseline.toFixed(2)})</span></span>
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
        width:680px; max-width:95vw; max-height:85vh;
        background:#0d0d1a; border:1px solid #334; border-radius:8px;
        display:flex; flex-direction:column; overflow:hidden;
        box-shadow: 0 8px 32px rgba(0,0,0,0.6);
      }
      .ndp-header {
        display:flex; justify-content:space-between; align-items:center;
        padding:12px 16px; background:#111128; border-bottom:1px solid #223;
      }
      .ndp-name { font-size:18px; font-weight:bold; color:#adf; }
      .ndp-header-btns { display:flex; gap:8px; }
      .ndp-close-btn, .ndp-delete-btn {
        border:none; border-radius:4px; cursor:pointer;
        padding:4px 10px; font-size:13px;
      }
      .ndp-close-btn { background:#223; color:#aaa; }
      .ndp-close-btn:hover { background:#334; color:#fff; }
      .ndp-delete-btn { background:#411; color:#f66; }
      .ndp-delete-btn:hover { background:#622; color:#faa; }
      .ndp-body {
        display:flex; gap:12px; padding:12px; overflow-y:auto; flex:1;
      }
      .ndp-col { flex:1; display:flex; flex-direction:column; gap:10px; }
      .ndp-section {
        background:#111125; border:1px solid #1a1a33; border-radius:6px; padding:10px;
      }
      .ndp-section h3 {
        margin:0 0 8px 0; font-size:12px; text-transform:uppercase;
        color:#668; letter-spacing:1px; border-bottom:1px solid #1a1a33;
        padding-bottom:4px;
      }

      /* Stats */
      .ndp-stat-grid { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
      .ndp-stat { display:flex; align-items:center; gap:6px; }
      .ndp-stat-label { color:#889; font-size:11px; min-width:36px; }
      .ndp-stat-val { color:#cdc; font-size:12px; font-weight:bold; }
      .ndp-stat-big { font-size:16px; color:#efe; }

      /* Bars */
      .ndp-bar-wrap {
        flex:1; height:8px; background:#1a1a2e; border-radius:4px;
        overflow:hidden; position:relative;
      }
      .ndp-bar { height:100%; border-radius:4px; transition:width 0.3s; }
      .ndp-baseline-marker {
        position:absolute; top:-1px; bottom:-1px; width:2px;
        background:#fff8; border-radius:1px;
      }

      /* Traits / Emotions */
      .ndp-trait { display:flex; align-items:center; gap:6px; margin-bottom:4px; }
      .ndp-trait-label { color:#889; font-size:11px; min-width:80px; }
      .ndp-trait-val { color:#ccc; font-size:11px; min-width:60px; text-align:right; }

      /* Inventory */
      .ndp-inventory .ndp-bar-wrap { height:12px; margin-bottom:4px; }
      .ndp-inv-label { color:#8aa; font-size:11px; text-align:center; margin-bottom:6px; }
      .ndp-take-logs-btn {
        width:100%; padding:6px; border:1px solid #2a4; border-radius:4px;
        background:#1a2a1a; color:#4f4; font-size:12px; cursor:pointer;
      }
      .ndp-take-logs-btn:hover:not(:disabled) { background:#2a3a2a; }
      .ndp-take-logs-btn:disabled { opacity:0.4; cursor:default; color:#666; border-color:#333; }

      /* Relationship label */
      .ndp-rel-label { margin-top:6px; font-size:12px; color:#aaa; }

      /* Thoughts */
      .ndp-thought-item { margin-bottom:4px; font-size:11px; color:#bbb; }
      .ndp-thought-label { color:#668; font-weight:bold; }
      .ndp-speech { color:#ff8; font-style:italic; margin-top:4px; }
      .ndp-thought-events { margin-top:6px; border-top:1px solid #1a1a33; padding-top:4px; }
      .ndp-event { font-size:10px; color:#888; margin-bottom:2px; }
      .ndp-event-age { color:#556; font-size:9px; margin-right:4px; }

      /* Tabs */
      .ndp-tabs { display:flex; gap:2px; margin-bottom:0; }
      .ndp-tab {
        flex:1; padding:6px 0; border:none; border-radius:4px 4px 0 0;
        background:#111125; color:#668; font-size:11px; cursor:pointer;
        text-transform:uppercase; letter-spacing:0.5px; font-weight:bold;
      }
      .ndp-tab:hover { color:#aab; background:#16162a; }
      .ndp-tab.active { color:#adf; background:#1a1a33; }
      .ndp-tab-content { border-radius:0 0 6px 6px; min-height:150px; }
      .ndp-tab-pane { display:none; }
      .ndp-tab-pane.active { display:block; }

      /* Relationship entries */
      .ndp-rel-entry { padding:6px 0; border-bottom:1px solid #1a1a33; }
      .ndp-rel-entry:last-child { border-bottom:none; }
      .ndp-rel-entry-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; }
      .ndp-rel-entry-name { color:#ccc; font-size:12px; font-weight:bold; }
      .ndp-rel-entry-label { font-size:11px; font-weight:bold; }
      .ndp-rel-entry-bars { display:flex; gap:8px; }
      .ndp-rel-bar-row { display:flex; align-items:center; gap:4px; flex:1; }
      .ndp-rel-bar-label { color:#668; font-size:9px; font-weight:bold; width:10px; }
      .ndp-rel-bar-val { color:#888; font-size:9px; width:28px; text-align:right; }
      .ndp-rel-entry-mems { margin-top:4px; padding-left:8px; border-left:2px solid #1a1a33; }
      .ndp-rel-mem { font-size:10px; color:#999; margin-bottom:1px; }
      .ndp-rel-mem-age { color:#556; font-size:9px; }
      .ndp-rel-list { max-height:300px; overflow-y:auto; }

      /* Memories */
      .ndp-mem-list { max-height:200px; overflow-y:auto; }
      .ndp-mem-item {
        padding:4px 0; border-bottom:1px solid #111;
      }
      .ndp-mem-text { font-size:11px; color:#bbb; }
      .ndp-mem-meta { display:flex; gap:8px; margin-top:2px; }
      .ndp-mem-imp { font-size:10px; font-weight:bold; }
      .ndp-mem-age { font-size:10px; color:#556; }
      .ndp-mem-scope { font-size:10px; color:#446; font-style:italic; }
      .ndp-mem-empty { color:#556; font-size:11px; font-style:italic; }

      /* Scrollbar */
      .ndp-mem-list::-webkit-scrollbar { width:4px; }
      .ndp-mem-list::-webkit-scrollbar-track { background:#0d0d1a; }
      .ndp-mem-list::-webkit-scrollbar-thumb { background:#334; border-radius:2px; }
      .ndp-body::-webkit-scrollbar { width:4px; }
      .ndp-body::-webkit-scrollbar-track { background:#0d0d1a; }
      .ndp-body::-webkit-scrollbar-thumb { background:#334; border-radius:2px; }
    `;
    document.head.appendChild(style);
  }
}
