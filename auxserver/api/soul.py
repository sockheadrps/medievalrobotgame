from fastapi import APIRouter

from schemas.soul import NPCSaveRequest
from services.soul_service import load_npc, list_npcs, save_npc

router = APIRouter()


@router.post("/npc_save")
async def npc_save(request: NPCSaveRequest):
    return save_npc(request)


@router.get("/npc_load/{npc_id}")
async def npc_load(npc_id: str):
    data = load_npc(npc_id)
    if data is None:
        return {"found": False}
    return {"found": True, "data": data}


@router.get("/npc_list")
async def npc_list():
    return {"npcs": list_npcs()}
