# accounts.py — REST endpoints for player login/register.

from fastapi import APIRouter
from pydantic import BaseModel

from core.config import DEV_MODE, MODEL, NUM_CTX
from services.accounts import (
    player_exists, load_player, create_player, list_players,
    register_player, authenticate_player, update_llm_model,
    get_setting, reset_game,
)

router = APIRouter()


class LoginRequest(BaseModel):
    username: str
    password: str = ""


class RegisterRequest(BaseModel):
    username: str
    password: str
    chat_color: str = "#cccccc"


def _validate_username(username: str):
    if not username or len(username) < 2 or len(username) > 20:
        return "Username must be 2-20 characters"
    safe = "".join(c for c in username if c.isalnum() or c == "_")
    if safe != username:
        return "Username can only contain letters, numbers, and underscores"
    return None


@router.post("/register")
async def register(req: RegisterRequest):
    """Create a new account with username + password."""
    username = req.username.strip()
    err = _validate_username(username)
    if err:
        return {"ok": False, "error": err}
    if len(req.password) < 3:
        return {"ok": False, "error": "Password must be at least 3 characters"}

    data = register_player(username, req.password, req.chat_color)
    if data is None:
        return {"ok": False, "error": "Username already taken"}
    return {"ok": True, "is_new": True, "player": data}


@router.post("/login")
async def login(req: LoginRequest):
    """Login with username + password."""
    username = req.username.strip()
    err = _validate_username(username)
    if err:
        return {"ok": False, "error": err}

    if not player_exists(username):
        return {"ok": False, "error": "Account not found"}

    data = authenticate_player(username, req.password)
    if data is None:
        return {"ok": False, "error": "Wrong password"}

    return {"ok": True, "is_new": False, "player": data}


class SetModelRequest(BaseModel):
    username: str
    model: str


@router.post("/set_model")
async def set_model(req: SetModelRequest):
    """Save the player's LLM model choice to their account."""
    username = req.username.strip()
    if not player_exists(username):
        return {"ok": False, "error": "Account not found"}
    update_llm_model(username, req.model)
    return {"ok": True}


@router.get("/game_config")
async def game_config():
    """Client-readable config. In dev mode, forces a specific model for all players."""
    return {
        "dev_mode": DEV_MODE,
        "forced_model": MODEL if DEV_MODE else None,
        "num_ctx": NUM_CTX if DEV_MODE else None,
    }


@router.post("/reset_game")
async def do_reset_game():
    """Wipe all world state and player stats. Keeps accounts."""
    from services.game_state import game
    from services.ai_player import ai_player

    # Reset DB
    reset_game()
    # Reset in-memory game state
    game.reset()
    # Re-spawn AI rival fresh
    ai_player.reset()
    return {"ok": True}


@router.get("/players")
async def get_players():
    return {"players": list_players()}
