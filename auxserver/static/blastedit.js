// blastedit.js — Blast editor logic

const BLAST_SPRITES = [
  '001_blastoozarou','002_Blaster','003_Rocket','004_Bullet','005_blast14',
  '006_blast13','007_blast16','008_blast27','009_blast06','010_blast35',
  '011_blast28','012_blast20','013_blast23','014_blast08','015_blast09',
  '016_blast22','017_blast34','018_blast02','019_blast10','020_blast11',
  '021_blast03','022_blast04','023_blast33','024_blast05','025_blast01',
  '026_blast12','027_blast36','028_blast15','029_blast32','030_blast31',
  '031_blast18','032_blast30','033_blast17','034_blast24','035_blast25',
  '036_blast19','037_blast29','038_blast21','039_blast26','040_blast07',
];

const EFFECT_FIELDS = [
  // [group, key, label, min, max, step, isFloat]
  ['Movement', 'slow_pct',      'Slow %',              0, 100, 1,   false],
  ['Movement', 'slow_duration', 'Slow Duration (s)',    0, 10,  0.5, true],
  ['Movement', 'pushback',      'Pushback (px)',        0, 200, 8,   false],
  ['Movement', 'pull',          'Pull (px)',            0, 200, 8,   false],
  ['Movement', 'stun_duration', 'Stun Duration (s)',    0, 5,   0.5, true],
  ['Damage over Time', 'burn_dps',            'Burn DPS',              0, 20, 1,   false],
  ['Damage over Time', 'burn_duration',       'Burn Duration (s)',      0, 10, 0.5, true],
  ['Damage over Time', 'aftershock_dps',      'Aftershock DPS',        0, 20, 1,   false],
  ['Damage over Time', 'aftershock_radius',   'Aftershock Radius (px)',0, 300,16,  false],
  ['Damage over Time', 'aftershock_duration', 'Aftershock Duration (s)',0,10, 0.5, true],
  ['Damage over Time', 'decay_def',           'Decay DEF',             0, 20, 1,   false],
  ['Damage over Time', 'decay_duration',      'Decay Duration (s)',     0, 10, 0.5, true],
  ['Ki Effects', 'ki_drain',                 'Ki Drain',              0, 20, 1,   false],
  ['Ki Effects', 'ki_silence_duration',      'Ki Silence (s)',         0, 5,  0.5, true],
  ['Ki Effects', 'ki_regen_suppress_duration','Ki Regen Suppress (s)', 0, 10, 0.5, true],
  ['Utility',   'blind_duration',   'Blind Duration (s)', 0, 5,  0.5, true],
  ['Utility',   'expose_pct',       'Expose %',           0, 100,5,   false],
  ['Utility',   'expose_duration',  'Expose Duration (s)',0, 10, 0.5, true],
  ['Sustain',   'siphon_pct',       'Siphon %',           0, 100,5,   false],
  ['Sustain',   'vampiric_pct',     'Vampiric %',         0, 100,5,   false],
  ['Sustain',   'vampiric_duration','Vampiric Duration (s)',0,10,0.5, true],
];

const EFFECT_DEFAULTS = {};
for (const [,key,,min] of EFFECT_FIELDS) EFFECT_DEFAULTS[key] = min;

// State
let blastDefs = [];
let currentSprite = null;
let dirty = false;

function getDefBySprite(sprite) { return blastDefs.find(b => b.sprite === sprite) || null; }

async function loadDefs() {
  const r = await fetch('/api/blasts');
  blastDefs = await r.json();
}

async function saveDefs() {
  const r = await fetch('/api/blasts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blasts: blastDefs }),
  });
  const result = await r.json();
  if (result.ok) {
    dirty = false;
    updateDirtyIndicator();
    document.getElementById('status-msg').textContent = `Saved ${result.count} blast(s)`;
    setTimeout(() => { document.getElementById('status-msg').textContent = ''; }, 3000);
  }
}

function markDirty() {
  dirty = true;
  updateDirtyIndicator();
  document.getElementById('status-msg').textContent = '';
}

