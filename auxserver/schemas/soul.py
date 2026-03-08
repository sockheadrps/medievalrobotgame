from pydantic import BaseModel, Field


class SoulContext(BaseModel):
    name: str = "NPC"
    personality: dict = Field(default_factory=dict)
    emotional_state: dict = Field(default_factory=dict)
    relationship: str = "neutral"
    relationship_dynamics: dict = Field(default_factory=dict)
    recent_memories: list = Field(default_factory=list)


class DialogueRequest(BaseModel):
    npc_id: str = "npc_0"
    soul: SoulContext
    player_message: str
    world_context: dict = Field(default_factory=dict)


class ThoughtRequest(BaseModel):
    npc_id: str = "npc_0"
    soul: SoulContext
    event: str
    world_context: dict = Field(default_factory=dict)


class QuipRequest(BaseModel):
    npc_id: str = "npc_0"
    soul: SoulContext
    situation: str
    other_name: str = ""


class EncounterRequest(BaseModel):
    opener_id: str = "npc_0"
    responder_id: str = "npc_1"
    opener_soul: SoulContext
    responder_soul: SoulContext


class AggressionMemoryRequest(BaseModel):
    aggressor_id: str
    aggressor_name: str = "NPC"
    target_id: str
    target_name: str = "NPC"
    trigger: str = "unknown"
    worst_statements: list[str] = Field(default_factory=list)
