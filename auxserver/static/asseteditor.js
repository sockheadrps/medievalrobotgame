/* Asset Editor — client-side logic for /asseteditor */

let currentTab = 'wo';
let worldObjects = [];
let equipment = [];
let items = [];
let stations = [];
let selectedWO = null;
let selectedEQ = null;
let selectedIT = null;
let selectedST = null;

// ── Save feedback ────────────────────────────────────────────────────────────

function showFeedback(message, type) {
  let el = document.getElementById('ae-save-feedback');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ae-save-feedback';
    el.style.cssText = 'position:fixed;top:10px;right:10px;padding:8px 16px;border-radius:4px;font-weight:bold;z-index:9999;display:none;';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.style.background = type === 'success' ? '#4caf50' : '#f44336';
  el.style.color = '#fff';
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 2500);
}

// ── Tab switching ────────────────────────────────────────────────────────────

function switchTab(tab) {
  currentTab = tab;
  document.getElementById('tabWO').classList.toggle('active', tab === 'wo');
  document.getElementById('tabEQ').classList.toggle('active', tab === 'eq');
  document.getElementById('tabIT').classList.toggle('active', tab === 'it');
  document.getElementById('tabST').classList.toggle('active', tab === 'st');
  document.getElementById('woSidebar').style.display = tab === 'wo' ? '' : 'none';
  document.getElementById('eqSidebar').style.display = tab === 'eq' ? '' : 'none';
  document.getElementById('itSidebar').style.display = tab === 'it' ? '' : 'none';
  document.getElementById('stSidebar').style.display = tab === 'st' ? '' : 'none';
  document.getElementById('woEditor').style.display = 'none';
  document.getElementById('eqEditor').style.display = 'none';
  document.getElementById('itEditor').style.display = 'none';
  document.getElementById('stEditor').style.display = 'none';
  document.getElementById('emptyState').style.display = '';
  selectedWO = null;
  selectedEQ = null;
  selectedIT = null;
  selectedST = null;
}

// ── Data loading ─────────────────────────────────────────────────────────────

async function loadAll() {
  const [woResp, eqResp, itResp, stResp] = await Promise.all([
    fetch('/api/assets/world-objects'),
    fetch('/api/assets/equipment'),
    fetch('/api/assets/items'),
    fetch('/api/assets/stations'),
  ]);
  worldObjects = await woResp.json();
  equipment = await eqResp.json();
  items = await itResp.json();
  stations = await stResp.json();
  renderWOList();
  renderEQList();
  renderITList();
  renderSTList();
}

function renderWOList() {
  const ul = document.getElementById('woList');
  ul.innerHTML = '';
  for (const wo of worldObjects) {
    const li = document.createElement('li');
    li.classList.toggle('selected', selectedWO?.id === wo.id);
    li.innerHTML = `<span class="item-label">${wo.label || wo.id}</span><span class="item-id">${wo.id}</span>`;
    li.onclick = () => selectWO(wo);
    ul.appendChild(li);
  }
}

function renderEQList() {
  const ul = document.getElementById('eqList');
  ul.innerHTML = '';
  for (const eq of equipment) {
    const li = document.createElement('li');
    li.classList.toggle('selected', selectedEQ?.id === eq.id);
    li.innerHTML = `<span class="item-label">${eq.label || eq.id}</span><span class="item-id">${eq.id}</span>`;
    li.onclick = () => selectEQ(eq);
    ul.appendChild(li);
  }
}

// ── World Object Editor ──────────────────────────────────────────────────────

function newWorldObject() {
  const id = prompt('World Object ID (e.g. copper_ore):');
  if (!id) return;
  const wo = {
    id, label: id.replace(/_/g, ' '),
    sprite: { type: 'tilemap', tileCol: 0, tileRow: 0 },
    solid: true, interaction: 'mine', required_level: 1,
    hp: 5, drops: [{ resource: 'copper', min: 1, max: 2 }],
    respawn_min: 30, respawn_max: 60,
  };
  selectWO(wo);
}

function selectWO(wo) {
  selectedWO = JSON.parse(JSON.stringify(wo));
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('eqEditor').style.display = 'none';
  document.getElementById('itEditor').style.display = 'none';
  document.getElementById('stEditor').style.display = 'none';
  const el = document.getElementById('woEditor');
  el.style.display = '';
  renderWOEditor();
  renderWOList();
}

function renderWOEditor() {
  const wo = selectedWO;
  if (!wo) return;
  const el = document.getElementById('woEditor');
  el.innerHTML = `
    <h3 style="color:#66aaff;margin-bottom:12px;">World Object: ${wo.id}</h3>

    <div class="form-row">
      <div class="form-group"><label>ID</label><input id="wo_id" value="${wo.id}" /></div>
      <div class="form-group"><label>Label</label><input id="wo_label" value="${wo.label || ''}" /></div>
    </div>

    <div class="section-header">Sprite</div>
    <div class="form-row">
      <div class="form-group"><label>Type</label>
        <select id="wo_spriteType">
          <option value="tilemap" ${wo.sprite?.type === 'tilemap' ? 'selected' : ''}>Tilemap</option>
          <option value="png" ${wo.sprite?.type === 'png' ? 'selected' : ''}>Custom PNG</option>
        </select>
      </div>
      <div class="form-group"><label>Tile Col</label><input type="number" id="wo_tileCol" value="${wo.sprite?.tileCol ?? 0}" onchange="drawTilePreview('wo_tilePreview', Number(this.value), Number(document.getElementById('wo_tileRow').value))" /></div>
      <div class="form-group"><label>Tile Row</label><input type="number" id="wo_tileRow" value="${wo.sprite?.tileRow ?? 0}" onchange="drawTilePreview('wo_tilePreview', Number(document.getElementById('wo_tileCol').value), Number(this.value))" /></div>
      <div class="form-group"><label>Preview</label>
        <div style="display:flex;align-items:center;">
          <canvas id="wo_tilePreview" class="tile-preview" width="48" height="48"></canvas>
          <button type="button" class="btn-pick-tile" onclick="openTilePicker(
            Number(document.getElementById('wo_tileCol').value),
            Number(document.getElementById('wo_tileRow').value),
            (col, row) => {
              document.getElementById('wo_tileCol').value = col;
              document.getElementById('wo_tileRow').value = row;
              drawTilePreview('wo_tilePreview', col, row);
            }
          )">Pick tile</button>
        </div>
      </div>
    </div>

    <div class="section-header">Properties</div>
    <div class="form-row">
      <div class="form-group"><label>Interaction</label>
        <select id="wo_interaction">
          <option value="mine" ${wo.interaction === 'mine' ? 'selected' : ''}>Mine</option>
          <option value="chop" ${wo.interaction === 'chop' ? 'selected' : ''}>Chop</option>
          <option value="harvest" ${wo.interaction === 'harvest' ? 'selected' : ''}>Harvest</option>
        </select>
      </div>
      <div class="form-group"><label>Required Level</label><input type="number" id="wo_reqLevel" value="${wo.required_level ?? 1}" min="1" /></div>
      <div class="form-group"><label>HP</label><input type="number" id="wo_hp" value="${wo.hp ?? 5}" min="1" /></div>
      <div class="form-group"><label>Solid</label>
        <select id="wo_solid">
          <option value="true" ${wo.solid ? 'selected' : ''}>Yes</option>
          <option value="false" ${!wo.solid ? 'selected' : ''}>No</option>
        </select>
      </div>
    </div>

    <div class="form-row">
      <div class="form-group"><label>Respawn Min (s)</label><input type="number" id="wo_respawnMin" value="${wo.respawn_min ?? 30}" /></div>
      <div class="form-group"><label>Respawn Max (s)</label><input type="number" id="wo_respawnMax" value="${wo.respawn_max ?? 60}" /></div>
    </div>

    <div class="section-header">Drops</div>
    <div class="drops-list" id="woDrops"></div>
    <button class="btn-add-row" onclick="addWODrop()">+ Add Drop</button>

    <div style="margin-top:20px;">
      <button class="btn-save" onclick="saveWO()">Save</button>
      <button class="btn-delete" onclick="deleteWO()">Delete</button>
    </div>
  `;
  renderWODrops();
  drawTilePreview('wo_tilePreview', wo.sprite?.tileCol ?? 0, wo.sprite?.tileRow ?? 0);
}

