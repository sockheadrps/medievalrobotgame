from __future__ import annotations
import logging

from core.config import PROMPTS_DIR

logger = logging.getLogger(__name__)
from services.template_renderer import render, TemplateError


# Cache raw template text (file reads)
_cache: dict[str, str] = {}


def load_prompt(category: str) -> str:
    """Load a raw prompt template (no rendering). Cached after first read."""
    if category in _cache:
        return _cache[category]
    path = PROMPTS_DIR / f"{category}.txt"
    if not path.exists():
        path = PROMPTS_DIR / "fallback.txt"
    text = path.read_text(encoding="utf-8")
    _cache[category] = text
    return text


def render_prompt(
    category: str,
    context: dict,
    *,
    allowed_prefixes: list[str] | None = None,
) -> str:
    """Load a prompt template and render it with the given context.

    If the template contains no {{...}} tags, it's returned as-is (backwards
    compatible with plain-text prompts).
    """
    template = load_prompt(category)
    if "{{" not in template:
        return template
    try:
        return render(template, context, allowed_prefixes=allowed_prefixes)
    except TemplateError as e:
        logger.warning("TemplateError[%s]: %s", category, e)
        # Fall back to raw template on render failure
        return template


def clear_cache():
    """Clear the template cache (useful for hot-reload in dev)."""
    _cache.clear()
