# ws.py — WebSocket endpoint for multiplayer game.
# Each client connects with a username, sends inputs, receives world state.

import asyncio
import json
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from services.game_state import game, WORLD_OBJECT_INSTANCES
from services.animal_service import animal_manager
from services.crop_service import crop_manager
from services.accounts import save_player, load_player
from services.ai_player import ai_player, PID as AI_PID
from core.config import SPAWN_AI_PLAYER
from services.database import save_npc as db_save_npc, load_npc as db_load_npc, delete_npc as db_delete_npc

router = APIRouter()


def _clean_npcs(npcs_dict):
    """Strip internal fields (callables, move targets) from NPC dicts for serialization."""
    return {nid: {k: v for k, v in npc.items() if not k.startswith("_")}
            for nid, npc in npcs_dict.items()}


# Connected clients: pid -> WebSocket
clients: dict[str, WebSocket] = {}

TICK_RATE = 20  # Hz
TICK_INTERVAL = 1.0 / TICK_RATE

# Auto-save interval (seconds)
SAVE_INTERVAL = 30.0
_last_save = time.time()

_loop_started = False


def _save_player_state(pid: str):
    """Save a player's current game state to their account file."""
    p = game.players.get(pid)
    if not p:
        return
    data = {
        "username": pid,
        "x": p["x"], "y": p["y"],
        "hp": p["hp"], "maxHp": p["maxHp"],
        "ki": p.get("ki", 20), "maxKi": p.get("maxKi", 20),
        "blastLevel": p.get("blastLevel", 0),
        "kiSkillLevel": p.get("kiSkillLevel", 1),
        "kiSkillXp": p.get("kiSkillXp", 0),
        "inf_ki": p.get("inf_ki", False),
        "str": p["str"], "def": p["def"],
        "level": p["level"], "xp": p["xp"],
        "logs": p["logs"],
        "stones": p.get("stones", 0),
        "crystals": p.get("crystals", 0),
        "copper": p.get("copper", 0),
        "meat": p.get("meat", 0),
        "feathers": p.get("feathers", 0),
        "vegetables": p.get("vegetables", 0),
        "seeds": p.get("seeds", 0),
        "ki_blast_bonuses": p.get("ki_blast_bonuses", {}),
        "ki_moves": p.get("ki_moves", []),
        "npc_ids": [nid for nid in p.get("npc_ids", [])
                    if not p.get("npcs", {}).get(nid, {}).get("dead")],
        "map": p.get("map", "level_01"),
        "combat_mode": p.get("combat_mode", "kill"),
        "equipment": p.get("equipment", {}),
        "inventory": p.get("inventory", {}),
    }
    save_player(pid, data)

    # Also persist NPC stats to the database
    for npc_id, npc in p.get("npcs", {}).items():
        if npc.get("dead"):
            # Remove dead NPCs from DB so they don't respawn on reload
            db_delete_npc(npc_id)
            continue
        stats = {k: v for k, v in npc.items() if not k.startswith("_") and k not in ("id", "name", "x", "y", "owner")}
        # Pass empty soul {} — save_npc will preserve existing soul data when soul is empty
        db_save_npc(npc_id, npc.get("name", npc_id), npc.get("x", 0), npc.get("y", 0), stats, {})


def _save_all_players():
    """Save all connected players (including AI rival)."""
    for pid in list(clients.keys()):
        _save_player_state(pid)
    # Also save the AI rival (not in clients dict)
    _save_player_state(AI_PID)