function _itemOptions(selected) {
  let opts = '';
  for (const it of items) {
    const sel = it.id === selected ? ' selected' : '';
    opts += `<option value="${it.id}"${sel}>${it.label || it.id}</option>`;
  }
  // If the current value isn't in items list, keep it as a fallback option
  if (selected && !items.find(it => it.id === selected)) {
    opts = `<option value="${selected}" selected>${selected}</option>` + opts;
  }
  return opts;
}

function renderWODrops() {
  const container = document.getElementById('woDrops');
  if (!container) return;
  container.innerHTML = '';
  for (let i = 0; i < (selectedWO.drops || []).length; i++) {
    const d = selectedWO.drops[i];
    const row = document.createElement('div');
    row.className = 'drop-row';
    row.innerHTML = `
      <select class="drop-res" data-i="${i}" data-f="resource" onchange="updateWODrop(this)">${_itemOptions(d.resource)}</select>
      <label style="color:#888;font-size:11px;">min</label>
      <input class="drop-num" type="number" value="${d.min}" data-i="${i}" data-f="min" onchange="updateWODrop(this)" />
      <label style="color:#888;font-size:11px;">max</label>
      <input class="drop-num" type="number" value="${d.max}" data-i="${i}" data-f="max" onchange="updateWODrop(this)" />
      <button onclick="removeWODrop(${i})">x</button>
    `;
    container.appendChild(row);
  }
}

function addWODrop() {
  selectedWO.drops = selectedWO.drops || [];
  const defaultRes = items.length > 0 ? items[0].id : 'stone';
  selectedWO.drops.push({ resource: defaultRes, min: 1, max: 1 });
  renderWODrops();
}

function removeWODrop(i) {
  selectedWO.drops.splice(i, 1);
  renderWODrops();
}

function updateWODrop(el) {
  const i = Number(el.dataset.i);
  const f = el.dataset.f;
  if (f === 'resource') selectedWO.drops[i].resource = el.value;
  else selectedWO.drops[i][f] = Number(el.value);
}

function gatherWO() {
  return {
    id: document.getElementById('wo_id').value.trim(),
    label: document.getElementById('wo_label').value.trim(),
    sprite: {
      type: document.getElementById('wo_spriteType').value,
      tileCol: Number(document.getElementById('wo_tileCol').value),
      tileRow: Number(document.getElementById('wo_tileRow').value),
    },
    solid: document.getElementById('wo_solid').value === 'true',
    interaction: document.getElementById('wo_interaction').value,
    required_level: Number(document.getElementById('wo_reqLevel').value),
    hp: Number(document.getElementById('wo_hp').value),
    drops: selectedWO.drops || [],
    respawn_min: Number(document.getElementById('wo_respawnMin').value),
    respawn_max: Number(document.getElementById('wo_respawnMax').value),
  };
}

