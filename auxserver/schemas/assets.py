"""Pydantic models for data-driven asset definitions (world objects, equipment)."""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel


# ── World Objects ─────────────────────────────────────────────────────────────

class SpriteRef(BaseModel):
    type: str = "tilemap"          # "tilemap" | "spritesheet" | "png"
    tileCol: Optional[int] = None
    tileRow: Optional[int] = None
    png: Optional[str] = None      # filename inside the asset folder
    # Spritesheet-specific fields (type == "spritesheet")
    file: Optional[str] = None     # spritesheet filename
    frameW: int = 16               # cell width in pixels
    frameH: int = 16               # cell height in pixels
    spacing: int = 0               # gap between cells
    frame: int = 0                 # selected frame index


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
    # Mining tool stats (only relevant when slot == "tool")
    mining_power: int = 0              # damage per swing to wall tiles
    can_mine_hardwall: bool = False    # whether this tool can mine depth 30+ rock
    durability: int = 0                # 0 = infinite, otherwise number of uses


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
    slot: str = "chest"                  # "chest", "head", "legs", "weapon", "tool"
    frameSize: FrameSize = FrameSize()
    totalFrames: int = 1
    namedFrames: dict[str, str] = {}     # armor_frame_index → animation_name
    sourceTemplate: str = "baseplayer"   # which base sprite this overlays
    recipe: Recipe = Recipe()
    stats: EquipmentStats = EquipmentStats()


# ── Crafting Stations ────────────────────────────────────────────────────────

class StationRecipe(BaseModel):
    input_item: str = ""                 # item id consumed
    input_qty: int = 1
    output_item: str = ""                # item id produced
    output_min: int = 1
    output_max: int = 1
    process_time: float = 5.0           # seconds per operation


class CraftingStationDef(BaseModel):
    id: str
    label: str
    sprite: SpriteRef = SpriteRef()
    station_type: str = "smelter"       # "smelter", "crusher", "anvil", "workbench"
    speed_bonus: float = 1.0            # multiplier (1.0 = normal)
    required_metallurgy: int = 0        # metallurgy level to build/use
    fuel_type: str = "none"             # "none", "coal", "wood"
    recipes: list[StationRecipe] = []   # what this station can process
    build_recipe: dict[str, int] = {}   # ingredients to construct: item_id → qty
