from fastapi import APIRouter, Request
from fastapi.responses import FileResponse
from fastapi import HTTPException

from core.config import templates
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


@router.get("/mapmaker")
async def get_editor(request: Request):
    return templates.TemplateResponse(
        "mapmaker.html",
        {
            "request": request,
            "tile_size": 32,
        },
    )