async function saveWO() {
  const data = gatherWO();
  try {
    await fetch('/api/assets/world-objects', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    await loadAll();
    selectWO(data);
    showFeedback('Saved!', 'success');
  } catch (e) {
    showFeedback('Save failed: ' + e.message, 'error');
  }
}

async function deleteWO() {
  if (!selectedWO?.id) return;
  if (!confirm(`Delete world object "${selectedWO.id}"?`)) return;
  await fetch(`/api/assets/world-objects/${selectedWO.id}`, { method: 'DELETE' });
  selectedWO = null;
  document.getElementById('woEditor').style.display = 'none';
  document.getElementById('emptyState').style.display = '';
  await loadAll();
}

// ── Equipment Editor ─────────────────────────────────────────────────────────

let _eqSheetImg = null;      // loaded spritesheet Image for current equipment
let _eqSelectedFrame = null;  // currently clicked frame index in the sheet picker

function newEquipment() {
  const id = prompt('Equipment ID (e.g. iron_helm):');
  if (!id) return;
  const eq = {
    id, label: id.replace(/_/g, ' '),
    spriteSheet: '', slot: 'chest',
    frameSize: { width: 32, height: 32 }, totalFrames: 1,
    namedFrames: {}, sourceTemplate: 'baseplayer',
    recipe: { station: 'anvil', ingredients: {}, required_level: 1 },
    stats: { str_bonus: 0, def_bonus: 0, hp_bonus: 0, dmg_reduction_pct: 0 },
  };
  selectEQ(eq);
}

function selectEQ(eq) {
  selectedEQ = JSON.parse(JSON.stringify(eq));
  _eqSheetImg = null;
  _eqSelectedFrame = null;
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('woEditor').style.display = 'none';
  document.getElementById('itEditor').style.display = 'none';
  document.getElementById('stEditor').style.display = 'none';
  const el = document.getElementById('eqEditor');
  el.style.display = '';
  renderEQEditor();
  renderEQList();
}

function renderEQEditor() {
  const eq = selectedEQ;
  if (!eq) return;
  const stats = eq.stats || {};
  const recipe = eq.recipe || {};
  const el = document.getElementById('eqEditor');
  el.innerHTML = `
    <h3 style="color:#66aaff;margin-bottom:12px;">Equipment: ${eq.id}</h3>

    <div class="form-row">
      <div class="form-group"><label>ID</label><input id="eq_id" value="${eq.id}" /></div>
      <div class="form-group"><label>Label</label><input id="eq_label" value="${eq.label || ''}" /></div>
    </div>

    <div class="form-row">
      <div class="form-group"><label>Slot</label>
        <select id="eq_slot" onchange="toggleMiningFields()">
          <option value="chest" ${eq.slot === 'chest' ? 'selected' : ''}>Chest</option>
          <option value="head" ${eq.slot === 'head' ? 'selected' : ''}>Head</option>
          <option value="legs" ${eq.slot === 'legs' ? 'selected' : ''}>Legs</option>
          <option value="weapon" ${eq.slot === 'weapon' ? 'selected' : ''}>Weapon</option>
          <option value="tool" ${eq.slot === 'tool' ? 'selected' : ''}>Tool</option>
        </select>
      </div>
      <div class="form-group"><label>Source Template</label><input id="eq_sourceTemplate" value="${eq.sourceTemplate || 'baseplayer'}" /></div>
    </div>

    <!-- ── Sprite Sheet ────────────────────────────────────── -->
    <div class="section-header">Sprite Sheet</div>
    <div class="form-row">
      <div class="form-group"><label>spriteSheet</label>
        <div style="display:flex;gap:6px;align-items:center;">
          <input type="text" id="eq_spriteSheet" value="${eq.spriteSheet || ''}" readonly style="flex:1;" />
          <button type="button" class="btn-pick-tile" onclick="openEQSpritesheet()">Open PNG</button>
        </div>
      </div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>frameSize.width</label><input type="number" id="eq_frameW" value="${eq.frameSize?.width ?? 32}" min="1" onchange="redrawEQSheetPicker()" /></div>
      <div class="form-group"><label>frameSize.height</label><input type="number" id="eq_frameH" value="${eq.frameSize?.height ?? 32}" min="1" onchange="redrawEQSheetPicker()" /></div>
      <div class="form-group"><label>totalFrames</label><input type="number" id="eq_totalFrames" value="${eq.totalFrames ?? 1}" min="1" /></div>
    </div>

    <div style="display:flex;gap:12px;align-items:flex-start;margin:8px 0;">
      <div>
        <div style="color:#88aacc;font-size:10px;text-transform:uppercase;margin-bottom:4px;">Selected Frame</div>
        <canvas id="eq_sheetPreview" class="tile-preview" width="64" height="64" style="width:64px;height:64px;"></canvas>
        <div id="eq_frameInfo" style="color:#8a8;font-size:11px;margin-top:2px;"></div>
      </div>
      <div class="sheet-picker-wrap" id="eq_sheetPickerWrap">
        <canvas id="eq_sheetPicker"></canvas>
      </div>
    </div>

    <!-- ── Named Frames ────────────────────────────────────── -->
    <div class="section-header">Named Frames
      <span style="font-size:10px;color:#556;text-transform:none;letter-spacing:0;">— click a frame above, then assign an animation name</span>
    </div>
    <div id="eq_namedFramesList"></div>
    <div class="form-row" style="margin-top:6px;">
      <div class="form-group" style="flex:0 0 60px;"><label>Frame #</label><input type="number" id="eq_nfFrame" value="0" min="0" style="width:60px;" /></div>
      <div class="form-group" style="flex:1;"><label>Animation Name</label><input type="text" id="eq_nfName" placeholder="e.g. face_down" /></div>
      <div class="form-group" style="flex:0;align-self:flex-end;">
        <button class="btn-add-row" onclick="addEQNamedFrame()">+ Assign</button>
      </div>
    </div>

    <!-- ── Stats ───────────────────────────────────────────── -->
    <div class="section-header">Stats</div>
    <div class="form-row">
      <div class="form-group"><label>STR Bonus</label><input type="number" id="eq_strBonus" value="${stats.str_bonus ?? 0}" /></div>
      <div class="form-group"><label>DEF Bonus</label><input type="number" id="eq_defBonus" value="${stats.def_bonus ?? 0}" /></div>
      <div class="form-group"><label>HP Bonus</label><input type="number" id="eq_hpBonus" value="${stats.hp_bonus ?? 0}" /></div>
      <div class="form-group"><label>Dmg Reduction %</label><input type="number" id="eq_dmgRed" value="${stats.dmg_reduction_pct ?? 0}" step="0.1" /></div>
    </div>

    <div class="section-header" id="eq_miningHeader" style="${eq.slot === 'tool' ? '' : 'display:none'}">Mining Tool Stats</div>
    <div class="form-row" id="eq_miningRow" style="${eq.slot === 'tool' ? '' : 'display:none'}">
      <div class="form-group"><label>Mining Power</label><input type="number" id="eq_miningPower" value="${stats.mining_power ?? 1}" min="1" /></div>
      <div class="form-group"><label>Can Mine Hardwall</label>
        <select id="eq_canMineHardwall">
          <option value="false" ${!stats.can_mine_hardwall ? 'selected' : ''}>No</option>
          <option value="true" ${stats.can_mine_hardwall ? 'selected' : ''}>Yes</option>
        </select>
      </div>
      <div class="form-group"><label>Durability (0=infinite)</label><input type="number" id="eq_durability" value="${stats.durability ?? 0}" min="0" /></div>
    </div>

    <!-- ── Recipe ──────────────────────────────────────────── -->
    <div class="section-header">Recipe</div>
    <div class="form-row">
      <div class="form-group"><label>Station</label>
        <select id="eq_station">
          <option value="anvil" ${recipe.station === 'anvil' ? 'selected' : ''}>Anvil</option>
          <option value="workbench" ${recipe.station === 'workbench' ? 'selected' : ''}>Workbench</option>
        </select>
      </div>
      <div class="form-group"><label>Required Level</label><input type="number" id="eq_recipeLevel" value="${recipe.required_level ?? 1}" min="1" /></div>
    </div>

    <div class="section-header">Ingredients</div>
    <div class="ingredients-list" id="eqIngredients"></div>
    <button class="btn-add-row" onclick="addEQIngredient()">+ Add Ingredient</button>

    <div style="margin-top:20px;">
      <button class="btn-save" onclick="saveEQ()">Save</button>
      <button class="btn-delete" onclick="deleteEQ()">Delete</button>
    </div>
  `;
  renderEQIngredients();
  renderEQNamedFrames();
  // Auto-load existing spritesheet
  if (eq.spriteSheet && eq.id) {
    loadEQSpritesheet(eq.spriteSheet);
  }
}

// ── Equipment Spritesheet Picker ────────────────────────────────────────────

function openEQSpritesheet() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png';
  input.onchange = async () => {
    if (!input.files.length) return;
    const file = input.files[0];
    const id = document.getElementById('eq_id')?.value?.trim();
    if (!id) { alert('Set an equipment ID first.'); return; }
    // Upload to server
    const form = new FormData();
    form.append('file', file);
    const resp = await fetch(`/api/assets/equipment/${id}/sprite`, { method: 'POST', body: form });
    const result = await resp.json();
    if (!result.ok) { alert('Upload failed'); return; }
    document.getElementById('eq_spriteSheet').value = file.name;
    // Load into canvas
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      _eqSheetImg = img;
      redrawEQSheetPicker();
    };
    img.src = url;
  };
  input.click();
}

function loadEQSpritesheet(filename) {
  const id = selectedEQ?.id;
  if (!id || !filename) return;
  const img = new Image();
  img.onload = () => {
    _eqSheetImg = img;
    redrawEQSheetPicker();
  };
  img.onerror = () => { /* sheet not found, that's ok */ };
  img.src = `/assets/equipment/${id}/${filename}`;
}

function redrawEQSheetPicker() {
  const canvas = document.getElementById('eq_sheetPicker');
  const preview = document.getElementById('eq_sheetPreview');
  if (!canvas || !_eqSheetImg) return;

  const fw = Number(document.getElementById('eq_frameW')?.value) || 32;
  const fh = Number(document.getElementById('eq_frameH')?.value) || 32;
  const img = _eqSheetImg;
  const cols = Math.max(1, Math.floor(img.width / fw));
  const rows = Math.max(1, Math.floor(img.height / fh));

  const scale = Math.max(1, Math.min(3, Math.floor(500 / img.width)));
  canvas.width = img.width * scale;
  canvas.height = img.height * scale;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  // Draw grid
  ctx.strokeStyle = 'rgba(100,170,255,0.25)';
  ctx.lineWidth = 1;
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      ctx.strokeRect(c * fw * scale, r * fh * scale, fw * scale, fh * scale);
    }
  }

  // Highlight frames that have named assignments
  const nf = selectedEQ?.namedFrames || {};
  for (const frameStr of Object.keys(nf)) {
    const fi = Number(frameStr);
    const fc = fi % cols;
    const fr = Math.floor(fi / cols);
    ctx.strokeStyle = 'rgba(102,255,136,0.6)';
    ctx.lineWidth = 2;
    ctx.strokeRect(fc * fw * scale + 1, fr * fh * scale + 1, fw * scale - 2, fh * scale - 2);
  }

  // Highlight selected frame
  if (_eqSelectedFrame !== null) {
    const selCol = _eqSelectedFrame % cols;
    const selRow = Math.floor(_eqSelectedFrame / cols);
    ctx.strokeStyle = '#ffcc00';
    ctx.lineWidth = 2;
    ctx.strokeRect(selCol * fw * scale, selRow * fh * scale, fw * scale, fh * scale);
  }

  // Draw preview
  if (preview && _eqSelectedFrame !== null) {
    const selCol = _eqSelectedFrame % cols;
    const selRow = Math.floor(_eqSelectedFrame / cols);
    const pctx = preview.getContext('2d');
    pctx.imageSmoothingEnabled = false;
    pctx.clearRect(0, 0, preview.width, preview.height);
    pctx.drawImage(img, selCol * fw, selRow * fh, fw, fh, 0, 0, preview.width, preview.height);
  }

  // Update frame info
  const info = document.getElementById('eq_frameInfo');
  if (info && _eqSelectedFrame !== null) {
    const name = nf[String(_eqSelectedFrame)];
    info.textContent = `Frame ${_eqSelectedFrame}` + (name ? ` = ${name}` : '');
  }

  // Click handler
  canvas.onclick = (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    const px = (e.clientX - rect.left) * sx;
    const py = (e.clientY - rect.top) * sy;
    const clickCol = Math.floor(px / (fw * scale));
    const clickRow = Math.floor(py / (fh * scale));
    _eqSelectedFrame = clickRow * cols + clickCol;
    document.getElementById('eq_nfFrame').value = _eqSelectedFrame;
    redrawEQSheetPicker();
  };
}

