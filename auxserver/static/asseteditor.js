/* Asset Editor — client-side logic for /asseteditor */

let currentTab = 'wo';
let worldObjects = [];
let equipment = [];
let items = [];
let selectedWO = null;
let selectedEQ = null;
let selectedIT = null;

// ── Tab switching ────────────────────────────────────────────────────────────

function switchTab(tab) {
  currentTab = tab;
  document.getElementById('tabWO').classList.toggle('active', tab === 'wo');
  document.getElementById('tabEQ').classList.toggle('active', tab === 'eq');
  document.getElementById('tabIT').classList.toggle('active', tab === 'it');
  document.getElementById('woSidebar').style.display = tab === 'wo' ? '' : 'none';
  document.getElementById('eqSidebar').style.display = tab === 'eq' ? '' : 'none';
  document.getElementById('itSidebar').style.display = tab === 'it' ? '' : 'none';
  document.getElementById('woEditor').style.display = 'none';
  document.getElementById('eqEditor').style.display = 'none';
  document.getElementById('itEditor').style.display = 'none';
  document.getElementById('emptyState').style.display = '';
  selectedWO = null;
  selectedEQ = null;
  selectedIT = null;
}

// ── Data loading ─────────────────────────────────────────────────────────────

async function loadAll() {
  const [woResp, eqResp, itResp] = await Promise.all([
    fetch('/api/assets/world-objects'),
    fetch('/api/assets/equipment'),
    fetch('/api/assets/items'),
  ]);
  worldObjects = await woResp.json();
  equipment = await eqResp.json();
  items = await itResp.json();
  renderWOList();
  renderEQList();
  renderITList();
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
  await fetch('/api/assets/world-objects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  await loadAll();
  selectWO(data);
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
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('woEditor').style.display = 'none';
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
      <div class="form-group"><label>Sprite Sheet (filename)</label><input id="eq_spriteSheet" value="${eq.spriteSheet || ''}" /></div>
      <div class="form-group"><label>Slot</label>
        <select id="eq_slot">
          <option value="chest" ${eq.slot === 'chest' ? 'selected' : ''}>Chest</option>
          <option value="head" ${eq.slot === 'head' ? 'selected' : ''}>Head</option>
          <option value="legs" ${eq.slot === 'legs' ? 'selected' : ''}>Legs</option>
          <option value="weapon" ${eq.slot === 'weapon' ? 'selected' : ''}>Weapon</option>
        </select>
      </div>
    </div>

    <div class="form-row">
      <div class="form-group"><label>Frame Width</label><input type="number" id="eq_frameW" value="${eq.frameSize?.width ?? 32}" /></div>
      <div class="form-group"><label>Frame Height</label><input type="number" id="eq_frameH" value="${eq.frameSize?.height ?? 32}" /></div>
      <div class="form-group"><label>Total Frames</label><input type="number" id="eq_totalFrames" value="${eq.totalFrames ?? 1}" /></div>
    </div>

    <div class="section-header">Stats</div>
    <div class="form-row">
      <div class="form-group"><label>STR Bonus</label><input type="number" id="eq_strBonus" value="${stats.str_bonus ?? 0}" /></div>
      <div class="form-group"><label>DEF Bonus</label><input type="number" id="eq_defBonus" value="${stats.def_bonus ?? 0}" /></div>
      <div class="form-group"><label>HP Bonus</label><input type="number" id="eq_hpBonus" value="${stats.hp_bonus ?? 0}" /></div>
      <div class="form-group"><label>Dmg Reduction %</label><input type="number" id="eq_dmgRed" value="${stats.dmg_reduction_pct ?? 0}" step="0.1" /></div>
    </div>

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

    <div class="section-header">Named Frames</div>
    <div class="form-group">
      <label>JSON (frame_index: anim_name)</label>
      <textarea id="eq_namedFrames" rows="6">${JSON.stringify(eq.namedFrames || {}, null, 2)}</textarea>
    </div>

    <div style="margin-top:20px;">
      <button class="btn-save" onclick="saveEQ()">Save</button>
      <button class="btn-delete" onclick="deleteEQ()">Delete</button>
    </div>
  `;
  renderEQIngredients();
}

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
  // Re-gather all ingredients from DOM
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

function gatherEQ() {
  // Re-gather ingredients from DOM
  updateEQIngredient(null);
  let namedFrames = {};
  try { namedFrames = JSON.parse(document.getElementById('eq_namedFrames').value); } catch (e) { /* keep existing */ }

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
    namedFrames,
    sourceTemplate: 'baseplayer',
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
    },
  };
}

async function saveEQ() {
  const data = gatherEQ();
  await fetch('/api/assets/equipment', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  await loadAll();
  selectEQ(data);
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
    id, label: id.charAt(0).toUpperCase() + id.slice(1),
    category: 'resource',
    sprite: { type: 'tilemap', tileCol: 0, tileRow: 0 },
    stackable: true, maxStack: 99,
    color: '#cccccc', description: '',
  };
  selectIT(it);
}

function selectIT(it) {
  selectedIT = JSON.parse(JSON.stringify(it));
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('woEditor').style.display = 'none';
  document.getElementById('eqEditor').style.display = 'none';
  const el = document.getElementById('itEditor');
  el.style.display = '';
  renderITEditor();
  renderITList();
}

function renderITEditor() {
  const it = selectedIT;
  if (!it) return;
  const el = document.getElementById('itEditor');
  el.innerHTML = `
    <h3 style="color:#66aaff;margin-bottom:12px;">Item: ${it.id}</h3>

    <div class="form-row">
      <div class="form-group"><label>ID</label><input id="it_id" value="${it.id}" /></div>
      <div class="form-group"><label>Label</label><input id="it_label" value="${it.label || ''}" /></div>
    </div>

    <div class="form-row">
      <div class="form-group"><label>Category</label>
        <select id="it_category">
          <option value="resource" ${it.category === 'resource' ? 'selected' : ''}>Resource</option>
          <option value="consumable" ${it.category === 'consumable' ? 'selected' : ''}>Consumable</option>
          <option value="quest" ${it.category === 'quest' ? 'selected' : ''}>Quest</option>
          <option value="material" ${it.category === 'material' ? 'selected' : ''}>Material</option>
        </select>
      </div>
      <div class="form-group"><label>Color</label><input type="color" id="it_color" value="${it.color || '#cccccc'}" /></div>
    </div>

    <div class="section-header">Sprite</div>
    <div class="form-row">
      <div class="form-group"><label>Type</label>
        <select id="it_spriteType" onchange="toggleItemSpriteInputs()">
          <option value="tilemap" ${it.sprite?.type === 'tilemap' ? 'selected' : ''}>Tilemap</option>
          <option value="png" ${it.sprite?.type === 'png' ? 'selected' : ''}>Custom PNG</option>
        </select>
      </div>
      <div class="form-group" id="it_tileColGroup"><label>Tile Col</label><input type="number" id="it_tileCol" value="${it.sprite?.tileCol ?? 0}" onchange="drawTilePreview('it_tilePreview', Number(this.value), Number(document.getElementById('it_tileRow').value))" /></div>
      <div class="form-group" id="it_tileRowGroup"><label>Tile Row</label><input type="number" id="it_tileRow" value="${it.sprite?.tileRow ?? 0}" onchange="drawTilePreview('it_tilePreview', Number(document.getElementById('it_tileCol').value), Number(this.value))" /></div>
      <div class="form-group"><label>Preview</label>
        <div style="display:flex;align-items:center;">
          <canvas id="it_tilePreview" class="tile-preview" width="48" height="48"></canvas>
          <button type="button" class="btn-pick-tile" id="it_pickTileBtn" onclick="openTilePicker(
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
    <div class="form-group" id="it_pngGroup" style="display:none;">
      <label>PNG file</label>
      <input type="text" id="it_png" value="${it.sprite?.png || ''}" placeholder="filename.png" />
      <input type="file" id="it_pngUpload" accept="image/png" style="margin-top:4px;" onchange="uploadItemSprite()" />
    </div>

    <div class="section-header">Properties</div>
    <div class="form-row">
      <div class="form-group"><label>Stackable</label>
        <select id="it_stackable">
          <option value="true" ${it.stackable !== false ? 'selected' : ''}>Yes</option>
          <option value="false" ${it.stackable === false ? 'selected' : ''}>No</option>
        </select>
      </div>
      <div class="form-group"><label>Max Stack</label><input type="number" id="it_maxStack" value="${it.maxStack ?? 99}" min="1" /></div>
    </div>

    <div class="form-group"><label>Description</label><textarea id="it_description" rows="2">${it.description || ''}</textarea></div>

    <div style="margin-top:20px;">
      <button class="btn-save" onclick="saveIT()">Save</button>
      <button class="btn-delete" onclick="deleteIT()">Delete</button>
    </div>
  `;
  toggleItemSpriteInputs();
  if (it.sprite?.type === 'tilemap') {
    drawTilePreview('it_tilePreview', it.sprite?.tileCol ?? 0, it.sprite?.tileRow ?? 0);
  }
}

function toggleItemSpriteInputs() {
  const type = document.getElementById('it_spriteType')?.value;
  const isTilemap = type === 'tilemap';
  document.getElementById('it_tileColGroup').style.display = isTilemap ? '' : 'none';
  document.getElementById('it_tileRowGroup').style.display = isTilemap ? '' : 'none';
  const pickBtn = document.getElementById('it_pickTileBtn');
  if (pickBtn) pickBtn.style.display = isTilemap ? '' : 'none';
  document.getElementById('it_pngGroup').style.display = isTilemap ? 'none' : '';
}

function gatherIT() {
  const spriteType = document.getElementById('it_spriteType').value;
  const sprite = { type: spriteType };
  if (spriteType === 'tilemap') {
    sprite.tileCol = Number(document.getElementById('it_tileCol').value);
    sprite.tileRow = Number(document.getElementById('it_tileRow').value);
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
    color: document.getElementById('it_color').value,
    description: document.getElementById('it_description').value.trim(),
  };
}

async function saveIT() {
  const data = gatherIT();
  await fetch('/api/assets/items', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  await loadAll();
  selectIT(data);
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
    document.getElementById('it_png').value = fileInput.files[0].name;
  }
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
