# game_state.py — Server-authoritative world state for multiplayer.
# Holds all players, trees, ground items, NPCs, dummies.
# Ticked at ~20Hz by the WebSocket broadcast loop.

import json
import time
import math
import random
from pathlib import Path

from services.database import (
    load_ground_items, save_ground_items,
    load_fences, save_fences,
    load_dummies, save_dummies,
)

TILE_SIZE = 48
PLAYER_SPEED = 160
PLAYER_RUN_SPEED = 280
TREE_CHOP_DIST = 80
TREE_REGROW_MIN = 15.0
TREE_REGROW_MAX = 30.0
PICKUP_DIST = TILE_SIZE * 0.6
PVP_ATTACK_RANGE = TILE_SIZE * 1.5
PVP_COOLDOWN = 0.8
PLAYER_RESPAWN_TIME = 5.0
PVP_XP_KILL = 25

SHEET_COLS = 57
FRAME_TREE = 531  # tileX=18, tileY=9

# Fallback tree positions if map fails to load
FALLBACK_TREE_POSITIONS = [
    (3,3),(4,5),(6,2),(8,4),(10,3),(12,5),(14,2),(16,4),
    (5,8),(7,7),(9,9),(11,8),(13,7),(15,9),
    (3,12),(6,11),(8,13),(10,12),(12,14),(14,11),(16,13),
    (4,16),(7,15),(9,17),(11,16),(13,18),(15,15),
    (18,3),(20,5),(22,2),(24,4),(18,8),(20,7),
    (22,9),(24,8),(18,12),(20,14),(22,11),(24,13),
]


def _load_tree_positions_from_map():
    """Load tree positions from level1.json map file."""
    try:
        maps_dir = Path(__file__).resolve().parent.parent / "maps"
        map_path = maps_dir / "level1.json"
        if not map_path.exists():
            return FALLBACK_TREE_POSITIONS, 80, 50
        data = json.loads(map_path.read_text(encoding="utf-8"))
        width = data.get("width", 30)
        height = data.get("height", 30)
        trees = []
        for t in data.get("tiles", []):
            tile_x = t.get("tileX")
            tile_y = t.get("tileY")
            if not isinstance(tile_x, int) or not isinstance(tile_y, int):
                continue
            frame = tile_x + tile_y * SHEET_COLS
            if frame == FRAME_TREE:
                trees.append((t["x"], t["y"]))
        if trees:
            print(f"[game_state] Loaded {len(trees)} trees from level1.json ({width}x{height})")
            return trees, width, height
    except Exception as e:
        print(f"[game_state] Failed to load map: {e}")
    return FALLBACK_TREE_POSITIONS, 80, 50


TREE_POSITIONS, MAP_COLS, MAP_ROWS = _load_tree_positions_from_map()


def tile_pos(col, row):
    return (col * TILE_SIZE + TILE_SIZE / 2, row * TILE_SIZE + TILE_SIZE / 2)


def dist(x1, y1, x2, y2):
    return math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2)


_next_item_id = 0
_next_dummy_id = 0
_next_fence_id = 0


def _gen_item_id():
    global _next_item_id
    _next_item_id += 1
    return f"item_{_next_item_id}"


def _gen_dummy_id():
    global _next_dummy_id
    _next_dummy_id += 1
    return f"dummy_{_next_dummy_id}"


def _gen_fence_id():
    global _next_fence_id
    _next_fence_id += 1
    return f"fence_{_next_fence_id}"


# Fence HP per tier
FENCE_HP = {1: 15, 2: 30, 3: 50}
GATE_HP = 60
LOG_STACK_MAX = 3


