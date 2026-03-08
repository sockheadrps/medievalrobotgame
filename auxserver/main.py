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

from api.commands import router as commands_router
from api.maps import router as maps_router
from api.soul import router as soul_router
from core.config import STATIC_DIR, TEMPLATES_DIR

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
app.mount("/templates", StaticFiles(directory=str(TEMPLATES_DIR)), name="templates")

app.include_router(commands_router)
app.include_router(soul_router)
app.include_router(maps_router)


@app.get("/health")
def health():
    return {"status": "ok"}
