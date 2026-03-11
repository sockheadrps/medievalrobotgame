from pydantic import BaseModel, Field


class SoulContext(BaseModel):
    name: str = "NPC"
    personality: dict = Field(default_factory=dict)
    emotional_state: dict = Field(default_factory=dict)
    relationship: str = "neutral"
    memories: list = Field(default_factory=list)


class DialogueRequest(BaseModel):
    npc_id: str = "npc_0"
    soul: SoulContext
    player_message: str
    world_context: dict = Field(default_factory=dict)
    speaking_player: str = ""
    owner: str = ""


class NPCSaveRequest(BaseModel):
    id: str
    name: str = "NPC"
    x: float = 0
    y: float = 0
    stats: dict = Field(default_factory=dict)
    soul: dict = Field(default_factory=dict)