// ── Named Frames UI ─────────────────────────────────────────────────────────

function renderEQNamedFrames() {
  const container = document.getElementById('eq_namedFramesList');
  if (!container) return;
  container.innerHTML = '';
  const nf = selectedEQ?.namedFrames || {};
  const entries = Object.entries(nf);
  if (entries.length === 0) {
    container.innerHTML = '<div style="color:#556;font-size:11px;">No frames assigned yet.</div>';
    return;
  }
  for (const [frameStr, animName] of entries) {
    const row = document.createElement('div');
    row.className = 'ingredient-row';
    row.innerHTML = `
      <span style="color:#88aacc;width:50px;font-size:11px;">#${frameStr}</span>
      <input style="flex:1;" value="${animName}" onchange="updateEQNamedFrame('${frameStr}', this.value)" />
      <button onclick="removeEQNamedFrame('${frameStr}')">x</button>
    `;
    // Hover to highlight in picker
    row.onmouseenter = () => { _eqSelectedFrame = Number(frameStr); redrawEQSheetPicker(); };
    container.appendChild(row);
  }
}

function addEQNamedFrame() {
  const frame = document.getElementById('eq_nfFrame').value.trim();
  const name = document.getElementById('eq_nfName').value.trim();
  if (!name) { alert('Enter an animation name.'); return; }
  if (!selectedEQ.namedFrames) selectedEQ.namedFrames = {};
  selectedEQ.namedFrames[frame] = name;
  document.getElementById('eq_nfName').value = '';
  renderEQNamedFrames();
  redrawEQSheetPicker();
}

function updateEQNamedFrame(frameStr, newName) {
  if (!selectedEQ.namedFrames) return;
  if (newName.trim()) {
    selectedEQ.namedFrames[frameStr] = newName.trim();
  } else {
    delete selectedEQ.namedFrames[frameStr];
  }
  renderEQNamedFrames();
  redrawEQSheetPicker();
}

function removeEQNamedFrame(frameStr) {
  delete selectedEQ.namedFrames[frameStr];
  renderEQNamedFrames();
  redrawEQSheetPicker();
}

// ── Equipment Ingredients ───────────────────────────────────────────────────

function renderEQIngredients() {
  const container = document.getElementById('eqIngredients');
  if (!container) return;
  container.innerHTML = '';
  const ingredients = selectedEQ.recipe?.ingredients || {};
  const entries = Object.entries(ingredients);
  for (let i = 0; i < entries.length; i++) {
    const [res, amt] = entries[i];
    const row = document.createElement('div');
    row.className = 'ingredient-row';
    row.innerHTML = `
      <input class="ing-res" value="${res}" data-i="${i}" data-f="res" onchange="updateEQIngredient(this)" />
      <input class="ing-amt" type="number" value="${amt}" data-i="${i}" data-f="amt" onchange="updateEQIngredient(this)" />
      <button onclick="removeEQIngredient('${res}')">x</button>
    `;
    container.appendChild(row);
  }
}

function addEQIngredient() {
  if (!selectedEQ.recipe) selectedEQ.recipe = { station: 'anvil', ingredients: {}, required_level: 1 };
  const name = prompt('Resource name (e.g. copper, stones):');
  if (!name) return;
  selectedEQ.recipe.ingredients[name] = 1;
  renderEQIngredients();
}

function removeEQIngredient(res) {
  delete selectedEQ.recipe.ingredients[res];
  renderEQIngredients();
}

function updateEQIngredient(el) {
  const container = document.getElementById('eqIngredients');
  const rows = container.querySelectorAll('.ingredient-row');
  const newIngredients = {};
  rows.forEach(row => {
    const res = row.querySelector('.ing-res').value.trim();
    const amt = Number(row.querySelector('.ing-amt').value);
    if (res) newIngredients[res] = amt;
  });
  selectedEQ.recipe.ingredients = newIngredients;
}

// ── Equipment Gather / Save / Delete ────────────────────────────────────────

function gatherEQ() {
  updateEQIngredient(null);
  return {
    id: document.getElementById('eq_id').value.trim(),
    label: document.getElementById('eq_label').value.trim(),
    spriteSheet: document.getElementById('eq_spriteSheet').value.trim(),
    slot: document.getElementById('eq_slot').value,
    frameSize: {
      width: Number(document.getElementById('eq_frameW').value),
      height: Number(document.getElementById('eq_frameH').value),
    },
    totalFrames: Number(document.getElementById('eq_totalFrames').value),
    namedFrames: selectedEQ?.namedFrames || {},
    sourceTemplate: document.getElementById('eq_sourceTemplate')?.value?.trim() || 'baseplayer',
    recipe: {
      station: document.getElementById('eq_station').value,
      ingredients: selectedEQ.recipe?.ingredients || {},
      required_level: Number(document.getElementById('eq_recipeLevel').value),
    },
    stats: {
      str_bonus: Number(document.getElementById('eq_strBonus').value),
      def_bonus: Number(document.getElementById('eq_defBonus').value),
      hp_bonus: Number(document.getElementById('eq_hpBonus').value),
      dmg_reduction_pct: Number(document.getElementById('eq_dmgRed').value),
      mining_power: Number(document.getElementById('eq_miningPower')?.value || 0),
      can_mine_hardwall: document.getElementById('eq_canMineHardwall')?.value === 'true',
      durability: Number(document.getElementById('eq_durability')?.value || 0),
    },
  };
}

function toggleMiningFields() {
  const isTool = document.getElementById('eq_slot')?.value === 'tool';
  const header = document.getElementById('eq_miningHeader');
  const row = document.getElementById('eq_miningRow');
  if (header) header.style.display = isTool ? '' : 'none';
  if (row) row.style.display = isTool ? '' : 'none';
}

