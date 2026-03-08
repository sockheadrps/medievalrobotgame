from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    text: str
    npc_id: str = "npc_0"
    world_context: dict = Field(default_factory=dict)
    npc_context: dict = Field(default_factory=dict)
