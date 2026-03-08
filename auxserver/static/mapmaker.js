// =========================
// Tile Map Editor (Layered)
// =========================

const TILE = 16,
  SPACING = 1,
  SLOT = TILE + SPACING;

let MAP_WIDTH = 40,
  MAP_HEIGHT = 25;

// Zoom State
let mapZoom = 2.0;
const ZOOM_SPEED = 0.1,
  MIN_ZOOM = 0.5,
  MAX_ZOOM = 5.0;

// Tool State
let activeTool = 'paint';
let lineStart = null;
let selectedTile = null;

// ✅ Layer State
// 0 = ground (grass, floor), 1 = object (trees, props, walls), 2+ optional
let activeLayer = 0;

let placedTiles = [];

let isDrawing = false,
  isErasing = false;

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

let isGridWhite = true;
let isPanning = false;
let panStartX = 0,
  panStartY = 0;
let scrollStartX = 0,
  scrollStartY = 0;
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

// --- Initialization ---
img.onload = () => {
  sCanvas.width = img.width;
  sCanvas.height = img.height;
  sCtx.drawImage(img, 0, 0);
  zCtx.imageSmoothingEnabled = false;
  updateDimensions();
};

window.setTool = function (tool) {
  activeTool = tool;
  document
    .querySelectorAll('.tool-btn')
    .forEach((b) => b.classList.remove('active'));
  const btn = document.getElementById(
    'btn' + tool.charAt(0).toUpperCase() + tool.slice(1)
  );
  if (btn) btn.classList.add('active');
  lineStart = null;
  renderMap();
};

window.toggleGridColor = function () {
  isGridWhite = !isGridWhite;
  const btn = document.getElementById('btnGridToggle');
  if (btn) btn.textContent = isGridWhite ? '🔳 Grid: White' : '🔲 Grid: Black';
  renderMap();
};

// ✅ Optional helper so you can switch layers via console or a future UI
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
  zCtx.drawImage(
    img,
    sx,
    sy,
    viewSize,
    viewSize,
    0,
    0,
    zCanvas.width,
    zCanvas.height
  );

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

  selectedTile = {
    col: Math.floor(px / SLOT),
    row: Math.floor(py / SLOT),
  };

  const frame = selectedTile.row * cols + selectedTile.col;

  const sel = document.getElementById('selection-display');
  if (sel) sel.textContent = `Selected: [${selectedTile.col}, ${selectedTile.row}]`;

  if (infoEl) {
    infoEl.textContent = `col=${selectedTile.col}  row=${selectedTile.row}  frame=${frame}  (px ${selectedTile.col * SLOT}, ${selectedTile.row * SLOT})   COLS=${cols}`;
  }
});

// --- Map Dimension Logic ---
function updateDimensions() {
  MAP_WIDTH = parseInt(document.getElementById('gridW').value) || 40;
  MAP_HEIGHT = parseInt(document.getElementById('gridH').value) || 25;
  mCanvas.width = MAP_WIDTH * TILE;
  mCanvas.height = MAP_HEIGHT * TILE;
  applyMapZoom();
  renderMap();
}

// --- Tools Logic (Paint, Dump, Line) ---
function getTileAt(x, y, layer = activeLayer) {
  return placedTiles.find(
    (t) => t.x === x && t.y === y && (t.layer ?? 0) === layer
  );
}

function removeTileAt(x, y, layer = activeLayer) {
  placedTiles = placedTiles.filter(
    (t) => !(t.x === x && t.y === y && (t.layer ?? 0) === layer)
  );
}

function setTileAt(x, y, tileX, tileY, layer = activeLayer) {
  removeTileAt(x, y, layer);
  placedTiles.push({ x, y, tileX, tileY, layer });
}

function doPaint(gx, gy) {
  if (isErasing) {
    removeTileAt(gx, gy, activeLayer);
    renderMap();
    return;
  }

  if (isDrawing && selectedTile) {
    setTileAt(gx, gy, selectedTile.col, selectedTile.row, activeLayer);
    renderMap();
  }
}

