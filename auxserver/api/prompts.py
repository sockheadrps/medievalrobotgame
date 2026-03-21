"""Serve rendered LLM prompt templates."""
from fastapi import APIRouter, Query
from services.prompt_loader import load_prompt
from services.template_renderer import render

router = APIRouter(prefix="/api/prompts")


@router.get("/{name}")
async def get_prompt(
    name: str,
    npc_name: str = Query(default=""),
    personality_type: str = Query(default="Pragmatist"),
    emotion: str = Query(default="neutral"),
    memory_summary: str = Query(default=""),
):
    template = load_prompt(name)
    rendered = render(template, {
        "npc_name": npc_name,
        "personality_type": personality_type,
        "emotion": emotion,
        "memory_summary": memory_summary,
    })
    return {"prompt": rendered}
