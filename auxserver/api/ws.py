# ws.py — WebSocket endpoint for multiplayer game.
# Each client connects with a username, sends inputs, receives world state.

import asyncio
import json
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from services.game_state import game
from services.accounts import save_player, load_player

router = APIRouter()

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
        "inf_ki": p.get("inf_ki", False),
        "kiSkillLevel": p.get("kiSkillLevel", 1),
        "kiSkillXp": p.get("kiSkillXp", 0),
        "realm_tier": p.get("realm_tier", 0),
        "realm_insight": p.get("realm_insight", 0),
        "realm_crystal_t1": p.get("realm_crystal_t1", 0),
        "ki_upgrades": p.get("ki_upgrades", {}),
        "str": p["str"], "def": p["def"],
        "level": p["level"], "xp": p["xp"],
        "logs": p["logs"],
        "stones": p.get("stones", 0),
        "bastalite": p.get("bastalite", 0),
        "crystal_pristine": p.get("crystal_pristine", 0),
        "crystal_normal": p.get("crystal_normal", 0),
        "crystal_poor": p.get("crystal_poor", 0),
        "armor_elite": p.get("armor_elite", False),
        "armor_elite_inv": p.get("armor_elite_inv", False),
        "ki_moves": p.get("ki_moves", []),
        "ki_denominations": p.get("ki_denominations", []),
        "ki_known_augments": p.get("ki_known_augments", {}),
        "ki_equipped_augments": p.get("ki_equipped_augments", {}),
        "ki_upgrades": p.get("ki_upgrades", {}),
        "aura_tint": p.get("aura_tint", 0x4fd6ff),
        "aura_alpha": p.get("aura_alpha", 0.42),
        "npc_ids": p.get("npc_ids", []),
    }
    save_player(pid, data)


def _save_all_players():
    """Save all connected players."""
    for pid in list(clients.keys()):
        _save_player_state(pid)


