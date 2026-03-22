"""Admin control panel routes."""

import json
import logging
import os
import re
from pathlib import Path as _Path
from typing import Optional

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

import core.config as cfg
from core.config import templates, ENV_FILE
from services.game_state import game
from services.database import (
    get_setting, set_setting,
    get_player_npc_limit, get_rival_npc_limit,
    get_speed_multiplier,
    wipe_all_npcs, reset_player_stats_to_default,
    list_players,
)

logger = logging.getLogger(__name__)
router = APIRouter()
_BLAST_MOVES_PATH = _Path(__file__).resolve().parent.parent / "data" / "blast_moves.json"


@router.get("/admin", response_class=HTMLResponse)
async def admin_panel(request: Request):
    return templates.TemplateResponse("admin.html", {"request": request})


@router.get("/api/admin/pause")
async def get_pause():
    return {"paused": game.paused}


@router.post("/api/admin/pause")
async def set_pause():
    game.paused = not game.paused
    state = "paused" if game.paused else "resumed"
    logger.info("Admin: game %s", state)
    return {"paused": game.paused}


@router.get("/api/admin/state")
async def admin_state():
    """Current state snapshot for the admin panel."""
    players = []
    for pid, p in game.players.items():
        if pid.startswith("__"):
            continue
        alive_npcs = [nid for nid in p.get("npc_ids", [])
                      if not p.get("npcs", {}).get(nid, {}).get("dead")]
        players.append({
            "pid": pid,
            "level": p.get("level", 1),
            "xp": p.get("xp", 0),
            "str": p.get("str", 1),
            "def": p.get("def", 1),
            "npc_count": len(p.get("npc_ids", [])),
            "alive_npc_count": len(alive_npcs),
        })

    rival = game.players.get("__ai_rival__", {})
    rival_npc_ids = rival.get("npc_ids", [])

    return {
        "players": players,
        "rival": {
            "level": rival.get("level", 1),
            "npc_count": len(rival_npc_ids),
        },
        "limits": {
            "player": get_player_npc_limit(),
            "rival": get_rival_npc_limit(),
        },
        "speed_multiplier": get_speed_multiplier(),
        "all_player_usernames": list_players(),
        "paused": game.paused,
    }


@router.post("/api/admin/wipe_npcs")
async def wipe_npcs():
    """Wipe all NPCs for every player and the AI rival in-memory and in DB."""
    wiped = 0

    for pid, p in game.players.items():
        count = len(p.get("npc_ids", []))
        wiped += count
        p["npc_ids"] = []
        p["npcs"] = {}
        p["_npc_sync"] = {}

    game.background_npcs.clear()
    wipe_all_npcs()

    logger.info("Admin: wiped %d NPCs", wiped)
    return {"ok": True, "wiped": wiped}


@router.post("/api/admin/reset_rival")
async def reset_rival():
    """Fully reset the AI rival — memory, stats, NPCs, re-spawn fresh."""
    from services.ai_player import ai_player
    ai_player.reset()
    return {"ok": True}


class ResetPlayerRequest(BaseModel):
    pid: Optional[str] = None  # None = reset all players


@router.post("/api/admin/reset_player_stats")
async def reset_player_stats(req: ResetPlayerRequest):
    """Reset level, xp, str, def, hp, ki stats to defaults."""
    reset_fields = {
        "level": 1, "xp": 0,
        "str": 1, "def": 1,
        "hp": 20, "maxHp": 20,
        "ki": 20, "maxKi": 20,
        "kiSkillLevel": 1, "kiSkillXp": 0,
        "blastLevel": 0,
    }

    if req.pid:
        if req.pid not in game.players:
            return {"ok": False, "error": f"Player '{req.pid}' not connected"}
        pids = [req.pid]
    else:
        pids = [pid for pid in game.players if not pid.startswith("__")]

    for pid in pids:
        p = game.players.get(pid)
        if p:
            p.update(reset_fields)
        reset_player_stats_to_default(pid)

    logger.info("Admin: reset stats for %s", pids)
    return {"ok": True, "reset": pids}


