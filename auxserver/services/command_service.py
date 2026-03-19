import json

import httpx

from schemas.commands import ChatRequest
from services.prompt_loader import load_prompt, render_prompt
from services.llm_gateway import chat_completion

VALID_CATEGORIES = {
    "gather",
    "combat",
    "follow",
    "idle",
    "build",
    "chat",
}

VALID_TASKS = {
    "gather",
    "gather_stone",
    "gather_all",
    "follow",
    "idle",
    "attack_nearest_enemy",
    "attack_player",
    "attack_npc",
    "defend_player",
    "train",
    "give_logs",
    "build_fence",
    "light_campfire",
    "guard_fire",
    "learn_ki",
    "show_blast",
    "practice_ki",
    "pickup_stone",
    "refine_stone",
    "give_materials",
    "meditate",
}
VALID_GOALS = {
    "gather",
    "attack_nearest_enemy",
    "defend_player",
    "train",
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
    raw_text = await chat_completion(
        [
            {"role": "system", "content": router_prompt},
            {"role": "user", "content": text},
        ],
        temperature=0,
        max_tokens=5,
        timeout=60.0,
    )
    raw = raw_text.strip().lower().split()[0]
    category = raw.strip(".,!?")
    if category not in VALID_CATEGORIES:
        print(f"[Router] UNKNOWN category '{category}' for input: {text!r}")
        return "fallback"
    print(f"[Router] '{text}' -> '{category}'")
    return category


async def specialist_commands(category: str, request: ChatRequest, client: httpx.AsyncClient) -> list:
    # Build template context from request
    tmpl_ctx = {}
    if request.npc_context:
        tmpl_ctx["npc"] = request.npc_context
    if request.world_context:
        tmpl_ctx["world"] = request.world_context

    specialist_prompt = render_prompt(category, tmpl_ctx)

    # For plain-text prompts, append context the old way
    if "{{" not in load_prompt(category):
        ctx_parts = []
        if request.npc_context:
            ctx_parts.append("NPC context: " + json.dumps(request.npc_context))
        if request.world_context:
            ctx_parts.append("World state: " + json.dumps(request.world_context))
        context_str = ("\n\n" + "\n".join(ctx_parts)) if ctx_parts else ""
        specialist_prompt += context_str

    raw = await chat_completion(
        [
            {"role": "system", "content": specialist_prompt},
            {"role": "user", "content": request.text},
        ],
        temperature=0,
        max_tokens=300,
        timeout=60.0,
    )
    print(f"[Specialist:{category}] raw -> {raw!r}")
    commands = extract_command_json(raw)
    return validate_commands(commands)


_KEYWORD_SHORTCUTS = {
    "practice ki":      ("combat", [{"task": "practice_ki"}]),
    "train ki":         ("combat", [{"task": "practice_ki"}]),
    "learn ki":         ("combat", [{"task": "practice_ki"}]),
    "ki blast practice":("combat", [{"task": "practice_ki"}]),
    "practice energy":  ("combat", [{"task": "practice_ki"}]),
    "train on dummy":   ("combat", [{"task": "train"}]),
    "train melee":      ("combat", [{"task": "train"}]),
    "attack":           ("combat", [{"task": "attack_nearest_enemy"}]),
    "defend me":        ("combat", [{"task": "defend_player"}]),
    "guard me":         ("combat", [{"task": "defend_player"}]),
    "follow me":        ("follow", [{"task": "follow"}]),
    "come here":        ("follow", [{"task": "follow"}]),
    "stop":             ("idle",   [{"task": "idle"}]),
    "gather wood":      ("gather", [{"task": "gather"}]),
    "chop trees":       ("gather", [{"task": "gather"}]),
    "get wood":         ("gather", [{"task": "gather"}]),
    "gather logs":      ("gather", [{"task": "gather"}]),
    "get logs":         ("gather", [{"task": "gather"}]),
    "pickup stone":     ("combat", [{"task": "pickup_stone"}]),
    "refine stone":     ("combat", [{"task": "refine_stone"}]),
}


async def parse_command(request: ChatRequest) -> tuple[str, list]:
    # Fast keyword matching — bypass LLM for common commands
    text_lower = request.text.strip().lower()
    for keyword, result in _KEYWORD_SHORTCUTS.items():
        if text_lower == keyword or text_lower.startswith(keyword + " "):
            print(f"[CommandService] Keyword shortcut: '{request.text}' -> {result}")
            return result

    async with httpx.AsyncClient(timeout=60.0) as client:
        category = await route_category(request.text, client)
        # Chat is conversation, not a command — return idle to fall through to dialogue
        if category == "chat":
            return category, [{"task": "idle"}]
        commands = await specialist_commands(category, request, client)
    return category, commands
