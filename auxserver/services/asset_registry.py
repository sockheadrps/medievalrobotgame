"""
Asset Registry — singleton that scans assets/ at startup, caches all
world-object and equipment definitions, and builds frame-remap tables.
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Optional

from schemas.assets import WorldObjectDef, EquipmentDef, CraftingStationDef

logger = logging.getLogger(__name__)


class AssetRegistry:
    def __init__(self):
        self.world_objects: dict[str, WorldObjectDef] = {}
        self.equipment: dict[str, EquipmentDef] = {}
        # baseplayer frame → armor frame  (per equipment id)
        self.frame_remap: dict[str, dict[int, int]] = {}
        self._base_anims: dict[str, int] = {}   # flattened baseplayer name→frame
        self.crafting_stations: dict[str, CraftingStationDef] = {}
        self._loaded: bool = False

    # ── public API ────────────────────────────────────────────────────────

    def load_all(self, assets_dir: Path):
        """Scan assets/ tree and populate registries."""
        if self._loaded:
            return  # already scanned at startup
        self._load_base_animations(assets_dir)
        self._scan_world_objects(assets_dir / "world_objects")
        self._scan_equipment(assets_dir / "equipment")
        self._scan_crafting_stations(assets_dir / "crafting_stations")
        self._loaded = True
        logger.info(
            "Loaded %d world objects, %d equipment items, %d crafting stations",
            len(self.world_objects), len(self.equipment), len(self.crafting_stations)
        )

    def get_world_object(self, obj_id: str) -> Optional[WorldObjectDef]:
        return self.world_objects.get(obj_id)

    def get_equipment(self, eq_id: str) -> Optional[EquipmentDef]:
        return self.equipment.get(eq_id)

    def get_crafting_station(self, station_id: str) -> Optional[CraftingStationDef]:
        return self.crafting_stations.get(station_id)

    def get_manifest(self) -> dict:
        """Return JSON-serialisable manifest for the client."""
        wo_list = {}
        for wid, wo in self.world_objects.items():
            wo_list[wid] = wo.model_dump()

        eq_list = {}
        for eid, eq in self.equipment.items():
            eq_list[eid] = {
                **eq.model_dump(),
                "frameRemap": self.frame_remap.get(eid, {}),
            }

        return {"worldObjects": wo_list, "equipment": eq_list}

    # ── internals ─────────────────────────────────────────────────────────

    def _load_base_animations(self, assets_dir: Path):
        """Flatten baseplayer.json animations into {name: frame_index}."""
        bp_path = assets_dir / "baseplayer.json"
        if not bp_path.exists():
            logger.warning("baseplayer.json not found")
            return
        data = json.loads(bp_path.read_text(encoding="utf-8-sig"))
        self._base_anims = {}
        self._flatten_anims(data.get("animations", {}), "", self._base_anims)

    def _flatten_anims(self, obj, prefix: str, out: dict):
        """Recursively flatten animation tree into name→frame pairs.

        Handles these shapes from baseplayer.json:
          - int value:       "meditate": 16            → "meditate": 16
          - dict with dirs:  "face": {"down": 0, ...}  → "face_down": 0
          - list of dicts:   "punch_sequence_1": [{"left": 25}, ...]
                             → "punch_sequence_1_0_left": 25, ...
          - list of ints:    "training": [17, 18, ...]
                             → "training_0": 17, ...
        """
        if isinstance(obj, int):
            out[prefix] = obj
        elif isinstance(obj, dict):
            for key, val in obj.items():
                child_prefix = f"{prefix}_{key}" if prefix else key
                self._flatten_anims(val, child_prefix, out)
        elif isinstance(obj, list):
            for i, item in enumerate(obj):
                child_prefix = f"{prefix}_{i}" if prefix else str(i)
                self._flatten_anims(item, child_prefix, out)

    def _scan_world_objects(self, wo_dir: Path):
        if not wo_dir.exists():
            return
        for folder in wo_dir.iterdir():
            if not folder.is_dir():
                continue
            cfg_path = folder / "object.json"
            if not cfg_path.exists():
                continue
            try:
                data = json.loads(cfg_path.read_text(encoding="utf-8-sig"))
                wo = WorldObjectDef(**data)
                self.world_objects[wo.id] = wo
            except (json.JSONDecodeError, OSError) as e:
                logger.warning("Asset registry: skipping malformed file %s: %s", cfg_path, e)
            except Exception as e:
                logger.warning("Asset registry: error loading %s: %s", cfg_path, e)

    def _scan_equipment(self, eq_dir: Path):
        if not eq_dir.exists():
            return
        for folder in eq_dir.iterdir():
            if not folder.is_dir():
                continue
            cfg_path = folder / "item.json"
            if not cfg_path.exists():
                continue
            try:
                data = json.loads(cfg_path.read_text(encoding="utf-8-sig"))
                eq = EquipmentDef(**data)
                self.equipment[eq.id] = eq
                self._build_frame_remap(eq)
            except (json.JSONDecodeError, OSError) as e:
                logger.warning("Asset registry: skipping malformed file %s: %s", cfg_path, e)
            except Exception as e:
                logger.warning("Asset registry: error loading %s: %s", cfg_path, e)

    def _scan_crafting_stations(self, cs_dir: Path):
        if not cs_dir.exists():
            return
        for folder in cs_dir.iterdir():
            if not folder.is_dir():
                continue
            cfg_path = folder / "station.json"
            if not cfg_path.exists():
                continue
            try:
                data = json.loads(cfg_path.read_text(encoding="utf-8-sig"))
                st = CraftingStationDef(**data)
                self.crafting_stations[st.id] = st
            except (json.JSONDecodeError, OSError) as e:
                logger.warning("Asset registry: skipping malformed file %s: %s", cfg_path, e)
            except Exception as e:
                logger.warning("Asset registry: error loading %s: %s", cfg_path, e)

    def _build_frame_remap(self, eq: EquipmentDef):
        """Build baseplayer_frame → armor_frame mapping.

        1. Invert armor namedFrames: {armor_frame_str: anim_name} → {anim_name: armor_frame_int}
        2. For each baseplayer anim_name → base_frame, look up armor anim_name → armor_frame
        3. Result: {base_frame: armor_frame}  (ints)
        """
        # Invert: armor namedFrames maps "frame_index_str" → "anim_name"
        armor_name_to_frame: dict[str, int] = {}
        for frame_str, anim_name in eq.namedFrames.items():
            armor_name_to_frame[anim_name] = int(frame_str)

        remap: dict[int, int] = {}
        for anim_name, base_frame in self._base_anims.items():
            if anim_name in armor_name_to_frame:
                remap[base_frame] = armor_name_to_frame[anim_name]
            else:
                # Try stripping list index: "punch_sequence_2_0_right" → "punch_sequence_2_right"
                stripped = re.sub(r'_(\d+)_', '_', anim_name, count=1)
                if stripped != anim_name and stripped in armor_name_to_frame:
                    remap[base_frame] = armor_name_to_frame[stripped]

        self.frame_remap[eq.id] = remap
        logger.debug("Frame remap for '%s': %d/%d frames mapped", eq.id, len(remap), len(self._base_anims))


# Singleton
asset_registry = AssetRegistry()
