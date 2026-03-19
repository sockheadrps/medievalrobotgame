import base64
import json
import re
from pathlib import Path

from fastapi import HTTPException

from core.config import MAPS_DIR, MAP_SPRITES_DIR
from schemas.maps import MapData


MAP_NAME_RE = re.compile(r"[A-Za-z0-9_-]+")
SPRITE_ID_RE = re.compile(r"[A-Za-z0-9_-]+")


def _validated_map_name(name: str) -> str:
    map_name = name.strip()
    if not MAP_NAME_RE.fullmatch(map_name):
        raise HTTPException(
            status_code=400,
            detail="Map name can only contain letters, numbers, underscore, and hyphen.",
        )
    return map_name


def _validated_sprite_id(sprite_id: str) -> str:
    sid = (sprite_id or "").strip()
    if not SPRITE_ID_RE.fullmatch(sid):
        raise HTTPException(
            status_code=400,
            detail="Sprite id can only contain letters, numbers, underscore, and hyphen.",
        )
    return sid


def map_file_path(name: str) -> Path:
    map_name = _validated_map_name(name)
    return MAPS_DIR / f"{map_name}.json"


def sprite_file_name(map_name: str, sprite_id: str) -> str:
    return f"{map_name}__{sprite_id}.png"


def sprite_file_path(map_name: str, sprite_id: str) -> Path:
    safe_map = _validated_map_name(map_name)
    safe_sprite = _validated_sprite_id(sprite_id)
    return MAP_SPRITES_DIR / sprite_file_name(safe_map, safe_sprite)


def _decode_png_data_url(data_url: str) -> bytes:
    prefix = "data:image/png;base64,"
    if not data_url.startswith(prefix):
        raise HTTPException(status_code=400, detail="Expected PNG data URL for custom sprites.")
    try:
        return base64.b64decode(data_url[len(prefix) :], validate=True)
    except Exception as exc:  # pragma: no cover - defensive
        raise HTTPException(status_code=400, detail="Invalid custom sprite PNG payload.") from exc


def collision_file_path(name: str) -> Path:
    map_name = _validated_map_name(name)
    return MAPS_DIR / f"{map_name}_collision.json"


def items_file_path(name: str) -> Path:
    map_name = _validated_map_name(name)
    return MAPS_DIR / f"{map_name}_items.json"


def save_map_data(data: MapData) -> None:
    map_path = map_file_path(data.name)
    map_name = map_path.stem

    saved_files = set()
    custom_sprites_out = []
    for sprite in data.customSprites:
        sid = _validated_sprite_id(sprite.id)
        if sprite.pngDataUrl:
            payload = _decode_png_data_url(sprite.pngDataUrl)
        elif sprite.pngFile:
            existing = MAP_SPRITES_DIR / sprite.pngFile
            if not existing.exists():
                raise HTTPException(
                    status_code=400,
                    detail=f"Sprite file '{sprite.pngFile}' was not found on server.",
                )
            payload = existing.read_bytes()
        else:
            raise HTTPException(
                status_code=400,
                detail=f"Custom sprite '{sid}' is missing PNG data.",
            )

        filename = sprite_file_name(map_name, sid)
        out_path = MAP_SPRITES_DIR / filename
        out_path.write_bytes(payload)
        saved_files.add(filename)
        custom_sprites_out.append({"id": sid, "pngFile": filename})

    prefix = f"{map_name}__"
    for existing in MAP_SPRITES_DIR.glob(f"{prefix}*.png"):
        if existing.name not in saved_files:
            existing.unlink(missing_ok=True)

    map_payload = {
        "name": data.name,
        "width": data.width,
        "height": data.height,
        "tiles": [t.model_dump(exclude_none=True) for t in data.tiles],
        "customSprites": custom_sprites_out,
    }

    with open(map_path, "w", encoding="utf-8") as f:
        json.dump(map_payload, f)

    # Save collision tiles to a separate file — not included in the rendered map
    collision_path = collision_file_path(data.name)
    collision_payload = {
        "name": data.name,
        "collisionTiles": [c.model_dump() for c in data.collisionTiles],
    }
    with open(collision_path, "w", encoding="utf-8") as f:
        json.dump(collision_payload, f)

    # Save map items registry to a separate file
    items_path = items_file_path(data.name)
    items_payload = {
        "name": data.name,
        "mapItems": [i.model_dump() for i in data.mapItems],
    }
    with open(items_path, "w", encoding="utf-8") as f:
        json.dump(items_payload, f)


def load_map_data(name: str) -> dict:
    map_path = map_file_path(name)
    map_name = map_path.stem
    if not map_path.exists():
        raise HTTPException(status_code=404, detail=f'Map "{name}" not found.')

    with open(map_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    sprites = []
    for sprite in data.get("customSprites", []):
        sid = sprite.get("id")
        if not isinstance(sid, str):
            continue

        png_file = sprite.get("pngFile")
        if isinstance(png_file, str) and (MAP_SPRITES_DIR / png_file).exists():
            sprites.append(
                {
                    "id": sid,
                    "pngFile": png_file,
                    "pngUrl": f"/map-sprite?name={map_name}&sprite_id={sid}",
                }
            )
            continue

        # Backward compatibility for old maps that still contain inline pixels.
        if isinstance(sprite.get("pixels"), list):
            sprites.append({"id": sid, "pixels": sprite["pixels"]})

    data["customSprites"] = sprites

    # Load collision tiles from the separate collision file if it exists
    col_path = collision_file_path(name)
    if col_path.exists():
        with open(col_path, "r", encoding="utf-8") as f:
            col_data = json.load(f)
        data["collisionTiles"] = col_data.get("collisionTiles", [])
    else:
        data["collisionTiles"] = []

    # Load map items registry
    itm_path = items_file_path(name)
    if itm_path.exists():
        with open(itm_path, "r", encoding="utf-8") as f:
            itm_data = json.load(f)
        data["mapItems"] = itm_data.get("mapItems", [])
    else:
        data["mapItems"] = []

    return data
