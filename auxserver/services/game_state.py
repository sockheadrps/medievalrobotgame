# game_state.py — Server-authoritative world state for multiplayer.
# Holds all players, trees, ground items, NPCs, dummies.
# Ticked at ~20Hz by the WebSocket broadcast loop.

import logging
import time
import math
import random

logger = logging.getLogger(__name__)

from services.database import (
    load_ground_items, save_ground_items,
    load_dummies, save_dummies,
    load_anvils, save_anvils,
    load_campfires, save_campfires,
    load_buildings, save_buildings,
)
from services.animal_service import animal_manager
from services.crop_service import crop_manager
from services.asset_registry import asset_registry
from core.constants import (
    TILE_SIZE, MAP_COLS, MAP_ROWS,
    PLAYER_SPEED, PLAYER_RUN_SPEED, NPC_SPEED,
    PICKUP_DIST,
    TREE_CHOP_DIST, ROCK_MINE_DIST, ROCK_HITS, ROCK_LIFESPAN_MS,
    KI_MAX_BASE, KI_MAX_PER_LEVEL,
    KI_BLAST_BASE_COST, KI_BLAST_BASE_DMG, KI_BLAST_SCALE,
)
from services.world_data import (
    TREE_POSITIONS, ROCK_SPAWN_POSITIONS, COLLISION_TILES,
    PORTALS, MINECART_PORTALS, WORLD_OBJECT_INSTANCES, init_world_objects,
)
ROCK_LIFESPAN = ROCK_LIFESPAN_MS / 1000  # seconds — despawns if not mined
TREE_REGROW_MIN = 15.0
TREE_REGROW_MAX = 30.0
PVP_ATTACK_RANGE = TILE_SIZE * 2.0  # slightly more generous than client (1.5 tiles) to account for sync lag
PVP_COOLDOWN = 0.6
PLAYER_RESPAWN_TIME = 5.0
KNOCKOUT_MIN_TIME = 10.0
KNOCKOUT_MAX_TIME = 20.0
PVP_XP_KILL = 25
AI_RIVAL_PID = "__ai_rival__"

# Ki / blast constants
KI_DEF_REDUCTION_DIVISOR = 2
KI_SKILL_RESIST_PER_LEVEL = 0.01
KI_SKILL_RESIST_CAP = 0.50
KI_BLAST_RANGE = TILE_SIZE * 4  # longer range than melee
KI_BLAST_COOLDOWN = 1.2  # seconds between blasts
ABSORB_DURATION = 2.0
DEFAULT_KI_MOVES = ["absorb"]

# Rock spawning
ROCK_SPAWN_INTERVAL = 45.0    # seconds
ROCK_SPAWN_CHANCE = 0.45      # 45% per tile per interval

# Barrier constants
BARRIER_BASE_PHYSICAL_REDUCTION = 10
BARRIER_BASE_KI_REDUCTION = 10
BARRIER_UPGRADE_CAP = 30
BARRIER_PROC_KI_COST = 3
BARRIER_PROC_DURATION = 0.22

# Anvil constants
ANVIL_STONE_COST = 5        # stones to place an anvil
REFINE_STONE_COST = 1       # stones consumed per refine attempt

# Crystal constants (simplified refining)
CRYSTAL_CHANCE = 0.30
CRYSTAL_UPGRADE_CHANCE = 0.50
CRYSTAL_UPGRADE_STATS = ["blast_speed", "blast_range", "blast_dmg", "blast_cooldown", "barrier_duration", "barrier_cooldown"]

# Gate & Fence constants
GATE_LOG_COST = 3
FENCE_LOG_COST = 2
FENCE_BASE_HP = 50

# Ki Target constants
KI_TARGET_HP = 5          # hits before it breaks
KI_TARGET_BREAK_CHANCE = 0.40  # 40% chance to break per blast hit
KI_TARGET_LOG_COST = 5
KI_TARGET_LEARN_CHANCE = 1.0 / 25.0  # 1/25 chance NPC learns per hit

# World object interaction
WORLD_OBJ_MINE_DIST = 80  # px



