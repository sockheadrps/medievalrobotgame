from fastapi import APIRouter
from pydantic import BaseModel, Field

from schemas.soul import NPCSaveRequest
from services.soul_service import load_npc, list_npcs, save_npc
from services.prompt_loader import load_prompt, render_prompt, clear_cache as clear_prompt_cache
from services import personality_types as ptypes

router = APIRouter()


class RenderPromptRequest(BaseModel):
    category: str
    context: dict = Field(default_factory=dict)


@router.post("/npc_save")
async def npc_save(request: NPCSaveRequest):
    return save_npc(request)


@router.get("/npc_load/{npc_id}")
async def npc_load(npc_id: str):
    data = load_npc(npc_id)
    if data is None:
        return {"found": False}
    return {"found": True, "data": data}


@router.get("/npc_list")
async def npc_list():
    return {"npcs": list_npcs()}


@router.get("/personality_types")
async def personality_type_list():
    return ptypes.all_types()


@router.get("/personality_types/{type_name}")
async def personality_type_get(type_name: str):
    td = ptypes.get_type(type_name)
    if td is None:
        return {"error": f"Unknown type: {type_name}"}
    return {type_name: td}


@router.post("/render_prompt")
async def render_prompt_endpoint(req: RenderPromptRequest):
    """Render a prompt template with the given context.

    Returns the raw template and the rendered result.
    """
    try:
        raw = load_prompt(req.category)
        rendered = render_prompt(req.category, req.context)
        return {"category": req.category, "raw": raw, "rendered": rendered}
    except Exception as e:
        return {"error": str(e)}


@router.get("/prompt_raw/{category}")
async def prompt_raw(category: str):
    """Return the raw (unrendered) template for a given prompt category."""
    try:
        raw = load_prompt(category)
        return {"category": category, "raw": raw}
    except Exception as e:
        return {"error": str(e)}


@router.get("/prompt_list")
async def prompt_list():
    """List all available prompt template categories."""
    from pathlib import Path
    from core.config import PROMPTS_DIR
    templates = [p.stem for p in Path(PROMPTS_DIR).glob("*.txt")]
    return {"prompts": sorted(templates)}
