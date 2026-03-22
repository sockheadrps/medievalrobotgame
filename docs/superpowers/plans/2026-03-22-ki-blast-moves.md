# Ki Blast Moves System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add named, effect-bearing ki blast moves — blast editor GUI, effect system, hotbar slot, proximity learning, and geode crystal drops.

**Architecture:** A single `blast_moves.json` file defines all blasts. The server loads it into `BLAST_DEFS` at startup and applies effects on hit. Client fetches defs in preload and uses `blast_id` from the FX event payload to render the correct sprite. Status effects live as timestamp fields on entity dicts; `_tick_status_effects()` in `GameState` drives DoTs.

**Tech Stack:** FastAPI (blast editor routes), Python (server effect logic), Phaser 3 (client sprite loading and hotbar UI), Jinja2 templates (editor page), vanilla JS for editor.

**Spec:** `docs/superpowers/specs/2026-03-22-ki-blast-moves-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `auxserver/data/blast_moves.json` | Create | Blast definitions source of truth |
| `auxserver/templates/blastedit.html` | Create | Blast editor page (served by Jinja2) |
| `auxserver/static/blastedit.js` | Create | Blast editor logic |
| `auxserver/api/admin.py` | Modify | `/blasts` + `/api/blasts` GET/POST routes |
| `auxserver/main.py` | Modify | Register admin router (already registered; no new import needed) |
| `auxserver/services/combat_ki.py` | Modify | Load `BLAST_DEFS`, apply effects in all hit paths, proximity learning, `blast_id` in FX |
| `auxserver/services/combat_utils.py` | Modify | Add `blast_id` to `_queue_ki_blast_fx` payload |
| `auxserver/services/game_state.py` | Modify | `aftershock_zones`, `_tick_status_effects()`, slow/stun/displaced in move handler, ki silence gate, ki regen suppress check |
| `auxserver/services/player_manager.py` | Modify | Add `active_blast_id`, `learned_blasts`, `last_blast_observe_at` to `add_player` |
| `auxserver/services/database.py` | Modify | Save/load `active_blast_id`, `learned_blasts` in `state_json` |
| `auxserver/services/input_handler.py` | Modify | Handle `set_active_blast` and `use_blast_crystal` |
| `auxserver/services/npc_manager.py` | Modify | Add blast fields to NPC state, set `active_blast_id` to most-recently-learned |
| `auxserver/services/mine_state.py` | Modify | Add `blast_crystal` as secondary geode drop |
| `auxserver/services/cave_mining.py` | Modify | Award `blast_crystal` to player inventory from geode mine drop |
| `src/constants.js` | Modify | Add blast sprite keys for all 40 variants |
| `src/scenes/GameScene.js` | Modify | Synchronous XHR fetch of blast defs in `preload()`, queue all 40 spritesheet loads |
| `src/systems/CombatFxController.js` | Modify | Use `blast_id` for sprite selection on fire + replicated FX events |
| `src/ui/InventoryController.js` | Modify | Add blast hotbar slot with right-click picker popup |

---

## Task 1: Create `blast_moves.json` with starter blasts

**Files:**
- Create: `auxserver/data/blast_moves.json`

- [ ] **Step 1: Create the data file with 3 starter blasts**

```json
[
  {
    "id": "standard_shot",
    "displayName": "Standard Shot",
    "sprite": "001_blastoozarou",
    "kiCost": 8,
    "effects": {
      "slow_pct": 0, "slow_duration": 0,
      "burn_dps": 0, "burn_duration": 0,
      "blind_duration": 0,
      "pushback": 0, "pull": 0,
      "siphon_pct": 0,
      "ki_drain": 0,
      "ki_silence_duration": 0,
      "expose_pct": 0, "expose_duration": 0,
      "stun_duration": 0,
      "ki_regen_suppress_duration": 0,
      "vampiric_pct": 0, "vampiric_duration": 0,
      "aftershock_dps": 0, "aftershock_radius": 0, "aftershock_duration": 0,
      "decay_def": 0, "decay_duration": 0
    }
  },
  {
    "id": "glacial_spike",
    "displayName": "Glacial Spike",
    "sprite": "003_Rocket",
    "kiCost": 10,
    "effects": {
      "slow_pct": 60, "slow_duration": 3.0,
      "burn_dps": 0, "burn_duration": 0,
      "blind_duration": 0,
      "pushback": 0, "pull": 0,
      "siphon_pct": 0,
      "ki_drain": 0,
      "ki_silence_duration": 0,
      "expose_pct": 0, "expose_duration": 0,
      "stun_duration": 0,
      "ki_regen_suppress_duration": 0,
      "vampiric_pct": 0, "vampiric_duration": 0,
      "aftershock_dps": 0, "aftershock_radius": 0, "aftershock_duration": 0,
      "decay_def": 0, "decay_duration": 0
    }
  },
  {
    "id": "inferno_burst",
    "displayName": "Inferno Burst",
    "sprite": "009_blast06",
    "kiCost": 12,
    "effects": {
      "slow_pct": 0, "slow_duration": 0,
      "burn_dps": 4, "burn_duration": 3.0,
      "blind_duration": 0,
      "pushback": 64, "pull": 0,
      "siphon_pct": 0,
      "ki_drain": 0,
      "ki_silence_duration": 0,
      "expose_pct": 0, "expose_duration": 0,
      "stun_duration": 0,
      "ki_regen_suppress_duration": 0,
      "vampiric_pct": 0, "vampiric_duration": 0,
      "aftershock_dps": 0, "aftershock_radius": 0, "aftershock_duration": 0,
      "decay_def": 0, "decay_duration": 0
    }
  }
]
```

- [ ] **Step 2: Verify file is valid JSON**

```bash
cd auxserver && node -e "JSON.parse(require('fs').readFileSync('data/blast_moves.json','utf8')); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add auxserver/data/blast_moves.json
git commit -m "feat: add blast_moves.json with 3 starter blasts"
```

---

## Task 2: Blast editor backend routes

**Files:**
- Modify: `auxserver/api/admin.py`

The admin router is already registered in `main.py` (`app.include_router(admin_router)`). Just add routes to `admin.py`.

- [ ] **Step 1: Add the blast editor routes to `auxserver/api/admin.py`**

Add these imports at top of admin.py (after existing imports):
```python
from pathlib import Path as _Path
```

Add these routes after the existing admin routes (before the end of the file):

```python
_BLAST_MOVES_PATH = _Path(__file__).resolve().parent.parent / "data" / "blast_moves.json"


@router.get("/blasts", response_class=HTMLResponse)
async def blast_editor(request: Request):
    return templates.TemplateResponse("blastedit.html", {"request": request})


@router.get("/api/blasts")
async def get_blasts():
    import json as _json
    try:
        return _json.loads(_BLAST_MOVES_PATH.read_text(encoding="utf-8"))
    except Exception as e:
        logger.warning("Failed to read blast_moves.json: %s", e)
        return []


class BlastSaveBody(BaseModel):
    blasts: list


@router.post("/api/blasts")
async def save_blasts(body: BlastSaveBody):
    import json as _json
    try:
        _BLAST_MOVES_PATH.write_text(
            _json.dumps(body.blasts, indent=2, ensure_ascii=False),
            encoding="utf-8"
        )
        # Reload in-memory BLAST_DEFS so changes take effect without restart
        try:
            from services.combat_ki import reload_blast_defs
            reload_blast_defs()
        except Exception:
            pass
        return {"ok": True, "count": len(body.blasts)}
    except Exception as e:
        logger.warning("Failed to write blast_moves.json: %s", e)
        return {"ok": False, "error": str(e)}
