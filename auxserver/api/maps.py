from fastapi import APIRouter, Request

from core.config import templates
from schemas.maps import MapData
from services.map_service import load_map_data, save_map_data

router = APIRouter()


@router.post("/save-map")
async def save_map(data: MapData):
    save_map_data(data)
    return {"message": "Map saved successfully!"}


@router.get("/load-map")
async def load_map(name: str):
    return load_map_data(name)


@router.get("/mapmaker")
async def get_editor(request: Request):
    return templates.TemplateResponse(
        "mapmaker.html",
        {
            "request": request,
            "tile_size": 32,
        },
    )
