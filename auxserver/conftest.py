"""pytest configuration — adds auxserver/ to sys.path so service imports work."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
