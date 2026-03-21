// =========================
// Tile Map Editor (Layered + Sprite Maker)
// =========================

const TILE = 16;
const SPACING = 1;
const SLOT = TILE + SPACING;

let MAP_WIDTH = 40;
let MAP_HEIGHT = 25;

// Zoom State
let mapZoom = 2.0;
const ZOOM_SPEED = 0.1;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 5.0;

// Tool State
let activeTool = 'paint';
let editorMode = 'map';
let lineStart = null;
let selectedBrush = null; // { type:'sheet', col, row } | { type:'custom', id }
let lastSheetSelection = null;

// Tile History — most-recent first, max 24 entries
const TILE_HISTORY_MAX = 24;
let tileHistory = []; // array of { col, row }

// Collision State — editor-only overlay tiles, not written to placedTiles
// Keys are "x,y" strings, values are the hex color string used for that tile
let collisionTiles = new Map();

// Layer State
let activeLayer = 0;

let placedTiles = [];
let customSprites = [];
const customSpriteCanvases = new Map();
let customSpriteIdCounter = 1;

let isDrawing = false;
let isErasing = false;
let lastFloodTile = null; // track last tile flooded to avoid re-flooding same cell

// Undo/redo history
// Each entry is an array of { x, y, layer, newTile, oldTile } change objects.
// newTile / oldTile are copies of the placedTiles entry (or null if the cell was empty).
const _paintHistory = [];
let _historyIndex = -1;
// Accumulates changes during an active drag stroke; committed on mouseup.
let _currentStroke = null;
// Track which cells have already been touched in the current stroke (avoid duplicate entries).
const _strokeTouched = new Set();

function _tileSnapshot(x, y, layer) {
  const t = getTileAt(x, y, layer);
  return t ? { ...t } : null;
}

function _recordBatch(changes) {
  if (!changes || changes.length === 0) return;
  // Discard redo stack above current position
  _paintHistory.splice(_historyIndex + 1);
  _paintHistory.push(changes);
  _historyIndex = _paintHistory.length - 1;
  // Cap at 100 batch entries
  if (_paintHistory.length > 100) {
    _paintHistory.shift();
    _historyIndex = _paintHistory.length - 1;
  }
}

function _beginStroke() {
  _currentStroke = [];
  _strokeTouched.clear();
}

function _commitStroke() {
  if (_currentStroke && _currentStroke.length > 0) {
    _recordBatch(_currentStroke);
  }
  _currentStroke = null;
  _strokeTouched.clear();
}

function _addToStroke(x, y, layer, oldTile, newTile) {
  if (!_currentStroke) return;
  const key = `${x},${y},${layer}`;
  // Only record the first time a cell is touched in this stroke (preserves original oldTile)
  if (!_strokeTouched.has(key)) {
    _strokeTouched.add(key);
    _currentStroke.push({ x, y, layer, oldTile, newTile });
  } else {
    // Update newTile for already-touched cell (in case it changed)
    const entry = _currentStroke.find(c => c.x === x && c.y === y && c.layer === layer);
    if (entry) entry.newTile = newTile;
  }
}

function _applyTileSnapshot(x, y, layer, snapshot) {
  placedTiles = placedTiles.filter((t) => !(t.x === x && t.y === y && (t.layer ?? 0) === layer));
  if (snapshot) placedTiles.push({ ...snapshot });
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
    e.preventDefault();
    if (_historyIndex >= 0) {
      const batch = _paintHistory[_historyIndex];
      // Apply in reverse order to correctly undo multi-tile ops
      for (let i = batch.length - 1; i >= 0; i--) {
        const { x, y, layer, oldTile } = batch[i];
        _applyTileSnapshot(x, y, layer, oldTile);
      }
      _historyIndex--;
      renderMap();
    }
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
    e.preventDefault();
    if (_historyIndex < _paintHistory.length - 1) {
      _historyIndex++;
      const batch = _paintHistory[_historyIndex];
      for (const { x, y, layer, newTile } of batch) {
        _applyTileSnapshot(x, y, layer, newTile);
      }
      renderMap();
    }
  }
});

const img = new Image();
img.src = '/static/Spritesheet/roguelikeSheet_transparent.png';

const sCanvas = document.getElementById('sheetCanvas');
const sCtx = sCanvas.getContext('2d');
const zCanvas = document.getElementById('zoom');
const zCtx = zCanvas.getContext('2d');
const mCanvas = document.getElementById('mapCanvas');
const mCtx = mCanvas.getContext('2d');
const mapContainer = document.querySelector('.map-container');
const infoEl = document.getElementById('info');
const selectionEl = document.getElementById('selection-display');

// Sprite maker refs
const spritePanelEl = document.getElementById('spriteEditorPanel');
const spriteEditorCanvas = document.getElementById('spriteEditorCanvas');
const spriteEditorCtx = spriteEditorCanvas.getContext('2d');
const spritePreviewCanvas = document.getElementById('spritePreviewCanvas');
const spritePreviewCtx = spritePreviewCanvas.getContext('2d');
const spriteInfoEl = document.getElementById('spriteInfo');
const spriteListEl = document.getElementById('spriteList');
const spriteColorEl = document.getElementById('spriteColor');
const spriteEraserBtn = document.getElementById('spriteEraserBtn');

const spriteWorkCanvas = document.createElement('canvas');
spriteWorkCanvas.width = TILE;
spriteWorkCanvas.height = TILE;
const spriteWorkCtx = spriteWorkCanvas.getContext('2d');

let spritePenColor = '#ff0066';
let spriteUseEraser = false;
let spriteDrawing = false;

let isGridWhite = true;
let isPanning = false;
let panStartX = 0;
let panStartY = 0;
let scrollStartX = 0;
let scrollStartY = 0;
let spacePanHeld = false;

const SIDEBAR_MIN_PX = 200;
function sidebarMaxPx() {
  return Math.floor(window.innerWidth * 0.4);
}
function setSidebarWidth(px) {
  const clamped = Math.max(SIDEBAR_MIN_PX, Math.min(px, sidebarMaxPx()));
  document.documentElement.style.setProperty('--sidebar-w', `${clamped}px`);
}

function applyMapZoom() {
  // Use CSS size instead of transform so scrollable area grows with zoom.
  mCanvas.style.width = `${mCanvas.width * mapZoom}px`;
  mCanvas.style.height = `${mCanvas.height * mapZoom}px`;
}

function brushToText(brush) {
  if (!brush) return 'None';
  if (brush.type === 'sheet') return `Sheet [${brush.col}, ${brush.row}]`;
  if (brush.type === 'custom') return `Custom ${brush.id}`;
  return 'None';
}

function updateSelectionDisplay() {
  if (selectionEl) selectionEl.textContent = `Selected: ${brushToText(selectedBrush)}`;
}

function brushSignature(brush) {
  if (!brush) return 'empty';
  if (brush.type === 'sheet') return `sheet:${brush.col},${brush.row}`;
  if (brush.type === 'custom') return `custom:${brush.id}`;
  return 'empty';
}

function tileSignature(tile) {
  if (!tile) return 'empty';
  if (tile.customSpriteId) return `custom:${tile.customSpriteId}`;
  if (Number.isFinite(tile.tileX) && Number.isFinite(tile.tileY)) {
    return `sheet:${tile.tileX},${tile.tileY}`;
  }
  return 'empty';
}

function setSelectedSheetTile(col, row) {
  lastSheetSelection = { col, row };
  selectedBrush = { type: 'sheet', col, row };
  updateSelectionDisplay();
  pushTileHistory(col, row);
}

// ── Tile History ─────────────────────────────────────────────
const tileHistoryEl = document.getElementById('tileHistory');

function pushTileHistory(col, row) {
  // Remove existing entry if present (dedup — move to front instead)
  const idx = tileHistory.findIndex((t) => t.col === col && t.row === row);
  if (idx !== -1) tileHistory.splice(idx, 1);
  tileHistory.unshift({ col, row });
  if (tileHistory.length > TILE_HISTORY_MAX) tileHistory.length = TILE_HISTORY_MAX;
  renderTileHistory();
}