```

- [ ] **Step 2: Start server and verify route exists**

```bash
cd auxserver && uvicorn main:app --reload --port 8000
```

Visit `http://localhost:8000/blasts` — should get a template error (template doesn't exist yet) not a 404. Visit `http://localhost:8000/api/blasts` — should return the JSON array.

- [ ] **Step 3: Commit**

```bash
git add auxserver/api/admin.py
git commit -m "feat: add /blasts and /api/blasts routes to admin"
```

---

## Task 3: Blast editor frontend — `blastedit.html` and `blastedit.js`

**Files:**
- Create: `auxserver/templates/blastedit.html`
- Create: `auxserver/static/blastedit.js`

The editor has a left sidebar (40 sprite thumbnails), a main panel (sprite preview canvas + identity + effects), and a save bar.

- [ ] **Step 1: Create `auxserver/templates/blastedit.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Blast Editor</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { display: flex; flex-direction: column; height: 100vh; background: #1a1a2e; color: #eee; font-family: sans-serif; font-size: 13px; }
    #header { padding: 8px 16px; background: #16213e; font-size: 16px; font-weight: bold; border-bottom: 1px solid #333; display: flex; align-items: center; gap: 16px; }
    #main { display: flex; flex: 1; overflow: hidden; }
    #sidebar { width: 200px; overflow-y: auto; background: #12121e; border-right: 1px solid #333; padding: 8px; display: flex; flex-wrap: wrap; gap: 4px; align-content: flex-start; }
    .sprite-thumb { width: 56px; height: 56px; cursor: pointer; border: 2px solid #333; border-radius: 4px; background: #1a1a2e; display: flex; align-items: center; justify-content: center; overflow: hidden; position: relative; }
    .sprite-thumb:hover { border-color: #4fd6ff; }
    .sprite-thumb.selected { border-color: #ffd700; }
    .sprite-thumb.configured::after { content: '✓'; position: absolute; top: 2px; right: 4px; font-size: 10px; color: #4dff88; }
    .sprite-thumb.dimmed { opacity: 0.4; }
    .sprite-thumb canvas { image-rendering: pixelated; }
    #panel { flex: 1; overflow-y: auto; padding: 16px; }
    #empty-state { text-align: center; margin-top: 80px; color: #666; }
    #editor { display: none; }
    .section { margin-bottom: 20px; }
    .section h3 { color: #4fd6ff; margin-bottom: 8px; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; }
    .preview-wrap { display: flex; justify-content: center; margin-bottom: 12px; }
    #preview-canvas { border: 1px solid #333; background: #111; image-rendering: pixelated; }
    .row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .row label { width: 180px; flex-shrink: 0; color: #aaa; }
    .row input[type=text], .row input[type=number] { width: 100px; background: #222; border: 1px solid #444; color: #eee; padding: 3px 6px; border-radius: 3px; }
    .row input[type=range] { width: 120px; }
    .row .val { width: 48px; text-align: right; color: #ffd700; }
    .group-label { background: #1e1e3a; padding: 4px 8px; border-radius: 3px; color: #888; font-size: 11px; margin: 8px 0 4px; text-transform: uppercase; letter-spacing: 0.5px; }
    #save-bar { padding: 10px 16px; background: #16213e; border-top: 1px solid #333; display: flex; align-items: center; gap: 12px; }
    #save-btn { background: #4fd6ff; color: #000; border: none; padding: 6px 20px; border-radius: 4px; cursor: pointer; font-weight: bold; }
    #save-btn:hover { background: #7fe8ff; }
    #dirty-indicator { color: #ffa040; display: none; }
    #status-msg { color: #4dff88; font-size: 12px; }
  </style>
</head>
<body>
  <div id="header">
    🔥 Blast Editor
    <span style="color:#666;font-size:12px">Click a sprite in the sidebar to configure it as a blast move</span>
  </div>
  <div id="main">
    <div id="sidebar" title="Click to select a blast sprite"></div>
    <div id="panel">
      <div id="empty-state">Select a blast sprite from the sidebar to begin.</div>
      <div id="editor">
        <div class="section">
          <div class="preview-wrap"><canvas id="preview-canvas" width="96" height="96"></canvas></div>
          <div class="row"><label>Sprite</label><span id="sprite-name" style="color:#ffd700"></span></div>
        </div>
        <div class="section">
          <h3>Identity</h3>
          <div class="row"><label>Display Name</label><input type="text" id="f-displayName" placeholder="My Blast"></div>
          <div class="row"><label>ID (slug)</label><input type="text" id="f-id" placeholder="my_blast"></div>
          <div class="row"><label>Ki Cost</label><input type="number" id="f-kiCost" min="1" max="50" value="8" style="width:70px"></div>
        </div>
        <div class="section">
          <h3>Effects</h3>
          <div class="group-label">Movement</div>
          <!-- sliders injected by JS -->
          <div id="effects-container"></div>
        </div>
        <div style="height:40px"></div>
      </div>
    </div>
  </div>
  <div id="save-bar">
    <button id="save-btn">Save All</button>
    <span id="dirty-indicator">● Unsaved changes</span>
    <span id="status-msg"></span>
  </div>
  <script src="/static/blastedit.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `auxserver/static/blastedit.js`**

```javascript
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
let blastDefs = [];   // loaded from server
let currentSprite = null;  // currently selected sprite name
let dirty = false;

// Indexed lookup: sprite -> blast def
function getDefBySprite(sprite) { return blastDefs.find(b => b.sprite === sprite) || null; }
function getDefById(id) { return blastDefs.find(b => b.id === id) || null; }

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

// Slugify display name to id
function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// Build sidebar thumbnails
function buildSidebar() {
  const sidebar = document.getElementById('sidebar');
  sidebar.innerHTML = '';
  for (const sprite of BLAST_SPRITES) {
    const thumb = document.createElement('div');
    thumb.className = 'sprite-thumb' + (getDefBySprite(sprite) ? ' configured' : ' dimmed');
    thumb.title = sprite;
    thumb.dataset.sprite = sprite;

    // Draw first frame thumbnail
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
    // Draw frame 0 (down direction for 4/8-dir, or frame 0 for omni)
    const fw = 32, fh = 32;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, fw, fh, 0, 0, canvas.width, canvas.height);
  };
  if (img.complete) draw();
  else img.onload = draw;
}

// Animated preview
let _previewTimer = null;
let _previewFrameIdx = 0;
let _previewDef = null;

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
  _previewDef = def;

  const fw = def.frameSize.width;
  const fh = def.frameSize.height;
  const cols = def.layout.columns;
  const dirs = def.stateInfo.dirs;
  const frames = def.stateInfo.frames;
  const fps = 4;

  // For dirs=4 or dirs=8: cycle through frames for "down" direction (frame 0 = down)
  // For dirs=1: cycle all frames
  const totalFrames = dirs === 1 ? frames : frames;
  const dirOffset = 0; // always use "down" (index 0 * frames)

  const drawFrame = (frameInAnim) => {
    const globalIdx = dirs === 1 ? frameInAnim : dirOffset + frameInAnim * dirs;
    const srcX = (globalIdx % cols) * fw;
    const srcY = Math.floor(globalIdx / cols) * fh;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, srcX, srcY, fw, fh, 0, 0, canvas.width, canvas.height);
  };

  drawFrame(0);
  if (totalFrames > 1) {
    _previewTimer = setInterval(() => {
      _previewFrameIdx = (_previewFrameIdx + 1) % totalFrames;
      drawFrame(_previewFrameIdx);
    }, 1000 / fps);
  }
}

