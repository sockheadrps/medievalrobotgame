"""Cave mining system — procedural mine grid with fog-of-war and ore seeding.

Each player gets their own mine grid layered over cave_01. The grid tracks:
- tile_type: open / wall / hardwall / bedrock
- tile_known: has the player ever seen this tile
- tile_visible: is the tile currently lit (within light radius of an open tile)
- ore_type / ore_amount: pre-seeded resource data for wall/hardwall tiles
- vein_id: membership in a pure-vein cluster (30+ depth only)
"""

from __future__ import annotations

import json
import math
import random
from pathlib import Path
from typing import Optional

from core.config import MAPS_DIR
from core.constants import TILE_SIZE

# ── Constants ────────────────────────────────────────────────────────────────

# Base cave is 40x40 (indices 0-39). Mineable area extends 15 tiles beyond.
BASE_SIZE = 40
EXTEND = 15
GRID_MIN = -EXTEND          # -15
GRID_MAX = BASE_SIZE + EXTEND  # 55
GRID_SIZE = GRID_MAX - GRID_MIN  # 70

# Bedrock boundary (1 tile thick at the very edge of the 70x70 area)
BEDROCK_BORDER = 1

# Visibility radii
OPEN_LIGHT_RADIUS = 5       # open tiles illuminate this far
WALL_REVEAL_RADIUS = 3      # walls become known within this range of open tiles

# Entry points (col, row) in base cave coordinates
ENTRANCES = [
    (20, 0),    # top edge — north shaft
    (20, 39),   # bottom edge — south shaft
    (0, 20),    # left edge — west shaft
]

# Hardwall depth threshold
HARDWALL_DEPTH = 30

# ── Ore distribution ─────────────────────────────────────────────────────────

# Probability weights by depth zone.  Values are (chance_per_tile, ore_type).
# Multiple entries can match; first roll that hits wins.
# Evaluated top-to-bottom; "stone" is the fallback.

def _ore_table(depth: float) -> list[tuple[float, str, int, int]]:
    """Return [(chance, ore_type, min_amt, max_amt), ...] for a given depth.
    Evaluated in order; first hit wins.  Last entry is guaranteed fallback.
    """
    table = []

    if depth >= 15:
        # Ramp factor: 0.0 at depth 15, 1.0 at depth 30, capped at 1.0
        ramp = min(1.0, (depth - 15) / 15)
        table.append((0.03 * ramp, "geode", 1, 1))
        table.append((0.04 * ramp, "raw_gold_ore", 1, 2))

    if depth >= 5:
        iron_ramp = min(1.0, (depth - 5) / 10)  # 0 at 5, 1.0 at 15
        table.append((0.08 * iron_ramp, "raw_iron_ore", 1, 3))

    if depth >= 0:
        table.append((0.12, "coal", 1, 2))
        table.append((0.15, "clay", 1, 3))

    # Fallback: stone always
    table.append((1.0, "stone", 1, 3))
    return table


def _roll_ore(rng: random.Random, depth: float) -> tuple[str, int]:
    """Roll ore for a tile at the given depth. Returns (ore_type, amount)."""
    table = _ore_table(depth)
    for chance, ore_type, mn, mx in table:
        if rng.random() < chance:
            return ore_type, rng.randint(mn, mx)
    return "stone", 1


# ── Vein generation ──────────────────────────────────────────────────────────

