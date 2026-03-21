"""Resource gathering: thin facade combining all resource sub-services."""

from services.gathering import GatheringService
from services.cave_mining import CaveMiningService
from services.ground_items import GroundItemsService


class ResourceService(GatheringService, CaveMiningService, GroundItemsService):
    """Thin facade: combines all resource sub-services."""

    def __init__(self, game_state):
        self.gs = game_state
