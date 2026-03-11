"""
Minimal safe template renderer for LLM prompt generation.

Supports:
  - Variable interpolation:  {{path.to.value}}
  - Filters:                 {{val | round(2)}}, upper, lower, join(", "), default("x"), len, truncate(80)
  - Conditionals:            {{#if path == "val"}} ... {{#else}} ... {{/if}}
                             {{#if path > 0.5}} ... {{/if}}
                             {{#if path}} ... {{/if}}  (existence check)
  - Bounded loops:           {{#each list_path}} {{this}} {{/each}}

Non-goals: no eval, no code execution, no Turing-completeness, no arbitrary object access.
"""

from __future__ import annotations

import re
from typing import Any

# ── Limits ────────────────────────────────────────────────────────────────────

MAX_TEMPLATE_SIZE = 16_000       # chars
MAX_OUTPUT_SIZE = 32_000         # chars
MAX_SUBSTITUTIONS = 200
MAX_CONDITIONALS = 50
MAX_LOOPS = 20
MAX_EACH_ITEMS = 100             # cap per {{#each}} block
MAX_FILTER_CHAIN = 5

# ── Path validation ──────────────────────────────────────────────────────────

_PATH_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_.]*$")


class TemplateError(Exception):
    """Raised when a template is malformed or exceeds limits."""


# ── Filters ──────────────────────────────────────────────────────────────────

_FILTER_RE = re.compile(
    r"^(round|upper|lower|join|default|len|truncate)"
    r"(?:\(([^)]*)\))?$"
)


def _parse_filter_arg(raw: str | None) -> str | None:
    """Strip surrounding quotes from a filter argument."""
    if raw is None:
        return None
    raw = raw.strip()
    if (raw.startswith('"') and raw.endswith('"')) or (raw.startswith("'") and raw.endswith("'")):
        return raw[1:-1]
    return raw


def _apply_filter(value: Any, name: str, arg: str | None) -> Any:
    if name == "upper":
        return str(value).upper()
    if name == "lower":
        return str(value).lower()
    if name == "round":
        try:
            n = int(arg) if arg else 0
            result = round(float(value), n)
            return int(result) if n == 0 else result
        except (TypeError, ValueError):
            return value
    if name == "join":
        sep = arg if arg is not None else ", "
        if isinstance(value, list):
            return sep.join(str(v) for v in value)
        return str(value)
    if name == "default":
        if value is None or value == "" or value == []:
            return arg if arg is not None else ""
        return value
    if name == "len":
        if isinstance(value, (list, dict, str)):
            return len(value)
        return 0
    if name == "truncate":
        try:
            n = int(arg) if arg else 80
            s = str(value)
            return s[:n] + "..." if len(s) > n else s
        except (TypeError, ValueError):
            return value
    return value


# ── Core lookup ──────────────────────────────────────────────────────────────

def _resolve_path(context: Any, path: str) -> Any:
    """Walk a dot-path through a plain dict. Returns None if not found."""
    if not _PATH_RE.match(path):
        return None
    parts = path.split(".")
    current: Any = context
    for part in parts:
        if isinstance(current, dict) or isinstance(current, _PrefixGuard):
            current = current.get(part)
        else:
            return None
        if current is None:
            return None
    return current


# ── Parsing helpers ──────────────────────────────────────────────────────────

# Matches {{expr}} or {{expr | filter | filter}}
_VAR_RE = re.compile(r"\{\{(?!#|/)(.+?)\}\}")

_IF_OPEN_RE = re.compile(r"\{\{#if\s+(.+?)\}\}")
_IF_ELSE_TAG = "{{#else}}"
_IF_CLOSE_TAG = "{{/if}}"

# Matches {{#each path}} ... {{/each}}
_EACH_RE = re.compile(
    r"\{\{#each\s+([a-zA-Z_][a-zA-Z0-9_.]*)\}\}(.*?)\{\{/each\}\}",
    re.DOTALL,
)