function updateDirtyIndicator() {
  document.getElementById('dirty-indicator').style.display = dirty ? 'inline' : 'none';
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function buildSidebar() {
  const sidebar = document.getElementById('sidebar');
  sidebar.innerHTML = '';
  for (const sprite of BLAST_SPRITES) {
    const thumb = document.createElement('div');
    thumb.className = 'sprite-thumb' + (getDefBySprite(sprite) ? ' configured' : ' dimmed');
    thumb.title = sprite;
    thumb.dataset.sprite = sprite;

    const c = document.createElement('canvas');
    c.width = 48; c.height = 48;
    thumb.appendChild(c);
    drawSpriteThumb(c, sprite);

    thumb.addEventListener('click', () => selectSprite(sprite));
    sidebar.appendChild(thumb);
  }
}

function refreshThumb(sprite) {
  const thumb = document.querySelector(`.sprite-thumb[data-sprite="${sprite}"]`);
  if (!thumb) return;
  const hasDef = !!getDefBySprite(sprite);
  thumb.classList.toggle('configured', hasDef);
  thumb.classList.toggle('dimmed', !hasDef);
}

const _imgCache = {};
function getSpriteImage(sprite) {
  if (_imgCache[sprite]) return _imgCache[sprite];
  const img = new Image();
  img.src = `/assets/BlastsAscended/${sprite}/${sprite}.png`;
  _imgCache[sprite] = img;
  return img;
}

const _jsonCache = {};
async function getSpriteJson(sprite) {
  if (_jsonCache[sprite]) return _jsonCache[sprite];
  const r = await fetch(`/assets/BlastsAscended/${sprite}/${sprite}.json`);
  const d = await r.json();
  _jsonCache[sprite] = d;
  return d;
}

function drawSpriteThumb(canvas, sprite) {
  const img = getSpriteImage(sprite);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const draw = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, 32, 32, 0, 0, canvas.width, canvas.height);
  };
  if (img.complete) draw();
  else img.onload = draw;
}

let _previewTimer = null;
let _previewFrameIdx = 0;

function stopPreview() {
  if (_previewTimer) { clearInterval(_previewTimer); _previewTimer = null; }
}

async function startPreview(sprite) {
  stopPreview();
  _previewFrameIdx = 0;
  const canvas = document.getElementById('preview-canvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const [img, def] = await Promise.all([
    new Promise(res => {
      const i = getSpriteImage(sprite);
      if (i.complete) res(i); else { i.onload = () => res(i); }
    }),
    getSpriteJson(sprite),
  ]);

  const fw = def.frameSize.width;
  const fh = def.frameSize.height;
  const cols = def.layout.columns;
  const dirs = def.stateInfo.dirs;
  const frames = def.stateInfo.frames;
  const fps = 4;

  const drawFrame = (frameInAnim) => {
    const globalIdx = dirs === 1 ? frameInAnim : frameInAnim * dirs;
    const srcX = (globalIdx % cols) * fw;
    const srcY = Math.floor(globalIdx / cols) * fh;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, srcX, srcY, fw, fh, 0, 0, canvas.width, canvas.height);
    // Apply tint overlay if set
    const def = getDefBySprite(currentSprite);
    const tint = def?.tint;
    if (tint && tint !== '#ffffff') {
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = tint;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'source-over';
    }
  };

  drawFrame(0);
  if (frames > 1) {
    _previewTimer = setInterval(() => {
      _previewFrameIdx = (_previewFrameIdx + 1) % frames;
      drawFrame(_previewFrameIdx);
    }, 1000 / fps);
  }
}

function buildEffectsUI() {
  const container = document.getElementById('effects-container');
  container.innerHTML = '';
  let currentGroup = null;

  for (const [group, key, label, min, max, step, isFloat] of EFFECT_FIELDS) {
    if (group !== currentGroup) {
      const gl = document.createElement('div');
      gl.className = 'group-label';
      gl.textContent = group;
      container.appendChild(gl);
      currentGroup = group;
    }
    const row = document.createElement('div');
    row.className = 'row';

    const lbl = document.createElement('label');
    lbl.textContent = label;
    row.appendChild(lbl);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = min; slider.max = max; slider.step = step;
    slider.id = `eff-${key}`;

    const numInput = document.createElement('input');
    numInput.type = 'number';
    numInput.min = min; numInput.max = max; numInput.step = step;
    numInput.style.width = '70px';
    numInput.id = `effn-${key}`;

    slider.addEventListener('input', () => {
      numInput.value = slider.value;
      commitEffectValue(key, isFloat ? parseFloat(slider.value) : parseInt(slider.value));
    });
    numInput.addEventListener('input', () => {
      slider.value = numInput.value;
      commitEffectValue(key, isFloat ? parseFloat(numInput.value) : parseInt(numInput.value));
    });

    row.appendChild(slider);
    row.appendChild(numInput);
    container.appendChild(row);
  }
}

