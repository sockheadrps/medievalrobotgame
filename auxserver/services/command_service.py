import json

import httpx

from core.config import MODEL, OLLAMA_URL
from schemas.commands import ChatRequest
from services.prompt_loader import load_prompt

VALID_CATEGORIES = {
    "gather",
    "store",
    "smelt",
    "craft",
    "crank",
    "combat",
    "follow",
    "idle",
}

VALID_TASKS = {
    "gather",
    "deposit",
    "fill",
    "smelt",
    "loop",
    "follow",
    "idle",
    "attack_nearest_enemy",
    "deposit_to_crate",
}
VALID_GOALS = {
    "gather",
    "gather_from_rocks",
    "deposit_extra",
    "deposit_ore",
    "fill_furnace_wood",
    "crank_flywheel",
    "hunt_for_feathers",
    "gather_wood_for_arrows",
    "smith_arrowheads",
    "fetch_arrowheads",
    "craft_arrows",
    "deposit_arrows",
    "attack_nearest_enemy",
    "defend_player",
    "defend_location",
    "patrol_area",
}


def extract_command_json(raw: str) -> list:
    start = raw.find("[")
    if start == -1:
        return [{"task": "idle"}]
    depth = 0
    for i, ch in enumerate(raw[start:], start):
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                try:
                    result = json.loads(raw[start : i + 1])
                    if isinstance(result, list):
                        return result
                except Exception:
                    pass
                break
    return [{"task": "idle"}]


def validate_commands(raw: list) -> list:
    out = []
    for cmd in raw:
        if not isinstance(cmd, dict):
            continue
        task = cmd.get("task")
        if task not in VALID_TASKS:
            print(f"[Validator] Dropped unknown task: {cmd!r}")
            continue
        if task == "loop":
            goals = cmd.get("goals")
            if not isinstance(goals, list) or len(goals) == 0:
                print(f"[Validator] Dropped loop with no/invalid goals: {cmd!r}")
                continue
            valid_goals = [g for g in goals if isinstance(g, dict) and g.get("goal") in VALID_GOALS]
            if not valid_goals:
                print(f"[Validator] Dropped loop - all goals unknown: {cmd!r}")
                continue
            if len(valid_goals) < len(goals):
                dropped = [g for g in goals if g not in valid_goals]
                print(f"[Validator] Pruned unknown goals from loop: {dropped!r}")
            cmd = {**cmd, "goals": valid_goals}
        out.append(cmd)
    if not out:
        print("[Validator] All commands invalid - returning idle")
        return [{"task": "idle"}]
    return out


async def route_category(text: str, client: httpx.AsyncClient) -> str:
    router_prompt = load_prompt("router")
    resp = await client.post(
        OLLAMA_URL,
        json={
            "model": MODEL,
            "messages": [
                {"role": "system", "content": router_prompt},
                {"role": "user", "content": text},
            ],
            "stream": False,
            "options": {"temperature": 0, "num_predict": 5},
        },
    )
    resp.raise_for_status()
    raw = resp.json()["message"]["content"].strip().lower().split()[0]
    category = raw.strip(".,!?")
    if category not in VALID_CATEGORIES:
        print(f"[Router] UNKNOWN category '{category}' for input: {text!r}")
        return "fallback"
    print(f"[Router] '{text}' -> '{category}'")
    return category


async def specialist_commands(category: str, request: ChatRequest, client: httpx.AsyncClient) -> list:
    specialist_prompt = load_prompt(category)

    ctx_parts = []
    if request.npc_context:
        ctx_parts.append("NPC context: " + json.dumps(request.npc_context))
    if request.world_context:
        ctx_parts.append("World state: " + json.dumps(request.world_context))
    context_str = ("\n\n" + "\n".join(ctx_parts)) if ctx_parts else ""

    resp = await client.post(
        OLLAMA_URL,
        json={
            "model": MODEL,
            "messages": [
                {"role": "system", "content": specialist_prompt + context_str},
                {"role": "user", "content": request.text},
            ],
            "stream": False,
            "options": {"temperature": 0, "num_predict": 300},
        },
    )
    resp.raise_for_status()
    raw = resp.json()["message"]["content"].strip()
    print(f"[Specialist:{category}] raw -> {raw!r}")
    commands = extract_command_json(raw)
    return validate_commands(commands)


async def parse_command(request: ChatRequest) -> tuple[str, list]:
    async with httpx.AsyncClient(timeout=60.0) as client:
        category = await route_category(request.text, client)
        commands = await specialist_commands(category, request, client)
    return category, commands
