"""Smoke tests: verify service modules import and instantiate without error."""


def test_game_state_imports():
    from services.game_state import GameState
    assert GameState is not None


def test_database_imports():
    from services.database import init_db
    assert init_db is not None


def test_combat_imports():
    from services.game_state import GameState
    from services.combat import CombatService
    gs = GameState.__new__(GameState)  # bypass __init__ (avoids DB requirement)
    gs.combat = CombatService(gs)
    assert isinstance(gs.combat, CombatService)


def test_resources_imports():
    from services.resources import ResourceService
    assert ResourceService is not None
