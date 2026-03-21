"""Miscellaneous routes that don't belong to a specific domain router."""

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse

from core.config import templates
from services.asset_registry import asset_registry
from services.game_state import game

router = APIRouter()


@router.get("/health")
def health():
    return {"status": "ok"}


@router.get("/api/debug/buildings")
def debug_buildings():
    """Dump all building state for debugging conveyors."""
    result = {}
    for bid, b in game.buildings.items():
        result[bid] = {
            "kind": b["kind"],
            "col": b["col"], "row": b["row"],
            "map": b.get("map", "level_01"),
            "direction": b.get("direction", ""),
            "out_direction": b.get("out_direction", ""),
            "held": b.get("_held"),
            "stored": b.get("stored", {}),
            "label": b.get("label", ""),
        }
    return result


@router.get("/asseteditor", response_class=HTMLResponse)
async def asseteditor_redirect(request: Request):
    return templates.TemplateResponse("asseteditor.html", {"request": request})


@router.get("/api/asset-manifest")
def asset_manifest():
    """Return all asset definitions + frame remap tables for the client."""
    return asset_registry.get_manifest()


@router.get("/playground", response_class=HTMLResponse)
async def playground(request: Request):
    return templates.TemplateResponse("playground.html", {"request": request})


@router.get("/api/aip")
async def aip_state():
    """JSON snapshot of the AI rival player's state for the dashboard."""
    from services.ai_player import ai_player
    return ai_player.get_dashboard_state()


@router.get("/aip", response_class=HTMLResponse)
async def aip_dashboard(request: Request):
    """Live AI player dashboard."""
    return templates.TemplateResponse("ai_dashboard.html", {"request": request})