async def game_loop():
    """Server game loop — ticks world state and broadcasts to all clients."""
    global _last_save
    last = time.time()
    while True:
        now = time.time()
        dt = now - last
        last = now

        game.tick(dt)

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
                "realm_tier": p.get("realm_tier", 0),
                "realm_insight": p.get("realm_insight", 0),
                "realm_crystal_t1": p.get("realm_crystal_t1", 0),
                "ki_upgrades": p.get("ki_upgrades", {}),
                "ki_moves": p.get("ki_moves", []),
                "str": p["str"], "def": p["def"],
                "level": p["level"], "xp": p["xp"],
                "logs": p["logs"],
                "stones": p.get("stones", 0),
                "bastalite": p.get("bastalite", 0),
                "crystal_pristine": p.get("crystal_pristine", 0),
                "crystal_normal": p.get("crystal_normal", 0),
                "crystal_poor": p.get("crystal_poor", 0),
                "dead": p.get("dead", False),
                "knocked_out": p.get("knocked_out", False),
                "knocked_until": p.get("knocked_until"),
                "meditating": p.get("meditating", False),
                "meditation_started_at": p.get("meditation_started_at"),
                "meditation_until": p.get("meditation_until"),
                "meditation_total_ms": p.get("meditation_total_ms", 0),
                "meditation_crystal_quality": p.get("meditation_crystal_quality"),
                "charging": p.get("charging", False),
                "charge_power": p.get("charge_power", 0.0),
                "clairvoyance_active": p.get("clairvoyance_active", False),
                "clairvoyance_target_type": p.get("clairvoyance_target_type"),
                "clairvoyance_target_id": p.get("clairvoyance_target_id"),
                "clairvoyance_target_owner": p.get("clairvoyance_target_owner"),
                "barrier_proc_until": p.get("barrier_proc_until", 0.0),
                "barrier_proc_facing": p.get("barrier_proc_facing", "down"),
                "carrying": p.get("carrying"),
                "carried_by": p.get("carried_by"),
                "armor_elite": p.get("armor_elite", False),
                "armor_elite_inv": p.get("armor_elite_inv", False),
                "aura_tint": p.get("aura_tint", 0x4fd6ff),
                "aura_alpha": p.get("aura_alpha", 0.42),
                "ki_denominations": p.get("ki_denominations", []),
                "ki_known_augments": p.get("ki_known_augments", {}),
                "ki_equipped_augments": p.get("ki_equipped_augments", {}),
                "npcs": p.get("npcs", {}),
                "chatColor": p.get("chatColor", "#cccccc"),
                "_ki_target_result": p.pop("_ki_target_result", None),
                "_refine_result": p.pop("_refine_result", None),
                "_meditation_result": p.pop("_meditation_result", None),
                "_shrine_result": p.pop("_shrine_result", None),
            }
        clean_dummies = {}
        for did, d in game.dummies.items():
            clean_dummies[did] = {
                "id": d["id"], "x": d["x"], "y": d["y"],
                "hp": d["hp"], "maxHp": d["maxHp"], "dead": d["dead"],
            }
        clean_fences = {}
        for fid, f in game.fences.items():
            if not f["dead"]:
                clean_fences[fid] = {
                    "id": f["id"], "x": f["x"], "y": f["y"],
                    "tier": f["tier"], "hp": f["hp"], "maxHp": f["maxHp"],
                    "owner": f["owner"], "gate": f["gate"], "dead": f["dead"],
                }
        clean_ki_targets = {}
        for ktid, kt in game.ki_targets.items():
            if not kt.get("dead"):
                clean_ki_targets[ktid] = {
                    "id": kt["id"], "x": kt["x"], "y": kt["y"],
                    "hp": kt["hp"], "maxHp": kt["maxHp"],
                    "owner": kt.get("owner", ""),
                }
        clean_anvils = {}
        for aid, a in game.anvils.items():
            if not a.get("dead"):
                clean_anvils[aid] = {
                    "id": a["id"], "x": a["x"], "y": a["y"],
                    "owner": a.get("owner", ""),
                }
        state = {
            "type": "state",
            "players": clean_players,
            "trees": game.trees,
            "rocks": game.rocks,
            "ground_items": game.ground_items,
            "dummies": clean_dummies,
            "fences": clean_fences,
            "ki_targets": clean_ki_targets,
            "anvils": clean_anvils,
            "fx_events": list(game.fx_events),
        }
        game.fx_events.clear()
        payload = json.dumps(state)

        # Broadcast to all connected clients
        disconnected = []
        for pid, ws in clients.items():
            try:
                await ws.send_text(payload)
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
        player["x"] = saved.get("x", player["x"])
        player["y"] = saved.get("y", player["y"])
        player["hp"] = saved.get("hp", player["hp"])
        player["maxHp"] = saved.get("maxHp", player["maxHp"])
        player["ki"] = saved.get("ki", player.get("ki", 20))
        player["maxKi"] = saved.get("maxKi", player.get("maxKi", 20))
        player["blastLevel"] = saved.get("blastLevel", player.get("blastLevel", 0))
        player["inf_ki"] = saved.get("inf_ki", player.get("inf_ki", False))
        player["kiSkillLevel"] = saved.get("kiSkillLevel", player.get("kiSkillLevel", 1))
        player["kiSkillXp"] = saved.get("kiSkillXp", player.get("kiSkillXp", 0))
        player["realm_tier"] = saved.get("realm_tier", player.get("realm_tier", 0))
        player["realm_insight"] = saved.get("realm_insight", player.get("realm_insight", 0))
        player["realm_crystal_t1"] = saved.get("realm_crystal_t1", player.get("realm_crystal_t1", 0))
        player["ki_upgrades"] = saved.get("ki_upgrades", player.get("ki_upgrades", {}))
        player["str"] = saved.get("str", player["str"])
        player["def"] = saved.get("def", player["def"])
        player["level"] = saved.get("level", player["level"])
        player["xp"] = saved.get("xp", player["xp"])
        player["logs"] = saved.get("logs", player["logs"])
        player["stones"] = saved.get("stones", player.get("stones", 0))
        player["bastalite"] = saved.get("bastalite", 0)
        player["crystal_pristine"] = saved.get("crystal_pristine", 0)
        player["crystal_normal"] = saved.get("crystal_normal", 0)
        player["crystal_poor"] = saved.get("crystal_poor", 0)
        player["armor_elite"] = saved.get("armor_elite", False)
        player["armor_elite_inv"] = saved.get("armor_elite_inv", False)
        player["ki_moves"] = saved.get("ki_moves", [])
        player["ki_denominations"] = saved.get("ki_denominations", [])
        player["ki_known_augments"] = saved.get("ki_known_augments", {})
        player["ki_equipped_augments"] = saved.get("ki_equipped_augments", {})
        player["aura_tint"] = saved.get("aura_tint", player.get("aura_tint", 0x4fd6ff))
        player["aura_alpha"] = saved.get("aura_alpha", player.get("aura_alpha", 0.42))
        player["npc_ids"] = saved.get("npc_ids", [])
        game._normalize_ki_progression(player)
        game._ensure_level_based_ki(player)
        print(f"[ws] Restored player {pid} (level {player['level']}, {player['logs']} logs)")
    else:
        player["npc_ids"] = []
        print(f"[ws] New player {pid}")

    # Send welcome with saved NPC IDs
    snap = game.snapshot()
    welcome = {
        "type": "welcome",
        "your_id": pid,
        "players": snap["players"],
        "trees": snap["trees"],
        "ground_items": snap["ground_items"],
        "dummies": snap["dummies"],
        "fences": snap["fences"],
        "ki_targets": snap.get("ki_targets", {}),
        "anvils": snap.get("anvils", {}),
        "npc_ids": player.get("npc_ids", []),
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
