
# Design Doc: Safe Minimal Template Renderer for Prompt Generation

## Overview

This document describes a minimal custom Python template renderer intended for prompt generation in an LLM pipeline. The goal is to provide a small, predictable, and safe alternative to full templating engines such as Jinja.

The renderer supports only a tightly controlled feature set:

- Variable interpolation with dot-path lookup:
  - `{{path.to.value}}`
- A small whitelist of filters:
  - `round(n)`
  - `upper`
  - `lower`
  - `join("sep")`
  - `default("x")`
- Minimal conditional blocks:
  - `{{#if path == "value"}} ... {{/if}}`
  - `{{#if path != "value"}} ... {{/if}}`

The system is explicitly designed to be non-Turing-complete, non-executable, and resistant to injection attacks.

---

## Goals

- Safely render prompt templates from structured context data
- Keep behavior deterministic and easy to reason about
- Avoid arbitrary code execution entirely
- Prevent template-based injection into the rendering system
- Make templates simple enough for humans to author without introducing risk

---

## Non-Goals

- No arbitrary Python execution
- No loops
- No nested expressions beyond minimal conditionals
- No user-defined filters
- No indexing syntax like `foo[0]`
- No function calls in paths
- No math expressions beyond the `round(n)` filter
- No access to object attributes or methods outside plain dict traversal

---

## Supported Syntax

### 1. Variable Interpolation

Templates may reference values in a context dictionary using dot notation:

```text
{{npc.name}}
{{emotion.primary}}
{{relationship.default.trust}}
```

If a path is not found, the renderer returns an empty string unless a `default(...)` filter is used.

### 2. Filters

Filters are applied using pipe syntax:

```text
{{npc.name | upper}}
{{relationship.default.trust | round(2)}}
{{memories | join(", ")}}
{{emotion.primary | default("neutral")}}
```

Supported filters:

- `round(n)` — rounds numeric values
- `upper` — converts to uppercase
- `lower` — converts to lowercase
- `join("sep")` — joins list values with a separator
- `default("x")` — substitutes a fallback if value is missing or empty

### 3. Conditional Blocks

Minimal conditional sections are supported:

```text
{{#if type.event == "combat"}}
Stay alert.
{{/if}}

{{#if emotion.primary != "calm"}}
Respond cautiously.
{{/if}}
```

Supported operators:

- `==`
- `!=`

Right-hand values must be string literals.

---

## Example Use Case

Given this context:

```json
{
  "npc": {
    "name": "Robot-1"
  },
  "emotion": {
    "primary": "tense"
  },
  "relationship": {
    "default": {
      "trust": 0.6634
    }
  },
  "memories": ["player helped repair generator", "player revived npc"],
  "type": {
    "event": "combat"
  }
}
```

And this template:

```text
You are {{npc.name}}.
Current emotional state: {{emotion.primary | upper}}.
Trust level: {{relationship.default.trust | round(2)}}.
Memories: {{memories | join("; ")}}.

{{#if type.event == "combat"}}
You are in combat. Prioritize survival and teamwork.
{{/if}}
```

The rendered output would be:

```text
You are Robot-1.
Current emotional state: TENSE.
Trust level: 0.66.
Memories: player helped repair generator; player revived npc.

You are in combat. Prioritize survival and teamwork.
```

---

## Security Model

The renderer is designed under a strict security posture:

1. **No eval**
   - No dynamic execution of template content
   - No Python expressions
   - No runtime compilation

2. **Whitelist-only behavior**
   - Only approved path formats are allowed
   - Only approved filters are allowed
   - Only approved conditional forms are allowed

3. **Plain dictionary traversal only**
   - The renderer reads from dict snapshots
   - No attribute access on arbitrary Python objects
   - No method calls

4. **Minimal expression language**
   - Conditionals only support:
     - `path == "literal"`
     - `path != "literal"`
   - No variable-to-variable comparisons
   - No boolean chaining
   - No arithmetic

5. **Fail closed**
   - Invalid paths, filters, or expressions resolve to empty output or are rejected
   - Unknown features are never interpreted dynamically

---

## Hardening Requirements

To make template injection effectively impossible within the renderer itself, the implementation should enforce the following.

### 1. Path Validation

Only allow simple dot-path tokens matching a strict regex:

```text
^[a-zA-Z0-9_.]+$
```

Disallow:

- `(`
- `)`
- `[`
- `]`
- `{`
- `}`
- whitespace inside paths
- quotes inside paths

This prevents attempts like:

```text
{{__class__}}
{{npc.name()}}
{{memories[0]}}
{{foo.__dict__}}
```

### 2. Prefix Whitelisting

Only allow access to approved top-level namespaces such as:

- `npc.`
- `emotion.`
- `relationship.`
- `type.`
- `memories`

Any path outside these prefixes should return an empty string or fail validation.

Example allowed paths:

- `npc.name`
- `emotion.primary`
- `relationship.default.trust`
- `type.event`
- `memories`

