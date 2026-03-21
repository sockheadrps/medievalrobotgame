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
    from services.game_state import GameState
    from services.resources import ResourceService
    gs = GameState.__new__(GameState)  # bypass __init__ (avoids DB requirement)
    gs.resources = ResourceService(gs)
    assert isinstance(gs.resources, ResourceService)


def test_building_imports():
    from services.game_state import GameState
    from services.building import BuildingService
    gs = GameState.__new__(GameState)  # bypass __init__ (avoids DB requirement)
    gs.building = BuildingService(gs)
    assert isinstance(gs.building, BuildingService)


def test_npc_manager_imports():
    from services.game_state import GameState
    from services.npc_manager import NPCManager
    gs = GameState.__new__(GameState)  # bypass __init__ (avoids DB requirement)
    gs.npc_manager = NPCManager(gs)
    assert isinstance(gs.npc_manager, NPCManager)


def test_player_manager_imports():
    from services.game_state import GameState
    from services.player_manager import PlayerManager
    gs = GameState.__new__(GameState)  # bypass __init__ (avoids DB requirement)
    gs.player_manager = PlayerManager(gs)
    assert isinstance(gs.player_manager, PlayerManager)


def test_portals_imports():
    from services.game_state import GameState
    from services.portals import PortalService
    gs = GameState.__new__(GameState)  # bypass __init__ (avoids DB requirement)
    gs.portals = PortalService(gs)
    assert isinstance(gs.portals, PortalService)


def test_all_services_import():
    from services.combat import CombatService
    from services.resources import ResourceService
    from services.building import BuildingService
    from services.npc_manager import NPCManager
    from services.player_manager import PlayerManager
    from services.portals import PortalService
    # all imported without error
    assert True


def test_world_data_imports():
    from services.world_data import TILE_SIZE, PORTALS, WORLD_OBJECT_INSTANCES
    assert TILE_SIZE == 48


def test_constants_loads():
    from core.constants import TILE_SIZE
    assert isinstance(TILE_SIZE, (int, float))
    assert TILE_SIZE > 0


def test_prompts_router_imports():
    from api.prompts import router
    assert router is not None
