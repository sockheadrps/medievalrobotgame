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
        "str": p["str"], "def": p["def"],
        "level": p["level"], "xp": p["xp"],
        "logs": p["logs"],
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
                "str": p["str"], "def": p["def"],
                "level": p["level"], "xp": p["xp"],
                "logs": p["logs"],
                "dead": p.get("dead", False),
                "npcs": p.get("npcs", {}),
                "chatColor": p.get("chatColor", "#cccccc"),
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
        state = {
            "type": "state",
            "players": clean_players,
            "trees": game.trees,
            "ground_items": game.ground_items,
            "dummies": clean_dummies,
            "fences": clean_fences,
        }
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
        player["str"] = saved.get("str", player["str"])
        player["def"] = saved.get("def", player["def"])
        player["level"] = saved.get("level", player["level"])
        player["xp"] = saved.get("xp", player["xp"])
        player["logs"] = saved.get("logs", player["logs"])
        player["npc_ids"] = saved.get("npc_ids", [])
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
