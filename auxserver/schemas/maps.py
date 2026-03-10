from typing import List

from pydantic import BaseModel


class TilePlacement(BaseModel):
    x: int
    y: int
    tileX: int | None = None
    tileY: int | None = None
    customSpriteId: str | None = None
    layer: int = 0


class CustomSprite(BaseModel):
    id: str
    pixels: List[int] | None = None
    pngDataUrl: str | None = None
    pngFile: str | None = None
    pngUrl: str | None = None


class MapData(BaseModel):
    name: str
    width: int | None = None
    height: int | None = None
    tiles: List[TilePlacement]
    customSprites: List[CustomSprite] = []
