"""Smoke tests: verify service modules import and instantiate without error."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


def test_game_state_imports():
    from services.game_state import GameState
    assert GameState is not None


def test_database_imports():
    from services.database import init_db
    assert init_db is not None
