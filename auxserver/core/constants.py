"""Load shared constants from constants.json. No fallback hardcoded values."""
import json
from pathlib import Path

_path = Path(__file__).resolve().parent.parent / "data" / "constants.json"
_data = json.loads(_path.read_text())

# Tilemap
TILE_SIZE = _data["TILE_SIZE"]
MAP_COLS  = _data["MAP_COLS"]
MAP_ROWS  = _data["MAP_ROWS"]

# Movement
PLAYER_SPEED     = _data["PLAYER_SPEED"]
PLAYER_RUN_SPEED = _data["PLAYER_RUN_SPEED"]
NPC_SPEED        = _data["NPC_SPEED"]

# Interaction distances
PICKUP_DIST    = _data["PICKUP_DIST"]
INTERACT_DIST  = _data["INTERACT_DIST"]
TREE_CHOP_DIST = _data["TREE_CHOP_DIST"]
ROCK_MINE_DIST = _data["ROCK_MINE_DIST"]

# Rock
ROCK_HITS        = _data["ROCK_HITS"]
ROCK_LIFESPAN_MS = _data["ROCK_LIFESPAN_MS"]

# Ki / blast
KI_MAX_BASE        = _data["KI_MAX_BASE"]
KI_MAX_PER_LEVEL   = _data["KI_MAX_PER_LEVEL"]
KI_REGEN_MS        = _data["KI_REGEN_MS"]
KI_BLAST_BASE_COST = _data["KI_BLAST_BASE_COST"]
KI_BLAST_BASE_DMG  = _data["KI_BLAST_BASE_DMG"]
KI_BLAST_SCALE     = _data["KI_BLAST_SCALE"]
