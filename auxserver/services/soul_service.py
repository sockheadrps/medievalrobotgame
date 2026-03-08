import json
import re
from datetime import datetime, timezone

import httpx

from core.config import BASE_DIR, MODEL, OLLAMA_URL
from schemas.soul import (
    AggressionMemoryRequest,
    DialogueRequest,
    EncounterRequest,
    QuipRequest,
    SoulContext,
    ThoughtRequest,
)
from services.prompt_loader import load_prompt

ALLOWED_ACTIONS = {"idle", "move_to", "trade", "flee", "rename_self"}
RESERVED_NAMES = {"player", "boss", "admin", "system", "npc", "rival"}
BANNED_TOKENS = {"fuck", "shit", "bitch", "slur"}
REL_KEYS = ("trust", "respect", "anger", "fear", "rivalry")


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


def _safe_float(value, default=0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def _norm_relationship_metrics(metrics: dict | None) -> dict:
    metrics = metrics or {}
    return {k: _clamp(_safe_float(metrics.get(k, 0.0)), -100.0, 100.0) for k in REL_KEYS}


def clamp_relationship_deltas(deltas: dict) -> dict:
    clamped = {}
    for key in REL_KEYS:
        val = _safe_float((deltas or {}).get(key, 0.0), 0.0)
        clamped[key] = _clamp(val, -35.0, 35.0)
    return clamped


def _merge_deltas(base: dict, extra: dict) -> dict:
    merged = {}
    for key in ("trust", "fear", "anger"):
        merged[key] = _safe_float(base.get(key, 0.0)) + _safe_float(extra.get(key, 0.0))
    return clamp_deltas(merged)


def _get_relationship_metrics(soul: SoulContext, other_id: str) -> dict:
    rel_map = soul.relationship_dynamics or {}
    if not isinstance(rel_map, dict):
        return _norm_relationship_metrics({})
    metrics = rel_map.get(other_id)
    if isinstance(metrics, dict):
        return _norm_relationship_metrics(metrics)
    # Fallback for legacy data: first available object
    for value in rel_map.values():
        if isinstance(value, dict):
            return _norm_relationship_metrics(value)
    return _norm_relationship_metrics({})


def _validate_rename_name(name: str) -> str | None:
    clean = str(name or "").strip()
    if len(clean) < 2 or len(clean) > 20:
        return None
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9 _'\-]{1,19}", clean):
        return None
    lower = clean.lower()
    if lower in RESERVED_NAMES:
        return None
    if any(token in lower for token in BANNED_TOKENS):
        return None
    return clean


def _extract_action(result: dict) -> dict:
    action = result.get("action", "idle")
    params = result.get("params", {})
    if isinstance(action, dict):
        params = action.get("params", params)
        action = action.get("type", "idle")
    if not isinstance(params, dict):
        params = {}
    action = str(action or "idle").strip()
    if action not in ALLOWED_ACTIONS:
        return {"type": "idle", "params": {}}
    if action == "rename_self":
        new_name = _validate_rename_name(params.get("new_name"))
        if not new_name:
            return {"type": "idle", "params": {}}
        return {"type": "rename_self", "params": {"new_name": new_name}}
    return {"type": action, "params": {}}


def _outcome_emotion_nudge(outcome: str, aggressor: str, role: str) -> dict:
    if outcome == "friendly":
        return {"trust": 0.03, "fear": -0.01, "anger": -0.03}
    if outcome == "fight":
        if aggressor == role:
            return {"trust": -0.05, "fear": 0.01, "anger": 0.09}
        return {"trust": -0.06, "fear": 0.08, "anger": 0.06}
    return {"trust": -0.03, "fear": 0.02, "anger": 0.05}


def _resolve_encounter(request: EncounterRequest, llm_outcome: str) -> tuple[str, str, dict, dict]:
    opener_metrics = _get_relationship_metrics(request.opener_soul, request.responder_id)
    responder_metrics = _get_relationship_metrics(request.responder_soul, request.opener_id)

    op_personality = request.opener_soul.personality or {}
    rs_personality = request.responder_soul.personality or {}
    op_emotions = request.opener_soul.emotional_state or {}
    rs_emotions = request.responder_soul.emotional_state or {}

    op_aggr = _clamp(_safe_float(op_personality.get("aggression"), 0.3), 0.0, 1.0)
    rs_aggr = _clamp(_safe_float(rs_personality.get("aggression"), 0.3), 0.0, 1.0)
    op_coop = _clamp(_safe_float(op_personality.get("cooperation"), 0.5), 0.0, 1.0)
    rs_coop = _clamp(_safe_float(rs_personality.get("cooperation"), 0.5), 0.0, 1.0)

    op_impulse = _clamp(
        _safe_float(op_personality.get("impulse_control"), 1.0 - (op_aggr * 0.7)),
        0.0,
        1.0,
    )
    rs_impulse = _clamp(
        _safe_float(rs_personality.get("impulse_control"), 1.0 - (rs_aggr * 0.7)),
        0.0,
        1.0,
    )

    op_pair_anger = max(0.0, opener_metrics["anger"]) / 100.0
    rs_pair_anger = max(0.0, responder_metrics["anger"]) / 100.0
    op_pair_rivalry = max(0.0, opener_metrics["rivalry"]) / 100.0
    rs_pair_rivalry = max(0.0, responder_metrics["rivalry"]) / 100.0
    op_pair_trust = max(0.0, opener_metrics["trust"]) / 100.0
    rs_pair_trust = max(0.0, responder_metrics["trust"]) / 100.0
    op_pair_respect = max(0.0, opener_metrics["respect"]) / 100.0
    rs_pair_respect = max(0.0, responder_metrics["respect"]) / 100.0

    op_anger = _clamp(_safe_float(op_emotions.get("anger"), 0.2), 0.0, 1.0)
    rs_anger = _clamp(_safe_float(rs_emotions.get("anger"), 0.2), 0.0, 1.0)

    fight_score = (
        0.30 * max(op_pair_anger, rs_pair_anger)
        + 0.24 * max(op_pair_rivalry, rs_pair_rivalry)
        + 0.18 * max(op_aggr, rs_aggr)
        + 0.16 * max(op_anger, rs_anger)
        + 0.12 * max(1.0 - op_impulse, 1.0 - rs_impulse)
        - 0.16 * min(op_coop, rs_coop)
    )
    friendly_score = (
        0.35 * ((op_pair_trust + rs_pair_trust) / 2.0)
        + 0.25 * ((op_pair_respect + rs_pair_respect) / 2.0)
        + 0.22 * ((op_coop + rs_coop) / 2.0)
        - 0.20 * max(op_pair_anger, rs_pair_anger)
        - 0.16 * max(op_pair_rivalry, rs_pair_rivalry)
    )
    if llm_outcome == "fight":
        fight_score += 0.12
    elif llm_outcome == "friendly":
        fight_score -= 0.07
        friendly_score += 0.10

    if fight_score >= 0.72:
        outcome = "fight"
    elif friendly_score >= 0.58 and fight_score < 0.65:
        outcome = "friendly"
    else:
        outcome = "argue"

    aggressor = "none"
    if outcome == "fight":
        opener_trigger = (
            opener_metrics["anger"]
            + opener_metrics["rivalry"]
            + (op_aggr * 100.0)
            + ((1.0 - op_impulse) * 90.0)
            + (op_anger * 70.0)
        )
        responder_trigger = (
            responder_metrics["anger"]
            + responder_metrics["rivalry"]
            + (rs_aggr * 100.0)
            + ((1.0 - rs_impulse) * 90.0)
            + (rs_anger * 70.0)
        )
        aggressor = "opener" if opener_trigger >= responder_trigger else "responder"

    if outcome == "friendly":
        opener_rel = {"trust": 8, "respect": 6, "anger": -8, "fear": -4, "rivalry": -6}
        responder_rel = {"trust": 8, "respect": 6, "anger": -8, "fear": -4, "rivalry": -6}
    elif outcome == "fight":
        opener_rel = {"trust": -14, "respect": -12, "anger": 16, "fear": 4, "rivalry": 12}
        responder_rel = {"trust": -14, "respect": -12, "anger": 16, "fear": 6, "rivalry": 12}
        if aggressor == "opener":
            opener_rel["fear"] = 2
            responder_rel["fear"] = 8
        else:
            opener_rel["fear"] = 8
            responder_rel["fear"] = 2
    else:
        opener_rel = {"trust": -6, "respect": -8, "anger": 10, "fear": 2, "rivalry": 7}
        responder_rel = {"trust": -6, "respect": -8, "anger": 10, "fear": 2, "rivalry": 7}

    return (
        outcome,
        aggressor,
        clamp_relationship_deltas(opener_rel),
        clamp_relationship_deltas(responder_rel),
    )


def _soul_block(soul: SoulContext, with_memory: bool = True) -> str:
    payload = {
        "name": soul.name,
        "personality": soul.personality,
        "emotional_state": soul.emotional_state,
        "relationship": soul.relationship,
        "relationship_dynamics": soul.relationship_dynamics,
    }
    if with_memory:
        payload["recent_memories"] = soul.recent_memories
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
    action = _extract_action(result)
    out = {"dialogue": dialogue, "emotion_deltas": deltas, "action": action}
    if memory:
        out["memory_tag"] = memory
    return out


async def generate_thought(request: ThoughtRequest) -> dict:
    prompt_text = load_prompt("thought")
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
                    {"role": "user", "content": f"Event: {request.event}"},
                ],
                "stream": False,
                "options": {"temperature": 0.8, "num_predict": 150},
            },
        )
        resp.raise_for_status()

    raw = resp.json()["message"]["content"].strip()
    print(f"[thought:{request.npc_id}] raw -> {raw!r}")
    result = extract_soul_json(raw)
    thought = result.get("thought", "...")
    deltas = clamp_deltas(result.get("emotion_deltas", {}))
    return {"thought": thought, "emotion_deltas": deltas}


