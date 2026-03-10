import os
import sys
from pathlib import Path

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

# Ensure local package-style imports (api/, core/, services/) resolve
# regardless of whether uvicorn is started from repo root or auxserver/.
THIS_DIR = Path(__file__).resolve().parent
if str(THIS_DIR) not in sys.path:
    sys.path.insert(0, str(THIS_DIR))

from api.maps import router as maps_router
from api.soul import router as soul_router
from api.ws import router as ws_router
from api.accounts import router as accounts_router
from core.config import STATIC_DIR, TEMPLATES_DIR, DEV_MODE, templates
from services.database import init_db, migrate_json_files, ensure_dev_accounts
from services.game_state import game

app = FastAPI()

# Initialize SQLite database and migrate any existing JSON files
init_db()
migrate_json_files()

if DEV_MODE:
    ensure_dev_accounts()


@app.on_event("shutdown")
def shutdown_save():
    """Save world state to DB on server shutdown."""
    print("[main] Saving world state before shutdown...")
    game.save_world()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
app.mount("/templates", StaticFiles(directory=str(TEMPLATES_DIR)), name="templates")

app.include_router(soul_router)
app.include_router(maps_router)
app.include_router(ws_router)
app.include_router(accounts_router)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/playground", response_class=HTMLResponse)
async def playground(request: Request):
    return templates.TemplateResponse("playground.html", {"request": request})


# ── Ollama proxy (production: clients hit /ollama/* which we forward to Ollama) ──
OLLAMA_BASE = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")

@app.api_route("/ollama/{path:path}", methods=["GET", "POST"])
async def ollama_proxy(path: str, request: Request):
    url = f"{OLLAMA_BASE}/{path}"
    body = await request.body()
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.request(
            method=request.method,
            url=url,
            content=body,
            headers={"Content-Type": "application/json"},
        )
    return StreamingResponse(
        iter([resp.content]),
        status_code=resp.status_code,
        headers={"Content-Type": resp.headers.get("Content-Type", "application/json")},
    )


# Serve built frontend (Docker puts it in /app/static/game)
GAME_DIR = THIS_DIR / "static" / "game"
if GAME_DIR.exists():
    app.mount("/", StaticFiles(directory=str(GAME_DIR), html=True), name="frontend")
