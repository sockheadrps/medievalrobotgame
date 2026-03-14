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
    load_ki_targets, save_ki_targets,
    load_anvils, save_anvils,
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
KNOCKOUT_MIN_TIME = 10.0
KNOCKOUT_MAX_TIME = 20.0
PVP_XP_KILL = 25
CAMPFIRE_DURATION_PER_LOG = 20.0
CAMPFIRE_HEAL_RATE = 0.03
CAMPFIRE_HEAL_TILE_RADIUS = 2
CAMPFIRE_HEAL_LINGER = 2.5

# Ki / blast constants
KI_MAX_BASE = 20
KI_MAX_PER_LEVEL = 2
KI_BLAST_BASE_COST = 8
KI_BLAST_BASE_DMG = 2
KI_BLAST_SCALE = 0.02  # 2% improvement per blast level
KI_DEF_REDUCTION_DIVISOR = 2
KI_SKILL_RESIST_PER_LEVEL = 0.01
KI_SKILL_RESIST_CAP = 0.50
KI_BLAST_RANGE = TILE_SIZE * 4  # longer range than melee
KI_BLAST_COOLDOWN = 1.2  # seconds between blasts
CHARGE_KI_DRAIN_RATE = 3.0
CHARGE_BUILD_RATE = 0.75
CHARGE_DECAY_RATE = 0.07
CHARGE_STR_BONUS = 0.50
CHARGE_DEF_BONUS = 0.50
CHARGE_KI_ATTACK_BONUS = 0.50
CHARGE_KI_REGEN_BONUS = 1.00

SHEET_COLS = 57
FRAME_TREE = 531  # tileX=18, tileY=9
FRAME_BARE = 6    # tileX=6,  tileY=0 — bare ground (rock spawn tile)

# Rock spawning
ROCK_SPAWN_INTERVAL = 300.0   # seconds (5 minutes)
ROCK_SPAWN_CHANCE = 0.10      # 10% per tile per interval
ROCK_LIFESPAN = 60.0          # seconds — despawns if not mined
ROCK_HITS = 5                 # clicks to mine
ROCK_MINE_DIST = 80           # px

# Fallback tree positions if map fails to load
FALLBACK_TREE_POSITIONS = [
    (3,3),(4,5),(6,2),(8,4),(10,3),(12,5),(14,2),(16,4),
    (5,8),(7,7),(9,9),(11,8),(13,7),(15,9),
    (3,12),(6,11),(8,13),(10,12),(12,14),(14,11),(16,13),
    (4,16),(7,15),(9,17),(11,16),(13,18),(15,15),
    (18,3),(20,5),(22,2),(24,4),(18,8),(20,7),
    (22,9),(24,8),(18,12),(20,14),(22,11),(24,13),
]


def _load_map_positions():
    """Load tree and rock-spawn-tile positions from level1.json."""
    try:
        maps_dir = Path(__file__).resolve().parent.parent / "maps"
        map_path = maps_dir / "level1.json"
        if not map_path.exists():
            return FALLBACK_TREE_POSITIONS, [], 80, 50
        data = json.loads(map_path.read_text(encoding="utf-8"))
        width = data.get("width", 30)
        height = data.get("height", 30)
        trees = []
        rock_spawns = []
        for t in data.get("tiles", []):
            tile_x = t.get("tileX")
            tile_y = t.get("tileY")
            if not isinstance(tile_x, int) or not isinstance(tile_y, int):
                continue
            frame = tile_x + tile_y * SHEET_COLS
            if frame == FRAME_TREE:
                trees.append((t["x"], t["y"]))
            elif frame == FRAME_BARE:
                rock_spawns.append((t["x"], t["y"]))
        if trees:
            print(f"[game_state] Loaded {len(trees)} trees, {len(rock_spawns)} rock spawn tiles from level1.json ({width}x{height})")
            return trees, rock_spawns, width, height
    except Exception as e:
        print(f"[game_state] Failed to load map: {e}")
    return FALLBACK_TREE_POSITIONS, [], 80, 50


TREE_POSITIONS, ROCK_SPAWN_POSITIONS, MAP_COLS, MAP_ROWS = _load_map_positions()


def tile_pos(col, row):
    return (col * TILE_SIZE + TILE_SIZE / 2, row * TILE_SIZE + TILE_SIZE / 2)


def dist(x1, y1, x2, y2):
    return math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2)


_next_item_id = 0
_next_dummy_id = 0
_next_fence_id = 0
_next_ki_target_id = 0
_next_anvil_id = 0


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


def _gen_ki_target_id():
    global _next_ki_target_id
    _next_ki_target_id += 1
    return f"kt_{_next_ki_target_id}"


def _gen_anvil_id():
    global _next_anvil_id
    _next_anvil_id += 1
    return f"anvil_{_next_anvil_id}"


# Anvil constants
ANVIL_STONE_COST = 5        # stones to place an anvil
REFINE_STONE_COST = 1       # stones consumed per refine attempt
BASTALITE_CHANCE = 0.30     # 30% chance for Bastalite
CRYSTAL_PRISTINE_CHANCE = 0.05  # 5%
CRYSTAL_NORMAL_CHANCE = 0.10    # 10%
CRYSTAL_POOR_CHANCE = 0.15      # 15%
KI_SKILL_MEDITATE_UNLOCK_LEVEL = 10
MEDITATION_POOR_MS = 30000
MEDITATION_NORMAL_MS = 50000
MEDITATION_PRISTINE_MS = 70000
MEDITATION_REALM_COMPLETE_GRACE = 5.0

LEGACY_KI_MOVE_DENOMINATION_MAP = {
    "sense_ki": "utility",
    "charge": "utility",
    "barrier": "utility",
    "ki_shot": "offense",
}

KI_PROGRESSION = {
    "denominations": {
        "utility": {
            "cost": 3,
            "moves": {
                "sense_ki": {"cost": 1},
                "charge": {"cost": 1},
                "barrier": {"cost": 1},
            },
        },
        "offense": {
            "cost": 3,
            "moves": {
                "ki_shot": {"cost": 1},
            },
        },
    },
    "augments": {
        "sense_ki": {
            "sense_1": {"cost": 1, "kind": "passive"},
            "sense_2": {"cost": 2, "kind": "passive"},
            "sense_3": {"cost": 3, "kind": "passive"},
            "reveal_name": {"cost": 1, "kind": "passive"},
            "clairvoyance": {"cost": 3, "kind": "slottable"},
        },
        "barrier": {
            "ki_guard": {"cost": 2, "kind": "passive"},
        },
        "ki_shot": {
            "explosive": {"cost": 2, "kind": "slottable"},
            "echo_shot": {"cost": 3, "kind": "slottable"},
            "homing": {"cost": 2, "kind": "slottable"},
        },
    },
}
CLAIRVOYANCE_DRAIN_PER_SEC = 2.5
ECHO_SHOT_PROC_CHANCE = 0.25
EXPLOSIVE_SHOT_SPLASH_RADIUS = TILE_SIZE * 1.25
EXPLOSIVE_SHOT_SPLASH_MULT = 0.5
BARRIER_BASE_PHYSICAL_REDUCTION = 10
BARRIER_BASE_KI_REDUCTION = 10
BARRIER_UPGRADE_CAP = 30
BARRIER_PROC_KI_COST = 3
BARRIER_PROC_DURATION = 0.22

# Ki Target constants
KI_TARGET_HP = 5          # hits before it breaks
KI_TARGET_BREAK_CHANCE = 0.40  # 40% chance to break per blast hit
KI_TARGET_LOG_COST = 10
KI_TARGET_LEARN_CHANCE = 1.0 / 25.0  # 1/25 chance NPC learns per hit

# Fence HP per tier
FENCE_HP = {1: 15, 2: 30, 3: 50}
GATE_HP = 60
LOG_STACK_MAX = 3