class GameState:
    def __init__(self):
        self.players = {}       # pid -> PlayerState
        self.trees = []         # list of TreeState
        self.ground_items = []  # list of ItemState
        self.npcs = {}          # npc_id -> dict (managed client-side for now)
        self.dummies = {}       # dummy_id -> DummyState
        self.fences = {}        # fence_id -> FenceState
        self._last_save = 0     # timestamp of last DB save
        self._init_trees()
        self._load_persisted()

    def _init_trees(self):
        for i, (col, row) in enumerate(TREE_POSITIONS):
            x, y = tile_pos(col, row)
            self.trees.append({
                "id": i,
                "x": x, "y": y,
                "chopped": False,
                "regrow_at": None,
            })

    def _load_persisted(self):
        """Load ground items, fences, and dummies from the database."""
        global _next_item_id, _next_fence_id, _next_dummy_id
        try:
            self.ground_items = load_ground_items()
            self.fences = load_fences()
            self.dummies = load_dummies()
            # Restore ID counters so new IDs don't collide
            for item in self.ground_items:
                n = int(item["id"].split("_", 1)[1])
                if n >= _next_item_id:
                    _next_item_id = n
            for fid in self.fences:
                n = int(fid.split("_", 1)[1])
                if n >= _next_fence_id:
                    _next_fence_id = n
            for did in self.dummies:
                n = int(did.split("_", 1)[1])
                if n >= _next_dummy_id:
                    _next_dummy_id = n
            ct = len(self.ground_items) + len(self.fences) + len(self.dummies)
            if ct > 0:
                print(f"[game_state] Restored {len(self.ground_items)} ground items, "
                      f"{len(self.fences)} fences, {len(self.dummies)} dummies from DB")
        except Exception as e:
            print(f"[game_state] Failed to load persisted state: {e}")

    def save_world(self):
        """Persist ground items, fences, and dummies to the database."""
        try:
            save_ground_items(self.ground_items)
            save_fences(self.fences)
            save_dummies(self.dummies)
        except Exception as e:
            print(f"[game_state] Failed to save world state: {e}")

    def add_player(self, pid: str):
        # Spawn near center with slight random offset
        sx, sy = tile_pos(10, 10)
        sx += random.randint(-48, 48)
        sy += random.randint(-48, 48)
        self.players[pid] = {
            "id": pid,
            "x": sx, "y": sy,
            "vx": 0, "vy": 0,
            "facing": "down",
            "anim": "idle",
            "punching": False,
            "hp": 20, "maxHp": 20,
            "str": 1, "def": 1,
            "level": 1, "xp": 0,
            "logs": 0,
            "dead": False,
            "respawn_at": None,
            "last_hit_by_player": {},  # attacker_pid -> timestamp
            "npcs": {},  # npc_id -> { hp, maxHp, str, def, x, y, owner }
            "npc_ids": [],  # persistent list of owned NPC IDs
            "chatColor": "#cccccc",
        }
        return self.players[pid]

    def remove_player(self, pid: str):
        self.players.pop(pid, None)

    def handle_input(self, pid: str, data: dict):
        """Process input from a client."""
        p = self.players.get(pid)
        if not p:
            return

        msg_type = data.get("type")

        # Allow sync_npcs and move even when dead (move will be no-op on server)
        # Block combat actions when dead
        if p.get("dead") and msg_type not in ("move", "sync_npcs", "admin"):
            return

        if msg_type == "move":
            dx = data.get("dx", 0)
            dy = data.get("dy", 0)
            running = data.get("running", False)
            speed = PLAYER_RUN_SPEED if running else PLAYER_SPEED

            # Normalize diagonal
            if dx != 0 and dy != 0:
                dx /= math.sqrt(2)
                dy /= math.sqrt(2)

            p["vx"] = dx * speed
            p["vy"] = dy * speed

            # Update facing
            if dx < 0:
                p["facing"] = "left"
            elif dx > 0:
                p["facing"] = "right"
            elif dy < 0:
                p["facing"] = "up"
            elif dy > 0:
                p["facing"] = "down"

            moving = dx != 0 or dy != 0
            if moving:
                p["anim"] = "run" if running else "walk"
            else:
                p["anim"] = "idle"

        elif msg_type == "chop":
            tree_id = data.get("tree_id")
            self._try_chop(pid, tree_id)

        elif msg_type == "attack_dummy":
            dummy_id = data.get("dummy_id")
            self._try_attack_dummy(pid, dummy_id)

        elif msg_type == "build_dummy":
            self._try_build_dummy(pid, data.get("logs", 10))

        elif msg_type == "punch":
            p["punching"] = True
            p["punch_until"] = time.time() + 0.3

        elif msg_type == "npc_chop":
            tree_id = data.get("tree_id")
            owner_id = data.get("owner_id", pid)
            self._npc_chop(tree_id, owner_id)

        elif msg_type == "admin":
            self._handle_admin(p, data)

        elif msg_type == "npc_attack_dummy":
            dummy_id = data.get("dummy_id")
            npc_str = data.get("str", 1)
            self._npc_attack_dummy(dummy_id, npc_str)

        elif msg_type == "attack_player":
            target_pid = data.get("target_id")
            self._try_attack_player(pid, target_pid)

        elif msg_type == "attack_npc":
            target_owner = data.get("owner_id")
            target_npc_id = data.get("npc_id")
            self._try_attack_npc(pid, target_owner, target_npc_id)

        elif msg_type == "npc_attack_player":
            target_pid = data.get("target_id")
            npc_str = data.get("str", 1)
            npc_id = data.get("npc_id", "npc")
            self._npc_attack_player(pid, target_pid, npc_str, npc_id)

        elif msg_type == "npc_attack_npc":
            target_owner = data.get("target_owner")
            target_npc_id = data.get("target_npc_id")
            npc_str = data.get("str", 1)
            npc_id = data.get("npc_id", "npc")
            self._npc_attack_npc(pid, npc_id, target_owner, target_npc_id, npc_str)

        elif msg_type == "npc_steal_logs":
            target_owner = data.get("target_owner")
            target_npc_id = data.get("target_npc_id")
            npc_id = data.get("npc_id", "npc")
            npc_str = data.get("str", 1)
            steal_amount = data.get("amount", 1)
            self._npc_steal_logs(pid, npc_id, target_owner, target_npc_id, npc_str, steal_amount)

        elif msg_type == "drop_item":
            self._try_drop_item(pid, data)

        elif msg_type == "pickup_placed":
            self._try_pickup_placed(pid, data.get("item_id"))

        elif msg_type == "build_fence":
            self._try_build_fence(pid, data)

        elif msg_type == "build_gate":
            self._try_build_gate(pid, data)

        elif msg_type == "attack_fence":
            fence_id = data.get("fence_id")
            self._try_attack_fence(pid, fence_id)

        elif msg_type == "pickup_fence":
            fence_id = data.get("fence_id")
            self._try_pickup_fence(pid, fence_id)

        elif msg_type == "sync_npcs":
            npcs = data.get("npcs", {})
            self._sync_player_npcs(pid, npcs)

    def _handle_admin(self, p, data):
        field = data.get("field")
        value = data.get("value", 0)
        if field == "logs":
            p["logs"] += int(value)
        elif field == "full_hp":
            p["hp"] = p["maxHp"]
        elif field == "maxHp":
            p["maxHp"] += int(value)
            p["hp"] = p["maxHp"]
        elif field == "str":
            p["str"] += int(value)
        elif field == "def":
            p["def"] += int(value)

    def _npc_attack_dummy(self, dummy_id, npc_str):
        if not dummy_id:
            return
        dummy = self.dummies.get(dummy_id)
        if not dummy or dummy["dead"]:
            return
        now = time.time()
        last = dummy.get("last_hit_by", {}).get("npc", 0)
        if now - last < 0.8:
            return
        dummy.setdefault("last_hit_by", {})["npc"] = now
        dmg = max(1, npc_str + random.randint(0, max(1, npc_str // 2)))
        dummy["hp"] = max(0, dummy["hp"] - dmg)
        if dummy["hp"] <= 0:
            dummy["dead"] = True

    # ── PvP Combat ──────────────────────────────────────────────────────────────

    def _try_attack_player(self, attacker_pid, target_pid):
        """Player attacks another player."""
        if attacker_pid == target_pid:
            return
        attacker = self.players.get(attacker_pid)
        target = self.players.get(target_pid)
        if not attacker or not target:
            return
        if attacker.get("dead") or target.get("dead"):
            return

        d = dist(attacker["x"], attacker["y"], target["x"], target["y"])
        if d > PVP_ATTACK_RANGE:
            return

        # Cooldown
        now = time.time()
        last = attacker.get("last_hit_by_player", {}).get(f"atk_{target_pid}", 0)
        if now - last < PVP_COOLDOWN:
            return
        attacker.setdefault("last_hit_by_player", {})[f"atk_{target_pid}"] = now

        # Damage: attacker STR vs target DEF
        s = attacker["str"]
        d_def = target["def"]
        dmg = max(1, s + random.randint(0, max(1, s // 2)) - d_def // 2)
        target["hp"] = max(0, target["hp"] - dmg)

        # Punch anim
        attacker["punching"] = True
        attacker["punch_until"] = now + 0.3

        # XP for hitting a player
        attacker["xp"] += 8
        needed = attacker["level"] * 20
        if attacker["xp"] >= needed:
            attacker["xp"] -= needed
            attacker["level"] += 1
            attacker["maxHp"] += 2
            attacker["hp"] = attacker["maxHp"]
            attacker["str"] += 1
            attacker["def"] += 1

        if target["hp"] <= 0:
            self._kill_player(target, attacker)

    def _try_attack_npc(self, attacker_pid, target_owner_pid, target_npc_id):
        """Player attacks another player's NPC."""
        attacker = self.players.get(attacker_pid)
        owner = self.players.get(target_owner_pid)
        if not attacker or not owner:
            return
        if attacker.get("dead"):
            return

        npc_state = owner.get("npcs", {}).get(target_npc_id)
        if not npc_state or npc_state.get("dead"):
            return

        d = dist(attacker["x"], attacker["y"], npc_state["x"], npc_state["y"])
        if d > PVP_ATTACK_RANGE:
            return

        # Cooldown
        now = time.time()
        cooldown_key = f"atk_npc_{target_npc_id}"
        last = attacker.get("last_hit_by_player", {}).get(cooldown_key, 0)
        if now - last < PVP_COOLDOWN:
            return
        attacker.setdefault("last_hit_by_player", {})[cooldown_key] = now

        s = attacker["str"]
        npc_def = npc_state.get("def", 1)
        dmg = max(1, s + random.randint(0, max(1, s // 2)) - npc_def // 2)
        npc_state["hp"] = max(0, npc_state["hp"] - dmg)
        npc_state["_last_attacked_by"] = {"type": "player", "id": attacker_pid}

        attacker["punching"] = True
        attacker["punch_until"] = now + 0.3

        # XP
        attacker["xp"] += 5
        needed = attacker["level"] * 20
        if attacker["xp"] >= needed:
            attacker["xp"] -= needed
            attacker["level"] += 1
            attacker["maxHp"] += 2
            attacker["hp"] = attacker["maxHp"]
            attacker["str"] += 1
            attacker["def"] += 1

        if npc_state["hp"] <= 0:
            npc_state["dead"] = True

    def _npc_attack_player(self, owner_pid, target_pid, npc_str, npc_id):
        """An NPC (owned by owner_pid) attacks a player."""
        if owner_pid == target_pid:
            return  # NPCs don't attack their own owner
        target = self.players.get(target_pid)
        if not target or target.get("dead"):
            return

        # Cooldown
        now = time.time()
        cooldown_key = f"npc_{npc_id}"
        last = target.get("last_hit_by_player", {}).get(cooldown_key, 0)
        if now - last < PVP_COOLDOWN:
            return
        target.setdefault("last_hit_by_player", {})[cooldown_key] = now

        d_def = target["def"]
        dmg = max(1, npc_str + random.randint(0, max(1, npc_str // 2)) - d_def // 2)
        target["hp"] = max(0, target["hp"] - dmg)

        if target["hp"] <= 0:
            # Credit kill XP to the NPC's owner
            owner = self.players.get(owner_pid)
            if owner:
                owner["xp"] += PVP_XP_KILL
                needed = owner["level"] * 20
                if owner["xp"] >= needed:
                    owner["xp"] -= needed
                    owner["level"] += 1
                    owner["maxHp"] += 2
                    owner["hp"] = owner["maxHp"]
                    owner["str"] += 1
                    owner["def"] += 1
            self._kill_player(target, owner)

    def _npc_attack_npc(self, owner_pid, attacker_npc_id, target_owner_pid, target_npc_id, npc_str):
        """An NPC attacks another player's NPC."""
        if owner_pid == target_owner_pid:
            return  # Don't attack own NPCs
        target_owner = self.players.get(target_owner_pid)
        if not target_owner:
            return
        npc_state = target_owner.get("npcs", {}).get(target_npc_id)
        if not npc_state or npc_state.get("dead"):
            return

        now = time.time()
        cooldown_key = f"npc_{attacker_npc_id}_vs_{target_npc_id}"
        last = npc_state.get("last_hit", {}).get(cooldown_key, 0)
        if now - last < PVP_COOLDOWN:
            return
        npc_state.setdefault("last_hit", {})[cooldown_key] = now

        npc_def = npc_state.get("def", 1)
        dmg = max(1, npc_str + random.randint(0, max(1, npc_str // 2)) - npc_def // 2)
        npc_state["hp"] = max(0, npc_state["hp"] - dmg)

        if npc_state["hp"] <= 0:
            npc_state["dead"] = True

    def _npc_steal_logs(self, owner_pid, attacker_npc_id, target_owner_pid, target_npc_id, npc_str, steal_amount):
        """An NPC smacks another player's NPC and steals logs from it."""
        if owner_pid == target_owner_pid:
            return  # Don't steal from own NPCs
        target_owner = self.players.get(target_owner_pid)
        if not target_owner:
            return
        npc_state = target_owner.get("npcs", {}).get(target_npc_id)
        if not npc_state or npc_state.get("dead"):
            return

        # Cooldown — use same mechanism as npc_attack_npc
        now = time.time()
        cooldown_key = f"steal_{attacker_npc_id}_vs_{target_npc_id}"
        last = npc_state.get("last_hit", {}).get(cooldown_key, 0)
        if now - last < PVP_COOLDOWN * 2:  # longer cooldown for stealing
            return
        npc_state.setdefault("last_hit", {})[cooldown_key] = now

        # Light smack damage (half of normal attack)
        npc_def = npc_state.get("def", 1)
        dmg = max(1, (npc_str + random.randint(0, max(1, npc_str // 2))) // 2 - npc_def // 2)
        npc_state["hp"] = max(0, npc_state["hp"] - dmg)

        # Steal logs from the target's synced data
        target_logs = npc_state.get("logs", 0)
        stolen = min(steal_amount, target_logs)
        if stolen > 0:
            npc_state["logs"] = target_logs - stolen
            npc_state["_logs_stolen_at"] = now
            # Record who stole so the victim's client can identify the thief
            npc_state["_last_robbed_by"] = {
                "npc_id": attacker_npc_id,
                "owner": owner_pid,
                "amount": stolen,
                "at": now,
            }

        if npc_state["hp"] <= 0:
            npc_state["dead"] = True

    def _kill_player(self, target, killer=None):
        """Handle player death — drop all logs as ground items."""
        target["dead"] = True
        target["hp"] = 0
        target["vx"] = 0
        target["vy"] = 0
        target["respawn_at"] = time.time() + PLAYER_RESPAWN_TIME

        # Drop logs as ground items at death location
        if target["logs"] > 0:
            item_id = _gen_item_id()
            self.ground_items.append({
                "id": item_id,
                "x": target["x"],
                "y": target["y"] + TILE_SIZE * 0.4,
                "resource": "Wood",
                "amount": target["logs"],
            })
            target["logs"] = 0

    def _is_blocked_by_fence(self, x, y, owner_pid):
        """Check if a position is blocked by a fence/gate. Owner can pass own gates."""
        for f in self.fences.values():
            if f["dead"]:
                continue
            fd = dist(x, y, f["x"], f["y"])
            if fd < TILE_SIZE * 0.45:
                if f["gate"] and f["owner"] == owner_pid:
                    continue  # owner passes through own gates
                return True
        return False

    def _sync_player_npcs(self, pid, npcs):
        """Sync NPC positions/stats from a client so other clients can see them."""
        p = self.players.get(pid)
        if not p:
            return
        now = time.time()
        # Only update position and stats, preserve server-side hp if it was damaged
        for npc_id, npc_data in npcs.items():
            existing = p.get("npcs", {}).get(npc_id)
            if existing and existing.get("hp", 0) < npc_data.get("hp", 0):
                # Server HP was reduced by combat — don't let client overwrite it
                npc_data["hp"] = existing["hp"]
            if existing:
                # Logs stolen by another NPC — only protect if steal happened recently
                steal_ts = existing.get("_logs_stolen_at", 0)
                if steal_ts and now - steal_ts < 2.0 and existing.get("logs", 0) < npc_data.get("logs", 0):
                    npc_data["logs"] = existing["logs"]
            if existing and existing.get("dead"):
                npc_data["dead"] = True
            # Fence collision — reject NPC position if it would be inside a fence
            new_x = npc_data.get("x", 0)
            new_y = npc_data.get("y", 0)
            if existing and self._is_blocked_by_fence(new_x, new_y, pid):
                npc_data["x"] = existing.get("x", new_x)
                npc_data["y"] = existing.get("y", new_y)
            npc_data["owner"] = pid
            p.setdefault("npcs", {})[npc_id] = npc_data

    def _npc_chop(self, tree_id, owner_id):
        """NPC chops a tree — tree state only. Logs go to NPC inventory client-side."""
        if tree_id is None:
            return
        if tree_id < 0 or tree_id >= len(self.trees):
            return
        tree = self.trees[tree_id]
        if tree["chopped"]:
            return

        tree["chopped"] = True
        tree["regrow_at"] = time.time() + random.uniform(TREE_REGROW_MIN, TREE_REGROW_MAX)

    def _try_chop(self, pid, tree_id):
        if tree_id is None:
            return
        if tree_id < 0 or tree_id >= len(self.trees):
            return
        tree = self.trees[tree_id]
        if tree["chopped"]:
            return

        tree["chopped"] = True
        tree["regrow_at"] = time.time() + random.uniform(TREE_REGROW_MIN, TREE_REGROW_MAX)

        # Drop ground item
        item_id = _gen_item_id()
        self.ground_items.append({
            "id": item_id,
            "x": tree["x"],
            "y": tree["y"] + TILE_SIZE * 0.4,
            "resource": "Wood",
            "amount": 1,
        })

    def _try_attack_dummy(self, pid, dummy_id):
        p = self.players.get(pid)
        if not p or not dummy_id:
            return
        dummy = self.dummies.get(dummy_id)
        if not dummy or dummy["dead"]:
            return
        d = dist(p["x"], p["y"], dummy["x"], dummy["y"])
        if d > TILE_SIZE * 1.5:
            return

        # Facing check
        dx = dummy["x"] - p["x"]
        dy = dummy["y"] - p["y"]
        facing = p["facing"]
        if abs(dx) > abs(dy):
            if not ((dx > 0 and facing == "right") or (dx < 0 and facing == "left")):
                return
        else:
            if not ((dy > 0 and facing == "down") or (dy < 0 and facing == "up")):
                return

        # Cooldown check
        now = time.time()
        last = dummy.get("last_hit_by", {}).get(pid, 0)
        if now - last < 0.8:
            return
        dummy.setdefault("last_hit_by", {})[pid] = now

        # Damage
        s = p["str"]
        dmg = max(1, s + random.randint(0, max(1, s // 2)))
        dummy["hp"] = max(0, dummy["hp"] - dmg)

        # Punch anim
        p["punching"] = True
        p["punch_until"] = now + 0.3

        # XP
        xp_gain = 5
        p["xp"] += xp_gain
        needed = p["level"] * 20
        if p["xp"] >= needed:
            p["xp"] -= needed
            p["level"] += 1
            p["maxHp"] += 2
            p["hp"] = p["maxHp"]
            p["str"] += 1
            p["def"] += 1

        if dummy["hp"] <= 0:
            dummy["dead"] = True

    def _try_build_dummy(self, pid, logs_used):
        p = self.players.get(pid)
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
        self.dummies[did] = {
            "id": did,
            "x": dx, "y": dy,
            "maxHp": logs_used * 5,
            "hp": logs_used * 5,
            "dead": False,
            "last_hit_by": {},
        }

    # ── Drop Items / Fences / Gates ────────────────────────────────────────────

    def _tile_key(self, x, y):
        """Return (col, row) grid key for a world position."""
        return (int(x // TILE_SIZE), int(y // TILE_SIZE))

    def _try_drop_item(self, pid, data):
        """Drop logs. If x/y given, drop at that position (NPC drop). Otherwise drop at player's feet."""
        p = self.players.get(pid)
        if not p or p.get("dead"):
            return

        amount = min(int(data.get("amount", 1)), 3)

        # If explicit x/y given (NPC forced drop), use that position
        if "x" in data and "y" in data:
            drop_x, drop_y = float(data["x"]), float(data["y"])
        else:
            if p["logs"] < 1:
                return
            drop_x, drop_y = p["x"], p["y"]

        col = int(drop_x // TILE_SIZE)
        row = int(drop_y // TILE_SIZE)
        tx, ty = tile_pos(col, row)

        # For player-initiated drops (no x/y), deduct from player logs
        if "x" not in data:
            amount = 1  # hotbar drops 1 at a time
            p["logs"] -= 1

        # Check if there's already a log stack on this tile
        for item in self.ground_items:
            if (item["resource"] in ("Wood", "log") and
                    self._tile_key(item["x"], item["y"]) == (col, row)):
                item["amount"] = min(item["amount"] + amount, LOG_STACK_MAX)
                if "x" not in data:
                    item["_placed"] = True  # mark as intentionally placed
                return

        # No existing stack — create new
        item_id = _gen_item_id()
        self.ground_items.append({
            "id": item_id,
            "x": tx,
            "y": ty,
            "resource": "Wood",
            "amount": min(amount, LOG_STACK_MAX),
            "_placed": True,  # intentionally placed — not auto-picked up
        })

    def _try_pickup_placed(self, pid, item_id):
        """Player picks up 1 log from a placed stack by clicking it."""
        p = self.players.get(pid)
        if not p or p.get("dead") or not item_id:
            return

        for item in self.ground_items:
            if item["id"] == item_id and item.get("_placed"):
                # Range check
                d = dist(p["x"], p["y"], item["x"], item["y"])
                if d > TILE_SIZE * 1.5:
                    return
                # Pick up 1 log
                p["logs"] += 1
                item["amount"] -= 1
                if item["amount"] <= 0:
                    self.ground_items.remove(item)
                return

    def _try_build_fence(self, pid, data):
        """NPC builds a fence from a log stack on a tile. Logs consumed = fence tier."""
        p = self.players.get(pid)
        if not p or p.get("dead"):
            return
        x = data.get("x", 0)
        y = data.get("y", 0)
        col, row = self._tile_key(x, y)
        tx, ty = tile_pos(col, row)

        # Check for existing fence/gate on this tile
        for f in self.fences.values():
            if self._tile_key(f["x"], f["y"]) == (col, row):
                return  # already a fence here

        # Find log stack on this tile
        log_item = None
        for item in self.ground_items:
            if (item["resource"] in ("Wood", "log") and
                    self._tile_key(item["x"], item["y"]) == (col, row)):
                log_item = item
                break
        if not log_item:
            return

        tier = min(log_item["amount"], 3)
        hp = FENCE_HP.get(tier, 15)

        # Remove the log stack
        self.ground_items.remove(log_item)

        fid = _gen_fence_id()
        self.fences[fid] = {
            "id": fid,
            "x": tx, "y": ty,
            "tier": tier,
            "hp": hp, "maxHp": hp,
            "owner": pid,
            "gate": False,
            "dead": False,
            "last_hit_by": {},
        }

    def _try_build_gate(self, pid, data):
        """Player builds a fence gate (costs 10 logs from inventory)."""
        p = self.players.get(pid)
        if not p or p.get("dead"):
            return
        if p["logs"] < 10:
            return

        col = int(p["x"] // TILE_SIZE) + 2
        row = int(p["y"] // TILE_SIZE)
        tx, ty = tile_pos(col, row)

        # Check for existing fence/gate on this tile
        for f in self.fences.values():
            if self._tile_key(f["x"], f["y"]) == (col, row):
                return

        p["logs"] -= 10
        fid = _gen_fence_id()
        self.fences[fid] = {
            "id": fid,
            "x": tx, "y": ty,
            "tier": 3,
            "hp": GATE_HP, "maxHp": GATE_HP,
            "owner": pid,
            "gate": True,
            "dead": False,
            "last_hit_by": {},
        }

    def _try_attack_fence(self, pid, fence_id):
        """Player attacks a fence/gate."""
        p = self.players.get(pid)
        if not p or p.get("dead") or not fence_id:
            return
        fence = self.fences.get(fence_id)
        if not fence or fence["dead"]:
            return

        d = dist(p["x"], p["y"], fence["x"], fence["y"])
        if d > PVP_ATTACK_RANGE:
            return

        now = time.time()
        last = fence["last_hit_by"].get(pid, 0)
        if now - last < PVP_COOLDOWN:
            return
        fence["last_hit_by"][pid] = now

        s = p["str"]
        dmg = max(1, s + random.randint(0, max(1, s // 2)))
        fence["hp"] = max(0, fence["hp"] - dmg)

        p["punching"] = True
        p["punch_until"] = now + 0.3

        if fence["hp"] <= 0:
            fence["dead"] = True

    def _try_pickup_fence(self, pid, fence_id):
        """Owner picks up their own gate, refunding 10 logs."""
        p = self.players.get(pid)
        if not p or p.get("dead") or not fence_id:
            return
        fence = self.fences.get(fence_id)
        if not fence or fence["dead"]:
            return
        # Only owner can pick up, and only gates
        if fence["owner"] != pid or not fence["gate"]:
            return
        d = dist(p["x"], p["y"], fence["x"], fence["y"])
        if d > PVP_ATTACK_RANGE:
            return
        p["logs"] += 10
        fence["dead"] = True  # will be cleaned up next tick

    def tick(self, dt: float):
        """Advance simulation by dt seconds."""
        now = time.time()

        # Respawn dead players
        for p in self.players.values():
            if p.get("dead") and p.get("respawn_at") and now >= p["respawn_at"]:
                p["dead"] = False
                p["hp"] = p["maxHp"]
                p["respawn_at"] = None
                # Respawn at center
                sx, sy = tile_pos(10, 10)
                p["x"] = sx + random.randint(-48, 48)
                p["y"] = sy + random.randint(-48, 48)

        # Move players
        world_w = MAP_COLS * TILE_SIZE
        world_h = MAP_ROWS * TILE_SIZE
        for p in self.players.values():
            if p.get("dead"):
                p["vx"] = 0
                p["vy"] = 0
                continue
            if p.get("punching"):
                if now >= p.get("punch_until", 0):
                    p["punching"] = False
                p["vx"] = 0
                p["vy"] = 0
            else:
                new_x = p["x"] + p["vx"] * dt
                new_y = p["y"] + p["vy"] * dt
                # Clamp to world bounds
                new_x = max(0, min(world_w, new_x))
                new_y = max(0, min(world_h, new_y))
                # Fence/gate collision
                blocked = self._is_blocked_by_fence(new_x, new_y, p["id"])
                if not blocked:
                    p["x"] = new_x
                    p["y"] = new_y
                else:
                    p["vx"] = 0
                    p["vy"] = 0

        # Pickup ground items (skip dead players)
        for p in self.players.values():
            if p.get("dead"):
                continue
            remaining = []
            for item in self.ground_items:
                # Intentionally placed logs (for fences) are not auto-picked up
                if item.get("_placed"):
                    remaining.append(item)
                    continue
                d = dist(p["x"], p["y"], item["x"], item["y"])
                if d <= PICKUP_DIST:
                    p["logs"] += item["amount"]
                else:
                    remaining.append(item)
            self.ground_items = remaining

        # Tree regrowth
        for tree in self.trees:
            if tree["chopped"] and tree["regrow_at"] and now >= tree["regrow_at"]:
                tree["chopped"] = False
                tree["regrow_at"] = None

        # Clean up dead dummies
        to_remove = [did for did, d in self.dummies.items() if d["dead"]]
        for did in to_remove:
            del self.dummies[did]

        # Clean up dead fences/gates
        to_remove = [fid for fid, f in self.fences.items() if f["dead"]]
        for fid in to_remove:
            del self.fences[fid]

        # Periodic save to DB (every 30 seconds)
        if now - self._last_save >= 30:
            self._last_save = now
            self.save_world()

    def snapshot(self):
        """Full world state for a joining player."""
        return {
            "type": "snapshot",
            "players": self.players,
            "trees": self.trees,
            "ground_items": self.ground_items,
            "dummies": self.dummies,
            "fences": self.fences,
        }

    def delta(self):
        """Compact state sent every tick."""
        return {
            "type": "state",
            "players": self.players,
            "trees": [t for t in self.trees if t["chopped"] or t.get("_just_regrew")],
            "ground_items": self.ground_items,
            "dummies": self.dummies,
            "fences": self.fences,
        }


# Singleton
game = GameState()
