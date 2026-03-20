"""File I/O for asset editor — list, save, delete world objects and equipment."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from core.config import WORLD_OBJECTS_DIR, EQUIPMENT_DIR, ITEMS_DIR, STATIONS_DIR, ASSETS_DIR


def list_world_objects() -> list[dict]:
    """Return all world object configs."""
    results = []
    if not WORLD_OBJECTS_DIR.exists():
        return results
    for folder in sorted(WORLD_OBJECTS_DIR.iterdir()):
        if not folder.is_dir():
            continue
        cfg = folder / "object.json"
        if cfg.exists():
            data = json.loads(cfg.read_text(encoding="utf-8-sig"))
            results.append(data)
    return results


def save_world_object(data: dict) -> None:
    """Save a world object definition (creates folder if needed)."""
    obj_id = data.get("id")
    if not obj_id:
        raise ValueError("World object must have an 'id'")
    folder = WORLD_OBJECTS_DIR / obj_id
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "object.json").write_text(
        json.dumps(data, indent=2), encoding="utf-8"
    )


def delete_world_object(obj_id: str) -> bool:
    folder = WORLD_OBJECTS_DIR / obj_id
    if folder.exists() and folder.is_dir():
        shutil.rmtree(folder)
        return True
    return False


def list_equipment() -> list[dict]:
    """Return all equipment configs."""
    results = []
    if not EQUIPMENT_DIR.exists():
        return results
    for folder in sorted(EQUIPMENT_DIR.iterdir()):
        if not folder.is_dir():
            continue
        cfg = folder / "item.json"
        if cfg.exists():
            data = json.loads(cfg.read_text(encoding="utf-8-sig"))
            results.append(data)
    return results


def save_equipment(data: dict) -> None:
    """Save an equipment definition (creates folder if needed)."""
    eq_id = data.get("id")
    if not eq_id:
        raise ValueError("Equipment must have an 'id'")
    folder = EQUIPMENT_DIR / eq_id
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "item.json").write_text(
        json.dumps(data, indent=2), encoding="utf-8"
    )


def delete_equipment(eq_id: str) -> bool:
    folder = EQUIPMENT_DIR / eq_id
    if folder.exists() and folder.is_dir():
        shutil.rmtree(folder)
        return True
    return False


# ── Items ────────────────────────────────────────────────────────────────────

def list_items() -> list[dict]:
    """Return all item configs."""
    results = []
    if not ITEMS_DIR.exists():
        return results
    for folder in sorted(ITEMS_DIR.iterdir()):
        if not folder.is_dir():
            continue
        cfg = folder / "item.json"
        if cfg.exists():
            data = json.loads(cfg.read_text(encoding="utf-8-sig"))
            results.append(data)
    return results


def save_item(data: dict) -> None:
    """Save an item definition (creates folder if needed)."""
    item_id = data.get("id")
    if not item_id:
        raise ValueError("Item must have an 'id'")
    folder = ITEMS_DIR / item_id
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "item.json").write_text(
        json.dumps(data, indent=2), encoding="utf-8"
    )


def delete_item(item_id: str) -> bool:
    folder = ITEMS_DIR / item_id
    if folder.exists() and folder.is_dir():
        shutil.rmtree(folder)
        return True
    return False


def save_item_sprite(item_id: str, filename: str, content: bytes) -> str:
    """Save an uploaded PNG sprite to the item folder. Returns the relative path."""
    folder = ITEMS_DIR / item_id
    folder.mkdir(parents=True, exist_ok=True)
    dest = folder / filename
    dest.write_bytes(content)
    return str(dest.relative_to(ASSETS_DIR))


# ── Crafting Stations ────────────────────────────────────────────────────────

def list_stations() -> list[dict]:
    """Return all crafting station configs."""
    results = []
    if not STATIONS_DIR.exists():
        return results
    for folder in sorted(STATIONS_DIR.iterdir()):
        if not folder.is_dir():
            continue
        cfg = folder / "station.json"
        if cfg.exists():
            data = json.loads(cfg.read_text(encoding="utf-8-sig"))
            results.append(data)
    return results


def save_station(data: dict) -> None:
    """Save a crafting station definition (creates folder if needed)."""
    station_id = data.get("id")
    if not station_id:
        raise ValueError("Station must have an 'id'")
    folder = STATIONS_DIR / station_id
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "station.json").write_text(
        json.dumps(data, indent=2), encoding="utf-8"
    )


def delete_station(station_id: str) -> bool:
    folder = STATIONS_DIR / station_id
    if folder.exists() and folder.is_dir():
        shutil.rmtree(folder)
        return True
    return False


def save_uploaded_sprite(eq_id: str, filename: str, content: bytes) -> str:
    """Save an uploaded PNG sprite to the equipment folder. Returns the relative path."""
    folder = EQUIPMENT_DIR / eq_id
    folder.mkdir(parents=True, exist_ok=True)
    dest = folder / filename
    dest.write_bytes(content)
    return str(dest.relative_to(ASSETS_DIR))
