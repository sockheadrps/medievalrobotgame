"""
animal_service.py — Server-side animal spawning, roaming, combat, loot, and respawn.

Workflow for adding a new animal species:
  1. Drop assets/<SpeciesName>.png and assets/<SpeciesName>.json into the assets folder.
  2. In the map editor, add a Map Item with id "<species>_spawn" and place it on spawn tiles.
  3. Save the map. The server reads the items file on startup — no code changes needed.
"""

import json
import math
import random
import time
from pathlib import Path

TILE_SIZE  = 48
ASSETS_DIR = Path(__file__).resolve().parent.parent.parent / "assets"
MAPS_DIR   = Path(__file__).resolve().parent.parent / "maps"

# ── Species definitions (fallback if no JSON found) ─────────────────────────
_DEFAULT_SPECIES = {
    "dinobird": {
        "hp": 20,
        "speed": 40,
        "roam_radius": 5,       # tiles
        "respawn_delay": 30.0,  # seconds
        "loot": [
            {"item": "meat",    "quantity": 1, "chance": 1.0},
            {"item": "feather", "quantity": 2, "chance": 0.6},
        ],
    },
}


def _load_species_defs() -> dict:
    """Read all <Species>.json files from assets/ and build registry."""
    defs = dict(_DEFAULT_SPECIES)
    for path in ASSETS_DIR.glob("*.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
            if data.get("entity", {}).get("type") != "animal":
                continue
            entity = data["entity"]
            species = entity.get("species") or path.stem.lower().replace(" ", "_")
            defs[species] = {
                "hp":             entity.get("hp", 20),
                "speed":          entity.get("speed", 40),
                "roam_radius":    entity.get("roamRadius", 5),
                "respawn_delay":  entity.get("respawn", {}).get("delayMs", 30000) / 1000.0,
                "loot":           entity.get("loot", []),
            }
        except Exception as e:
            print(f"[animals] Could not parse {path.name}: {e}")
    return defs


def _load_spawn_points(map_name: str) -> list[dict]:
    """Read <map>_items.json and return entries whose id ends with '_spawn'."""
    items_path = MAPS_DIR / f"{map_name}_items.json"
    if not items_path.exists():
        return []
    try:
        data = json.loads(items_path.read_text(encoding="utf-8"))
        spawns = []
        for item in data.get("mapItems", []):
            # Support both id and label as the spawn identifier
            label: str = item.get("label", "").strip()
            item_id: str = item.get("id", "").strip()
            spawn_key = label if label.endswith("_spawn") else (item_id if item_id.endswith("_spawn") else None)
            if not spawn_key:
                continue
            species = spawn_key[: -len("_spawn")]
            col = item.get("tileCol")
            row = item.get("tileRow")
            if col is None or row is None:
                continue
            spawns.append({
                "species": species,
                "col": col,
                "row": row,
            })
        return spawns
    except Exception as e:
        print(f"[animals] Failed to load spawn points from {map_name}: {e}")
        return []


# ── AnimalManager ────────────────────────────────────────────────────────────

class AnimalManager:
    def __init__(self, map_name: str = "level_01"):
        self._species_defs = _load_species_defs()
        self._spawn_points = _load_spawn_points(map_name)
        self._animals: dict[str, dict] = {}
        self._next_id = 0
        self._respawn_queue: list[dict] = []  # {species, col, row, at}

        print(f"[animals] Loaded {len(self._species_defs)} species, "
              f"{len(self._spawn_points)} spawn points")
        self._initial_spawn()

    # ── Public API ───────────────────────────────────────────────────────────

    def get_all(self) -> list[dict]:
        return list(self._animals.values())

    def handle_attack(self, animal_id: str, attacker_pid: str, damage: int = 5) -> dict | None:
        """Apply damage to an animal. Returns loot dict if it dies, else None."""
        animal = self._animals.get(animal_id)
        if not animal or animal.get("dead"):
            return None
        animal["hp"] = max(0, animal["hp"] - damage)
        if animal["hp"] <= 0:
            return self._kill(animal, attacker_pid)
        return None

    def tick(self, dt: float):
        now = time.time()
        # Roam living animals
        for animal in self._animals.values():
            if animal.get("dead"):
                continue
            self._roam(animal, dt)

        # Process respawn queue
        ready = [r for r in self._respawn_queue if now >= r["at"]]
        for r in ready:
            self._respawn_queue.remove(r)
            self._spawn_animal(r["species"], r["col"], r["row"])

    # ── Internal ─────────────────────────────────────────────────────────────

    def _initial_spawn(self):
        for sp in self._spawn_points:
            self._spawn_animal(sp["species"], sp["col"], sp["row"])

    def _spawn_animal(self, species: str, col: int, row: int) -> dict:
        df = self._species_defs.get(species, self._species_defs.get("dinobird"))
        self._next_id += 1
        aid = f"animal_{self._next_id}"
        # Scatter slightly within ±1 tile of spawn point
        cx = col * TILE_SIZE + TILE_SIZE / 2 + random.randint(-TILE_SIZE, TILE_SIZE)
        cy = row * TILE_SIZE + TILE_SIZE / 2 + random.randint(-TILE_SIZE, TILE_SIZE)
        animal = {
            "id":          aid,
            "species":     species,
            "x":           cx,
            "y":           cy,
            "spawn_x":     cx,
            "spawn_y":     cy,
            "hp":          df["hp"],
            "maxHp":       df["hp"],
            "speed":       df["speed"],
            "roam_radius": df["roam_radius"] * TILE_SIZE,
            "loot":        df["loot"],
            "respawn_delay": df["respawn_delay"],
            "dead":        False,
            "dx":          0.0,
            "dy":          0.0,
            "_move_timer": 0.0,
            "_target_x":   cx,
            "_target_y":   cy,
            # spawn origin for respawn
            "_spawn_col":  col,
            "_spawn_row":  row,
        }
        self._animals[aid] = animal
        return animal

    def _roam(self, animal: dict, dt: float):
        """Simple random roam — pick new waypoint every few seconds."""
        animal["_move_timer"] -= dt
        if animal["_move_timer"] <= 0:
            # Pick new random target within roam_radius of spawn
            angle = random.uniform(0, 2 * math.pi)
            r = random.uniform(0, animal["roam_radius"])
            animal["_target_x"] = animal["spawn_x"] + math.cos(angle) * r
            animal["_target_y"] = animal["spawn_y"] + math.sin(angle) * r
            animal["_move_timer"] = random.uniform(1.5, 4.0)

        tx = animal["_target_x"]
        ty = animal["_target_y"]
        dx = tx - animal["x"]
        dy = ty - animal["y"]
        dist = math.sqrt(dx * dx + dy * dy)
        if dist > 4:
            spd = animal["speed"]
            animal["x"] += (dx / dist) * spd * dt
            animal["y"] += (dy / dist) * spd * dt
            animal["dx"] = dx / dist
            animal["dy"] = dy / dist
        else:
            animal["dx"] = 0.0
            animal["dy"] = 0.0

    def _kill(self, animal: dict, killer_pid: str) -> dict:
        animal["dead"] = True
        animal["hp"]   = 0
        # Roll loot
        drops = []
        for entry in animal.get("loot", []):
            if random.random() <= entry.get("chance", 1.0):
                drops.append({"item": entry["item"], "quantity": entry["quantity"]})

        # Queue respawn
        self._respawn_queue.append({
            "species": animal["species"],
            "col":     animal["_spawn_col"],
            "row":     animal["_spawn_row"],
            "at":      time.time() + animal["respawn_delay"],
        })

        print(f"[animals] {animal['id']} ({animal['species']}) killed by {killer_pid}, "
              f"drops: {drops}, respawn in {animal['respawn_delay']}s")
        return {"animal_id": animal["id"], "killer": killer_pid, "drops": drops}


# Singleton — imported by game_state and ws handler
animal_manager = AnimalManager()
