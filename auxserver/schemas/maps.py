from typing import List

from pydantic import BaseModel


class TilePlacement(BaseModel):
    x: int
    y: int
    tileX: int
    tileY: int


class MapData(BaseModel):
    name: str
    width: int | None = None
    height: int | None = None
    tiles: List[TilePlacement]
