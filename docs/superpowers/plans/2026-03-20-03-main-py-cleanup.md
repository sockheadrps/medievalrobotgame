# main.py Cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce `main.py` to under 100 lines by moving the Ollama/LLM proxy routes into `auxserver/api/ollama.py`, the AI dashboard HTML into `auxserver/templates/ai_dashboard.html`, and module-level init calls into a proper `startup()` lifecycle hook.

**Architecture:** FastAPI router pattern already established in `auxserver/api/`. This plan follows that pattern exactly. `main.py` becomes: imports, app creation, router registration, startup/shutdown hooks — nothing else.

**Tech Stack:** FastAPI, Jinja2 (already configured via `core/config.py`). No new dependencies.

**Spec:** `docs/superpowers/specs/refactor/03-main-py.md`

---

## File Map

**Create:**
- `auxserver/api/ollama.py` — Ollama proxy + legacy LLM proxy routes
- `auxserver/templates/ai_dashboard.html` — AI player dashboard HTML

**Modify:**
- `auxserver/main.py` — remove inline HTML, remove inline routes, consolidate init into startup()

---

### Task 1: Audit current main.py

- [ ] Read `auxserver/main.py` in full and note:
  - Which routes are Ollama/LLM proxy routes (not yet in `api/`)
  - Where the inline AI dashboard HTML lives (search for `<!DOCTYPE` or `<html`)
  - Which init calls run at module level (lines before `app = FastAPI()`)

```bash
grep -n "def \|@app\|<!DOCTYPE\|<html\|init_db\|load_all\|init_world" auxserver/main.py
```

---

### Task 2: Extract AI dashboard HTML

**Files:**
- Create: `auxserver/templates/ai_dashboard.html`
- Modify: `auxserver/main.py`

- [ ] Find the inline HTML in `main.py`:
```bash
grep -n "<!DOCTYPE\|<html\|</html>" auxserver/main.py
```

- [ ] Cut the HTML string from `main.py` and save it to `auxserver/templates/ai_dashboard.html`.

- [ ] In `main.py`, replace the inline HTML response with a Jinja2 template render. `templates` is already configured in `core/config.py`:
```python
from core.config import templates

@app.get("/ai-dashboard")
async def ai_dashboard(request: Request):
    return templates.TemplateResponse("ai_dashboard.html", {"request": request})
```

- [ ] Start server: `uvicorn main:app --reload`
  Visit `http://127.0.0.1:8001/ai-dashboard` — page loads correctly.

- [ ] Commit:
```bash
git add auxserver/templates/ai_dashboard.html auxserver/main.py
git commit -m "refactor: move AI dashboard HTML to template file"
```

---

### Task 3: Extract Ollama/LLM proxy routes

**Files:**
- Create: `auxserver/api/ollama.py`
- Modify: `auxserver/main.py`

- [ ] Identify Ollama/LLM proxy routes in `main.py`:
```bash
grep -n "ollama\|/llm\|/api/chat\|/api/generate\|proxy" auxserver/main.py
```

- [ ] Create `auxserver/api/ollama.py`:
```python
"""Ollama and legacy LLM proxy routes."""
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
import httpx

router = APIRouter()

# Move Ollama proxy endpoints here from main.py.
# Preserve exact URL paths to avoid breaking the client.
```
Move identified route handlers into this router. Use `router = APIRouter()` and `@router.get/post(...)` instead of `@app.get/post(...)`.

- [ ] Register in `main.py`:
```python
from api.ollama import router as ollama_router
app.include_router(ollama_router)
```

- [ ] Start server and test each moved endpoint:
```bash
curl http://127.0.0.1:8001/api/generate -X POST -H "Content-Type: application/json" -d '{"model":"test","prompt":"hi"}'
```
  Expected: proxied to Ollama (or appropriate error if Ollama not running).

- [ ] Commit:
```bash
git add auxserver/api/ollama.py auxserver/main.py
git commit -m "refactor: extract Ollama/LLM proxy to api/ollama.py"
```

---

### Task 4: Consolidate startup/shutdown into lifecycle hooks

**Files:**
- Modify: `auxserver/main.py`

- [ ] Current state: `init_db()`, `migrate_json_files()`, `asset_registry.load_all()`, `init_world_objects()` run at module import time (top-level statements). There is one `@app.on_event("shutdown")` hook.

- [ ] Move the module-level calls into a startup hook. The existing `main.py` uses `@app.on_event("shutdown")` — match that pattern for consistency. (Note: `@app.on_event` is deprecated in FastAPI ≥0.93 in favour of the `lifespan` context manager. Since the existing shutdown hook already uses `@app.on_event`, match it here for now. Migrating both to `lifespan` is a follow-on task if desired.):
```python
@app.on_event("startup")
async def startup():
    init_db()
    migrate_json_files()
    asset_registry.load_all(ASSETS_DIR)
    init_world_objects()
    if DEV_MODE:
        ensure_dev_accounts()
```

- [ ] Remove the now-duplicate top-level calls from `main.py`.

- [ ] Verify the existing `@app.on_event("shutdown")` hook is complete (save game state, close DB). If shutdown logic is scattered, consolidate it here too.

- [ ] Start server and verify init works: `uvicorn main:app --reload`
  Check logs — DB init, asset registry scan, and world init should all run on startup.

- [ ] Commit:
```bash
git add auxserver/main.py
git commit -m "refactor: consolidate startup logic into @app.on_event(startup)"
```

---

### Task 5: Verify and final cleanup

- [ ] Check line count: `wc -l auxserver/main.py`
  Must be under 100.

- [ ] Read `main.py` — it should contain only:
  - Imports
  - `app = FastAPI()` + middleware
  - `app.include_router(...)` calls
  - `@app.on_event("startup")` function
  - `@app.on_event("shutdown")` function
  - Static file mounts (if any)

- [ ] If anything else is present, move it to the appropriate `api/` router.

- [ ] Run smoke tests: `cd auxserver && python -m pytest tests/test_smoke.py -v` — all PASS.

- [ ] Full end-to-end: start server, open game in browser, verify all features work.

- [ ] Commit if any remaining cleanup:
```bash
git add auxserver/main.py
git commit -m "refactor: main.py under 100 lines — only app wiring remains"
```