function ensureDefExists() {
  if (!currentSprite) return null;
  let def = getDefBySprite(currentSprite);
  if (!def) {
    def = {
      id: slugify(document.getElementById('f-id').value || currentSprite.replace(/^\d+_/, '')),
      displayName: document.getElementById('f-displayName').value || currentSprite.replace(/^\d+_/, '').replace(/_/g, ' '),
      sprite: currentSprite,
      kiCost: parseInt(document.getElementById('f-kiCost').value) || 8,
      effects: { ...EFFECT_DEFAULTS },
    };
    blastDefs.push(def);
    refreshThumb(currentSprite);
    document.getElementById('delete-btn').style.display = 'inline-block';
  }
  return def;
}

function commitEffectValue(key, value) {
  const def = ensureDefExists();
  if (!def) return;
  def.effects[key] = value;
  markDirty();
}

function loadDefIntoForm(def) {
  document.getElementById('f-displayName').value = def.displayName || '';
  document.getElementById('f-id').value = def.id || '';
  document.getElementById('f-kiCost').value = def.kiCost || 8;
  const tint = def.tint || null;
  const tintInput = document.getElementById('f-tint');
  const tintHex = document.getElementById('f-tint-hex');
  if (tint) {
    tintInput.value = tint;
    tintHex.textContent = tint;
  } else {
    tintInput.value = '#ffffff';
    tintHex.textContent = 'none';
  }
  for (const [,key,,min] of EFFECT_FIELDS) {
    const v = (def.effects || {})[key] ?? min;
    const slider = document.getElementById(`eff-${key}`);
    const num = document.getElementById(`effn-${key}`);
    if (slider) slider.value = v;
    if (num) num.value = v;
  }
}

function selectSprite(sprite) {
  currentSprite = sprite;
  document.querySelectorAll('.sprite-thumb').forEach(t => t.classList.remove('selected'));
  const thumb = document.querySelector(`.sprite-thumb[data-sprite="${sprite}"]`);
  if (thumb) thumb.classList.add('selected');

  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('editor').style.display = 'block';
  document.getElementById('sprite-name').textContent = sprite;

  const existing = getDefBySprite(sprite);
  const def = existing || {
    id: slugify(sprite.replace(/^\d+_/, '')),
    displayName: sprite.replace(/^\d+_/, '').replace(/_/g, ' '),
    sprite,
    kiCost: 8,
    effects: { ...EFFECT_DEFAULTS },
  };
  // Only show Remove button for sprites that already have a saved definition
  document.getElementById('delete-btn').style.display = existing ? 'inline-block' : 'none';

  loadDefIntoForm(def);
  startPreview(sprite);
}

function deleteCurrentBlast() {
  if (!currentSprite) return;
  blastDefs = blastDefs.filter(d => d.sprite !== currentSprite);
  refreshThumb(currentSprite);
  document.getElementById('delete-btn').style.display = 'none';
  markDirty();
}

function wireIdentityInputs() {
  document.getElementById('f-displayName').addEventListener('input', e => {
    const def = ensureDefExists();
    if (!def) return;
    def.displayName = e.target.value;
    const idField = document.getElementById('f-id');
    idField.value = slugify(e.target.value);
    def.id = idField.value;
    markDirty();
  });
  document.getElementById('f-id').addEventListener('input', e => {
    const def = ensureDefExists();
    if (!def) return;
    def.id = e.target.value;
    markDirty();
  });
  document.getElementById('f-kiCost').addEventListener('input', e => {
    const def = ensureDefExists();
    if (!def) return;
    def.kiCost = parseInt(e.target.value) || 8;
    markDirty();
  });
  document.getElementById('f-tint').addEventListener('input', e => {
    const def = ensureDefExists();
    if (!def) return;
    def.tint = e.target.value;
    document.getElementById('f-tint-hex').textContent = e.target.value;
    markDirty();
  });
  document.getElementById('f-tint-clear').addEventListener('click', () => {
    const def = ensureDefExists();
    if (!def) return;
    delete def.tint;
    document.getElementById('f-tint').value = '#ffffff';
    document.getElementById('f-tint-hex').textContent = 'none';
    markDirty();
  });
  document.getElementById('save-btn').addEventListener('click', saveDefs);
  document.getElementById('delete-btn').addEventListener('click', deleteCurrentBlast);
}

async function init() {
  await loadDefs();
  buildEffectsUI();
  buildSidebar();
  wireIdentityInputs();
}

init();
