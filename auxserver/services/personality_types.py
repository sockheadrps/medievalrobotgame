"""
Personality type system for NPCs.

Types are qualitative archetypes layered on top of numeric traits.
Numeric traits remain the source of truth for simulation; types provide
prompting guidance, speech style, and spawn-time trait ranges.
"""

from __future__ import annotations

import json
import random
from pathlib import Path
from typing import Any

_DATA_FILE = Path(__file__).resolve().parent.parent / "data" / "personality_types.json"

_cache: dict[str, dict] | None = None


def _load() -> dict[str, dict]:
    global _cache
    if _cache is None:
        _cache = json.loads(_DATA_FILE.read_text(encoding="utf-8"))
    return _cache


def list_types() -> list[str]:
    """Return all available personality type names."""
    return list(_load().keys())


def get_type(name: str) -> dict | None:
    """Return the type definition for a given name, or None."""
    return _load().get(name)


def all_types() -> dict[str, dict]:
    """Return the full type registry."""
    return dict(_load())


def roll_traits(type_name: str) -> dict[str, float] | None:
    """Generate random numeric traits within the type's base ranges.

    Returns a dict like {"cooperation": 0.82, "aggression": 0.28, "neuroticism": 0.41}
    or None if the type is unknown.
    """
    td = get_type(type_name)
    if not td:
        return None
    ranges = td.get("base_ranges", {})
    traits = {}
    for key in ("cooperation", "aggression", "neuroticism"):
        lo, hi = ranges.get(key, [0.3, 0.7])
        traits[key] = round(random.uniform(lo, hi), 2)
    return traits


def classify(personality: dict) -> str:
    """Given numeric traits, find the best-matching personality type.

    Uses simple distance to the midpoint of each type's base_ranges.
    """
    types = _load()
    best_type = "Pragmatist"  # default fallback
    best_dist = float("inf")

    coop = personality.get("cooperation", 0.5)
    aggr = personality.get("aggression", 0.2)
    neur = personality.get("neuroticism", 0.3)

    for name, td in types.items():
        ranges = td.get("base_ranges", {})
        mid_c = sum(ranges.get("cooperation", [0.5, 0.5])) / 2
        mid_a = sum(ranges.get("aggression", [0.2, 0.2])) / 2
        mid_n = sum(ranges.get("neuroticism", [0.3, 0.3])) / 2
        dist = (coop - mid_c) ** 2 + (aggr - mid_a) ** 2 + (neur - mid_n) ** 2
        if dist < best_dist:
            best_dist = dist
            best_type = name

    return best_type


def build_prompt_block(type_name: str, is_owner: bool = True) -> str:
    """Build the personality type prompt text for LLM injection.

    Returns empty string if type is unknown.
    """
    td = get_type(type_name)
    if not td:
        return ""

    lines = [
        f"NPC Type: {type_name}",
        f"Personality traits: {', '.join(td['traits'])}",
        f"Speech style: {td['speech_style']}",
    ]

    if not is_owner and td.get("ownership_modifier"):
        lines.append(td["ownership_modifier"])

    return "\n".join(lines)


def type_context(type_name: str) -> dict:
    """Build a template-friendly context dict for a personality type."""
    td = get_type(type_name)
    if not td:
        return {}
    return {
        "type": type_name,
        "traits": td["traits"],
        "speech_style": td["speech_style"],
        "decision_preference": td["decision_preference"],
        "ownership_modifier": td.get("ownership_modifier", ""),
    }


def reload():
    """Clear cache so types are re-read from disk."""
    global _cache
    _cache = None