function floodFill(startX, startY) {
  if (!selectedTile) return;

  const target = getTileAt(startX, startY, activeLayer);
  const targetType = target ? `${target.tileX},${target.tileY}` : 'empty';
  const replacementType = `${selectedTile.col},${selectedTile.row}`;
  if (targetType === replacementType) return;

  const stack = [[startX, startY]];
  const processed = new Set();

  while (stack.length > 0) {
    const [x, y] = stack.pop();
    const key = `${x},${y}`;

    if (
      x < 0 ||
      y < 0 ||
      x >= MAP_WIDTH ||
      y >= MAP_HEIGHT ||
      processed.has(key)
    )
      continue;

    const current = getTileAt(x, y, activeLayer);
    const currentType = current ? `${current.tileX},${current.tileY}` : 'empty';

    if (currentType === targetType) {
      processed.add(key);

      setTileAt(x, y, selectedTile.col, selectedTile.row, activeLayer);

      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
  }

  renderMap();
}

function finalizeLine(endX, endY) {
  if (!lineStart || !selectedTile) return;

  const dx = Math.abs(endX - lineStart.x);
  const dy = Math.abs(endY - lineStart.y);

  if (dx > dy) {
    const start = Math.min(lineStart.x, endX),
      end = Math.max(lineStart.x, endX);
    for (let x = start; x <= end; x++) {
      setTileAt(x, lineStart.y, selectedTile.col, selectedTile.row, activeLayer);
    }
  } else {
    const start = Math.min(lineStart.y, endY),
      end = Math.max(lineStart.y, endY);
    for (let y = start; y <= end; y++) {
      setTileAt(lineStart.x, y, selectedTile.col, selectedTile.row, activeLayer);
    }
  }

  lineStart = null;
  renderMap();
}

function renderLinePreview(gx, gy) {
  renderMap(); // clear map back to committed state
  mCtx.fillStyle = 'rgba(0, 255, 0, 0.4)';

  const dx = Math.abs(gx - lineStart.x),
    dy = Math.abs(gy - lineStart.y);

  if (dx > dy) {
    const start = Math.min(lineStart.x, gx),
      end = Math.max(lineStart.x, gx);
    mCtx.fillRect(
      start * TILE,
      lineStart.y * TILE,
      (end - start + 1) * TILE,
      TILE
    );
  } else {
    const start = Math.min(lineStart.y, gy),
      end = Math.max(lineStart.y, gy);
    mCtx.fillRect(
      lineStart.x * TILE,
      start * TILE,
      TILE,
      (end - start + 1) * TILE
    );
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
    // Start Panning
    e.preventDefault();
    isPanning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    scrollStartX = mapContainer.scrollLeft;
    scrollStartY = mapContainer.scrollTop;
    mCanvas.style.cursor = 'grabbing';
    return;
  }

  // Normal Tool Logic
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
    return;
  }
});

// Local canvas mousemove for drawing previews
mCanvas.addEventListener('mousemove', (e) => {
  if (isPanning) return;

  const { gx, gy } = getGridCoords(e);

  if (activeTool === 'paint' && (isDrawing || isErasing)) {
    if (gx >= 0 && gy >= 0 && gx < MAP_WIDTH && gy < MAP_HEIGHT) doPaint(gx, gy);
  } else if (activeTool === 'line' && lineStart) {
    renderLinePreview(gx, gy);
  }
});

// --- Map Renderer ---
function renderMap() {
  // Base Fill (shows through only if BOTH layers are empty and sprite is transparent)
  mCtx.fillStyle = '#2a2a2a';
  mCtx.fillRect(0, 0, mCanvas.width, mCanvas.height);

  // Grid Lines
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

  // ✅ Draw tiles sorted by layer (ground first, then objects)
  placedTiles
    .slice()
    .sort((a, b) => (a.layer ?? 0) - (b.layer ?? 0))
    .forEach((t) => {
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
    }),
  });
  const res = await resp.json();
  alert(res.message);
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
  const maxX = loadedTiles.reduce((acc, t) => Math.max(acc, t.x ?? 0), 0) + 1;
  const maxY = loadedTiles.reduce((acc, t) => Math.max(acc, t.y ?? 0), 0) + 1;

  MAP_WIDTH = Number.isFinite(loadedWidth) && loadedWidth > 0 ? loadedWidth : Math.max(40, maxX);
  MAP_HEIGHT = Number.isFinite(loadedHeight) && loadedHeight > 0 ? loadedHeight : Math.max(25, maxY);

  document.getElementById('gridW').value = MAP_WIDTH;
  document.getElementById('gridH').value = MAP_HEIGHT;

  // ✅ Coerce loaded tiles to include layer (default 0 if missing)
  placedTiles = loadedTiles.map((t) => ({
    x: t.x,
    y: t.y,
    tileX: t.tileX,
    tileY: t.tileY,
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
