# Spec 03: main.py Cleanup

## Goal
Reduce `main.py` to its single responsibility: create the FastAPI app, register routers, and handle startup/shutdown. All route handlers and inline HTML move out.

## Current State Audit

`main.py` is 399 lines. It currently contains:
- FastAPI app creation and router registration
- Startup/shutdown lifecycle hooks
- Ollama proxy endpoints
- Legacy LLM proxy endpoint
- AI player dashboard HTML (inline in Python)
- Database init, asset registry scan, and state loading (scattered across startup)

No `auxserver/api/` directory or `auxserver/templates/` directory exists yet.

## Gaps to Fill

- [ ] Create `auxserver/templates/` directory
- [ ] Move AI player dashboard HTML to `auxserver/templates/ai_dashboard.html`
- [ ] Create `auxserver/api/ollama.py` router — move Ollama proxy endpoints and legacy LLM proxy here
- [ ] Register the new router in `main.py` via `app.include_router()`
- [ ] Consolidate database init, asset registry scan, and state loading into a single `startup()` function
- [ ] Consolidate shutdown save logic into a single `shutdown()` function
- [ ] Remove all inline HTML from `main.py`
- [ ] `main.py` should only: create app, register routers, define startup/shutdown hooks

## Acceptance Criteria

- `main.py` is under 100 lines
- `auxserver/api/ollama.py` exists and handles all Ollama/LLM proxy routes
- `auxserver/templates/ai_dashboard.html` exists and is served correctly
- Startup and shutdown are single named functions with no scattered inline logic
- All existing API endpoints respond identically after the move

## Risks & Notes

- **Template serving**: FastAPI serves Jinja2 templates via `Jinja2Templates`. If this is not already set up, add it. Keep it simple — one template for the dashboard.
- **Router prefix**: the Ollama router should preserve existing URL paths to avoid breaking the client.