async function saveEQ() {
  const data = gatherEQ();
  try {
    await fetch('/api/assets/equipment', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    await loadAll();
    selectEQ(data);
    showFeedback('Saved!', 'success');
  } catch (e) {
    showFeedback('Save failed: ' + e.message, 'error');
  }
}

async function deleteEQ() {
  if (!selectedEQ?.id) return;
  if (!confirm(`Delete equipment "${selectedEQ.id}"?`)) return;
  await fetch(`/api/assets/equipment/${selectedEQ.id}`, { method: 'DELETE' });
  selectedEQ = null;
  document.getElementById('eqEditor').style.display = 'none';
  document.getElementById('emptyState').style.display = '';
  await loadAll();
}

// ── Item Editor ──────────────────────────────────────────────────────────────

let _itSheetImg = null;   // loaded spritesheet Image for current item
let _itSheetFile = null;  // filename of loaded spritesheet

function renderITList() {
  const ul = document.getElementById('itList');
  ul.innerHTML = '';
  for (const it of items) {
    const li = document.createElement('li');
    li.classList.toggle('selected', selectedIT?.id === it.id);
    li.innerHTML = `<span class="item-label">${it.label || it.id}</span><span class="item-id">${it.id}</span>`;
    li.onclick = () => selectIT(it);
    ul.appendChild(li);
  }
}

function newItem() {
  const id = prompt('Item ID (e.g. copper):');
  if (!id) return;
  const it = {
    id, label: id.charAt(0).toUpperCase() + id.slice(1).replace(/_/g, ' '),
    category: 'resource',
    sprite: { type: 'tilemap', tileCol: 0, tileRow: 0 },
    stackable: true, maxStack: 99,
    color: '#cccccc', description: '',
  };
  selectIT(it);
}

function selectIT(it) {
  selectedIT = JSON.parse(JSON.stringify(it));
  _itSheetImg = null;
  _itSheetFile = null;
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('woEditor').style.display = 'none';
  document.getElementById('eqEditor').style.display = 'none';
  document.getElementById('stEditor').style.display = 'none';
  const el = document.getElementById('itEditor');
  el.style.display = '';
  renderITEditor();
  renderITList();
}

function renderITEditor() {
  const it = selectedIT;
  if (!it) return;
  const el = document.getElementById('itEditor');
  const sp = it.sprite || {};
  el.innerHTML = `
    <h3 style="color:#66aaff;margin-bottom:12px;">Item: ${it.id}</h3>

    <!-- ── Identity ─────────────────────────────────────────── -->
    <div class="section-header">Identity</div>
    <div class="form-row">
      <div class="form-group"><label>id</label><input id="it_id" value="${it.id}" /></div>
      <div class="form-group"><label>label</label><input id="it_label" value="${it.label || ''}" /></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>category</label>
        <select id="it_category">
          <option value="resource" ${it.category === 'resource' ? 'selected' : ''}>resource</option>
          <option value="consumable" ${it.category === 'consumable' ? 'selected' : ''}>consumable</option>
          <option value="quest" ${it.category === 'quest' ? 'selected' : ''}>quest</option>
          <option value="material" ${it.category === 'material' ? 'selected' : ''}>material</option>
        </select>
      </div>
      <div class="form-group"><label>color</label>
        <div style="display:flex;gap:6px;align-items:center;">
          <input type="color" id="it_color" value="${it.color || '#cccccc'}" style="width:40px;height:28px;padding:0;border:1px solid #444;" />
          <input type="text" id="it_colorHex" value="${it.color || '#cccccc'}" style="width:80px;" oninput="document.getElementById('it_color').value=this.value" />
        </div>
      </div>
    </div>
    <div class="form-group"><label>description</label><textarea id="it_description" rows="2">${it.description || ''}</textarea></div>

    <!-- ── Stacking ─────────────────────────────────────────── -->
    <div class="section-header">Stacking</div>
    <div class="form-row">
      <div class="form-group"><label>stackable</label>
        <select id="it_stackable">
          <option value="true" ${it.stackable !== false ? 'selected' : ''}>true</option>
          <option value="false" ${it.stackable === false ? 'selected' : ''}>false</option>
        </select>
      </div>
      <div class="form-group"><label>maxStack</label><input type="number" id="it_maxStack" value="${it.maxStack ?? 99}" min="1" /></div>
    </div>

    <!-- ── Sprite ───────────────────────────────────────────── -->
    <div class="section-header">Sprite</div>
    <div class="form-row">
      <div class="form-group"><label>sprite.type</label>
        <select id="it_spriteType" onchange="toggleItemSpriteMode()">
          <option value="tilemap" ${sp.type === 'tilemap' ? 'selected' : ''}>tilemap</option>
          <option value="spritesheet" ${sp.type === 'spritesheet' ? 'selected' : ''}>spritesheet</option>
          <option value="png" ${sp.type === 'png' ? 'selected' : ''}>png</option>
        </select>
      </div>
    </div>

    <!-- Tilemap mode -->
    <div id="it_tilemapGroup">
      <div class="form-row" style="align-items:flex-end;">
        <div class="form-group"><label>sprite.tileCol</label><input type="number" id="it_tileCol" value="${sp.tileCol ?? 0}" onchange="drawTilePreview('it_tilePreview', Number(this.value), Number(document.getElementById('it_tileRow').value))" /></div>
        <div class="form-group"><label>sprite.tileRow</label><input type="number" id="it_tileRow" value="${sp.tileRow ?? 0}" onchange="drawTilePreview('it_tilePreview', Number(document.getElementById('it_tileCol').value), Number(this.value))" /></div>
        <div class="form-group"><label>Preview</label>
          <div style="display:flex;align-items:center;">
            <canvas id="it_tilePreview" class="tile-preview" width="48" height="48"></canvas>
            <button type="button" class="btn-pick-tile" onclick="openTilePicker(
              Number(document.getElementById('it_tileCol').value),
              Number(document.getElementById('it_tileRow').value),
              (col, row) => {
                document.getElementById('it_tileCol').value = col;
                document.getElementById('it_tileRow').value = row;
                drawTilePreview('it_tilePreview', col, row);
              }
            )">Pick tile</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Spritesheet mode -->
    <div id="it_sheetGroup" style="display:none;">
      <div class="form-row">
        <div class="form-group"><label>sprite.file</label>
          <div style="display:flex;gap:6px;align-items:center;">
            <input type="text" id="it_sheetFile" value="${sp.file || ''}" readonly style="flex:1;" />
            <button type="button" class="btn-pick-tile" onclick="openItemSpritesheet()">Open PNG</button>
          </div>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>sprite.frameW</label><input type="number" id="it_frameW" value="${sp.frameW ?? 16}" min="1" onchange="redrawSheetPicker()" /></div>
        <div class="form-group"><label>sprite.frameH</label><input type="number" id="it_frameH" value="${sp.frameH ?? 16}" min="1" onchange="redrawSheetPicker()" /></div>
        <div class="form-group"><label>sprite.spacing</label><input type="number" id="it_spacing" value="${sp.spacing ?? 0}" min="0" onchange="redrawSheetPicker()" /></div>
        <div class="form-group"><label>sprite.frame</label><input type="number" id="it_frame" value="${sp.frame ?? 0}" min="0" onchange="redrawSheetPicker()" /></div>
      </div>
      <div style="display:flex;gap:12px;align-items:flex-start;margin-top:8px;">
        <canvas id="it_sheetPreview" class="tile-preview" width="64" height="64" style="width:64px;height:64px;"></canvas>
        <div class="sheet-picker-wrap" id="it_sheetPickerWrap">
          <canvas id="it_sheetPicker"></canvas>
        </div>
      </div>
    </div>

    <!-- PNG mode -->
    <div id="it_pngGroup" style="display:none;">
      <div class="form-group"><label>sprite.png</label>
        <div style="display:flex;gap:6px;align-items:center;">
          <input type="text" id="it_png" value="${sp.png || ''}" readonly style="flex:1;" />
          <button type="button" class="btn-pick-tile" onclick="document.getElementById('it_pngUpload').click()">Open PNG</button>
        </div>
        <input type="file" id="it_pngUpload" accept="image/png" style="display:none;" onchange="uploadItemSprite()" />
      </div>
      <div id="it_pngPreviewWrap" style="margin-top:6px;"></div>
    </div>

    <!-- ── JSON Preview ─────────────────────────────────────── -->
    <div class="section-header" style="cursor:pointer;user-select:none;" onclick="document.getElementById('it_jsonPreview').style.display = document.getElementById('it_jsonPreview').style.display === 'none' ? '' : 'none';">
      JSON Preview <span style="font-size:10px;color:#556;">&#9660;</span>
    </div>
    <pre id="it_jsonPreview" style="display:none;background:#080818;border:1px solid #222;padding:8px;border-radius:4px;font-size:11px;color:#8a8;max-height:200px;overflow:auto;white-space:pre-wrap;"></pre>

    <div style="margin-top:20px;display:flex;gap:8px;align-items:center;">
      <button class="btn-save" onclick="saveIT()">Save</button>
      <button class="btn-delete" onclick="deleteIT()">Delete</button>
      <button class="btn-pick-tile" onclick="previewITJson()" style="margin-left:auto;">Refresh JSON</button>
    </div>
  `;

  // Sync color picker ↔ hex input
  document.getElementById('it_color').addEventListener('input', () => {
    document.getElementById('it_colorHex').value = document.getElementById('it_color').value;
  });

  toggleItemSpriteMode();

  if (sp.type === 'tilemap') {
    drawTilePreview('it_tilePreview', sp.tileCol ?? 0, sp.tileRow ?? 0);
  } else if (sp.type === 'spritesheet' && sp.file) {
    // Try to load existing spritesheet
    loadItemSpritesheet(sp.file);
  }
}

function toggleItemSpriteMode() {
  const type = document.getElementById('it_spriteType')?.value;
  document.getElementById('it_tilemapGroup').style.display = type === 'tilemap' ? '' : 'none';
  document.getElementById('it_sheetGroup').style.display = type === 'spritesheet' ? '' : 'none';
  document.getElementById('it_pngGroup').style.display = type === 'png' ? '' : 'none';
}

function previewITJson() {
  const data = gatherIT();
  const el = document.getElementById('it_jsonPreview');
  if (el) {
    el.style.display = '';
    el.textContent = JSON.stringify(data, null, 2);
  }
}

// ── Spritesheet frame picker ────────────────────────────────────────────────

function openItemSpritesheet() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png';
  input.onchange = async () => {
    if (!input.files.length) return;
    const file = input.files[0];
    const id = document.getElementById('it_id')?.value?.trim();
    if (!id) { alert('Set an item ID first.'); return; }
    // Upload to server
    const form = new FormData();
    form.append('file', file);
    const resp = await fetch(`/api/assets/items/${id}/sprite`, { method: 'POST', body: form });
    const result = await resp.json();
    if (!result.ok) { alert('Upload failed'); return; }
    document.getElementById('it_sheetFile').value = file.name;
    // Load into canvas
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      _itSheetImg = img;
      _itSheetFile = file.name;
      redrawSheetPicker();
    };
    img.src = url;
  };
  input.click();
}

