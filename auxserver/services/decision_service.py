import json

import httpx

from core.config import MODEL, OLLAMA_URL
from services.prompt_loader import load_prompt, render_prompt
from services.soul_service import extract_soul_json
from services import personality_types as ptypes


VALID_INTENTS = {
    "follow",
    "stay_near_player",
    "defend_player",
    "attack_enemy",
    "retreat",
    "hold_position",
    "observe",
    "reposition",
    "do_nothing",
    "gather_wood",
    "train",
}

VALID_MEMORY_TYPES = {"event", "command", "observation", "dialogue", "relationship", "goal"}

FALLBACK = {
    "primary_intent": "follow",
    "secondary_intent": None,
    "target_id": None,
    "speech": None,
    "emotion_delta": {"trust": 0, "fear": 0, "anger": 0},
    "memory_candidates": [],
    "reason_summary": "Fallback behavior due to invalid model output.",
    "decision_confidence": 0.5,
}


def _clamp(val: float, lo: float, hi: float) -> float:
    try:
        v = float(val)
    except (TypeError, ValueError):
        return 0.0
    return max(lo, min(hi, v))


def validate_decision(raw: dict) -> dict:
    """Validate and sanitize an LLM decision response."""
    if not isinstance(raw, dict):
        return dict(FALLBACK)

    out = dict(FALLBACK)

    # primary_intent
    pi = raw.get("primary_intent")
    if pi in VALID_INTENTS:
        out["primary_intent"] = pi

    # secondary_intent
    si = raw.get("secondary_intent")
    if si in VALID_INTENTS:
        out["secondary_intent"] = si

    # target_id
    tid = raw.get("target_id")
    if isinstance(tid, str) and len(tid) < 64:
        out["target_id"] = tid

    # speech — max 80 chars
    speech = raw.get("speech")
    if isinstance(speech, str) and len(speech.strip()) > 0:
        out["speech"] = speech.strip()[:80]

    # emotion_delta — clamp to [-0.1, 0.1]
    ed = raw.get("emotion_delta")
    if isinstance(ed, dict):
        out["emotion_delta"] = {
            "trust": _clamp(ed.get("trust", 0), -0.1, 0.1),
            "fear":  _clamp(ed.get("fear", 0), -0.1, 0.1),
            "anger": _clamp(ed.get("anger", 0), -0.1, 0.1),
        }

    # memory_candidates — max 2, importance >= 0
    mcs = raw.get("memory_candidates")
    if isinstance(mcs, list):
        valid = []
        for mc in mcs[:2]:
            if not isinstance(mc, dict):
                continue
            text = mc.get("text", "")
            mtype = mc.get("type", "observation")
            imp = _clamp(mc.get("importance", 0), 0, 1)
            if isinstance(text, str) and len(text.strip()) > 0:
                valid.append({
                    "text": text.strip()[:200],
                    "type": mtype if mtype in VALID_MEMORY_TYPES else "observation",
                    "importance": round(imp, 2),
                })
        out["memory_candidates"] = valid

    # reason_summary
    rs = raw.get("reason_summary")
    if isinstance(rs, str):
        out["reason_summary"] = rs.strip()[:200]

    # decision_confidence
    dc = raw.get("decision_confidence")
    if dc is not None:
        out["decision_confidence"] = _clamp(dc, 0, 1)

    return out


async def generate_decision(state: dict) -> dict:
    """Send curated NPC state to LLM and return a validated decision."""
    npc_info = state.get("npc", {})
    # Inject personality type context if not already present
    personality = npc_info.get("personality", {})
    if "ptype" not in npc_info:
        type_name = personality.get("type", "") or ptypes.classify(personality)
        npc_info["ptype"] = ptypes.type_context(type_name)
    system_content = render_prompt("decision", state)

    # Build user message with full state
    user_content = (
        "Decide the NPC's next high-level action for the next 2 to 5 seconds.\n"
        "Return JSON only.\n\n"
        f"State:\n{json.dumps(state, indent=2)}"
    )

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                OLLAMA_URL,
                json={
                    "model": MODEL,
                    "messages": [
                        {"role": "system", "content": system_content},
                        {"role": "user", "content": user_content},
                    ],
                    "stream": False,
                    "think": False,
                    "options": {"temperature": 0.4, "num_predict": 400},
                },
            )
            resp.raise_for_status()

        raw_text = resp.json()["message"]["content"].strip()
        print(f"[decision:{npc_info.get('id', '?')}] raw -> {raw_text!r}")

        parsed = extract_soul_json(raw_text)
        if not parsed:
            print(f"[decision] Failed to parse JSON from response")
            return dict(FALLBACK)

        return validate_decision(parsed)

    except Exception as e:
        print(f"[decision] Error: {e}")
        return dict(FALLBACK)