class GameState:
    def __init__(self):
        self.players = {}       # pid -> PlayerState
        self.trees = []         # list of TreeState
        self.rocks = []         # list of RockState (dynamically spawned)
        self.ground_items = []  # list of ItemState
        self.npcs = {}          # npc_id -> dict (managed client-side for now)
        self.dummies = {}       # dummy_id -> DummyState
        self.fences = {}        # fence_id -> FenceState
        self.ki_targets = {}    # kt_id -> KiTargetState
        self.anvils = {}        # anvil_id -> AnvilState
        self.fx_events = []     # transient replicated visual effects
        self._last_save = 0     # timestamp of last DB save
        self._last_rock_spawn = time.time()  # last rock spawn check
        self._next_rock_id = 0
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
        """Load ground items, fences, dummies, ki targets, and anvils from the database."""
        global _next_item_id, _next_fence_id, _next_dummy_id, _next_ki_target_id, _next_anvil_id
        try:
            self.ground_items = load_ground_items()
            self.fences = load_fences()
            self.dummies = load_dummies()
            self.ki_targets = load_ki_targets()
            self.anvils = load_anvils()
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
            for ktid in self.ki_targets:
                n = int(ktid.split("_", 1)[1])
                if n >= _next_ki_target_id:
                    _next_ki_target_id = n
            for aid in self.anvils:
                n = int(aid.split("_", 1)[1])
                if n >= _next_anvil_id:
                    _next_anvil_id = n
            ct = len(self.ground_items) + len(self.fences) + len(self.dummies) + len(self.ki_targets) + len(self.anvils)
            if ct > 0:
                print(f"[game_state] Restored {len(self.ground_items)} ground items, "
                      f"{len(self.fences)} fences, {len(self.dummies)} dummies, "
                      f"{len(self.ki_targets)} ki targets from DB")
        except Exception as e:
            print(f"[game_state] Failed to load persisted state: {e}")

    def save_world(self):
        """Persist ground items, fences, dummies, ki targets, and anvils to the database."""
        try:
            save_ground_items(self.ground_items)
            save_fences(self.fences)
            save_dummies(self.dummies)
            save_ki_targets(self.ki_targets)
            save_anvils(self.anvils)
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
            "ki": 20, "maxKi": 20,
            "inf_ki": False,
            "blastLevel": 0,
            "kiSkillLevel": 1,
            "kiSkillXp": 0,
            "realm_tier": 0,
            "realm_insight": 0,
            "ki_moves": [],
            "ki_denominations": [],
            "ki_known_augments": {},
            "ki_equipped_augments": {},
            "ki_upgrades": {},
            "realm_crystal_t1": 0,
            "meditating": False,
            "meditation_started_at": None,
            "meditation_until": None,
            "meditation_total_ms": 0,
            "meditation_crystal_quality": None,
            "charging": False,
            "charge_power": 0.0,
            "clairvoyance_active": False,
            "clairvoyance_target_type": None,
            "clairvoyance_target_id": None,
            "clairvoyance_target_owner": None,
            "barrier_proc_until": 0.0,
            "barrier_proc_facing": "down",
            "aura_tint": 0x4fd6ff,
            "aura_alpha": 0.42,
            "str": 1, "def": 1,
            "level": 1, "xp": 0,
            "logs": 0,
            "stones": 0,
            "bastalite": 0,
            "crystal_pristine": 0,
            "crystal_normal": 0,
            "crystal_poor": 0,
            "dead": False,
            "knocked_out": False,
            "knocked_until": None,
            "carried_by": None,
            "carried_by_type": None,
            "carrying": None,
            "respawn_at": None,
            "last_hit_by_player": {},  # attacker_pid -> timestamp
            "npcs": {},  # npc_id -> { hp, maxHp, str, def, x, y, owner }
            "npc_ids": [],  # persistent list of owned NPC IDs
            "chatColor": "#cccccc",
            "_campfire_heal_accum": 0.0,
            "armor_elite": False,
            "armor_elite_inv": False,
        }
        self._normalize_ki_progression(self.players[pid])
        return self.players[pid]

    def _normalize_ki_progression(self, actor):
        if not actor:
            return
        moves = [str(move) for move in (actor.get("ki_moves", []) or []) if move]
        actor["ki_moves"] = moves
        known_denominations = []
        for denomination in actor.get("ki_denominations", []) or []:
            denom_id = str(denomination or "").strip()
            if denom_id and denom_id not in known_denominations:
                known_denominations.append(denom_id)
        for move_id in moves:
            denom_id = LEGACY_KI_MOVE_DENOMINATION_MAP.get(move_id)
            if denom_id and denom_id not in known_denominations:
                known_denominations.append(denom_id)
        actor["ki_denominations"] = known_denominations

        raw_known_augments = actor.get("ki_known_augments", {})
        if not isinstance(raw_known_augments, dict):
            raw_known_augments = {}
        normalized_known_augments = {}
        for move_id, augments in raw_known_augments.items():
            if not move_id:
                continue
            items = []
            for augment_id in augments or []:
                aug_id = str(augment_id or "").strip()
                if aug_id and aug_id not in items:
                    items.append(aug_id)
            normalized_known_augments[str(move_id)] = items
        actor["ki_known_augments"] = normalized_known_augments

        raw_equipped_augments = actor.get("ki_equipped_augments", {})
        if not isinstance(raw_equipped_augments, dict):
            raw_equipped_augments = {}
        normalized_equipped_augments = {}
        for move_id, augment_id in raw_equipped_augments.items():
            move_key = str(move_id or "").strip()
            aug_key = str(augment_id or "").strip()
            if move_key:
                normalized_equipped_augments[move_key] = aug_key or None
        actor["ki_equipped_augments"] = normalized_equipped_augments

    def _get_progress_denomination(self, denomination_id):
        return KI_PROGRESSION["denominations"].get(str(denomination_id or "").strip())

    def _get_progress_move(self, move_id):
        move_key = str(move_id or "").strip()
        for denomination in KI_PROGRESSION["denominations"].values():
            move = denomination.get("moves", {}).get(move_key)
            if move:
                return move
        return None

    def _get_progress_move_denomination(self, move_id):
        move_key = str(move_id or "").strip()
        for denomination_id, denomination in KI_PROGRESSION["denominations"].items():
            if move_key in denomination.get("moves", {}):
                return denomination_id
        return None

    def _get_progress_augment(self, move_id, augment_id):
        return KI_PROGRESSION["augments"].get(str(move_id or "").strip(), {}).get(str(augment_id or "").strip())

    def _has_known_augment(self, actor, move_id, augment_id):
        return str(augment_id or "").strip() in (actor.get("ki_known_augments", {}).get(str(move_id or "").strip(), []) or [])

    def _get_equipped_augment(self, actor, move_id):
        return actor.get("ki_equipped_augments", {}).get(str(move_id or "").strip())

    def _try_spend_realm_crystals(self, actor, amount):
        cost = max(0, int(amount or 0))
        if cost <= 0:
            return True
        current = int(actor.get("realm_crystal_t1", 0) or 0)
        if current < cost:
            return False
        actor["realm_crystal_t1"] = current - cost
        return True

    def _unlock_ki_progression(self, actor, kind, denomination_id=None, move_id=None, augment_id=None):
        self._normalize_ki_progression(actor)
        kind = str(kind or "").strip()
        if kind == "denomination":
            denom_id = str(denomination_id or "").strip()
            denomination = self._get_progress_denomination(denom_id)
            if not denomination or denom_id in actor["ki_denominations"]:
                return False
            if not self._try_spend_realm_crystals(actor, denomination.get("cost", 0)):
                return False
            actor["ki_denominations"].append(denom_id)
            return True
        if kind == "move":
            move_key = str(move_id or "").strip()
            denomination_key = self._get_progress_move_denomination(move_key)
            move = self._get_progress_move(move_key)
            if not move or not denomination_key or denomination_key not in actor.get("ki_denominations", []):
                return False
            if move_key in (actor.get("ki_moves", []) or []):
                return False
            if not self._try_spend_realm_crystals(actor, move.get("cost", 0)):
                return False
            actor["ki_moves"] = list(actor.get("ki_moves", []) or []) + [move_key]
            self._normalize_ki_progression(actor)
            return True
        if kind == "augment":
            move_key = str(move_id or "").strip()
            augment_key = str(augment_id or "").strip()
            augment = self._get_progress_augment(move_key, augment_key)
            if not augment or move_key not in (actor.get("ki_moves", []) or []):
                return False
            known = actor.get("ki_known_augments", {}).setdefault(move_key, [])
            if augment_key in known:
                return False
            if not self._try_spend_realm_crystals(actor, augment.get("cost", 0)):
                return False
            known.append(augment_key)
            self._normalize_ki_progression(actor)
            return True
        return False

    def _equip_ki_progression(self, actor, move_id, augment_id):
        self._normalize_ki_progression(actor)
        move_key = str(move_id or "").strip()
        augment_key = str(augment_id or "").strip()
        if not move_key:
            return False
        if not augment_key:
            actor.get("ki_equipped_augments", {}).pop(move_key, None)
            if move_key == "sense_ki":
                self._clear_clairvoyance(actor)
            return True
        augment = self._get_progress_augment(move_key, augment_key)
        if not augment or augment.get("kind") != "slottable":
            return False
        if not self._has_known_augment(actor, move_key, augment_key):
            return False
        actor.setdefault("ki_equipped_augments", {})[move_key] = augment_key
        return True

    def _clear_clairvoyance(self, actor):
        if not actor:
            return
        actor["clairvoyance_active"] = False
        actor["clairvoyance_target_type"] = None
        actor["clairvoyance_target_id"] = None
        actor["clairvoyance_target_owner"] = None

    def _toggle_clairvoyance(self, pid, target_type, target_owner, target_id):
        actor = self.players.get(pid)
        if not actor:
            return
        if actor.get("clairvoyance_active"):
            self._clear_clairvoyance(actor)
            return
        if self._get_equipped_augment(actor, "sense_ki") != "clairvoyance":
            return
        if "sense_ki" not in (actor.get("ki_moves", []) or []):
            return
        target_type = str(target_type or "").strip()
        target_id = str(target_id or "").strip()
        target_owner = str(target_owner or "").strip() or None
        if target_type not in ("player", "npc") or not target_id:
            return
        actor["clairvoyance_active"] = True
        actor["clairvoyance_target_type"] = target_type
        actor["clairvoyance_target_id"] = target_id
        actor["clairvoyance_target_owner"] = target_owner

    def remove_player(self, pid: str):
        self.players.pop(pid, None)

    def handle_input(self, pid: str, data: dict):
        """Process input from a client."""
        p = self.players.get(pid)
        if not p:
            return

        msg_type = data.get("type")

        # Block most actions while dead or knocked out.
        if (p.get("dead") or p.get("knocked_out") or p.get("meditating")) and msg_type not in ("sync_npcs", "admin", "complete_meditation_realm", "pause_meditation_timer"):
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

        elif msg_type == "mine_rock":
            rock_id = data.get("rock_id")
            self._try_mine_rock(pid, rock_id)

        elif msg_type == "attack_dummy":
            dummy_id = data.get("dummy_id")
            self._try_attack_dummy(pid, dummy_id)

        elif msg_type == "build_dummy":
            self._try_build_dummy(pid, data.get("logs", 10))

        elif msg_type == "delete_dummy":
            dummy_id = data.get("dummy_id")
            if dummy_id and dummy_id in self.dummies:
                self.dummies[dummy_id]["dead"] = True

        elif msg_type == "delete_ki_target":
            target_id = data.get("target_id")
            if target_id and target_id in self.ki_targets:
                self.ki_targets[target_id]["dead"] = True

        elif msg_type == "build_anvil":
            self._try_build_anvil(pid)

        elif msg_type == "delete_anvil":
            anvil_id = data.get("anvil_id")
            if anvil_id and anvil_id in self.anvils:
                self.anvils[anvil_id]["dead"] = True
        elif msg_type == "build_ki_shrine":
            self._build_ki_shrine(pid)
        elif msg_type == "use_ki_shrine":
            self._use_ki_shrine(pid, data.get("item_id"), data.get("npc_id"))

        elif msg_type == "refine_rock":
            anvil_id = data.get("anvil_id")
            npc_id = data.get("npc_id")
            self._try_refine_rock(pid, anvil_id, npc_id)

        elif msg_type == "punch":
            p["punching"] = True
            p["punch_until"] = time.time() + 0.3

        elif msg_type == "npc_chop":
            tree_id = data.get("tree_id")
            owner_id = data.get("owner_id", pid)
            self._npc_chop(tree_id, owner_id)

        elif msg_type == "npc_pickup_stone":
            item_id = data.get("item_id")
            npc_id = data.get("npc_id")
            self._npc_pickup_stone(pid, npc_id, item_id)
        elif msg_type == "npc_pickup_stone_tile":
            npc_id = data.get("npc_id")
            self._npc_pickup_stone_tile(pid, npc_id, data.get("x"), data.get("y"))

        elif msg_type == "npc_refine_rock":
            anvil_id = data.get("anvil_id")
            npc_id = data.get("npc_id")
            self._npc_refine_rock(pid, npc_id, anvil_id)

        elif msg_type == "npc_give_materials":
            npc_id = data.get("npc_id")
            self._npc_give_materials(pid, npc_id)

        elif msg_type == "admin":
            self._handle_admin(p, data)

        elif msg_type == "npc_attack_dummy":
            dummy_id = data.get("dummy_id")
            npc_str = data.get("str", 1)
            npc_id = data.get("npc_id", "npc")
            self._npc_attack_dummy(pid, npc_id, dummy_id, npc_str)

        elif msg_type == "attack_player":
            target_pid = data.get("target_id")
            self._try_attack_player(pid, target_pid)

        elif msg_type == "attack_npc":
            target_owner = data.get("owner_id")
            target_npc_id = data.get("npc_id")
            self._try_attack_npc(pid, target_owner, target_npc_id)

        elif msg_type == "ki_blast_miss":
            # Fired with no target — still costs ki
            cost, _dmg = self._calc_blast(p.get("blastLevel", 0))
            if self._try_ki_spend(p, cost):
                self._queue_ki_blast_fx(p)
        elif msg_type == "start_meditation":
            self._start_meditation(pid, None, data.get("crystal_quality"))
        elif msg_type == "npc_meditate":
            self._start_meditation(pid, data.get("npc_id"), data.get("crystal_quality"))
        elif msg_type == "complete_meditation_realm":
            self._complete_meditation_realm(
                pid,
                data.get("npc_id"),
                data.get("tier"),
                data.get("realm_crystal_t1", 0),
                data.get("request_move_roll", False),
            )
        elif msg_type == "pause_meditation_timer":
            self._pause_meditation_timer(pid, data.get("npc_id"))
        elif msg_type == "ki_progress_unlock":
            self._unlock_ki_progression(
                p,
                data.get("kind"),
                data.get("denomination_id"),
                data.get("move_id"),
                data.get("augment_id"),
            )
        elif msg_type == "ki_progress_equip":
            self._equip_ki_progression(
                p,
                data.get("move_id"),
                data.get("augment_id"),
            )
        elif msg_type == "toggle_clairvoyance":
            self._toggle_clairvoyance(
                pid,
                data.get("target_type"),
                data.get("target_owner"),
                data.get("target_id"),
            )

        elif msg_type == "ki_blast_player":
            target_pid = data.get("target_id")
            self._ki_blast_player(pid, target_pid)

        elif msg_type == "ki_blast_npc":
            target_owner = data.get("owner_id")
            target_npc_id = data.get("npc_id")
            self._ki_blast_npc(pid, target_owner, target_npc_id)
        elif msg_type == "ki_blast_dummy":
            dummy_id = data.get("dummy_id")
            self._ki_blast_dummy(pid, dummy_id)

        elif msg_type == "npc_ki_blast_player":
            npc_id = data.get("npc_id")
            target_pid = data.get("target_id")
            self._npc_ki_blast_player(pid, npc_id, target_pid)

        elif msg_type == "npc_ki_blast_npc":
            npc_id = data.get("npc_id")
            target_owner = data.get("owner_id")
            target_npc_id = data.get("target_npc_id")
            self._npc_ki_blast_npc(pid, npc_id, target_owner, target_npc_id)

        elif msg_type == "npc_ki_blast_ki_target":
            npc_id = data.get("npc_id")
            target_id = data.get("target_id")
            self._npc_ki_blast_ki_target(pid, npc_id, target_id)

        elif msg_type == "finish_player":
            self._finish_player(pid, data.get("target_id"))

        elif msg_type == "finish_npc":
            self._finish_npc(pid, data.get("owner_id"), data.get("npc_id"))

        elif msg_type == "rob_player":
            self._rob_player(pid, data.get("target_id"))

        elif msg_type == "rob_npc":
            self._rob_npc(pid, data.get("owner_id"), data.get("npc_id"))

        elif msg_type == "carry_player":
            self._carry_player(pid, data.get("target_id"))

        elif msg_type == "carry_npc":
            self._carry_npc(pid, data.get("owner_id"), data.get("npc_id"))

        elif msg_type == "drop_carried":
            self._drop_carried(pid)

        elif msg_type == "npc_carry_player":
            self._npc_carry_player(pid, data.get("npc_id"), data.get("target_id"))

        elif msg_type == "npc_carry_npc":
            self._npc_carry_npc(pid, data.get("npc_id"), data.get("owner_id"), data.get("target_npc_id"))

        elif msg_type == "npc_drop_carried":
            self._npc_drop_carried(pid, data.get("npc_id"))

        elif msg_type == "npc_rob_player":
            self._npc_rob_player(pid, data.get("npc_id"), data.get("target_id"))

        elif msg_type == "npc_rob_npc":
            self._npc_rob_npc(pid, data.get("npc_id"), data.get("owner_id"), data.get("target_npc_id"))

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
        elif msg_type == "spawn_armor_elite":
            # Give armor directly to the player (equip it)
            if not p.get("armor_elite") and not p.get("armor_elite_inv"):
                p["armor_elite"] = True
            elif p.get("armor_elite_inv") and not p.get("armor_elite"):
                p["armor_elite"] = True
                p["armor_elite_inv"] = False

        elif msg_type == "reset_blast_level":
            p["blastLevel"] = 0

        elif msg_type == "build_ki_target":
            self._try_build_ki_target(pid, data.get("x"), data.get("y"))

        elif msg_type == "ki_blast_ki_target":
            target_id = data.get("target_id")
            npc_id = data.get("npc_id")  # which NPC is watching (for learning)
            self._ki_blast_ki_target(pid, target_id, npc_id)
        elif msg_type == "toggle_charge":
            if "charge" in (p.get("ki_moves", []) or []):
                if p.get("charging"):
                    p["charging"] = False
                elif p.get("ki", 0) > 0:
                    p["charging"] = True

        elif msg_type == "unequip_armor":
            if p.get("armor_elite"):
                p["armor_elite"] = False
                # Put it back as inventory item (just unequip, keep in inv)
                p["armor_elite_inv"] = True

        elif msg_type == "equip_armor":
            if p.get("armor_elite_inv") and not p.get("armor_elite"):
                p["armor_elite_inv"] = False
                p["armor_elite"] = True

        elif msg_type == "drop_armor":
            # Drop the armor one tile ahead in facing direction so player doesn't re-grab it
            had = p.get("armor_elite") or p.get("armor_elite_inv")
            if had:
                p["armor_elite"] = False
                p["armor_elite_inv"] = False
                facing = p.get("facing", "down")
                col = int(p["x"] // TILE_SIZE)
                row = int(p["y"] // TILE_SIZE)
                if facing == "left": col -= 1
                elif facing == "right": col += 1
                elif facing == "up": row -= 1
                else: row += 1
                tx, ty = tile_pos(col, row)
                item_id = _gen_item_id()
                now = time.time()
                self.ground_items.append({
                    "id": item_id,
                    "x": tx, "y": ty,
                    "resource": "ArmorElite",
                    "amount": 1,
                    "_drop_immunity": now + 1.5,  # can't be auto-picked by dropper for 1.5s
                })

        elif msg_type == "build_fence":
            self._try_build_fence(pid, data)

        elif msg_type == "build_gate":
            self._try_build_gate(pid, data)
        elif msg_type == "light_campfire":
            self._try_light_campfire(pid, data)

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
        target_npc_id = data.get("target_npc_id")
        actor = p.get("npcs", {}).get(target_npc_id) if target_npc_id else p
        if actor is None:
            actor = p
        if field == "logs":
            actor["logs"] = actor.get("logs", 0) + int(value)
        elif field == "stones":
            actor["stones"] = actor.get("stones", 0) + int(value)
        elif field == "realm_crystal_t1":
            actor["realm_crystal_t1"] = max(0, int(actor.get("realm_crystal_t1", 0) or 0) + int(value))
        elif field == "full_hp":
            actor["hp"] = actor.get("maxHp", actor.get("hp", 1))
        elif field == "maxHp":
            actor["maxHp"] = actor.get("maxHp", 20) + int(value)
            actor["hp"] = actor["maxHp"]
        elif field == "str":
            actor["str"] = actor.get("str", 1) + int(value)
        elif field == "def":
            actor["def"] = actor.get("def", 1) + int(value)
        elif field == "full_ki":
            actor["ki"] = actor.get("maxKi", KI_MAX_BASE)
        elif field == "inf_ki":
            actor["inf_ki"] = not bool(actor.get("inf_ki", False))
            if actor["inf_ki"]:
                actor["ki"] = actor.get("maxKi", KI_MAX_BASE)
        elif field == "maxKi":
            actor["maxKi"] = actor.get("maxKi", KI_MAX_BASE) + int(value)
            actor["ki"] = actor["maxKi"]
        elif field == "ki_skill_level":
            actor["kiSkillLevel"] = max(1, int(actor.get("kiSkillLevel", 1)) + int(value))
            max_xp = max(0, actor["kiSkillLevel"] * 20 - 1)
            actor["kiSkillXp"] = min(int(actor.get("kiSkillXp", 0)), max_xp)
            actor["realm_tier"] = self._realm_tier_for_level(actor.get("kiSkillLevel", 1))
        elif field == "ki_move_toggle":
            move_id = str(data.get("move_id") or "").strip()
            if move_id:
                moves = list(actor.get("ki_moves", []) or [])
                if move_id in moves:
                    moves = [m for m in moves if m != move_id]
                else:
                    moves.append(move_id)
                actor["ki_moves"] = moves
                self._normalize_ki_progression(actor)
        elif field == "ki_upgrade_adjust":
            move_id = str(data.get("move_id") or "").strip()
            stat_id = str(data.get("stat_id") or "").strip()
            delta = int(data.get("delta", value or 0) or 0)
            if move_id and stat_id and delta:
                upgrades = self._get_upgrade_map(actor)
                move_data = upgrades.get(move_id)
                if not isinstance(move_data, dict):
                    move_data = {}
                    upgrades[move_id] = move_data
                next_value = max(0, int(move_data.get(stat_id, 0) or 0) + delta)
                if move_id == "barrier" and stat_id in ("physical_block", "ki_block"):
                    next_value = min(BARRIER_UPGRADE_CAP, next_value)
                move_data[stat_id] = next_value
        elif field == "aura_tint":
            raw = data.get("value", value)
            if isinstance(raw, str):
                raw = raw.strip()
                if raw.startswith("#"):
                    raw = raw[1:]
                try:
                    actor["aura_tint"] = int(raw, 16)
                except ValueError:
                    pass
            else:
                try:
                    actor["aura_tint"] = int(raw)
                except (TypeError, ValueError):
                    pass
        elif field == "aura_alpha":
            try:
                actor["aura_alpha"] = max(0.0, min(1.0, float(data.get("value", value))))
            except (TypeError, ValueError):
                pass

    def _clear_meditation_state(self, actor):
        if not actor:
            return
        actor["meditating"] = False
        actor["meditation_started_at"] = None
        actor["meditation_until"] = None
        actor["meditation_total_ms"] = 0
        actor["meditation_crystal_quality"] = None

    def _roll_tier1_move_unlock(self, actor, quality):
        tier_one_moves = ["ki_shot", "charge", "sense_ki"]
        known = list(actor.get("ki_moves", []) or [])
        options = [move for move in tier_one_moves if move not in known]
        if not options:
            return None
        chance = 0.7 if quality == "pristine" else 0.5 if quality == "normal" else 0.35
        if random.random() > chance:
            return None
        learned = random.choice(options)
        actor["ki_moves"] = known + [learned]
        self._normalize_ki_progression(actor)
        return learned

    def _get_upgrade_map(self, actor):
        upgrades = actor.get("ki_upgrades")
        if not isinstance(upgrades, dict):
            upgrades = {}
            actor["ki_upgrades"] = upgrades
        return upgrades

    def _get_upgrade_value(self, actor, move_id, stat_id):
        upgrades = self._get_upgrade_map(actor)
        move_data = upgrades.get(move_id)
        if not isinstance(move_data, dict):
            return 0
        return max(0, int(move_data.get(stat_id, 0) or 0))

    def _get_blast_range(self, actor):
        pct = self._get_upgrade_value(actor, "ki_shot", "range") * 0.01
        return KI_BLAST_RANGE * (1.0 + pct)

    def _get_blast_cooldown(self, actor):
        pct = self._get_upgrade_value(actor, "ki_shot", "cooldown") * 0.01
        return max(0.15, KI_BLAST_COOLDOWN * (1.0 - pct))

    def _get_charge_stats(self, actor):
        return {
            "ceiling_pct": self._get_upgrade_value(actor, "charge", "ceiling"),
            "decay_pct": self._get_upgrade_value(actor, "charge", "decay"),
            "speed_pct": self._get_upgrade_value(actor, "charge", "speed"),
        }

    def _clear_charge_state(self, actor):
        if actor:
            actor["charging"] = False
            actor["charge_power"] = 0.0

    def _get_charge_power(self, actor):
        return max(0.0, min(1.0, float(actor.get("charge_power", 0.0) or 0.0)))

    def _get_charge_multiplier(self, actor, full_bonus):
        return 1.0 + self._get_charge_power(actor) * max(0.0, float(full_bonus or 0.0))

    def _get_effective_str(self, actor):
        base = max(1, int(actor.get("str", 1) or 1))
        return max(1, round(base * self._get_charge_multiplier(actor, CHARGE_STR_BONUS)))

    def _get_effective_def(self, actor):
        base = max(1, int(actor.get("def", 1) or 1))
        return max(1, round(base * self._get_charge_multiplier(actor, CHARGE_DEF_BONUS)))

    def _get_sense_stats(self, actor):
        known_augments = set(actor.get("ki_known_augments", {}).get("sense_ki", []) or [])
        range_level = sum(1 for augment_id in ("sense_1", "sense_2", "sense_3") if augment_id in known_augments)
        legacy_range = self._get_upgrade_value(actor, "sense_ki", "range")
        if range_level <= 0 and legacy_range > 0:
            range_level = min(3, legacy_range)
        return {
            "range_level": range_level,
            "base_range_tiles": [8, 16, 24, 32][range_level] if 0 <= range_level <= 3 else 8,
            "range_pct": self._get_upgrade_value(actor, "sense_ki", "range_pct"),
            "level_delta_bonus": self._get_upgrade_value(actor, "sense_ki", "level_delta"),
        }

    def _apply_t1_shrine_upgrade(self, actor):
        unlocked = [move for move in ("ki_shot", "charge", "sense_ki", "barrier") if move in (actor.get("ki_moves", []) or [])]
        if not unlocked:
            return {"success": False, "reason": "No Tier 1 moves unlocked."}
        if random.random() >= 0.5:
            return {"success": False, "reason": "The shrine stayed silent."}
        move_id = random.choice(unlocked)
        stat_options = {
            "ki_shot": ["range", "cooldown", "speed", "damage"],
            "charge": ["ceiling", "decay", "speed"],
            "sense_ki": ["range_pct", "level_delta"],
            "barrier": ["physical_block"],
        }
        if self._has_known_augment(actor, "barrier", "ki_guard"):
            stat_options["barrier"] = ["physical_block", "ki_block"]
        stat_id = random.choice(stat_options[move_id])
        upgrades = self._get_upgrade_map(actor)
        move_data = upgrades.get(move_id)
        if not isinstance(move_data, dict):
            move_data = {}
            upgrades[move_id] = move_data
        next_value = max(0, int(move_data.get(stat_id, 0) or 0)) + 1
        if move_id == "barrier" and stat_id in ("physical_block", "ki_block"):
            next_value = min(BARRIER_UPGRADE_CAP, next_value)
        move_data[stat_id] = next_value
        return {"success": True, "move": move_id, "stat": stat_id, "value": move_data[stat_id]}

    def _complete_meditation_realm(self, pid, npc_id, tier, realm_crystal_t1, request_move_roll):
        owner = self.players.get(pid)
        if not owner:
            return
        actor = owner.get("npcs", {}).get(npc_id) if npc_id else owner
        if not actor:
            return
        result_who = actor.get("id") if npc_id else owner["id"]
        prior_result = owner.get("_meditation_result")
        recent_matching_result = (
            isinstance(prior_result, dict)
            and prior_result.get("who") == result_who
            and (time.time() - float(prior_result.get("ts", 0) or 0)) <= MEDITATION_REALM_COMPLETE_GRACE
        )
        if not actor.get("meditating") and not recent_matching_result:
            return
        quality = actor.get("meditation_crystal_quality") or "poor"
        insight_gain = 3 if quality == "pristine" else 2 if quality == "normal" else 1
        crystals_found = max(0, min(999, int(realm_crystal_t1 or 0)))
        learned_move = None
        if int(tier or 0) == 1 and int(actor.get("realm_tier", 0) or 0) >= 1 and request_move_roll:
            learned_move = self._roll_tier1_move_unlock(actor, quality)
        actor["realm_crystal_t1"] = int(actor.get("realm_crystal_t1", 0) or 0) + crystals_found
        if actor.get("meditating"):
            actor["realm_tier"] = self._realm_tier_for_level(actor.get("kiSkillLevel", 1))
            actor["realm_insight"] = int(actor.get("realm_insight", 0) or 0) + insight_gain
            self._clear_meditation_state(actor)
        elif recent_matching_result:
            insight_gain = 0
        owner["_meditation_result"] = {
            "who": result_who,
            "quality": quality,
            "realm_tier": actor.get("realm_tier", 0),
            "insight_gain": insight_gain,
            "insight_total": actor.get("realm_insight", 0),
            "realm_crystal_t1": crystals_found + int(prior_result.get("realm_crystal_t1", 0) or 0) if recent_matching_result else crystals_found,
            "learned_move": learned_move or (prior_result.get("learned_move") if recent_matching_result else None),
            "ts": time.time(),
        }

    def _pause_meditation_timer(self, pid, npc_id):
        owner = self.players.get(pid)
        if not owner:
            return
        actor = owner.get("npcs", {}).get(npc_id) if npc_id else owner
        if not actor or not actor.get("meditating"):
            return
        actor["meditation_until"] = None

    def _grant_xp(self, entity, amount):
        xp = max(0, int(amount or 0))
        if xp <= 0 or not entity:
            return False
        entity["xp"] = int(entity.get("xp", 0)) + xp
        leveled = False
        while entity["xp"] >= max(1, int(entity.get("level", 1))) * 20:
            needed = max(1, int(entity.get("level", 1))) * 20
            entity["xp"] -= needed
            entity["level"] = int(entity.get("level", 1)) + 1
            entity["maxHp"] = int(entity.get("maxHp", 1)) + 2
            entity["hp"] = entity["maxHp"]
            entity["str"] = int(entity.get("str", 1)) + 1
            entity["def"] = int(entity.get("def", 1)) + 1
            leveled = True
        if leveled:
            self._ensure_level_based_ki(entity, refill=True)
        return leveled

    def _level_based_max_ki(self, level):
        lvl = max(1, int(level or 1))
        return KI_MAX_BASE + max(0, lvl - 1) * KI_MAX_PER_LEVEL

    def _ensure_level_based_ki(self, entity, refill=False):
        if not entity:
            return
        current_max = int(entity.get("maxKi", KI_MAX_BASE))
        target_max = max(current_max, self._level_based_max_ki(entity.get("level", 1)))
        current_ki = int(entity.get("ki", target_max))
        if target_max > current_max:
            entity["maxKi"] = target_max
            entity["ki"] = target_max if refill else min(target_max, current_ki + (target_max - current_max))
            return
        entity["ki"] = min(current_ki, current_max)

    def _grant_ki_skill_xp(self, entity, amount):
        xp = max(0, int(amount or 0))
        if xp <= 0 or not entity:
            return False
        entity["kiSkillXp"] = int(entity.get("kiSkillXp", 0)) + xp
        entity["kiSkillLevel"] = max(1, int(entity.get("kiSkillLevel", 1)))
        leveled = False
        while entity["kiSkillXp"] >= max(1, int(entity.get("kiSkillLevel", 1))) * 20:
            needed = max(1, int(entity.get("kiSkillLevel", 1))) * 20
            entity["kiSkillXp"] -= needed
            entity["kiSkillLevel"] = int(entity.get("kiSkillLevel", 1)) + 1
            leveled = True
        entity["realm_tier"] = self._realm_tier_for_level(entity.get("kiSkillLevel", 1))
        return leveled

    def _realm_tier_for_level(self, ki_skill_level):
        lvl = max(1, int(ki_skill_level or 1))
        if lvl >= 70:
            return 5
        if lvl >= 50:
            return 4
        if lvl >= 35:
            return 3
        if lvl >= 20:
            return 2
        if lvl >= KI_SKILL_MEDITATE_UNLOCK_LEVEL:
            return 1
        return 0

    def _meditation_duration_ms(self, crystal_quality):
        quality = (crystal_quality or "").lower()
        if quality == "pristine":
            return MEDITATION_PRISTINE_MS
        if quality == "normal":
            return MEDITATION_NORMAL_MS
        if quality == "poor":
            return MEDITATION_POOR_MS
        return 0

    def _start_meditation(self, pid, npc_id, crystal_quality):
        owner = self.players.get(pid)
        if not owner:
            return
        actor = owner.get("npcs", {}).get(npc_id) if npc_id else owner
        if not actor or actor.get("dead") or actor.get("knocked_out") or actor.get("meditating"):
            return
        if int(actor.get("kiSkillLevel", 1)) < KI_SKILL_MEDITATE_UNLOCK_LEVEL:
            return

        quality = (crystal_quality or "").lower()
        if quality not in ("poor", "normal", "pristine"):
            for fallback in ("pristine", "normal", "poor"):
                if actor.get(f"crystal_{fallback}", 0) > 0:
                    quality = fallback
                    break
        if quality not in ("poor", "normal", "pristine"):
            return
        if actor.get(f"crystal_{quality}", 0) <= 0:
            return

        duration_ms = self._meditation_duration_ms(quality)
        if duration_ms <= 0:
            return

        actor[f"crystal_{quality}"] = max(0, actor.get(f"crystal_{quality}", 0) - 1)
        now = time.time()
        actor["charging"] = False
        actor["meditating"] = True
        actor["meditation_started_at"] = now
        actor["meditation_until"] = now + (duration_ms / 1000.0)
        actor["meditation_total_ms"] = duration_ms
        actor["meditation_crystal_quality"] = quality
        actor["realm_tier"] = self._realm_tier_for_level(actor.get("kiSkillLevel", 1))
        actor["vx"] = 0
        actor["vy"] = 0

    def _npc_attack_dummy(self, owner_pid, npc_id, dummy_id, npc_str):
        if not dummy_id:
            return
        owner = self.players.get(owner_pid)
        npc_state = owner.get("npcs", {}).get(npc_id) if owner else None
        if not npc_state or npc_state.get("dead") or npc_state.get("knocked_out"):
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
        self._grant_xp(npc_state, 5)
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
        if attacker.get("dead") or attacker.get("knocked_out") or target.get("dead") or target.get("knocked_out"):
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
        s = self._get_effective_str(attacker)
        d_def = self._get_effective_def(target)
        dmg = max(1, s + random.randint(0, max(1, s // 2)) - d_def // 2)
        dmg = self._apply_barrier_reduction(target, "physical", dmg)
        target["hp"] = max(0, target["hp"] - dmg)

        # Punch anim
        attacker["punching"] = True
        attacker["punch_until"] = now + 0.3

        # XP for hitting a player
        self._grant_xp(attacker, 8)

        if target["hp"] <= 0:
            self._knock_out_player(target)

    def _try_attack_npc(self, attacker_pid, target_owner_pid, target_npc_id):
        """Player attacks another player's NPC."""
        attacker = self.players.get(attacker_pid)
        owner = self.players.get(target_owner_pid)
        if not attacker or not owner:
            return
        if attacker.get("dead") or attacker.get("knocked_out"):
            return

        npc_state = owner.get("npcs", {}).get(target_npc_id)
        if not npc_state or npc_state.get("dead") or npc_state.get("knocked_out"):
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

        s = self._get_effective_str(attacker)
        npc_def = self._get_effective_def(npc_state)
        dmg = max(1, s + random.randint(0, max(1, s // 2)) - npc_def // 2)
        dmg = self._apply_barrier_reduction(npc_state, "physical", dmg)
        npc_state["hp"] = max(0, npc_state["hp"] - dmg)
        npc_state["_last_attacked_by"] = {"type": "player", "id": attacker_pid}

        attacker["punching"] = True
        attacker["punch_until"] = now + 0.3

        # XP
        self._grant_xp(attacker, 5)

        if npc_state["hp"] <= 0:
            self._knock_out_npc(npc_state)

    def _npc_attack_player(self, owner_pid, target_pid, npc_str, npc_id):
        """An NPC (owned by owner_pid) attacks a player."""
        if owner_pid == target_pid:
            return  # NPCs don't attack their own owner
        owner = self.players.get(owner_pid)
        npc_state = owner.get("npcs", {}).get(npc_id) if owner else None
        if not npc_state or npc_state.get("dead") or npc_state.get("knocked_out"):
            return
        target = self.players.get(target_pid)
        if not target or target.get("dead") or target.get("knocked_out"):
            return

        # Cooldown
        now = time.time()
        cooldown_key = f"npc_{npc_id}"
        last = target.get("last_hit_by_player", {}).get(cooldown_key, 0)
        if now - last < PVP_COOLDOWN:
            return
        target.setdefault("last_hit_by_player", {})[cooldown_key] = now

        d_def = self._get_effective_def(target)
        dmg = max(1, npc_str + random.randint(0, max(1, npc_str // 2)) - d_def // 2)
        dmg = self._apply_barrier_reduction(target, "physical", dmg)
        target["hp"] = max(0, target["hp"] - dmg)
        self._grant_xp(npc_state, 8)

        if target["hp"] <= 0:
            # Credit kill XP to the NPC's owner
            if owner:
                self._grant_xp(owner, PVP_XP_KILL)
            self._knock_out_player(target)

    def _npc_attack_npc(self, owner_pid, attacker_npc_id, target_owner_pid, target_npc_id, npc_str):
        """An NPC attacks another player's NPC."""
        if owner_pid == target_owner_pid:
            return  # Don't attack own NPCs
        owner = self.players.get(owner_pid)
        attacker_npc = owner.get("npcs", {}).get(attacker_npc_id) if owner else None
        if not attacker_npc or attacker_npc.get("dead") or attacker_npc.get("knocked_out"):
            return
        target_owner = self.players.get(target_owner_pid)
        if not target_owner:
            return
        npc_state = target_owner.get("npcs", {}).get(target_npc_id)
        if not npc_state or npc_state.get("dead") or npc_state.get("knocked_out"):
            return

        now = time.time()
        cooldown_key = f"npc_{attacker_npc_id}_vs_{target_npc_id}"
        last = npc_state.get("last_hit", {}).get(cooldown_key, 0)
        if now - last < PVP_COOLDOWN:
            return
        npc_state.setdefault("last_hit", {})[cooldown_key] = now

        npc_def = self._get_effective_def(npc_state)
        dmg = max(1, npc_str + random.randint(0, max(1, npc_str // 2)) - npc_def // 2)
        dmg = self._apply_barrier_reduction(npc_state, "physical", dmg)
        npc_state["hp"] = max(0, npc_state["hp"] - dmg)
        npc_state["_last_attacked_by"] = {"type": "npc", "id": attacker_npc_id, "owner": owner_pid}
        self._grant_xp(attacker_npc, 5)

        if npc_state["hp"] <= 0:
            self._knock_out_npc(npc_state)

    def _npc_steal_logs(self, owner_pid, attacker_npc_id, target_owner_pid, target_npc_id, npc_str, steal_amount):
        """An NPC smacks another player's NPC and steals logs from it."""
        if owner_pid == target_owner_pid:
            return  # Don't steal from own NPCs
        target_owner = self.players.get(target_owner_pid)
        if not target_owner:
            return
        npc_state = target_owner.get("npcs", {}).get(target_npc_id)
        if not npc_state or npc_state.get("dead") or npc_state.get("knocked_out"):
            return

        # Cooldown — use same mechanism as npc_attack_npc
        now = time.time()
        cooldown_key = f"steal_{attacker_npc_id}_vs_{target_npc_id}"
        last = npc_state.get("last_hit", {}).get(cooldown_key, 0)
        if now - last < PVP_COOLDOWN * 2:  # longer cooldown for stealing
            return
        npc_state.setdefault("last_hit", {})[cooldown_key] = now

        # Light smack damage (half of normal attack)
        npc_def = self._get_effective_def(npc_state)
        dmg = max(1, (npc_str + random.randint(0, max(1, npc_str // 2))) // 2 - npc_def // 2)
        dmg = self._apply_barrier_reduction(npc_state, "physical", dmg)
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
            self._knock_out_npc(npc_state)

    # ── Ki Blast Combat ────────────────────────────────────────────────────────

    def _calc_blast(self, blast_level):
        """Return (cost, dmg) for a given blast level. 2% compound improvement per level."""
        cost = max(1, round(KI_BLAST_BASE_COST * (1 - KI_BLAST_SCALE) ** blast_level))
        dmg = max(1, round(KI_BLAST_BASE_DMG * (1 + KI_BLAST_SCALE) ** blast_level))
        return cost, dmg

    def _calc_blast_for_actor(self, actor):
        cost, dmg = self._calc_blast(actor.get("blastLevel", 0))
        dmg_bonus = self._get_upgrade_value(actor, "ki_shot", "damage") * 0.01
        charge_mult = self._get_charge_multiplier(actor, CHARGE_KI_ATTACK_BONUS)
        return cost, max(1, round(dmg * (1.0 + dmg_bonus) * charge_mult))

    def _calc_ki_damage_taken(self, raw_dmg, target):
        base_dmg = max(1, int(raw_dmg or 0))
        effective_def = self._get_effective_def(target)
        after_def = max(1, base_dmg - max(0, effective_def) // KI_DEF_REDUCTION_DIVISOR)
        ki_skill_level = max(1, int(target.get("kiSkillLevel", 1) or 1))
        resist_pct = min(KI_SKILL_RESIST_CAP, max(0.0, (ki_skill_level - 1) * KI_SKILL_RESIST_PER_LEVEL))
        return max(1, round(after_def * (1.0 - resist_pct)))

    def _get_barrier_stats(self, actor):
        physical_bonus = min(BARRIER_UPGRADE_CAP, self._get_upgrade_value(actor, "barrier", "physical_block"))
        ki_bonus = min(BARRIER_UPGRADE_CAP, self._get_upgrade_value(actor, "barrier", "ki_block"))
        has_barrier = "barrier" in (actor.get("ki_moves", []) or [])
        has_ki_guard = self._has_known_augment(actor, "barrier", "ki_guard")
        return {
            "has_barrier": has_barrier,
            "has_ki_guard": has_ki_guard,
            "physical_pct": BARRIER_BASE_PHYSICAL_REDUCTION + physical_bonus if has_barrier else 0,
            "ki_pct": (BARRIER_BASE_KI_REDUCTION + ki_bonus) if has_barrier and has_ki_guard else 0,
        }

    def _try_spend_plain_ki(self, actor, amount):
        cost = max(0, int(amount or 0))
        if cost <= 0:
            return True
        if actor.get("inf_ki"):
            actor["ki"] = actor.get("maxKi", KI_MAX_BASE)
            return True
        ki = int(actor.get("ki", 0) or 0)
        if ki < cost:
            return False
        actor["ki"] = ki - cost
        return True

    def _compute_blast_visual_impact(self, actor, target=None):
        start_x = float(actor.get("x", 0))
        start_y = float(actor.get("y", 0)) - TILE_SIZE * 0.4
        facing = actor.get("facing", "down")
        dir_map = {
            "down": (0.0, 1.0),
            "up": (0.0, -1.0),
            "left": (-1.0, 0.0),
            "right": (1.0, 0.0),
        }
        dx, dy = dir_map.get(facing, dir_map["down"])
        explosive = self._get_equipped_augment(actor, "ki_shot") == "explosive"
        if target:
            end_x = float(target.get("x", start_x))
            end_y = float(target.get("y", start_y)) - TILE_SIZE * 0.4
        else:
            blast_range = self._get_blast_range(actor)
            end_x = start_x + dx * blast_range
            end_y = start_y + dy * blast_range
            if explosive:
                range_tiles = blast_range / TILE_SIZE
                capped_range_tiles = min(range_tiles, 7)
                early_max_tiles = 2 if capped_range_tiles <= 6 else 3 if capped_range_tiles <= 7 else 0
                if early_max_tiles > 0 and random.random() < 0.2:
                    early_tiles = random.randint(1, early_max_tiles)
                    effective_dist = max(TILE_SIZE, blast_range - early_tiles * TILE_SIZE)
                    end_x = start_x + dx * effective_dist
                    end_y = start_y + dy * effective_dist
        return start_x, start_y, end_x, end_y

    def _queue_ki_blast_fx(self, actor, target=None, owner_pid=None, npc_id=None):
        if not actor:
            return
        start_x, start_y, impact_x, impact_y = self._compute_blast_visual_impact(actor, target)
        self.fx_events.append({
            "kind": "ki_blast",
            "owner_pid": owner_pid,
            "npc_id": npc_id,
            "start_x": start_x,
            "start_y": start_y,
            "impact_x": impact_x,
            "impact_y": impact_y,
            "facing": actor.get("facing", "down"),
            "aura_tint": actor.get("aura_tint", 0x4fd6ff),
            "explosive": self._get_equipped_augment(actor, "ki_shot") == "explosive",
        })

    def _apply_barrier_reduction(self, target, damage_type, raw_damage):
        incoming = max(1, int(raw_damage or 0))
        stats = self._get_barrier_stats(target)
        if not stats["has_barrier"]:
            return incoming
        reduction_pct = stats["physical_pct"] if damage_type == "physical" else stats["ki_pct"]
        if reduction_pct <= 0:
            return incoming
        if not self._try_spend_plain_ki(target, BARRIER_PROC_KI_COST):
            return incoming
        target["barrier_proc_until"] = time.time() + BARRIER_PROC_DURATION
        target["barrier_proc_facing"] = target.get("facing", "down")
        return max(1, round(incoming * (1.0 - reduction_pct * 0.01)))

    def _apply_explosive_splash_player(self, attacker_pid, primary_target_pid, damage):
        splash = max(1, round(max(1, damage) * EXPLOSIVE_SHOT_SPLASH_MULT))
        center = self.players.get(primary_target_pid)
        if not center:
            return
        for pid, target in self.players.items():
            if pid in (attacker_pid, primary_target_pid) or target.get("dead") or target.get("knocked_out"):
                continue
            if dist(center["x"], center["y"], target["x"], target["y"]) <= EXPLOSIVE_SHOT_SPLASH_RADIUS:
                final_damage = self._apply_barrier_reduction(target, "ki", self._calc_ki_damage_taken(splash, target))
                target["hp"] = max(0, target["hp"] - final_damage)
                if target["hp"] <= 0:
                    self._knock_out_player(target)

    def _apply_explosive_splash_npc(self, attacker_pid, primary_owner_pid, primary_npc_id, damage):
        splash = max(1, round(max(1, damage) * EXPLOSIVE_SHOT_SPLASH_MULT))
        owner = self.players.get(primary_owner_pid)
        center = owner.get("npcs", {}).get(primary_npc_id) if owner else None
        if not center:
            return
        for pid, target in self.players.items():
            if pid == attacker_pid or target.get("dead") or target.get("knocked_out"):
                continue
            if dist(center["x"], center["y"], target["x"], target["y"]) <= EXPLOSIVE_SHOT_SPLASH_RADIUS:
                target["hp"] = max(0, target["hp"] - self._calc_ki_damage_taken(splash, target))
                if target["hp"] <= 0:
                    self._knock_out_player(target)
            for npc_id, npc in (target.get("npcs", {}) or {}).items():
                if pid == primary_owner_pid and npc_id == primary_npc_id:
                    continue
                if npc.get("dead") or npc.get("knocked_out"):
                    continue
                if dist(center["x"], center["y"], npc["x"], npc["y"]) <= EXPLOSIVE_SHOT_SPLASH_RADIUS:
                    final_damage = self._apply_barrier_reduction(npc, "ki", self._calc_ki_damage_taken(splash, npc))
                    npc["hp"] = max(0, npc["hp"] - final_damage)
                    if npc["hp"] <= 0:
                        self._knock_out_npc(npc)

    def _try_ki_spend(self, entity, cost):
        """Deduct ki from entity if enough. Returns True on success."""
        if entity.get("inf_ki"):
            entity["ki"] = entity.get("maxKi", KI_MAX_BASE)
            entity["blastLevel"] = entity.get("blastLevel", 0) + 1
            self._grant_ki_skill_xp(entity, 1)
            return True
        ki = entity.get("ki", 0)
        if ki < cost:
            return False
        entity["ki"] = ki - cost
        entity["blastLevel"] = entity.get("blastLevel", 0) + 1
        self._grant_ki_skill_xp(entity, 1)
        return True

    def _ki_blast_player(self, attacker_pid, target_pid):
        """Player ki-blasts another player."""
        if attacker_pid == target_pid:
            return
        attacker = self.players.get(attacker_pid)
        target = self.players.get(target_pid)
        if not attacker or not target:
            return
        if attacker.get("dead") or attacker.get("knocked_out") or target.get("dead") or target.get("knocked_out"):
            return

        d = dist(attacker["x"], attacker["y"], target["x"], target["y"])
        if d > self._get_blast_range(attacker):
            return

        now = time.time()
        cooldown_key = f"kb_{target_pid}"
        last = attacker.get("last_hit_by_player", {}).get(cooldown_key, 0)
        if now - last < self._get_blast_cooldown(attacker):
            return

        cost, dmg = self._calc_blast_for_actor(attacker)
        if not self._try_ki_spend(attacker, cost):
            return
        self._grant_ki_skill_xp(attacker, 1)
        self._queue_ki_blast_fx(attacker, target=target)

        attacker.setdefault("last_hit_by_player", {})[cooldown_key] = now

        final_dmg = self._apply_barrier_reduction(target, "ki", self._calc_ki_damage_taken(dmg, target))
        target["hp"] = max(0, target["hp"] - final_dmg)
        mode = self._get_equipped_augment(attacker, "ki_shot")
        if mode == "echo_shot" and random.random() < ECHO_SHOT_PROC_CHANCE and target["hp"] > 0:
            echo_dmg = self._apply_barrier_reduction(target, "ki", self._calc_ki_damage_taken(dmg, target))
            target["hp"] = max(0, target["hp"] - echo_dmg)
        if mode == "explosive":
            self._apply_explosive_splash_player(attacker_pid, target_pid, dmg)

        self._grant_xp(attacker, 8)

        if target["hp"] <= 0:
            self._knock_out_player(target)

    def _ki_blast_npc(self, attacker_pid, target_owner_pid, target_npc_id):
        """Player ki-blasts another player's NPC."""
        attacker = self.players.get(attacker_pid)
        owner = self.players.get(target_owner_pid)
        if not attacker or not owner:
            return
        if attacker.get("dead") or attacker.get("knocked_out"):
            return

        npc_state = owner.get("npcs", {}).get(target_npc_id)
        if not npc_state or npc_state.get("dead") or npc_state.get("knocked_out"):
            return

        d = dist(attacker["x"], attacker["y"], npc_state["x"], npc_state["y"])
        if d > self._get_blast_range(attacker):
            return

        now = time.time()
        cooldown_key = f"kb_npc_{target_npc_id}"
        last = attacker.get("last_hit_by_player", {}).get(cooldown_key, 0)
        if now - last < self._get_blast_cooldown(attacker):
            return

        cost, dmg = self._calc_blast_for_actor(attacker)
        if not self._try_ki_spend(attacker, cost):
            return
        self._grant_ki_skill_xp(attacker, 1)
        self._queue_ki_blast_fx(attacker, target=npc_state)

        attacker.setdefault("last_hit_by_player", {})[cooldown_key] = now

        final_dmg = self._apply_barrier_reduction(npc_state, "ki", self._calc_ki_damage_taken(dmg, npc_state))
        npc_state["hp"] = max(0, npc_state["hp"] - final_dmg)
        npc_state["_last_attacked_by"] = {"type": "player", "id": attacker_pid}
        mode = self._get_equipped_augment(attacker, "ki_shot")
        if mode == "echo_shot" and random.random() < ECHO_SHOT_PROC_CHANCE and npc_state["hp"] > 0:
            echo_dmg = self._apply_barrier_reduction(npc_state, "ki", self._calc_ki_damage_taken(dmg, npc_state))
            npc_state["hp"] = max(0, npc_state["hp"] - echo_dmg)
        if mode == "explosive":
            self._apply_explosive_splash_npc(attacker_pid, target_owner_pid, target_npc_id, dmg)

        self._grant_xp(attacker, 5)

        if npc_state["hp"] <= 0:
            self._knock_out_npc(npc_state)

    def _ki_blast_dummy(self, pid, dummy_id):
        """Player ki-blasts a training dummy."""
        p = self.players.get(pid)
        if not p or not dummy_id:
            return
        dummy = self.dummies.get(dummy_id)
        if not dummy or dummy.get("dead"):
            return
        if p.get("dead") or p.get("knocked_out"):
            return

        d = dist(p["x"], p["y"], dummy["x"], dummy["y"])
        if d > self._get_blast_range(p):
            return

        now = time.time()
        cooldown_key = f"kb_dummy_{dummy_id}"
        last = p.get("last_hit_by_player", {}).get(cooldown_key, 0)
        if now - last < self._get_blast_cooldown(p):
            return

        cost, dmg = self._calc_blast_for_actor(p)
        if not self._try_ki_spend(p, cost):
            return
        self._grant_ki_skill_xp(p, 2)
        p.setdefault("last_hit_by_player", {})[cooldown_key] = now

        dummy["hp"] = max(0, dummy["hp"] - max(1, dmg))
        self._grant_xp(p, 3)
        if dummy["hp"] <= 0:
            dummy["dead"] = True

    def _npc_ki_blast_player(self, owner_pid, npc_id, target_pid):
        """An NPC ki-blasts a player."""
        if owner_pid == target_pid:
            return
        owner = self.players.get(owner_pid)
        npc_state = owner.get("npcs", {}).get(npc_id) if owner else None
        if not npc_state or npc_state.get("dead") or npc_state.get("knocked_out"):
            return
        target = self.players.get(target_pid)
        if not target or target.get("dead") or target.get("knocked_out"):
            return

        now = time.time()
        cooldown_key = f"nkb_{npc_id}"
        last = target.get("last_hit_by_player", {}).get(cooldown_key, 0)
        if now - last < self._get_blast_cooldown(npc_state):
            return

        cost, dmg = self._calc_blast_for_actor(npc_state)
        if npc_state.get("inf_ki"):
            npc_state["ki"] = npc_state.get("maxKi", KI_MAX_BASE)
            npc_state["blastLevel"] = npc_state.get("blastLevel", 0) + 1
            self._grant_ki_skill_xp(npc_state, 2)
        else:
            ki = npc_state.get("ki", 0)
            if ki < cost:
                return
            npc_state["ki"] = ki - cost
            npc_state["blastLevel"] = npc_state.get("blastLevel", 0) + 1
            self._grant_ki_skill_xp(npc_state, 2)
        self._queue_ki_blast_fx(npc_state, target=target, owner_pid=owner_pid, npc_id=npc_id)

        target.setdefault("last_hit_by_player", {})[cooldown_key] = now

        final_dmg = self._apply_barrier_reduction(target, "ki", self._calc_ki_damage_taken(dmg, target))
        target["hp"] = max(0, target["hp"] - final_dmg)
        self._grant_xp(npc_state, 8)

        if target["hp"] <= 0:
            if owner:
                self._grant_xp(owner, PVP_XP_KILL)
            self._knock_out_player(target)

    def _npc_ki_blast_npc(self, owner_pid, attacker_npc_id, target_owner_pid, target_npc_id):
        """An NPC ki-blasts another player's NPC."""
        if owner_pid == target_owner_pid:
            return
        owner = self.players.get(owner_pid)
        attacker_npc = owner.get("npcs", {}).get(attacker_npc_id) if owner else None
        if not attacker_npc or attacker_npc.get("dead") or attacker_npc.get("knocked_out"):
            return
        target_owner = self.players.get(target_owner_pid)
        if not target_owner:
            return
        npc_state = target_owner.get("npcs", {}).get(target_npc_id)
        if not npc_state or npc_state.get("dead") or npc_state.get("knocked_out"):
            return

        now = time.time()
        cooldown_key = f"nkb_{attacker_npc_id}_vs_{target_npc_id}"
        last = npc_state.get("last_hit", {}).get(cooldown_key, 0)
        if now - last < self._get_blast_cooldown(attacker_npc):
            return

        cost, dmg = self._calc_blast_for_actor(attacker_npc)
        if attacker_npc.get("inf_ki"):
            attacker_npc["ki"] = attacker_npc.get("maxKi", KI_MAX_BASE)
            attacker_npc["blastLevel"] = attacker_npc.get("blastLevel", 0) + 1
            self._grant_ki_skill_xp(attacker_npc, 2)
        else:
            ki = attacker_npc.get("ki", 0)
            if ki < cost:
                return
            attacker_npc["ki"] = ki - cost
            attacker_npc["blastLevel"] = attacker_npc.get("blastLevel", 0) + 1
            self._grant_ki_skill_xp(attacker_npc, 2)
        self._queue_ki_blast_fx(attacker_npc, target=npc_state, owner_pid=owner_pid, npc_id=attacker_npc_id)

        npc_state.setdefault("last_hit", {})[cooldown_key] = now

        final_dmg = self._apply_barrier_reduction(npc_state, "ki", self._calc_ki_damage_taken(dmg, npc_state))
        npc_state["hp"] = max(0, npc_state["hp"] - final_dmg)
        npc_state["_last_attacked_by"] = {"type": "npc", "id": attacker_npc_id, "owner": owner_pid}
        self._grant_xp(attacker_npc, 5)

        if npc_state["hp"] <= 0:
            self._knock_out_npc(npc_state)

    def _knockout_duration(self):
        return random.uniform(KNOCKOUT_MIN_TIME, KNOCKOUT_MAX_TIME)

    def _knock_out_player(self, target):
        if target.get("carried_by"):
            self._drop_any_carrier(target.get("carried_by"), target.get("carried_by_type"))
        self._clear_charge_state(target)
        target["dead"] = False
        target["hp"] = 0
        target["vx"] = 0
        target["vy"] = 0
        target["punching"] = False
        target["knocked_out"] = True
        target["knocked_until"] = time.time() + self._knockout_duration()
        target["carried_by"] = None
        target["carried_by_type"] = None
        target["meditating"] = False
        target["meditation_started_at"] = None
        target["meditation_until"] = None
        target["meditation_total_ms"] = 0
        target["meditation_crystal_quality"] = None
        self._drop_carried(target["id"])

    def _knock_out_npc(self, npc_state):
        carrier_id = npc_state.get("carried_by")
        if carrier_id:
            self._drop_any_carrier(carrier_id, npc_state.get("carried_by_type"))
        self._clear_charge_state(npc_state)
        npc_state["dead"] = False
        npc_state["hp"] = 0
        npc_state["knocked_out"] = True
        npc_state["knocked_until"] = time.time() + self._knockout_duration()
        npc_state["carried_by"] = None
        npc_state["carried_by_type"] = None
        npc_state["meditating"] = False
        npc_state["meditation_started_at"] = None
        npc_state["meditation_until"] = None
        npc_state["meditation_total_ms"] = 0
        npc_state["meditation_crystal_quality"] = None

    def _is_in_interact_range(self, ax, ay, bx, by):
        return dist(ax, ay, bx, by) <= PVP_ATTACK_RANGE

    def _get_knocked_player_target(self, target_pid):
        target = self.players.get(target_pid)
        if not target or target.get("dead") or not target.get("knocked_out"):
            return None
        return target

    def _get_knocked_npc_target(self, owner_pid, npc_id):
        owner = self.players.get(owner_pid)
        if not owner:
            return None, None
        npc_state = owner.get("npcs", {}).get(npc_id)
        if not npc_state or npc_state.get("dead") or not npc_state.get("knocked_out"):
            return owner, None
        return owner, npc_state

    def _finish_player(self, attacker_pid, target_pid):
        attacker = self.players.get(attacker_pid)
        target = self._get_knocked_player_target(target_pid)
        if not attacker or not target:
            return
        if not self._is_in_interact_range(attacker["x"], attacker["y"], target["x"], target["y"]):
            return
        self._kill_player(target, attacker)

    def _finish_npc(self, attacker_pid, target_owner_pid, target_npc_id):
        attacker = self.players.get(attacker_pid)
        _owner, npc_state = self._get_knocked_npc_target(target_owner_pid, target_npc_id)
        if not attacker or not npc_state:
            return
        if not self._is_in_interact_range(attacker["x"], attacker["y"], npc_state["x"], npc_state["y"]):
            return
        carrier_id = npc_state.get("carried_by")
        if carrier_id:
            self._drop_any_carrier(carrier_id, npc_state.get("carried_by_type"))
        npc_state["dead"] = True
        npc_state["knocked_out"] = False
        npc_state["knocked_until"] = None
        npc_state["carried_by"] = None
        npc_state["carried_by_type"] = None

    def _rob_player(self, attacker_pid, target_pid):
        attacker = self.players.get(attacker_pid)
        target = self._get_knocked_player_target(target_pid)
        if not attacker or not target:
            return
        if not self._is_in_interact_range(attacker["x"], attacker["y"], target["x"], target["y"]):
            return
        amount = max(0, int(target.get("logs", 0)))
        if amount <= 0:
            return
        attacker["logs"] += amount
        target["logs"] = 0

    def _rob_npc(self, attacker_pid, target_owner_pid, target_npc_id):
        attacker = self.players.get(attacker_pid)
        _owner, npc_state = self._get_knocked_npc_target(target_owner_pid, target_npc_id)
        if not attacker or not npc_state:
            return
        if not self._is_in_interact_range(attacker["x"], attacker["y"], npc_state["x"], npc_state["y"]):
            return
        amount = max(0, int(npc_state.get("logs", 0)))
        if amount <= 0:
            return
        attacker["logs"] += amount
        npc_state["logs"] = 0
        now = time.time()
        npc_state["_logs_stolen_at"] = now
        npc_state["_last_robbed_by"] = {
            "npc_id": None,
            "owner": attacker_pid,
            "amount": amount,
            "at": now,
        }

    def _carry_player(self, carrier_pid, target_pid):
        carrier = self.players.get(carrier_pid)
        target = self._get_knocked_player_target(target_pid)
        if not carrier or not target or carrier.get("carrying") or target.get("carried_by"):
            return
        if not self._is_in_interact_range(carrier["x"], carrier["y"], target["x"], target["y"]):
            return
        carrier["carrying"] = {"type": "player", "id": target_pid}
        target["carried_by"] = carrier_pid
        target["carried_by_type"] = "player"

    def _carry_npc(self, carrier_pid, target_owner_pid, target_npc_id):
        carrier = self.players.get(carrier_pid)
        _owner, npc_state = self._get_knocked_npc_target(target_owner_pid, target_npc_id)
        if not carrier or not npc_state or carrier.get("carrying") or npc_state.get("carried_by"):
            return
        if not self._is_in_interact_range(carrier["x"], carrier["y"], npc_state["x"], npc_state["y"]):
            return
        carrier["carrying"] = {"type": "npc", "owner": target_owner_pid, "id": target_npc_id}
        npc_state["carried_by"] = carrier_pid
        npc_state["carried_by_type"] = "player"

    def _drop_carried(self, carrier_pid):
        carrier = self.players.get(carrier_pid)
        if not carrier:
            return
        carried = carrier.get("carrying")
        if not carried:
            return
        if carried.get("type") == "player":
            target = self.players.get(carried.get("id"))
            if target:
                target["carried_by"] = None
                target["carried_by_type"] = None
                target["x"] = carrier["x"]
                target["y"] = carrier["y"] + TILE_SIZE * 0.35
        elif carried.get("type") == "npc":
            owner = self.players.get(carried.get("owner"))
            target = owner.get("npcs", {}).get(carried.get("id")) if owner else None
            if target:
                target["carried_by"] = None
                target["carried_by_type"] = None
                target["x"] = carrier["x"]
                target["y"] = carrier["y"] + TILE_SIZE * 0.35
        carrier["carrying"] = None

    def _get_local_npc(self, owner_pid, npc_id):
        owner = self.players.get(owner_pid)
        if not owner:
            return None, None
        return owner, owner.get("npcs", {}).get(npc_id)

    def _npc_carrier_key(self, owner_pid, npc_id):
        return f"{owner_pid}:{npc_id}"

    def _drop_any_carrier(self, carried_by, carried_by_type):
        if not carried_by:
            return
        if carried_by_type == "npc":
            owner_pid, npc_id = str(carried_by).split(":", 1)
            self._npc_drop_carried(owner_pid, npc_id)
        else:
            self._drop_carried(carried_by)

    def _npc_carry_player(self, owner_pid, carrier_npc_id, target_pid):
        owner, carrier = self._get_local_npc(owner_pid, carrier_npc_id)
        target = self._get_knocked_player_target(target_pid)
        if not owner or not carrier or not target or carrier.get("carrying") or target.get("carried_by"):
            return
        if not self._is_in_interact_range(carrier["x"], carrier["y"], target["x"], target["y"]):
            return
        carrier["carrying"] = {"type": "player", "id": target_pid}
        target["carried_by"] = self._npc_carrier_key(owner_pid, carrier_npc_id)
        target["carried_by_type"] = "npc"

    def _npc_carry_npc(self, owner_pid, carrier_npc_id, target_owner_pid, target_npc_id):
        owner, carrier = self._get_local_npc(owner_pid, carrier_npc_id)
        _target_owner, target = self._get_knocked_npc_target(target_owner_pid, target_npc_id)
        if not owner or not carrier or not target or carrier.get("carrying") or target.get("carried_by"):
            return
        if not self._is_in_interact_range(carrier["x"], carrier["y"], target["x"], target["y"]):
            return
        carrier["carrying"] = {"type": "npc", "owner": target_owner_pid, "id": target_npc_id}
        target["carried_by"] = self._npc_carrier_key(owner_pid, carrier_npc_id)
        target["carried_by_type"] = "npc"

    def _npc_drop_carried(self, owner_pid, carrier_npc_id):
        _owner, carrier = self._get_local_npc(owner_pid, carrier_npc_id)
        if not carrier:
            return
        carried = carrier.get("carrying")
        if not carried:
            return
        if carried.get("type") == "player":
            target = self.players.get(carried.get("id"))
            if target:
                target["carried_by"] = None
                target["carried_by_type"] = None
                target["x"] = carrier["x"]
                target["y"] = carrier["y"] + TILE_SIZE * 0.35
        elif carried.get("type") == "npc":
            owner = self.players.get(carried.get("owner"))
            target = owner.get("npcs", {}).get(carried.get("id")) if owner else None
            if target:
                target["carried_by"] = None
                target["carried_by_type"] = None
                target["x"] = carrier["x"]
                target["y"] = carrier["y"] + TILE_SIZE * 0.35
        carrier["carrying"] = None

    def _npc_rob_player(self, owner_pid, npc_id, target_pid):
        _owner, carrier = self._get_local_npc(owner_pid, npc_id)
        target = self._get_knocked_player_target(target_pid)
        if not carrier or not target:
            return
        if not self._is_in_interact_range(carrier["x"], carrier["y"], target["x"], target["y"]):
            return
        amount = max(0, int(target.get("logs", 0)))
        if amount <= 0:
            return
        carrier["logs"] = min(carrier.get("maxLogs", 10), carrier.get("logs", 0) + amount)
        target["logs"] = 0

    def _npc_rob_npc(self, owner_pid, npc_id, target_owner_pid, target_npc_id):
        _owner, carrier = self._get_local_npc(owner_pid, npc_id)
        _target_owner, target = self._get_knocked_npc_target(target_owner_pid, target_npc_id)
        if not carrier or not target:
            return
        if not self._is_in_interact_range(carrier["x"], carrier["y"], target["x"], target["y"]):
            return
        amount = max(0, int(target.get("logs", 0)))
        if amount <= 0:
            return
        carrier["logs"] = min(carrier.get("maxLogs", 10), carrier.get("logs", 0) + amount)
        target["logs"] = 0

    def _kill_player(self, target, killer=None):
        """Handle player death — drop all logs as ground items."""
        if target.get("carried_by"):
            self._drop_any_carrier(target["carried_by"], target.get("carried_by_type"))
        target["dead"] = True
        target["knocked_out"] = False
        target["knocked_until"] = None
        target["carried_by"] = None
        target["carried_by_type"] = None
        target["meditating"] = False
        target["meditation_started_at"] = None
        target["meditation_until"] = None
        target["meditation_total_ms"] = 0
        target["meditation_crystal_quality"] = None
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
            if existing and existing.get("hp", 0) != npc_data.get("hp", 0):
                # NPC HP is server-authoritative so combat damage and campfire healing stick.
                npc_data["hp"] = existing["hp"]
            if existing and not existing.get("knocked_out") and existing.get("hp", 0) > 0 and npc_data.get("hp", 0) <= 0:
                npc_data["hp"] = existing["hp"]
            if existing:
                # Logs stolen by another NPC — only protect if steal happened recently
                for field in ("maxHp", "str", "def", "level", "xp", "maxLogs", "ki", "maxKi", "blastLevel",
                             "stones", "bastalite", "crystal_pristine", "crystal_normal", "crystal_poor", "realm_crystal_t1", "inf_ki",
                             "ki_moves", "ki_denominations", "ki_known_augments", "ki_equipped_augments", "ki_upgrades",
                             "kiSkillLevel", "kiSkillXp", "realm_tier", "realm_insight", "barrier_proc_until", "barrier_proc_facing"):
                    if field in existing:
                        npc_data[field] = existing[field]
                npc_data["armor_elite"] = bool(npc_data.get("armor_elite", existing.get("armor_elite", False)))
                for field in ("meditating", "meditation_started_at", "meditation_until", "meditation_total_ms", "meditation_crystal_quality"):
                    if field in existing:
                        npc_data[field] = existing[field]
                if existing.get("has_ki_blast"):
                    npc_data["has_ki_blast"] = True
            # Restore has_ki_blast from client stats if server doesn't have it yet
            if not npc_data.get("has_ki_blast") and npc_data.get("hasKiBlast"):
                npc_data["has_ki_blast"] = True
                steal_ts = existing.get("_logs_stolen_at", 0)
                if steal_ts and now - steal_ts < 2.0 and existing.get("logs", 0) < npc_data.get("logs", 0):
                    npc_data["logs"] = existing["logs"]
            if existing and existing.get("dead"):
                npc_data["dead"] = True
            if existing and existing.get("knocked_out"):
                npc_data["knocked_out"] = True
                npc_data["knocked_until"] = existing.get("knocked_until")
                npc_data["carried_by"] = existing.get("carried_by")
                npc_data["carried_by_type"] = existing.get("carried_by_type")
                npc_data["hp"] = existing.get("hp", 0)
                if existing.get("carried_by"):
                    npc_data["x"] = existing.get("x", npc_data.get("x", 0))
                    npc_data["y"] = existing.get("y", npc_data.get("y", 0))
            if existing and existing.get("carrying"):
                npc_data["carrying"] = existing.get("carrying")
            if existing and existing.get("meditating"):
                npc_data["x"] = existing.get("x", npc_data.get("x", 0))
                npc_data["y"] = existing.get("y", npc_data.get("y", 0))
            # Fence collision — reject NPC position if it would be inside a fence
            new_x = npc_data.get("x", 0)
            new_y = npc_data.get("y", 0)
            if existing and self._is_blocked_by_fence(new_x, new_y, pid):
                npc_data["x"] = existing.get("x", new_x)
                npc_data["y"] = existing.get("y", new_y)
            self._normalize_ki_progression(npc_data)
            self._ensure_level_based_ki(npc_data)
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

    # ── Rock spawning & mining ──────────────────────────────────────────────

    def _spawn_rocks(self):
        """Roll for rock spawns on bare ground tiles. Called every ROCK_SPAWN_INTERVAL."""
        now = time.time()
        for col, row in ROCK_SPAWN_POSITIONS:
            # Skip if a rock already exists at this tile
            x, y = tile_pos(col, row)
            already = any(r for r in self.rocks if r["col"] == col and r["row"] == row and not r["mined"])
            if already:
                continue
            if random.random() < ROCK_SPAWN_CHANCE:
                rock_id = self._next_rock_id
                self._next_rock_id += 1
                self.rocks.append({
                    "id": rock_id,
                    "col": col, "row": row,
                    "x": x, "y": y,
                    "hits_left": ROCK_HITS,
                    "mined": False,
                    "spawned_at": now,
                    "despawn_at": now + ROCK_LIFESPAN,
                })
        self._last_rock_spawn = now

    def _try_mine_rock(self, pid, rock_id):
        p = self.players.get(pid)
        if not p or rock_id is None:
            return
        rock = None
        for r in self.rocks:
            if r["id"] == rock_id and not r["mined"]:
                rock = r
                break
        if not rock:
            return

        # Distance check
        d = dist(p["x"], p["y"], rock["x"], rock["y"])
        if d > ROCK_MINE_DIST:
            return

        rock["hits_left"] -= 1
        if rock["hits_left"] <= 0:
            rock["mined"] = True
            # Award stone directly to player
            p["stones"] = p.get("stones", 0) + 1

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

    # ── Ki Targets ─────────────────────────────────────────────────────────────

    def _try_build_ki_target(self, pid, x=None, y=None):
        """Build a ki target costing 10 logs. x/y can be explicit or defaults to near player."""
        p = self.players.get(pid)
        if not p:
            return
        if p["logs"] < KI_TARGET_LOG_COST:
            return
        p["logs"] -= KI_TARGET_LOG_COST

        if x is None or y is None:
            col = int(p["x"] / TILE_SIZE) + 2
            row = int(p["y"] / TILE_SIZE)
            x, y = tile_pos(col, row)

        ktid = _gen_ki_target_id()
        self.ki_targets[ktid] = {
            "id": ktid,
            "x": x, "y": y,
            "hp": KI_TARGET_HP,
            "maxHp": KI_TARGET_HP,
            "owner": pid,
            "dead": False,
        }
        print(f"[game_state] {pid} built ki target {ktid} at ({x:.0f}, {y:.0f})")
        return ktid

    def _try_build_anvil(self, pid):
        """Build an anvil costing 5 stones, placed 2 tiles to the right of the player."""
        p = self.players.get(pid)
        if not p or p.get("dead"):
            return
        if p.get("stones", 0) < ANVIL_STONE_COST:
            return
        p["stones"] -= ANVIL_STONE_COST

        col = int(p["x"] / TILE_SIZE) + 2
        row = int(p["y"] / TILE_SIZE)
        x, y = tile_pos(col, row)

        aid = _gen_anvil_id()
        self.anvils[aid] = {
            "id": aid,
            "x": x, "y": y,
            "owner": pid,
            "dead": False,
        }
        print(f"[game_state] {pid} built anvil {aid} at ({x:.0f}, {y:.0f})")

    def _build_ki_shrine(self, pid):
        p = self.players.get(pid)
        if not p or p.get("dead"):
            return
        col = int(p["x"] / TILE_SIZE) + 1
        row = int(p["y"] / TILE_SIZE)
        x, y = tile_pos(col, row)
        for item in self.ground_items:
            if item.get("resource") == "KiShrine" and self._tile_key(item["x"], item["y"]) == (col, row):
                return
        self.ground_items.append({
            "id": _gen_item_id(),
            "x": x,
            "y": y,
            "resource": "KiShrine",
            "amount": 1,
            "_placed": True,
        })

    def _use_ki_shrine(self, pid, item_id, npc_id=None):
        owner = self.players.get(pid)
        if not owner:
            return
        actor = owner.get("npcs", {}).get(npc_id) if npc_id else owner
        if not actor or actor.get("dead") or actor.get("knocked_out"):
            return
        item = self._find_ground_item(item_id)
        if not item or item.get("resource") != "KiShrine":
            return
        if dist(actor["x"], actor["y"], item["x"], item["y"]) > TILE_SIZE * 1.5:
            return
        if int(actor.get("realm_crystal_t1", 0) or 0) <= 0:
            owner["_shrine_result"] = {
                "who": npc_id or pid,
                "success": False,
                "reason": "Need a Tier 1 realm crystal.",
            }
            return
        actor["realm_crystal_t1"] = int(actor.get("realm_crystal_t1", 0) or 0) - 1
        result = self._apply_t1_shrine_upgrade(actor)
        owner["_shrine_result"] = {
            "who": npc_id or pid,
            "success": bool(result.get("success")),
            "reason": result.get("reason"),
            "move": result.get("move"),
            "stat": result.get("stat"),
            "value": result.get("value"),
        }

    def _try_refine_rock(self, pid, anvil_id, npc_id=None):
        """Refine a rock at an anvil. Consumes 1 stone, rolls for Bastalite and ki crystals."""
        p = self.players.get(pid)
        if not p or p.get("dead"):
            return

        # Determine who is refining: player or their NPC
        actor = p
        if npc_id:
            npc_state = p.get("npcs", {}).get(npc_id)
            if npc_state and not npc_state.get("dead"):
                actor = npc_state
            else:
                return

        # Must have stones
        stones = actor.get("stones", 0)
        if stones < REFINE_STONE_COST:
            return

        # Must be near anvil
        anvil = self.anvils.get(anvil_id)
        if not anvil or anvil.get("dead"):
            return
        d = dist(actor["x"], actor["y"], anvil["x"], anvil["y"])
        if d > TILE_SIZE * 1.5:
            return

        # Consume stone
        actor["stones"] = stones - REFINE_STONE_COST

        # Roll for results
        results = []
        if random.random() < BASTALITE_CHANCE:
            actor["bastalite"] = actor.get("bastalite", 0) + 1
            results.append("Bastalite")

        roll = random.random()
        if roll < CRYSTAL_PRISTINE_CHANCE:
            actor["crystal_pristine"] = actor.get("crystal_pristine", 0) + 1
            results.append("Pristine Ki Crystal")
        elif roll < CRYSTAL_PRISTINE_CHANCE + CRYSTAL_NORMAL_CHANCE:
            actor["crystal_normal"] = actor.get("crystal_normal", 0) + 1
            results.append("Ki Crystal")
        elif roll < CRYSTAL_PRISTINE_CHANCE + CRYSTAL_NORMAL_CHANCE + CRYSTAL_POOR_CHANCE:
            actor["crystal_poor"] = actor.get("crystal_poor", 0) + 1
            results.append("Cracked Ki Crystal")

        # Store result for client to display
        who = npc_id or pid
        p.setdefault("_refine_result", {})
        p["_refine_result"] = {
            "who": who,
            "results": results,
        }
        print(f"[game_state] {who} refined rock at {anvil_id}: {results or 'nothing'}")

    def _npc_pickup_stone(self, pid, npc_id, item_id):
        """NPC picks up ALL stone from a ground item stack."""
        p = self.players.get(pid)
        if not p or not npc_id or not item_id:
            return
        npc_state = p.get("npcs", {}).get(npc_id)
        if not npc_state or npc_state.get("dead"):
            return

        for item in self.ground_items:
            if item["id"] == item_id and item.get("_placed") and item.get("resource") == "Stone":
                d = dist(npc_state["x"], npc_state["y"], item["x"], item["y"])
                if d > TILE_SIZE * 1.5:
                    return
                amount = item.get("amount", 1)
                npc_state["stones"] = npc_state.get("stones", 0) + amount
                self.ground_items.remove(item)
                print(f"[game_state] NPC {npc_id} picked up {amount} stone")
                return

    def _npc_pickup_stone_tile(self, pid, npc_id, x, y):
        """NPC picks up all placed stone items from the targeted tile."""
        p = self.players.get(pid)
        if not p or not npc_id or x is None or y is None:
            return
        npc_state = p.get("npcs", {}).get(npc_id)
        if not npc_state or npc_state.get("dead"):
            return

        tile = self._tile_key(float(x), float(y))
        total = 0
        remaining = []
        for item in self.ground_items:
            same_tile = self._tile_key(item["x"], item["y"]) == tile
            if item.get("_placed") and item.get("resource") == "Stone" and same_tile:
                d = dist(npc_state["x"], npc_state["y"], item["x"], item["y"])
                if d <= TILE_SIZE * 1.5:
                    total += item.get("amount", 1)
                    continue
            remaining.append(item)

        if total <= 0:
            return

        npc_state["stones"] = npc_state.get("stones", 0) + total
        self.ground_items = remaining
        print(f"[game_state] NPC {npc_id} picked up {total} stone from tile {tile}")

    def _npc_refine_rock(self, pid, npc_id, anvil_id):
        """NPC refines 1 stone at an anvil. Same chances as player refine."""
        p = self.players.get(pid)
        if not p or not npc_id:
            return
        npc_state = p.get("npcs", {}).get(npc_id)
        if not npc_state or npc_state.get("dead"):
            return
        if npc_state.get("stones", 0) < REFINE_STONE_COST:
            return

        anvil = self.anvils.get(anvil_id)
        if not anvil or anvil.get("dead"):
            return
        d = dist(npc_state["x"], npc_state["y"], anvil["x"], anvil["y"])
        if d > TILE_SIZE * 1.5:
            return

        npc_state["stones"] = npc_state.get("stones", 0) - REFINE_STONE_COST

        results = []
        if random.random() < BASTALITE_CHANCE:
            npc_state["bastalite"] = npc_state.get("bastalite", 0) + 1
            results.append("Bastalite")

        roll = random.random()
        if roll < CRYSTAL_PRISTINE_CHANCE:
            npc_state["crystal_pristine"] = npc_state.get("crystal_pristine", 0) + 1
            results.append("Pristine Ki Crystal")
        elif roll < CRYSTAL_PRISTINE_CHANCE + CRYSTAL_NORMAL_CHANCE:
            npc_state["crystal_normal"] = npc_state.get("crystal_normal", 0) + 1
            results.append("Ki Crystal")
        elif roll < CRYSTAL_PRISTINE_CHANCE + CRYSTAL_NORMAL_CHANCE + CRYSTAL_POOR_CHANCE:
            npc_state["crystal_poor"] = npc_state.get("crystal_poor", 0) + 1
            results.append("Cracked Ki Crystal")

        # Store result for client chat
        p.setdefault("_refine_result", {})
        p["_refine_result"] = {
            "who": npc_id,
            "results": results,
        }

    def _npc_give_materials(self, pid, npc_id):
        """NPC transfers all refined materials to the player."""
        p = self.players.get(pid)
        if not p or not npc_id:
            return
        npc_state = p.get("npcs", {}).get(npc_id)
        if not npc_state or npc_state.get("dead"):
            return

        # Transfer bastalite
        amt = npc_state.get("bastalite", 0)
        if amt > 0:
            p["bastalite"] = p.get("bastalite", 0) + amt
            npc_state["bastalite"] = 0

        # Transfer crystals
        for key in ("crystal_pristine", "crystal_normal", "crystal_poor"):
            amt = npc_state.get(key, 0)
            if amt > 0:
                p[key] = p.get(key, 0) + amt
                npc_state[key] = 0

        # Transfer any remaining stones too
        amt = npc_state.get("stones", 0)
        if amt > 0:
            p["stones"] = p.get("stones", 0) + amt
            npc_state["stones"] = 0

    def _ki_blast_ki_target(self, pid, target_id, watching_npc_id=None):
        """Player ki-blasts a ki target. 40% chance to break. 1/25 chance watching NPC learns."""
        p = self.players.get(pid)
        if not p:
            return
        kt = self.ki_targets.get(target_id)
        if not kt or kt.get("dead"):
            return

        d = dist(p["x"], p["y"], kt["x"], kt["y"])
        if d > KI_BLAST_RANGE:
            return

        cost, _dmg = self._calc_blast(p.get("blastLevel", 0))
        if not self._try_ki_spend(p, cost):
            return
        self._grant_ki_skill_xp(p, 2)

        self._grant_xp(p, 3)

        # Check if NPC learns (1/25 chance)
        npc_learned = False
        if watching_npc_id:
            npc_state = p.get("npcs", {}).get(watching_npc_id)
            if npc_state and not npc_state.get("has_ki_blast"):
                if random.random() < KI_TARGET_LEARN_CHANCE:
                    npc_state["has_ki_blast"] = True
                    npc_state["blastLevel"] = 0
                    npc_state["ki"] = npc_state.get("ki", 20)
                    npc_state["maxKi"] = npc_state.get("maxKi", 20)
                    npc_learned = True
                    print(f"[game_state] NPC {watching_npc_id} learned ki blast!")

        # 40% chance target breaks
        broke = random.random() < KI_TARGET_BREAK_CHANCE
        if broke:
            kt["dead"] = True
            # Remove from dict
            self.ki_targets.pop(target_id, None)

        # Store result for client to read
        p.setdefault("_ki_target_result", {})
        p["_ki_target_result"] = {
            "target_id": target_id,
            "broke": broke,
            "npc_learned": npc_learned,
            "npc_id": watching_npc_id,
        }

    def _npc_ki_blast_ki_target(self, owner_pid, npc_id, target_id):
        """An NPC ki-blasts a ki target (practice_ki task)."""
        owner = self.players.get(owner_pid)
        if not owner:
            return
        npc_state = owner.get("npcs", {}).get(npc_id)
        if not npc_state or npc_state.get("dead") or npc_state.get("knocked_out"):
            return
        if not npc_state.get("has_ki_blast"):
            return
        kt = self.ki_targets.get(target_id)
        if not kt:
            return

        cost, _dmg = self._calc_blast(npc_state.get("blastLevel", 0))
        if npc_state.get("inf_ki"):
            npc_state["ki"] = npc_state.get("maxKi", KI_MAX_BASE)
            npc_state["blastLevel"] = npc_state.get("blastLevel", 0) + 1
            self._grant_ki_skill_xp(npc_state, 3)
        else:
            ki = npc_state.get("ki", 0)
            if ki < cost:
                return
            npc_state["ki"] = ki - cost
            npc_state["blastLevel"] = npc_state.get("blastLevel", 0) + 1
            self._grant_ki_skill_xp(npc_state, 3)
        self._grant_xp(npc_state, 3)

        # 40% chance target breaks
        broke = random.random() < KI_TARGET_BREAK_CHANCE
        if broke:
            kt["dead"] = True
            self.ki_targets.pop(target_id, None)

        # Store result for client
        owner.setdefault("_ki_target_result", {})
        owner["_ki_target_result"] = {
            "target_id": target_id,
            "broke": broke,
            "npc_learned": False,
            "npc_id": npc_id,
        }

    # ── Drop Items / Fences / Gates ────────────────────────────────────────────

    def _tile_key(self, x, y):
        """Return (col, row) grid key for a world position."""
        return (int(x // TILE_SIZE), int(y // TILE_SIZE))

    def _find_ground_item(self, item_id):
        if not item_id:
            return None
        for item in self.ground_items:
            if item.get("id") == item_id:
                return item
        return None

    def _is_log_item(self, item):
        return item and item.get("resource") in ("Wood", "log")

    def _is_stone_item(self, item):
        return item and item.get("resource") == "Stone"

    def _campfire_ready(self, item):
        if not self._is_log_item(item):
            return False
        col, row = self._tile_key(item["x"], item["y"])
        required = {
            (col - 1, row),
            (col + 1, row),
            (col, row - 1),
            (col, row + 1),
        }
        found = set()
        for other in self.ground_items:
            if not self._is_stone_item(other):
                continue
            if self._tile_key(other["x"], other["y"]) in required:
                found.add(self._tile_key(other["x"], other["y"]))
        return found == required

    def _get_actor_for_campfire(self, pid, npc_id=None):
        player = self.players.get(pid)
        if not player:
            return None
        if npc_id:
            return player.get("npcs", {}).get(npc_id)
        return player

    def _ignite_campfire(self, item):
        now = time.time()
        logs_used = max(1, min(int(item.get("amount", 1)), LOG_STACK_MAX))
        item["lit"] = True
        item["burn_until"] = now + (logs_used * CAMPFIRE_DURATION_PER_LOG)

    def _spawn_armor_elite(self, pid):
        p = self.players.get(pid)
        if not p or p.get("dead"):
            return
        col = int(p["x"] // TILE_SIZE)
        row = int(p["y"] // TILE_SIZE)
        facing = p.get("facing", "down")
        if facing == "left":
            col -= 1
        elif facing == "right":
            col += 1
        elif facing == "up":
            row -= 1
        else:
            row += 1
        tx, ty = tile_pos(col, row)
        item_id = _gen_item_id()
        self.ground_items.append({
            "id": item_id,
            "x": tx,
            "y": ty,
            "resource": "ArmorElite",
            "amount": 1,
        })

    def _try_drop_item(self, pid, data):
        """Drop logs or stone. If x/y given, drop at that position (NPC drop). Otherwise drop at player's feet."""
        p = self.players.get(pid)
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
            self.ground_items.append({
                "id": item_id,
                "x": tx, "y": ty,
                "resource": "Stone",
                "amount": 1,
                "_placed": True,
            })
            return

        # Log drops
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
        """Player picks up 1 resource from a placed stack by clicking it."""
        p = self.players.get(pid)
        if not p or p.get("dead") or not item_id:
            return

        for item in self.ground_items:
            if item["id"] == item_id and item.get("_placed"):
                if item.get("lit"):
                    return
                # Range check
                d = dist(p["x"], p["y"], item["x"], item["y"])
                if d > TILE_SIZE * 1.5:
                    return
                # Pick up 1 resource
                if item["resource"] == "Stone":
                    p["stones"] = p.get("stones", 0) + 1
                else:
                    p["logs"] += 1
                item["amount"] -= 1
                if item["amount"] <= 0:
                    self.ground_items.remove(item)
                return

    def _try_light_campfire(self, pid, data):
        p = self.players.get(pid)
        if not p or p.get("dead") or p.get("knocked_out"):
            return
        item = self._find_ground_item(data.get("item_id"))
        if not item or not item.get("_placed") or not self._is_log_item(item):
            return
        if item.get("lit"):
            return
        if not self._campfire_ready(item):
            return
        actor = self._get_actor_for_campfire(pid, data.get("npc_id"))
        if not actor or actor.get("dead") or actor.get("knocked_out"):
            return
        if dist(actor["x"], actor["y"], item["x"], item["y"]) > TILE_SIZE * 1.5:
            return
        self._ignite_campfire(item)
        now = time.time()
        if data.get("npc_id"):
            actor["punching"] = True
            actor["punch_until"] = now + 0.3
        else:
            p["punching"] = True
            p["punch_until"] = now + 0.3

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
                if item.get("lit"):
                    return
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
                self._clear_charge_state(p)
                p["dead"] = False
                p["hp"] = p["maxHp"]
                p["ki"] = p.get("maxKi", KI_MAX_BASE)
                p["respawn_at"] = None
                p["carrying"] = None
                p["carried_by_type"] = None
                # Respawn at center
                sx, sy = tile_pos(10, 10)
                p["x"] = sx + random.randint(-48, 48)
                p["y"] = sy + random.randint(-48, 48)

        for p in self.players.values():
            if p.get("knocked_out") and p.get("knocked_until") and now >= p["knocked_until"]:
                if p.get("carried_by"):
                    self._drop_any_carrier(p["carried_by"], p.get("carried_by_type"))
                self._drop_carried(p["id"])
                p["knocked_out"] = False
                p["knocked_until"] = None
                p["carried_by"] = None
                p["carried_by_type"] = None
                p["charging"] = False
                p["hp"] = max(1, p["maxHp"] // 2)

        for p in self.players.values():
            if p.get("meditating") and p.get("meditation_until") and now >= p["meditation_until"]:
                quality = p.get("meditation_crystal_quality") or "poor"
                self._clear_meditation_state(p)
                p["realm_tier"] = self._realm_tier_for_level(p.get("kiSkillLevel", 1))
                insight_gain = 3 if quality == "pristine" else 2 if quality == "normal" else 1
                p["realm_insight"] = p.get("realm_insight", 0) + insight_gain
                p["_meditation_result"] = {
                    "who": p["id"],
                    "quality": quality,
                    "realm_tier": p.get("realm_tier", 0),
                    "insight_gain": insight_gain,
                    "insight_total": p.get("realm_insight", 0),
                    "realm_crystal_t1": 0,
                    "learned_move": None,
                    "ts": now,
                }

            for npc in p.get("npcs", {}).values():
                if npc.get("meditating") and npc.get("meditation_until") and now >= npc["meditation_until"]:
                    quality = npc.get("meditation_crystal_quality") or "poor"
                    self._clear_meditation_state(npc)
                    npc["realm_tier"] = self._realm_tier_for_level(npc.get("kiSkillLevel", 1))
                    insight_gain = 3 if quality == "pristine" else 2 if quality == "normal" else 1
                    npc["realm_insight"] = npc.get("realm_insight", 0) + insight_gain
                    p["_meditation_result"] = {
                        "who": npc.get("id"),
                        "quality": quality,
                        "realm_tier": npc.get("realm_tier", 0),
                        "insight_gain": insight_gain,
                        "insight_total": npc.get("realm_insight", 0),
                        "realm_crystal_t1": 0,
                        "learned_move": None,
                        "ts": now,
                    }

        for owner in self.players.values():
            for npc in owner.get("npcs", {}).values():
                if npc.get("knocked_out") and npc.get("knocked_until") and now >= npc["knocked_until"]:
                    carrier_id = npc.get("carried_by")
                    if carrier_id:
                        self._drop_any_carrier(carrier_id, npc.get("carried_by_type"))
                    npc["knocked_out"] = False
                    npc["knocked_until"] = None
                    npc["carried_by"] = None
                    npc["carried_by_type"] = None
                    npc["charging"] = False
                    npc["hp"] = max(1, npc.get("maxHp", 1) // 2)

        # Lit campfires (used for ki regen bonus and HP healing)
        lit_campfires = [
            item for item in self.ground_items
            if item.get("lit") and item.get("burn_until", 0) > now and self._is_log_item(item)
        ]

        # Ki regen — scales with level.
        # Level 1: 1 ki per 15s (very slow). Each level reduces interval by ~8%.
        # Formula: regen_rate = (1/15) * (1.08 ^ (level-1))  ki/sec
        # Level 1: ~0.067/s (15s per ki), Level 5: ~0.091/s (11s), Level 10: ~0.133/s (7.5s)
        # Campfire bonus: 20% for 1-log fire, 30% for 2-log, 40% for 3-log
        KI_REGEN_BASE = 1.0 / 15.0  # ki per second at level 1
        KI_REGEN_LEVEL_SCALE = 1.08  # 8% faster per level
        CAMPFIRE_KI_BONUS = {1: 0.20, 2: 0.30, 3: 0.40}

        def _campfire_ki_mult(ex, ey):
            """Return ki regen multiplier (1.0 + bonus) based on nearest lit campfire."""
            best_bonus = 0.0
            for item in lit_campfires:
                if (abs(self._tile_key(ex, ey)[0] - self._tile_key(item["x"], item["y"])[0]) <= 1 and
                    abs(self._tile_key(ex, ey)[1] - self._tile_key(item["x"], item["y"])[1]) <= 1):
                    logs = max(1, min(int(item.get("amount", 1)), 3))
                    best_bonus = max(best_bonus, CAMPFIRE_KI_BONUS.get(logs, 0.0))
            return 1.0 + best_bonus

        for p in self.players.values():
            if p.get("dead") or p.get("knocked_out"):
                self._clear_clairvoyance(p)
                continue
            if p.get("clairvoyance_active"):
                target_type = p.get("clairvoyance_target_type")
                target_id = p.get("clairvoyance_target_id")
                target_owner = p.get("clairvoyance_target_owner")
                if target_type == "player":
                    target = self.players.get(target_id)
                elif target_type == "npc":
                    owner = self.players.get(target_owner)
                    target = owner.get("npcs", {}).get(target_id) if owner else None
                else:
                    target = None
                if not target or target.get("dead") or target.get("knocked_out"):
                    self._clear_clairvoyance(p)
                else:
                    p["ki"] = max(0.0, p.get("ki", 0) - CLAIRVOYANCE_DRAIN_PER_SEC * dt)
                    if p["ki"] <= 0.001:
                        p["ki"] = 0.0
                        self._clear_clairvoyance(p)
            ki = p.get("ki", 0)
            maxKi = p.get("maxKi", KI_MAX_BASE)
            if p.get("charging"):
                stats = self._get_charge_stats(p)
                build_rate = CHARGE_BUILD_RATE * (1.0 + stats["speed_pct"] * 0.01)
                p["charge_power"] = min(1.0, self._get_charge_power(p) + build_rate * dt)
                p["ki"] = max(0.0, ki - CHARGE_KI_DRAIN_RATE * dt)
                p["_ki_regen_accum"] = 0.0
                if p["ki"] <= 0.001:
                    p["ki"] = 0.0
                    p["charging"] = False
            else:
                decay_mult = max(0.05, 1.0 - self._get_charge_stats(p)["decay_pct"] * 0.01)
                p["charge_power"] = max(0.0, self._get_charge_power(p) - CHARGE_DECAY_RATE * decay_mult * dt)
            ki = p.get("ki", 0)
            if ki < maxKi:
                level = max(1, p.get("level", 1))
                rate = KI_REGEN_BASE * (KI_REGEN_LEVEL_SCALE ** (level - 1))
                rate *= _campfire_ki_mult(p["x"], p["y"])
                rate *= self._get_charge_multiplier(p, CHARGE_KI_REGEN_BONUS)
                p["_ki_regen_accum"] = p.get("_ki_regen_accum", 0.0) + rate * dt
                if p["_ki_regen_accum"] >= 1.0:
                    regen = min(int(p["_ki_regen_accum"]), maxKi - ki)
                    p["ki"] = ki + regen
                    p["_ki_regen_accum"] -= regen
            else:
                p["_ki_regen_accum"] = 0.0

        for owner in self.players.values():
            for npc in owner.get("npcs", {}).values():
                if npc.get("dead") or npc.get("knocked_out"):
                    continue
                ki = npc.get("ki", 0)
                maxKi = npc.get("maxKi", KI_MAX_BASE)
                if ki < maxKi:
                    level = max(1, npc.get("level", 1))
                    rate = KI_REGEN_BASE * (KI_REGEN_LEVEL_SCALE ** (level - 1))
                    rate *= _campfire_ki_mult(npc.get("x", 0), npc.get("y", 0))
                    npc["_ki_regen_accum"] = npc.get("_ki_regen_accum", 0.0) + rate * dt
                    if npc["_ki_regen_accum"] >= 1.0:
                        regen = min(int(npc["_ki_regen_accum"]), maxKi - ki)
                        npc["ki"] = ki + regen
                        npc["_ki_regen_accum"] -= regen
                else:
                    npc["_ki_regen_accum"] = 0.0

        for pid, p in self.players.items():
            carried = p.get("carrying")
            if not carried:
                continue
            if p.get("dead") or p.get("knocked_out"):
                self._drop_carried(pid)
                continue
            if carried.get("type") == "player":
                target = self.players.get(carried.get("id"))
            else:
                owner = self.players.get(carried.get("owner"))
                target = owner.get("npcs", {}).get(carried.get("id")) if owner else None
            if not target or target.get("dead") or not target.get("knocked_out"):
                self._drop_carried(pid)
                continue
            target["x"] = p["x"]
            target["y"] = p["y"] + TILE_SIZE * 0.35

        for owner_pid, owner in self.players.items():
            for npc_id, carrier in owner.get("npcs", {}).items():
                carried = carrier.get("carrying")
                if not carried:
                    continue
                if carrier.get("dead") or carrier.get("knocked_out"):
                    self._npc_drop_carried(owner_pid, npc_id)
                    continue
                if carried.get("type") == "player":
                    target = self.players.get(carried.get("id"))
                else:
                    target_owner = self.players.get(carried.get("owner"))
                    target = target_owner.get("npcs", {}).get(carried.get("id")) if target_owner else None
                if not target or target.get("dead") or not target.get("knocked_out"):
                    self._npc_drop_carried(owner_pid, npc_id)
                    continue
                target["x"] = carrier["x"]
                target["y"] = carrier["y"] + TILE_SIZE * 0.35

        # Move players
        world_w = MAP_COLS * TILE_SIZE
        world_h = MAP_ROWS * TILE_SIZE
        for p in self.players.values():
            if p.get("dead") or p.get("knocked_out") or p.get("carried_by") or p.get("meditating"):
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

        # Pickup ground items (skip dead or knocked-out players)
        now = time.time()
        for p in self.players.values():
            if p.get("dead") or p.get("knocked_out") or p.get("carried_by"):
                continue
            remaining = []
            for item in self.ground_items:
                # Intentionally placed logs (for fences) are not auto-picked up
                if item.get("_placed"):
                    remaining.append(item)
                    continue
                # Drop immunity — recently dropped items can't be re-grabbed immediately
                if item.get("_drop_immunity") and now < item["_drop_immunity"]:
                    remaining.append(item)
                    continue
                d = dist(p["x"], p["y"], item["x"], item["y"])
                if d <= PICKUP_DIST:
                    if item.get("resource") == "ArmorElite":
                        if p.get("armor_elite") or p.get("armor_elite_inv"):
                            remaining.append(item)
                        else:
                            p["armor_elite"] = True
                    elif item.get("resource") == "Stone":
                        p["stones"] = p.get("stones", 0) + item.get("amount", 1)
                    else:
                        p["logs"] += item.get("amount", 1)
                else:
                    remaining.append(item)
            self.ground_items = remaining

        for p in self.players.values():
            for npc in p.get("npcs", {}).values():
                if npc.get("dead") or npc.get("knocked_out") or npc.get("carried_by") or npc.get("armor_elite"):
                    continue
                remaining = []
                picked = False
                for item in self.ground_items:
                    if picked or item.get("_placed"):
                        remaining.append(item)
                        continue
                    if item.get("resource") != "ArmorElite":
                        remaining.append(item)
                        continue
                    d = dist(npc["x"], npc["y"], item["x"], item["y"])
                    if d <= PICKUP_DIST:
                        npc["armor_elite"] = True
                        picked = True
                    else:
                        remaining.append(item)
                self.ground_items = remaining

        # Tree regrowth
        for tree in self.trees:
            if tree["chopped"] and tree["regrow_at"] and now >= tree["regrow_at"]:
                tree["chopped"] = False
                tree["regrow_at"] = None

        self.ground_items = [
            item for item in self.ground_items
            if not (item.get("lit") and now >= item.get("burn_until", 0))
        ]

        lit_campfires = [
            item for item in self.ground_items
            if item.get("lit") and item.get("burn_until", 0) > now and self._is_log_item(item)
        ]

        for p in self.players.values():
            if p.get("dead") or p.get("knocked_out") or p.get("carried_by"):
                p["_campfire_heal_accum"] = 0.0
                p["_campfire_last_near"] = 0.0
                continue
            near_fire = any(
                abs(self._tile_key(p["x"], p["y"])[0] - self._tile_key(item["x"], item["y"])[0]) <= CAMPFIRE_HEAL_TILE_RADIUS and
                abs(self._tile_key(p["x"], p["y"])[1] - self._tile_key(item["x"], item["y"])[1]) <= CAMPFIRE_HEAL_TILE_RADIUS
                for item in lit_campfires
            )
            if near_fire and p["hp"] < p["maxHp"]:
                p["_campfire_last_near"] = now
                p["_campfire_heal_accum"] = p.get("_campfire_heal_accum", 0.0) + p["maxHp"] * CAMPFIRE_HEAL_RATE * dt
                if p["_campfire_heal_accum"] >= 1.0:
                    heal = min(int(p["_campfire_heal_accum"]), p["maxHp"] - p["hp"])
                    if heal > 0:
                        p["hp"] += heal
                    p["_campfire_heal_accum"] -= int(p["_campfire_heal_accum"])
            else:
                last_near = p.get("_campfire_last_near", 0.0)
                if now - last_near > CAMPFIRE_HEAL_LINGER:
                    p["_campfire_heal_accum"] = 0.0

            for npc in p.get("npcs", {}).values():
                if npc.get("dead") or npc.get("knocked_out") or npc.get("carried_by"):
                    npc["_campfire_heal_accum"] = 0.0
                    npc["_campfire_last_near"] = 0.0
                    continue
                near_fire = any(
                    abs(self._tile_key(npc["x"], npc["y"])[0] - self._tile_key(item["x"], item["y"])[0]) <= CAMPFIRE_HEAL_TILE_RADIUS and
                    abs(self._tile_key(npc["x"], npc["y"])[1] - self._tile_key(item["x"], item["y"])[1]) <= CAMPFIRE_HEAL_TILE_RADIUS
                    for item in lit_campfires
                )
                if near_fire and npc.get("hp", 0) < npc.get("maxHp", 0):
                    npc["_campfire_last_near"] = now
                    npc["_campfire_heal_accum"] = npc.get("_campfire_heal_accum", 0.0) + npc["maxHp"] * CAMPFIRE_HEAL_RATE * dt
                    if npc["_campfire_heal_accum"] >= 1.0:
                        heal = min(int(npc["_campfire_heal_accum"]), npc["maxHp"] - npc["hp"])
                        if heal > 0:
                            npc["hp"] += heal
                        npc["_campfire_heal_accum"] -= int(npc["_campfire_heal_accum"])
                else:
                    last_near = npc.get("_campfire_last_near", 0.0)
                    if now - last_near > CAMPFIRE_HEAL_LINGER:
                        npc["_campfire_heal_accum"] = 0.0

        # Rock despawn (unmined rocks past their lifespan)
        self.rocks = [r for r in self.rocks if not (not r["mined"] and now >= r["despawn_at"])]
        # Also clean up fully mined rocks (already awarded stone)
        self.rocks = [r for r in self.rocks if not r["mined"]]

        # Rock spawn check (every ROCK_SPAWN_INTERVAL seconds)
        if now - self._last_rock_spawn >= ROCK_SPAWN_INTERVAL:
            self._spawn_rocks()

        # Clean up dead dummies
        to_remove = [did for did, d in self.dummies.items() if d["dead"]]
        for did in to_remove:
            del self.dummies[did]

        # Clean up dead fences/gates
        to_remove = [fid for fid, f in self.fences.items() if f["dead"]]
        for fid in to_remove:
            del self.fences[fid]

        # Clean up dead anvils
        to_remove = [aid for aid, a in self.anvils.items() if a.get("dead")]
        for aid in to_remove:
            del self.anvils[aid]

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
            "rocks": self.rocks,
            "ground_items": self.ground_items,
            "dummies": self.dummies,
            "fences": self.fences,
            "ki_targets": self.ki_targets,
            "anvils": self.anvils,
        }

    def delta(self):
        """Compact state sent every tick."""
        return {
            "type": "state",
            "players": self.players,
            "trees": [t for t in self.trees if t["chopped"] or t.get("_just_regrew")],
            "rocks": self.rocks,
            "ground_items": self.ground_items,
            "dummies": self.dummies,
            "fences": self.fences,
            "anvils": self.anvils,
        }


# Singleton
game = GameState()
