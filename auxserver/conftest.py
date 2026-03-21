"""pytest configuration — adds auxserver/ to sys.path so service imports work."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# Prime the circular-import chain (building → game_state → building) once at
# session start so that individual test modules can safely do
# `from services.building import BuildingService` without hitting a partially-
# initialised module error.
import services.game_state  # noqa: F401  (side-effect import)
