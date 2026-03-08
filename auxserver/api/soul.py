from fastapi import APIRouter

from schemas.soul import AggressionMemoryRequest, DialogueRequest, EncounterRequest, QuipRequest, ThoughtRequest
from services.soul_service import (
    generate_dialogue,
    generate_encounter,
    generate_quip,
    generate_thought,
    log_violent_memory,
)

router = APIRouter()


@router.post("/npc_dialogue")
async def npc_dialogue(request: DialogueRequest):
    return await generate_dialogue(request)


@router.post("/npc_thought")
async def npc_thought(request: ThoughtRequest):
    return await generate_thought(request)


@router.post("/npc_quip")
async def npc_quip(request: QuipRequest):
    return await generate_quip(request)


@router.post("/npc_encounter")
async def npc_encounter(request: EncounterRequest):
    return await generate_encounter(request)


@router.post("/npc_memory_log")
async def npc_memory_log(request: AggressionMemoryRequest):
    return await log_violent_memory(request)