async def game_loop():
    """Server game loop — ticks world state and broadcasts to all clients."""
    global _last_save
    last = time.time()
    while True:
        now = time.time()
        dt = now - last
        last = now

        game.tick(dt)
        ai_player.tick()

        # Periodic auto-save
        if now - _last_save >= SAVE_INTERVAL:
            _save_all_players()
            _last_save = now

        # Build state update — only send client-relevant fields
        clean_players = {}
        for pid, p in game.players.items():
            clean_players[pid] = {
                "id": p["id"], "x": p["x"], "y": p["y"],
                "facing": p["facing"], "anim": p["anim"],
                "punching": p["punching"],
                "hp": p["hp"], "maxHp": p["maxHp"],
                "ki": p.get("ki", 20), "maxKi": p.get("maxKi", 20),
                "inf_ki": p.get("inf_ki", False),
                "blastLevel": p.get("blastLevel", 0),
                "kiSkillLevel": p.get("kiSkillLevel", 1),
                "kiSkillXp": p.get("kiSkillXp", 0),
                "str": p["str"], "def": p["def"],
                "level": p["level"], "xp": p["xp"],
                "logs": p["logs"],
                "stones": p.get("stones", 0),
                "crystals": p.get("crystals", 0),
                "copper": p.get("copper", 0),
                "meat": p.get("meat", 0),
                "feathers": p.get("feathers", 0),
                "vegetables": p.get("vegetables", 0),
                "seeds": p.get("seeds", 0),
                "ki_blast_bonuses": p.get("ki_blast_bonuses", {}),
                "ki_moves": p.get("ki_moves", []),
                "dead": p.get("dead", False),
                "knocked_out": p.get("knocked_out", False),
                "knocked_until": p.get("knocked_until"),
                "barrier_proc_until": p.get("barrier_proc_until", 0.0),
                "barrier_proc_facing": p.get("barrier_proc_facing", "down"),
                "npcs": _clean_npcs(p.get("npcs", {})),
                "chatColor": p.get("chatColor", "#cccccc"),
                "is_ai_rival": p.get("is_ai_rival", False),
                "map": p.get("map", "level_01"),
                "carried_by": p.get("carried_by"),
                "carrying": bool(p.get("_carrying")),
                "combat_mode": p.get("combat_mode", "kill"),
                "equipment": p.get("equipment", {}),
                "inventory": p.get("inventory", {}),
                "_refine_result": p.pop("_refine_result", None),
                "_crystal_result": p.pop("_crystal_result", None),
            }
        clean_dummies = {}
        for did, d in game.dummies.items():
            clean_dummies[did] = {
                "id": d["id"], "x": d["x"], "y": d["y"],
                "hp": d["hp"], "maxHp": d["maxHp"], "dead": d["dead"],
                "map": d.get("map", "level_01"),
                "etrainer": d.get("_etrainer", False),
            }
        clean_anvils = {}
        for aid, a in game.anvils.items():
            if not a.get("dead"):
                clean_anvils[aid] = {
                    "id": a["id"], "x": a["x"], "y": a["y"],
                    "owner": a.get("owner", ""),
                    "map": a.get("map", "level_01"),
                }
        clean_campfires = {}
        now = time.time()
        for cid, c in game.campfires.items():
            if not c.get("dead"):
                remaining = max(0, c["duration"] - (now - c["lit_at"]))
                clean_campfires[cid] = {
                    "id": c["id"], "x": c["x"], "y": c["y"],
                    "logs": c["logs"],
                    "remaining": round(remaining, 1),
                    "duration": c["duration"],
                    "map": c.get("map", "level_01"),
                }
        # Clean buildings dict
        clean_buildings = {}
        for bid, b in game.buildings.items():
            cb = {
                "id": b["id"], "kind": b["kind"],
                "col": b["col"], "row": b["row"],
                "map": b.get("map", "level_01"),
                "owner": b.get("owner", ""),
                "direction": b.get("direction", ""),
                "out_direction": b.get("out_direction", ""),
                "label": b.get("label", ""),
                "stored": b.get("stored", {}),
            }
            if b.get("hp") is not None:
                cb["hp"] = b["hp"]
                cb["maxHp"] = b.get("maxHp", b["hp"])
            if b.get("_cart"):
                cb["cart"] = b["_cart"]
            if b.get("_held"):
                cb["held"] = b["_held"]
            clean_buildings[bid] = cb

        # Build clean world objects dict (filter internal fields)
        clean_world_objects = {}
        for wo_id, wo in WORLD_OBJECT_INSTANCES.items():
            clean_world_objects[wo_id] = {
                "id": wo["id"],
                "asset_id": wo["asset_id"],
                "map": wo["map"],
                "x": wo["x"], "y": wo["y"],
                "hp": wo["hp"], "maxHp": wo["maxHp"],
                "depleted": wo["depleted"],
            }
        all_animals = animal_manager.get_all()
        all_crops = crop_manager.get_all()
        all_fx = list(game.fx_events)
        game.fx_events.clear()

        # Broadcast per-client — filter entities to the receiving player's map
        disconnected = []
        for pid, ws in clients.items():
            recipient_map = game.players.get(pid, {}).get("map", "level_01")
            on_overworld = recipient_map == "level_01"

            # Players: include self always; others only if on same map
            filtered_players = {}
            for other_pid, pdata in clean_players.items():
                if other_pid == pid or pdata.get("map", "level_01") == recipient_map:
                    # Filter each player's NPCs to same map too
                    filtered_npcs = {
                        nid: npc for nid, npc in pdata.get("npcs", {}).items()
                        if npc.get("map", "level_01") == recipient_map
                    }
                    filtered_players[other_pid] = {**pdata, "npcs": filtered_npcs}

            # World objects: filter by map (they can exist on any map)
            filtered_wo = {wid: wo for wid, wo in clean_world_objects.items()
                           if wo["map"] == recipient_map}

            # Buildings: filter by map
            filtered_buildings = {bid: b for bid, b in clean_buildings.items()
                                  if b["map"] == recipient_map}

            # Filter anvils, dummies, campfires by map
            filtered_anvils = {aid: a for aid, a in clean_anvils.items()
                               if a.get("map", "level_01") == recipient_map}
            filtered_dummies = {did: d for did, d in clean_dummies.items()
                                if d.get("map", "level_01") == recipient_map}
            filtered_campfires = {cid: c for cid, c in clean_campfires.items()
                                  if c.get("map", "level_01") == recipient_map}

            state = {
                "type": "state",
                "players": filtered_players,
                "xp_multipliers": dict(game.xp_multipliers),
                "trees": game.trees if on_overworld else [],
                "rocks": game.rocks if on_overworld else [],
                "ground_items": [gi for gi in game.ground_items
                                 if gi.get("map", "level_01") == recipient_map] if on_overworld else [],
                "dummies": filtered_dummies,
                "anvils": filtered_anvils,
                "campfires": filtered_campfires,
                "fx_events": all_fx if on_overworld else [],
                "animals": all_animals if on_overworld else [],
                "crops": all_crops if on_overworld else [],
                "world_objects": filtered_wo,
                "buildings": filtered_buildings,
            }
            try:
                await ws.send_text(json.dumps(state))
            except Exception:
                disconnected.append(pid)

        for pid in disconnected:
            _save_player_state(pid)
            clients.pop(pid, None)
            game.remove_player(pid)

        await asyncio.sleep(TICK_INTERVAL)