class SetLimitsRequest(BaseModel):
    player_limit: Optional[int] = None  # 0 or negative = remove limit
    rival_limit: Optional[int] = None


@router.post("/api/admin/set_limits")
async def set_limits(req: SetLimitsRequest):
    """Set or clear max NPC count limits."""
    if req.player_limit is not None:
        set_setting("admin_npc_limit_player",
                    str(req.player_limit) if req.player_limit > 0 else "")
    if req.rival_limit is not None:
        set_setting("admin_npc_limit_rival",
                    str(req.rival_limit) if req.rival_limit > 0 else "")
    return {
        "ok": True,
        "limits": {
            "player": get_player_npc_limit(),
            "rival": get_rival_npc_limit(),
        },
    }


class SetSpeedRequest(BaseModel):
    multiplier: float = 1.0


@router.post("/api/admin/set_speed")
async def set_speed(req: SetSpeedRequest):
    """Set global movement speed multiplier (1.0 = normal)."""
    val = max(0.1, min(10.0, req.multiplier))
    set_setting("admin_speed_multiplier", str(val) if val != 1.0 else "")
    from services.game_state import game
    game._speed_multiplier = val
    return {"ok": True, "speed_multiplier": val}


# ── Entity editor ─────────────────────────────────────────────────────────────

def _entity_snapshot(actor: dict, npc_id: Optional[str] = None) -> dict:
    """Return editable stat snapshot for a player or NPC dict."""
    return {
        "npc_id": npc_id,
        "level": actor.get("level", 1),
        "xp": actor.get("xp", 0),
        "str": actor.get("str", 1),
        "def": actor.get("def", 1),
        "maxHp": actor.get("maxHp", 20),
        "maxKi": actor.get("maxKi", 20),
        "kiSkillLevel": actor.get("kiSkillLevel", 1),
        "blastLevel": actor.get("blastLevel", 0),
        "ki_moves": list(actor.get("ki_moves") or []),
        "has_ki_blast": bool(actor.get("has_ki_blast", True)),
    }


@router.get("/api/admin/entity_data")
async def entity_data(pid: str, npc_id: Optional[str] = None):
    """Return editable stats for a player/rival and, if npc_id given, that NPC."""
    p = game.players.get(pid)
    if not p:
        return {"ok": False, "error": f"'{pid}' not connected"}

    if npc_id:
        actor = p.get("npcs", {}).get(npc_id)
        if not actor:
            return {"ok": False, "error": f"NPC '{npc_id}' not found"}
        snap = _entity_snapshot(actor, npc_id)
    else:
        snap = _entity_snapshot(p)
        # Include NPC list so UI can populate the sub-selector
        snap["npcs"] = [
            {"id": nid, "level": npc.get("level", 1), "dead": bool(npc.get("dead"))}
            for nid, npc in p.get("npcs", {}).items()
        ]

    return {"ok": True, **snap}


class SetEntityStatsRequest(BaseModel):
    pid: str
    npc_id: Optional[str] = None
    level: Optional[int] = None
    xp: Optional[int] = None
    str_stat: Optional[int] = None
    def_stat: Optional[int] = None
    maxHp: Optional[int] = None
    maxKi: Optional[int] = None
    kiSkillLevel: Optional[int] = None
    blastLevel: Optional[int] = None
    ki_moves: Optional[list] = None
    has_ki_blast: Optional[bool] = None


