"""Smoke tests: verify service modules import and instantiate without error."""


def test_game_state_imports():
    from services.game_state import GameState
    assert GameState is not None


def test_database_imports():
    from services.database import init_db
    assert init_db is not None


def test_combat_imports():
    from services.combat import CombatService
    assert CombatService is not None
