import json

import httpx

from core.config import MODEL, OLLAMA_URL
from schemas.soul import DialogueRequest, NPCSaveRequest, SoulContext
from services.prompt_loader import load_prompt
from services import database as db


def extract_soul_json(raw: str) -> dict:
    start = raw.find("{")
    if start == -1:
        return {}
    depth = 0
    for i, ch in enumerate(raw[start:], start):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(raw[start : i + 1])
                except Exception:
                    pass
                break
    return {}


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


async def generate_dialogue(request: DialogueRequest) -> dict:
    prompt_text = load_prompt("dialogue")
    system_content = prompt_text + f"\n\nNPC soul:\n{_soul_block(request.soul)}"
    if request.world_context:
        system_content += "\n\nWorld state: " + json.dumps(request.world_context)

    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(
            OLLAMA_URL,
            json={
                "model": MODEL,
                "messages": [
                    {"role": "system", "content": system_content},
                    {"role": "user", "content": request.player_message},
                ],
                "stream": False,
                "options": {"temperature": 0.7, "num_predict": 300},
            },
        )
        resp.raise_for_status()

    raw = resp.json()["message"]["content"].strip()
    print(f"[dialogue:{request.npc_id}] raw -> {raw!r}")
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