def _is_collision_tile(x: float, y: float) -> bool:
    """Return True if pixel position (x,y) falls inside a collision tile."""
    col = int(x // TILE_SIZE)
    row = int(y // TILE_SIZE)
    return (col, row) in COLLISION_TILES


def tile_pos(col, row):
    return (col * TILE_SIZE + TILE_SIZE / 2, row * TILE_SIZE + TILE_SIZE / 2)


def dist(x1, y1, x2, y2):
    return math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2)


_next_item_id = 0
_next_dummy_id = 0
_next_anvil_id = 0
_next_campfire_id = 0
_next_building_id = 0

# Campfire constants
CAMPFIRE_RADIUS = TILE_SIZE * 2      # 2 tile radius for regen aura
CAMPFIRE_HP_REGEN = 0.5              # HP per second while near campfire
CAMPFIRE_KI_REGEN_MULT = 2.0        # Ki regen multiplier near campfire
CAMPFIRE_DURATION = {1: 20.0, 2: 40.0, 3: 60.0}  # seconds by log count


def _gen_item_id():
    global _next_item_id
    _next_item_id += 1
    return f"item_{_next_item_id}"


def _gen_dummy_id():
    global _next_dummy_id
    _next_dummy_id += 1
    return f"dummy_{_next_dummy_id}"


def _gen_anvil_id():
    global _next_anvil_id
    _next_anvil_id += 1
    return f"anvil_{_next_anvil_id}"


def _gen_campfire_id():
    global _next_campfire_id
    _next_campfire_id += 1
    return f"campfire_{_next_campfire_id}"


def _gen_building_id():
    global _next_building_id
    _next_building_id += 1
    return f"bld_{_next_building_id}"


class GameState:
    def __init__(self):
        self.players = {}       # pid -> PlayerState
        self.trees = []         # list of TreeState
        self.rocks = []         # list of RockState (dynamically spawned)
        self.ground_items = []  # list of ItemState
        self.npcs = {}          # npc_id -> dict (managed client-side for now)
        self.dummies = {}       # dummy_id -> DummyState
        self.anvils = {}        # anvil_id -> AnvilState
        self.campfires = {}     # campfire_id -> CampfireState
        self.buildings = {}     # building_id -> {id, kind, col, row, map, owner, direction, stored}
        self.pending_carts = [] # [{map, col, row, resource, amount}] — carts arriving via portal
        self.fx_events = []     # transient replicated visual effects
        self.pending_absorbs = []
        self.aftershock_zones = []  # [{x, y, map, radius, dps, expires_at, owner_pid, last_tick}]
        self.background_npcs = {}  # npc_id -> {pid, npc_id, map, task, last_tick}
        self.mine_grids = {}       # pid -> MineGrid (loaded on cave entry)
        from services.instance_manager import InstanceManager
        self.instances = InstanceManager()

        self.paused = False        # admin pause — halts AI brain loop and LLM calls
        self.xp_multipliers = {
            "player": 1.0,
            "npc": 1.0,
            "ai_player": 1.0,
            "ai_npc": 1.0,
        }
        from services.database import get_speed_multiplier as _gsm
        self._speed_multiplier = _gsm()
        self._last_save = 0     # timestamp of last DB save
        self._last_rock_spawn = time.time()  # last rock spawn check
        self._next_rock_id = 0
        self._init_trees()
        self._load_persisted()

        from services.combat import CombatService
        self.combat = CombatService(self)

        from services.resources import ResourceService
        self.resources = ResourceService(self)

        from services.building import BuildingService
        self.building = BuildingService(self)

        from services.npc_manager import NPCManager
        self.npc_manager = NPCManager(self)

        from services.player_manager import PlayerManager
        self.player_manager = PlayerManager(self)

        from services.input_handler import InputHandler
        self.input_handler = InputHandler(self)

        from services.portals import PortalService
        self.portals = PortalService(self)

        # Initialize central map instance (always loaded)
        self.instances.init_central(TREE_POSITIONS, ROCK_SPAWN_POSITIONS)

    def _init_trees(self):
        trees = []
        for i, (col, row) in enumerate(TREE_POSITIONS):
            x, y = tile_pos(col, row)
            trees.append({
                "id": i,
                "x": x, "y": y,
                "chopped": False,
                "regrow_at": None,
            })
        # Store trees in the instance manager for level_01 (backwards compat)
        self.instances._instances["level_01"] = {
            "trees": trees, "rocks": [], "buildings": {},
            "dummies": {}, "anvils": {}, "campfires": {},
            "world_objects": [],
        }
        self.instances.mark_persistent("level_01")
        self.instances.mark_persistent("central")
        # Keep flat self.trees as a reference to the instance list for backwards compat
        self.trees = self.instances._instances["level_01"]["trees"]

    def _load_persisted(self):
        """Load ground items, dummies, anvils, campfires, and buildings from the database."""
        global _next_item_id, _next_dummy_id, _next_anvil_id, _next_campfire_id, _next_building_id
        try:
            self.ground_items = load_ground_items()
            self.dummies = load_dummies()
            self.anvils = load_anvils()
            self.campfires = load_campfires()
            self.buildings = load_buildings()
            # Restore ID counters so new IDs don't collide
            for item in self.ground_items:
                n = int(item["id"].split("_", 1)[1])
                if n >= _next_item_id:
                    _next_item_id = n
            for did in self.dummies:
                n = int(did.split("_", 1)[1])
                if n >= _next_dummy_id:
                    _next_dummy_id = n
            for aid in self.anvils:
                n = int(aid.split("_", 1)[1])
                if n >= _next_anvil_id:
                    _next_anvil_id = n
            for cid in self.campfires:
                n = int(cid.split("_", 1)[1])
                if n >= _next_campfire_id:
                    _next_campfire_id = n
            for bid in self.buildings:
                n = int(bid.split("_", 1)[1])
                if n >= _next_building_id:
                    _next_building_id = n
            ct = len(self.ground_items) + len(self.dummies) + len(self.anvils) + len(self.campfires) + len(self.buildings)
            if ct > 0:
                logger.info("Restored %d ground items, %d dummies, %d anvils, %d campfires, %d buildings from DB",
                            len(self.ground_items), len(self.dummies), len(self.anvils),
                            len(self.campfires), len(self.buildings))
        except Exception as e:
            logger.warning("Failed to load persisted state: %s", e)

    def reset(self):
        """Reset all in-memory state to fresh. Called after DB reset."""
        global _next_item_id, _next_dummy_id, _next_anvil_id, _next_campfire_id, _next_building_id
        self.players.clear()
        self.ground_items.clear()
        self.dummies.clear()
        self.anvils.clear()
        self.campfires.clear()
        self.buildings.clear()
        self.fx_events.clear()
        self.pending_absorbs.clear()
        self.aftershock_zones.clear()
        self.rocks.clear()
        self.xp_multipliers = {
            "player": 1.0,
            "npc": 1.0,
            "ai_player": 1.0,
            "ai_npc": 1.0,
        }
        _next_item_id = 0
        _next_dummy_id = 0
        _next_anvil_id = 0
        _next_campfire_id = 0
        _next_building_id = 0
        # Re-init trees (all unchopped)
        self.trees.clear()
        self._init_trees()
        self._last_rock_spawn = time.time()
        self.resources._spawn_rocks()
        logger.info("In-memory state reset")

    def save_world(self):
        """Persist ground items, dummies, anvils, campfires, buildings, and mine grids to the database."""
        try:
            save_ground_items(self.ground_items)
            save_dummies(self.dummies)
            save_anvils(self.anvils)
            save_campfires(self.campfires)
            save_buildings(self.buildings)
            # Save mine grids
            from services.database import save_mine_state
            for pid, mg in self.mine_grids.items():
                save_mine_state(pid, mg.to_json())
            # Save and unload idle map instances
            self.instances.save_all()
            self.instances.tick_unload()
        except Exception as e:
            logger.warning("Failed to save world state: %s", e)

    def _tick_status_effects(self, dt):
        """Tick burn DoTs, aftershock zones, and vampiric regen on all entities."""
        import time as _t
        now = _t.time()

        # Collect all live entities
        entities = []
        for p in self.players.values():
            if not p.get("dead") and not p.get("knocked_out"):
                entities.append(p)
            for npc in p.get("npcs", {}).values():
                if not npc.get("dead") and not npc.get("knocked_out"):
                    entities.append(npc)

        for e in entities:
            # Burn DoT — tick once per second
            if e.get("burning_until", 0) > now and e.get("burn_dps", 0) > 0:
                last = e.get("burn_last_tick", 0)
                if now - last >= 1.0:
                    e["hp"] = max(0, e.get("hp", 0) - e["burn_dps"])
                    e["burn_last_tick"] = now

            # Vampiric regen (on attacker) — continuous per second
            if e.get("vampiric_until", 0) > now and e.get("vampiric_pct", 0) > 0:
                last_dmg = e.get("vampiric_last_dmg", 0)
                max_hp = e.get("maxHp", 20)
                regen_per_sec = min(last_dmg * e["vampiric_pct"] / 100, max_hp * 0.05)  # cap at 5% max HP/s
                e["hp"] = min(max_hp, e.get("hp", 0) + regen_per_sec * dt)

        # Aftershock zones — tick once per second, remove expired
        live_zones = []
        for zone in self.aftershock_zones:
            if zone["expires_at"] <= now:
                continue
            live_zones.append(zone)
            last = zone.get("last_tick", 0)
            if now - last < 1.0:
                continue
            zone["last_tick"] = now
            zx, zy, zmap = zone["x"], zone["y"], zone["map"]
            rad2 = zone["radius"] ** 2
            for e in entities:
                if e.get("map", "level_01") != zmap:
                    continue
                dx = e.get("x", 0) - zx
                dy = e.get("y", 0) - zy
                if dx * dx + dy * dy <= rad2:
                    e["hp"] = max(0, e.get("hp", 0) - zone["dps"])
        self.aftershock_zones = live_zones

    def add_player(self, pid: str):
        return self.player_manager.add_player(pid)

    def remove_player(self, pid: str):
        return self.player_manager.remove_player(pid)

    def handle_input(self, pid: str, data: dict):
        """Delegate to InputHandler.handle_input."""
        return self.input_handler.handle_input(pid, data)


    # ── Tick ───────────────────────────────────────────────────────────────────

    def tick(self, dt: float):
        """Advance simulation by dt seconds."""
        now = time.time()
        animal_manager.tick(dt)
        crop_manager.tick(dt)

        # Respawn dead players
        for p in self.players.values():
            if p.get("dead") and p.get("respawn_at") and now >= p["respawn_at"]:
                p["dead"] = False
                p["hp"] = p["maxHp"]
                p["ki"] = p.get("maxKi", KI_MAX_BASE)
                p["respawn_at"] = None
                # Respawn at center
                sx, sy = tile_pos(10, 10)
                p["x"] = sx + random.randint(-48, 48)
                p["y"] = sy + random.randint(-48, 48)

        # Knockout recovery — players
        for p in self.players.values():
            if p.get("knocked_out") and p.get("knocked_until") and now >= p["knocked_until"]:
                p["knocked_out"] = False
                p["knocked_until"] = None
                p["hp"] = max(1, p["maxHp"] // 2)
                # Auto-drop if being carried
                if p.get("carried_by"):
                    carrier = self.players.get(p["carried_by"])
                    if carrier:
                        carrier.pop("_carrying", None)
                    p.pop("carried_by", None)

        # Knockout recovery — NPCs
        for owner in self.players.values():
            for npc in owner.get("npcs", {}).values():
                if npc.get("knocked_out") and npc.get("knocked_until") and now >= npc["knocked_until"]:
                    npc["knocked_out"] = False
                    npc["knocked_until"] = None
                    npc["hp"] = max(1, npc.get("maxHp", 1) // 2)
                    # Auto-drop if being carried
                    if npc.get("carried_by"):
                        carrier = self.players.get(npc["carried_by"])
                        if carrier:
                            carrier.pop("_carrying", None)
                        npc.pop("carried_by", None)

        # Carry position sync — carried entities follow their carrier
        for carry_pid, p in self.players.items():
            carrying = p.get("_carrying")
            if not carrying:
                continue
            if carrying["type"] == "npc":
                owner = self.players.get(carrying["owner_id"])
                target = owner.get("npcs", {}).get(carrying["npc_id"]) if owner else None
            elif carrying["type"] == "player":
                target = self.players.get(carrying["target_id"])
            else:
                target = None
            if not target:
                p.pop("_carrying", None)
                continue
            # If target woke up, drop them
            if not target.get("knocked_out"):
                target.pop("carried_by", None)
                p.pop("_carrying", None)
                continue
            # Move carried entity to carrier position (offset slightly)
            target["x"] = p["x"]
            target["y"] = p["y"] - 10

        # Tick meditate / fly Ki drain and HP regen
        for pid, p in self.players.items():
            if p.get("dead") or p.get("knocked_out"):
                p["meditating"] = False
                p["flying"] = False
                continue

            # Meditate: drain Ki, heal HP
            if p.get("meditating"):
                ki = p.get("ki", 0)
                hp = p.get("hp", 0)
                maxHp = p.get("maxHp", 20)
                if ki > 0:
                    drain = 2.0 * dt  # 2 Ki/sec
                    p["ki"] = max(0, ki - drain)
                    # Stop meditating if Ki runs out
                    if p["ki"] <= 0:
                        p["meditating"] = False
                    else:
                        # Heal 1 HP/sec while meditating
                        if hp < maxHp:
                            p["hp"] = min(maxHp, hp + 1.5 * dt)
                else:
                    p["meditating"] = False

            # Fly: drain Ki based on fly skill
            if p.get("flying"):
                ki = p.get("ki", 0)
                if ki > 0:
                    fly_skill = p.get("fly_skill_level", 1)
                    # Drain: starts at 3 Ki/sec, -0.2 per skill level, min 0.5
                    drain_rate = max(0.5, 3.0 - (fly_skill - 1) * 0.2)
                    drain = drain_rate * dt
                    p["ki"] = max(0, ki - drain)
                    # Gain fly XP while flying
                    p["fly_xp"] = p.get("fly_xp", 0.0) + dt
                    xp_per_level = 60.0  # 60 seconds of fly time per skill level
                    while p["fly_xp"] >= xp_per_level:
                        p["fly_xp"] -= xp_per_level
                        p["fly_skill_level"] = p.get("fly_skill_level", 1) + 1
                    # Stop flying if Ki runs out
                    if p["ki"] <= 0:
                        p["flying"] = False
                else:
                    p["flying"] = False

        # Ki regen — scales with level.
        if self.pending_absorbs:
            remaining_absorbs = []
            for absorb in self.pending_absorbs:
                if now >= absorb.get("resolve_at", 0):
                    self.combat._resolve_pending_absorb(absorb)
                else:
                    remaining_absorbs.append(absorb)
            self.pending_absorbs = remaining_absorbs

        KI_REGEN_BASE = 1.0 / 15.0
        KI_REGEN_LEVEL_SCALE = 1.08

        for p in self.players.values():
            if p.get("dead") or p.get("knocked_out"):
                continue
            ki = p.get("ki", 0)
            maxKi = p.get("maxKi", KI_MAX_BASE)
            if ki < maxKi:
                if p.get("ki_regen_suppressed_until", 0) > now:
                    p["_ki_regen_accum"] = 0.0
                    continue
                level = max(1, p.get("level", 1))
                ki_level = max(1, int(p.get("kiSkillLevel", 1) or 1))
                rate = KI_REGEN_BASE * (KI_REGEN_LEVEL_SCALE ** (level - 1)) * (1 + (ki_level - 1) * 0.15)
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
                    if npc.get("ki_regen_suppressed_until", 0) > now:
                        npc["_ki_regen_accum"] = 0.0
                        continue
                    level = max(1, npc.get("level", 1))
                    ki_level = max(1, int(npc.get("kiSkillLevel", 1) or 1))
                    rate = KI_REGEN_BASE * (KI_REGEN_LEVEL_SCALE ** (level - 1)) * (1 + (ki_level - 1) * 0.15)
                    npc["_ki_regen_accum"] = npc.get("_ki_regen_accum", 0.0) + rate * dt
                    if npc["_ki_regen_accum"] >= 1.0:
                        regen = min(int(npc["_ki_regen_accum"]), maxKi - ki)
                        npc["ki"] = ki + regen
                        npc["_ki_regen_accum"] -= regen
                else:
                    npc["_ki_regen_accum"] = 0.0

        # Campfire aura — bonus HP regen + boosted ki regen for nearby actors
        self.building._tick_campfires(dt, now)
        self._tick_status_effects(dt)

        # Move players — use per-map dimensions for correct bounds clamping
        from services.world_data import get_map_dimensions as _get_map_dims
        for move_pid, p in self.players.items():
            if p.get("dead") or p.get("knocked_out"):
                p["vx"] = 0
                p["vy"] = 0
                continue
            if p.get("punching"):
                if now >= p.get("punch_until", 0):
                    p["punching"] = False
                p["vx"] = 0
                p["vy"] = 0
            else:
                # Status effect movement gates
                if p.get("stunned_until", 0) > now:
                    p["vx"] = 0
                    p["vy"] = 0
                    continue
                if p.get("displaced_until", 0) > now:
                    p["vx"] = 0
                    p["vy"] = 0
                    continue
                if p.get("slowed_until", 0) > now:
                    slow = p.get("slow_pct", 0) / 100.0
                    p["vx"] = p.get("vx", 0) * (1 - slow)
                    p["vy"] = p.get("vy", 0) * (1 - slow)
                new_x = p["x"] + p["vx"] * dt
                new_y = p["y"] + p["vy"] * dt

                player_map = p.get("map", "level_01")
                if player_map == "cave_01":
                    # Cave: expanded bounds for mine grid (-15..55 tiles)
                    from services.mine_state import GRID_MIN, GRID_MAX
                    mine_min = GRID_MIN * TILE_SIZE
                    mine_max = GRID_MAX * TILE_SIZE
                    new_x = max(mine_min, min(mine_max, new_x))
                    new_y = max(mine_min, min(mine_max, new_y))
                    # Mine wall collision
                    mg = self.mine_grids.get(move_pid)
                    if mg:
                        dest_col = int(new_x // TILE_SIZE)
                        dest_row = int(new_y // TILE_SIZE)
                        if not mg.is_tile_open(dest_col, dest_row):
                            cur_col = int(p["x"] // TILE_SIZE)
                            cur_row = int(p["y"] // TILE_SIZE)
                            # Only block if we're currently on an open tile
                            # (prevents getting permanently stuck)
                            if mg.is_tile_open(cur_col, cur_row):
                                # Try sliding along X (keep new_x, revert Y)
                                if mg.is_tile_open(dest_col, cur_row):
                                    new_y = p["y"]
                                # Try sliding along Y (revert X, keep new_y)
                                elif mg.is_tile_open(cur_col, dest_row):
                                    new_x = p["x"]
                                # Fully blocked
                                else:
                                    new_x = p["x"]
                                    new_y = p["y"]
                else:
                    _mcols, _mrows = _get_map_dims(player_map)
                    _map_w = _mcols * TILE_SIZE
                    _map_h = _mrows * TILE_SIZE
                    new_x = max(0, min(_map_w, new_x))
                    new_y = max(0, min(_map_h, new_y))
                    # Collision tile check with axis sliding — per-map tile set
                    from services.world_data import get_collision_tiles as _gct
                    _map_collision = _gct(player_map)
                    def _is_col(x, y):
                        return (_map_collision and
                                (int(x // TILE_SIZE), int(y // TILE_SIZE)) in _map_collision)
                    if _is_col(new_x, new_y):
                        # Try sliding along X only
                        if not _is_col(new_x, p["y"]):
                            new_y = p["y"]
                        # Try sliding along Y only
                        elif not _is_col(p["x"], new_y):
                            new_x = p["x"]
                        # Fully blocked
                        else:
                            new_x = p["x"]
                            new_y = p["y"]
                # Fence/gate collision with axis sliding
                if self.building._is_barrier_tile(new_x, new_y, move_pid):
                    if not self.building._is_barrier_tile(new_x, p["y"], move_pid):
                        new_y = p["y"]
                    elif not self.building._is_barrier_tile(p["x"], new_y, move_pid):
                        new_x = p["x"]
                    else:
                        new_x = p["x"]
                        new_y = p["y"]
                p["x"] = new_x
                p["y"] = new_y
                # Portal check
                portal = self.portals.check_portal(p)
                if portal:
                    old_map = p.get("map", "level_01")
                    tx, ty = tile_pos(portal["spawn_col"], portal["spawn_row"])
                    p["x"] = tx
                    p["y"] = ty
                    p["map"] = portal["to_map"]
                    p["vx"] = 0
                    p["vy"] = 0
                    # Track instance occupancy
                    self.instances.player_left(old_map, pid)
                    self.instances.player_entered(portal["to_map"], pid)

        # Move NPCs with _move_target (server-side NPC movement for AI-owned NPCs)
        for npc_owner_pid, owner in self.players.items():
            for npc in owner.get("npcs", {}).values():
                if npc.get("dead") or npc.get("knocked_out"):
                    continue
                mt = npc.get("_move_target")
                if not mt:
                    continue
                tx, ty = mt
                dx_npc = tx - npc["x"]
                dy_npc = ty - npc["y"]
                d = (dx_npc * dx_npc + dy_npc * dy_npc) ** 0.5
                if d < 20:  # arrival threshold
                    npc["x"] = tx
                    npc["y"] = ty
                    npc.pop("_move_target", None)
                    # Fire on_arrive callback
                    cb = npc.pop("_on_arrive", None)
                    if cb:
                        cb()
                else:
                    speed = NPC_SPEED * dt
                    new_nx = npc["x"] + (dx_npc / d) * speed
                    new_ny = npc["y"] + (dy_npc / d) * speed
                    # Fence/gate collision for NPCs (owner's gates let them through)
                    if self.building._is_barrier_tile(new_nx, new_ny, npc_owner_pid):
                        if not self.building._is_barrier_tile(new_nx, npc["y"], npc_owner_pid):
                            new_ny = npc["y"]
                        elif not self.building._is_barrier_tile(npc["x"], new_ny, npc_owner_pid):
                            new_nx = npc["x"]
                        else:
                            new_nx = npc["x"]
                            new_ny = npc["y"]
                    npc["x"] = new_nx
                    npc["y"] = new_ny
                npc.setdefault("map", "level_01")
                portal = self.portals.check_portal(npc)
                if portal:
                    tx2, ty2 = tile_pos(portal["spawn_col"], portal["spawn_row"])
                    npc["x"] = tx2
                    npc["y"] = ty2
                    npc["map"] = portal["to_map"]
                    npc.pop("_move_target", None)

        # Pickup ground items (skip dead or knocked-out players)
        now = time.time()
        for p in self.players.values():
            if p.get("dead") or p.get("knocked_out"):
                continue
            remaining = []
            for item in self.ground_items:
                if item.get("_placed"):
                    remaining.append(item)
                    continue
                if item.get("_drop_immunity") and now < item["_drop_immunity"]:
                    remaining.append(item)
                    continue
                d = dist(p["x"], p["y"], item["x"], item["y"])
                if d <= PICKUP_DIST:
                    if item.get("resource") == "Stone":
                        p["stones"] = p.get("stones", 0) + item.get("amount", 1)
                    else:
                        p["logs"] += item.get("amount", 1)
                else:
                    remaining.append(item)
            self.ground_items = remaining

        # Tree regrowth — iterate all active instances
        for _mk, _inst in self.instances._instances.items():
            for tree in _inst.get("trees", []):
                if tree["chopped"] and tree.get("regrow_at") and now >= tree["regrow_at"]:
                    tree["chopped"] = False
                    tree["regrow_at"] = None

        # Rock despawn (unmined rocks past their lifespan)
        self.rocks = [r for r in self.rocks if not (not r["mined"] and now >= r["despawn_at"])]
        self.rocks = [r for r in self.rocks if not r["mined"]]

        # Rock spawn check (every ROCK_SPAWN_INTERVAL seconds)
        if now - self._last_rock_spawn >= ROCK_SPAWN_INTERVAL:
            self.resources._spawn_rocks()

        # World object respawn
        for wo in WORLD_OBJECT_INSTANCES.values():
            if wo["depleted"] and wo["respawn_at"] and now >= wo["respawn_at"]:
                wo_def = asset_registry.get_world_object(wo["asset_id"])
                wo["depleted"] = False
                wo["hp"] = wo_def.hp if wo_def else wo["maxHp"]
                wo["respawn_at"] = None

        # Clean up dead dummies
        to_remove = [did for did, d in self.dummies.items() if d["dead"]]
        for did in to_remove:
            del self.dummies[did]

        # Clean up dead anvils
        to_remove = [aid for aid, a in self.anvils.items() if a.get("dead")]
        for aid in to_remove:
            del self.anvils[aid]

        # ── Server-side building processing (log cutters, tracks) ─────────
        self.building._tick_buildings(dt, now)

        # ── Background NPC workers (mine/deposit while player is on another map) ──
        self.npc_manager._tick_background_npcs(now)

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
            "anvils": self.anvils,
            "campfires": self.campfires,
            "animals": animal_manager.get_all(),
            "crops": crop_manager.get_all(),
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
            "anvils": self.anvils,
            "campfires": self.campfires,
            "animals": animal_manager.get_all(),
            "crops": crop_manager.get_all(),
        }


# Singleton
game = GameState()