function loadItemSpritesheet(filename) {
  const id = selectedIT?.id;
  if (!id || !filename) return;
  const img = new Image();
  img.onload = () => {
    _itSheetImg = img;
    _itSheetFile = filename;
    redrawSheetPicker();
  };
  // Items are served from /static/items/{id}/{filename} — but they're in assets/items/
  // We need a route to serve them. Use the existing file path pattern.
  img.src = `/assets/items/${id}/${filename}`;
}

function redrawSheetPicker() {
  const canvas = document.getElementById('it_sheetPicker');
  const preview = document.getElementById('it_sheetPreview');
  if (!canvas || !_itSheetImg) return;

  const fw = Number(document.getElementById('it_frameW')?.value) || 16;
  const fh = Number(document.getElementById('it_frameH')?.value) || 16;
  const sp = Number(document.getElementById('it_spacing')?.value) || 0;
  const selFrame = Number(document.getElementById('it_frame')?.value) || 0;

  const img = _itSheetImg;
  const slotW = fw + sp;
  const slotH = fh + sp;
  const cols = Math.max(1, Math.floor((img.width + sp) / slotW));
  const rows = Math.max(1, Math.floor((img.height + sp) / slotH));

  const scale = Math.max(1, Math.min(3, Math.floor(400 / img.width)));
  canvas.width = img.width * scale;
  canvas.height = img.height * scale;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  // Draw grid
  ctx.strokeStyle = 'rgba(100,170,255,0.25)';
  ctx.lineWidth = 1;
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      ctx.strokeRect(c * slotW * scale, r * slotH * scale, fw * scale, fh * scale);
    }
  }

  // Highlight selected frame
  const selCol = selFrame % cols;
  const selRow = Math.floor(selFrame / cols);
  ctx.strokeStyle = '#ffcc00';
  ctx.lineWidth = 2;
  ctx.strokeRect(selCol * slotW * scale, selRow * slotH * scale, fw * scale, fh * scale);

  // Draw preview of selected frame
  if (preview) {
    const pctx = preview.getContext('2d');
    pctx.imageSmoothingEnabled = false;
    pctx.clearRect(0, 0, preview.width, preview.height);
    pctx.drawImage(img,
      selCol * slotW, selRow * slotH, fw, fh,
      0, 0, preview.width, preview.height
    );
  }

  // Click handler
  canvas.onclick = (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    const px = (e.clientX - rect.left) * sx;
    const py = (e.clientY - rect.top) * sy;
    const clickCol = Math.floor(px / (slotW * scale));
    const clickRow = Math.floor(py / (slotH * scale));
    const frame = clickRow * cols + clickCol;
    document.getElementById('it_frame').value = frame;
    redrawSheetPicker();
  };
}

// ── Gather / Save / Delete ──────────────────────────────────────────────────

function gatherIT() {
  const spriteType = document.getElementById('it_spriteType').value;
  const sprite = { type: spriteType };
  if (spriteType === 'tilemap') {
    sprite.tileCol = Number(document.getElementById('it_tileCol').value);
    sprite.tileRow = Number(document.getElementById('it_tileRow').value);
  } else if (spriteType === 'spritesheet') {
    sprite.file = document.getElementById('it_sheetFile').value.trim();
    sprite.frameW = Number(document.getElementById('it_frameW').value);
    sprite.frameH = Number(document.getElementById('it_frameH').value);
    sprite.spacing = Number(document.getElementById('it_spacing').value);
    sprite.frame = Number(document.getElementById('it_frame').value);
  } else {
    sprite.png = document.getElementById('it_png').value.trim();
  }
  return {
    id: document.getElementById('it_id').value.trim(),
    label: document.getElementById('it_label').value.trim(),
    category: document.getElementById('it_category').value,
    sprite,
    stackable: document.getElementById('it_stackable').value === 'true',
    maxStack: Number(document.getElementById('it_maxStack').value),
    color: document.getElementById('it_colorHex').value.trim() || document.getElementById('it_color').value,
    description: document.getElementById('it_description').value.trim(),
  };
}

