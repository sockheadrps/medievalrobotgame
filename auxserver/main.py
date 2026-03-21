import logging
import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

# Ensure local package-style imports (api/, core/, services/) resolve
# regardless of whether uvicorn is started from repo root or auxserver/.
THIS_DIR = Path(__file__).resolve().parent
if str(THIS_DIR) not in sys.path:
    sys.path.insert(0, str(THIS_DIR))

from api.constants import router as constants_router
from api.maps import router as maps_router
from api.soul import router as soul_router
from api.ws import router as ws_router
from api.accounts import router as accounts_router
from api.playground_tests import router as playground_tests_router
from api.assets import router as assets_router
from api.ollama import router as ollama_router
from api.misc import router as misc_router
from api.prompts import router as prompts_router
from core.config import STATIC_DIR, TEMPLATES_DIR, DEV_MODE, ASSETS_DIR
from services.database import init_db, migrate_json_files, ensure_dev_accounts
from services.asset_registry import asset_registry
from services.game_state import game, init_world_objects

class _SuppressNoisy(logging.Filter):
    _SUPPRESS = ("/api/prompts/", "/api/npc", "/api/aip", "/llm/", "/npc_save")

    def filter(self, record):
        msg = record.getMessage()
        return not any(p in msg for p in self._SUPPRESS)


logging.getLogger("uvicorn.access").addFilter(_SuppressNoisy())

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
app.mount("/templates", StaticFiles(directory=str(TEMPLATES_DIR)), name="templates")
app.mount("/assets", StaticFiles(directory=str(ASSETS_DIR)), name="assets")

app.include_router(constants_router)
app.include_router(soul_router)
app.include_router(maps_router)
app.include_router(ws_router)
app.include_router(accounts_router)
app.include_router(playground_tests_router)
app.include_router(assets_router)
app.include_router(ollama_router)
app.include_router(misc_router)
app.include_router(prompts_router)


@app.on_event("startup")
async def startup():
    init_db()
    migrate_json_files()
    asset_registry.load_all(ASSETS_DIR)
    init_world_objects()
    if DEV_MODE:
        ensure_dev_accounts()


@app.on_event("shutdown")
def shutdown_save():
    """Save world state to DB on server shutdown."""
    print("[main] Saving world state before shutdown...")
    game.save_world()


# Serve built frontend (Docker puts it in /app/static/game)
GAME_DIR = THIS_DIR / "static" / "game"
if GAME_DIR.exists():
    app.mount("/", StaticFiles(directory=str(GAME_DIR), html=True), name="frontend")
