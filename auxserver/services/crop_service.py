"""
crop_service.py — Server-side crop growing, harvesting, and pickup.

Crops auto-plant on eligible fertile-soil tiles defined in level_01_items.json
with label "crop_zone". They cycle:
  planted → growing (5 min) → ready (5 min) → harvested (reset, replant after 1s)

Players and NPCs within HARVEST_DIST can harvest a ready crop to receive a vegetable.
"""

import json
import time
from pathlib import Path

from core.constants import TILE_SIZE
MAPS_DIR      = Path(__file__).resolve().parent.parent / "maps"

GROW_TIME     = 300.0   # 5 minutes to go from planted → ready to sprout
MATURE_TIME   = 300.0   # 5 minutes from sprout → ready to harvest
REPLANT_DELAY = 2.0     # seconds after harvest before replanting
HARVEST_DIST  = TILE_SIZE * 1.5

# Spritesheet frame coords (tileX, tileY) for rendering on the client
FRAME_SPROUT  = {"tileX": 44, "tileY": 23}   # small growing plant
FRAME_MATURE  = {"tileX": 22, "tileY": 11}   # mature / ready to harvest
FRAME_SOIL    = {"tileX": 22, "tileY": 11}   # fertile soil tile (eligible ground)


def _load_fertile_tiles(map_name: str) -> set[tuple[int, int]]:
    """Load all tiles with tileX=22, tileY=11 (fertile soil) from the map."""
    map_path = MAPS_DIR / f"{map_name}.json"
    if not map_path.exists():
        return set()
    try:
        data = json.loads(map_path.read_text(encoding="utf-8"))
        fertile = set()
        for t in data.get("tiles", []):
            if t.get("tileX") == 22 and t.get("tileY") == 11:
                fertile.add((int(t["x"]), int(t["y"])))
        return fertile
    except Exception as e:
        print(f"[crops] Failed to load fertile tiles: {e}")
        return set()


class CropManager:
    def __init__(self, map_name: str = "level_01"):
        self._fertile: set[tuple[int, int]] = _load_fertile_tiles(map_name)
        self._crops: dict[str, dict] = {}
        self._next_id = 0
        print(f"[crops] Loaded {len(self._fertile)} fertile soil tiles")

    # ── Public API ───────────────────────────────────────────────────────────

    def get_all(self) -> list[dict]:
        """Return client-safe crop list."""
        return [self._client_view(c) for c in self._crops.values()]

    def try_plant(self, world_x: float, world_y: float, planter_id: str) -> str | None:
        """
        Attempt to plant a seed at world coords. Returns 'planted' on success,
        error string on failure.
        """
        col = int(world_x // TILE_SIZE)
        row = int(world_y // TILE_SIZE)
        # Must be fertile soil
        if (col, row) not in self._fertile:
            return "not_soil"
        # Can't plant on an already-occupied tile
        for crop in self._crops.values():
            if crop["col"] == col and crop["row"] == row and crop["stage"] != "harvested":
                return "occupied"
        self._plant(col, row)
        print(f"[crops] {planter_id} planted seed at ({col},{row})")
        return "planted"

    def try_harvest(self, crop_id: str, harvester_id: str) -> str | None:
        """
        Returns 'vegetable' if successfully harvested, else None.
        Works for both player pids and NPC ids.
        """
        crop = self._crops.get(crop_id)
        if not crop or crop["stage"] != "ready":
            return None
        crop["stage"]       = "harvested"
        crop["harvested_at"] = time.time()
        print(f"[crops] {crop_id} harvested by {harvester_id}")
        return "vegetable"

    def tick(self, dt: float):
        now = time.time()
        for crop in list(self._crops.values()):
            stage = crop["stage"]
            if stage == "growing":
                if now - crop["planted_at"] >= GROW_TIME:
                    crop["stage"] = "ready"
            # harvested stays harvested — player must replant with a seed

    # ── Internal ─────────────────────────────────────────────────────────────

    def _plant(self, col: int, row: int):
        self._next_id += 1
        cid = f"crop_{self._next_id}"
        cx = col * TILE_SIZE + TILE_SIZE / 2
        cy = row * TILE_SIZE + TILE_SIZE / 2
        self._crops[cid] = {
            "id":          cid,
            "x":           cx,
            "y":           cy,
            "col":         col,
            "row":         row,
            "stage":       "growing",
            "planted_at":  time.time(),
            "harvested_at": None,
        }

    def _client_view(self, crop: dict) -> dict:
        stage = crop["stage"]
        now = time.time()
        if stage == "growing":
            elapsed  = now - crop["planted_at"]
            progress = min(1.0, elapsed / GROW_TIME)
        elif stage == "ready":
            progress = 1.0
        else:
            progress = 0.0

        frame = FRAME_MATURE if stage == "ready" else (
            FRAME_SPROUT if stage == "growing" else None
        )
        return {
            "id":       crop["id"],
            "x":        crop["x"],
            "y":        crop["y"],
            "stage":    stage,
            "progress": round(progress, 2),
            "frame":    frame,
        }


crop_manager = CropManager()
