from fastapi import APIRouter

from schemas.commands import ChatRequest
from services.command_service import parse_command

router = APIRouter()


@router.post("/parse_command")
async def parse_command_endpoint(request: ChatRequest):
    category, commands = await parse_command(request)
    return {
        "npc_id": request.npc_id,
        "category": category,
        "commands": commands,
    }
