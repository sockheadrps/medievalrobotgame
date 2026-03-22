"""Miscellaneous routes that don't belong to a specific domain router."""

import logging
import os
import json as _json_mod
from pathlib import Path
from fastapi import APIRouter, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse
from typing import Optional

from core.config import templates
from services.asset_registry import asset_registry
from services.game_state import game
from services.database import load_npc as db_load_npc

logger = logging.getLogger(__name__)
router = APIRouter()

ASSETS_DIR_PATH = Path(__file__).resolve().parent.parent.parent / "assets"


@router.get("/api/customization/assets")
async def customization_assets():
    """Scan hair/, clothing/, and items/ overlay folders and return asset metadata."""
    result = []
    for category in ("hair", "clothing", "items"):
        cat_dir = ASSETS_DIR_PATH / category
        if not cat_dir.exists():
            continue
        for item_dir in sorted(cat_dir.iterdir()):
            if not item_dir.is_dir():
                continue
            # Look for a JSON file in this subfolder
            json_files = list(item_dir.glob("*.json"))
            if not json_files:
                continue
            try:
                data = _json_mod.loads(json_files[0].read_text(encoding="utf-8"))
            except Exception:
                continue
            # Find PNG
            png_files = list(item_dir.glob("*.png"))
            png_path = f"assets/{category}/{item_dir.name}/{png_files[0].name}" if png_files else None
            result.append({
                "name": data.get("name", item_dir.name),
                "slug": data.get("slug", item_dir.name),
                "category": data.get("category", category),
                "description": data.get("description", ""),
                "frameCount": data.get("frameCount", 1),
                "pngPath": png_path,
                "frameWidth": data.get("frameWidth", 32),
                "frameHeight": data.get("frameHeight", 32),
            })
    return result


@router.get("/health")
def health():
    return {"status": "ok"}


@router.get("/api/debug/bounds")
def debug_bounds():
    from services.world_data import MAP_COLS, MAP_ROWS, get_collision_tiles
    from core.constants import TILE_SIZE
    from core.constants import MAP_COLS as CONST_COLS, MAP_ROWS as CONST_ROWS
    l01_col = get_collision_tiles("level_01")
    rival_col = get_collision_tiles("rivalmap")
    players = {}
    for pid, p in game.players.items():
        players[pid] = {"x": round(p.get("x", 0), 1), "y": round(p.get("y", 0), 1), "map": p.get("map", "level_01")}
    return {
        "world_data": {"MAP_COLS": MAP_COLS, "MAP_ROWS": MAP_ROWS},
        "constants": {"MAP_COLS": CONST_COLS, "MAP_ROWS": CONST_ROWS},
        "world_w": MAP_COLS * TILE_SIZE,
        "world_h": MAP_ROWS * TILE_SIZE,
        "collision_level_01": len(l01_col),
        "collision_rivalmap": len(rival_col),
        "players": players,
    }


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


@router.get("/api/npc")
async def npc_state(pid: Optional[str] = Query(default=None)):
    """JSON snapshot of player NPC states for the NPC dashboard."""
    players_summary = []
    for p_pid, p in game.players.items():
        synced = p.get("_npc_sync", {})
        living = {nid: n for nid, n in synced.items() if not n.get("dead")}
        players_summary.append({"pid": p_pid, "npc_count": len(living)})

    if not pid:
        return {"players": players_summary, "npcs": None}

    player = game.players.get(pid)
    if not player:
        return {"players": players_summary, "npcs": [], "error": f"Player '{pid}' not found"}

    npcs_out = []
    server_npcs = player.get("_npc_sync", {})  # populated by npc_sync WS messages
    # Union: npc_ids from account save + any IDs seen via npc_sync
    npc_ids = list({*player.get("npc_ids", []), *server_npcs.keys()})
    logger.info("[/api/npc] pid=%s npc_ids=%s synced_keys=%s",
                pid, player.get("npc_ids", []), list(server_npcs.keys()))

    for npc_id in npc_ids:
        live = server_npcs.get(npc_id, {})
        live_has_sync = "hp" in live  # populated by npc_sync message

        if live_has_sync:
            # Full live data sent by client via npc_sync
            name = live.get("name", npc_id)
            stats = {k: v for k, v in live.items()
                     if k not in ("soul", "relationships", "personality", "memories", "diary",
                                  "last_decision", "recent_events", "drives")}
            soul = {
                "personality": live.get("personality", {}),
                "drives": live.get("drives", {}),
                "relationships": live.get("relationships", {}),
                "memories": live.get("memories", {}),
                "diary": live.get("diary", []),
            }
            last_decision = live.get("last_decision")
            recent_events = live.get("recent_events", [])
        else:
            # Fall back to DB snapshot (player offline or not yet synced)
            db_row = db_load_npc(npc_id)
            if not db_row and not live:
                continue
            if db_row:
                db_stats = db_row.get("stats", {})
                name = db_row.get("name", npc_id)
                soul = db_row.get("soul", {})
                stats = {"x": db_row.get("x", 0), "y": db_row.get("y", 0), **db_stats}
            else:
                name = live.get("name", npc_id)
                soul = {}
                stats = {k: v for k, v in live.items() if not k.startswith("_")}
            last_decision = None
            recent_events = []

        bg = game.background_npcs.get(npc_id)

        npcs_out.append({
            "id": npc_id,
            "name": name,
            "live": live_has_sync,
            "stats": stats,
            "soul": soul,
            "current_task": live.get("current_task"),
            "task_running": live.get("task_running", False),
            "manual_locked": live.get("manual_locked", False),
            "last_decision": last_decision,
            "recent_events": recent_events,
            "background_task": bg.get("task") if bg else None,
        })

    return {"players": players_summary, "npcs": npcs_out}


@router.get("/api/npc/debug")
async def npc_debug():
    """Raw dump of all player npc_ids and npcs dict keys for debugging."""
    out = {}
    for p_pid, p in game.players.items():
        out[p_pid] = {
            "npc_ids": p.get("npc_ids", []),
            "npcs_keys": list(p.get("npcs", {}).keys()),
            "npcs_synced": [k for k, v in p.get("npcs", {}).items() if "hp" in v],
        }
    return out


@router.get("/npc", response_class=HTMLResponse)
async def npc_dashboard(request: Request):
    """Live NPC dashboard."""
    return templates.TemplateResponse("npc_dashboard.html", {"request": request})
