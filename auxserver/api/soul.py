from fastapi import APIRouter
from pydantic import BaseModel, Field

from schemas.soul import NPCSaveRequest, DialoguePromptRequest, DecisionPromptRequest, NPCChatPromptRequest
from services.soul_service import load_npc, list_npcs, save_npc, build_template_context
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


# ── Game client prompt rendering endpoints ─────────────────────────────────
# These endpoints are called by the game client (LLMClient.js) to get
# server-rendered prompts with personality types, ownership logic, etc.
# The client then passes the rendered prompt to its local Ollama instance.


@router.post("/build_dialogue_prompt")
async def build_dialogue_prompt(req: DialoguePromptRequest):
    """Render a dialogue system prompt from soul context.

    Returns the rendered system prompt string that the client passes to Ollama.
    """
    try:
        ctx = build_template_context(
            name=req.name,
            personality=req.personality,
            emotional_state=req.emotional_state,
            relationship=req.relationship,
            memories=req.memories,
            learned_phrases=req.learned_phrases,
            system_note=req.system_note,
            topic_entity=req.topic_entity,
            speaking_player=req.speaking_player,
            owner=req.owner,
            nearby_threats=req.nearby_threats,
        )
        if req.nearby_entities:
            ctx["nearby_entities"] = req.nearby_entities[:10]
        if req.nearby_threats:
            ctx["nearby_threats"] = req.nearby_threats[:6]
        rendered = render_prompt("dialogue", ctx)
        return {"prompt": rendered}
    except Exception as e:
        return {"error": str(e)}


@router.post("/build_decision_prompt")
async def build_decision_prompt(req: DecisionPromptRequest):
    """Render a decision system prompt from NPC state packet.

    Returns the rendered system prompt string that the client passes to Ollama.
    """
    try:
        # Inject personality type context if not already present
        npc_info = req.state.get("npc", {})
        personality = npc_info.get("personality", {})
        if "ptype" not in npc_info:
            type_name = personality.get("type", "") or ptypes.classify(personality)
            npc_info["ptype"] = ptypes.type_context(type_name)
        rendered = render_prompt("decision", req.state)
        return {"prompt": rendered}
    except Exception as e:
        return {"error": str(e)}


@router.post("/build_npc_chat_prompt")
async def build_npc_chat_prompt(req: NPCChatPromptRequest):
    """Render NPC chat + chat impact prompts for NPC-to-NPC conversation.

    Returns rendered prompts for both the NPC chat and the impact evaluation.
    """
    try:
        # Build context for the speaking NPC
        personality = req.personality or {}
        type_name = personality.get("type", "") or ptypes.classify(personality)

        ctx = {
            "npc": {
                "name": req.name,
                "personality": personality,
                "ptype": ptypes.type_context(type_name),
                "logs": req.logs,
            },
            "target": {
                "name": req.target_name,
                "logs": req.target_logs,
            },
            "emotion": {
                "trust": req.trust,
                "anger": req.anger,
            },
            "recent_memory": req.recent_memory,
        }
        if req.learned_phrases:
            ctx["learned_phrases"] = req.learned_phrases[:6]
        chat_prompt = render_prompt("npc_chat", ctx)
        impact_prompt = render_prompt("chat_impact", {})
        return {"chat_prompt": chat_prompt, "impact_prompt": impact_prompt}
    except Exception as e:
        return {"error": str(e)}


@router.post("/build_command_prompts")
async def build_command_prompts(req: RenderPromptRequest):
    """Render router + all specialist command prompts.

    Returns a dict of category → rendered prompt so the client can cache them.
    """
    try:
        ctx = req.context or {}
        prompts = {
            "router": render_prompt("router", ctx),
        }
        for cat in ("gather", "combat", "follow", "idle", "build", "fallback"):
            prompts[cat] = render_prompt(cat, ctx)
        return {"prompts": prompts}
    except Exception as e:
        return {"error": str(e)}