// Build the effects sliders
function buildEffectsUI() {
  const container = document.getElementById('effects-container');
  container.innerHTML = '';
  let currentGroup = null;

  for (const [group, key, label, min, max, step, isFloat] of EFFECT_FIELDS) {
    if (group !== currentGroup) {
      if (currentGroup !== null) {
        // Add group label for next group
      }
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
    slider.dataset.key = key;
    slider.id = `eff-${key}`;

    const numInput = document.createElement('input');
    numInput.type = 'number';
    numInput.min = min; numInput.max = max; numInput.step = step;
    numInput.style.width = '70px';
    numInput.dataset.key = key;
    numInput.id = `effn-${key}`;

    // Sync
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

function commitEffectValue(key, value) {
  if (!currentSprite) return;
  let def = getDefBySprite(currentSprite);
  if (!def) return;
  def.effects[key] = value;
  markDirty();
}

function loadDefIntoForm(def) {
  document.getElementById('f-displayName').value = def.displayName || '';
  document.getElementById('f-id').value = def.id || '';
  document.getElementById('f-kiCost').value = def.kiCost || 8;
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

  let def = getDefBySprite(sprite);
  if (!def) {
    // Create new def for this sprite
    def = {
      id: slugify(sprite.replace(/^\d+_/, '')),
      displayName: sprite.replace(/^\d+_/, '').replace(/_/g, ' '),
      sprite,
      kiCost: 8,
      effects: { ...EFFECT_DEFAULTS },
    };
    blastDefs.push(def);
    markDirty();
    refreshThumb(sprite);
  }

  loadDefIntoForm(def);
  startPreview(sprite);
}

// Wire up identity inputs
function wireIdentityInputs() {
  document.getElementById('f-displayName').addEventListener('input', e => {
    if (!currentSprite) return;
    const def = getDefBySprite(currentSprite);
    if (!def) return;
    def.displayName = e.target.value;
    // Auto-update slug if id hasn't been manually edited
    const idField = document.getElementById('f-id');
    idField.value = slugify(e.target.value);
    def.id = idField.value;
    markDirty();
  });
  document.getElementById('f-id').addEventListener('input', e => {
    if (!currentSprite) return;
    const def = getDefBySprite(currentSprite);
    if (!def) return;
    def.id = e.target.value;
    markDirty();
  });
  document.getElementById('f-kiCost').addEventListener('input', e => {
    if (!currentSprite) return;
    const def = getDefBySprite(currentSprite);
    if (!def) return;
    def.kiCost = parseInt(e.target.value) || 8;
    markDirty();
  });
  document.getElementById('save-btn').addEventListener('click', saveDefs);
}

async function init() {
  await loadDefs();
  buildEffectsUI();
  buildSidebar();
  wireIdentityInputs();
}

init();
```

- [ ] **Step 3: Test the editor in browser**

Start server, visit `http://localhost:8000/blasts`. Click a sprite in sidebar. Verify:
- Preview canvas animates
- Sliders exist grouped by category
- Changing a slider marks as dirty
- Save button writes to `blast_moves.json` and shows "Saved N blast(s)"

- [ ] **Step 4: Commit**

```bash
git add auxserver/templates/blastedit.html auxserver/static/blastedit.js
git commit -m "feat: blast editor web GUI with animated preview and effect sliders"
```

---

## Task 4: Load `BLAST_DEFS` in `combat_ki.py` + `reload_blast_defs()`

**Files:**
- Modify: `auxserver/services/combat_ki.py`

- [ ] **Step 1: Add `BLAST_DEFS` module-level dict and loader at top of `combat_ki.py`**

After the existing imports (after `from services.combat_utils import CombatUtilsMixin`), add:

```python
import json as _json
from pathlib import Path as _Path

_BLAST_MOVES_PATH = _Path(__file__).resolve().parent.parent / "data" / "blast_moves.json"
BLAST_DEFS: dict = {}


def _load_blast_defs():
    global BLAST_DEFS
    try:
        raw = _json.loads(_BLAST_MOVES_PATH.read_text(encoding="utf-8"))
        BLAST_DEFS = {b["id"]: b for b in raw if "id" in b}
        logger.info("Loaded %d blast definitions", len(BLAST_DEFS))
    except Exception as e:
        logger.warning("Failed to load blast_moves.json: %s", e)
        BLAST_DEFS = {}


def reload_blast_defs():
    """Called by admin API after saving blast_moves.json."""
    _load_blast_defs()


_load_blast_defs()
```

- [ ] **Step 2: Verify server starts without error**

Check server logs: `Loaded N blast definitions` should appear. No import errors.

- [ ] **Step 3: Commit**

```bash
git add auxserver/services/combat_ki.py
git commit -m "feat: load BLAST_DEFS from blast_moves.json at startup"
```

---

## Task 5: Add `blast_id` to `_queue_ki_blast_fx` payload

**Files:**
- Modify: `auxserver/services/combat_utils.py`

- [ ] **Step 1: Update `_queue_ki_blast_fx` to accept and emit `blast_id`**

Find the `_queue_ki_blast_fx` method (line 108). Change signature and payload:

```python
def _queue_ki_blast_fx(self, actor, target=None, owner_pid=None, npc_id=None, blast_id=None):
    if not actor:
        return
    start_x, start_y, impact_x, impact_y = self._compute_blast_visual_impact(actor, target)
    self.gs.fx_events.append({
        "kind": "ki_blast",
        "owner_pid": owner_pid,
        "npc_id": npc_id,
        "blast_id": blast_id or actor.get("active_blast_id"),
        "start_x": start_x,
        "start_y": start_y,
        "impact_x": impact_x,
        "impact_y": impact_y,
        "facing": actor.get("facing", "down"),
    })
```

- [ ] **Step 2: Update all callers of `_queue_ki_blast_fx` in `combat_ki.py` to not break**

The signature change adds `blast_id=None` as optional — existing calls still work because they use positional/keyword args that don't include `blast_id`. No caller changes needed at this step; the actor's `active_blast_id` will be read automatically.

- [ ] **Step 3: Commit**

```bash
git add auxserver/services/combat_utils.py
git commit -m "feat: add blast_id to ki blast FX event payload"
```

---

## Task 6: Add blast fields to player and NPC state

**Files:**
- Modify: `auxserver/services/player_manager.py`
- Modify: `auxserver/services/database.py`
- Modify: `auxserver/services/npc_manager.py`

- [ ] **Step 1: Add fields to `add_player()` in `player_manager.py`**

In `add_player`, after `"ki_moves": list(DEFAULT_KI_MOVES),` add:
```python
"active_blast_id": None,
"learned_blasts": [],
"last_blast_observe_at": 0.0,
```

- [ ] **Step 2: Add fields to `save_player` in `database.py`**

In the `state_json = json.dumps({...})` dict inside `save_player`, add:
```python
"active_blast_id": data.get("active_blast_id"),
"learned_blasts": data.get("learned_blasts", []),
```

- [ ] **Step 3: Add fields to `load_player` in `database.py`**

In the return dict of `load_player`, add:
```python
"active_blast_id": extra.get("active_blast_id"),
"learned_blasts": extra.get("learned_blasts", []),
"last_blast_observe_at": 0.0,
```

- [ ] **Step 4: Add blast fields to NPC state in `npc_manager.py`**

Find where NPC state dicts are initialized (look for `"has_ki_blast"` or similar NPC creation). Add to NPC state:
```python
"learned_blasts": [],
"active_blast_id": None,
"last_blast_observe_at": 0.0,
```

- [ ] **Step 5: Commit**

```bash
git add auxserver/services/player_manager.py auxserver/services/database.py auxserver/services/npc_manager.py
git commit -m "feat: add active_blast_id, learned_blasts fields to player and NPC state"
```

---

## Task 7: Input handler — `set_active_blast` and `use_blast_crystal`

**Files:**
- Modify: `auxserver/services/input_handler.py`

- [ ] **Step 1: Add handlers in `handle_input()`**

In the `elif msg_type == ...` chain, add (place near other ki-related handlers):

```python
elif msg_type == "set_active_blast":
    blast_id = data.get("blast_id")
    learned = p.get("learned_blasts", [])
    if blast_id in learned:
        p["active_blast_id"] = blast_id
    # Silently reject if not known

elif msg_type == "use_blast_crystal":
    inv = p.setdefault("inventory", {})
    if inv.get("blast_crystal", 0) < 1:
        return
    from services.combat_ki import BLAST_DEFS
    learned = p.setdefault("learned_blasts", [])
    unknown = [bid for bid in BLAST_DEFS if bid not in learned]
    if not unknown:
        # All blasts known — award ki XP instead
        gs.player_manager._grant_ki_skill_xp(p, 50)
        gs.fx_events.append({
            "type": "chat_hint", "pid": pid,
            "text": "You already know all blast techniques! You absorb the crystal's energy. (+50 Ki XP)"
        })
    else:
        import random as _random
        new_blast = _random.choice(unknown)
        learned.append(new_blast)
        blast_name = BLAST_DEFS[new_blast].get("displayName", new_blast)
        gs.fx_events.append({
            "type": "chat_hint", "pid": pid,
            "text": f"The crystal resonates with your ki! You learned: {blast_name}!"
        })
    inv["blast_crystal"] = inv.get("blast_crystal", 0) - 1
    if inv["blast_crystal"] <= 0:
        del inv["blast_crystal"]
```

- [ ] **Step 2: Verify with manual test**

Connect as a player, use browser devtools or a test script to send:
```json
{"type": "use_blast_crystal"}
```
Expected: no blast_crystal in inventory → nothing happens. Add blast_crystal via admin, then use → chat hint with blast name.

- [ ] **Step 3: Commit**

```bash
git add auxserver/services/input_handler.py
git commit -m "feat: handle set_active_blast and use_blast_crystal inputs"
```

---

## Task 8: Apply blast effects in all hit paths + proximity learning

**Files:**
- Modify: `auxserver/services/combat_ki.py`

This is the largest server task. Add `_apply_blast_effects()` helper and call it in each hit path.

- [ ] **Step 1: Add `_apply_blast_effects()` to `CombatKiService`**

Add this method to `CombatKiService` (after `_ki_blast_ground_item`):

```python
def _apply_blast_effects(self, attacker, target, final_dmg):
    """Apply active blast's effects to target. Called after damage is dealt."""
    blast_id = attacker.get("active_blast_id")
    if not blast_id or blast_id not in BLAST_DEFS:
        return
    effects = BLAST_DEFS[blast_id].get("effects", {})
    now = __import__("time").time()

    # ── Instant effects ────────────────────────────────────────────────────
    # Pushback
    pushback = effects.get("pushback", 0)
    if pushback > 0:
        dx = target.get("x", 0) - attacker.get("x", 0)
        dy = target.get("y", 0) - attacker.get("y", 0)
        d = max(1, (dx**2 + dy**2) ** 0.5)
        target["x"] = target.get("x", 0) + (dx / d) * pushback
        target["y"] = target.get("y", 0) + (dy / d) * pushback
        target["displaced_until"] = now + 0.3

    # Pull
    pull = effects.get("pull", 0)
    if pull > 0:
        dx = attacker.get("x", 0) - target.get("x", 0)
        dy = attacker.get("y", 0) - target.get("y", 0)
        d = max(1, (dx**2 + dy**2) ** 0.5)
        target["x"] = target.get("x", 0) + (dx / d) * pull
        target["y"] = target.get("y", 0) + (dy / d) * pull
        target["displaced_until"] = now + 0.3

    # Ki Drain
    ki_drain = effects.get("ki_drain", 0)
    if ki_drain > 0:
        target["ki"] = max(0, target.get("ki", 0) - ki_drain)

    # Siphon — instant heal on attacker
    siphon_pct = effects.get("siphon_pct", 0)
    if siphon_pct > 0 and final_dmg > 0:
        heal = final_dmg * siphon_pct / 100
        attacker["hp"] = min(attacker.get("maxHp", 20), attacker.get("hp", 0) + heal)

    # ── Duration effects ───────────────────────────────────────────────────
    slow_pct = effects.get("slow_pct", 0)
    slow_dur = effects.get("slow_duration", 0)
    if slow_pct > 0 and slow_dur > 0:
        target["slowed_until"] = now + slow_dur
        target["slow_pct"] = slow_pct

    stun_dur = effects.get("stun_duration", 0)
    if stun_dur > 0:
        target["stunned_until"] = now + stun_dur

    blind_dur = effects.get("blind_duration", 0)
    if blind_dur > 0:
        target["blinded_until"] = now + blind_dur

    ki_silence_dur = effects.get("ki_silence_duration", 0)
    if ki_silence_dur > 0:
        target["ki_silenced_until"] = now + ki_silence_dur

    expose_pct = effects.get("expose_pct", 0)
    expose_dur = effects.get("expose_duration", 0)
    if expose_pct > 0 and expose_dur > 0:
        target["exposed_until"] = now + expose_dur
        target["exposed_pct"] = expose_pct

    ki_regen_sup = effects.get("ki_regen_suppress_duration", 0)
    if ki_regen_sup > 0:
        target["ki_regen_suppressed_until"] = now + ki_regen_sup

    decay_def = effects.get("decay_def", 0)
    decay_dur = effects.get("decay_duration", 0)
    if decay_def > 0 and decay_dur > 0:
        target["decay_def_until"] = now + decay_dur
        target["decay_def_amount"] = decay_def

    # Vampiric — attacker gains timed regen
    vamp_pct = effects.get("vampiric_pct", 0)
    vamp_dur = effects.get("vampiric_duration", 0)
    if vamp_pct > 0 and vamp_dur > 0 and final_dmg > 0:
        attacker["vampiric_until"] = now + vamp_dur
        attacker["vampiric_pct"] = vamp_pct
        attacker["vampiric_last_dmg"] = final_dmg

    # ── Burn DoT ───────────────────────────────────────────────────────────
    burn_dps = effects.get("burn_dps", 0)
    burn_dur = effects.get("burn_duration", 0)
    if burn_dps > 0 and burn_dur > 0:
        target["burning_until"] = now + burn_dur
        target["burn_dps"] = burn_dps
        target["burn_last_tick"] = now

    # ── Aftershock zone ────────────────────────────────────────────────────
    shock_dps = effects.get("aftershock_dps", 0)
    shock_rad = effects.get("aftershock_radius", 0)
    shock_dur = effects.get("aftershock_duration", 0)
    if shock_dps > 0 and shock_rad > 0 and shock_dur > 0:
        self.gs.aftershock_zones.append({
            "x": target.get("x", 0),
            "y": target.get("y", 0),
            "map": target.get("map", "level_01"),
            "radius": shock_rad,
            "dps": shock_dps,
            "expires_at": now + shock_dur,
            "owner_pid": attacker.get("id"),
            "last_tick": now,
        })
```

- [ ] **Step 2: Add `_proximity_learn()` helper**

```python
def _proximity_learn(self, blast_id, origin_x, origin_y, origin_map):
    """Roll proximity blast learning for all nearby entities."""
    if not blast_id or blast_id not in BLAST_DEFS:
        return
    import time as _time
    now = _time.time()
    PROX_RANGE = 200
    LEARN_CHANCE = 0.002  # 0.2%
    COOLDOWN = 1.0

    blast_name = BLAST_DEFS[blast_id].get("displayName", blast_id)

    def _check_entity(entity, pid_for_hint=None):
        if entity.get("dead") or entity.get("knocked_out"):
            return
        if entity.get("map", "level_01") != origin_map:
            return
        learned = entity.setdefault("learned_blasts", [])
        if blast_id in learned:
            return
        last_obs = entity.get("last_blast_observe_at", 0.0)
        if now - last_obs < COOLDOWN:
            return
        ex = entity.get("x", 0)
        ey = entity.get("y", 0)
        if (ex - origin_x)**2 + (ey - origin_y)**2 > PROX_RANGE**2:
            return
        import random as _random
        if _random.random() < LEARN_CHANCE:
            learned.append(blast_id)
            entity["last_blast_observe_at"] = now
            if pid_for_hint:
                self.gs.fx_events.append({
                    "type": "chat_hint", "pid": pid_for_hint,
                    "text": f"Watching carefully... you learned {blast_name}!",
                })

    for pid, p in self.gs.players.items():
        _check_entity(p, pid_for_hint=pid)
        for npc in p.get("npcs", {}).values():
            _check_entity(npc)
```

- [ ] **Step 3: Wire `_apply_blast_effects` into `_ki_blast_player`**

After `target["hp"] = max(0, target["hp"] - final_dmg)`, add:
```python
self._apply_blast_effects(attacker, target, final_dmg)
self._proximity_learn(attacker.get("active_blast_id"), attacker["x"], attacker["y"], attacker.get("map", "level_01"))
```

Also update `_calc_blast_for_actor` call to respect `kiCost` override from `BLAST_DEFS`:

In `_ki_blast_player`, after `cost, dmg = self._calc_blast_for_actor(attacker)`, add:
```python
blast_id = attacker.get("active_blast_id")
if blast_id and blast_id in BLAST_DEFS:
    cost = BLAST_DEFS[blast_id].get("kiCost", cost)
```

- [ ] **Step 4: Same wiring for `_ki_blast_npc`, `_ki_blast_dummy`, `_ki_blast_ground_item`, `_npc_ki_blast_player`, `_npc_ki_blast_npc`**

For each player-fires hit path (`_ki_blast_npc`, `_ki_blast_dummy`):
- After `cost, dmg = self._calc_blast_for_actor(p)`, add the kiCost override block (same as Step 3)
- After damage is dealt, call `self._apply_blast_effects(p, target, final_dmg)` and `self._proximity_learn(p.get("active_blast_id"), p["x"], p["y"], p.get("map", "level_01"))`
- `_ki_blast_ground_item`: only needs proximity learning (no target to apply status effects to)

For NPC-fires paths (`_npc_ki_blast_player`, `_npc_ki_blast_npc`):
- The attacker is `attacker_npc` or `npc_state`; add the same kiCost override and effects calls
- `_apply_blast_effects(attacker_npc, target, final_dmg)` and `_proximity_learn(attacker_npc.get("active_blast_id"), attacker_npc["x"], attacker_npc["y"], attacker_npc.get("map", "level_01"))`

**Update NPC `active_blast_id` in `_proximity_learn`:** When a blast is added to an NPC's `learned_blasts`, set its `active_blast_id` to the newly learned blast. In `_proximity_learn()`, after `learned.append(blast_id)`, add:

```python
# If this entity is an NPC, update its active blast
if "owner" in entity:  # NPCs have an "owner" field
    entity["active_blast_id"] = blast_id
```

Also update `npc_manager.py` `_build_npc()` to include blast fields at line ~76 (after the `npc_state` dict):
```python
npc_state["learned_blasts"] = []
npc_state["active_blast_id"] = None
npc_state["last_blast_observe_at"] = 0.0
```

- [ ] **Step 5: Update `_get_effective_def` to subtract `decay_def_amount` if active**

`_get_effective_def` is defined in `combat_melee.py` at line 47 (not in `combat_utils.py`). Update it there:

```python
def _get_effective_def(self, actor):
    import time as _t
    base = max(1, int(actor.get("def", 1) or 1))
    base += self._equipment_stat_bonus(actor, "def_bonus")
    # Decay DEF debuff
    if actor.get("decay_def_until", 0) > _t.time():
        base = max(0, base - actor.get("decay_def_amount", 0))
    return base
```

Also add expose amplification to `_calc_melee_damage` in `combat_melee.py` (the spec requires expose to apply to ALL damage sources including melee). After computing `return max(1, base + variance - reduction)`, change to:

```python
result = max(1, base + variance - reduction)
# Expose amplification (applies to all damage sources)
import time as _t
if defender.get("exposed_until", 0) > _t.time():
    result = round(result * (1 + defender.get("exposed_pct", 0) / 100))
return result
```

- [ ] **Step 6: Commit**

```bash
git add auxserver/services/combat_ki.py auxserver/services/combat_utils.py
git commit -m "feat: apply blast effects on hit and add proximity learning"
```

---

## Task 9: `game_state.py` — status effect infrastructure

**Files:**
- Modify: `auxserver/services/game_state.py`

- [ ] **Step 1: Add `aftershock_zones` to `GameState.__init__` and `reset()`**

In `__init__`, after `self.pending_absorbs = []`:
```python
self.aftershock_zones = []  # [{x, y, map, radius, dps, expires_at, owner_pid, last_tick}]
```

In `reset()`, after `self.pending_absorbs.clear()`:
```python
self.aftershock_zones.clear()
```

- [ ] **Step 2: Add `_tick_status_effects(dt)` method to `GameState`**

Add after `save_world()`:

```python
def _tick_status_effects(self, dt):
    """Tick burn DoTs, aftershock zones, and vampiric regen on all entities."""
    import time as _t
    now = _t.time()

    # Collect all live entities
    entities = []
    for p in self.players.values():
        if not p.get("dead") and not p.get("knocked_out"):
            entities.append(p)
        for npc in p.get("npcs", {}).values():
            if not npc.get("dead") and not npc.get("knocked_out"):
                entities.append(npc)

    for e in entities:
        # Burn DoT
        if e.get("burning_until", 0) > now and e.get("burn_dps", 0) > 0:
            last = e.get("burn_last_tick", 0)
            if now - last >= 1.0:
                e["hp"] = max(0, e.get("hp", 0) - e["burn_dps"])
                e["burn_last_tick"] = now

        # Vampiric regen (on attacker)
        if e.get("vampiric_until", 0) > now and e.get("vampiric_pct", 0) > 0:
            last_dmg = e.get("vampiric_last_dmg", 0)
            regen_per_sec = last_dmg * e["vampiric_pct"] / 100
            e["hp"] = min(e.get("maxHp", 20), e.get("hp", 0) + regen_per_sec * dt)

    # Aftershock zones
    live_zones = []
    for zone in self.aftershock_zones:
        if zone["expires_at"] <= now:
            continue
        live_zones.append(zone)
        last = zone.get("last_tick", 0)
        if now - last < 1.0:
            continue
        zone["last_tick"] = now
        zx, zy, zmap = zone["x"], zone["y"], zone["map"]
        rad2 = zone["radius"] ** 2
        for e in entities:
            if e.get("map", "level_01") != zmap:
                continue
            dx = e.get("x", 0) - zx
            dy = e.get("y", 0) - zy
            if dx*dx + dy*dy <= rad2:
                e["hp"] = max(0, e.get("hp", 0) - zone["dps"])
    self.aftershock_zones = live_zones
```

- [ ] **Step 3: Call `_tick_status_effects(dt)` from `tick()`**

In `tick()`, after the campfire tick line (`self.building._tick_campfires(dt, now)`), add:
```python
self._tick_status_effects(dt)
```

- [ ] **Step 4: Check `ki_silenced_until` before ki actions in `input_handler.py`**

The ki-related message types in `input_handler.py` are (verified from file):
- `ki_blast_player`, `ki_blast_npc`, `ki_blast_dummy`, `ki_blast_ground_item`, `ki_blast_ki_target`, `ki_blast_miss`
- `absorb_npc`, `npc_absorb_npc`
- `npc_ki_blast_player`, `npc_ki_blast_npc`, `npc_ki_blast_ki_target`
- `activate_barrier`

Add a single early-exit check before these handlers. In `handle_input()`, after the existing dead/knocked-out block (around line 35), add:

```python
# Ki silence gate
import time as _t
_KI_MSG_TYPES = {
    "ki_blast_player", "ki_blast_npc", "ki_blast_dummy",
    "ki_blast_ground_item", "ki_blast_ki_target", "ki_blast_miss",
    "absorb_npc", "npc_absorb_npc",
    "npc_ki_blast_player", "npc_ki_blast_npc", "npc_ki_blast_ki_target",
    "activate_barrier",
}
if msg_type in _KI_MSG_TYPES and p.get("ki_silenced_until", 0) > _t.time():
    return  # silenced — no ki actions allowed
```

- [ ] **Step 5: Add `ki_regen_suppressed_until` check in ki regen loop**

In `game_state.py` `tick()`, the player ki regen loop starts around line 434. Before `p["_ki_regen_accum"]` accumulation, add:
```python
if p.get("ki_regen_suppressed_until", 0) > now:
    p["_ki_regen_accum"] = 0.0
    continue
```

Similarly in the NPC ki regen loop.

- [ ] **Step 6: Add `stunned_until`, `displaced_until`, `slowed_until` checks in move handler**

In `tick()` move handler (the `for move_pid, p in self.players.items():` loop), in the `else:` branch (where we compute `new_x = p["x"] + p["vx"] * dt`), add before computing new_x/new_y:

```python
# Status effect movement gates
if p.get("stunned_until", 0) > now:
    p["vx"] = 0
    p["vy"] = 0
    continue
if p.get("displaced_until", 0) > now:
    # Skip applying client velocity — displaced position already set
    p["vx"] = 0
    p["vy"] = 0
    continue
if p.get("slowed_until", 0) > now:
    slow = p.get("slow_pct", 0) / 100.0
    p["vx"] = p.get("vx", 0) * (1 - slow)
    p["vy"] = p.get("vy", 0) * (1 - slow)
```

- [ ] **Step 7: Add `blinded_until` check in ki blast range**

In `combat_utils.py`, in `_get_blast_range`:
```python
def _get_blast_range(self, actor):
    import time as _t
    if actor.get("blinded_until", 0) > _t.time():
        return KI_BLAST_RANGE * 0.2
    bonuses = actor.get("ki_blast_bonuses") or {}
    bonus = int(bonuses.get("blast_range", 0) or 0)
    return KI_BLAST_RANGE + bonus * TILE_SIZE * 0.5 + TILE_SIZE
```

- [ ] **Step 8: Add `exposed_pct` to damage calc**

In `combat_utils.py`, in `_calc_ki_damage_taken`, after the existing calculation, add expose amplification:
```python
def _calc_ki_damage_taken(self, raw_dmg, target):
    import time as _t
    base_dmg = max(1, int(raw_dmg or 0))
    effective_def = self._get_effective_def(target)
    after_def = max(1, base_dmg - max(0, effective_def) // KI_DEF_REDUCTION_DIVISOR)
    ki_skill_level = max(1, int(target.get("kiSkillLevel", 1) or 1))
    resist_pct = min(KI_SKILL_RESIST_CAP, max(0.0, (ki_skill_level - 1) * KI_SKILL_RESIST_PER_LEVEL))
    result = max(1, round(after_def * (1.0 - resist_pct)))
    # Expose amplification
    if target.get("exposed_until", 0) > _t.time():
        result = round(result * (1 + target.get("exposed_pct", 0) / 100))
    return result
```

- [ ] **Step 9: Commit**

```bash
git add auxserver/services/game_state.py auxserver/services/combat_utils.py auxserver/services/input_handler.py
git commit -m "feat: status effect tick system, move handler gates, ki silence and blind"
```

---

## Task 10: Geode → `blast_crystal` drop

**Files:**
- Modify: `auxserver/services/cave_mining.py`

- [ ] **Step 1: Add blast_crystal drop when geode is mined**

In `cave_mining.py`, in the ore award section (around line 91–103), where `ore_type` is processed:

```python
# Award resources to player inventory
ore_type = drop.get("ore_type")
ore_amount = drop.get("ore_amount", 0)
if ore_type and ore_amount > 0:
    inv = p.setdefault("inventory", {})
    if ore_type == "stone":
        p["stones"] = p.get("stones", 0) + ore_amount
    elif ore_type == "geode":
        inv["geode"] = inv.get("geode", 0) + ore_amount
        # 25% chance to also drop a blast_crystal
        import random as _random
        if _random.random() < 0.25:
            inv["blast_crystal"] = inv.get("blast_crystal", 0) + 1
            self.gs.fx_events.append({
                "type": "chat_hint", "pid": pid,
                "text": "+1 blast crystal! (Use it to learn a random ki blast technique)"
            })
    else:
        inv[ore_type] = inv.get(ore_type, 0) + ore_amount

    if ore_type != "geode":  # geode hint handled above
        self.gs.fx_events.append({
            "type": "chat_hint", "pid": pid,
            "text": f"+{ore_amount} {ore_type.replace('_', ' ')}"
        })
```

Note: If the existing code already handles geode specially, adapt accordingly. The key change is adding the 25% crystal roll when `ore_type == "geode"`.

- [ ] **Step 2: Commit**

```bash
git add auxserver/services/cave_mining.py
git commit -m "feat: geode mining has 25% chance to drop blast_crystal"
```

---

## Task 11: Client — blast sprite keys in `src/constants.js`

**Files:**
- Modify: `src/constants.js`

- [ ] **Step 1: Add blast sprite key constants**

Add to `src/constants.js`:
```javascript
// Ki blast sprite keys (one per BlastsAscended subfolder)
export const BLAST_SPRITE_KEYS = [
  '001_blastoozarou','002_Blaster','003_Rocket','004_Bullet','005_blast14',
  '006_blast13','007_blast16','008_blast27','009_blast06','010_blast35',
  '011_blast28','012_blast20','013_blast23','014_blast08','015_blast09',
  '016_blast22','017_blast34','018_blast02','019_blast10','020_blast11',
  '021_blast03','022_blast04','023_blast33','024_blast05','025_blast01',
  '026_blast12','027_blast36','028_blast15','029_blast32','030_blast31',
  '031_blast18','032_blast30','033_blast17','034_blast24','035_blast25',
  '036_blast19','037_blast29','038_blast21','039_blast26','040_blast07',
];

// Map sprite name → its JSON layout (populated in GameScene.preload via sync XHR)
export const BLAST_DEFS = {};      // id -> blast def object
export const BLAST_SPRITE_META = {}; // sprite -> {dirs, frames, frameWidth, frameHeight, columns}
```

- [ ] **Step 2: Commit**

```bash
git add src/constants.js
git commit -m "feat: add blast sprite key list and BLAST_DEFS map to constants"
```

---

## Task 12: Client — `GameScene.js` preload blast defs and spritesheets

**Files:**
- Modify: `src/scenes/GameScene.js`

- [ ] **Step 1: Fetch blast defs synchronously at start of `preload()`**

At the very top of the `preload()` method body (before any `this.load.spritesheet` calls), add:

```javascript
// Fetch blast definitions synchronously so they're available during preload
import { BLAST_DEFS, BLAST_SPRITE_META, BLAST_SPRITE_KEYS } from '../constants.js';
// (If already imported at top of file, skip the import line here)

try {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', '/api/blasts', false); // synchronous
  xhr.send();
  if (xhr.status === 200) {
    const defs = JSON.parse(xhr.responseText);
    for (const def of defs) {
      BLAST_DEFS[def.id] = def;
    }
  }
} catch (e) {
  console.warn('Failed to load blast defs:', e);
}

// Fetch sprite metadata and queue spritesheet loads for all 40 blasts
for (const sprite of BLAST_SPRITE_KEYS) {
  try {
    const xhr2 = new XMLHttpRequest();
    xhr2.open('GET', `/assets/BlastsAscended/${sprite}/${sprite}.json`, false);
    xhr2.send();
    if (xhr2.status === 200) {
      const meta = JSON.parse(xhr2.responseText);
      const fw = meta.frameSize.width;
      const fh = meta.frameSize.height;
      BLAST_SPRITE_META[sprite] = {
        dirs: meta.stateInfo.dirs,
        frames: meta.stateInfo.frames,
        frameWidth: fw,
        frameHeight: fh,
        columns: meta.layout.columns,
      };
      this.load.spritesheet(
        `blast_${sprite}`,
        `/assets/BlastsAscended/${sprite}/${sprite}.png`,
        { frameWidth: fw, frameHeight: fh }
      );
    }
  } catch (e) {
    console.warn(`Failed to load blast meta for ${sprite}:`, e);
  }
}
```

Note: The import statements must be at the top of the file. If constants are already imported, just add `BLAST_DEFS`, `BLAST_SPRITE_META`, `BLAST_SPRITE_KEYS` to the existing import.

- [ ] **Step 2: Verify no load errors in browser console**

Start game, open devtools console. Verify: `blast_001_blastoozarou` etc. texture keys exist in Phaser's cache, no 404 errors.

- [ ] **Step 3: Commit**

```bash
git add src/scenes/GameScene.js
git commit -m "feat: preload all 40 blast spritesheets and fetch blast defs in GameScene"
```

---

## Task 13: Client — `CombatFxController.js` use blast sprite

**Files:**
- Modify: `src/systems/CombatFxController.js`

- [ ] **Step 1: Update `firePlayerKiBlast()` to use active blast sprite**

In `firePlayerKiBlast()`, replace the `NRG_KEY` sprite creation with blast-aware selection.

Find:
```javascript
const proj = scene.add.sprite(projX, projY, NRG_KEY, blastFrame);
```

Replace with:
```javascript
import { BLAST_DEFS, BLAST_SPRITE_META } from '../constants.js';
// (add to file imports at top)

const activeBlastId = p.activeBlastId;
const blastDef = activeBlastId ? BLAST_DEFS[activeBlastId] : null;
const blastSprite = blastDef?.sprite;
const blastMeta = blastSprite ? BLAST_SPRITE_META[blastSprite] : null;

let projKey = NRG_KEY;
let projFrame = blastFrame; // dirFrames[aim.facing] computed above
if (blastSprite && blastMeta && scene.textures.exists(`blast_${blastSprite}`)) {
  projKey = `blast_${blastSprite}`;
  // Compute correct frame based on dirs layout
  const dirs = blastMeta.dirs;
  const frames = blastMeta.frames;
  if (dirs === 1) {
    projFrame = 0;  // omni: always frame 0
  } else if (dirs === 4) {
    // Frame layout: frame 0 = down dir 0, frame 1 = up dir 0, frame 2 = right dir 0, frame 3 = left dir 0
    const dir4 = { down: 0, up: 1, right: 2, left: 3 };
    projFrame = dir4[aim.facing] ?? 0;
  } else if (dirs === 8) {
    // 8-dir: down=0, up=1, right=2, left=3 (using cardinal subset)
    const dir8 = { down: 0, up: 1, right: 2, left: 3 };
    projFrame = dir8[aim.facing] ?? 0;
  }
}

const proj = scene.add.sprite(projX, projY, projKey, projFrame);
```

Also remove the `setTint` line for blast sprites (they have their own color):
```javascript
if (!blastSprite) {
  proj.setTint(Number(p.auraTint ?? 0x4fd6ff));
}
```

- [ ] **Step 2: Create blast animation on the projectile while it travels**

After creating `proj`, add animation if the blast has multiple frames:
```javascript
if (blastMeta && blastMeta.frames > 1) {
  const animKey = `blast_anim_${blastSprite}_${aim.facing}`;
  if (!scene.anims.exists(animKey)) {
    const dirs = blastMeta.dirs;
    const frameNums = [];
    for (let f = 0; f < blastMeta.frames; f++) {
      let idx;
      if (dirs === 1) idx = f;
      else if (dirs === 4) { const d4 = {down:0,up:1,right:2,left:3}; idx = (d4[aim.facing]??0) + f * dirs; }
      else { const d8 = {down:0,up:1,right:2,left:3}; idx = (d8[aim.facing]??0) + f * dirs; }
      frameNums.push(idx);
    }
    scene.anims.create({
      key: animKey,
      frames: frameNums.map(n => ({ key: projKey, frame: n })),
      frameRate: 8,
      repeat: -1,
    });
  }
  proj.play(animKey);
}
```

- [ ] **Step 3: Handle replicated `ki_blast` FX events using `blast_id`**

Find where incoming FX events with `kind === "ki_blast"` are handled (search for `ki_blast` in GameScene.js). Update the sprite selection to use `event.blast_id` from the server payload:

```javascript
// When rendering a replicated blast from another player/NPC
const repBlastId = fxEvent.blast_id;
const repDef = repBlastId ? BLAST_DEFS[repBlastId] : null;
const repSprite = repDef?.sprite;
const repKey = (repSprite && scene.textures.exists(`blast_${repSprite}`)) ? `blast_${repSprite}` : NRG_KEY;
// ... use repKey instead of NRG_KEY
```

- [ ] **Step 4: Commit**

```bash
git add src/systems/CombatFxController.js src/scenes/GameScene.js
git commit -m "feat: render blast-specific sprite on fire and replicated FX events"
```

---

## Task 14: Client — hotbar blast slot + right-click picker

**Files:**
- Modify: `src/ui/InventoryController.js`

- [ ] **Step 1: Find the ki slot rendering code in `InventoryController.js` and add a blast slot**

Search `src/ui/InventoryController.js` for the ki bar / ki slots (look for `_pf_kiBar`, `_kiSlot`, or `ki` variables). The blast slot sits to the left of the existing ki slots. Add a `_blastSlot` container that:
- Shows the first directional frame of `BLAST_DEFS[player.activeBlastId]?.sprite` (using the same texture loading as above)
- Shows "?" text if `player.learnedBlasts` is empty or `activeBlastId` is null

```javascript
// Approximate pattern — adapt to the actual HUD structure:
_buildBlastSlot() {
  const scene = this.scene;
  const x = /* position left of ki slots, e.g., existing_ki_slot_x - 56 */;
  const y = /* same y as ki slots */;

  this._blastSlotBg = scene.add.rectangle(x, y, 48, 48, 0x1a1a2e).setStrokeStyle(1, 0x444444).setDepth(30).setScrollFactor(0);
  this._blastSlotSprite = scene.add.sprite(x, y, NRG_KEY, 0).setDepth(31).setScrollFactor(0).setScale(1.5);
  this._blastSlotLabel = scene.add.text(x, y + 24, '', { fontSize: '9px', color: '#aaa' }).setOrigin(0.5, 1).setDepth(32).setScrollFactor(0);
  this._blastSlotQuestion = scene.add.text(x, y, '?', { fontSize: '18px', color: '#666' }).setOrigin(0.5, 0.5).setDepth(32).setScrollFactor(0);

  // Right-click to open picker
  this._blastSlotBg.setInteractive();
  this._blastSlotBg.on('pointerdown', (ptr) => {
    if (ptr.rightButtonDown()) this._openBlastPicker();
  });
}

updateBlastSlot(player) {
  const activeId = player.activeBlastId;
  const learned = player.learnedBlasts || [];
  if (!activeId || !BLAST_DEFS[activeId]) {
    this._blastSlotSprite.setVisible(false);
    this._blastSlotQuestion.setVisible(true);
    this._blastSlotLabel.setText('');
  } else {
    const def = BLAST_DEFS[activeId];
    const sprite = def.sprite;
    const key = `blast_${sprite}`;
    if (this.scene.textures.exists(key)) {
      this._blastSlotSprite.setTexture(key, 0).setVisible(true);
    }
    this._blastSlotQuestion.setVisible(false);
    this._blastSlotLabel.setText(def.displayName || activeId);
  }
}
```

- [ ] **Step 2: Build the blast picker popup**

```javascript
_openBlastPicker() {
  // Destroy previous picker
  this._closePicker();
  const scene = this.scene;
  const learned = scene.player?.learnedBlasts || [];
  if (learned.length === 0) return;

  // Popup container
  this._pickerContainer = scene.add.container(0, 0).setDepth(50).setScrollFactor(0);
  const bg = scene.add.rectangle(100, 100, 220, Math.min(260, learned.length * 56 + 20), 0x111122, 0.95);
  bg.setStrokeStyle(1, 0x4fd6ff);
  bg.setOrigin(0, 0);
  this._pickerContainer.add(bg);

  let row = 0;
  for (const blastId of learned) {
    const def = BLAST_DEFS[blastId];
    if (!def) continue;
    const y = row * 52 + 16;
    // Sprite preview
    const sprKey = `blast_${def.sprite}`;
    if (scene.textures.exists(sprKey)) {
      const spr = scene.add.sprite(36, y + 16, sprKey, 0).setScrollFactor(0);
      this._pickerContainer.add(spr);
    }
    // Name
    const lbl = scene.add.text(68, y + 8, def.displayName, { fontSize: '12px', color: '#eee' }).setScrollFactor(0);
    const costLbl = scene.add.text(68, y + 22, `Ki: ${def.kiCost}`, { fontSize: '10px', color: '#aaa' }).setScrollFactor(0);
    this._pickerContainer.add([lbl, costLbl]);
    // Hit area
    const hitZone = scene.add.rectangle(110, y + 16, 200, 48, 0xffffff, 0).setInteractive().setScrollFactor(0);
    hitZone.on('pointerdown', () => {
      scene._conn?.send({ type: 'set_active_blast', blast_id: blastId });
      scene.player.activeBlastId = blastId;
      this.updateBlastSlot(scene.player);
      this._closePicker();
    });
    this._pickerContainer.add(hitZone);
    row++;
  }

  // Click outside to close
  scene.input.once('pointerdown', () => this._closePicker());
}

_closePicker() {
  this._pickerContainer?.destroy();
  this._pickerContainer = null;
}
```

- [ ] **Step 3: Update `player` state sync to map `active_blast_id` → `activeBlastId`**

In `StateSyncController.js` or wherever server state is applied to the player object, ensure:
```javascript
player.activeBlastId = serverState.active_blast_id ?? player.activeBlastId;
player.learnedBlasts = serverState.learned_blasts ?? player.learnedBlasts ?? [];
```

- [ ] **Step 4: Commit**

```bash
git add src/ui/ src/systems/StateSyncController.js
git commit -m "feat: hotbar blast slot with right-click picker and set_active_blast"
```

---

## Task 15: Integration smoke test

- [ ] **Step 1: Start server, open game in browser**

```bash
cd auxserver && uvicorn main:app --reload --port 8000
```

- [ ] **Step 2: Verify blast editor**
- Visit `/blasts` — sidebar shows 40 thumbnails, editor loads when one is clicked
- Configure "glacial_spike" blast with slow_pct=60, slow_duration=3 — save — verify `data/blast_moves.json` updated

- [ ] **Step 3: Verify blast selection**
- Open game, open browser devtools console
- Send: `scene._conn.send({type:'set_active_blast', blast_id:'glacial_spike'})`
- Hotbar blast slot should update to show glacial spike sprite

- [ ] **Step 4: Verify blast firing**
- Fire ki blast at a dummy — should use glacial spike sprite visually
- Server log should show blast FX event with `blast_id: "glacial_spike"`

- [ ] **Step 5: Verify blast_crystal from geode**
- Mine at depth ≥ 15 in cave until geode drops
- Check inventory for `blast_crystal`
- Send `use_blast_crystal` message — chat hint should show learned blast name

- [ ] **Step 6: Final commit**

```bash
git add -u
git commit -m "feat: ki blast moves system complete — editor, effects, hotbar, learning"
```