function renderTileHistory() {
  if (!tileHistoryEl) return;
  tileHistoryEl.innerHTML = '';
  const active = selectedBrush?.type === 'sheet' ? selectedBrush : null;
  for (const entry of tileHistory) {
    const c = document.createElement('canvas');
    c.className = 'tile-history-item';
    c.width = TILE;
    c.height = TILE;
    if (active && active.col === entry.col && active.row === entry.row) {
      c.classList.add('active');
    }
    const ctx = c.getContext('2d');
    if (img.complete && img.naturalWidth) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, entry.col * SLOT, entry.row * SLOT, TILE, TILE, 0, 0, TILE, TILE);
    }
    c.title = `[${entry.col}, ${entry.row}]`;
    c.addEventListener('click', () => setSelectedSheetTile(entry.col, entry.row));
    tileHistoryEl.appendChild(c);
  }
}

function setSelectedCustomSprite(id) {
  selectedBrush = { type: 'custom', id };
  updateSelectionDisplay();
}

function nextCustomSpriteId() {
  let id = `custom_${customSpriteIdCounter}`;
  while (customSpriteCanvases.has(id)) {
    customSpriteIdCounter += 1;
    id = `custom_${customSpriteIdCounter}`;
  }
  customSpriteIdCounter += 1;
  return id;
}