# Condition operators
_COND_RE = re.compile(
    r'^([a-zA-Z_][a-zA-Z0-9_.]*)\s*(==|!=|>=?|<=?)\s*"([^"]*)"$'
)
_COND_NUM_RE = re.compile(
    r"^([a-zA-Z_][a-zA-Z0-9_.]*)\s*(==|!=|>=?|<=?)\s*(-?[0-9]+(?:\.[0-9]+)?)$"
)
_COND_EXIST_RE = re.compile(
    r"^([a-zA-Z_][a-zA-Z0-9_.]*)$"
)


def _eval_condition(context: dict, expr: str) -> bool:
    """Evaluate a simple conditional expression against context."""
    expr = expr.strip()

    # String comparison: path == "literal"
    m = _COND_RE.match(expr)
    if m:
        path, op, literal = m.group(1), m.group(2), m.group(3)
        val = _resolve_path(context, path)
        val_str = str(val) if val is not None else ""
        if op == "==":
            return val_str == literal
        if op == "!=":
            return val_str != literal
        # For >, <, >=, <= with string RHS — try numeric
        try:
            return _numeric_cmp(float(val), op, float(literal))
        except (TypeError, ValueError):
            return False

    # Numeric comparison: path > 0.5
    m = _COND_NUM_RE.match(expr)
    if m:
        path, op, num_str = m.group(1), m.group(2), m.group(3)
        val = _resolve_path(context, path)
        try:
            return _numeric_cmp(float(val), op, float(num_str))
        except (TypeError, ValueError):
            return False

    # Existence check: path (truthy)
    m = _COND_EXIST_RE.match(expr)
    if m:
        val = _resolve_path(context, m.group(1))
        if val is None or val == "" or val == [] or val == {} or val is False:
            return False
        return True

    return False


def _numeric_cmp(a: float, op: str, b: float) -> bool:
    if op == "==":
        return a == b
    if op == "!=":
        return a != b
    if op == ">":
        return a > b
    if op == "<":
        return a < b
    if op == ">=":
        return a >= b
    if op == "<=":
        return a <= b
    return False


# ── Main renderer ────────────────────────────────────────────────────────────

