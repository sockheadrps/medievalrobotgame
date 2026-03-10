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

// Layer State
let activeLayer = 0;

let placedTiles = [];
let customSprites = [];
const customSpriteCanvases = new Map();
let customSpriteIdCounter = 1;

let isDrawing = false;
let isErasing = false;

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

// --- Initialization ---
img.onload = () => {
  sCanvas.width = img.width;
  sCanvas.height = img.height;
  sCtx.drawImage(img, 0, 0);
  zCtx.imageSmoothingEnabled = false;

  initSpriteEditor();
  updateDimensions();
  updateSelectionDisplay();
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
  const rect = sCanvas.getBoundingClientRect();
  const scaleX = img.width / rect.width;
  const scaleY = img.height / rect.height;
  const px = (e.clientX - rect.left) * scaleX;
  const py = (e.clientY - rect.top) * scaleY;
  const col = Math.floor(px / SLOT);
  const row = Math.floor(py / SLOT);

  const viewSize = 6 * SLOT;
  const sx = col * SLOT - viewSize / 2 + SLOT / 2;
  const sy = row * SLOT - viewSize / 2 + SLOT / 2;

  zCtx.clearRect(0, 0, zCanvas.width, zCanvas.height);
  zCtx.drawImage(img, sx, sy, viewSize, viewSize, 0, 0, zCanvas.width, zCanvas.height);

  zCtx.strokeStyle = '#f00';
  zCtx.lineWidth = 2;
  const centerSize = (TILE / viewSize) * zCanvas.width;
  const centerPos = (zCanvas.width - centerSize) / 2;
  zCtx.strokeRect(centerPos, centerPos, centerSize, centerSize);
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
    infoEl.textContent = `col=${col}  row=${row}  frame=${frame}  (px ${col * SLOT}, ${row * SLOT})   COLS=${cols}`;
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
  if (isErasing) {
    removeTileAt(gx, gy, activeLayer);
    renderMap();
    return;
  }

  if (isDrawing && selectedBrush) {
    setTileAt(gx, gy, selectedBrush, activeLayer);
    renderMap();
  }
}

function floodFill(startX, startY) {
  if (!selectedBrush) return;

  const target = getTileAt(startX, startY, activeLayer);
  const targetType = tileSignature(target);
  const replacementType = brushSignature(selectedBrush);
  if (targetType === replacementType) return;

  const stack = [[startX, startY]];
  const processed = new Set();

  while (stack.length > 0) {
    const [x, y] = stack.pop();
    const key = `${x},${y}`;

    if (x < 0 || y < 0 || x >= MAP_WIDTH || y >= MAP_HEIGHT || processed.has(key)) continue;

    const current = getTileAt(x, y, activeLayer);
    const currentType = tileSignature(current);

    if (currentType === targetType) {
      processed.add(key);
      setTileAt(x, y, selectedBrush, activeLayer);
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
  }

  renderMap();
}

function finalizeLine(endX, endY) {
  if (!lineStart || !selectedBrush) return;

  const dx = Math.abs(endX - lineStart.x);
  const dy = Math.abs(endY - lineStart.y);

  if (dx > dy) {
    const start = Math.min(lineStart.x, endX);
    const end = Math.max(lineStart.x, endX);
    for (let x = start; x <= end; x++) {
      setTileAt(x, lineStart.y, selectedBrush, activeLayer);
    }
  } else {
    const start = Math.min(lineStart.y, endY);
    const end = Math.max(lineStart.y, endY);
    for (let y = start; y <= end; y++) {
      setTileAt(lineStart.x, y, selectedBrush, activeLayer);
    }
  }

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

  if (activeTool === 'paint') {
    if (e.button === 0) isDrawing = true;
    if (e.button === 2) isErasing = true;
    doPaint(gx, gy);
  } else if (activeTool === 'flood' && e.button === 0) {
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
  isResizing = false;
  isDrawing = false;
  isErasing = false;
  spriteDrawing = false;

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

// Local canvas mousemove for drawing previews
mCanvas.addEventListener('mousemove', (e) => {
  if (isPanning || editorMode !== 'map') return;

  const { gx, gy } = getGridCoords(e);

  if (activeTool === 'paint' && (isDrawing || isErasing)) {
    if (gx >= 0 && gy >= 0 && gx < MAP_WIDTH && gy < MAP_HEIGHT) doPaint(gx, gy);
  } else if (activeTool === 'line' && lineStart) {
    renderLinePreview(gx, gy);
  }
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
}

// --- Toolbar Events ---
document.getElementById('gridW').addEventListener('change', updateDimensions);
document.getElementById('gridH').addEventListener('change', updateDimensions);

document.getElementById('saveBtn').addEventListener('click', async () => {
  const name = document.getElementById('mapName').value.trim();
  if (!name) {
    alert('Enter a map name first.');
    return;
  }

  const resp = await fetch('/save-map', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      width: MAP_WIDTH,
      height: MAP_HEIGHT,
      tiles: placedTiles,
      customSprites: customSpritesPayloadForSave(),
    }),
  });

  const res = await resp.json();
  alert(res.message || 'Saved.');
});

document.getElementById('loadBtn').addEventListener('click', async () => {
  const name = document.getElementById('mapName').value.trim();
  if (!name) {
    alert('Enter a map name first.');
    return;
  }

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

  updateDimensions();
  alert(`Loaded "${name}"`);
});

document.getElementById('clearBtn').addEventListener('click', () => {
  if (confirm('Wipe the entire map?')) {
    placedTiles = [];
    renderMap();
  }
});

// Prevent context menu on right-click (since RMB is erase)
mCanvas.addEventListener('contextmenu', (e) => e.preventDefault());
mapContainer.addEventListener('contextmenu', (e) => e.preventDefault());