async function saveIT() {
  const data = gatherIT();
  try {
    await fetch('/api/assets/items', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    await loadAll();
    selectIT(data);
    showFeedback('Saved!', 'success');
  } catch (e) {
    showFeedback('Save failed: ' + e.message, 'error');
  }
}

async function deleteIT() {
  if (!selectedIT?.id) return;
  if (!confirm(`Delete item "${selectedIT.id}"?`)) return;
  await fetch(`/api/assets/items/${selectedIT.id}`, { method: 'DELETE' });
  selectedIT = null;
  document.getElementById('itEditor').style.display = 'none';
  document.getElementById('emptyState').style.display = '';
  await loadAll();
}

async function uploadItemSprite() {
  const fileInput = document.getElementById('it_pngUpload');
  if (!fileInput.files.length) return;
  const id = document.getElementById('it_id')?.value?.trim();
  if (!id) { alert('Save the item first (needs an ID).'); return; }
  const form = new FormData();
  form.append('file', fileInput.files[0]);
  const resp = await fetch(`/api/assets/items/${id}/sprite`, { method: 'POST', body: form });
  const result = await resp.json();
  if (result.ok) {
    const fname = fileInput.files[0].name;
    document.getElementById('it_png').value = fname;
    // Show preview
    const wrap = document.getElementById('it_pngPreviewWrap');
    if (wrap) {
      const url = URL.createObjectURL(fileInput.files[0]);
      wrap.innerHTML = `<img src="${url}" style="max-width:128px;image-rendering:pixelated;border:1px solid #333;" />`;
    }
  }
}

// ── Station Editor ──────────────────────────────────────────────────────────

function renderSTList() {
  const ul = document.getElementById('stList');
  ul.innerHTML = '';
  for (const st of stations) {
    const li = document.createElement('li');
    li.classList.toggle('selected', selectedST?.id === st.id);
    li.innerHTML = `<span class="item-label">${st.label || st.id}</span><span class="item-id">${st.id}</span>`;
    li.onclick = () => selectST(st);
    ul.appendChild(li);
  }
}

function newStation() {
  const id = prompt('Station ID (e.g. basic_furnace):');
  if (!id) return;
  const st = {
    id, label: id.replace(/_/g, ' '),
    sprite: { type: 'tilemap', tileCol: 0, tileRow: 0 },
    station_type: 'smelter',
    speed_bonus: 1.0,
    required_metallurgy: 0,
    fuel_type: 'none',
    recipes: [],
    build_recipe: {},
  };
  selectST(st);
}

function selectST(st) {
  selectedST = JSON.parse(JSON.stringify(st));
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('woEditor').style.display = 'none';
  document.getElementById('eqEditor').style.display = 'none';
  document.getElementById('itEditor').style.display = 'none';
  const el = document.getElementById('stEditor');
  el.style.display = '';
  renderSTEditor();
  renderSTList();
}

function renderSTEditor() {
  const st = selectedST;
  if (!st) return;
  const el = document.getElementById('stEditor');
  el.innerHTML = `
    <h3 style="color:#66aaff;margin-bottom:12px;">Crafting Station: ${st.id}</h3>

    <div class="form-row">
      <div class="form-group"><label>ID</label><input id="st_id" value="${st.id}" /></div>
      <div class="form-group"><label>Label</label><input id="st_label" value="${st.label || ''}" /></div>
    </div>

    <div class="section-header">Sprite</div>
    <div class="form-row">
      <div class="form-group"><label>Tile Col</label><input type="number" id="st_tileCol" value="${st.sprite?.tileCol ?? 0}" onchange="drawTilePreview('st_tilePreview', Number(this.value), Number(document.getElementById('st_tileRow').value))" /></div>
      <div class="form-group"><label>Tile Row</label><input type="number" id="st_tileRow" value="${st.sprite?.tileRow ?? 0}" onchange="drawTilePreview('st_tilePreview', Number(document.getElementById('st_tileCol').value), Number(this.value))" /></div>
      <div class="form-group"><label>Preview</label>
        <div style="display:flex;align-items:center;">
          <canvas id="st_tilePreview" class="tile-preview" width="48" height="48"></canvas>
          <button type="button" class="btn-pick-tile" onclick="openTilePicker(
            Number(document.getElementById('st_tileCol').value),
            Number(document.getElementById('st_tileRow').value),
            (col, row) => {
              document.getElementById('st_tileCol').value = col;
              document.getElementById('st_tileRow').value = row;
              drawTilePreview('st_tilePreview', col, row);
            }
          )">Pick tile</button>
        </div>
      </div>
    </div>

    <div class="section-header">Properties</div>
    <div class="form-row">
      <div class="form-group"><label>Station Type</label>
        <select id="st_stationType">
          <option value="smelter" ${st.station_type === 'smelter' ? 'selected' : ''}>Smelter</option>
          <option value="crusher" ${st.station_type === 'crusher' ? 'selected' : ''}>Crusher</option>
          <option value="anvil" ${st.station_type === 'anvil' ? 'selected' : ''}>Anvil</option>
          <option value="workbench" ${st.station_type === 'workbench' ? 'selected' : ''}>Workbench</option>
        </select>
      </div>
      <div class="form-group"><label>Speed Bonus</label><input type="number" id="st_speedBonus" value="${st.speed_bonus ?? 1.0}" step="0.1" min="0.1" /></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>Required Metallurgy Level</label><input type="number" id="st_reqMetal" value="${st.required_metallurgy ?? 0}" min="0" /></div>
      <div class="form-group"><label>Fuel Type</label>
        <select id="st_fuelType">
          <option value="none" ${st.fuel_type === 'none' ? 'selected' : ''}>None</option>
          <option value="coal" ${st.fuel_type === 'coal' ? 'selected' : ''}>Coal</option>
          <option value="wood" ${st.fuel_type === 'wood' ? 'selected' : ''}>Wood</option>
        </select>
      </div>
    </div>

    <div class="section-header">Build Recipe</div>
    <div class="build-recipe-list" id="stBuildRecipe"></div>
    <button class="btn-add-row" onclick="addSTBuildIngredient()">+ Add Ingredient</button>

    <div class="section-header">Station Recipes</div>
    <div class="station-recipes-list" id="stRecipes"></div>
    <button class="btn-add-row" onclick="addSTRecipe()">+ Add Recipe</button>

    <div style="margin-top:20px;">
      <button class="btn-save" onclick="saveST()">Save</button>
      <button class="btn-delete" onclick="deleteST()">Delete</button>
    </div>
  `;
  renderSTBuildRecipe();
  renderSTRecipes();
  drawTilePreview('st_tilePreview', st.sprite?.tileCol ?? 0, st.sprite?.tileRow ?? 0);
}

// ── Station Build Recipe ──

function renderSTBuildRecipe() {
  const container = document.getElementById('stBuildRecipe');
  if (!container) return;
  container.innerHTML = '';
  const ingredients = selectedST.build_recipe || {};
  const entries = Object.entries(ingredients);
  for (let i = 0; i < entries.length; i++) {
    const [res, amt] = entries[i];
    const row = document.createElement('div');
    row.className = 'ingredient-row';
    row.innerHTML = `
      <select class="ing-res" data-i="${i}" onchange="updateSTBuildRecipe()">${_itemOptions(res)}</select>
      <label style="color:#888;font-size:11px;">qty</label>
      <input class="ing-amt" type="number" value="${amt}" data-i="${i}" onchange="updateSTBuildRecipe()" />
      <button onclick="removeSTBuildIngredient('${res}')">x</button>
    `;
    container.appendChild(row);
  }
}

function addSTBuildIngredient() {
  if (!selectedST.build_recipe) selectedST.build_recipe = {};
  const defaultRes = items.length > 0 ? items[0].id : 'stone';
  selectedST.build_recipe[defaultRes] = 1;
  renderSTBuildRecipe();
}

function removeSTBuildIngredient(res) {
  delete selectedST.build_recipe[res];
  renderSTBuildRecipe();
}

function updateSTBuildRecipe() {
  const container = document.getElementById('stBuildRecipe');
  const rows = container.querySelectorAll('.ingredient-row');
  const newRecipe = {};
  rows.forEach(row => {
    const res = row.querySelector('.ing-res').value.trim();
    const amt = Number(row.querySelector('.ing-amt').value);
    if (res) newRecipe[res] = amt;
  });
  selectedST.build_recipe = newRecipe;
}

// ── Station Recipes (processing) ──

function renderSTRecipes() {
  const container = document.getElementById('stRecipes');
  if (!container) return;
  container.innerHTML = '';
  const recipes = selectedST.recipes || [];
  for (let i = 0; i < recipes.length; i++) {
    const r = recipes[i];
    const card = document.createElement('div');
    card.className = 'recipe-card';

    const inputRows = Object.entries(r.inputs || {}).map(([res, qty], j) =>
      `<div class="ing-row">
        <input class="ing-res" value="${res}" oninput="updateSTRecipeDict(this, ${i}, 'inputs', ${j})" />
        <input class="ing-amt" type="number" value="${qty}" min="1" oninput="updateSTRecipeDictQty(this, ${i}, 'inputs', ${j})" />
        <button onclick="removeSTRecipeDictRow(${i}, 'inputs', '${res}')">x</button>
      </div>`
    ).join('');

    const outputRows = Object.entries(r.outputs || {}).map(([res, qty], j) =>
      `<div class="ing-row">
        <input class="ing-res" value="${res}" oninput="updateSTRecipeDict(this, ${i}, 'outputs', ${j})" />
        <input class="ing-amt" type="number" value="${qty}" min="1" oninput="updateSTRecipeDictQty(this, ${i}, 'outputs', ${j})" />
        <button onclick="removeSTRecipeDictRow(${i}, 'outputs', '${res}')">x</button>
      </div>`
    ).join('');

    card.innerHTML = `
      <div class="recipe-card-header">
        <span>Recipe ${i + 1}</span>
        <button onclick="removeSTRecipe(${i})">x</button>
      </div>
      <div class="section-label">Inputs</div>
      <div id="stRecipeInputs_${i}">${inputRows}</div>
      <button class="btn-add-row" onclick="addSTRecipeDictRow(${i}, 'inputs')">+ Input</button>
      <div class="section-label">Outputs</div>
      <div id="stRecipeOutputs_${i}">${outputRows}</div>
      <button class="btn-add-row" onclick="addSTRecipeDictRow(${i}, 'outputs')">+ Output</button>
      <div class="form-row">
        <div class="form-group"><label>Fuel Cost</label>
          <input type="number" value="${r.fuel_cost ?? 0}" min="0" data-i="${i}" data-f="fuel_cost" onchange="updateSTRecipeScalar(this)" />
        </div>
        <div class="form-group"><label>Process Time (s)</label>
          <input type="number" value="${r.process_time ?? 5}" min="0.5" step="0.5" data-i="${i}" data-f="process_time" onchange="updateSTRecipeScalar(this)" />
        </div>
      </div>
    `;
    container.appendChild(card);
  }
}

function addSTRecipe() {
  selectedST.recipes = selectedST.recipes || [];
  selectedST.recipes.push({
    inputs: {},
    outputs: {},
    fuel_cost: 0,
    process_time: 5.0,
  });
  renderSTRecipes();
}

function removeSTRecipe(i) {
  selectedST.recipes.splice(i, 1);
  renderSTRecipes();
}

function updateSTRecipeScalar(el) {
  const i = Number(el.dataset.i);
  const f = el.dataset.f;
  selectedST.recipes[i][f] = Number(el.value);
}

function addSTRecipeDictRow(i, side) {
  if (!selectedST.recipes[i][side]) selectedST.recipes[i][side] = {};
  selectedST.recipes[i][side][''] = 1;
  renderSTRecipes();
}

function removeSTRecipeDictRow(i, side, res) {
  delete selectedST.recipes[i][side][res];
  renderSTRecipes();
}

function updateSTRecipeDict(el, i, side, j) {
  const dict = selectedST.recipes[i][side];
  const keys = Object.keys(dict);
  if (keys[j] !== undefined) {
    const oldKey = keys[j];
    const val = dict[oldKey];
    delete dict[oldKey];
    dict[el.value] = val;
  }
}

function updateSTRecipeDictQty(el, i, side, j) {
  const dict = selectedST.recipes[i][side];
  const keys = Object.keys(dict);
  if (keys[j] !== undefined) {
    dict[keys[j]] = Number(el.value);
  }
}

function gatherST() {
  updateSTBuildRecipe();
  return {
    id: document.getElementById('st_id').value.trim(),
    label: document.getElementById('st_label').value.trim(),
    sprite: {
      type: 'tilemap',
      tileCol: Number(document.getElementById('st_tileCol').value),
      tileRow: Number(document.getElementById('st_tileRow').value),
    },
    station_type: document.getElementById('st_stationType').value,
    speed_bonus: Number(document.getElementById('st_speedBonus').value),
    required_metallurgy: Number(document.getElementById('st_reqMetal').value),
    fuel_type: document.getElementById('st_fuelType').value,
    recipes: selectedST.recipes || [],
    build_recipe: selectedST.build_recipe || {},
  };
}

async function saveST() {
  const data = gatherST();
  try {
    await fetch('/api/assets/stations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    await loadAll();
    selectST(data);
    showFeedback('Saved!', 'success');
  } catch (e) {
    showFeedback('Save failed: ' + e.message, 'error');
  }
}

async function deleteST() {
  if (!selectedST?.id) return;
  if (!confirm(`Delete station "${selectedST.id}"?`)) return;
  await fetch(`/api/assets/stations/${selectedST.id}`, { method: 'DELETE' });
  selectedST = null;
  document.getElementById('stEditor').style.display = 'none';
  document.getElementById('emptyState').style.display = '';
  await loadAll();
}

// ── Tile Picker Modal ────────────────────────────────────────────────────────

const TILE_PX = 16;
const TILE_SPACING = 1;
const TILE_SLOT = TILE_PX + TILE_SPACING; // 17px per cell in the sheet
const TILE_COLS = 57;
let _tilePickerImg = null;
let _tilePickerCb = null;

function loadTileSheet() {
  if (_tilePickerImg) return Promise.resolve(_tilePickerImg);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => { _tilePickerImg = img; resolve(img); };
    img.src = '/static/Spritesheet/roguelikeSheet_transparent.png';
  });
}

