# ai_player.py — Server-side AI rival player.
# Runs a brain loop that queries the local Ollama LLM for strategic decisions,
# then translates those decisions into game.handle_input() calls.
# Includes a persistent memory system (event log, diary, relationships, strategy).

import asyncio
import json
import math
import random
import time
from pathlib import Path

import httpx

from core.config import BASE_DIR
from services.llm_gateway import chat_completion
from services.game_state import (
    game, TILE_SIZE, TREE_CHOP_DIST, ROCK_MINE_DIST, WORLD_OBJ_MINE_DIST,
    PVP_ATTACK_RANGE, WORLD_OBJECT_INSTANCES,
)
from services.prompt_loader import render_prompt
from services.soul_service import extract_soul_json
from services.accounts import load_player
from services.database import load_npc as db_load_npc

PID = "__ai_rival__"
THINK_INTERVAL = 10.0  # seconds between brain cycles
ARRIVAL_THRESHOLD = 20  # px — must be smaller than PICKUP_DIST (28.8px)
SPAWN_MARGIN = 6  # tiles away from center minimum
NPC_THREAT_RADIUS_TILES = 5
MEMORY_FILE = BASE_DIR / "data" / "ai_rival_memory.json"
DIARY_INTERVAL = 5  # write a diary entry every N think cycles
MAX_EVENT_LOG = 30  # ring buffer size
MAX_DIARY = 10  # max diary entries kept
REFINE_BATCH_SIZE = 100
TARGET_NPC_COUNT = 5
EARLY_GAME_NPC_TARGET = 3

VALID_GOALS = {
    "gather_logs", "build_npc", "train_combat", "gather_stones",
    "refine", "consume_crystal", "attack_player", "talk", "explore",
    "build_dummy", "build_anvil",
}

# Fallback decision when LLM fails or returns garbage
FALLBACK_DECISION = {
    "goal": "gather_logs",
    "target": None,
    "npc_commands": [],
    "speech": None,
    "attitude": "neutral",
    "reason": "Fallback — LLM unavailable.",
}

NPC_NAMES = [
    "Kaito", "Sora", "Riku", "Hana", "Yuki",
    "Akira", "Rei", "Shin", "Taro", "Mika",
]


def _dist(x1, y1, x2, y2):
    return math.hypot(x2 - x1, y2 - y1)


