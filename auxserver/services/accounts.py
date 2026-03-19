# accounts.py — Player account persistence via SQLite.

from services.database import (
    player_exists,
    save_player,
    load_player,
    create_player,
    list_players,
    register_player,
    authenticate_player,
    update_llm_model,
    get_setting,
    set_setting,
    reset_game,
)

# Re-export all functions so existing imports work unchanged.
__all__ = [
    "player_exists", "save_player", "load_player", "create_player",
    "list_players", "register_player", "authenticate_player",
    "update_llm_model", "get_setting", "set_setting", "reset_game",
]
