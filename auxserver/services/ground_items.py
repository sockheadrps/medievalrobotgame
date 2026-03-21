"""Ground items sub-service: drop/pickup helpers."""

import logging

logger = logging.getLogger(__name__)

from services.game_state import (
    TILE_SIZE,
    tile_pos,
    dist,
    _gen_item_id,
)
from services.asset_registry import asset_registry


class GroundItemsService:
    # ── Drop / Pickup Helpers ──────────────────────────────────────────────────

    def _tile_key(self, x, y):
        """Return (col, row) grid key for a world position."""
        return (int(x // TILE_SIZE), int(y // TILE_SIZE))

    def _find_ground_item(self, item_id):
        if not item_id:
            return None
        for item in self.gs.ground_items:
            if item.get("id") == item_id:
                return item
        return None

    def _is_log_item(self, item):
        return item and item.get("resource") in ("Wood", "log")

    def _is_stone_item(self, item):
        return item and item.get("resource") == "Stone"

    def _try_drop_item(self, pid, data):
        """Drop logs or stone."""
        p = self.gs.players.get(pid)
        if not p or p.get("dead"):
            return

        item_type = data.get("item", "log")
        amount = min(int(data.get("amount", 1)), 3)

        # Stone drops
        if item_type == "stone":
            if p.get("stones", 0) < 1:
                return
            p["stones"] -= 1
            col = int(p["x"] // TILE_SIZE)
            row = int(p["y"] // TILE_SIZE)
            tx, ty = tile_pos(col, row)
            item_id = _gen_item_id()
            self.gs.ground_items.append({
                "id": item_id,
                "x": tx, "y": ty,
                "resource": "Stone",
                "amount": 1,
                "_placed": True,
            })
            return

        # Log drops
        if "x" in data and "y" in data:
            drop_x, drop_y = float(data["x"]), float(data["y"])
        else:
            if p["logs"] < 1:
                return
            drop_x, drop_y = p["x"], p["y"]

        col = int(drop_x // TILE_SIZE)
        row = int(drop_y // TILE_SIZE)
        tx, ty = tile_pos(col, row)

        if "x" not in data:
            amount = 1
            p["logs"] -= 1

        # Check if there's already a log stack on this tile
        for item in self.gs.ground_items:
            if (item["resource"] in ("Wood", "log") and
                    self._tile_key(item["x"], item["y"]) == (col, row)):
                item["amount"] = min(item["amount"] + amount, 3)
                if "x" not in data:
                    item["_placed"] = True
                return

        # No existing stack — create new
        item_id = _gen_item_id()
        self.gs.ground_items.append({
            "id": item_id,
            "x": tx,
            "y": ty,
            "resource": "Wood",
            "amount": min(amount, 3),
            "_placed": True,
        })

    def _try_pickup_placed(self, pid, item_id):
        """Player picks up 1 resource from a placed stack by clicking it."""
        p = self.gs.players.get(pid)
        if not p or p.get("dead") or not item_id:
            return

        for item in self.gs.ground_items:
            if item["id"] == item_id and item.get("_placed"):
                if item.get("lit"):
                    return
                d = dist(p["x"], p["y"], item["x"], item["y"])
                if d > TILE_SIZE * 1.5:
                    return
                # Equipment items go to inventory
                if item.get("_equipment"):
                    eq_id = item["resource"]
                    inv = p.setdefault("inventory", {})
                    inv[eq_id] = inv.get(eq_id, 0) + 1
                    self.gs.ground_items.remove(item)
                    eq_def = asset_registry.get_equipment(eq_id)
                    label = eq_def.label if eq_def else eq_id
                    self.gs.fx_events.append({"type": "chat_hint", "pid": pid,
                                              "text": f"Picked up {label}."})
                    return
                if item["resource"] == "Stone":
                    p["stones"] = p.get("stones", 0) + 1
                else:
                    p["logs"] += 1
                item["amount"] -= 1
                if item["amount"] <= 0:
                    self.gs.ground_items.remove(item)
                return