async def generate_quip(request: QuipRequest) -> dict:
    prompt_text = load_prompt("quip")
    soul_block = _soul_block(request.soul, with_memory=False)
    user_msg = f"Situation: {request.situation}"
    if request.other_name:
        user_msg += f"\nAddressed to: {request.other_name}"
    system_content = prompt_text + f"\n\nNPC soul:\n{soul_block}"

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                OLLAMA_URL,
                json={
                    "model": MODEL,
                    "messages": [
                        {"role": "system", "content": system_content},
                        {"role": "user", "content": user_msg},
                    ],
                    "stream": False,
                    "options": {"temperature": 0.9, "num_predict": 60},
                },
            )
            resp.raise_for_status()

        raw = resp.json()["message"]["content"].strip()
        result = extract_soul_json(raw)
        quip = result.get("quip") or result.get("line") or result.get("text") or raw
        quip = quip.strip().strip('"').strip("'")
        print(f"[quip:{request.npc_id}:{request.situation}] -> {quip!r}")
        return {"quip": quip}
    except Exception as exc:
        fallback_by_situation = {
            "rival_nearby": "Keep an eye on them.",
            "rival_spotted": "We should stay alert.",
            "heard_player": "I heard you.",
            "greet_npc": "Hey.",
            "greet_player": "Boss.",
            "npc_reply": "Yeah, fair enough.",
        }
        fallback = fallback_by_situation.get(request.situation, "...")
        print(f"[quip:{request.npc_id}:{request.situation}] fallback due to error: {exc}")
        return {"quip": fallback}


