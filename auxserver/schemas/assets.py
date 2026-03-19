"""Pydantic models for data-driven asset definitions (world objects, equipment)."""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel


# ── World Objects ─────────────────────────────────────────────────────────────

class SpriteRef(BaseModel):
    type: str = "tilemap"          # "tilemap" (use tilesheet col/row) or "png" (custom image)
    tileCol: Optional[int] = None
    tileRow: Optional[int] = None
    png: Optional[str] = None      # filename inside the world_object folder


class Drop(BaseModel):
    resource: str
    min: int = 1
    max: int = 1


class WorldObjectDef(BaseModel):
    id: str
    label: str
    sprite: SpriteRef
    solid: bool = True
    interaction: str = "mine"       # "mine", "chop", "harvest", etc.
    required_level: int = 1
    hp: int = 5
    drops: list[Drop] = []
    respawn_min: float = 30.0       # seconds
    respawn_max: float = 60.0


# ── Equipment ─────────────────────────────────────────────────────────────────

class FrameSize(BaseModel):
    width: int = 32
    height: int = 32


class Recipe(BaseModel):
    station: str = "anvil"
    ingredients: dict[str, int] = {}
    required_level: int = 1


class EquipmentStats(BaseModel):
    str_bonus: int = 0
    def_bonus: int = 0
    hp_bonus: int = 0
    dmg_reduction_pct: float = 0.0


# ── Items ─────────────────────────────────────────────────────────────────────

class ItemDef(BaseModel):
    id: str                                  # key used in drops, inventory, etc. e.g. "copper"
    label: str                               # display name e.g. "Copper"
    category: str = "resource"               # "resource", "consumable", "quest", etc.
    sprite: SpriteRef = SpriteRef()          # tilemap tile or custom PNG
    stackable: bool = True
    maxStack: int = 99
    color: str = "#cccccc"                   # UI tint / label color
    description: str = ""


# ── Equipment ─────────────────────────────────────────────────────────────────

class EquipmentDef(BaseModel):
    id: str
    label: str
    spriteSheet: str                     # filename (e.g. "Armor_Elite.png")
    slot: str = "chest"                  # "chest", "head", "legs", etc.
    frameSize: FrameSize = FrameSize()
    totalFrames: int = 1
    namedFrames: dict[str, str] = {}     # armor_frame_index → animation_name
    sourceTemplate: str = "baseplayer"   # which base sprite this overlays
    recipe: Recipe = Recipe()
    stats: EquipmentStats = EquipmentStats()
