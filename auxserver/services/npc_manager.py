"""NPC management: spawning, sync, carry, equipment, background simulation."""

import random
import time

from services.asset_registry import asset_registry
from services.game_state import (
    TILE_SIZE,
    KI_MAX_BASE,
    KI_MAX_PER_LEVEL,
    DEFAULT_KI_MOVES,
    CRYSTAL_UPGRADE_STATS,
    WORLD_OBJECT_INSTANCES,
    tile_pos,
    dist,
    _gen_item_id,
)


class NPCManager:
    BG_NPC_MINE_INTERVAL = 3.0   # seconds between mine actions
    BG_NPC_MAX_INVENTORY = 10    # max items before depositing

    def __init__(self, game_state):
        self.gs = game_state

    # ── Build NPC ──────────────────────────────────────────────────────────────

    def _try_build_npc(self, pid, name=None):
        """Deduct 10 logs and create a basic NPC dict for the player."""
        p = self.gs.players.get(pid)
        if not p or p.get("dead"):
            return
        if p.get("logs", 0) < 10:
            return
        p["logs"] -= 10

        npc_id = f"{pid}_npc_{len(p.get('npc_ids', []))}"
        npc_name = name or npc_id

        col = int(p["x"] / TILE_SIZE) + 2
        row = int(p["y"] / TILE_SIZE)
        nx, ny = tile_pos(col, row)

        npc_state = {
            "id": npc_id,
            "name": npc_name,
            "x": nx, "y": ny,
            "hp": 20, "maxHp": 20,
            "ki": 20, "maxKi": 20,
            "str": 1, "def": 1,
            "level": 1, "xp": 0,
            "logs": 0, "maxLogs": 10,
            "stones": 0,
            "crystals": 0,
            "ki_blast_bonuses": {s: 0 for s in CRYSTAL_UPGRADE_STATS},
            "ki_moves": list(DEFAULT_KI_MOVES),
            "blastLevel": 0,
            "kiSkillLevel": 1,
            "kiSkillXp": 0,
            "barrier_proc_until": 0.0,
            "barrier_proc_facing": "down",
            "knocked_out": False,
            "dead": False,
            "owner": pid,
            "inf_ki": False,
            "map": p.get("map", "level_01"),
        }
        self.gs.player_manager._ensure_default_ki_moves(npc_state)
        p.setdefault("npcs", {})[npc_id] = npc_state
        p.setdefault("npc_ids", []).append(npc_id)
        print(f"[npc_manager] {pid} built NPC {npc_id} at ({nx:.0f}, {ny:.0f})")

    # ── NPC sync ───────────────────────────────────────────────────────────────

    def _sync_player_npcs(self, pid, npcs):
        """Sync NPC positions/stats from a client so other clients can see them."""
        p = self.gs.players.get(pid)
        if not p:
            return
        now = time.time()
        for npc_id, npc_data in npcs.items():
            existing = p.get("npcs", {}).get(npc_id)
            if existing and existing.get("hp", 0) != npc_data.get("hp", 0):
                # NPC HP is server-authoritative so combat damage sticks.
                npc_data["hp"] = existing["hp"]
            if existing and not existing.get("knocked_out") and existing.get("hp", 0) > 0 and npc_data.get("hp", 0) <= 0:
                npc_data["hp"] = existing["hp"]
            if existing:
                # Preserve server-authoritative fields
                for field in ("maxHp", "str", "def", "level", "xp", "maxLogs", "ki", "maxKi", "blastLevel",
                             "stones", "crystals", "ki_blast_bonuses", "ki_moves", "inf_ki",
                             "kiSkillLevel", "kiSkillXp", "barrier_proc_until", "barrier_proc_facing",
                             "inventory", "equipment"):
                    if field in existing:
                        npc_data[field] = existing[field]
                if existing.get("has_ki_blast"):
                    npc_data["has_ki_blast"] = True
                # Logs stolen by another NPC — only protect if steal happened recently
                steal_ts = existing.get("_logs_stolen_at", 0)
                if steal_ts and now - steal_ts < 2.0 and existing.get("logs", 0) < npc_data.get("logs", 0):
                    npc_data["logs"] = existing["logs"]
            # Restore has_ki_blast from client stats if server doesn't have it yet
            if not npc_data.get("has_ki_blast") and npc_data.get("hasKiBlast"):
                npc_data["has_ki_blast"] = True
            if existing and existing.get("dead"):
                npc_data["dead"] = True
            if existing and existing.get("knocked_out"):
                npc_data["knocked_out"] = True
                npc_data["knocked_until"] = existing.get("knocked_until")
                npc_data["hp"] = existing.get("hp", 0)
            self.gs.player_manager._ensure_default_ki_moves(npc_data)
            self.gs.player_manager._ensure_level_based_ki(npc_data)
            npc_data["owner"] = pid
            p.setdefault("npcs", {})[npc_id] = npc_data

    # ── Carry System ────────────────────────────────────────────────────────────

    def _try_carry_npc(self, pid, owner_id, npc_id):
        """Player picks up a knocked-out NPC."""
        p = self.gs.players.get(pid)
        if not p or p.get("dead") or p.get("knocked_out"):
            return
        if p.get("_carrying"):
            return  # already carrying something
        owner = self.gs.players.get(owner_id)
        if not owner:
            return
        npc = owner.get("npcs", {}).get(npc_id)
        if not npc or not npc.get("knocked_out"):
            return
        # Range check
        if dist(p["x"], p["y"], npc["x"], npc["y"]) > TILE_SIZE * 2:
            return
        p["_carrying"] = {"type": "npc", "owner_id": owner_id, "npc_id": npc_id}
        npc["carried_by"] = pid

    # ── NPC Equipment ────────────────────────────────────────────────────────────

    def _try_npc_pickup_equipment(self, pid, npc_id, item_id):
        """Have an owned NPC pick up a dropped equipment item and equip it."""
        p = self.gs.players.get(pid)
        if not p or not npc_id or not item_id:
            return
        npc = p.get("npcs", {}).get(npc_id)
        if not npc or npc.get("dead") or npc.get("knocked_out"):
            return
        # Find the ground item
        gi = None
        for item in self.gs.ground_items:
            if item["id"] == item_id and item.get("_equipment"):
                gi = item
                break
        if not gi:
            return
        # Range check
        if dist(npc["x"], npc["y"], gi["x"], gi["y"]) > TILE_SIZE * 2.5:
            self.gs.fx_events.append({"type": "chat_hint", "pid": pid,
                                   "text": "NPC is too far from the item."})
            return
        eq_id = gi["resource"]
        eq_def = asset_registry.get_equipment(eq_id)
        if not eq_def:
            return
        # Remove ground item
        self.gs.ground_items = [i for i in self.gs.ground_items if i["id"] != item_id]
        # Equip on NPC (swap old if needed)
        npc_eq = npc.setdefault("equipment", {})
        old_eq = npc_eq.get(eq_def.slot)
        if old_eq:
            # Drop old equipment on ground
            col = int(npc["x"] // TILE_SIZE)
            row = int(npc["y"] // TILE_SIZE)
            tx, ty = tile_pos(col, row)
            self.gs.ground_items.append({
                "id": _gen_item_id(),
                "x": tx, "y": ty,
                "resource": old_eq,
                "amount": 1,
                "_placed": True,
                "_equipment": True,
                "map": p.get("map", "level_01"),
            })
        npc_eq[eq_def.slot] = eq_id
        label = eq_def.label if eq_def else eq_id
        self.gs.fx_events.append({"type": "chat_hint", "pid": pid,
                               "text": f"NPC equipped {label}."})

    def _try_give_npc_equipment(self, pid, npc_id, eq_id):
        """Player gives equipment from their inventory to an owned NPC."""
        p = self.gs.players.get(pid)
        if not p or not npc_id or not eq_id or p.get("dead"):
            return
        npc = p.get("npcs", {}).get(npc_id)
        if not npc or npc.get("dead") or npc.get("knocked_out"):
            return
        inv = p.get("inventory", {})
        if inv.get(eq_id, 0) < 1:
            self.gs.fx_events.append({"type": "chat_hint", "pid": pid,
                                   "text": "You don't have that item."})
            return
        eq_def = asset_registry.get_equipment(eq_id)
        if not eq_def:
            return
        # Remove from player inventory
        inv[eq_id] = inv.get(eq_id, 0) - 1
        if inv[eq_id] <= 0:
            del inv[eq_id]
        # Equip on NPC (swap old to player inventory)
        npc_eq = npc.setdefault("equipment", {})
        old_eq = npc_eq.get(eq_def.slot)
        if old_eq:
            inv[old_eq] = inv.get(old_eq, 0) + 1
        npc_eq[eq_def.slot] = eq_id
        label = eq_def.label if eq_def else eq_id
        self.gs.fx_events.append({"type": "chat_hint", "pid": pid,
                               "text": f"Gave {label} to NPC."})

    def _try_take_npc_equipment(self, pid, npc_id, slot):
        """Player takes equipment back from an owned NPC."""
        p = self.gs.players.get(pid)
        if not p or not npc_id or not slot or p.get("dead"):
            return
        npc = p.get("npcs", {}).get(npc_id)
        if not npc:
            return
        npc_eq = npc.get("equipment", {})
        eq_id = npc_eq.get(slot)
        if not eq_id:
            return
        del npc_eq[slot]
        inv = p.setdefault("inventory", {})
        inv[eq_id] = inv.get(eq_id, 0) + 1
        eq_def = asset_registry.get_equipment(eq_id)
        label = eq_def.label if eq_def else eq_id
        self.gs.fx_events.append({"type": "chat_hint", "pid": pid,
                               "text": f"Took {label} from NPC."})

    # ── Background NPC worker simulation ──────────────────────────────────────

    def _tick_background_npcs(self, now):
        """Simulate NPC tasks while the player is on a different map."""
        for npc_id, bg in list(self.gs.background_npcs.items()):
            elapsed = now - bg["last_tick"]
            if elapsed < self.BG_NPC_MINE_INTERVAL:
                continue
            bg["last_tick"] = now

            pid = bg["pid"]
            p = self.gs.players.get(pid)
            if not p:
                continue
            npc_state = p.get("npcs", {}).get(npc_id)
            if not npc_state or npc_state.get("dead") or npc_state.get("knocked_out"):
                continue

            task = bg["task"]
            task_type = task.get("task", "")
            npc_map = bg["map"]
            npc_inv = npc_state.setdefault("inventory", {})
            total_inv = sum(npc_inv.values())

            if task_type in ("custom_task", "mine_ore"):
                # Phase: deposit if full
                if total_inv >= self.BG_NPC_MAX_INVENTORY:
                    self._bg_npc_deposit(npc_state, npc_inv, task, npc_map)
                    continue

                # Phase: mine — find a non-depleted world object on this map
                ore_asset_ids = task.get("ore_asset_ids", [])
                mined = False
                for wo_id, wo in WORLD_OBJECT_INSTANCES.items():
                    if wo["depleted"]:
                        continue
                    if wo["map"] != npc_map:
                        continue
                    if ore_asset_ids and wo["asset_id"] not in ore_asset_ids:
                        continue
                    # Mine it
                    wo_def = asset_registry.get_world_object(wo["asset_id"])
                    if not wo_def:
                        continue
                    wo["hp"] -= 1
                    for drop in wo_def.drops:
                        amount = random.randint(drop.min, drop.max)
                        npc_inv[drop.resource] = npc_inv.get(drop.resource, 0) + amount
                    if wo["hp"] <= 0:
                        wo["depleted"] = True
                        respawn_secs = random.uniform(wo_def.respawn_min, wo_def.respawn_max)
                        wo["respawn_at"] = now + respawn_secs
                    mined = True
                    break
                # If nothing to mine, just wait (ores will respawn)

    def _bg_npc_deposit(self, npc_state, npc_inv, task, npc_map):
        """Background NPC deposits inventory into matching crates."""
        crate_bids = task.get("crate_building_ids", [])
        crate_labels = task.get("crate_labels", [])

        for resource, qty in list(npc_inv.items()):
            if qty <= 0:
                continue
            deposited = False

            # Try specified crates first
            for i, bid in enumerate(crate_bids):
                b = self.gs.buildings.get(bid)
                if not b or b.get("map", "level_01") != npc_map:
                    continue
                lbl = (crate_labels[i] if i < len(crate_labels) else "") or b.get("label", "")
                label_key = "Wood" if lbl == "logs" else lbl
                if lbl and resource.lower() != label_key.lower():
                    continue
                stored = b.setdefault("stored", {})
                stored[resource] = stored.get(resource, 0) + qty
                npc_inv[resource] = 0
                deposited = True
                break

            # Fallback: find any crate on this map with matching label
            if not deposited:
                for bid, b in self.gs.buildings.items():
                    if b["kind"] != "crate" or b.get("map", "level_01") != npc_map:
                        continue
                    lbl = b.get("label", "")
                    label_key = "Wood" if lbl == "logs" else lbl
                    if lbl and resource.lower() != label_key.lower():
                        continue
                    stored = b.setdefault("stored", {})
                    stored[resource] = stored.get(resource, 0) + qty
                    npc_inv[resource] = 0
                    break

        # Clean empty entries
        for k in list(npc_inv.keys()):
            if npc_inv[k] <= 0:
                del npc_inv[k]