Example denied paths:

- `config.secret_key`
- `os.environ`
- `user.__class__`

### 3. Filter Whitelisting

Only these filters should exist:

- `round(n)`
- `upper`
- `lower`
- `join("sep")`
- `default("x")`

Reject anything else, including malformed filter calls.

### 4. Strict Conditional Grammar

Conditionals should only parse:

- `path == "literal"`
- `path != "literal"`

Do not support:

- nested conditions
- `and` / `or`
- comparisons to other paths
- numeric comparisons
- regex matching
- function calls

### 5. Size Limits

Impose conservative limits such as:

- maximum template size
- maximum output size
- maximum number of substitutions
- maximum number of conditional blocks
- maximum filter chain length

This prevents abuse through huge templates or pathological rendering cases.

### 6. Immutable Context Snapshot

The context passed into rendering should be a plain, immutable snapshot of game state or pipeline state.

The renderer must not mutate input data.

### 7. Optional Output Escaping

If rendered output may be inserted into HTML, logs, or other sensitive sinks, escaping should happen at the output boundary. The renderer itself should remain text-focused, but integration points should account for downstream context.

---

## Proposed Architecture

### Components

#### 1. Template Loader
Responsible for reading template files from disk or another trusted source.

Responsibilities:
- load raw template text
- enforce template size limits
- optionally cache templates

#### 2. Context Builder
Constructs the safe context snapshot passed into rendering.

Responsibilities:
- extract only approved game or pipeline fields
- normalize types
- omit sensitive/internal values
- convert objects into plain dict/list primitives

#### 3. Renderer
Applies conditional substitution, path lookup, and filters.

Responsibilities:
- validate syntax
- apply secure lookup rules
- render deterministic string output

#### 4. Validator
Runs pre-render validation on paths, filters, and conditional expressions.

Responsibilities:
- reject disallowed syntax
- enforce whitelist rules
- count substitutions and blocks

---

## Rendering Flow

1. Load template text  
2. Validate template size and basic syntax  
3. Build a frozen/safe context snapshot  
4. Resolve conditional blocks  
5. Resolve interpolation tags  
6. Apply filter chains  
7. Enforce output length cap  
8. Return rendered prompt string

---

## Failure Behavior

The renderer should fail safely.

Recommended behavior:

- Invalid path: render empty string
- Unknown filter: reject template or render empty string for that tag
- Malformed conditional: reject template or treat block as false
- Too-large template/output: abort rendering
- Too many substitutions: abort rendering

For production use, surfacing structured errors during template loading is better than silently accepting malformed templates.

---

## Example Safe Validation Rules

### Allowed Path Regex

```python
PATH_RE = re.compile(r"^[a-zA-Z0-9_.]+$")
```

### Allowed Prefixes

```python
ALLOWED_PREFIXES = [
    "npc.",
    "emotion.",
    "relationship.",
    "type.",
    "memories"
]
```

### Path Acceptance Logic

A path is valid only if:

- it matches the path regex
- it equals an allowed root key or begins with an allowed prefix

---

## Integration with LLM Prompt Pipeline

This renderer is well suited to an LLM-backed NPC or prompt system where prompts are built from structured runtime state.

Example flow:

1. Game event occurs  
2. System builds current NPC context  
3. Prompt template is loaded  
4. Renderer fills template with safe values  
5. Rendered prompt is sent into the LLM  
6. LLM response is post-processed by separate systems

This keeps the prompt-building layer safe, deterministic, and independent from model execution.

---

## Benefits

- Very small attack surface
- Easy to audit
- Predictable authoring model
- Safer than embedding Python or a full templating engine
- Well suited to game state, NPC state, and event-driven prompt assembly

---

## Tradeoffs

- Much less flexible than Jinja or similar engines
- No loops means repeated content must be preformatted in context
- Limited conditional expressiveness
- Template authors must work within strict constraints

These tradeoffs are intentional and directly support the security goals.

---

## Recommendation

Use this renderer only as a minimal prompt formatting layer, not as a general-purpose templating system. Keep it:

- small
- whitelisted
- dict-only
- non-executable
- capped by strict limits

That design makes injection through the renderer effectively impossible, assuming context construction is also controlled and only safe data is exposed.

---

## Future Extensions

Only consider additions if they preserve the same safety model. Possible safe extensions could include:

- boolean existence checks like `{{#if npc.name}}`
- a `len` filter for lists
- a `truncate(n)` filter
- template linting tools

Avoid any extension that introduces:

- arbitrary expression parsing
- function execution
- iteration
- user-defined plugins
- object attribute access
- dynamic imports or evaluation

---

## Summary

This design provides a minimal, safe template renderer for LLM prompt generation. It supports only path substitution, a few whitelisted filters, and very small conditional blocks. By avoiding eval, limiting syntax, enforcing path/filter whitelists, and capping input/output sizes, the renderer can be made highly resistant to injection and suitable for production use in controlled prompt pipelines.
