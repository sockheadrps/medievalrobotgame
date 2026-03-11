from pydantic import BaseModel, Field


class SoulContext(BaseModel):
    name: str = "NPC"
    personality: dict = Field(default_factory=dict)
    emotional_state: dict = Field(default_factory=dict)
    relationship: str = "neutral"
    memories: list = Field(default_factory=list)
    learned_phrases: list = Field(default_factory=list)
    system_note: str = ""
    topic_entity: dict = Field(default_factory=dict)


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


class DialoguePromptRequest(BaseModel):
    """Request to render a dialogue system prompt from soul context."""
    name: str = "NPC"
    personality: dict = Field(default_factory=dict)
    emotional_state: dict = Field(default_factory=dict)
    relationship: str = "neutral"
    memories: list = Field(default_factory=list)
    learned_phrases: list = Field(default_factory=list)
    nearby_entities: list = Field(default_factory=list)
    system_note: str = ""
    topic_entity: dict = Field(default_factory=dict)
    speaking_player: str = ""
    owner: str = ""


class DecisionPromptRequest(BaseModel):
    """Request to render a decision system prompt from state packet."""
    state: dict = Field(default_factory=dict)


class NPCChatPromptRequest(BaseModel):
    """Request to render NPC chat prompts for NPC-to-NPC conversation."""
    name: str = "Robot"
    personality: dict = Field(default_factory=dict)
    trust: float = 0.5
    anger: float = 0.0
    logs: int = 0
    target_name: str = "Robot"
    target_logs: int = 0
    recent_memory: str = ""
    learned_phrases: list = Field(default_factory=list)