@router.post("/api/admin/set_entity_stats")
async def set_entity_stats(req: SetEntityStatsRequest):
    """Directly set stats on a player or one of their NPCs."""
    p = game.players.get(req.pid)
    if not p:
        return {"ok": False, "error": f"'{req.pid}' not connected"}

    if req.npc_id:
        actor = p.get("npcs", {}).get(req.npc_id)
        if not actor:
            return {"ok": False, "error": f"NPC '{req.npc_id}' not found"}
    else:
        actor = p

    if req.level is not None:
        actor["level"] = max(1, req.level)
    if req.xp is not None:
        actor["xp"] = max(0, req.xp)
    if req.str_stat is not None:
        actor["str"] = max(1, req.str_stat)
    if req.def_stat is not None:
        actor["def"] = max(1, req.def_stat)
    if req.maxHp is not None:
        actor["maxHp"] = max(1, req.maxHp)
        actor["hp"] = actor["maxHp"]
    if req.maxKi is not None:
        actor["maxKi"] = max(1, req.maxKi)
        actor["ki"] = actor["maxKi"]
    if req.kiSkillLevel is not None:
        actor["kiSkillLevel"] = max(1, req.kiSkillLevel)
        actor["kiSkillXp"] = 0
    if req.blastLevel is not None:
        actor["blastLevel"] = max(0, req.blastLevel)
    if req.ki_moves is not None:
        actor["ki_moves"] = [str(m) for m in req.ki_moves]
    if req.has_ki_blast is not None:
        actor["has_ki_blast"] = req.has_ki_blast

    label = f"{req.pid}" + (f"/npc:{req.npc_id}" if req.npc_id else "")
    logger.info("Admin: set stats for %s", label)
    return {"ok": True, "snapshot": _entity_snapshot(actor, req.npc_id)}


# ── Model selector ────────────────────────────────────────────────────────────

def _load_model_list() -> list[str]:
    raw = get_setting("saved_models") or "[]"
    try:
        return json.loads(raw)
    except Exception:
        return []


def _save_model_list(models: list[str]):
    set_setting("saved_models", json.dumps(models))


def _update_env_model(model: str):
    """Write NANO_GPT_MODEL=... into the .env file, adding the line if missing."""
    if not ENV_FILE.exists():
        ENV_FILE.write_text(f"NANO_GPT_MODEL={model}\n", encoding="utf-8")
        return
    text = ENV_FILE.read_text(encoding="utf-8")
    if re.search(r"^NANO_GPT_MODEL\s*=", text, re.MULTILINE):
        text = re.sub(r"^NANO_GPT_MODEL\s*=.*$", f"NANO_GPT_MODEL={model}", text, flags=re.MULTILINE)
    else:
        text = text.rstrip("\n") + f"\nNANO_GPT_MODEL={model}\n"
    ENV_FILE.write_text(text, encoding="utf-8")


@router.get("/api/admin/model")
async def get_model():
    return {
        "current_model": cfg.MODEL,
        "saved_models": _load_model_list(),
    }


class SetModelRequest(BaseModel):
    model: str


@router.post("/api/admin/model")
async def set_model(req: SetModelRequest):
    model = req.model.strip()
    if not model:
        return {"ok": False, "error": "Model name cannot be empty"}

    # Update live config
    cfg.MODEL = model
    os.environ["NANO_GPT_MODEL"] = model

    # Persist to .env
    _update_env_model(model)

    # Add to saved list if not already there
    models = _load_model_list()
    if model not in models:
        models.insert(0, model)
        models = models[:20]  # cap at 20
        _save_model_list(models)

    logger.info("Admin: switched model to %s", model)
    return {"ok": True, "current_model": model, "saved_models": models}


# ── Ki Blast Move Editor ──────────────────────────────────────────────────────

@router.get("/blasts", response_class=HTMLResponse)
async def blast_editor(request: Request):
    return templates.TemplateResponse("blastedit.html", {"request": request})


@router.get("/api/blasts")
async def get_blasts():
    import json as _json
    try:
        return _json.loads(_BLAST_MOVES_PATH.read_text(encoding="utf-8"))
    except Exception as e:
        logger.warning("Failed to read blast_moves.json: %s", e)
        return []


class BlastSaveBody(BaseModel):
    blasts: list


@router.post("/api/blasts")
async def save_blasts(body: BlastSaveBody):
    import json as _json
    try:
        _BLAST_MOVES_PATH.write_text(
            _json.dumps(body.blasts, indent=2, ensure_ascii=False),
            encoding="utf-8"
        )
        # Reload in-memory BLAST_DEFS so changes take effect without restart
        try:
            from services.combat_ki import reload_blast_defs
            reload_blast_defs()
        except Exception:
            pass
        return {"ok": True, "count": len(body.blasts)}
    except Exception as e:
        logger.warning("Failed to write blast_moves.json: %s", e)
        return {"ok": False, "error": str(e)}
