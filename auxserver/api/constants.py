from pathlib import Path
import json

from fastapi import APIRouter

router = APIRouter()


@router.get("/api/constants")
async def get_constants():
    path = Path(__file__).resolve().parent.parent / "data" / "constants.json"
    return json.loads(path.read_text())
