from fastapi import APIRouter, Request
from fastapi.responses import FileResponse
from fastapi import HTTPException

from core.config import templates, MAPS_DIR
from schemas.maps import MapData
from services.map_service import load_map_data, save_map_data, sprite_file_path

router = APIRouter()


@router.post("/save-map")
async def save_map(data: MapData):
    save_map_data(data)
    return {"message": "Map saved successfully!"}


@router.get("/load-map")
async def load_map(name: str):
    return load_map_data(name)


@router.get("/map-sprite")
async def load_map_sprite(name: str, sprite_id: str):
    path = sprite_file_path(name, sprite_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Sprite not found.")
    return FileResponse(path, media_type="image/png")


@router.get("/list-maps")
async def list_maps():
    """Return all map names available on disk (excludes _collision and _items files)."""
    names = sorted(
        p.stem for p in MAPS_DIR.glob("*.json")
        if not p.stem.endswith("_collision") and not p.stem.endswith("_items")
    )
    return {"maps": names}


@router.post("/wipe-map")
async def wipe_map(request: Request):
    """Wipe all in-game runtime data for a map (buildings, ground items, mine grids).
    Resets the map to its saved tile state without modifying the tile data files.
    """
    import re
    from services.game_state import game
    from services.database import save_buildings, save_ground_items

    body = await request.json()
    name = (body.get("name") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]+", name):
        raise HTTPException(status_code=400, detail="Invalid map name.")

    # Remove buildings on this map from live state
    game.buildings = {bid: b for bid, b in game.buildings.items() if b.get("map", "level_01") != name}

    # Remove ground items on this map from live state
    game.ground_items = [gi for gi in game.ground_items if gi.get("map", "level_01") != name]

    # Clear mine grids if this is a cave map (reset in-memory + DB)
    if name == "cave_01":
        game.mine_grids.clear()
        from services.database import delete_all_mine_states
        delete_all_mine_states()

    # Persist the stripped state
    save_buildings(game.buildings)
    save_ground_items(game.ground_items)

    return {"ok": True, "map": name}


@router.get("/mapmaker")
async def get_editor(request: Request):
    return templates.TemplateResponse(
        "mapmaker.html",
        {
            "request": request,
            "tile_size": 32,
        },
    )
