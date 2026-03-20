# Spec 03: main.py Cleanup

## Goal
Reduce `main.py` to its single responsibility: create the FastAPI app, register routers, and handle startup/shutdown. All route handlers and inline HTML move out.

## Current State Audit

`main.py` is 399 lines. It currently contains:
- FastAPI app creation and router registration (several routers already extracted to `auxserver/api/`)
- Inline Ollama proxy endpoints and legacy LLM proxy (not yet moved to a router)
- AI player dashboard HTML (inline in Python, not yet moved to a template file)
- Database init, asset registry scan, and state loading called at **module import time** (lines ~31–36), outside any lifecycle hook — there is no `startup()` function

**Already in place** (do not recreate):
- `auxserver/api/` exists with: `accounts.py`, `assets.py`, `commands.py`, `maps.py`, `soul.py`, `ws.py`
- `auxserver/core/` exists with: `config.py` (which configures Jinja2 templates)
- `auxserver/templates/` exists with: `asseteditor.html`, `mapmaker.html`, `playground.html`
- Jinja2 is already configured and in use

The remaining work is narrower than a full extraction: move the Ollama/LLM proxy routes into the existing `api/` structure, move the AI dashboard HTML into `templates/`, and consolidate the module-level init calls into a proper lifecycle hook.

## Gaps to Fill

- [ ] Move AI player dashboard HTML to `auxserver/templates/ai_dashboard.html` (template already dir exists)
- [ ] Create `auxserver/api/ollama.py` router — move Ollama proxy endpoints and legacy LLM proxy here (api/ dir already exists)
- [ ] Register `ollama.py` router in `main.py` via `app.include_router()`
- [ ] Move module-level init calls (`init_db()`, `migrate_json_files()`, `asset_registry.load_all()`, `init_world_objects()`) into a `@app.on_event("startup")` function
- [ ] Consolidate shutdown save logic into a `@app.on_event("shutdown")` function (one already exists — extend it)
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
