import json
import logging

from schemas.soul import DialogueRequest, NPCSaveRequest, SoulContext

logger = logging.getLogger(__name__)
from services.prompt_loader import load_prompt, render_prompt
from services import database as db
from services import personality_types as ptypes
from services.llm_gateway import chat_completion


def _try_extract_json_from(text: str) -> dict:
    """Try to extract the first complete JSON object from text using
    string-aware brace-depth tracking. Returns {} on failure."""
    start = text.find("{")
    if start == -1:
        return {}
    depth = 0
    in_string = False
    escape_next = False
    for i, ch in enumerate(text[start:], start):
        if escape_next:
            escape_next = False
            continue
        if ch == "\\" and in_string:
            escape_next = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    chunk = text[start : i + 1]
                    result = json.loads(chunk)
                    if isinstance(result, dict):
                        return result
                except Exception:
                    # Retry after stripping trailing commas before ] or }
                    import re as _re
                    cleaned = _re.sub(r",\s*([}\]])", r"\1", chunk)
                    try:
                        result = json.loads(cleaned)
                        if isinstance(result, dict):
                            return result
                    except Exception as exc2:
                        logger.warning("extract_soul_json: json.loads failed: %s | snippet: %.200s", exc2, chunk)
                break
    return {}


def extract_soul_json(raw: str) -> dict:
    """Extract the first complete JSON object from LLM output.

    Tries (in order):
    1. Each ```json / ```python / ``` code block in the text
    2. The raw text itself
    Returns {} if nothing parses successfully.
    """
    import re

    # Try code blocks first — the LLM often abandons inline JSON mid-way and
    # then provides a clean version inside a code fence.
    for m in re.finditer(r"```(?:json|python|)\s*\n(.*?)```", raw, re.DOTALL):
        result = _try_extract_json_from(m.group(1))
        if result:
            return result

    # Fall back to scanning the raw text
    return _try_extract_json_from(raw)


def clamp_deltas(deltas: dict) -> dict:
    clamped = {}
    for key in ("trust", "fear", "anger"):
        val = deltas.get(key, 0.0)
        try:
            val = float(val)
        except (TypeError, ValueError):
            val = 0.0
        clamped[key] = max(-0.4, min(0.4, val))
    return clamped


def _soul_block(soul: SoulContext) -> str:
    payload = {
        "name": soul.name,
        "personality": soul.personality,
        "emotional_state": soul.emotional_state,
        "relationship": soul.relationship,
        "memories": soul.memories[-12:] if soul.memories else [],
    }
    return json.dumps(payload, indent=2)


def _build_template_context(
    soul: SoulContext,
    world_context: dict | None = None,
    system_note: str = "",
    topic_entity: dict | None = None,
    speaking_player: str = "",
    owner: str = "",
) -> dict:
    """Build a flat context dict for template rendering from soul + world state."""
    personality = soul.personality or {}

    # Resolve personality type — explicit field, or auto-classify from traits
    type_name = personality.get("type", "")
    if not type_name:
        type_name = ptypes.classify(personality)

    ctx = {
        "npc": {
            "name": soul.name,
            "personality": personality,
            "ptype": ptypes.type_context(type_name),
        },
        "emotion": soul.emotional_state,
        "relationship": soul.relationship,
        "memories": soul.memories[-12:] if soul.memories else [],
    }
    if soul.learned_phrases:
        ctx["learned_phrases"] = soul.learned_phrases[:6]
    if getattr(soul, "nearby_threats", None):
        ctx["nearby_threats"] = soul.nearby_threats[:6]
    if system_note:
        ctx["system_note"] = system_note
    if topic_entity:
        ctx["topic_entity"] = topic_entity
    if speaking_player:
        ctx["speaking_player"] = speaking_player
    if owner:
        ctx["owner"] = owner
    if speaking_player and owner:
        ctx["is_owner"] = speaking_player == owner
    if world_context:
        ctx["world"] = world_context
    return ctx


def build_template_context(
    name: str = "NPC",
    personality: dict | None = None,
    emotional_state: dict | None = None,
    relationship: str = "neutral",
    memories: list | None = None,
    learned_phrases: list | None = None,
    system_note: str = "",
    topic_entity: dict | None = None,
    speaking_player: str = "",
    owner: str = "",
    world_context: dict | None = None,
    nearby_threats: list | None = None,
) -> dict:
    """Build a template context dict from plain values (for API use)."""
    personality = personality or {}
    emotional_state = emotional_state or {}
    memories = memories or []

    type_name = personality.get("type", "")
    if not type_name:
        type_name = ptypes.classify(personality)

    ctx = {
        "npc": {
            "name": name,
            "personality": personality,
            "ptype": ptypes.type_context(type_name),
        },
        "emotion": emotional_state,
        "relationship": relationship,
        "memories": memories[-12:] if memories else [],
    }
    if learned_phrases:
        ctx["learned_phrases"] = learned_phrases[:6]
    if nearby_threats:
        ctx["nearby_threats"] = nearby_threats[:6]
    if system_note:
        ctx["system_note"] = system_note
    if topic_entity:
        ctx["topic_entity"] = topic_entity
    if speaking_player:
        ctx["speaking_player"] = speaking_player
    if owner:
        ctx["owner"] = owner
    if speaking_player and owner:
        ctx["is_owner"] = speaking_player == owner
    if world_context:
        ctx["world"] = world_context
    return ctx


async def generate_dialogue(request: DialogueRequest) -> dict:
    ctx = _build_template_context(
        request.soul, request.world_context,
        system_note=request.soul.system_note,
        topic_entity=request.soul.topic_entity,
        speaking_player=request.speaking_player,
        owner=request.owner,
    )
    system_content = render_prompt("dialogue", ctx)

    raw = await chat_completion(
        [
            {"role": "system", "content": system_content},
            {"role": "user", "content": request.player_message},
        ],
        temperature=0.7,
        max_tokens=300,
        timeout=60.0,
    )
    logger.debug("dialogue[%s] raw -> %r", request.npc_id, raw)
    result = extract_soul_json(raw)
    dialogue = result.get("dialogue", "...")
    deltas = clamp_deltas(result.get("emotion_deltas", {}))
    memory = result.get("memory_tag")
    out = {"dialogue": dialogue, "emotion_deltas": deltas}
    if memory:
        out["memory_tag"] = memory
    return out


# ── NPC persistence (SQLite) ──────────────────────────────────────────────────

def save_npc(request: NPCSaveRequest) -> dict:
    return db.save_npc(request.id, request.name, request.x, request.y, request.stats, request.soul)


def load_npc(npc_id: str) -> dict | None:
    return db.load_npc(npc_id)


def list_npcs() -> list[str]:
    return db.list_npcs()