def _generate_veins(rng: random.Random, grid: dict, depth_map: dict) -> None:
    """Generate pure-vein clusters on hardwall tiles (depth 30+).
    Modifies grid tiles in-place, setting vein_id and overriding ore_type.
    """
    vein_counter = 0
    claimed: set[tuple[int, int]] = set()

    # Collect all hardwall tiles
    hardwall_tiles = [
        (c, r) for (c, r), t in grid.items()
        if t["type"] == "hardwall" and (c, r) not in claimed
    ]
    rng.shuffle(hardwall_tiles)

    for col, row in hardwall_tiles:
        if (col, row) in claimed:
            continue
        depth = depth_map.get((col, row), 0)
        if depth < HARDWALL_DEPTH:
            continue

        # Roll for vein anchor: ~2% iron, ~0.5% gold
        roll = rng.random()
        if roll < 0.005:
            vein_ore = "gold_nugget"
        elif roll < 0.025:
            vein_ore = "iron_nugget"
        else:
            continue

        # Flood-fill cluster of 3-5 tiles
        vein_id = f"vein_{vein_counter}"
        vein_counter += 1
        cluster_size = rng.randint(3, 5)
        cluster = [(col, row)]
        frontier = [(col, row)]
        claimed.add((col, row))

        while len(cluster) < cluster_size and frontier:
            cx, cy = frontier.pop(0)
            for dx, dy in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
                nx, ny = cx + dx, cy + dy
                if (nx, ny) in claimed:
                    continue
                tile = grid.get((nx, ny))
                if tile and tile["type"] == "hardwall":
                    claimed.add((nx, ny))
                    cluster.append((nx, ny))
                    frontier.append((nx, ny))
                    if len(cluster) >= cluster_size:
                        break

        # Mark all cluster tiles
        for cx, cy in cluster:
            t = grid[(cx, cy)]
            t["vein_id"] = vein_id
            t["ore_type"] = vein_ore
            t["ore_amount"] = rng.randint(2, 4)


# ── MineGrid class ───────────────────────────────────────────────────────────