function buildCanvasFromPixels(pixels) {
  if (!Array.isArray(pixels) || pixels.length !== TILE * TILE * 4) return null;
  const c = document.createElement('canvas');
  c.width = TILE;
  c.height = TILE;
  const ctx = c.getContext('2d');
  const imgData = ctx.createImageData(TILE, TILE);
  for (let i = 0; i < pixels.length; i++) {
    const v = Number(pixels[i]);
    imgData.data[i] = Number.isFinite(v) ? Math.max(0, Math.min(255, v)) : 0;
  }
  ctx.putImageData(imgData, 0, 0);
  return c;
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load image source: ${src}`));
    image.src = src;
  });
}

async function buildCanvasFromImageSource(src) {
  const image = await loadImageElement(src);
  const c = document.createElement('canvas');
  c.width = TILE;
  c.height = TILE;
  c.getContext('2d').drawImage(image, 0, 0, TILE, TILE);
  return c;
}

function canvasPixels(canvas) {
  const ctx = canvas.getContext('2d');
  return Array.from(ctx.getImageData(0, 0, TILE, TILE).data);
}

function customSpritesPayloadForSave() {
  return Array.from(customSpriteCanvases.entries()).map(([id, canvas]) => ({
    id,
    pngDataUrl: canvas.toDataURL('image/png'),
  }));
}

function refreshSpriteList() {
  if (!spriteListEl) return;
  spriteListEl.innerHTML = '';

  if (customSprites.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No saved sprites';
    spriteListEl.appendChild(opt);
    return;
  }

  customSprites.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.id;
    spriteListEl.appendChild(opt);
  });
}

function clearSpriteWork() {
  spriteWorkCtx.clearRect(0, 0, TILE, TILE);
  drawSpriteEditor();
}

function loadSheetSelectionToSpriteWork() {
  const src = lastSheetSelection;
  if (!src) {
    if (spriteInfoEl) spriteInfoEl.textContent = 'Pick a sheet tile first.';
    return;
  }

  spriteWorkCtx.clearRect(0, 0, TILE, TILE);
  spriteWorkCtx.drawImage(
    img,
    src.col * SLOT,
    src.row * SLOT,
    TILE,
    TILE,
    0,
    0,
    TILE,
    TILE
  );
  drawSpriteEditor();

  if (spriteInfoEl) {
    spriteInfoEl.textContent = `Loaded sheet tile [${src.col}, ${src.row}] into editor.`;
  }
}

function saveSpriteFromWork() {
  const id = nextCustomSpriteId();
  const c = document.createElement('canvas');
  c.width = TILE;
  c.height = TILE;
  c.getContext('2d').drawImage(spriteWorkCanvas, 0, 0);

  customSpriteCanvases.set(id, c);
  customSprites.push({ id });
  refreshSpriteList();

  if (spriteListEl) spriteListEl.value = id;
  setSelectedCustomSprite(id);

  if (spriteInfoEl) spriteInfoEl.textContent = `Saved ${id} and set it as active brush.`;
}

function loadSavedSpriteToWork(id) {
  const c = customSpriteCanvases.get(id);
  if (!c) return;
  spriteWorkCtx.clearRect(0, 0, TILE, TILE);
  spriteWorkCtx.drawImage(c, 0, 0);
  drawSpriteEditor();
  if (spriteInfoEl) spriteInfoEl.textContent = `Loaded ${id} into editor.`;
}

function drawSpriteEditor() {
  const scale = Math.max(1, Math.floor(spriteEditorCanvas.width / TILE));
  spriteEditorCtx.clearRect(0, 0, spriteEditorCanvas.width, spriteEditorCanvas.height);

  // Checker background
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      spriteEditorCtx.fillStyle = (x + y) % 2 === 0 ? '#1a1a1a' : '#232323';
      spriteEditorCtx.fillRect(x * scale, y * scale, scale, scale);
    }
  }

  // Sprite pixels
  spriteEditorCtx.imageSmoothingEnabled = false;
  spriteEditorCtx.drawImage(spriteWorkCanvas, 0, 0, TILE * scale, TILE * scale);

  // Pixel grid
  spriteEditorCtx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
  spriteEditorCtx.lineWidth = 1;
  for (let i = 0; i <= TILE; i++) {
    const p = i * scale + 0.5;
    spriteEditorCtx.beginPath();
    spriteEditorCtx.moveTo(p, 0);
    spriteEditorCtx.lineTo(p, TILE * scale);
    spriteEditorCtx.stroke();

    spriteEditorCtx.beginPath();
    spriteEditorCtx.moveTo(0, p);
    spriteEditorCtx.lineTo(TILE * scale, p);
    spriteEditorCtx.stroke();
  }

  // Preview
  spritePreviewCtx.clearRect(0, 0, spritePreviewCanvas.width, spritePreviewCanvas.height);
  spritePreviewCtx.imageSmoothingEnabled = false;
  spritePreviewCtx.drawImage(
    spriteWorkCanvas,
    0,
    0,
    spritePreviewCanvas.width,
    spritePreviewCanvas.height
  );
}

function spritePixelFromEvent(e) {
  const rect = spriteEditorCanvas.getBoundingClientRect();
  const x = Math.floor(((e.clientX - rect.left) / rect.width) * TILE);
  const y = Math.floor(((e.clientY - rect.top) / rect.height) * TILE);
  return {
    x: Math.max(0, Math.min(TILE - 1, x)),
    y: Math.max(0, Math.min(TILE - 1, y)),
  };
}

function paintSpritePixel(e, eraseOverride = null) {
  const { x, y } = spritePixelFromEvent(e);
  const erase = eraseOverride === null ? spriteUseEraser : eraseOverride;

  if (erase) spriteWorkCtx.clearRect(x, y, 1, 1);
  else {
    spriteWorkCtx.fillStyle = spritePenColor;
    spriteWorkCtx.fillRect(x, y, 1, 1);
  }

  drawSpriteEditor();
}

async function hydrateCustomSprites(items) {
  customSprites = [];
  customSpriteCanvases.clear();
  customSpriteIdCounter = 1;

  if (!Array.isArray(items)) {
    if (selectedBrush?.type === 'custom') {
      selectedBrush = null;
      updateSelectionDisplay();
    }
    refreshSpriteList();
    return;
  }

  for (const s of items) {
    if (!s || typeof s.id !== 'string') continue;
    let c = null;
    if (Array.isArray(s.pixels)) {
      c = buildCanvasFromPixels(s.pixels);
    } else if (typeof s.pngUrl === 'string') {
      try {
        c = await buildCanvasFromImageSource(s.pngUrl);
      } catch (_err) {
        c = null;
      }
    } else if (typeof s.pngDataUrl === 'string') {
      try {
        c = await buildCanvasFromImageSource(s.pngDataUrl);
      } catch (_err) {
        c = null;
      }
    }
    if (!c) continue;

    customSprites.push({ id: s.id });
    customSpriteCanvases.set(s.id, c);

    const m = /_(\d+)$/.exec(s.id);
    if (m) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n)) customSpriteIdCounter = Math.max(customSpriteIdCounter, n + 1);
    }
  }

  refreshSpriteList();

  if (selectedBrush?.type === 'custom' && !customSpriteCanvases.has(selectedBrush.id)) {
    selectedBrush = null;
    updateSelectionDisplay();
  }
}

function initSpriteEditor() {
  clearSpriteWork();
  drawSpriteEditor();
  refreshSpriteList();

  document.getElementById('spriteNewBtn').addEventListener('click', () => {
    clearSpriteWork();
    if (spriteInfoEl) spriteInfoEl.textContent = 'Started a blank 16x16 sprite.';
  });

  document.getElementById('spriteClearBtn').addEventListener('click', () => {
    clearSpriteWork();
    if (spriteInfoEl) spriteInfoEl.textContent = 'Cleared sprite editor.';
  });

  document.getElementById('spriteFromTileBtn').addEventListener('click', loadSheetSelectionToSpriteWork);

  document.getElementById('spriteSaveBtn').addEventListener('click', () => {
    saveSpriteFromWork();
  });

  document.getElementById('spriteUseSavedBtn').addEventListener('click', () => {
    const id = spriteListEl.value;
    if (!id || !customSpriteCanvases.has(id)) return;
    setSelectedCustomSprite(id);
    if (spriteInfoEl) spriteInfoEl.textContent = `Selected ${id} as active brush.`;
  });

  document.getElementById('spriteLoadSavedBtn').addEventListener('click', () => {
    const id = spriteListEl.value;
    if (!id || !customSpriteCanvases.has(id)) return;
    loadSavedSpriteToWork(id);
  });

  spriteColorEl.addEventListener('input', (e) => {
    spritePenColor = e.target.value || '#ff0066';
  });

  spriteEraserBtn.addEventListener('click', () => {
    spriteUseEraser = !spriteUseEraser;
    spriteEraserBtn.textContent = spriteUseEraser ? 'Eraser: On' : 'Eraser: Off';
  });

  spriteEditorCanvas.addEventListener('mousedown', (e) => {
    if (editorMode !== 'sprite') return;
    e.preventDefault();
    spriteDrawing = true;
    paintSpritePixel(e, e.button === 2 ? true : null);
  });

  spriteEditorCanvas.addEventListener('mousemove', (e) => {
    if (editorMode !== 'sprite' || !spriteDrawing) return;
    paintSpritePixel(e);
  });

  spriteEditorCanvas.addEventListener('mouseup', () => {
    spriteDrawing = false;
  });

  spriteEditorCanvas.addEventListener('mouseleave', () => {
    spriteDrawing = false;
  });

  spriteEditorCanvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

// Keep zoom canvas buffer in sync with its CSS size so it fills the column
function syncZoomCanvasSize() {
  const w = zCanvas.clientWidth || 160;
  const h = zCanvas.clientHeight || 160;
  if (zCanvas.width !== w || zCanvas.height !== h) {
    zCanvas.width  = w;
    zCanvas.height = h;
    zCtx.imageSmoothingEnabled = false;
  }
}
new ResizeObserver(syncZoomCanvasSize).observe(zCanvas);

// --- Initialization ---
img.onload = () => {
  sCanvas.width = img.width;
  sCanvas.height = img.height;
  sCtx.drawImage(img, 0, 0);
  syncZoomCanvasSize();
  zCtx.imageSmoothingEnabled = false;

  initSpriteEditor();
  initMapItems();
  updateDimensions();
  updateSelectionDisplay();
  renderTileHistory();
};

window.setEditorMode = function (mode) {
  editorMode = mode === 'sprite' ? 'sprite' : 'map';

  document.body.classList.toggle('sprite-mode', editorMode === 'sprite');

  const mapBtn = document.getElementById('btnModeMap');
  const spriteBtn = document.getElementById('btnModeSprite');
  if (mapBtn) mapBtn.classList.toggle('active', editorMode === 'map');
  if (spriteBtn) spriteBtn.classList.toggle('active', editorMode === 'sprite');

  if (spritePanelEl) spritePanelEl.classList.toggle('hidden', editorMode !== 'sprite');
};

window.setTool = function (tool) {
  activeTool = tool;
  document.querySelectorAll('.tool-btn').forEach((b) => b.classList.remove('active'));
  const btn = document.getElementById('btn' + tool.charAt(0).toUpperCase() + tool.slice(1));
  if (btn) btn.classList.add('active');
  lineStart = null;
  renderMap();
};

function getCollisionColor() {
  return document.getElementById('collisionColor')?.value || '#ff0033';
}

window.toggleGridColor = function () {
  isGridWhite = !isGridWhite;
  const btn = document.getElementById('btnGridToggle');
  if (btn) btn.textContent = isGridWhite ? 'Grid: White' : 'Grid: Black';
  renderMap();
};

window.setLayer = function (layer) {
  const n = Number(layer);
  if (!Number.isFinite(n) || n < 0) return;
  activeLayer = Math.floor(n);
  renderMap();
};

// --- Sidebar Resizer ---
const resizer = document.getElementById('resizer');
let isResizing = false;
resizer.addEventListener('mousedown', () => (isResizing = true));
window.addEventListener('mousemove', (e) => {
  if (!isResizing) return;
  setSidebarWidth(e.clientX);
});
window.addEventListener('mouseup', () => (isResizing = false));

// Default sidebar to max expanded on load.
setSidebarWidth(sidebarMaxPx());
window.addEventListener('resize', () => {
  const current = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')
  );
  if (!Number.isFinite(current)) {
    setSidebarWidth(sidebarMaxPx());
    return;
  }
  setSidebarWidth(current);
});

// --- Scroll to Zoom ---
mapContainer.addEventListener(
  'wheel',
  (e) => {
    if (e.ctrlKey) return;
    e.preventDefault();
    if (e.deltaY < 0) mapZoom = Math.min(mapZoom + ZOOM_SPEED, MAX_ZOOM);
    else mapZoom = Math.max(mapZoom - ZOOM_SPEED, MIN_ZOOM);
    applyMapZoom();
  },
  { passive: false }
);

// --- Pan Hotkey ---
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') spacePanHeld = true;
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') spacePanHeld = false;
});

// --- Centered Magnifier & Sheet Picker ---
sCanvas.addEventListener('mousemove', (e) => {
  syncZoomCanvasSize();
  const rect = sCanvas.getBoundingClientRect();
  const scaleX = img.width / rect.width;
  const scaleY = img.height / rect.height;
  const px = (e.clientX - rect.left) * scaleX;
  const py = (e.clientY - rect.top) * scaleY;
  const col = Math.floor(px / SLOT);
  const row = Math.floor(py / SLOT);

  // Show a 10×10 tile window centred on the hovered tile
  const VIEW_TILES = 10;
  const viewSize = VIEW_TILES * SLOT;
  const sx = col * SLOT - viewSize / 2 + SLOT / 2;
  const sy = row * SLOT - viewSize / 2 + SLOT / 2;

  zCtx.clearRect(0, 0, zCanvas.width, zCanvas.height);
  zCtx.drawImage(img, sx, sy, viewSize, viewSize, 0, 0, zCanvas.width, zCanvas.height);

  // Red highlight box on the centre tile
  zCtx.strokeStyle = '#f00';
  zCtx.lineWidth = 2;
  const centerW = (SLOT / viewSize) * zCanvas.width;
  const centerH = (SLOT / viewSize) * zCanvas.height;
  const centerX = (zCanvas.width - centerW) / 2;
  const centerY = (zCanvas.height - centerH) / 2;
  zCtx.strokeRect(centerX, centerY, centerW, centerH);
});

sCanvas.addEventListener('mousedown', (e) => {
  const rect = sCanvas.getBoundingClientRect();
  const scaleX = img.width / rect.width;
  const scaleY = img.height / rect.height;
  const px = (e.clientX - rect.left) * scaleX;
  const py = (e.clientY - rect.top) * scaleY;
  const cols = Math.floor(img.width / SLOT);

  const col = Math.floor(px / SLOT);
  const row = Math.floor(py / SLOT);
  setSelectedSheetTile(col, row);

  const frame = row * cols + col;
  if (infoEl) {
    infoEl.textContent = `[${col},${row}] f${frame}`;
  }
});

// --- Map Dimension Logic ---
function updateDimensions() {
  MAP_WIDTH = parseInt(document.getElementById('gridW').value, 10) || 40;
  MAP_HEIGHT = parseInt(document.getElementById('gridH').value, 10) || 25;
  mCanvas.width = MAP_WIDTH * TILE;
  mCanvas.height = MAP_HEIGHT * TILE;
  applyMapZoom();
  renderMap();
}

// --- Tools Logic (Paint, Fill, Line) ---
function getTileAt(x, y, layer = activeLayer) {
  return placedTiles.find((t) => t.x === x && t.y === y && (t.layer ?? 0) === layer);
}

function removeTileAt(x, y, layer = activeLayer) {
  placedTiles = placedTiles.filter((t) => !(t.x === x && t.y === y && (t.layer ?? 0) === layer));
}

function setTileAt(x, y, brush = selectedBrush, layer = activeLayer) {
  if (!brush) return;
  removeTileAt(x, y, layer);

  if (brush.type === 'sheet') {
    placedTiles.push({ x, y, tileX: brush.col, tileY: brush.row, layer });
    return;
  }

  if (brush.type === 'custom') {
    placedTiles.push({ x, y, customSpriteId: brush.id, layer });
  }
}

function doPaint(gx, gy) {
  if (activeTool === 'collision') {
    if (isErasing) {
      collisionTiles.delete(`${gx},${gy}`);
    } else if (isDrawing) {
      collisionTiles.set(`${gx},${gy}`, getCollisionColor());
    }
    renderMap();
    return;
  }

  if (isErasing) {
    const oldTile = _tileSnapshot(gx, gy, activeLayer);
    removeTileAt(gx, gy, activeLayer);
    _addToStroke(gx, gy, activeLayer, oldTile, null);
    renderMap();
    return;
  }

  if (isDrawing && selectedBrush) {
    const oldTile = _tileSnapshot(gx, gy, activeLayer);
    setTileAt(gx, gy, selectedBrush, activeLayer);
    const newTile = _tileSnapshot(gx, gy, activeLayer);
    _addToStroke(gx, gy, activeLayer, oldTile, newTile);
    renderMap();
  }
}

function floodFillCollision(startX, startY) {
  const color = getCollisionColor();
  const startKey = `${startX},${startY}`;
  const startFilled = collisionTiles.has(startKey);
  const startColor = startFilled ? collisionTiles.get(startKey) : null;
  // If already the same color, nothing to do
  if (startFilled && startColor === color) return;

  const stack = [[startX, startY]];
  const processed = new Set();
  while (stack.length > 0) {
    const [x, y] = stack.pop();
    const key = `${x},${y}`;
    if (x < 0 || y < 0 || x >= MAP_WIDTH || y >= MAP_HEIGHT || processed.has(key)) continue;
    const curFilled = collisionTiles.has(key);
    const curColor = curFilled ? collisionTiles.get(key) : null;
    // Continue flood into cells with same "state" as start
    if (curFilled !== startFilled || (startFilled && curColor !== startColor)) continue;
    processed.add(key);
    collisionTiles.set(key, color);
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  renderMap();
}

function floodFill(startX, startY) {
  if (activeTool === 'collision') { floodFillCollision(startX, startY); return; }
  if (!selectedBrush) return;

  const target = getTileAt(startX, startY, activeLayer);
  const targetType = tileSignature(target);
  const replacementType = brushSignature(selectedBrush);
  if (targetType === replacementType) return;

  const stack = [[startX, startY]];
  const processed = new Set();
  const floodChanges = [];

  while (stack.length > 0) {
    const [x, y] = stack.pop();
    const key = `${x},${y}`;

    if (x < 0 || y < 0 || x >= MAP_WIDTH || y >= MAP_HEIGHT || processed.has(key)) continue;

    const current = getTileAt(x, y, activeLayer);
    const currentType = tileSignature(current);

    if (currentType === targetType) {
      processed.add(key);
      const oldTile = current ? { ...current } : null;
      setTileAt(x, y, selectedBrush, activeLayer);
      const newTile = _tileSnapshot(x, y, activeLayer);
      floodChanges.push({ x, y, layer: activeLayer, oldTile, newTile });
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
  }

  _recordBatch(floodChanges);
  renderMap();
}

function finalizeLine(endX, endY) {
  if (!lineStart) return;
  if (activeTool === 'collision') {
    const color = getCollisionColor();
    const dx = Math.abs(endX - lineStart.x);
    const dy = Math.abs(endY - lineStart.y);
    if (dx > dy) {
      const start = Math.min(lineStart.x, endX), end = Math.max(lineStart.x, endX);
      for (let x = start; x <= end; x++) collisionTiles.set(`${x},${lineStart.y}`, color);
    } else {
      const start = Math.min(lineStart.y, endY), end = Math.max(lineStart.y, endY);
      for (let y = start; y <= end; y++) collisionTiles.set(`${lineStart.x},${y}`, color);
    }
    lineStart = null;
    renderMap();
    return;
  }
  if (!selectedBrush) return;

  const dx = Math.abs(endX - lineStart.x);
  const dy = Math.abs(endY - lineStart.y);
  const lineChanges = [];

  if (dx > dy) {
    const start = Math.min(lineStart.x, endX);
    const end = Math.max(lineStart.x, endX);
    for (let x = start; x <= end; x++) {
      const oldTile = _tileSnapshot(x, lineStart.y, activeLayer);
      setTileAt(x, lineStart.y, selectedBrush, activeLayer);
      const newTile = _tileSnapshot(x, lineStart.y, activeLayer);
      lineChanges.push({ x, y: lineStart.y, layer: activeLayer, oldTile, newTile });
    }
  } else {
    const start = Math.min(lineStart.y, endY);
    const end = Math.max(lineStart.y, endY);
    for (let y = start; y <= end; y++) {
      const oldTile = _tileSnapshot(lineStart.x, y, activeLayer);
      setTileAt(lineStart.x, y, selectedBrush, activeLayer);
      const newTile = _tileSnapshot(lineStart.x, y, activeLayer);
      lineChanges.push({ x: lineStart.x, y, layer: activeLayer, oldTile, newTile });
    }
  }

  _recordBatch(lineChanges);
  lineStart = null;
  renderMap();
}

function renderLinePreview(gx, gy) {
  renderMap(); // clear map back to committed state
  mCtx.fillStyle = 'rgba(0, 255, 0, 0.4)';

  const dx = Math.abs(gx - lineStart.x);
  const dy = Math.abs(gy - lineStart.y);

  if (dx > dy) {
    const start = Math.min(lineStart.x, gx);
    const end = Math.max(lineStart.x, gx);
    mCtx.fillRect(start * TILE, lineStart.y * TILE, (end - start + 1) * TILE, TILE);
  } else {
    const start = Math.min(lineStart.y, gy);
    const end = Math.max(lineStart.y, gy);
    mCtx.fillRect(lineStart.x * TILE, start * TILE, TILE, (end - start + 1) * TILE);
  }
}

// --- Map Interaction Events ---
const getGridCoords = (e) => {
  const rect = mCanvas.getBoundingClientRect();
  const scaleX = mCanvas.width / rect.width;
  const scaleY = mCanvas.height / rect.height;
  const px = (e.clientX - rect.left) * scaleX;
  const py = (e.clientY - rect.top) * scaleY;
  return {
    gx: Math.floor(px / TILE),
    gy: Math.floor(py / TILE),
  };
};

mCanvas.addEventListener('mousedown', (e) => {
  if (e.shiftKey || e.button === 1 || spacePanHeld) {
    e.preventDefault();
    isPanning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    scrollStartX = mapContainer.scrollLeft;
    scrollStartY = mapContainer.scrollTop;
    mCanvas.style.cursor = 'grabbing';
    return;
  }

  if (editorMode !== 'map') return;

  const { gx, gy } = getGridCoords(e);
  if (gx < 0 || gy < 0 || gx >= MAP_WIDTH || gy >= MAP_HEIGHT) return;

  // Map position picker — assign map grid coords to the active item slot
  if (activeItemSlotId && e.button === 0) {
    assignItemTile(gx, gy);
    renderMap();
    return;
  }

  // World object placement — click map to place selected world object
  if (_activeWOAssetId && e.button === 0) {
    placeWorldObjectAt(gx, gy);
    return;
  }

  if (activeTool === 'paint') {
    if (e.button === 0) isDrawing = true;
    if (e.button === 2) isErasing = true;
    _beginStroke();
    doPaint(gx, gy);
  } else if (activeTool === 'collision') {
    if (e.button === 0) isDrawing = true;
    if (e.button === 2) isErasing = true;
    _beginStroke();
    doPaint(gx, gy);
  } else if (activeTool === 'portal' && e.button === 0) {
    placePortalAt(gx, gy);
  } else if (activeTool === 'flood' && e.button === 0) {
    isDrawing = true;
    lastFloodTile = `${gx},${gy}`;
    floodFill(gx, gy);
  } else if (activeTool === 'line' && e.button === 0) {
    if (!lineStart) lineStart = { x: gx, y: gy };
    else finalizeLine(gx, gy);
  }
});

// Allow pan start from empty map-container area too (not just on canvas pixels).
mapContainer.addEventListener('mousedown', (e) => {
  if (e.target === mCanvas) return;
  if (!(e.shiftKey || e.button === 1 || spacePanHeld)) return;
  e.preventDefault();
  isPanning = true;
  panStartX = e.clientX;
  panStartY = e.clientY;
  scrollStartX = mapContainer.scrollLeft;
  scrollStartY = mapContainer.scrollTop;
  mapContainer.style.cursor = 'grabbing';
});

// Global mouseup
window.addEventListener('mouseup', () => {
  _commitStroke();
  isResizing = false;
  isDrawing = false;
  isErasing = false;
  spriteDrawing = false;
  lastFloodTile = null;

  if (isPanning) {
    isPanning = false;
    mCanvas.style.cursor = 'crosshair';
    mapContainer.style.cursor = '';
  }
});

// Global mousemove for resizing + panning
window.addEventListener('mousemove', (e) => {
  if (isResizing) {
    setSidebarWidth(e.clientX);
    return;
  }
  if (isPanning) {
    const dx = e.clientX - panStartX;
    const dy = e.clientY - panStartY;
    mapContainer.scrollLeft = scrollStartX - dx;
    mapContainer.scrollTop = scrollStartY - dy;
  }
});

// Local canvas mousemove for drawing previews + magnifier update
mCanvas.addEventListener('mousemove', (e) => {
  if (isPanning || editorMode !== 'map') return;

  const { gx, gy } = getGridCoords(e);

  if ((activeTool === 'paint' || activeTool === 'collision') && (isDrawing || isErasing)) {
    if (gx >= 0 && gy >= 0 && gx < MAP_WIDTH && gy < MAP_HEIGHT) doPaint(gx, gy);
  } else if (activeTool === 'flood' && isDrawing) {
    const key = `${gx},${gy}`;
    if (key !== lastFloodTile && gx >= 0 && gy >= 0 && gx < MAP_WIDTH && gy < MAP_HEIGHT) {
      lastFloodTile = key;
      floodFill(gx, gy);
    }
  } else if (activeTool === 'line' && lineStart) {
    renderLinePreview(gx, gy);
  }

  // Update info bar with hovered tile coords
  infoEl.textContent = `col=${gx}  row=${gy}` + (activeItemSlotId ? '  [click to place item here]' : '');

  // Highlight tile under cursor when picking item position
  if (activeItemSlotId && gx >= 0 && gy >= 0 && gx < MAP_WIDTH && gy < MAP_HEIGHT) {
    renderMap();
    mCtx.save();
    mCtx.globalAlpha = 0.5;
    mCtx.fillStyle = '#00ffff';
    mCtx.fillRect(gx * TILE, gy * TILE, TILE, TILE);
    mCtx.restore();
  }

  // Update zoom magnifier — centre on the tile under cursor (same coords as painting)
  syncZoomCanvasSize();
  const VIEW_TILES = 10;
  const viewPx = VIEW_TILES * TILE;
  // Centre of hovered tile in canvas-buffer pixels
  const cx = (gx + 0.5) * TILE;
  const cy = (gy + 0.5) * TILE;
  const sx = cx - viewPx / 2;
  const sy = cy - viewPx / 2;
  zCtx.clearRect(0, 0, zCanvas.width, zCanvas.height);
  zCtx.save();
  zCtx.imageSmoothingEnabled = false;
  zCtx.drawImage(mCanvas, sx, sy, viewPx, viewPx, 0, 0, zCanvas.width, zCanvas.height);
  zCtx.restore();
  // Red highlight on the centre tile
  const tileScreenW = (TILE / viewPx) * zCanvas.width;
  const tileScreenH = (TILE / viewPx) * zCanvas.height;
  const tileCenterX = (zCanvas.width - tileScreenW) / 2;
  const tileCenterY = (zCanvas.height - tileScreenH) / 2;
  zCtx.strokeStyle = '#f00';
  zCtx.lineWidth = 2;
  zCtx.strokeRect(tileCenterX, tileCenterY, tileScreenW, tileScreenH);
});

// --- Map Renderer ---
function renderMap() {
  mCtx.fillStyle = '#2a2a2a';
  mCtx.fillRect(0, 0, mCanvas.width, mCanvas.height);

  mCtx.strokeStyle = isGridWhite ? 'rgb(202, 202, 202)' : 'rgb(0, 0, 0)';
  mCtx.lineWidth = 0.25;

  for (let i = 0; i <= mCanvas.width; i += TILE) {
    mCtx.beginPath();
    mCtx.moveTo(i, 0);
    mCtx.lineTo(i, mCanvas.height);
    mCtx.stroke();
  }
  for (let j = 0; j <= mCanvas.height; j += TILE) {
    mCtx.beginPath();
    mCtx.moveTo(0, j);
    mCtx.lineTo(mCanvas.width, j);
    mCtx.stroke();
  }

  placedTiles
    .slice()
    .sort((a, b) => (a.layer ?? 0) - (b.layer ?? 0))
    .forEach((t) => {
      if (t.customSpriteId && customSpriteCanvases.has(t.customSpriteId)) {
        const c = customSpriteCanvases.get(t.customSpriteId);
        mCtx.drawImage(c, t.x * TILE, t.y * TILE, TILE, TILE);
        return;
      }

      if (Number.isFinite(t.tileX) && Number.isFinite(t.tileY)) {
        mCtx.drawImage(
          img,
          t.tileX * SLOT,
          t.tileY * SLOT,
          TILE,
          TILE,
          t.x * TILE,
          t.y * TILE,
          TILE,
          TILE
        );
      }
    });

  // Draw collision overlays — editor-only, semi-transparent colored cells
  for (const [key, color] of collisionTiles) {
    const [cx, cy] = key.split(',').map(Number);
    // Fill with the chosen color at ~50% opacity
    mCtx.save();
    mCtx.globalAlpha = 0.45;
    mCtx.fillStyle = color;
    mCtx.fillRect(cx * TILE, cy * TILE, TILE, TILE);
    mCtx.restore();
    // Draw a small 'C' marker so it's obvious even on dark tiles
    mCtx.fillStyle = 'rgba(255,255,255,0.75)';
    mCtx.font = `bold ${Math.max(6, TILE - 6)}px monospace`;
    mCtx.textAlign = 'center';
    mCtx.textBaseline = 'middle';
    mCtx.fillText('C', cx * TILE + TILE / 2, cy * TILE + TILE / 2);
  }

  // Draw spawn point overlays — map items with label 'spawn'
  for (const entry of mapItems) {
    if (entry.tileCol === null || entry.label.trim().toLowerCase() !== 'spawn') continue;
    const px = entry.tileCol * TILE;
    const py = entry.tileRow * TILE;
    mCtx.save();
    mCtx.globalAlpha = 0.55;
    mCtx.fillStyle = '#44ff88';
    mCtx.fillRect(px, py, TILE, TILE);
    mCtx.restore();
    mCtx.fillStyle = 'rgba(0,0,0,0.85)';
    mCtx.font = `bold ${Math.max(5, TILE - 7)}px monospace`;
    mCtx.textAlign = 'center';
    mCtx.textBaseline = 'middle';
    mCtx.fillText('S', px + TILE / 2, py + TILE / 2);
  }

  // Draw world object overlays — map items with label starting with 'worldobj:'
  for (const entry of mapItems) {
    if (entry.tileCol === null || !String(entry.label).startsWith('worldobj:')) continue;
    const px = entry.tileCol * TILE;
    const py = entry.tileRow * TILE;
    mCtx.save();
    mCtx.globalAlpha = 0.45;
    mCtx.fillStyle = '#cc8844';
    mCtx.fillRect(px, py, TILE, TILE);
    mCtx.restore();
    mCtx.fillStyle = 'rgba(255,255,255,0.9)';
    mCtx.font = `bold ${Math.max(5, TILE - 7)}px monospace`;
    mCtx.textAlign = 'center';
    mCtx.textBaseline = 'middle';
    mCtx.fillText('W', px + TILE / 2, py + TILE / 2);
  }

  // Draw portal overlays — map items with label starting with 'portal:'
  for (const entry of mapItems) {
    if (entry.tileCol === null || !String(entry.label).startsWith('portal:')) continue;
    const px = entry.tileCol * TILE;
    const py = entry.tileRow * TILE;
    mCtx.save();
    mCtx.globalAlpha = 0.55;
    mCtx.fillStyle = '#aa44ff';
    mCtx.fillRect(px, py, TILE, TILE);
    mCtx.restore();
    mCtx.fillStyle = 'rgba(255,255,255,0.9)';
    mCtx.font = `bold ${Math.max(5, TILE - 7)}px monospace`;
    mCtx.textAlign = 'center';
    mCtx.textBaseline = 'middle';
    mCtx.fillText('P', px + TILE / 2, py + TILE / 2);
  }

  // Draw minecart entrance overlays
  for (const entry of mapItems) {
    if (entry.tileCol === null || String(entry.label) !== 'minecart_entrance') continue;
    const px = entry.tileCol * TILE;
    const py = entry.tileRow * TILE;
    mCtx.save();
    mCtx.globalAlpha = 0.55;
    mCtx.fillStyle = '#3366ff';
    mCtx.fillRect(px, py, TILE, TILE);
    mCtx.restore();
    mCtx.fillStyle = 'rgba(255,255,255,0.9)';
    mCtx.font = `bold ${Math.max(5, TILE - 7)}px monospace`;
    mCtx.textAlign = 'center';
    mCtx.textBaseline = 'middle';
    mCtx.fillText('E', px + TILE / 2, py + TILE / 2);
  }

  // Draw minecart exit overlays
  for (const entry of mapItems) {
    if (entry.tileCol === null || !String(entry.label).startsWith('minecart_exit:')) continue;
    const px = entry.tileCol * TILE;
    const py = entry.tileRow * TILE;
    mCtx.save();
    mCtx.globalAlpha = 0.55;
    mCtx.fillStyle = '#ff6633';
    mCtx.fillRect(px, py, TILE, TILE);
    mCtx.restore();
    mCtx.fillStyle = 'rgba(255,255,255,0.9)';
    mCtx.font = `bold ${Math.max(5, TILE - 7)}px monospace`;
    mCtx.textAlign = 'center';
    mCtx.textBaseline = 'middle';
    mCtx.fillText('X', px + TILE / 2, py + TILE / 2);
  }
}

// --- Toolbar Events ---
document.getElementById('gridW').addEventListener('change', updateDimensions);
document.getElementById('gridH').addEventListener('change', updateDimensions);

// --- Map dropdown helpers ---

async function _loadMapList() {
  try {
    const resp = await fetch('/list-maps');
    if (!resp.ok) return;
    const data = await resp.json();
    const sel = document.getElementById('mapSelect');
    const current = sel.value;
    sel.innerHTML = '';
    for (const name of (data.maps || [])) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    }
    // Restore selection if still present, else default to first
    if (current && [...sel.options].some(o => o.value === current)) {
      sel.value = current;
    }
  } catch (e) {
    console.warn('Failed to load map list', e);
  }
}

function _currentMapName() {
  return document.getElementById('mapSelect').value.trim();
}

async function _loadMapByName(name) {
  const resp = await fetch(`/load-map?name=${encodeURIComponent(name)}`);
  const res = await resp.json();
  if (!resp.ok) {
    alert(res.detail || 'Failed to load map.');
    return;
  }

  const loadedTiles = Array.isArray(res.tiles) ? res.tiles : [];
  const loadedWidth = Number.parseInt(res.width, 10);
  const loadedHeight = Number.parseInt(res.height, 10);
  const maxX = loadedTiles.reduce((acc, t) => Math.max(acc, Number(t?.x) || 0), 0) + 1;
  const maxY = loadedTiles.reduce((acc, t) => Math.max(acc, Number(t?.y) || 0), 0) + 1;

  MAP_WIDTH = Number.isFinite(loadedWidth) && loadedWidth > 0 ? loadedWidth : Math.max(40, maxX);
  MAP_HEIGHT = Number.isFinite(loadedHeight) && loadedHeight > 0 ? loadedHeight : Math.max(25, maxY);

  document.getElementById('gridW').value = MAP_WIDTH;
  document.getElementById('gridH').value = MAP_HEIGHT;

  await hydrateCustomSprites(res.customSprites);

  placedTiles = loadedTiles
    .filter((t) => Number.isFinite(t?.x) && Number.isFinite(t?.y))
    .map((t) => ({
      x: t.x,
      y: t.y,
      tileX: Number.isFinite(t.tileX) ? t.tileX : undefined,
      tileY: Number.isFinite(t.tileY) ? t.tileY : undefined,
      customSpriteId: typeof t.customSpriteId === 'string' ? t.customSpriteId : undefined,
      layer: Number.isFinite(t.layer) ? t.layer : 0,
    }));

  collisionTiles.clear();
  if (Array.isArray(res.collisionTiles)) {
    for (const ct of res.collisionTiles) {
      if (Number.isFinite(ct?.x) && Number.isFinite(ct?.y)) {
        collisionTiles.set(`${ct.x},${ct.y}`, ct.color || '#ff0033');
      }
    }
  }

  hydrateMapItems(res.mapItems || []);

  updateDimensions();
  if (loadedTiles.length > 0) {
    const minX = loadedTiles.reduce((a, t) => Math.min(a, t.x || 0), Infinity);
    const minY = loadedTiles.reduce((a, t) => Math.min(a, t.y || 0), Infinity);
    mapContainer.scrollLeft = Math.max(0, minX * TILE * mapZoom - 80);
    mapContainer.scrollTop  = Math.max(0, minY * TILE * mapZoom - 80);
  } else {
    mapContainer.scrollLeft = 0;
    mapContainer.scrollTop  = 0;
  }
}

// Auto-load selected map when dropdown changes
document.getElementById('mapSelect').addEventListener('change', async () => {
  const name = _currentMapName();
  if (name) await _loadMapByName(name);
});

// Load map list on page load, then load default map
_loadMapList().then(async () => {
  const name = _currentMapName();
  if (name) await _loadMapByName(name);
});

document.getElementById('newMapBtn').addEventListener('click', async () => {
  const name = prompt('New map name (letters, numbers, _ and - only):');
  if (!name || !name.trim()) return;
  const safe = name.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(safe)) {
    alert('Invalid map name. Use only letters, numbers, _ and -.');
    return;
  }
  // Save an empty map under that name to create it
  const resp = await fetch('/save-map', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: safe,
      width: MAP_WIDTH,
      height: MAP_HEIGHT,
      tiles: [],
      customSprites: [],
      collisionTiles: [],
      mapItems: [],
    }),
  });
  if (!resp.ok) {
    const r = await resp.json();
    alert(r.detail || 'Failed to create map.');
    return;
  }
  // Clear editor
  placedTiles = [];
  collisionTiles.clear();
  hydrateMapItems([]);
  renderMap();
  // Refresh list and select the new map
  await _loadMapList();
  document.getElementById('mapSelect').value = safe;
});

document.getElementById('saveBtn').addEventListener('click', async () => {
  const name = _currentMapName();
  if (!name) {
    alert('No map selected.');
    return;
  }

  const collisionPayload = Array.from(collisionTiles.entries()).map(([key, color]) => {
    const [x, y] = key.split(',').map(Number);
    return { x, y, color };
  });

  const resp = await fetch('/save-map', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      width: MAP_WIDTH,
      height: MAP_HEIGHT,
      tiles: placedTiles,
      customSprites: customSpritesPayloadForSave(),
      collisionTiles: collisionPayload,
      mapItems: mapItemsPayload(),
    }),
  });

  const res = await resp.json();
  alert(res.message || 'Saved.');
});

document.getElementById('wipeMapBtn').addEventListener('click', async () => {
  const name = _currentMapName();
  if (!name) {
    alert('No map selected.');
    return;
  }
  if (!confirm(`Wipe all in-game data for "${name}"?\n\nThis removes all placed buildings, ground items, and (for cave maps) mine progress. The tile layout is preserved.\n\nThis cannot be undone.`)) return;

  const resp = await fetch('/wipe-map', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const res = await resp.json();
  if (!resp.ok) {
    alert(res.detail || 'Wipe failed.');
    return;
  }
  alert(`Map "${name}" wiped.`);
});

document.getElementById('clearBtn').addEventListener('click', () => {
  if (confirm('Wipe the entire map (tiles + collision zones + items)?')) {
    placedTiles = [];
    collisionTiles.clear();
    hydrateMapItems([]);
    renderMap();
  }
});

// Prevent context menu on right-click (since RMB is erase)
mCanvas.addEventListener('contextmenu', (e) => e.preventDefault());
mapContainer.addEventListener('contextmenu', (e) => e.preventDefault());

// =============================================================================
// Mix Palette — pick 2-10 tiles, then scatter them randomly/equally on the map
// =============================================================================

const mixSlotsEl   = document.getElementById('mixSlots');
const mixHintEl    = document.getElementById('mixHint');
const mixFillBtn   = document.getElementById('mixFillBtn');
const mixSlotCount = document.getElementById('mixSlotCount');

// Array of { col, row } | null, one entry per slot
let mixPalette = [null, null, null, null]; // starts at 4 slots
let mixActiveSlot = null; // index of the slot currently waiting for a tile pick

function buildMixSlots() {
  const count = parseInt(mixSlotCount.value, 10) || 4;
  // Resize palette array — preserve existing assignments
  while (mixPalette.length < count) mixPalette.push(null);
  mixPalette = mixPalette.slice(0, count);
  mixActiveSlot = null;

  mixSlotsEl.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const slot = document.createElement('div');
    slot.className = 'mix-slot' + (mixPalette[i] ? ' filled' : '');
    slot.dataset.index = i;
    slot.title = `Slot ${i + 1} — click to select, then pick a tile`;

    const canvas = document.createElement('canvas');
    canvas.width = TILE;
    canvas.height = TILE;
    canvas.className = 'mix-slot-canvas';
    slot.appendChild(canvas);

    const label = document.createElement('span');
    label.className = 'mix-slot-label';
    label.textContent = mixPalette[i] ? `${mixPalette[i].col},${mixPalette[i].row}` : '—';
    slot.appendChild(label);

    slot.addEventListener('click', () => {
      // Deselect if clicking the active slot again
      if (mixActiveSlot === i) {
        mixActiveSlot = null;
        updateMixSlotHighlights();
        if (mixHintEl) mixHintEl.textContent = 'Click a slot, then pick a tile above';
        return;
      }
      mixActiveSlot = i;
      updateMixSlotHighlights();
      if (mixHintEl) mixHintEl.textContent = `Slot ${i + 1} active — click a tile in the sheet above`;
    });

    mixSlotsEl.appendChild(slot);
    drawMixSlot(i);
  }
}

function updateMixSlotHighlights() {
  const slots = mixSlotsEl.querySelectorAll('.mix-slot');
  slots.forEach((s, i) => {
    s.classList.toggle('active-slot', i === mixActiveSlot);
  });
}

function drawMixSlot(index) {
  const slotEl = mixSlotsEl.children[index];
  if (!slotEl) return;
  const canvas = slotEl.querySelector('.mix-slot-canvas');
  const label  = slotEl.querySelector('.mix-slot-label');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, TILE, TILE);

  const entry = mixPalette[index];
  if (entry && img.complete) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, entry.col * SLOT, entry.row * SLOT, TILE, TILE, 0, 0, TILE, TILE);
    if (label) label.textContent = `${entry.col},${entry.row}`;
    slotEl.classList.add('filled');
  } else {
    ctx.fillStyle = '#1e1e1e';
    ctx.fillRect(0, 0, TILE, TILE);
    if (label) label.textContent = '—';
    slotEl.classList.remove('filled');
  }
}

// Called when user clicks the tilesheet — assign to active mix slot if one is waiting
function assignMixSlot(col, row) {
  if (mixActiveSlot === null) return false; // not waiting for a pick
  mixPalette[mixActiveSlot] = { col, row };
  drawMixSlot(mixActiveSlot);
  if (mixHintEl) mixHintEl.textContent = `Slot ${mixActiveSlot + 1} set to [${col}, ${row}]`;
  mixActiveSlot = null;
  updateMixSlotHighlights();
  return true; // consumed the click
}

// Mix Fill — scatter all filled palette tiles randomly+equally across the map
function doMixFill() {
  const filled = mixPalette.filter(Boolean);
  if (filled.length === 0) {
    if (mixHintEl) mixHintEl.textContent = 'Add tiles to the palette first!';
    return;
  }

  // Build a round-robin sequence shuffled to distribute evenly
  const totalCells = MAP_WIDTH * MAP_HEIGHT;
  let slotIndex = 0;

  for (let y = 0; y < MAP_HEIGHT; y++) {
    for (let x = 0; x < MAP_WIDTH; x++) {
      // Every cell gets the next tile in round-robin order (equal distribution)
      // Shuffle within groups of filled.length to add randomness while keeping equality
      const tile = filled[slotIndex % filled.length];
      slotIndex++;
      setTileAt(x, y, { type: 'sheet', col: tile.col, row: tile.row }, activeLayer);
    }
  }

  // Shuffle the placed tiles on this layer so the distribution looks random (not striped)
  // We do this by building a shuffled assignment map instead
  _mixFillShuffle(filled);

  renderMap();
  if (mixHintEl) mixHintEl.textContent = `Mix filled! ${filled.length} tile type${filled.length > 1 ? 's' : ''} across ${totalCells} cells`;
}

function _mixFillShuffle(filled) {
  // Build all positions on the active layer
  const positions = [];
  for (let y = 0; y < MAP_HEIGHT; y++) {
    for (let x = 0; x < MAP_WIDTH; x++) {
      positions.push({ x, y });
    }
  }

  // Fisher-Yates shuffle positions
  for (let i = positions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [positions[i], positions[j]] = [positions[j], positions[i]];
  }

  // Assign in round-robin order across shuffled positions — guarantees equal distribution
  placedTiles = placedTiles.filter(t => (t.layer ?? 0) !== activeLayer);
  positions.forEach((pos, idx) => {
    const tile = filled[idx % filled.length];
    placedTiles.push({ x: pos.x, y: pos.y, tileX: tile.col, tileY: tile.row, layer: activeLayer });
  });
}

// Hook into the existing sheet canvas click to intercept for mix palette AND map items assignment
sCanvas.addEventListener('mousedown', (e) => {
  const rect = sCanvas.getBoundingClientRect();
  const scaleX = img.width / rect.width;
  const scaleY = img.height / rect.height;
  const px = (e.clientX - rect.left) * scaleX;
  const py = (e.clientY - rect.top) * scaleY;
  const col = Math.floor(px / SLOT);
  const row = Math.floor(py / SLOT);
  assignMixSlot(col, row);
  assignItemTile(col, row); // map items registry
}, true); // capture phase so we run before the existing listener

// Slot count change
mixSlotCount.addEventListener('change', buildMixSlots);

// Mix Fill button
mixFillBtn.addEventListener('click', doMixFill);

// Init on image load (img.onload already calls initSpriteEditor + updateDimensions)
img.addEventListener('load', buildMixSlots);
// Also init now if image already loaded (e.g. cache hit)
if (img.complete) buildMixSlots();

// =============================================================================
// Map Items Registry
// Each item: { id, tileCol, tileRow, label, collision }
// tileCol/tileRow are the sprite sheet coords of the tile used to represent it.
// Saved to <mapname>_items.json on the server separately from the main map.
// =============================================================================

const itemsListEl = document.getElementById('itemsList');
let mapItems = [];          // array of { id, tileCol, tileRow, label, collision }
let activeItemSlotId = null; // id of item entry currently waiting for a tile pick
let _itemIdCounter = 1;

function _newItemId() { return `item_${_itemIdCounter++}`; }

function initMapItems() {
  document.getElementById('addItemBtn').addEventListener('click', () => {
    addItemEntry({ label: '', collision: false });
  });
  renderItemsList();
}

function addItemEntry({ id, tileCol, tileRow, label, collision } = {}) {
  const entry = {
    id: id || _newItemId(),
    tileCol: tileCol ?? null,
    tileRow: tileRow ?? null,
    label:     label ?? '',
    collision: collision ?? false,
  };
  mapItems.push(entry);
  renderItemsList();
  return entry;
}

function removeItemEntry(id) {
  mapItems = mapItems.filter(e => e.id !== id);
  if (activeItemSlotId === id) activeItemSlotId = null;
  renderItemsList();
}

function renderItemsList() {
  if (!itemsListEl) return;
  itemsListEl.innerHTML = '';

  if (mapItems.length === 0) {
    const hint = document.createElement('div');
    hint.style.cssText = 'color:#555;font-size:11px;padding:6px 4px;font-family:monospace;';
    hint.textContent = 'Press + to add an item';
    itemsListEl.appendChild(hint);
    return;
  }

  for (const entry of mapItems) {
    const row = document.createElement('div');
    row.className = 'item-entry';
    row.dataset.id = entry.id;

    // ── Tile drop slot ──
    const slot = document.createElement('div');
    slot.className = 'item-tile-slot' + (entry.tileCol !== null ? ' has-tile' : '');
    if (entry.id === activeItemSlotId) slot.classList.add('drop-target');
    slot.title = entry.tileCol !== null
      ? `Map position col=${entry.tileCol}, row=${entry.tileRow} — click then click map to re-assign`
      : 'Click here, then click a tile on the map to assign position';

    const slotCanvas = document.createElement('canvas');
    slotCanvas.width  = TILE;
    slotCanvas.height = TILE;
    slot.appendChild(slotCanvas);
    _drawItemSlotCanvas(slotCanvas, entry.tileCol, entry.tileRow, entry.label);

    slot.addEventListener('click', () => {
      if (activeItemSlotId === entry.id) {
        activeItemSlotId = null;
      } else {
        activeItemSlotId = entry.id;
      }
      mCanvas.style.cursor = activeItemSlotId ? 'crosshair' : '';
      renderItemsList();
    });
    row.appendChild(slot);

    // ── Label input ──
    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.className = 'item-label-input';
    labelInput.placeholder = 'name…';
    labelInput.value = entry.label;
    labelInput.addEventListener('input', () => { entry.label = labelInput.value; });
    row.appendChild(labelInput);

    // ── Collision checkbox ──
    const colWrap = document.createElement('div');
    colWrap.className = 'item-col-wrap';
    const colLabel = document.createElement('span');
    colLabel.textContent = 'col';
    const colCb = document.createElement('input');
    colCb.type = 'checkbox';
    colCb.className = 'item-col-cb';
    colCb.checked = entry.collision;
    colCb.title = 'Mark as collision tile';
    colCb.addEventListener('change', () => { entry.collision = colCb.checked; });
    colWrap.appendChild(colLabel);
    colWrap.appendChild(colCb);
    row.appendChild(colWrap);

    // ── Remove button ──
    const removeBtn = document.createElement('button');
    removeBtn.className = 'item-remove-btn';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove';
    removeBtn.addEventListener('click', () => removeItemEntry(entry.id));
    row.appendChild(removeBtn);

    itemsListEl.appendChild(row);
  }
}

function _drawItemSlotCanvas(canvas, tileCol, tileRow, label) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, TILE, TILE);
  const lbl = String(label || '');
  const isPortal = lbl.startsWith('portal:');
  const isSpawn  = lbl.trim().toLowerCase() === 'spawn';
  const isWorldObj = lbl.startsWith('worldobj:');
  const isMinecartExit = lbl.startsWith('minecart_exit:');
  const isMinecartEntrance = lbl === 'minecart_entrance';
  const isSpecial = isPortal || isSpawn || isWorldObj || isMinecartExit || isMinecartEntrance;
  if (tileCol !== null && isSpecial) {
    // Show a coloured pin for special items
    const color = isPortal ? '#7733cc' : isWorldObj ? '#cc8844' : isSpawn ? '#22aa55'
      : (isMinecartExit || isMinecartEntrance) ? '#cc6622' : '#446688';
    const letter = isPortal ? 'P' : isWorldObj ? 'W' : isSpawn ? 'S'
      : isMinecartExit ? 'X' : 'E';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, TILE, TILE);
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${TILE - 4}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(letter, TILE / 2, TILE / 2);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = `7px monospace`;
    ctx.fillText(`${tileCol},${tileRow}`, TILE / 2, TILE - 3);
  } else if (tileCol !== null) {
    // Generic map item — show position marker (tileCol/tileRow are map coords, not spritesheet)
    ctx.fillStyle = '#223344';
    ctx.fillRect(0, 0, TILE, TILE);
    ctx.fillStyle = '#88ccff';
    ctx.font = `bold ${TILE - 4}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('I', TILE / 2, TILE / 2);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = `7px monospace`;
    ctx.fillText(`${tileCol},${tileRow}`, TILE / 2, TILE - 3);
  } else {
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, TILE, TILE);
    ctx.fillStyle = '#333';
    ctx.font = `${TILE - 2}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('?', TILE / 2, TILE / 2);
  }
}

// Called on sheet click or map eyedrop — assign tile to the active item slot (if any)
function assignItemTile(col, row) {
  if (!activeItemSlotId) return false;
  const entry = mapItems.find(e => e.id === activeItemSlotId);
  if (!entry) { activeItemSlotId = null; return false; }
  entry.tileCol = col;
  entry.tileRow = row;
  activeItemSlotId = null;
  mCanvas.style.cursor = '';
  renderItemsList();
  return true;
}

// Serialize items for save
function mapItemsPayload() {
  return mapItems.map(e => ({
    id: e.id,
    tileCol: e.tileCol,
    tileRow: e.tileRow,
    label: e.label,
    collision: e.collision,
  }));
}

// Restore items after load
function hydrateMapItems(items) {
  mapItems = [];
  _itemIdCounter = 1;
  if (!Array.isArray(items)) { renderItemsList(); return; }
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const id = raw.id || _newItemId();
    // Keep counter ahead of any loaded ids
    const m = /_(\d+)$/.exec(id);
    if (m) _itemIdCounter = Math.max(_itemIdCounter, Number(m[1]) + 1);
    mapItems.push({
      id,
      tileCol:   raw.tileCol   ?? null,
      tileRow:   raw.tileRow   ?? null,
      label:     raw.label     ?? '',
      collision: raw.collision ?? false,
    });
  }
  renderItemsList();
}

// =============================================================================
// Portal Tool
// =============================================================================

function placePortalAt(gx, gy) {
  const target = prompt(`Portal at tile (col=${gx}, row=${gy})\n\nEnter target map name (e.g. cave_01):`, '');
  if (!target || !target.trim()) return;
  const mapName = target.trim();
  addItemEntry({ tileCol: gx, tileRow: gy, label: `portal:${mapName}`, collision: false });
  renderMap();
}

// =============================================================================
// World Objects Picker — click to place registered world objects on the map
// =============================================================================

let _woAssets = [];           // cached asset definitions from server
let _activeWOAssetId = null;  // which world object is selected for placement

async function loadWorldObjectAssets() {
  try {
    const resp = await fetch('/api/assets/world-objects');
    _woAssets = await resp.json();
  } catch (e) {
    _woAssets = [];
  }
  renderWOPicker();
}

function renderWOPicker() {
  const list = document.getElementById('woPickerList');
  if (!list) return;
  list.innerHTML = '';

  if (_woAssets.length === 0) {
    const hint = document.createElement('div');
    hint.style.cssText = 'color:#555;font-size:11px;padding:6px 4px;font-family:monospace;';
    hint.textContent = 'No world objects defined';
    list.appendChild(hint);
    return;
  }

  for (const wo of _woAssets) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px;cursor:pointer;border-bottom:1px solid #1a1a2e;';
    if (_activeWOAssetId === wo.id) {
      row.style.background = '#2a3a2a';
      row.style.borderLeft = '3px solid #66ff88';
    }

    // Tile preview
    const cv = document.createElement('canvas');
    cv.width = 20; cv.height = 20;
    cv.style.cssText = 'image-rendering:pixelated;border:1px solid #333;flex-shrink:0;';
    const sprite = wo.sprite || {};
    if (sprite.type === 'tilemap' && img.complete) {
      const ctx = cv.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, (sprite.tileCol || 0) * SLOT, (sprite.tileRow || 0) * SLOT, TILE, TILE, 0, 0, 20, 20);
    }

    const label = document.createElement('span');
    label.style.cssText = 'color:#ddd;font-size:11px;font-family:monospace;';
    label.textContent = wo.label || wo.id;

    row.appendChild(cv);
    row.appendChild(label);

    row.addEventListener('click', () => {
      if (_activeWOAssetId === wo.id) {
        _activeWOAssetId = null;
        mCanvas.style.cursor = '';
      } else {
        _activeWOAssetId = wo.id;
        mCanvas.style.cursor = 'crosshair';
      }
      renderWOPicker();
    });

    list.appendChild(row);
  }
}

function placeWorldObjectAt(gx, gy) {
  if (!_activeWOAssetId) return false;
  const wo = _woAssets.find(w => w.id === _activeWOAssetId);
  if (!wo) return false;
  addItemEntry({
    tileCol: gx,
    tileRow: gy,
    label: `worldobj:${wo.id}`,
    collision: wo.solid ?? true,
  });
  renderMap();
  return true;
}

// Load world objects when tilesheet image loads
img.addEventListener('load', loadWorldObjectAssets);