async def generate_encounter(request: EncounterRequest) -> dict:
    prompt_text = load_prompt("encounter")
    opener_block = _soul_block(request.opener_soul, with_memory=True)
    responder_block = _soul_block(request.responder_soul, with_memory=True)
    system_content = (
        prompt_text
        + f"\n\nopener_soul:\n{opener_block}"
        + f"\n\nresponder_soul:\n{responder_block}"
    )

    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(
            OLLAMA_URL,
            json={
                "model": MODEL,
                "messages": [
                    {"role": "system", "content": system_content},
                    {"role": "user", "content": "Generate the encounter exchange now."},
                ],
                "stream": False,
                "options": {"temperature": 0.85, "num_predict": 200},
            },
        )
        resp.raise_for_status()

    raw = resp.json()["message"]["content"].strip()
    print(f"[encounter:{request.opener_id}->{request.responder_id}] raw -> {raw!r}")

    result = extract_soul_json(raw)
    opener_line = result.get("opener_line", "...")
    reply_line = result.get("reply_line", "...")
    outcome = result.get("outcome", "argue")
    if outcome not in ("friendly", "argue", "fight"):
        outcome = "argue"

    (
        resolved_outcome,
        aggressor,
        opener_rel_deltas,
        responder_rel_deltas,
    ) = _resolve_encounter(request, outcome)
    opener_deltas = _merge_deltas(
        clamp_deltas(result.get("opener_emotion_deltas", {})),
        _outcome_emotion_nudge(resolved_outcome, aggressor, "opener"),
    )
    responder_deltas = _merge_deltas(
        clamp_deltas(result.get("responder_emotion_deltas", {})),
        _outcome_emotion_nudge(resolved_outcome, aggressor, "responder"),
    )

    return {
        "opener_line": opener_line,
        "reply_line": reply_line,
        "outcome": resolved_outcome,
        "aggressor": aggressor,
        "opener_emotion_deltas": opener_deltas,
        "responder_emotion_deltas": responder_deltas,
        "opener_relationship_deltas": opener_rel_deltas,
        "responder_relationship_deltas": responder_rel_deltas,
    }


def _clean_log_text(text: str, max_len: int = 220) -> str:
    clean = re.sub(r"\s+", " ", str(text or "")).strip()
    if len(clean) > max_len:
        clean = clean[: max_len - 3] + "..."
    return clean


async def log_violent_memory(request: AggressionMemoryRequest) -> dict:
    memory_file = BASE_DIR.parent / "memory.md"
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    aggressor_name = _clean_log_text(request.aggressor_name, 80) or request.aggressor_id
    target_name = _clean_log_text(request.target_name, 80) or request.target_id
    trigger = _clean_log_text(request.trigger, 80) or "unknown"

    statements = []
    seen = set()
    for raw in (request.worst_statements or []):
        s = _clean_log_text(raw)
        if not s:
            continue
        key = s.lower()
        if key in seen:
            continue
        seen.add(key)
        statements.append(s)
        if len(statements) >= 3:
            break

    lines = [
        f"## {timestamp} - Violent Aggression",
        f"- Trigger: `{trigger}`",
        f"- Aggressor: `{aggressor_name}` (`{request.aggressor_id}`)",
        f"- Target: `{target_name}` (`{request.target_id}`)",
        "- Worst statements said to aggressor:",
    ]
    if statements:
        for i, s in enumerate(statements, start=1):
            lines.append(f"  {i}. \"{s}\"")
    else:
        lines.append("  1. (no direct statement captured)")
    lines.append("")

    if not memory_file.exists():
        memory_file.write_text("# Memory Log\n\n", encoding="utf-8")
    with memory_file.open("a", encoding="utf-8") as f:
        f.write("\n".join(lines))

    return {"ok": True, "path": str(memory_file)}