def render(template: str, context: dict, *, allowed_prefixes: list[str] | None = None) -> str:
    """
    Render a template string against a plain-dict context.

    Args:
        template:          The template string.
        context:           A plain dict (no objects, no methods).
        allowed_prefixes:  Optional list of allowed top-level keys / prefixes.
                           If provided, any path not starting with one of these
                           resolves to None.  Pass None to allow all paths.

    Returns:
        The rendered string.

    Raises:
        TemplateError on malformed templates or limit violations.
    """
    if len(template) > MAX_TEMPLATE_SIZE:
        raise TemplateError(f"Template exceeds max size ({len(template)} > {MAX_TEMPLATE_SIZE})")

    # Wrap context with prefix guard if needed
    ctx = context if allowed_prefixes is None else _PrefixGuard(context, allowed_prefixes)

    # Count structural elements for limits
    n_ifs = template.count("{{#if ")
    if n_ifs > MAX_CONDITIONALS:
        raise TemplateError(f"Too many conditionals ({n_ifs} > {MAX_CONDITIONALS})")

    n_each = len(_EACH_RE.findall(template))
    if n_each > MAX_LOOPS:
        raise TemplateError(f"Too many loops ({n_each} > {MAX_LOOPS})")

    result = template
    sub_count = 0

    # Phase 1: resolve {{#each}} blocks (inner-to-outer not needed — no nesting allowed)
    def _expand_each(m: re.Match) -> str:
        nonlocal sub_count
        path = m.group(1)
        body = m.group(2)
        items = _resolve_path(ctx, path)
        if not isinstance(items, list):
            return ""
        capped = items[:MAX_EACH_ITEMS]
        parts = []
        for item in capped:
            sub_count += 1
            if sub_count > MAX_SUBSTITUTIONS:
                raise TemplateError("Too many substitutions")
            if isinstance(item, dict):
                # Merge item fields into context under "this" and directly
                inner_ctx = {**context, "this": item, **item}
                parts.append(render(body, inner_ctx, allowed_prefixes=allowed_prefixes))
            else:
                inner_ctx = {**context, "this": item}
                parts.append(render(body, inner_ctx, allowed_prefixes=allowed_prefixes))
        return "".join(parts)

    result = _EACH_RE.sub(_expand_each, result)

    # Phase 2: resolve {{#if}} blocks using recursive descent
    def _resolve_ifs(text: str, depth: int = 0) -> str:
        nonlocal sub_count
        if depth > MAX_CONDITIONALS:
            raise TemplateError("Too many nested conditionals")

        out = []
        pos = 0
        while pos < len(text):
            m = _IF_OPEN_RE.search(text, pos)
            if not m:
                out.append(text[pos:])
                break
            # Append text before this {{#if}}
            out.append(text[pos:m.start()])
            expr = m.group(1)
            sub_count += 1
            if sub_count > MAX_SUBSTITUTIONS:
                raise TemplateError("Too many substitutions")

            # Find matching {{/if}}, respecting nesting
            search_start = m.end()
            nesting = 1
            true_block = ""
            false_block = ""
            else_pos = -1
            scan = search_start
            while scan < len(text) and nesting > 0:
                next_open = text.find("{{#if ", scan)
                next_close = text.find("{{/if}}", scan)
                next_else = text.find("{{#else}}", scan)

                if next_close == -1:
                    raise TemplateError("Unclosed {{#if}} block")

                # Find the earliest tag
                candidates = []
                if next_open != -1:
                    candidates.append(("open", next_open))
                candidates.append(("close", next_close))
                if next_else != -1:
                    candidates.append(("else", next_else))
                candidates.sort(key=lambda x: x[1])

                tag_type, tag_pos = candidates[0]

                if tag_type == "open":
                    nesting += 1
                    scan = tag_pos + 6  # skip past "{{#if "
                elif tag_type == "else" and nesting == 1:
                    else_pos = tag_pos
                    scan = tag_pos + len("{{#else}}")
                elif tag_type == "close":
                    nesting -= 1
                    if nesting == 0:
                        if else_pos != -1:
                            true_block = text[search_start:else_pos]
                            false_block = text[else_pos + len("{{#else}}"):tag_pos]
                        else:
                            true_block = text[search_start:tag_pos]
                        pos = tag_pos + len("{{/if}}")
                    else:
                        scan = tag_pos + len("{{/if}}")
                else:
                    scan = tag_pos + 1

            if nesting > 0:
                raise TemplateError("Unclosed {{#if}} block")

            # Recursively resolve the chosen branch
            if _eval_condition(ctx, expr):
                out.append(_resolve_ifs(true_block, depth + 1))
            else:
                out.append(_resolve_ifs(false_block, depth + 1))

        return "".join(out)

    result = _resolve_ifs(result)

    # Phase 3: resolve {{variable | filters}}
    def _expand_var(m: re.Match) -> str:
        nonlocal sub_count
        sub_count += 1
        if sub_count > MAX_SUBSTITUTIONS:
            raise TemplateError("Too many substitutions")

        raw = m.group(1).strip()
        parts = [p.strip() for p in raw.split("|")]
        path = parts[0]
        filters = parts[1:]

        if len(filters) > MAX_FILTER_CHAIN:
            raise TemplateError(f"Filter chain too long ({len(filters)} > {MAX_FILTER_CHAIN})")

        value = _resolve_path(ctx, path)

        for f in filters:
            fm = _FILTER_RE.match(f)
            if not fm:
                raise TemplateError(f"Unknown filter: {f!r}")
            fname = fm.group(1)
            farg = _parse_filter_arg(fm.group(2))
            value = _apply_filter(value, fname, farg)

        if value is None:
            return ""
        return str(value)

    result = _VAR_RE.sub(_expand_var, result)

    if len(result) > MAX_OUTPUT_SIZE:
        raise TemplateError(f"Output exceeds max size ({len(result)} > {MAX_OUTPUT_SIZE})")

    return result


# ── Prefix guard ─────────────────────────────────────────────────────────────

class _PrefixGuard:
    """Dict wrapper that blocks access to keys outside allowed prefixes."""

    def __init__(self, data: dict, prefixes: list[str]):
        self._data = data
        self._prefixes = prefixes

    def get(self, key: str, default=None):
        if not any(key == p or key.startswith(p + ".") or p.startswith(key) for p in self._prefixes):
            return default
        return self._data.get(key, default)

    def __contains__(self, key: str):
        return key in self._data

    def __getitem__(self, key: str):
        return self._data[key]
