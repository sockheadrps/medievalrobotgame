# combat.py — Thin facade combining CombatMeleeService and CombatKiService.

from services.combat_melee import CombatMeleeService
from services.combat_ki import CombatKiService


class CombatService(CombatMeleeService, CombatKiService):
    """Thin facade: combines CombatMeleeService and CombatKiService."""

    def __init__(self, game_state):
        self.gs = game_state