async function openTilePicker(currentCol, currentRow, onPick) {
  const img = await loadTileSheet();
  _tilePickerCb = onPick;

  const overlay = document.createElement('div');
  overlay.className = 'tile-picker-overlay';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  const modal = document.createElement('div');
  modal.className = 'tile-picker-modal';

  const header = document.createElement('div');
  header.className = 'tile-picker-header';
  header.innerHTML = `<span>Click a tile to select — current: col ${currentCol}, row ${currentRow}</span>`;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'tile-picker-close';
  closeBtn.textContent = 'Close';
  closeBtn.onclick = () => overlay.remove();
  header.appendChild(closeBtn);

  const body = document.createElement('div');
  body.className = 'tile-picker-body';

  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = img.width * scale;
  canvas.height = img.height * scale;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  // Highlight current tile
  ctx.strokeStyle = '#66aaff';
  ctx.lineWidth = 2;
  ctx.strokeRect(currentCol * TILE_SLOT * scale, currentRow * TILE_SLOT * scale, TILE_PX * scale, TILE_PX * scale);

  canvas.onclick = (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    const col = Math.floor((e.clientX - rect.left) * sx / (TILE_SLOT * scale));
    const row = Math.floor((e.clientY - rect.top) * sy / (TILE_SLOT * scale));
    if (_tilePickerCb) _tilePickerCb(col, row);
    overlay.remove();
  };

  body.appendChild(canvas);
  modal.appendChild(header);
  modal.appendChild(body);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

function drawTilePreview(canvasId, col, row) {
  loadTileSheet().then((img) => {
    const c = document.getElementById(canvasId);
    if (!c) return;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(img, col * TILE_SLOT, row * TILE_SLOT, TILE_PX, TILE_PX, 0, 0, c.width, c.height);
  });
}

// ── Init ─────────────────────────────────────────────────────────────────────
loadAll();