class MineGrid:
    """Per-player mine grid for cave_01."""

    def __init__(self, player_id: str, seed: int | None = None):
        self.player_id = player_id
        self.seed = seed or hash(player_id) & 0xFFFFFFFF
        # grid[(col, row)] = tile dict
        self.grid: dict[tuple[int, int], dict] = {}
        # Precomputed depth from nearest entrance
        self.depth_map: dict[tuple[int, int], float] = {}
        # Pity counter for veins
        self.tiles_since_vein = 0

    # ── Initialization ───────────────────────────────────────────────────

    def initialize(self) -> None:
        """Build the full mine grid from cave_01 base data."""
        rng = random.Random(self.seed)

        # Load base cave tiles
        cave_path = MAPS_DIR / "cave_01.json"
        if cave_path.exists():
            cave_data = json.loads(cave_path.read_text(encoding="utf-8"))
            base_tiles = cave_data.get("tiles", [])
        else:
            base_tiles = []

        open_set: set[tuple[int, int]] = set()
        for t in base_tiles:
            col, row = int(t["x"]), int(t["y"])
            open_set.add((col, row))

        # Also add entry point tiles to open set (ensure they're walkable)
        for ec, er in ENTRANCES:
            open_set.add((ec, er))

        # Compute depth map for entire grid
        self._compute_depth_map()

        # Phase 1: Place all tiles
        for row in range(GRID_MIN, GRID_MAX):
            for col in range(GRID_MIN, GRID_MAX):
                # Bedrock border
                if (col <= GRID_MIN + BEDROCK_BORDER - 1 or
                    col >= GRID_MAX - BEDROCK_BORDER or
                    row <= GRID_MIN + BEDROCK_BORDER - 1 or
                    row >= GRID_MAX - BEDROCK_BORDER):
                    self.grid[(col, row)] = self._make_tile("bedrock")
                    continue

                if (col, row) in open_set:
                    self.grid[(col, row)] = self._make_tile("open", known=True, visible=True)
                else:
                    # Default to void (will become wall if adjacent to open)
                    depth = self.depth_map.get((col, row), 99)
                    tile_type = "hardwall" if depth >= HARDWALL_DEPTH else "wall"
                    ore_type, ore_amount = _roll_ore(rng, depth)
                    self.grid[(col, row)] = self._make_tile(
                        tile_type,
                        ore_type=ore_type,
                        ore_amount=ore_amount,
                    )

        # Phase 2: Compute initial wall frontier and visibility
        self._recompute_wall_frontier()
        self._recompute_visibility()

        # Phase 3: Generate pure veins on hardwall tiles
        _generate_veins(rng, self.grid, self.depth_map)

    def _compute_depth_map(self) -> None:
        """Compute Euclidean distance from each grid cell to nearest entrance."""
        for row in range(GRID_MIN, GRID_MAX):
            for col in range(GRID_MIN, GRID_MAX):
                min_dist = float("inf")
                for ec, er in ENTRANCES:
                    d = math.sqrt((col - ec) ** 2 + (row - er) ** 2)
                    if d < min_dist:
                        min_dist = d
                self.depth_map[(col, row)] = min_dist

    def _make_tile(self, tile_type: str, *,
                   known: bool = False, visible: bool = False,
                   ore_type: str | None = None, ore_amount: int = 0,
                   vein_id: str | None = None) -> dict:
        return {
            "type": tile_type,
            "known": known,
            "visible": visible,
            "ore_type": ore_type,
            "ore_amount": ore_amount,
            "vein_id": vein_id,
        }

    def _recompute_wall_frontier(self) -> None:
        """Tiles adjacent to open tiles that are wall/hardwall get known=True
        so the player can see them as mineable rock faces."""
        # Not needed globally — handled by visibility instead.
        pass

    def _recompute_visibility(self) -> None:
        """Recompute tile_visible for all tiles based on open tile light radius."""
        # First, clear all visibility
        for tile in self.grid.values():
            tile["visible"] = False

        # Find all open tiles and illuminate around them
        open_tiles = [
            (c, r) for (c, r), t in self.grid.items() if t["type"] == "open"
        ]

        for oc, or_ in open_tiles:
            for dr in range(-OPEN_LIGHT_RADIUS, OPEN_LIGHT_RADIUS + 1):
                for dc in range(-OPEN_LIGHT_RADIUS, OPEN_LIGHT_RADIUS + 1):
                    dist = math.sqrt(dc * dc + dr * dr)
                    nc, nr = oc + dc, or_ + dr
                    tile = self.grid.get((nc, nr))
                    if not tile:
                        continue

                    if tile["type"] == "open":
                        # Open tiles visible within full radius
                        if dist <= OPEN_LIGHT_RADIUS:
                            tile["visible"] = True
                            tile["known"] = True
                    else:
                        # Wall/hardwall/bedrock: tighter reveal radius
                        if dist <= WALL_REVEAL_RADIUS:
                            tile["visible"] = True
                            tile["known"] = True

    # ── Mining ───────────────────────────────────────────────────────────

    def mine_tile(self, col: int, row: int, can_mine_hardwall: bool = False
                  ) -> dict | None:
        """Attempt to mine a wall tile. Returns drop info or None on failure.

        Returns: {"ore_type": str, "ore_amount": int, "vein_id": str|None}
        or None if mining is not allowed.
        """
        tile = self.grid.get((col, row))
        if not tile:
            return None

        if tile["type"] == "wall":
            pass  # any pickaxe works
        elif tile["type"] == "hardwall":
            if not can_mine_hardwall:
                return None  # need iron+ pickaxe
        else:
            return None  # can't mine open/bedrock

        # Collect drop info before converting
        drop = {
            "ore_type": tile["ore_type"],
            "ore_amount": tile["ore_amount"],
            "vein_id": tile["vein_id"],
        }

        # Convert to open
        tile["type"] = "open"
        tile["known"] = True
        tile["visible"] = True
        tile["ore_type"] = None
        tile["ore_amount"] = 0
        tile["vein_id"] = None

        # If part of a vein, reveal all tiles in the vein
        if drop["vein_id"]:
            self._reveal_vein(drop["vein_id"])
            self.tiles_since_vein = 0
        else:
            self.tiles_since_vein += 1

        # Recompute visibility around the newly opened tile
        self._update_visibility_around(col, row)

        return drop

    def _reveal_vein(self, vein_id: str) -> None:
        """When a vein tile is first mined, make all tiles in the vein known."""
        for (c, r), tile in self.grid.items():
            if tile.get("vein_id") == vein_id:
                tile["known"] = True
                tile["visible"] = True

    def _update_visibility_around(self, col: int, row: int) -> None:
        """Update visibility for tiles near a newly opened tile."""
        for dr in range(-OPEN_LIGHT_RADIUS, OPEN_LIGHT_RADIUS + 1):
            for dc in range(-OPEN_LIGHT_RADIUS, OPEN_LIGHT_RADIUS + 1):
                dist = math.sqrt(dc * dc + dr * dr)
                nc, nr = col + dc, row + dr
                tile = self.grid.get((nc, nr))
                if not tile:
                    continue

                if tile["type"] == "open":
                    if dist <= OPEN_LIGHT_RADIUS:
                        tile["visible"] = True
                        tile["known"] = True
                else:
                    if dist <= WALL_REVEAL_RADIUS:
                        tile["visible"] = True
                        tile["known"] = True

    # ── State for client ─────────────────────────────────────────────────

    def get_known_tiles(self) -> list[dict]:
        """Return tile data for all known tiles (to send to client).

        Only sends tiles the player has discovered.
        Each tile includes: col, row, type, visible, ore_type (if visible wall).
        """
        result = []
        for (col, row), tile in self.grid.items():
            if not tile["known"]:
                continue
            entry = {
                "c": col,
                "r": row,
                "t": tile["type"],       # open/wall/hardwall/bedrock
                "v": tile["visible"],     # currently lit
            }
            # Only reveal ore info for visible wall/hardwall tiles
            if tile["visible"] and tile["type"] in ("wall", "hardwall") and tile["ore_type"]:
                entry["o"] = tile["ore_type"]
            # Mark vein tiles
            if tile.get("vein_id") and tile["known"]:
                entry["vn"] = True
            result.append(entry)
        return result

    def is_tile_open(self, col: int, row: int) -> bool:
        """Check if a tile is open (walkable)."""
        tile = self.grid.get((col, row))
        return tile is not None and tile["type"] == "open"

    def is_tile_mineable(self, col: int, row: int) -> bool:
        """Check if a tile can be mined (is a known wall/hardwall)."""
        tile = self.grid.get((col, row))
        if not tile:
            return False
        return tile["type"] in ("wall", "hardwall") and tile["known"]

    # ── Serialization ────────────────────────────────────────────────────

    def to_json(self) -> str:
        """Serialize grid state for DB persistence."""
        data = {
            "seed": self.seed,
            "tiles_since_vein": self.tiles_since_vein,
            "grid": {},
        }
        for (col, row), tile in self.grid.items():
            # Only persist non-default tiles to save space
            # Skip bedrock (can be recomputed) but keep everything else
            if tile["type"] == "bedrock":
                continue
            key = f"{col},{row}"
            entry = {"t": tile["type"]}
            if tile["known"]:
                entry["k"] = 1
            if tile["ore_type"]:
                entry["o"] = tile["ore_type"]
            if tile["ore_amount"]:
                entry["a"] = tile["ore_amount"]
            if tile["vein_id"]:
                entry["vi"] = tile["vein_id"]
            data["grid"][key] = entry
        return json.dumps(data, separators=(",", ":"))

    @classmethod
    def from_json(cls, player_id: str, json_str: str) -> "MineGrid":
        """Restore grid from DB persistence."""
        data = json.loads(json_str)
        mg = cls(player_id, seed=data.get("seed"))
        mg.tiles_since_vein = data.get("tiles_since_vein", 0)

        # Rebuild depth map
        mg._compute_depth_map()

        # Rebuild bedrock border
        for row in range(GRID_MIN, GRID_MAX):
            for col in range(GRID_MIN, GRID_MAX):
                if (col <= GRID_MIN + BEDROCK_BORDER - 1 or
                    col >= GRID_MAX - BEDROCK_BORDER or
                    row <= GRID_MIN + BEDROCK_BORDER - 1 or
                    row >= GRID_MAX - BEDROCK_BORDER):
                    mg.grid[(col, row)] = mg._make_tile("bedrock")

        # Restore saved tiles
        for key, entry in data.get("grid", {}).items():
            parts = key.split(",")
            col, row = int(parts[0]), int(parts[1])
            mg.grid[(col, row)] = {
                "type": entry["t"],
                "known": bool(entry.get("k")),
                "visible": False,  # will be recomputed
                "ore_type": entry.get("o"),
                "ore_amount": entry.get("a", 0),
                "vein_id": entry.get("vi"),
            }

        # Fill in any missing tiles (shouldn't happen but safety)
        for row in range(GRID_MIN, GRID_MAX):
            for col in range(GRID_MIN, GRID_MAX):
                if (col, row) not in mg.grid:
                    depth = mg.depth_map.get((col, row), 99)
                    tile_type = "hardwall" if depth >= HARDWALL_DEPTH else "wall"
                    rng = random.Random(mg.seed + col * 10000 + row)
                    ore_type, ore_amount = _roll_ore(rng, depth)
                    mg.grid[(col, row)] = mg._make_tile(
                        tile_type, ore_type=ore_type, ore_amount=ore_amount,
                    )

        # Recompute visibility from current open tiles
        mg._recompute_visibility()
        return mg
