import json
import re
from pathlib import Path

from fastapi import HTTPException

from core.config import MAPS_DIR
from schemas.maps import MapData


def map_file_path(name: str) -> Path:
    map_name = name.strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]+", map_name):
        raise HTTPException(
            status_code=400,
            detail="Map name can only contain letters, numbers, underscore, and hyphen.",
        )
    return MAPS_DIR / f"{map_name}.json"


def save_map_data(data: MapData) -> None:
    map_path = map_file_path(data.name)
    with open(map_path, "w", encoding="utf-8") as f:
        json.dump(data.model_dump(), f)


def load_map_data(name: str) -> dict:
    map_path = map_file_path(name)
    if not map_path.exists():
        raise HTTPException(status_code=404, detail=f'Map "{name}" not found.')
    with open(map_path, "r", encoding="utf-8") as f:
        return json.load(f)
