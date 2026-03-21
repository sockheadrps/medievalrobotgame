"""Asset Editor API — CRUD endpoints for world objects, equipment, and items."""

from fastapi import APIRouter, Request, UploadFile, File
from fastapi.responses import HTMLResponse

from core.config import templates
from services.asset_registry import asset_registry
from services.asset_service import (
    list_world_objects, save_world_object, delete_world_object,
    list_equipment, save_equipment, delete_equipment,
    save_uploaded_sprite,
    list_items, save_item, delete_item, save_item_sprite,
    list_stations, save_station, delete_station,
)

router = APIRouter(prefix="/api/assets", tags=["assets"])


# ── HTML editor page ──────────────────────────────────────────────────────────

@router.get("/editor", response_class=HTMLResponse, include_in_schema=False)
async def asset_editor_page(request: Request):
    return templates.TemplateResponse("asseteditor.html", {"request": request})


# ── World Objects ─────────────────────────────────────────────────────────────

@router.get("/world-objects")
async def get_world_objects():
    return list_world_objects()


@router.post("/world-objects")
async def post_world_object(request: Request):
    data = await request.json()
    save_world_object(data)
    return {"ok": True}


@router.delete("/world-objects/{obj_id}")
async def del_world_object(obj_id: str):
    deleted = delete_world_object(obj_id)
    return {"ok": deleted}


# ── Equipment ─────────────────────────────────────────────────────────────────

@router.get("/equipment")
async def get_equipment():
    return list_equipment()


@router.post("/equipment")
async def post_equipment(request: Request):
    data = await request.json()
    save_equipment(data)
    return {"ok": True}


@router.delete("/equipment/{eq_id}")
async def del_equipment(eq_id: str):
    deleted = delete_equipment(eq_id)
    return {"ok": deleted}


@router.post("/equipment/{eq_id}/sprite")
async def upload_equipment_sprite(eq_id: str, file: UploadFile = File(...)):
    content = await file.read()
    path = save_uploaded_sprite(eq_id, file.filename, content)
    return {"ok": True, "path": path}


# ── Items ────────────────────────────────────────────────────────────────────

@router.get("/items")
async def get_items():
    return list_items()


@router.post("/items")
async def post_item(request: Request):
    data = await request.json()
    save_item(data)
    return {"ok": True}


@router.delete("/items/{item_id}")
async def del_item(item_id: str):
    deleted = delete_item(item_id)
    return {"ok": deleted}


@router.post("/items/{item_id}/sprite")
async def upload_item_sprite(item_id: str, file: UploadFile = File(...)):
    content = await file.read()
    path = save_item_sprite(item_id, file.filename, content)
    return {"ok": True, "path": path}


# ── Crafting Stations ────────────────────────────────────────────────────────

@router.get("/stations")
async def get_stations():
    return list_stations()


@router.post("/stations")
async def post_station(request: Request):
    data = await request.json()
    save_station(data)
    return {"ok": True}


@router.delete("/stations/{station_id}")
async def del_station(station_id: str):
    deleted = delete_station(station_id)
    return {"ok": deleted}


@router.get("/crafting_stations")
async def get_crafting_stations_manifest():
    """Returns crafting station definitions read live from disk."""
    stations = list_stations()
    return {st["id"]: st for st in stations if st.get("id")}