def ensure_loop():
    global _loop_started
    if not _loop_started:
        _loop_started = True
        asyncio.ensure_future(game_loop())
        # Spawn and start the AI rival player (controlled by SPAWN_AI_PLAYER in .env)
        if SPAWN_AI_PLAYER:
            ai_player.spawn()
            ai_player.start()


@router.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    ensure_loop()

    # Wait for login message with username
    try:
        raw = await asyncio.wait_for(ws.receive_text(), timeout=10.0)
        login_data = json.loads(raw)
        if login_data.get("type") != "login" or not login_data.get("username"):
            await ws.send_text(json.dumps({"type": "error", "message": "Must send login first"}))
            await ws.close()
            return
    except (asyncio.TimeoutError, json.JSONDecodeError):
        await ws.close()
        return

    pid = login_data["username"]

    # Reject if already connected
    if pid in clients:
        await ws.send_text(json.dumps({"type": "error", "message": "Already logged in"}))
        await ws.close()
        return

    # Load saved state or create fresh player
    saved = load_player(pid)
    player = game.add_player(pid)
    player["chatColor"] = login_data.get("chatColor", "#cccccc")

    if saved:
        # Restore saved stats
        for key in ("x", "y", "hp", "maxHp", "str", "def", "level", "xp", "logs"):
            if key in saved:
                player[key] = saved[key]
        player["ki"] = saved.get("ki", player.get("ki", 20))
        player["maxKi"] = saved.get("maxKi", player.get("maxKi", 20))
        player["blastLevel"] = saved.get("blastLevel", 0)
        player["kiSkillLevel"] = saved.get("kiSkillLevel", 1)
        player["kiSkillXp"] = saved.get("kiSkillXp", 0)
        player["inf_ki"] = saved.get("inf_ki", False)
        player["stones"] = saved.get("stones", 0)
        player["crystals"] = saved.get("crystals", 0)
        player["copper"] = saved.get("copper", 0)
        player["meat"] = saved.get("meat", 0)
        player["feathers"] = saved.get("feathers", 0)
        player["vegetables"] = saved.get("vegetables", 0)
        player["seeds"] = saved.get("seeds", 0)
        player["ki_blast_bonuses"] = saved.get("ki_blast_bonuses", player.get("ki_blast_bonuses", {}))
        player["ki_moves"] = saved.get("ki_moves", [])
        game._ensure_default_ki_moves(player)
        player["npc_ids"] = saved.get("npc_ids", [])
        player["map"] = saved.get("map", "level_01")
        player["combat_mode"] = saved.get("combat_mode", "kill")
        player["equipment"] = saved.get("equipment", {})
        player["inventory"] = saved.get("inventory", {})
        print(f"[ws] Restored player {pid} (level {player['level']}, {player['logs']} logs)")
    else:
        player["npc_ids"] = []
        print(f"[ws] New player {pid}")

    # Send welcome with saved NPC IDs
    snap = game.snapshot()
    welcome = {
        "type": "welcome",
        "your_id": pid,
        "players": {pid_k: {**pv, "npcs": _clean_npcs(pv.get("npcs", {}))}
                     for pid_k, pv in snap["players"].items()},
        "trees": snap["trees"],
        "ground_items": snap["ground_items"],
        "dummies": snap["dummies"],
        "anvils": snap.get("anvils", {}),
        "npc_ids": player.get("npc_ids", []),
        "animals": animal_manager.get_all(),
        "crops": crop_manager.get_all(),
    }
    await ws.send_text(json.dumps(welcome))
    clients[pid] = ws

    try:
        while True:
            raw = await ws.receive_text()
            try:
                data = json.loads(raw)
                msg_type = data.get("type")
                # Track NPC IDs for persistence
                if msg_type == "register_npc":
                    npc_id = data.get("npc_id")
                    if npc_id and npc_id not in player.get("npc_ids", []):
                        player.setdefault("npc_ids", []).append(npc_id)
                elif msg_type == "unregister_npc":
                    npc_id = data.get("npc_id")
                    if npc_id:
                        npc_list = player.get("npc_ids", [])
                        if npc_id in npc_list:
                            npc_list.remove(npc_id)
                # Chat relay — forward to target player's client
                elif msg_type == "chat_to_npc":
                    target_owner = data.get("target_owner")
                    target_ws = clients.get(target_owner)
                    if target_ws:
                        relay = {
                            "type": "chat_incoming",
                            "from": pid,
                            "from_color": player.get("chatColor", "#cccccc"),
                            "target_npc_id": data.get("target_npc_id"),
                            "text": data.get("text", ""),
                            "meta": data.get("meta"),
                        }
                        try:
                            await target_ws.send_text(json.dumps(relay))
                        except Exception:
                            pass
                elif msg_type == "chat_reply":
                    target_pid = data.get("to")
                    target_ws = clients.get(target_pid)
                    if target_ws:
                        relay = {
                            "type": "chat_reply_incoming",
                            "from_owner": pid,
                            "npc_id": data.get("npc_id"),
                            "npc_name": data.get("npc_name"),
                            "reply": data.get("reply", ""),
                            "emotion_deltas": data.get("emotion_deltas"),
                            "meta": data.get("meta"),
                        }
                        try:
                            await target_ws.send_text(json.dumps(relay))
                        except Exception:
                            pass
                else:
                    game.handle_input(pid, data)
            except json.JSONDecodeError:
                pass
    except WebSocketDisconnect:
        pass
    finally:
        # Save on disconnect
        _save_player_state(pid)
        clients.pop(pid, None)
        game.remove_player(pid)
        print(f"[ws] Player {pid} disconnected and saved")