class AIMemory:
    """Persistent memory for the AI rival: event log, diary, relationships, strategy."""

    def __init__(self):
        self.event_log: list[str] = []        # recent events (ring buffer)
        self.diary: list[dict] = []           # [{time, text}] — LLM-generated summaries
        self.relationships: dict[str, dict] = {}  # pid → {attitude, reason, last_seen}
        self.strategy: str = ""               # current strategic plan
        self.identity: str = ""               # AI's chosen name/persona
        self.plan: dict = self._default_plan()
        self._load()

    def _default_plan(self) -> dict:
        return {
            "phase": "early_game",
            "strategy_type": "economic_growth",
            "current_objective": "gather_logs_for_first_npc",
            "objectives": [
                {"goal": "gather_logs", "target_amount": 10, "status": "in_progress"},
                {"goal": "build_npc", "target": EARLY_GAME_NPC_TARGET, "status": "pending"},
                {"goal": "build_dummy", "target": 1, "status": "pending"},
                {"goal": "gather_stones", "target_amount": 5, "status": "pending"},
                {"goal": "build_anvil", "target": 1, "status": "pending"},
                {"goal": "refine_crystals", "target": 3, "status": "pending"},
            ],
            "resource_targets": {"logs": 10, "stones": 5, "crystals": 3},
            "threats": [],
            "alliances": [],
            "last_updated_turn": 0,
        }

    def _normalize_plan(self, plan: dict | None) -> dict:
        base = self._default_plan()
        if not isinstance(plan, dict):
            return base
        normalized = {
            "phase": str(plan.get("phase", base["phase"]))[:32],
            "strategy_type": str(plan.get("strategy_type", plan.get("type", base["strategy_type"])))[:64],
            "current_objective": str(plan.get("current_objective", base["current_objective"]))[:120],
            "resource_targets": dict(base["resource_targets"]),
            "objectives": [],
            "threats": [],
            "alliances": [],
            "last_updated_turn": int(plan.get("last_updated_turn", base["last_updated_turn"]) or 0),
        }
        raw_targets = plan.get("resource_targets")
        if isinstance(raw_targets, dict):
            for key in ("logs", "stones", "crystals"):
                try:
                    normalized["resource_targets"][key] = max(0, int(raw_targets.get(key, normalized["resource_targets"][key]) or 0))
                except (TypeError, ValueError):
                    pass
        raw_objectives = plan.get("objectives")
        if isinstance(raw_objectives, list):
            for entry in raw_objectives[:8]:
                if not isinstance(entry, dict):
                    continue
                objective = {
                    "goal": str(entry.get("goal", ""))[:64],
                    "target_amount": None,
                    "target": None,
                    "status": str(entry.get("status", "pending"))[:32],
                }
                if entry.get("target_amount") is not None:
                    try:
                        objective["target_amount"] = max(0, int(entry.get("target_amount") or 0))
                    except (TypeError, ValueError):
                        objective["target_amount"] = None
                if entry.get("target") is not None:
                    try:
                        objective["target"] = max(0, int(entry.get("target") or 0))
                    except (TypeError, ValueError):
                        objective["target"] = None
                normalized["objectives"].append(objective)
        if not normalized["objectives"]:
            normalized["objectives"] = base["objectives"]
        for key in ("threats", "alliances"):
            raw_list = plan.get(key)
            if isinstance(raw_list, list):
                normalized[key] = [str(item)[:64] for item in raw_list[:8] if str(item).strip()]
        return normalized

    def _load(self):
        """Load memory from disk."""
        if not MEMORY_FILE.exists():
            return
        try:
            data = json.loads(MEMORY_FILE.read_text(encoding="utf-8"))
            self.event_log = data.get("event_log", [])[-MAX_EVENT_LOG:]
            raw_diary = data.get("diary", [])[-MAX_DIARY:]
            # Filter out garbage diary entries on load
            self.diary = [d for d in raw_diary if self._is_valid_diary(d.get("text", ""))]
            if len(self.diary) < len(raw_diary):
                print(f"[AIMemory] Cleaned {len(raw_diary) - len(self.diary)} garbage diary entries")
            self.relationships = data.get("relationships", {})
            self.strategy = data.get("strategy", "")
            self.identity = data.get("identity", "")
            self.plan = self._normalize_plan(data.get("plan"))
            print(f"[AIMemory] Loaded {len(self.event_log)} events, "
                  f"{len(self.diary)} diary entries, "
                  f"{len(self.relationships)} relationships")
        except Exception as e:
            print(f"[AIMemory] Failed to load: {e}")

    def save(self):
        """Persist memory to disk."""
        try:
            MEMORY_FILE.parent.mkdir(parents=True, exist_ok=True)
            data = {
                "event_log": self.event_log[-MAX_EVENT_LOG:],
                "diary": self.diary[-MAX_DIARY:],
                "relationships": self.relationships,
                "strategy": self.strategy,
                "identity": self.identity,
                "plan": self.plan,
                "saved_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            }
            MEMORY_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
        except Exception as e:
            print(f"[AIMemory] Failed to save: {e}")

    def _get_rel(self, pid: str) -> dict:
        existing = self.relationships.get(pid, {})
        rel = {
            "attitude": existing.get("attitude", "neutral"),
            "reason": existing.get("reason", ""),
            "last_seen": existing.get("last_seen", ""),
            "encounter_count": existing.get("encounter_count", 0),
            "messages_received": existing.get("messages_received", 0),
            "hostile_messages": existing.get("hostile_messages", 0),
            "attacks_on_me": existing.get("attacks_on_me", 0),
            "attacks_on_npcs": existing.get("attacks_on_npcs", 0),
            "dummy_hits": existing.get("dummy_hits", 0),
            "knockouts_inflicted": existing.get("knockouts_inflicted", 0),
            "threat_score": existing.get("threat_score", 0),
            "last_message": existing.get("last_message", ""),
            "last_action": existing.get("last_action", ""),
            "notes": list(existing.get("notes", []))[-8:],
        }
        self._refresh_attitude(rel)
        self.relationships[pid] = rel
        return rel

    def _refresh_attitude(self, rel: dict):
        if not isinstance(rel, dict):
            return
        if (
            rel.get("attacks_on_me", 0) > 0
            or rel.get("attacks_on_npcs", 0) > 0
            or rel.get("knockouts_inflicted", 0) > 0
            or rel.get("hostile_messages", 0) > 0
            or rel.get("threat_score", 0) >= 5
        ):
            rel["attitude"] = "hostile"
        elif rel.get("attitude") != "friendly":
            rel["attitude"] = "neutral"

    def log_event(self, text: str):
        """Record a timestamped event."""
        ts = time.strftime("%H:%M:%S")
        self.event_log.append(f"[{ts}] {text}")
        if len(self.event_log) > MAX_EVENT_LOG:
            self.event_log = self.event_log[-MAX_EVENT_LOG:]

    def update_relationship(self, pid: str, attitude: str, reason: str = ""):
        """Update how we feel about a specific player."""
        rel = self._get_rel(pid)
        rel["attitude"] = attitude
        self._refresh_attitude(rel)
        rel["reason"] = reason or rel.get("reason", "")
        rel["last_seen"] = time.strftime("%H:%M:%S")
        rel["encounter_count"] = rel.get("encounter_count", 0) + 1

    def note_message(self, pid: str, text: str):
        rel = self._get_rel(pid)
        rel["messages_received"] = rel.get("messages_received", 0) + 1
        rel["last_seen"] = time.strftime("%H:%M:%S")
        rel["last_message"] = text[:160]
        lowered = text.lower()
        hostile = any(token in lowered for token in ["fight", "kill", "retard", "stupid", "idiot", "leave me alone", "dont send", "don't send", "hate"])
        if hostile:
            rel["hostile_messages"] = rel.get("hostile_messages", 0) + 1
            rel["threat_score"] = rel.get("threat_score", 0) + 2
            rel["reason"] = rel.get("reason") or "Sent hostile messages."
        self._refresh_attitude(rel)
        rel.setdefault("notes", []).append(f"msg: {text[:100]}")
        rel["notes"] = rel["notes"][-8:]

    def note_action(self, pid: str, action: str, detail: str = ""):
        rel = self._get_rel(pid)
        rel["last_seen"] = time.strftime("%H:%M:%S")
        rel["last_action"] = action[:120]
        if action == "attack_me":
            rel["attacks_on_me"] = rel.get("attacks_on_me", 0) + 1
            rel["threat_score"] = rel.get("threat_score", 0) + 4
        elif action == "attack_my_npc":
            rel["attacks_on_npcs"] = rel.get("attacks_on_npcs", 0) + 1
            rel["threat_score"] = rel.get("threat_score", 0) + 5
        elif action == "hit_my_dummy":
            rel["dummy_hits"] = rel.get("dummy_hits", 0) + 1
            rel["threat_score"] = rel.get("threat_score", 0) + 2
        elif action == "knockout_me":
            rel["attacks_on_me"] = rel.get("attacks_on_me", 0) + 1
            rel["knockouts_inflicted"] = rel.get("knockouts_inflicted", 0) + 1
            rel["threat_score"] = rel.get("threat_score", 0) + 8
        elif action == "kill_or_drop_my_npc":
            rel["attacks_on_npcs"] = rel.get("attacks_on_npcs", 0) + 1
            rel["knockouts_inflicted"] = rel.get("knockouts_inflicted", 0) + 1
            rel["threat_score"] = rel.get("threat_score", 0) + 9
        self._refresh_attitude(rel)
        rel.setdefault("notes", []).append(f"{action}: {detail[:100]}")
        rel["notes"] = rel["notes"][-8:]

    @staticmethod
    def _is_valid_diary(text: str) -> bool:
        """Check if a diary entry is valid (not garbage/repetitive)."""
        if not text or len(text) < 20:
            return False
        words = text.split()
        if len(words) > 5 and len(set(words)) <= 3:
            return False
        alpha_chars = sum(1 for c in text if c.isalpha())
        if alpha_chars / len(text) < 0.4:
            return False
        return True

    def add_diary_entry(self, text: str):
        """Add a diary/summary entry."""
        self.diary.append({
            "time": time.strftime("%Y-%m-%d %H:%M:%S"),
            "text": text,
        })
        if len(self.diary) > MAX_DIARY:
            self.diary = self.diary[-MAX_DIARY:]

    def format_for_prompt(self) -> str:
        """Format memory as text for injection into the LLM prompt."""
        parts = []

        if self.identity:
            parts.append(f"YOUR IDENTITY: {self.identity}")

        if self.strategy:
            parts.append(f"CURRENT PLAN: {self.strategy}")
        if self.plan:
            parts.append("PERSISTENT PLAN:\n" + json.dumps(self.plan, indent=2))

        if self.relationships:
            lines = []
            for pid, rel in self.relationships.items():
                self._refresh_attitude(rel)
                lines.append(f"- {pid}: {rel['attitude']}"
                             f" (seen {rel.get('encounter_count', 1)}x"
                             f", threat={rel.get('threat_score', 0)}"
                             f", msgs={rel.get('messages_received', 0)}"
                             f", attacks_me={rel.get('attacks_on_me', 0)}"
                             f", attacks_npcs={rel.get('attacks_on_npcs', 0)}"
                             f"{', ' + rel['reason'] if rel.get('reason') else ''})")
            parts.append("RELATIONSHIPS:\n" + "\n".join(lines))

        if self.diary:
            # Show last 3 diary entries
            recent = self.diary[-3:]
            lines = [f"- [{d['time']}] {d['text']}" for d in recent]
            parts.append("DIARY (recent):\n" + "\n".join(lines))

        if self.event_log:
            # Show last 10 events
            recent = self.event_log[-10:]
            parts.append("RECENT EVENTS:\n" + "\n".join(f"- {e}" for e in recent))

        return "\n\n".join(parts) if parts else ""

    def format_for_dashboard(self) -> str:
        """Human-readable dashboard summary without raw JSON blobs."""
        parts = []

        if self.identity:
            parts.append(f"YOUR IDENTITY: {self.identity}")

        if self.strategy:
            parts.append(f"CURRENT PLAN: {self.strategy}")

        if self.plan:
            phase = self.plan.get("phase", "unknown")
            strategy_type = self.plan.get("strategy_type", "unknown")
            objective = self.plan.get("current_objective", "none")
            targets = self.plan.get("resource_targets", {})
            parts.append(
                "PLAN SUMMARY:\n"
                f"- phase: {phase}\n"
                f"- strategy: {strategy_type}\n"
                f"- current objective: {objective}\n"
                f"- targets: logs {targets.get('logs', 0)}, stones {targets.get('stones', 0)}, crystals {targets.get('crystals', 0)}"
            )

        if self.relationships:
            lines = []
            for pid, rel in self.relationships.items():
                self._refresh_attitude(rel)
                lines.append(f"- {pid}: {rel['attitude']}"
                             f" (seen {rel.get('encounter_count', 1)}x"
                             f", threat={rel.get('threat_score', 0)}"
                             f", msgs={rel.get('messages_received', 0)}"
                             f", attacks_me={rel.get('attacks_on_me', 0)}"
                             f", attacks_npcs={rel.get('attacks_on_npcs', 0)}"
                             f"{', ' + rel['reason'] if rel.get('reason') else ''})")
            parts.append("RELATIONSHIPS:\n" + "\n".join(lines))

        if self.diary:
            recent = self.diary[-3:]
            lines = [f"- [{d['time']}] {d['text']}" for d in recent]
            parts.append("DIARY (recent):\n" + "\n".join(lines))

        if self.event_log:
            recent = self.event_log[-10:]
            parts.append("RECENT EVENTS:\n" + "\n".join(f"- {e}" for e in recent))

        return "\n\n".join(parts) if parts else ""

    def plan_dashboard_view(self) -> dict:
        plan = self._normalize_plan(self.plan)
        objectives = plan.get("objectives", [])
        completed = sum(1 for obj in objectives if obj.get("status") == "completed")
        total = len(objectives)
        progress_pct = round((completed / total) * 100) if total else 0
        current_objective = plan.get("current_objective", "")
        priorities = {
            "defend_against_rivals": "critical",
            "build_npc": "high",
            "build_dummy": "high",
            "gather_logs": "high",
            "gather_stones": "medium",
            "build_anvil": "medium",
            "refine_crystals": "medium",
            "attack_or_control_territory": "high",
        }
        priority = priorities.get(current_objective, "medium")
        objective_rows = []
        for idx, objective in enumerate(objectives, start=1):
            target_amount = objective.get("target_amount")
            target = objective.get("target")
            target_label = ""
            if target_amount is not None:
                target_label = str(target_amount)
            elif target is not None:
                target_label = str(target)
            objective_rows.append({
                "goal": objective.get("goal", "unknown"),
                "status": objective.get("status", "pending"),
                "target_label": target_label,
                "priority": "now" if objective.get("goal") == current_objective else ("done" if objective.get("status") == "completed" else f"next_{idx}"),
            })
        return {
            "phase": plan.get("phase", "unknown"),
            "strategy_type": plan.get("strategy_type", "unknown"),
            "current_objective": current_objective or "none",
            "priority": priority,
            "progress_pct": progress_pct,
            "completed_objectives": completed,
            "total_objectives": total,
            "resource_targets": plan.get("resource_targets", {}),
            "threats": plan.get("threats", []),
            "alliances": plan.get("alliances", []),
            "objectives": objective_rows,
            "last_updated_turn": plan.get("last_updated_turn", 0),
        }

    def get_recent_events_text(self) -> str:
        """Get recent events as plain text for diary summarization."""
        return "\n".join(self.event_log[-15:]) if self.event_log else "Nothing notable happened."


class AIPlayer:
    def __init__(self):
        self._running = False
        self._task = None
        self._thinking = False
        self._pending_immediate_think = False
        self._pending_reactive_speech = None
        self._last_decision = dict(FALLBACK_DECISION)
        self._think_count = 0
        self._move_target = None  # (x, y) — auto-stop when reached
        self._on_arrive = None    # callback when reaching move target
        self._move_running = False
        self._continuous_action = None  # {"type": "mine_rock"|"chop", "target_id": ..., "cooldown": float, "last": 0}
        self._prev_stats = {}     # snapshot for detecting changes
        self._inbox: list[dict] = []  # incoming messages from players
        self._training_core_ids: list[str] = []
        self.memory = AIMemory()

    # ── Lifecycle ──────────────────────────────────────────────────────────────

    def spawn(self):
        """Register the AI rival in the game world, restoring saved state if available."""
        if PID in game.players:
            print(f"[AIPlayer] Already spawned.")
            return

        game.add_player(PID)
        p = game.players[PID]
        p["is_ai_rival"] = True
        p["chatColor"] = "#ff6644"

        # Try to restore saved state
        saved = load_player(PID)
        if saved:
            for key in ("x", "y", "hp", "maxHp", "str", "def", "level", "xp", "logs"):
                if key in saved:
                    p[key] = saved[key]
            p["ki"] = saved.get("ki", p.get("ki", 20))
            p["maxKi"] = saved.get("maxKi", p.get("maxKi", 20))
            p["blastLevel"] = saved.get("blastLevel", 0)
            p["stones"] = saved.get("stones", 0)
            p["crystals"] = saved.get("crystals", 0)
            p["ki_blast_bonuses"] = saved.get("ki_blast_bonuses", p.get("ki_blast_bonuses", {}))
            p["npc_ids"] = saved.get("npc_ids", [])
            # Restore NPC stats from the database
            p["npcs"] = {}
            for npc_id in p["npc_ids"]:
                npc_data = db_load_npc(npc_id)
                if npc_data:
                    stats = npc_data.get("stats", {})
                    npc_state = {
                        "id": npc_id,
                        "name": npc_data.get("name", npc_id),
                        "x": npc_data.get("x", p["x"] + TILE_SIZE * 2),
                        "y": npc_data.get("y", p["y"]),
                        "hp": 20, "maxHp": 20,
                        "ki": 20, "maxKi": 20,
                        "str": 1, "def": 1,
                        "level": 1, "xp": 0,
                        "logs": 0, "maxLogs": 10,
                        "stones": 0, "crystals": 0,
                        "ki_blast_bonuses": {s: 0 for s in ("blast_speed", "blast_range", "blast_dmg", "blast_cooldown", "barrier_duration", "barrier_cooldown")},
                        "ki_moves": ["absorb"],
                        "blastLevel": 0,
                        "kiSkillLevel": 1,
                        "kiSkillXp": 0,
                        "barrier_proc_until": 0.0,
                        "barrier_proc_facing": "down",
                        "knocked_out": False,
                        "dead": False,
                        "owner": PID,
                        "inf_ki": False,
                    }
                    # Overlay saved stats
                    for k, v in stats.items():
                        if k in npc_state:
                            npc_state[k] = v
                    # Ensure full HP on restore
                    npc_state["hp"] = npc_state["maxHp"]
                    npc_state["ki"] = npc_state["maxKi"]
                    p["npcs"][npc_id] = npc_state
                    print(f"[AIPlayer] Restored NPC {npc_id}: Lv{npc_state['level']} STR:{npc_state['str']} DEF:{npc_state['def']}")
                else:
                    print(f"[AIPlayer] NPC {npc_id} not found in DB, skipping")
            # Remove any npc_ids that weren't found
            p["npc_ids"] = [nid for nid in p["npc_ids"] if nid in p["npcs"]]
            print(f"[AIPlayer] Restored saved state (level {p['level']}, {p['logs']} logs, {len(p['npcs'])} NPCs)")
        else:
            # Fresh spawn away from center (center is roughly tile 10,10 = 480,480)
            cx, cy = 10 * TILE_SIZE, 10 * TILE_SIZE
            angle = random.uniform(0, 2 * math.pi)
            dist = (SPAWN_MARGIN + random.randint(2, 6)) * TILE_SIZE
            p["x"] = cx + math.cos(angle) * dist
            p["y"] = cy + math.sin(angle) * dist
            p["npc_ids"] = []
            print(f"[AIPlayer] Fresh spawn at ({p['x']:.0f}, {p['y']:.0f})")

    def start(self):
        """Start the background brain loop."""
        if self._running:
            return
        self._running = True
        self._task = asyncio.ensure_future(self.brain_loop())
        print("[AIPlayer] Brain loop started.")

    def stop(self):
        """Stop the brain loop."""
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
        print("[AIPlayer] Brain loop stopped.")

    def reset(self):
        """Full reset — stop brain, wipe memory, remove from game, re-spawn fresh."""
        self.stop()
        # Remove from game
        game.remove_player(PID)
        # Wipe memory
        self.memory = AIMemory()
        if MEMORY_FILE.exists():
            MEMORY_FILE.unlink()
        # Reset internal state
        self._last_decision = dict(FALLBACK_DECISION)
        self._think_count = 0
        self._move_target = None
        self._on_arrive = None
        self._move_running = False
        self._continuous_action = None
        self._pending_reactive_speech = None
        self._prev_stats = {}
        self._inbox.clear()
        # Re-spawn and start
        self.spawn()
        self.start()
        print("[AIPlayer] Full reset complete.")

    def _current_attitude(self) -> str:
        relationships = self.memory.relationships or {}
        if relationships:
            top_rel = max(
                relationships.values(),
                key=lambda rel: (
                    int(rel.get("threat_score", 0) or 0),
                    int(rel.get("attacks_on_me", 0) or 0) + int(rel.get("attacks_on_npcs", 0) or 0),
                ),
            )
            self.memory._refresh_attitude(top_rel)
            if top_rel.get("attitude") == "hostile":
                return "hostile"
            if top_rel.get("attitude") == "friendly":
                return "friendly"
        return self._last_decision.get("attitude", "neutral")

    def get_dashboard_state(self) -> dict:
        """Return a snapshot of the AI player's state for the dashboard."""
        p = game.players.get(PID, {})
        npcs = {}
        for nid, npc in p.get("npcs", {}).items():
            npcs[nid] = {
                "name": npc.get("name", nid),
                "hp": npc.get("hp", 0), "maxHp": npc.get("maxHp", 20),
                "str": npc.get("str", 1), "def": npc.get("def", 1),
                "level": npc.get("level", 1),
                "logs": npc.get("logs", 0), "stones": npc.get("stones", 0),
                "task": npc.get("_task", "idle"),
                "x": round(npc.get("x", 0)), "y": round(npc.get("y", 0)),
                "dead": npc.get("dead", False),
            }
        return {
            "pid": PID,
            "running": self._running,
            "think_count": self._think_count,
            "last_decision": self._last_decision,
            "mind": {
                "identity": self.memory.identity,
                "strategy": self.memory.strategy,
                "plan": self.memory.plan,
                "current_attitude": self._current_attitude(),
                "memory_summary": self.memory.format_for_dashboard(),
                "relationship_count": len(self.memory.relationships or {}),
                "has_full_npc_soul": False,
            },
            "tracked_players": self.memory.relationships,
            "plan_view": self.memory.plan_dashboard_view(),
            "stats": {
                "x": round(p.get("x", 0)), "y": round(p.get("y", 0)),
                "hp": p.get("hp", 0), "maxHp": p.get("maxHp", 20),
                "ki": p.get("ki", 0), "maxKi": p.get("maxKi", 20),
                "str": p.get("str", 1), "def": p.get("def", 1),
                "level": p.get("level", 1), "xp": p.get("xp", 0),
                "logs": p.get("logs", 0), "stones": p.get("stones", 0),
                "crystals": p.get("crystals", 0),
            },
            "npcs": npcs,
            "memory": {
                "identity": self.memory.identity,
                "strategy": self.memory.strategy,
                "plan": self.memory.plan,
                "relationships": self.memory.relationships,
                "event_log": self.memory.event_log[-20:],
                "diary": self.memory.diary[-5:],
            },
            "inbox": self._inbox[-5:],
        }

    def receive_message(self, from_pid: str, text: str):
        """Queue an incoming message from a player for the AI to process."""
        self._inbox.append({"from": from_pid, "text": text, "time": time.time()})
        # Keep inbox bounded
        if len(self._inbox) > 10:
            self._inbox = self._inbox[-10:]
        self.memory.log_event(f"{from_pid} said to me: \"{text[:100]}\"")
        self.memory.note_message(from_pid, text)
        if self._running:
            if self._thinking:
                self._pending_immediate_think = True
            else:
                asyncio.create_task(self._think())

    # ── Brain loop ─────────────────────────────────────────────────────────────

    async def brain_loop(self):
        """Main async loop — think every THINK_INTERVAL seconds."""
        # Small initial delay to let the game state settle
        await asyncio.sleep(3.0)
        while self._running:
            try:
                await self._think()
            except asyncio.CancelledError:
                break
            except Exception as e:
                print(f"[AIPlayer] brain_loop error: {e}")
            await asyncio.sleep(THINK_INTERVAL)

    async def _think(self):
        """One brain cycle: observe → decide → act → remember."""
        if self._thinking:
            return
        self._thinking = True

        p = game.players.get(PID)
        try:
            if not p:
                print("[AIPlayer] Not in game.players — respawning.")
                self.spawn()
                return

            # Don't think if dead or knocked out
            if p.get("dead") or p.get("knocked_out"):
                self.memory.log_event("I'm down — waiting to recover.")
                return

            self._think_count += 1

            # Detect stat changes since last think (resource gains, HP loss, etc.)
            self._detect_changes(p)
            self._review_plan(p)

            state_ctx = self._build_state()
            self._inbox.clear()  # Clear after building state so messages are seen once
            decision = await self._query_llm(state_ctx)
            if self._pending_reactive_speech and not decision.get("speech"):
                decision["speech"] = self._pending_reactive_speech
                if decision.get("goal") == "explore":
                    decision["goal"] = "talk"
                if not decision.get("reason"):
                    decision["reason"] = "Reacting to a recent combat event."
            self._pending_reactive_speech = None
            if state_ctx.get("interaction_log") and not decision.get("speech"):
                decision["speech"] = self._fallback_chat_reply(state_ctx["interaction_log"][-1])
                if decision.get("goal") == "explore":
                    decision["goal"] = "talk"
                if not decision.get("reason"):
                    decision["reason"] = "Responding to a direct player message."

            # Update attitude/identity from LLM response
            attitude = decision.get("attitude", "neutral")
            if decision.get("speech"):
                self.memory.log_event(f"Said: \"{decision['speech'][:80]}\"")

            # Update relationships based on nearby players
            for np in state_ctx.get("nearby_players", []):
                self.memory.update_relationship(np["id"], attitude)

            # Execute the decision
            self._execute(decision)
            self._last_decision = decision

            goal = decision.get("goal", "explore")
            reason = decision.get("reason", "")
            print(f"[AIPlayer] Think #{self._think_count}: goal={goal} reason={reason[:80]}")

            # Log the final executed decision after server-side overrides.
            self.memory.log_event(f"Decided: {goal} — {reason[:100]}")

            # Periodic diary: every DIARY_INTERVAL cycles, ask LLM to summarize
            if self._think_count % DIARY_INTERVAL == 0:
                await self._write_diary(p)

            # Save memory to disk every few cycles
            if self._think_count % 3 == 0:
                self.memory.save()

            # Snapshot current stats for next comparison
            self._prev_stats = {
                "hp": p["hp"], "logs": p["logs"], "stones": p.get("stones", 0),
                "crystals": p.get("crystals", 0), "level": p["level"],
                "npc_count": len([n for n in p.get("npcs", {}).values()
                                  if not n.get("dead")]),
            }
        finally:
            self._thinking = False
            if self._pending_immediate_think and self._running:
                self._pending_immediate_think = False
                asyncio.create_task(self._think())

    def _fallback_chat_reply(self, inbox_line: str) -> str:
        text = str(inbox_line or '').split(':', 1)[-1].strip().lower()
        if any(word in text for word in ['fight me', 'come fight', '1v1', 'attack me', 'duel']):
            return "If you want a fight, come prove it."
        if any(word in text for word in ['hello', 'hi', 'hey', 'yo', 'sup']):
            return "I hear you. State your business."
        if '?' in text:
            return "Maybe. Depends what you offer."
        return "I heard you."

    def _consume_ai_alerts(self, p: dict):
        alerts = p.pop("_ai_alerts", None)
        if not alerts:
            return
        for alert in alerts:
            if isinstance(alert, str):
                self.memory.log_event(alert)
                continue
            if not isinstance(alert, dict):
                continue
            message = str(alert.get("message", "")).strip()
            speech = str(alert.get("speech", "")).strip()
            source_pid = str(alert.get("source_pid", "")).strip()
            action = str(alert.get("action", "")).strip()
            if message:
                self.memory.log_event(message)
            if source_pid and action:
                self.memory.note_action(source_pid, action, message)
            if speech:
                self._pending_reactive_speech = speech[:120]

    def _detect_changes(self, p: dict):
        """Compare current stats to previous snapshot and log notable changes."""
        self._consume_ai_alerts(p)
        prev = self._prev_stats
        if not prev:
            return

        hp_diff = p["hp"] - prev.get("hp", p["hp"])
        if hp_diff < -3:
            self.memory.log_event(f"Took {-hp_diff} damage! HP now {p['hp']}/{p['maxHp']}")

        log_diff = p["logs"] - prev.get("logs", 0)
        if log_diff > 0:
            self.memory.log_event(f"Gained {log_diff} logs (total: {p['logs']})")

        stone_diff = p.get("stones", 0) - prev.get("stones", 0)
        if stone_diff > 0:
            self.memory.log_event(f"Gained {stone_diff} stones (total: {p.get('stones', 0)})")

        crystal_diff = p.get("crystals", 0) - prev.get("crystals", 0)
        if crystal_diff > 0:
            self.memory.log_event(f"Gained {crystal_diff} crystal(s)!")

        level_diff = p["level"] - prev.get("level", 1)
        if level_diff > 0:
            self.memory.log_event(f"Leveled up to {p['level']}!")

        npc_count = len([n for n in p.get("npcs", {}).values() if not n.get("dead")])
        if npc_count > prev.get("npc_count", 0):
            self.memory.log_event(f"New NPC joined! Now have {npc_count} NPCs.")

    def _review_plan(self, p: dict):
        plan = self.memory._normalize_plan(self.memory.plan)
        alive_npcs = [n for n in p.get("npcs", {}).values() if not n.get("dead") and not n.get("knocked_out")]
        dummy_count = len([d for d in game.dummies.values() if not d.get("dead") and d.get("owner") == PID])
        anvil_count = len([a for a in game.anvils.values() if a.get("owner") == PID]) if hasattr(game, "anvils") else 0
        logs = int(p.get("logs", 0) or 0)
        stones = int(p.get("stones", 0) or 0)
        crystals = int(p.get("crystals", 0) or 0)

        if len(alive_npcs) >= 3 or crystals >= 1 or anvil_count > 0:
            plan["phase"] = "mid_game"
        else:
            plan["phase"] = "early_game"
        if crystals >= 3 and len(alive_npcs) >= 3:
            plan["phase"] = "late_game"
        desired_npc_count = EARLY_GAME_NPC_TARGET if plan["phase"] == "early_game" else TARGET_NPC_COUNT

        threats = []
        alliances = []
        for pid, rel in (self.memory.relationships or {}).items():
            if rel.get("threat_score", 0) >= 5 or rel.get("attitude") == "hostile":
                threats.append(pid)
            elif rel.get("attitude") == "friendly":
                alliances.append(pid)
        plan["threats"] = threats[:8]
        plan["alliances"] = alliances[:8]

        build_objective = None
        for objective in plan.get("objectives", []):
            goal = objective.get("goal")
            status = objective.get("status", "pending")
            if goal == "gather_logs":
                target_amount = objective.get("target_amount") or 10
                objective["status"] = "completed" if logs >= target_amount else ("in_progress" if status != "completed" else status)
            elif goal == "build_npc":
                objective["target"] = desired_npc_count
                target_count = objective["target"]
                objective["status"] = "completed" if len(alive_npcs) >= target_count else ("in_progress" if logs >= 10 or len(alive_npcs) > 0 else "pending")
                build_objective = objective
            elif goal == "build_dummy":
                target_count = objective.get("target") or 1
                objective["status"] = "completed" if dummy_count >= target_count else ("in_progress" if len(alive_npcs) > 0 else "pending")
            elif goal == "gather_stones":
                target_amount = objective.get("target_amount") or 5
                objective["status"] = "completed" if stones >= target_amount else ("in_progress" if anvil_count == 0 and len(alive_npcs) > 0 else "pending")
            elif goal == "build_anvil":
                objective["status"] = "completed" if anvil_count > 0 else ("in_progress" if stones >= 5 else "pending")
            elif goal == "refine_crystals":
                target_amount = objective.get("target") or objective.get("target_amount") or 3
                objective["status"] = "completed" if crystals >= target_amount else ("in_progress" if anvil_count > 0 else "pending")

        if build_objective is None:
            plan.setdefault("objectives", []).insert(1, {
                "goal": "build_npc",
                "target": desired_npc_count,
                "status": "completed" if len(alive_npcs) >= desired_npc_count else ("in_progress" if logs >= 10 or len(alive_npcs) > 0 else "pending"),
            })

        current_objective = None
        for objective in plan.get("objectives", []):
            if objective.get("status") != "completed":
                current_objective = objective.get("goal")
                break
        if not current_objective:
            current_objective = "attack_or_control_territory" if threats else "refine_crystals"
        if self._has_immediate_rival_pressure(p):
            current_objective = "defend_against_rivals"
        plan["current_objective"] = current_objective
        plan["last_updated_turn"] = self._think_count
        self.memory.plan = plan

        if current_objective == "gather_logs":
            self.memory.strategy = "Gather logs to reach the next build threshold, then expand with more NPC labor."
        elif current_objective == "build_npc":
            self.memory.strategy = "Spend current logs on another NPC to increase labor and combat pressure."
        elif current_objective == "build_dummy":
            self.memory.strategy = "Set up a dummy so idle NPCs and I can turn resources into XP."
        elif current_objective == "gather_stones":
            self.memory.strategy = "Shift into stone collection to unlock an anvil and crystal refinement."
        elif current_objective == "build_anvil":
            self.memory.strategy = "Build an anvil immediately to convert stone stock into crystals."
        elif current_objective == "refine_crystals":
            self.memory.strategy = "Refine stones into crystals and cash them in for lasting stat advantages."
        elif current_objective == "defend_against_rivals":
            self.memory.strategy = "A rival is threatening my progress, so I should defend assets and retaliate when efficient."

    def _has_immediate_rival_pressure(self, p: dict) -> bool:
        px, py = p.get("x", 0), p.get("y", 0)
        for pid, rel in (self.memory.relationships or {}).items():
            if rel.get("threat_score", 0) < 5 and rel.get("attitude") != "hostile":
                continue
            other = game.players.get(pid)
            if not other or other.get("dead") or other.get("knocked_out"):
                continue
            if _dist(px, py, other.get("x", 0), other.get("y", 0)) <= TILE_SIZE * 10:
                return True
        return False

    async def _write_diary(self, p: dict):
        """Ask the LLM to summarize recent events into a diary entry."""
        recent_text = self.memory.get_recent_events_text()
        if recent_text == "Nothing notable happened.":
            return
        nearest_rock = self._find_nearest_rock()
        if nearest_rock:
            rock_line = f"Nearest available rock: id {nearest_rock['id']} at {round(_dist(p['x'], p['y'], nearest_rock['x'], nearest_rock['y']))}px."
        else:
            rock_line = "Nearest available rock: none."
        available_rock_count = self._count_available_rocks(p.get("map", "level_01"))

        prompt = (
            "You are an AI player keeping a game diary. "
            "Summarize these recent events in 1-2 sentences from first person. "
            "Focus on what matters strategically — resource progress, threats, plans. "
            "Be concise and in-character.\n"
            "Do not invent mechanics, costs, or goals that are not provided below.\n"
            "Do not contradict the current plan or current stats.\n"
            "Use only these true game facts:\n"
            "- Build NPC costs 10 logs.\n"
            "- Build Training Dummy costs 10 logs.\n"
            "- Build Anvil costs 5 stones.\n"
            "- Refine uses 1 stone at an anvil.\n\n"
            f"Events:\n{recent_text}\n\n"
            f"Current stats: Lv{p['level']} HP:{p['hp']}/{p['maxHp']} "
            f"Logs:{p['logs']} Stones:{p.get('stones',0)} Crystals:{p.get('crystals',0)}\n"
            f"Current strategy: {self.memory.strategy or 'none'}\n"
            f"Current plan phase: {(self.memory.plan or {}).get('phase', 'unknown')}\n"
            f"Current objective: {(self.memory.plan or {}).get('current_objective', 'unknown')}\n"
            f"Plan resource targets: {json.dumps((self.memory.plan or {}).get('resource_targets', {}))}\n"
            f"Available rock count: {available_rock_count}\n"
            f"{rock_line}\n\n"
            "Write the diary entry (plain text, no JSON):"
        )

        try:
            entry = await chat_completion(
                [{"role": "user", "content": prompt}],
                temperature=0.2,
                max_tokens=150,
                timeout=30.0,
            )
            # Clean up — strip quotes/markdown and reject prompt echoes
            entry = entry.strip('"').strip("*").strip()
            if not entry:
                return
            # Reject entries that echo back the prompt or contain garbage
            bad_markers = ["Write the diary entry", "Current stats:", "Plan resource targets:",
                           "Current plan phase:", "Current objective:", "Current strategy:"]
            if any(m in entry for m in bad_markers):
                print(f"[AIPlayer] Diary rejected (prompt echo): {entry[:80]}")
                return
            # Reject entries that are too short
            if len(entry) < 20:
                print(f"[AIPlayer] Diary rejected (too short): {entry[:80]}")
                return
            # Reject repetitive garbage (same char/word repeated many times)
            words = entry.split()
            if len(words) > 5:
                unique_words = set(words)
                if len(unique_words) <= 3:
                    print(f"[AIPlayer] Diary rejected (repetitive): {entry[:80]}")
                    return
            # Reject entries that are mostly non-alpha (timestamps, numbers, punctuation spam)
            alpha_chars = sum(1 for c in entry if c.isalpha())
            if len(entry) > 0 and alpha_chars / len(entry) < 0.4:
                print(f"[AIPlayer] Diary rejected (low alpha ratio): {entry[:80]}")
                return
            self.memory.add_diary_entry(entry)
            print(f"[AIPlayer] Diary: {entry[:120]}")
        except Exception as e:
            print(f"[AIPlayer] Diary write failed: {e}")

    # ── State gathering ────────────────────────────────────────────────────────

    def _build_state(self) -> dict:
        """Gather the AI player's view of the world."""
        p = game.players[PID]
        px, py = p["x"], p["y"]

        # Own stats — keyed as "player" to match prompt template {{player.hp}} etc.
        player = {
            "x": px, "y": py,
            "hp": p["hp"], "maxHp": p["maxHp"],
            "ki": p["ki"], "maxKi": p["maxKi"],
            "str": p["str"], "def": p["def"],
            "level": p["level"], "xp": p["xp"],
            "logs": p["logs"],
            "stones": p["stones"],
            "crystals": p["crystals"],
            "blastLevel": p.get("blastLevel", 0),
            "ki_blast_bonuses": p.get("ki_blast_bonuses", {}),
        }

        # Own NPCs — keyed as "npcs" to match {{#each npcs}}
        npcs = []
        for npc_id, npc in p.get("npcs", {}).items():
            if npc.get("dead") or npc.get("knocked_out"):
                continue
            npcs.append({
                "id": npc_id,
                "name": npc.get("name", npc_id),
                "hp": npc.get("hp", 0),
                "maxHp": npc.get("maxHp", 10),
                "str": npc.get("str", 1),
                "def": npc.get("def", 1),
                "level": npc.get("level", 1),
                "logs": npc.get("logs", 0),
                "stones": npc.get("stones", 0),
                "crystals": npc.get("crystals", 0),
                "x": npc.get("x", px),
                "y": npc.get("y", py),
                "current_task": npc.get("_task", "idle"),
            })

        # Nearby trees (unchopped, within 600px)
        nearby_trees = []
        for t in game.trees:
            if t["chopped"]:
                continue
            d = _dist(px, py, t["x"], t["y"])
            if d < 600:
                nearby_trees.append({"id": t["id"], "x": t["x"], "y": t["y"], "distance": round(d)})
        nearby_trees.sort(key=lambda t: t["distance"])
        nearby_trees = nearby_trees[:8]

        # Nearby rocks (spawned rocks + mapmaker world-object rocks)
        nearby_rocks = []
        for r in game.rocks:
            if r.get("mined"):
                continue
            d = _dist(px, py, r["x"], r["y"])
            if d < 1500:
                nearby_rocks.append({"id": r["id"], "type": "rock", "x": r["x"], "y": r["y"], "distance": round(d)})
        for wo_id, wo in WORLD_OBJECT_INSTANCES.items():
            if wo.get("depleted") or wo.get("asset_id") != "rock":
                continue
            if wo.get("map", "level_01") != p.get("map", "level_01"):
                continue
            d = _dist(px, py, wo["x"], wo["y"])
            if d < 1500:
                nearby_rocks.append({"id": wo_id, "type": "world_object_rock", "x": wo["x"], "y": wo["y"], "distance": round(d)})
        nearby_rocks.sort(key=lambda r: r["distance"])
        nearby_rocks = nearby_rocks[:6]
        nearest_global_rock = self._find_nearest_rock()
        available_rock_count = (
            sum(1 for r in game.rocks if not r.get("mined"))
            + sum(
                1 for wo in WORLD_OBJECT_INSTANCES.values()
                if not wo.get("depleted")
                and wo.get("asset_id") == "rock"
                and wo.get("map", "level_01") == p.get("map", "level_01")
            )
        )

        # Other players (not self)
        nearby_players = []
        for pid, op in game.players.items():
            if pid == PID:
                continue
            if op.get("dead") or op.get("knocked_out"):
                continue
            if op.get("is_ai_rival"):
                continue
            d = _dist(px, py, op["x"], op["y"])
            if d < 800:
                nearby_players.append({
                    "id": pid,
                    "x": op["x"], "y": op["y"],
                    "hp": op["hp"], "maxHp": op["maxHp"],
                    "str": op["str"], "def": op["def"],
                    "level": op["level"],
                    "logs": op["logs"],
                    "distance": round(d),
                    "npc_count": len([n for n in op.get("npcs", {}).values()
                                      if not n.get("dead") and not n.get("knocked_out")]),
                })
        nearby_players.sort(key=lambda p: p["distance"])

        tracked_players = []
        for pid, rel in (self.memory.relationships or {}).items():
            self.memory._refresh_attitude(rel)
            tracked_players.append({
                "id": pid,
                "attitude": rel.get("attitude", "neutral"),
                "reason": rel.get("reason", ""),
                "threat_score": rel.get("threat_score", 0),
                "messages_received": rel.get("messages_received", 0),
                "attacks_on_me": rel.get("attacks_on_me", 0),
                "attacks_on_npcs": rel.get("attacks_on_npcs", 0),
                "dummy_hits": rel.get("dummy_hits", 0),
                "last_message": rel.get("last_message", ""),
                "last_action": rel.get("last_action", ""),
                "notes": rel.get("notes", [])[-4:],
            })
        tracked_players.sort(key=lambda row: (-row["threat_score"], row["id"]))

        # Dummies
        nearby_dummies = []
        for did, dummy in game.dummies.items():
            d = _dist(px, py, dummy["x"], dummy["y"])
            if d < 600:
                nearby_dummies.append({"id": did, "x": dummy["x"], "y": dummy["y"],
                                       "hp": dummy.get("hp", 0), "distance": round(d)})

        # Anvils
        nearby_anvils = []
        for aid, anvil in game.anvils.items():
            d = _dist(px, py, anvil["x"], anvil["y"])
            if d < 600:
                nearby_anvils.append({"id": aid, "x": anvil["x"], "y": anvil["y"], "distance": round(d)})

        # Pending messages from players
        inbox = []
        for msg in self._inbox:
            inbox.append(f"{msg['from']}: {msg['text']}")

        return {
            "player": player,
            "npcs": npcs,
            "nearby_trees": nearby_trees,
            "nearby_rocks": nearby_rocks,
            "nearest_global_rock": (
                {
                    "id": nearest_global_rock["id"],
                    "x": nearest_global_rock["x"],
                    "y": nearest_global_rock["y"],
                    "distance": round(_dist(px, py, nearest_global_rock["x"], nearest_global_rock["y"])),
                } if nearest_global_rock else None
            ),
            "available_rock_count": available_rock_count,
            "nearby_players": nearby_players,
            "nearby_dummies": nearby_dummies,
            "nearby_anvils": nearby_anvils,
            "tracked_players": tracked_players,
            "attitude": self._current_attitude(),
            "think_count": self._think_count,
            "last_goal": self._last_decision.get("goal", "none"),
            "plan": json.dumps(self.memory.plan, indent=2),
            "memory": self.memory.format_for_prompt(),
            "interaction_log": inbox,
        }

    # ── LLM query ──────────────────────────────────────────────────────────────

    async def _query_llm(self, state_context: dict) -> dict:
        """Render the prompt template, call Ollama, parse JSON response."""
        try:
            system_prompt = render_prompt("ai_player_decision", state_context)
        except Exception as e:
            print(f"[AIPlayer] Prompt render error: {e}")
            system_prompt = "You are an AI rival player. Return JSON with your decision."

        user_content = (
            "Decide the AI player's next strategic action for the next ~10 seconds.\n"
            "Return JSON only, no explanation outside the JSON.\n\n"
            f"Current state:\n{json.dumps(state_context, indent=2)}"
        )

        try:
            raw_text = await chat_completion(
                [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_content},
                ],
                temperature=0.4,
                max_tokens=600,
                timeout=60.0,
            )
            print(f"[AIPlayer] LLM raw -> {raw_text[:300]}")

            parsed = extract_soul_json(raw_text)
            if not parsed:
                print("[AIPlayer] Failed to parse JSON from LLM response.")
                return self._fallback_decision(state_context)

            return self._validate_decision(parsed)

        except httpx.TimeoutException:
            print("[AIPlayer] LLM request timed out.")
            return self._fallback_decision(state_context)
        except httpx.HTTPStatusError as e:
            print(f"[AIPlayer] LLM HTTP error: {e.response.status_code}")
            return self._fallback_decision(state_context)
        except Exception as e:
            print(f"[AIPlayer] LLM error: {e}")
            return self._fallback_decision(state_context)

    def _validate_decision(self, raw: dict) -> dict:
        """Sanitize and validate the LLM decision."""
        out = dict(FALLBACK_DECISION)

        goal = raw.get("goal", "")
        if goal in VALID_GOALS:
            out["goal"] = goal

        target = raw.get("target")
        if isinstance(target, dict):
            out["target"] = {
                "type": str(target.get("type", ""))[:20],
                "id": str(target.get("id", ""))[:64] if target.get("id") is not None else None,
            }

        npc_cmds = raw.get("npc_commands")
        if isinstance(npc_cmds, list):
            valid_cmds = []
            for cmd in npc_cmds[:5]:
                if isinstance(cmd, dict):
                    valid_cmds.append({
                        "npc_id": str(cmd.get("npc_id", ""))[:64],
                        "task": str(cmd.get("task", "idle"))[:20],
                    })
            out["npc_commands"] = valid_cmds

        speech = raw.get("speech")
        if isinstance(speech, str) and speech.strip():
            out["speech"] = speech.strip()[:120]

        attitude = raw.get("attitude", "neutral")
        if attitude in ("hostile", "neutral", "friendly"):
            out["attitude"] = attitude

        reason = raw.get("reason")
        if isinstance(reason, str):
            out["reason"] = reason.strip()[:200]

        # Memory updates from LLM
        identity = raw.get("identity")
        if isinstance(identity, str) and identity.strip():
            self.memory.identity = identity.strip()[:100]

        strategy = raw.get("strategy")
        if isinstance(strategy, str) and strategy.strip():
            self.memory.strategy = strategy.strip()[:300]
        elif isinstance(strategy, dict):
            self.memory.plan = self.memory._normalize_plan(strategy)
            if self.memory.plan.get("current_objective"):
                self.memory.strategy = f"{self.memory.plan.get('phase', 'unknown_phase')}: {self.memory.plan.get('current_objective')}"

        plan = raw.get("plan")
        if isinstance(plan, dict):
            self.memory.plan = self.memory._normalize_plan(plan)
            if self.memory.plan.get("current_objective"):
                self.memory.strategy = f"{self.memory.plan.get('phase', 'unknown_phase')}: {self.memory.plan.get('current_objective')}"

        return out

    def _fallback_decision(self, state_ctx: dict) -> dict:
        """Produce a reasonable decision without the LLM."""
        pl = state_ctx.get("player", {})
        logs = pl.get("logs", 0)
        stones = pl.get("stones", 0)
        crystals = pl.get("crystals", 0)
        my_npcs = state_ctx.get("npcs", [])
        nearby_trees = state_ctx.get("nearby_trees", [])
        nearby_rocks = state_ctx.get("nearby_rocks", [])
        nearest_global_rock = state_ctx.get("nearest_global_rock")
        nearby_anvils = state_ctx.get("nearby_anvils", [])

        # Simple priority: build NPC > gather logs > gather stones > refine > explore
        if logs >= 10 and len(my_npcs) == 0:
            return {**FALLBACK_DECISION, "goal": "build_npc", "reason": "Have logs, need NPC."}
        if stones >= 5 and not nearby_anvils:
            return {**FALLBACK_DECISION, "goal": "build_anvil", "reason": "Have stones, need anvil."}
        if stones >= 1 and nearby_anvils:
            anvil = nearby_anvils[0]
            return {**FALLBACK_DECISION, "goal": "refine",
                    "target": {"type": "anvil", "id": anvil["id"]},
                    "reason": "Refine stones at anvil."}
        if crystals >= 1:
            return {**FALLBACK_DECISION, "goal": "consume_crystal", "reason": "Use crystal for upgrade."}
        if nearby_trees:
            tree = nearby_trees[0]
            return {**FALLBACK_DECISION, "goal": "gather_logs",
                    "target": {"type": "tree", "id": str(tree["id"])},
                    "reason": "Gather logs from nearest tree."}
        if nearby_rocks:
            rock = nearby_rocks[0]
            return {**FALLBACK_DECISION, "goal": "gather_stones",
                    "target": {"type": str(rock.get("type") or "rock"), "id": str(rock["id"])},
                    "reason": "Mine nearest rock."}
        if nearest_global_rock:
            return {**FALLBACK_DECISION, "goal": "gather_stones",
                    "target": {"type": str(nearest_global_rock.get("type") or "rock"), "id": str(nearest_global_rock["id"])},
                    "reason": "No local rocks; travel to the nearest available rock."}
        return {**FALLBACK_DECISION, "goal": "explore", "reason": "Nothing nearby, exploring."}

    # ── Action execution ───────────────────────────────────────────────────────

    def _execute(self, decision: dict):
        """Translate an LLM decision into game.handle_input() calls."""
        goal = decision.get("goal", "explore")
        target = decision.get("target")
        p = game.players.get(PID)
        if not p:
            return
        # Clear continuous action unless the new decision matches what we're already doing
        ca = self._continuous_action
        if ca:
            same_action = (
                (goal == "gather_stones" and ca["type"] in ("mine_rock", "mine_world_object_rock")) or
                (goal == "gather_logs" and ca["type"] == "chop") or
                (goal == "refine" and ca["type"] == "refine")
            )
            if not same_action:
                self._continuous_action = None
        current_objective = str((self.memory.plan or {}).get("current_objective", "") or "")
        plan_phase = str((self.memory.plan or {}).get("phase", "early_game") or "early_game")
        nearest_global_rock = self._find_nearest_rock()
        stones_needed = int((self.memory.plan or {}).get("resource_targets", {}).get("stones", 0) or 0)
        need_more_stones = (
            stones_needed > 0
            and p.get("stones", 0) < stones_needed
            and nearest_global_rock is not None
        )
        desired_npc_count = EARLY_GAME_NPC_TARGET if plan_phase == "early_game" else TARGET_NPC_COUNT

        # Sanity overrides — catch cases where the LLM ignores obvious next steps
        npc_count = len([n for n in p.get("npcs", {}).values() if not n.get("dead")])
        if p["logs"] >= 10 and npc_count < desired_npc_count and goal not in ("attack_player", "build_anvil"):
            goal = "build_npc"
            decision["goal"] = goal
            self.memory.log_event(
                f"Override: below NPC target ({npc_count}/{desired_npc_count}) with enough logs, building NPC."
            )
        elif goal == "gather_logs" and p["logs"] >= 5 and npc_count > 0 and not game.dummies:
            goal = "build_dummy"
            decision["goal"] = goal
            self.memory.log_event("Override: have NPCs but no dummies, building training dummy.")
        elif goal == "gather_stones" and p.get("stones", 0) >= 5 and not game.anvils:
            goal = "build_anvil"
            decision["goal"] = goal
            self.memory.log_event("Override: have enough stones, building anvil.")
        elif (
            goal == "gather_stones"
            and p.get("stones", 0) >= 40
            and any(not a.get("dead") for a in game.anvils.values())
            and current_objective not in ("gather_stones", "build_anvil", "defend_against_rivals")
        ):
            goal = "refine"
            decision["goal"] = goal
            self.memory.log_event("Override: have 40+ stones and anvil, refining batch.")
        elif p.get("crystals", 0) >= 1 and goal in ("gather_logs", "gather_stones", "explore", "train_combat", "refine"):
            goal = "consume_crystal"
            decision["goal"] = goal
            self.memory.log_event(f"Override: have {p.get('crystals', 0)} crystal(s), consuming all immediately.")

        # Fix confused LLM: "refine" with no stones or no anvil → gather_stones
        if goal == "refine" and (p.get("stones", 0) < 1 or not any(
                not a.get("dead") for a in game.anvils.values())):
            goal = "gather_stones"
            decision["goal"] = goal
            self.memory.log_event("Override: can't refine (no stones or no anvil), gathering stones.")

        if current_objective == "gather_stones" and goal in ("refine", "explore"):
            goal = "gather_stones"
            decision["goal"] = goal
            self.memory.log_event("Override: current plan requires more stones, gathering instead of refining.")
        elif current_objective == "build_dummy" and p.get("logs", 0) >= 10 and goal != "build_dummy":
            dummy_count = len([d for d in game.dummies.values() if not d.get("dead") and d.get("owner") == PID])
            if dummy_count == 0:
                goal = "build_dummy"
                decision["goal"] = goal
                self.memory.log_event("Override: have logs and need a dummy, building it now.")
        elif current_objective == "build_dummy" and goal in ("refine", "explore") and p.get("logs", 0) < 10:
            goal = "gather_logs"
            decision["goal"] = goal
            self.memory.log_event("Override: current plan requires logs for a dummy, gathering logs.")

        # Override: if the plan currently needs stones and a rock exists anywhere, gather stones
        # unless a nearby threat is forcing combat.
        if (
            need_more_stones
            and current_objective in ("gather_stones", "build_anvil", "refine_crystals", "build_dummy")
            and goal not in ("attack_player", "talk")
            and not self._hostile_player_nearby()
        ):
            goal = "gather_stones"
            decision["goal"] = goal
            decision["target"] = {"type": str(nearest_global_rock.get("type") or "rock"), "id": str(nearest_global_rock["id"])}
            self.memory.log_event(
                f"Override: objective {current_objective} still needs stones, heading to rock {nearest_global_rock['id']}."
            )

        # Override: plan needs stones but AI is stuck training/exploring
        if (
            need_more_stones
            and goal in ("train_combat", "explore")
        ):
            goal = "gather_stones"
            decision["goal"] = goal
            decision["target"] = {"type": str(nearest_global_rock.get("type") or "rock"), "id": str(nearest_global_rock["id"])}
            self.memory.log_event(
                f"Override: plan needs {stones_needed} stones (have {p.get('stones', 0)}), going to rock {nearest_global_rock['id']}."
            )


        px, py = p["x"], p["y"]

        # Chat
        speech = decision.get("speech")
        if speech:
            game.handle_input(PID, {"type": "chat", "text": speech})

        # Execute NPC commands
        npc_commands = decision.get("npc_commands", [])
        self._execute_npc_commands(npc_commands)

        # Main goal execution
        if goal == "gather_logs":
            self._do_gather_logs(target)

        elif goal == "gather_stones":
            self._do_gather_stones(target)

        elif goal == "build_npc":
            self._do_build_npc()

        elif goal == "build_dummy":
            self._do_build_dummy()

        elif goal == "build_anvil":
            self._do_build_anvil()

        elif goal == "refine":
            self._do_refine(target)

        elif goal == "consume_crystal":
            # Batch-consume ALL crystals at once so it doesn't take 15s per crystal
            crystal_count = p.get("crystals", 0)
            for _ in range(crystal_count):
                game.handle_input(PID, {"type": "consume_crystal"})

        elif goal == "attack_player":
            self._do_attack_player(target)

        elif goal == "train_combat":
            self._do_train_combat(target)

        elif goal == "talk":
            pass  # Speech already handled above

        elif goal == "explore":
            self._do_explore()

        else:
            self._do_explore()

    # ── Goal handlers ──────────────────────────────────────────────────────────

    def _do_gather_logs(self, target):
        p = game.players[PID]
        px, py = p["x"], p["y"]

        tree = None
        if target and target.get("type") == "tree" and target.get("id") is not None:
            try:
                tid = int(target["id"])
                for t in game.trees:
                    if t["id"] == tid and not t["chopped"]:
                        tree = t
                        break
            except (ValueError, TypeError):
                pass

        if not tree:
            tree = self._find_nearest_tree()

        if not tree:
            self._do_explore()
            return

        tree_id = tree["id"]
        # Move to the log drop position (slightly below tree center)
        # so the AI both chops and auto-picks up the log
        drop_x, drop_y = tree["x"], tree["y"] + TILE_SIZE * 0.4
        d = _dist(px, py, tree["x"], tree["y"])

        def _start_chopping(tid=tree_id, dx=drop_x, dy=drop_y):
            game.handle_input(PID, {"type": "chop", "tree_id": tid})
            self._continuous_action = {"type": "chop", "target_id": tid, "cooldown": 1.0, "last": time.time()}
            # Walk onto the drop spot to auto-pickup
            self._move_toward(dx, dy)

        if d <= TREE_CHOP_DIST:
            game.handle_input(PID, {"type": "stop"})
            _start_chopping()
        else:
            self._move_toward(drop_x, drop_y, running=d > 200, on_arrive=_start_chopping)

    def _do_gather_stones(self, target):
        p = game.players[PID]
        px, py = p["x"], p["y"]

        rock = None
        rock_wo = None
        if target and target.get("type") == "rock" and target.get("id") is not None:
            try:
                rid = target["id"]
                for r in game.rocks:
                    if str(r["id"]) == str(rid) and not r.get("mined"):
                        rock = r
                        break
            except (ValueError, TypeError):
                pass
        elif target and target.get("type") == "world_object_rock" and target.get("id"):
            wo = WORLD_OBJECT_INSTANCES.get(target["id"])
            if wo and not wo.get("depleted") and wo.get("asset_id") == "rock" and wo.get("map", "level_01") == p.get("map", "level_01"):
                rock_wo = wo

        if not rock and not rock_wo:
            nearest = self._find_nearest_rock()
            if nearest:
                if nearest.get("type") == "world_object_rock":
                    rock_wo = nearest
                else:
                    rock = nearest

        if not rock and not rock_wo:
            self._do_explore()
            return

        if rock_wo:
            wo_id = rock_wo["id"]
            d = _dist(px, py, rock_wo["x"], rock_wo["y"])

            def _start_world_mining(target_wo_id=wo_id):
                game.handle_input(PID, {"type": "stop"})
                game.handle_input(PID, {"type": "interact_world_object", "wo_id": target_wo_id})
                self._continuous_action = {"type": "mine_world_object_rock", "target_id": target_wo_id, "cooldown": 1.0, "last": time.time()}

            if d <= WORLD_OBJ_MINE_DIST:
                _start_world_mining()
            else:
                self._move_toward(rock_wo["x"], rock_wo["y"], running=d > 200, on_arrive=_start_world_mining)
            return

        rock_id = rock["id"]
        d = _dist(px, py, rock["x"], rock["y"])

        def _start_mining(rid=rock_id):
            game.handle_input(PID, {"type": "stop"})
            game.handle_input(PID, {"type": "mine_rock", "rock_id": rid})
            self._continuous_action = {"type": "mine_rock", "target_id": rid, "cooldown": 1.0, "last": time.time()}

        if d <= ROCK_MINE_DIST:
            _start_mining()
        else:
            self._move_toward(rock["x"], rock["y"], running=d > 200, on_arrive=_start_mining)

    def _do_build_npc(self):
        p = game.players[PID]
        if p["logs"] >= 10:
            name = random.choice(NPC_NAMES)
            game.handle_input(PID, {"type": "build_npc", "npc_name": name})
            print(f"[AIPlayer] Building NPC: {name}")
        else:
            # Not enough logs — go gather
            self._do_gather_logs(None)

    def _do_build_dummy(self):
        p = game.players[PID]
        if p["logs"] >= 10:
            game.handle_input(PID, {"type": "build_dummy", "logs": 10})
            print("[AIPlayer] Building training dummy.")
        else:
            self._do_gather_logs(None)

    def _do_build_anvil(self):
        p = game.players[PID]
        if p.get("stones", 0) >= 5:
            game.handle_input(PID, {"type": "build_anvil"})
            print("[AIPlayer] Building anvil.")
        else:
            self._do_gather_stones(None)

    def _do_refine(self, target):
        p = game.players[PID]
        px, py = p["x"], p["y"]

        if p.get("stones", 0) < 1:
            self._do_gather_stones(None)
            return

        anvil = None
        if target and target.get("type") == "anvil" and target.get("id"):
            anvil_data = game.anvils.get(target["id"])
            if anvil_data:
                anvil = {"id": target["id"], **anvil_data}

        if not anvil:
            nearest = self._find_nearest_anvil()
            if nearest:
                anvil = nearest

        if not anvil:
            self._do_build_anvil()
            return

        anvil_id = anvil["id"]
        refine_range = TILE_SIZE * 1.5  # must match server-side check
        d = _dist(px, py, anvil["x"], anvil["y"])

        def _start_refining(aid=anvil_id):
            game.handle_input(PID, {"type": "stop"})
            batch = min(int(p.get("stones", 0) or 0), REFINE_BATCH_SIZE)
            for _ in range(batch):
                game.handle_input(PID, {"type": "refine_rock", "anvil_id": aid})
            self._continuous_action = None
            if batch > 1:
                self.memory.log_event(f"Batch refined {batch} stones at {aid}.")

        if d <= refine_range:
            _start_refining()
        else:
            self._move_toward(anvil["x"], anvil["y"], on_arrive=_start_refining)

    def _do_attack_player(self, target):
        p = game.players[PID]
        px, py = p["x"], p["y"]

        victim = None
        if target and target.get("type") == "player" and target.get("id"):
            vp = game.players.get(target["id"])
            if vp and not vp.get("dead") and not vp.get("knocked_out") and target["id"] != PID:
                victim = vp

        if not victim:
            nearest = self._find_nearest_player()
            if nearest:
                victim = nearest

        if not victim:
            self._do_explore()
            return

        d = _dist(px, py, victim["x"], victim["y"])
        if d <= PVP_ATTACK_RANGE:
            game.handle_input(PID, {"type": "stop"})
            game.handle_input(PID, {"type": "attack_player", "target_id": victim["id"]})
            # Also try ki blast if we have ki
            if p.get("ki", 0) >= 8:
                game.handle_input(PID, {"type": "fire_ki_blast"})
        elif d <= TILE_SIZE * 4 and p.get("ki", 0) >= 8:
            # In ki blast range but not melee range — blast and approach
            game.handle_input(PID, {"type": "fire_ki_blast"})
            self._move_toward(victim["x"], victim["y"], running=True)
        else:
            self._move_toward(victim["x"], victim["y"], running=True)

    def _do_train_combat(self, target):
        p = game.players[PID]
        px, py = p["x"], p["y"]

        dummy = None
        if target and target.get("type") == "dummy" and target.get("id"):
            dd = game.dummies.get(target["id"])
            if dd:
                dummy = {"id": target["id"], **dd}

        if not dummy:
            # Find nearest dummy
            best = None
            best_dist = float("inf")
            for did, dd in game.dummies.items():
                d = _dist(px, py, dd["x"], dd["y"])
                if d < best_dist:
                    best_dist = d
                    best = {"id": did, **dd}
            dummy = best

        if not dummy:
            # No dummies exist — build one if we can
            self._do_build_dummy()
            return

        d = _dist(px, py, dummy["x"], dummy["y"])
        if d <= PVP_ATTACK_RANGE:
            game.handle_input(PID, {"type": "stop"})
            game.handle_input(PID, {"type": "attack_dummy", "dummy_id": dummy["id"]})
        else:
            self._move_toward(dummy["x"], dummy["y"])

    def _do_explore(self):
        """Move to a random nearby location."""
        p = game.players[PID]
        px, py = p["x"], p["y"]
        angle = random.uniform(0, 2 * math.pi)
        dist = random.randint(3, 8) * TILE_SIZE
        tx = px + math.cos(angle) * dist
        ty = py + math.sin(angle) * dist
        # Clamp to reasonable world bounds (0..50 tiles)
        tx = max(TILE_SIZE, min(50 * TILE_SIZE, tx))
        ty = max(TILE_SIZE, min(50 * TILE_SIZE, ty))
        self._move_toward(tx, ty, running=random.random() < 0.3)

    # ── NPC command execution ──────────────────────────────────────────────────

    def _execute_npc_commands(self, commands: list):
        """Translate NPC commands into server-side NPC actions with movement."""
        p = game.players.get(PID)
        if not p:
            return

        commands = self._ensure_stone_gatherer(commands)
        my_npcs = p.get("npcs", {})
        commands = self._prioritize_training_core(commands, my_npcs)
        assigned_ids = set()
        for cmd in commands:
            npc_id = cmd.get("npc_id", "")
            task = cmd.get("task", "idle")
            npc = my_npcs.get(npc_id)
            if not npc or npc.get("dead") or npc.get("knocked_out"):
                continue
            assigned_ids.add(npc_id)

            # Skip if NPC is already doing this task (avoid interrupting)
            if npc.get("_task") == task and npc.get("_move_target"):
                continue

            npc["_task"] = task

            if task == "gather":
                self._npc_gather(npc, npc_id)

            elif task == "gather_stones":
                self._npc_gather_stones(npc, npc_id)

            elif task == "attack":
                self._npc_attack(npc, npc_id)

            elif task == "train":
                self._npc_train(npc, npc_id)

            elif task == "follow":
                npc["_move_target"] = (p["x"], p["y"])
                npc.pop("_on_arrive", None)

            elif task == "idle":
                npc.pop("_move_target", None)
                npc.pop("_on_arrive", None)

        self._assign_fallback_npc_tasks(my_npcs, assigned_ids)

    def _desired_training_core_size(self, living_count: int) -> int:
        if living_count <= 1:
            return 1
        return min(4, max(2, living_count - 1))

    def _select_training_core(self, my_npcs: dict) -> set[str]:
        living = [
            (npc_id, npc) for npc_id, npc in my_npcs.items()
            if npc and not npc.get("dead") and not npc.get("knocked_out")
        ]
        desired = self._desired_training_core_size(len(living))
        if desired <= 0:
            self._training_core_ids = []
            return set()

        current_ids = [npc_id for npc_id in self._training_core_ids if any(npc_id == lid for lid, _ in living)]
        ranked_ids = [
            npc_id for npc_id, _npc in sorted(
                living,
                key=lambda entry: (
                    -(int(entry[1].get("level", 1) or 1)),
                    -(int(entry[1].get("xp", 0) or 0)),
                    -(int(entry[1].get("str", 1) or 1)),
                    entry[0],
                ),
            )
        ]
        for npc_id in ranked_ids:
            if npc_id not in current_ids:
                current_ids.append(npc_id)
            if len(current_ids) >= desired:
                break
        self._training_core_ids = current_ids[:desired]
        return set(self._training_core_ids)

    def _prioritize_training_core(self, commands: list, my_npcs: dict):
        p = game.players.get(PID)
        if not p:
            return commands
        if not any(not dd.get("dead") for dd in game.dummies.values()):
            return commands

        train_core_ids = self._select_training_core(my_npcs)
        if not train_core_ids:
            return commands

        current_objective = str((self.memory.plan or {}).get("current_objective", "") or "")
        stone_target = int((self.memory.plan or {}).get("resource_targets", {}).get("stones", 5) or 0)
        need_stones = (
            p.get("stones", 0) < stone_target
            and self._count_available_rocks(p.get("map", "level_01")) > 0
            and current_objective in ("gather_stones", "build_anvil", "refine_crystals", "build_dummy")
        )

        prioritized = []
        commanded_ids = set()
        for cmd in list(commands or []):
            if not isinstance(cmd, dict):
                continue
            npc_id = cmd.get("npc_id", "")
            task = cmd.get("task", "idle")
            if npc_id:
                commanded_ids.add(npc_id)

            if npc_id in train_core_ids and task not in ("attack",):
                prioritized.append({**cmd, "task": "train"})
                continue

            if task == "train" and npc_id not in train_core_ids:
                prioritized.append({**cmd, "task": "gather_stones" if need_stones else "gather"})
                continue

            prioritized.append(cmd)

        for npc_id in train_core_ids:
            if npc_id not in commanded_ids:
                prioritized.append({"npc_id": npc_id, "task": "train"})
        return prioritized

    def _ensure_stone_gatherer(self, commands: list):
        """If the plan still needs stones, force at least one living NPC onto gather_stones."""
        p = game.players.get(PID)
        if not p:
            return commands
        rocks_exist = self._count_available_rocks(p.get("map", "level_01")) > 0
        if not rocks_exist:
            return commands

        current_objective = str((self.memory.plan or {}).get("current_objective", "") or "")
        stone_target = int((self.memory.plan or {}).get("resource_targets", {}).get("stones", 5) or 0)
        need_stones = p.get("stones", 0) < stone_target and current_objective in (
            "gather_stones", "build_anvil", "refine_crystals", "build_dummy"
        )
        if not need_stones:
            return commands

        cmds = list(commands or [])
        if any(cmd.get("task") == "gather_stones" for cmd in cmds if isinstance(cmd, dict)):
            return cmds

        my_npcs = p.get("npcs", {})
        candidate_id = None
        for npc_id, npc in my_npcs.items():
            if not npc or npc.get("dead") or npc.get("knocked_out"):
                continue
            current_task = npc.get("_task", "idle")
            if current_task in ("attack",):
                continue
            candidate_id = npc_id
            break
        if not candidate_id:
            return cmds

        cmds.append({"npc_id": candidate_id, "task": "gather_stones"})
        self.memory.log_event(f"Override: assigned {my_npcs[candidate_id].get('name', candidate_id)} to gather stones.")
        return cmds

    def _assign_fallback_npc_tasks(self, my_npcs: dict, assigned_ids: set[str]):
        """Keep every living NPC busy even when the LLM omits npc_commands."""
        p = game.players.get(PID)
        if not p:
            return

        living = [
            (npc_id, npc) for npc_id, npc in my_npcs.items()
            if npc and not npc.get("dead") and not npc.get("knocked_out")
        ]
        if not living:
            return

        dummies_exist = any(not dd.get("dead") for dd in game.dummies.values())
        nearby_enemy = self._find_nearest_player(max_dist_tiles=NPC_THREAT_RADIUS_TILES)
        enemies_nearby = nearby_enemy is not None
        rocks_exist = self._count_available_rocks(p.get("map", "level_01")) > 0
        current_objective = str((self.memory.plan or {}).get("current_objective", "") or "")
        stones = p.get("stones", 0)
        stone_target = (self.memory.plan or {}).get("resource_targets", {}).get("stones", 5)
        need_stones = stones < stone_target and rocks_exist and current_objective in (
            "gather_stones", "build_anvil", "refine_crystals", "build_dummy"
        )

        train_core_ids = self._select_training_core(my_npcs) if dummies_exist else set()
        train_budget = len(train_core_ids)
        stone_budget = 0
        if need_stones:
            if len(living) <= 1:
                stone_budget = 1
            elif len(living) == 2:
                stone_budget = 1
            else:
                stone_budget = max(1, min(len(living) - 1, math.ceil(len(living) * 0.5)))
        assignment_notes = []

        living.sort(key=lambda entry: (0 if entry[0] in train_core_ids else 1, entry[0]))

        for npc_id, npc in living:
            if npc_id in assigned_ids:
                continue

            current_task = npc.get("_task", "idle")
            has_move = bool(npc.get("_move_target"))
            if current_task not in ("idle", "", None) and has_move:
                if npc_id in train_core_ids and current_task != "train":
                    pass
                else:
                    continue

            if enemies_nearby:
                npc["_task"] = "attack"
                self._npc_attack(npc, npc_id)
                assignment_notes.append(f"{npc.get('name', npc_id)} attacking nearby enemy")
                continue

            if stone_budget > 0 and current_task not in ("gather_stones", "attack"):
                npc["_task"] = "gather_stones"
                self._npc_gather_stones(npc, npc_id)
                stone_budget -= 1
                assignment_notes.append(f"{npc.get('name', npc_id)} gathering stones")
                continue

            if dummies_exist and train_budget > 0 and npc_id in train_core_ids and current_task != "gather":
                npc["_task"] = "train"
                self._npc_train(npc, npc_id)
                train_budget -= 1
                assignment_notes.append(f"{npc.get('name', npc_id)} training on dummy")
                continue

            npc["_task"] = "gather"
            self._npc_gather(npc, npc_id)
            assignment_notes.append(f"{npc.get('name', npc_id)} gathering logs")

        if assignment_notes:
            note = "; ".join(assignment_notes[:4])
            self.memory.log_event(f"NPC assignments: {note}")

    def _npc_gather(self, npc, npc_id):
        """Send NPC to nearest unchopped tree, chop on arrival, deposit when full, repeat."""
        p = game.players.get(PID)
        npc.pop("_resource_target_id", None)

        def _find_and_go():
            nx, ny = npc.get("x", 0), npc.get("y", 0)
            best_tree = None
            best_dist = float("inf")
            for t in game.trees:
                if t["chopped"]:
                    continue
                d = _dist(nx, ny, t["x"], t["y"])
                if d < best_dist:
                    best_dist = d
                    best_tree = t
            if not best_tree:
                return
            tree_id = best_tree["id"]

            def on_arrive_chop():
                # Chop the tree, crediting logs directly to the NPC
                game.handle_input(PID, {
                    "type": "npc_chop",
                    "tree_id": tree_id,
                    "owner_id": PID,
                    "npc_id": npc_id,
                })
                # Deposit logs to owner when NPC has enough
                if p and npc.get("logs", 0) >= 5:
                    p["logs"] = p.get("logs", 0) + npc["logs"]
                    deposited = npc["logs"]
                    npc["logs"] = 0
                    self.memory.log_event(f"NPC {npc.get('name', npc_id)} deposited {deposited} logs")
                # Auto-continue: find next tree
                _find_and_go()

            npc["_move_target"] = (best_tree["x"], best_tree["y"])
            npc["_on_arrive"] = on_arrive_chop

        _find_and_go()

    def _npc_gather_stones(self, npc, npc_id):
        """Send NPC to nearest minable rock, mine on arrival, deposit stones, repeat."""
        p = game.players.get(PID)

        def _find_and_mine():
            if npc.get("dead") or npc.get("knocked_out"):
                return
            nx, ny = npc.get("x", 0), npc.get("y", 0)
            current_target_id = npc.get("_resource_target_id")
            current_target_type = npc.get("_resource_target_type")
            best_rock = None
            best_world_rock = None
            if current_target_id is not None and current_target_type == "rock":
                for r in game.rocks:
                    if r["id"] == current_target_id and not r.get("mined"):
                        best_rock = r
                        break
            elif current_target_id is not None and current_target_type == "world_object_rock":
                wo = WORLD_OBJECT_INSTANCES.get(current_target_id)
                if wo and not wo.get("depleted") and wo.get("asset_id") == "rock" and wo.get("map", "level_01") == npc.get("map", p.get("map", "level_01")):
                    best_world_rock = wo
            if best_rock is None:
                best_dist = float("inf")
                for r in game.rocks:
                    if r.get("mined"):
                        continue
                    d = _dist(nx, ny, r["x"], r["y"])
                    if d < best_dist:
                        best_dist = d
                        best_rock = r
                for wo_id, wo in WORLD_OBJECT_INSTANCES.items():
                    if wo.get("depleted") or wo.get("asset_id") != "rock":
                        continue
                    if wo.get("map", "level_01") != npc.get("map", p.get("map", "level_01")):
                        continue
                    d = _dist(nx, ny, wo["x"], wo["y"])
                    if d < best_dist:
                        best_dist = d
                        best_rock = None
                        best_world_rock = {"id": wo_id, **wo}
            if not best_rock and not best_world_rock:
                # No rocks available — fall back to gathering logs
                npc.pop("_resource_target_id", None)
                npc.pop("_resource_target_type", None)
                npc["_task"] = "gather"
                self._npc_gather(npc, npc_id)
                return

            if best_world_rock:
                wo_id = best_world_rock["id"]
                npc["_resource_target_id"] = wo_id
                npc["_resource_target_type"] = "world_object_rock"

                def on_arrive_world_mine():
                    game.handle_input(PID, {
                        "type": "npc_interact_world_object",
                        "wo_id": wo_id,
                        "npc_id": npc_id,
                    })
                    if p and npc.get("stones", 0) >= 3:
                        p["stones"] = p.get("stones", 0) + npc["stones"]
                        deposited = npc["stones"]
                        npc["stones"] = 0
                        self.memory.log_event(f"NPC {npc.get('name', npc_id)} deposited {deposited} stones")
                    current = WORLD_OBJECT_INSTANCES.get(wo_id)
                    if current and not current.get("depleted") and current.get("asset_id") == "rock":
                        npc["_move_target"] = (current["x"], current["y"])
                        npc["_on_arrive"] = on_arrive_world_mine
                        return
                    npc.pop("_resource_target_id", None)
                    npc.pop("_resource_target_type", None)
                    _find_and_mine()

                npc["_move_target"] = (best_world_rock["x"], best_world_rock["y"])
                npc["_on_arrive"] = on_arrive_world_mine
                return

            rock_id = best_rock["id"]
            npc["_resource_target_id"] = rock_id
            npc["_resource_target_type"] = "rock"

            def on_arrive_mine():
                game.handle_input(PID, {
                    "type": "npc_mine_rock",
                    "rock_id": rock_id,
                    "npc_id": npc_id,
                })
                # Deposit stones to owner when NPC has enough
                if p and npc.get("stones", 0) >= 3:
                    p["stones"] = p.get("stones", 0) + npc["stones"]
                    deposited = npc["stones"]
                    npc["stones"] = 0
                    self.memory.log_event(f"NPC {npc.get('name', npc_id)} deposited {deposited} stones")
                current = next((r for r in game.rocks if r["id"] == rock_id), None)
                if current and not current.get("mined") and current.get("hits_left", 1) > 0:
                    npc["_move_target"] = (current["x"], current["y"])
                    npc["_on_arrive"] = on_arrive_mine
                    return
                npc.pop("_resource_target_id", None)
                npc.pop("_resource_target_type", None)
                # Continue mining or find next rock
                _find_and_mine()

            npc["_move_target"] = (best_rock["x"], best_rock["y"])
            npc["_on_arrive"] = on_arrive_mine

        _find_and_mine()

    def _npc_attack(self, npc, npc_id):
        """Send NPC to attack nearest non-AI player."""
        nearest = self._find_nearest_player()
        if not nearest:
            return

        def on_arrive_attack():
            game.handle_input(PID, {
                "type": "npc_attack_player",
                "target_id": nearest["id"],
                "str": npc.get("str", 1),
                "npc_id": npc_id,
            })

        npc["_move_target"] = (nearest["x"], nearest["y"])
        npc["_on_arrive"] = on_arrive_attack

    def _npc_train(self, npc, npc_id):
        """Send NPC to nearest training dummy."""
        def _find_and_train():
            best_dummy = None
            best_dist = float("inf")
            nx, ny = npc.get("x", 0), npc.get("y", 0)
            best_did = None
            for did, dd in game.dummies.items():
                if dd.get("dead"):
                    continue
                d = _dist(nx, ny, dd["x"], dd["y"])
                if d < best_dist:
                    best_dist = d
                    best_dummy = dd
                    best_did = did
            if not best_dummy or not best_did:
                npc.pop("_move_target", None)
                npc.pop("_on_arrive", None)
                return

            def on_arrive_train():
                game.handle_input(PID, {
                    "type": "npc_attack_dummy",
                    "dummy_id": best_did,
                    "str": npc.get("str", 1),
                    "npc_id": npc_id,
                })
                current = game.dummies.get(best_did)
                if current and not current.get("dead"):
                    npc["_move_target"] = (current["x"], current["y"])
                    npc["_on_arrive"] = on_arrive_train
                    return
                _find_and_train()

            npc["_move_target"] = (best_dummy["x"], best_dummy["y"])
            npc["_on_arrive"] = on_arrive_train

        _find_and_train()

    # ── Movement ───────────────────────────────────────────────────────────────

    def tick(self):
        """Called every server tick (~20Hz). Keep steering toward the current move target
        and execute continuous actions (mining, chopping) with cooldowns."""
        p = game.players.get(PID)
        if not p:
            return

        # Continuous action processing (mining rocks, chopping trees)
        ca = self._continuous_action
        if ca:
            now = time.time()
            if now - ca.get("last", 0) >= ca["cooldown"]:
                ca["last"] = now
                action_type = ca["type"]
                target_id = ca["target_id"]
                if action_type == "mine_rock":
                    # Check rock still exists and is minable
                    rock = None
                    for r in game.rocks:
                        if r["id"] == target_id and not r.get("mined"):
                            rock = r
                            break
                    if rock:
                        d = _dist(p["x"], p["y"], rock["x"], rock["y"])
                        if d <= ROCK_MINE_DIST:
                            game.handle_input(PID, {"type": "mine_rock", "rock_id": target_id})
                        else:
                            self._continuous_action = None
                    else:
                        self._continuous_action = None
                elif action_type == "mine_world_object_rock":
                    wo = WORLD_OBJECT_INSTANCES.get(target_id)
                    if wo and not wo.get("depleted") and wo.get("asset_id") == "rock" and wo.get("map", "level_01") == p.get("map", "level_01"):
                        d = _dist(p["x"], p["y"], wo["x"], wo["y"])
                        if d <= WORLD_OBJ_MINE_DIST:
                            game.handle_input(PID, {"type": "interact_world_object", "wo_id": target_id})
                        else:
                            self._continuous_action = None
                    else:
                        self._continuous_action = None
                elif action_type == "chop":
                    tree = None
                    for t in game.trees:
                        if t["id"] == target_id and not t["chopped"]:
                            tree = t
                            break
                    if tree:
                        d = _dist(p["x"], p["y"], tree["x"], tree["y"])
                        if d <= TREE_CHOP_DIST:
                            game.handle_input(PID, {"type": "chop", "tree_id": target_id})
                        else:
                            self._continuous_action = None
                    else:
                        self._continuous_action = None
                elif action_type == "refine":
                    anvil = game.anvils.get(target_id)
                    if anvil and not anvil.get("dead"):
                        d = _dist(p["x"], p["y"], anvil["x"], anvil["y"])
                        if d <= TILE_SIZE * 1.5 and p.get("stones", 0) >= 1:
                            game.handle_input(PID, {"type": "refine_rock", "anvil_id": target_id})
                        else:
                            self._continuous_action = None
                    else:
                        self._continuous_action = None

        if not self._move_target:
            return
        tx, ty = self._move_target
        dist = _dist(p["x"], p["y"], tx, ty)
        if dist < ARRIVAL_THRESHOLD:
            game.handle_input(PID, {"type": "stop"})
            self._move_target = None
            self._move_running = False
            # Execute pending action on arrival
            if self._on_arrive:
                cb = self._on_arrive
                self._on_arrive = None
                try:
                    cb()
                except Exception as e:
                    print(f"[AIPlayer] on_arrive error: {e}")
            return

        dx = tx - p["x"]
        dy = ty - p["y"]
        if dist <= 0:
            return
        game.handle_input(PID, {
            "type": "move",
            "dx": dx / dist,
            "dy": dy / dist,
            "running": bool(self._move_running),
        })

    def _move_toward(self, target_x, target_y, running=False, on_arrive=None):
        """Set velocity to move the AI player toward a target point."""
        p = game.players.get(PID)
        if not p:
            return

        dx = target_x - p["x"]
        dy = target_y - p["y"]
        dist = math.hypot(dx, dy)

        if dist < ARRIVAL_THRESHOLD:
            game.handle_input(PID, {"type": "stop"})
            self._move_target = None
            self._on_arrive = None
            self._move_running = False
            if on_arrive:
                on_arrive()
            return

        self._move_target = (target_x, target_y)
        self._on_arrive = on_arrive
        self._move_running = bool(running)

        # Normalize to unit direction
        ndx = dx / dist
        ndy = dy / dist

        game.handle_input(PID, {
            "type": "move",
            "dx": ndx,
            "dy": ndy,
            "running": running,
        })

    # ── Finders ────────────────────────────────────────────────────────────────

    def _find_nearest_tree(self):
        """Find the nearest unchopped tree."""
        p = game.players.get(PID)
        if not p:
            return None
        px, py = p["x"], p["y"]
        best = None
        best_dist = float("inf")
        for t in game.trees:
            if t["chopped"]:
                continue
            d = _dist(px, py, t["x"], t["y"])
            if d < best_dist:
                best_dist = d
                best = t
        return best

    def _find_nearest_rock(self):
        """Find the nearest minable rock."""
        p = game.players.get(PID)
        if not p:
            return None
        px, py = p["x"], p["y"]
        best = None
        best_dist = float("inf")
        for r in game.rocks:
            if r.get("mined"):
                continue
            d = _dist(px, py, r["x"], r["y"])
            if d < best_dist:
                best_dist = d
                best = {**r, "type": "rock"}
        for wo_id, wo in WORLD_OBJECT_INSTANCES.items():
            if wo.get("depleted") or wo.get("asset_id") != "rock":
                continue
            if wo.get("map", "level_01") != p.get("map", "level_01"):
                continue
            d = _dist(px, py, wo["x"], wo["y"])
            if d < best_dist:
                best_dist = d
                best = {"id": wo_id, "x": wo["x"], "y": wo["y"], "type": "world_object_rock"}
        return best

    def _count_available_rocks(self, map_name=None):
        total = sum(1 for r in game.rocks if not r.get("mined"))
        total += sum(
            1 for wo in WORLD_OBJECT_INSTANCES.values()
            if not wo.get("depleted")
            and wo.get("asset_id") == "rock"
            and (map_name is None or wo.get("map", "level_01") == map_name)
        )
        return total

    def _find_nearest_player(self, max_dist_tiles=None):
        """Find the nearest live human player."""
        p = game.players.get(PID)
        if not p:
            return None
        px, py = p["x"], p["y"]
        best = None
        best_dist = float("inf")
        for pid, op in game.players.items():
            if pid == PID:
                continue
            if op.get("dead") or op.get("knocked_out"):
                continue
            if op.get("is_ai_rival"):
                continue
            d = _dist(px, py, op["x"], op["y"])
            if max_dist_tiles is not None and d > max_dist_tiles * TILE_SIZE:
                continue
            if d < best_dist:
                best_dist = d
                best = op
        return best

    def _find_nearest_anvil(self):
        """Find the nearest anvil."""
        p = game.players.get(PID)
        if not p:
            return None
        px, py = p["x"], p["y"]
        best = None
        best_dist = float("inf")
        for aid, anvil in game.anvils.items():
            d = _dist(px, py, anvil["x"], anvil["y"])
            if d < best_dist:
                best_dist = d
                best = {"id": aid, **anvil}
        return best


# Singleton
ai_player = AIPlayer()
