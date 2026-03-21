"""Building system: fences, anvils, dummies, ki targets, conveyors, carts, tracks."""

import logging

logger = logging.getLogger(__name__)

from services.asset_registry import asset_registry
from services.game_state import (
    TILE_SIZE,
    ANVIL_STONE_COST,
    GATE_LOG_COST,
    FENCE_LOG_COST,
    FENCE_BASE_HP,
    KI_TARGET_HP,
    KI_TARGET_LOG_COST,
    MINECART_PORTALS,
    CAMPFIRE_RADIUS,
    CAMPFIRE_HP_REGEN,
    KI_MAX_BASE,
    tile_pos,
    dist,
    _gen_dummy_id,
    _gen_anvil_id,
    _gen_item_id,
    _gen_building_id,
)


class BuildingService:
    def __init__(self, game_state):
        self.gs = game_state

    # ── Dummy ──────────────────────────────────────────────────────────────────

    def _try_build_dummy(self, pid, logs_used):
        p = self.gs.players.get(pid)
        if not p:
            return
        logs_used = max(10, min(logs_used, p["logs"]))
        if p["logs"] < 10:
            return
        p["logs"] -= logs_used

        col = int(p["x"] / TILE_SIZE) + 2
        row = int(p["y"] / TILE_SIZE)
        dx, dy = tile_pos(col, row)
        did = _gen_dummy_id()
        self.gs.dummies[did] = {
            "id": did,
            "x": dx, "y": dy,
            "maxHp": logs_used * 5,
            "hp": logs_used * 5,
            "owner": pid,
            "dead": False,
            "last_hit_by": {},
        }

    # ── Ki Targets ─────────────────────────────────────────────────────────────

    def _try_build_ki_target(self, pid, x=None, y=None):
        """Build a ki target costing 10 logs. x/y can be explicit or defaults to near player."""
        p = self.gs.players.get(pid)
        if not p:
            return
        if p["logs"] < KI_TARGET_LOG_COST:
            return
        p["logs"] -= KI_TARGET_LOG_COST

        if x is None or y is None:
            col = int(p["x"] / TILE_SIZE) + 2
            row = int(p["y"] / TILE_SIZE)
            x, y = tile_pos(col, row)

        # Ki targets are now ephemeral ground items (not persisted separately)
        item_id = _gen_item_id()
        self.gs.ground_items.append({
            "id": item_id,
            "x": x, "y": y,
            "resource": "KiTarget",
            "amount": 1,
            "_placed": True,
            "_ki_target_hp": KI_TARGET_HP,
            "_ki_target_maxHp": KI_TARGET_HP,
            "_ki_target_owner": pid,
        })
        logger.debug("%s built ki target %s at (%.0f, %.0f)", pid, item_id, x, y)
        return item_id

    # ── Minecart Portal ────────────────────────────────────────────────────────

    def _handle_minecart_portal(self, pid, data):
        """Cart reached a minecart_exit tile — route it to the entrance on another map."""
        p = self.gs.players.get(pid)
        if not p:
            return
        player_map = p.get("map", "level_01")
        col = data.get("col")
        row = data.get("row")
        resource = data.get("resource", "planks")
        amount = int(data.get("amount", 1))
        if col is None or row is None:
            return

        for portal in MINECART_PORTALS:
            if (portal["from_map"] == player_map
                    and portal["tile_col"] == col
                    and portal["tile_row"] == row):
                self.gs.pending_carts.append({
                    "map": portal["to_map"],
                    "col": portal["entrance_col"],
                    "row": portal["entrance_row"],
                    "resource": resource,
                    "amount": amount,
                })
                return

    # ── Place Building ─────────────────────────────────────────────────────────

    def _place_building(self, pid, data):
        """Place a building (conveyor, crate, crafting_station, track, gate, fence) at a grid tile."""
        kind = data.get("kind")
        if kind not in ("conveyor", "crate", "crafting_station", "etrainer", "track", "gate", "fence"):
            logger.warning("_place_building rejected unknown kind=%s", kind)
            return
        col = data.get("col")
        row = data.get("row")
        if col is None or row is None:
            return
        p = self.gs.players.get(pid)
        if not p:
            return

        # Gate/fence cost logs
        if kind == "gate":
            if p.get("logs", 0) < GATE_LOG_COST:
                return
            p["logs"] -= GATE_LOG_COST
        elif kind == "fence":
            if p.get("logs", 0) < FENCE_LOG_COST:
                return
            p["logs"] -= FENCE_LOG_COST

        player_map = p.get("map", "level_01")

        # Crafting station: read asset_id from placement data
        asset_id = ""
        if kind == "crafting_station":
            asset_id = data.get("asset_id", "")
            if not asset_id:
                logger.warning("_place_building: crafting_station missing asset_id")
                return
            station_def = asset_registry.get_crafting_station(asset_id)
            if station_def:
                inv = p.setdefault("inventory", {})
                for item_id, qty in station_def.build_recipe.items():
                    if inv.get(item_id, 0) < qty:
                        self.gs.fx_events.append({"type": "chat_hint", "pid": pid,
                                                   "text": f"Need {qty}x {item_id} to build this."})
                        return
                for item_id, qty in station_def.build_recipe.items():
                    inv[item_id] = inv.get(item_id, 0) - qty
                    if inv[item_id] <= 0:
                        del inv[item_id]

        bid = _gen_building_id()
        bld = {
            "id": bid,
            "kind": kind,
            "col": int(col),
            "row": int(row),
            "map": player_map,
            "owner": pid,
            "direction": data.get("direction", ""),
            "label": "",
            "stored": {},
        }
        if asset_id:
            bld["asset_id"] = asset_id
        # Fences have HP
        if kind == "fence":
            bld["hp"] = FENCE_BASE_HP
            bld["maxHp"] = FENCE_BASE_HP
        # Etrainer: also create a dummy entry with infinite HP
        if kind == "etrainer":
            dx, dy = tile_pos(int(col), int(row))
            self.gs.dummies[bid] = {
                "id": bid,
                "x": dx, "y": dy,
                "maxHp": 999999,
                "hp": 999999,
                "owner": pid,
                "dead": False,
                "last_hit_by": {},
                "_etrainer": True,
                "map": player_map,
            }
        self.gs.buildings[bid] = bld
        logger.debug("%s placed %s at (%d,%d) -> %s", pid, kind, col, row, bid)

    # ── Barrier Tiles ──────────────────────────────────────────────────────────

    def _is_barrier_tile(self, x, y, pid):
        """Check if position (x,y) overlaps a fence or a gate not owned by pid."""
        col = int(x // TILE_SIZE)
        row = int(y // TILE_SIZE)
        player_map = self.gs.players.get(pid, {}).get("map", "level_01")
        for b in self.gs.buildings.values():
            if b["kind"] not in ("fence", "gate"):
                continue
            if b.get("map", "level_01") != player_map:
                continue
            if b["col"] != col or b["row"] != row:
                continue
            # Gates let owner through
            if b["kind"] == "gate" and b.get("owner") == pid:
                continue
            return True
        return False

    # ── Anvil ──────────────────────────────────────────────────────────────────

    def _try_build_anvil(self, pid):
        """Build an anvil costing 5 stones, placed 2 tiles to the right of the player."""
        p = self.gs.players.get(pid)
        if not p or p.get("dead"):
            return
        if p.get("stones", 0) < ANVIL_STONE_COST:
            return
        p["stones"] -= ANVIL_STONE_COST

        col = int(p["x"] / TILE_SIZE) + 2
        row = int(p["y"] / TILE_SIZE)
        x, y = tile_pos(col, row)

        aid = _gen_anvil_id()
        self.gs.anvils[aid] = {
            "id": aid,
            "x": x, "y": y,
            "owner": pid,
            "map": p.get("map", "level_01"),
            "dead": False,
        }
        logger.debug("%s built anvil %s at (%.0f, %.0f)", pid, aid, x, y)

    # ── Building Grid Helpers ──────────────────────────────────────────────────

    _DIR_DELTA = {
        "right": (1, 0), "left": (-1, 0),
        "up": (0, -1), "down": (0, 1),
    }

    def _building_at(self, col, row, map_name):
        """Find a building at a given grid position on a specific map."""
        for bid, b in self.gs.buildings.items():
            if b["col"] == col and b["row"] == row and b.get("map", "level_01") == map_name:
                return bid, b
        return None, None

    # ── Building Tick ──────────────────────────────────────────────────────────

    def _tick_buildings(self, dt, now):
        """Server-side processing for conveyors, crafting stations and minecart tracks."""
        CONVEYOR_INTERVAL = 1.0     # seconds per conveyor tick
        TRACK_INTERVAL = 0.8        # seconds per track tick
        MAX_PLANKS = 9

        # Track which conveyors/tracks received an item THIS tick so they
        # don't immediately forward it (prevents cascading through entire chain)
        _received_this_tick = set()

        for bid, b in list(self.gs.buildings.items()):
            kind = b["kind"]
            bmap = b.get("map", "level_01")
            stored = b.setdefault("stored", {})

            # ── Conveyor ──────────────────────────────────────────────
            if kind == "conveyor":
                # Skip if this conveyor just received an item this tick
                if bid in _received_this_tick:
                    continue
                accum = b.get("_conv_accum", 0.0) + dt
                if accum < CONVEYOR_INTERVAL:
                    b["_conv_accum"] = accum
                    continue
                b["_conv_accum"] = accum - CONVEYOR_INTERVAL

                in_dir = b.get("direction", "right")
                out_dir = b.get("out_direction") or in_dir

                # Always verify output direction has a valid neighbor.
                # If not, scan other directions (excluding input side) for a neighbor.
                fdc, fdr = self._DIR_DELTA.get(out_dir, (1, 0))
                _, fwd = self._building_at(b["col"] + fdc, b["row"] + fdr, bmap)
                if not fwd:
                    # Input side is BEHIND the conveyor (opposite of direction)
                    idc_in, idr_in = self._DIR_DELTA.get(in_dir, (1, 0))
                    back_col = b["col"] - idc_in
                    back_row = b["row"] - idr_in
                    found = False
                    for try_dir, (tdc, tdr) in self._DIR_DELTA.items():
                        if try_dir == out_dir:
                            continue  # already checked
                        nc, nr = b["col"] + tdc, b["row"] + tdr
                        # Skip the input side (behind the conveyor)
                        if nc == back_col and nr == back_row:
                            continue
                        _, try_nb = self._building_at(nc, nr, bmap)
                        if try_nb:
                            out_dir = try_dir
                            b["out_direction"] = try_dir  # cache
                            found = True
                            break
                    if not found and not b.get("_conv_no_out_logged"):
                        logger.debug("conv %s at (%d,%d) dir=%s: no output neighbor in any direction", bid, b['col'], b['row'], in_dir)
                        b["_conv_no_out_logged"] = True

                dc, dr = self._DIR_DELTA.get(out_dir, (1, 0))
                out_col = b["col"] + dc
                out_row = b["row"] + dr
                idc, idr = self._DIR_DELTA.get(in_dir, (1, 0))
                in_col = b["col"] - idc
                in_row = b["row"] - idr

                held = b.get("_held")

                if held:
                    nb_bid, nb = self._building_at(out_col, out_row, bmap)

                    if not nb and not b.get("_conv_no_out_logged"):
                        logger.debug("conv %s at (%d,%d) dir=%s out_dir=%s -> (%d,%d) NO NEIGHBOR, ejecting %s", bid, b['col'], b['row'], in_dir, out_dir, out_col, out_row, held['resource'])
                        b["_conv_no_out_logged"] = True

                    # Push to next empty conveyor
                    if nb and nb["kind"] == "conveyor" and not nb.get("_held"):
                        nb["_held"] = held
                        b["_held"] = None
                        if nb_bid:
                            _received_this_tick.add(nb_bid)
                        continue

                    # Push into storage building (crate, crafting_station)
                    if nb and nb["kind"] in ("crate", "crafting_station"):
                        nb_stored = nb.setdefault("stored", {})
                        resource = held["resource"]
                        amount = held["amount"]
                        accepted = False

                        if nb["kind"] == "crate":
                            crate_label = nb.get("label", "")
                            label_key = "Wood" if crate_label == "logs" else crate_label
                            if not crate_label or resource == label_key:
                                nb_stored[resource] = nb_stored.get(resource, 0) + amount
                                accepted = True
                        elif nb["kind"] == "crafting_station":
                            nb_asset_id = nb.get("asset_id", "")
                            nb_def = asset_registry.get_crafting_station(nb_asset_id)
                            if nb_def:
                                is_input = any(resource in r.inputs for r in nb_def.recipes)
                                is_fuel = (nb_def.fuel_type != "none" and resource == nb_def.fuel_type)
                                if is_input:
                                    max_needed = max(
                                        (r.inputs.get(resource, 0) for r in nb_def.recipes if resource in r.inputs),
                                        default=1,
                                    )
                                    cap = max_needed * 2
                                    cur = nb_stored.get(resource, 0)
                                    if cur < cap:
                                        nb_stored[resource] = min(cap, cur + amount)
                                        accepted = True
                                elif is_fuel:
                                    cur = nb_stored.get(resource, 0)
                                    if cur < 10:
                                        nb_stored[resource] = min(10, cur + amount)
                                        accepted = True

                        if accepted:
                            b["_held"] = None
                        continue

                    # No valid output and no neighbour — eject as ground item
                    if not nb:
                        px, py = tile_pos(out_col, out_row)
                        item_id = _gen_item_id()
                        self.gs.ground_items.append({
                            "id": item_id,
                            "x": px, "y": py,
                            "resource": held["resource"],
                            "amount": held["amount"],
                        })
                        b["_held"] = None
                        continue

                else:
                    # Pull from input-side storage (not from other conveyors)
                    _, nb = self._building_at(in_col, in_row, bmap)
                    if nb and nb["kind"] in ("crate", "crafting_station"):
                        nb_stored = nb.get("stored", {})
                        if nb["kind"] == "crafting_station":
                            nb_asset_id = nb.get("asset_id", "")
                            nb_def = asset_registry.get_crafting_station(nb_asset_id)
                            if nb_def:
                                output_keys = {k for r in nb_def.recipes for k in r.outputs}
                                pull_keys = [k for k in nb_stored if k in output_keys]
                            else:
                                pull_keys = []
                        else:
                            pull_keys = list(nb_stored.keys())

                        for res in pull_keys:
                            qty = nb_stored.get(res, 0)
                            if qty > 0:
                                nb_stored[res] = qty - 1
                                if nb_stored[res] <= 0:
                                    del nb_stored[res]
                                b["_held"] = {"resource": res, "amount": 1}
                                break
                continue

            # ── Generic Crafting Station ───────────────────────────────────────
            elif kind == "crafting_station":
                asset_id = b.get("asset_id", "")
                station_def = asset_registry.get_crafting_station(asset_id)
                if not station_def:
                    continue
                for recipe in station_def.recipes:
                    if not all(stored.get(r, 0) >= qty for r, qty in recipe.inputs.items()):
                        continue
                    if station_def.fuel_type != "none" and stored.get(station_def.fuel_type, 0) < recipe.fuel_cost:
                        continue
                    accum = b.get("_accum", 0.0) + dt
                    process_time = recipe.process_time / station_def.speed_bonus
                    if accum < process_time:
                        b["_accum"] = accum
                        break
                    b["_accum"] = 0.0
                    for r, qty in recipe.inputs.items():
                        stored[r] = stored.get(r, 0) - qty
                        if stored[r] <= 0:
                            del stored[r]
                    if station_def.fuel_type != "none":
                        stored[station_def.fuel_type] = stored.get(station_def.fuel_type, 0) - recipe.fuel_cost
                        if stored.get(station_def.fuel_type, 0) <= 0:
                            stored.pop(station_def.fuel_type, None)
                    for r, qty in recipe.outputs.items():
                        stored[r] = stored.get(r, 0) + qty
                    break

            # ── Minecart Track ────────────────────────────────────────
            elif kind == "track":
                # Skip if this track just received a cart this tick
                if bid in _received_this_tick:
                    continue

                # Spawn a cart from an adjacent crafting station or crate on the input side
                if not b.get("_cart"):
                    in_dir = b.get("direction", "right")
                    idc, idr = self._DIR_DELTA.get(in_dir, (1, 0))
                    in_col = b["col"] - idc
                    in_row = b["row"] - idr
                    _, src = self._building_at(in_col, in_row, bmap)
                    if src and src["kind"] in ("crate", "crafting_station"):
                        src_stored = src.get("stored", {})
                        if src["kind"] == "crafting_station":
                            src_asset_id = src.get("asset_id", "")
                            src_def = asset_registry.get_crafting_station(src_asset_id)
                            pull_keys = (
                                [k for k in src_stored if k in {ok for r in src_def.recipes for ok in r.outputs}]
                                if src_def else []
                            )
                        else:
                            pull_keys = list(src_stored.keys())
                        for res in pull_keys:
                            qty = src_stored.get(res, 0)
                            if qty > 0:
                                src_stored[res] = qty - 1
                                if src_stored[res] <= 0:
                                    del src_stored[res]
                                b["_cart"] = {"resource": res, "amount": 1}
                                break

                if not b.get("_cart"):
                    continue

                accum = b.get("_track_accum", 0.0) + dt
                if accum < TRACK_INTERVAL:
                    b["_track_accum"] = accum
                    continue
                b["_track_accum"] = accum - TRACK_INTERVAL

                cart = b["_cart"]
                out_dir = b.get("out_direction") or b.get("direction", "right")
                dc, dr = self._DIR_DELTA.get(out_dir, (1, 0))
                out_col = b["col"] + dc
                out_row = b["row"] + dr

                nb_bid, nb = self._building_at(out_col, out_row, bmap)

                # Transfer to next empty track
                if nb and nb["kind"] == "track" and not nb.get("_cart"):
                    nb["_cart"] = cart
                    b["_cart"] = None
                    if nb_bid:
                        _received_this_tick.add(nb_bid)
                    continue

                # Deposit into crate
                if nb and nb["kind"] == "crate":
                    crate_label = nb.get("label", "")
                    crate_stored = nb.setdefault("stored", {})
                    # Check label filter
                    label_key = "Wood" if crate_label == "logs" else crate_label
                    if not crate_label or cart["resource"] == label_key:
                        crate_stored[cart["resource"]] = crate_stored.get(cart["resource"], 0) + cart["amount"]
                        b["_cart"] = None
                        continue

                # Deposit into crafting station (e.g. log cutter)
                if nb and nb["kind"] == "crafting_station":
                    station_stored = nb.setdefault("stored", {})
                    station_stored[cart["resource"]] = station_stored.get(cart["resource"], 0) + cart["amount"]
                    b["_cart"] = None
                    continue

                # Check for minecart exit portal
                for portal in MINECART_PORTALS:
                    if (portal["from_map"] == bmap
                            and portal["tile_col"] == out_col
                            and portal["tile_row"] == out_row):
                        self.gs.pending_carts.append({
                            "map": portal["to_map"],
                            "col": portal["entrance_col"],
                            "row": portal["entrance_row"],
                            "resource": cart["resource"],
                            "amount": cart["amount"],
                        })
                        b["_cart"] = None
                        break

        # Spawn pending carts onto entrance tracks
        remaining = []
        for pc in self.gs.pending_carts:
            _, track = self._building_at(pc["col"], pc["row"], pc["map"])
            if track and track["kind"] == "track" and not track.get("_cart"):
                track["_cart"] = {"resource": pc["resource"], "amount": pc["amount"]}
            else:
                remaining.append(pc)  # keep for next tick if track is occupied
        self.gs.pending_carts = remaining

    # ── Campfire Tick ──────────────────────────────────────────────────────────

    def _tick_campfires(self, dt, now):
        """Expire campfires and apply HP/Ki regen aura to nearby players and NPCs."""
        KI_REGEN_BASE = 1.0 / 15.0
        KI_REGEN_LEVEL_SCALE = 1.08

        expired_campfires = []
        for cid, cf in self.gs.campfires.items():
            if cf.get("dead"):
                expired_campfires.append(cid)
                continue
            elapsed = now - cf["lit_at"]
            if elapsed >= cf["duration"]:
                cf["dead"] = True
                expired_campfires.append(cid)
                continue
            # Apply regen aura to nearby players and NPCs
            cx, cy = cf["x"], cf["y"]
            for p in self.gs.players.values():
                if p.get("dead") or p.get("knocked_out"):
                    continue
                d = dist(p["x"], p["y"], cx, cy)
                if d <= CAMPFIRE_RADIUS:
                    # Bonus HP regen
                    hp = p.get("hp", 0)
                    maxHp = p.get("maxHp", 20)
                    if hp < maxHp:
                        p["_campfire_hp_accum"] = p.get("_campfire_hp_accum", 0.0) + CAMPFIRE_HP_REGEN * dt
                        if p["_campfire_hp_accum"] >= 1.0:
                            heal = min(int(p["_campfire_hp_accum"]), maxHp - hp)
                            p["hp"] = hp + heal
                            p["_campfire_hp_accum"] -= heal
                    # Bonus ki regen (extra tick on top of normal regen)
                    ki = p.get("ki", 0)
                    maxKi = p.get("maxKi", KI_MAX_BASE)
                    if ki < maxKi:
                        level = max(1, p.get("level", 1))
                        bonus_rate = KI_REGEN_BASE * (KI_REGEN_LEVEL_SCALE ** (level - 1))
                        p["_ki_regen_accum"] = p.get("_ki_regen_accum", 0.0) + bonus_rate * dt
                # NPC aura
                for npc in p.get("npcs", {}).values():
                    if npc.get("dead") or npc.get("knocked_out"):
                        continue
                    nd = dist(npc.get("x", 0), npc.get("y", 0), cx, cy)
                    if nd <= CAMPFIRE_RADIUS:
                        nhp = npc.get("hp", 0)
                        nmaxHp = npc.get("maxHp", 20)
                        if nhp < nmaxHp:
                            npc["_campfire_hp_accum"] = npc.get("_campfire_hp_accum", 0.0) + CAMPFIRE_HP_REGEN * dt
                            if npc["_campfire_hp_accum"] >= 1.0:
                                heal = min(int(npc["_campfire_hp_accum"]), nmaxHp - nhp)
                                npc["hp"] = nhp + heal
                                npc["_campfire_hp_accum"] -= heal
                        nki = npc.get("ki", 0)
                        nmaxKi = npc.get("maxKi", KI_MAX_BASE)
                        if nki < nmaxKi:
                            nlevel = max(1, npc.get("level", 1))
                            bonus_rate = KI_REGEN_BASE * (KI_REGEN_LEVEL_SCALE ** (nlevel - 1))
                            npc["_ki_regen_accum"] = npc.get("_ki_regen_accum", 0.0) + bonus_rate * dt
        for cid in expired_campfires:
            del self.gs.campfires[cid]
