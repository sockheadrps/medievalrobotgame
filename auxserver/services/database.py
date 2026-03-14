# database.py — SQLite persistence for players and NPCs.
# Replaces the old JSON-file-per-entity approach.

import hashlib
import json
import sqlite3
import threading
from pathlib import Path

from core.config import BASE_DIR

DB_PATH = BASE_DIR / "data" / "game.db"
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

# Thread-local connections (SQLite doesn't allow sharing across threads)
_local = threading.local()


def _get_conn() -> sqlite3.Connection:
    if not hasattr(_local, "conn") or _local.conn is None:
        _local.conn = sqlite3.connect(str(DB_PATH))
        _local.conn.row_factory = sqlite3.Row
        _local.conn.execute("PRAGMA journal_mode=WAL")
        _local.conn.execute("PRAGMA foreign_keys=ON")
    return _local.conn


def init_db():
    """Create tables if they don't exist."""
    conn = _get_conn()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS players (
            username TEXT PRIMARY KEY,
            password_hash TEXT DEFAULT '',
            chat_color TEXT DEFAULT '#cccccc',
            x REAL DEFAULT 480,
            y REAL DEFAULT 480,
            hp INTEGER DEFAULT 20,
            max_hp INTEGER DEFAULT 20,
            str INTEGER DEFAULT 1,
            def INTEGER DEFAULT 1,
            level INTEGER DEFAULT 1,
            xp INTEGER DEFAULT 0,
            logs INTEGER DEFAULT 0,
            npc_ids TEXT DEFAULT '[]',
            state_json TEXT DEFAULT '{}'
        );

        CREATE TABLE IF NOT EXISTS npcs (
            id TEXT PRIMARY KEY,
            name TEXT DEFAULT 'NPC',
            x REAL DEFAULT 480,
            y REAL DEFAULT 480,
            stats TEXT DEFAULT '{}',
            soul TEXT DEFAULT '{}'
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS ground_items (
            id TEXT PRIMARY KEY,
            x REAL,
            y REAL,
            resource TEXT DEFAULT 'Wood',
            amount INTEGER DEFAULT 1,
            placed INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS fences (
            id TEXT PRIMARY KEY,
            x REAL,
            y REAL,
            tier INTEGER DEFAULT 1,
            hp INTEGER,
            max_hp INTEGER,
            owner TEXT,
            gate INTEGER DEFAULT 0,
            dead INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS dummies (
            id TEXT PRIMARY KEY,
            x REAL,
            y REAL,
            hp INTEGER,
            max_hp INTEGER,
            dead INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS ki_targets (
            id TEXT PRIMARY KEY,
            x REAL,
            y REAL,
            hp INTEGER,
            max_hp INTEGER,
            owner TEXT,
            dead INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS anvils (
            id TEXT PRIMARY KEY,
            x REAL,
            y REAL,
            owner TEXT,
            dead INTEGER DEFAULT 0
        );
    """)
    conn.commit()

    # Migrate: add columns if missing (for existing databases)
    try:
        conn.execute("ALTER TABLE players ADD COLUMN password_hash TEXT DEFAULT ''")
        conn.commit()
    except sqlite3.OperationalError:
        pass  # column already exists
    try:
        conn.execute("ALTER TABLE players ADD COLUMN chat_color TEXT DEFAULT '#cccccc'")
        conn.commit()
    except sqlite3.OperationalError:
        pass  # column already exists
    try:
        conn.execute("ALTER TABLE players ADD COLUMN llm_model TEXT DEFAULT ''")
        conn.commit()
    except sqlite3.OperationalError:
        pass  # column already exists
    try:
        conn.execute("ALTER TABLE players ADD COLUMN state_json TEXT DEFAULT '{}'")
        conn.commit()
    except sqlite3.OperationalError:
        pass  # column already exists


# ── Player operations ─────────────────────────────────────────────────────────

def _hash_password(password: str) -> str:
    """Simple SHA-256 hash. Not bcrypt, but fine for a game."""
    return hashlib.sha256(password.encode()).hexdigest()


def register_player(username: str, password: str, chat_color: str = "#cccccc") -> dict | None:
    """Create a new account with password. Returns player data or None if username taken."""
    if player_exists(username):
        return None
    conn = _get_conn()
    pw_hash = _hash_password(password)
    conn.execute("""
        INSERT INTO players (username, password_hash, chat_color)
        VALUES (?, ?, ?)
    """, (username, pw_hash, chat_color))
    conn.commit()
    return {"username": username, "npc_ids": [], "chat_color": chat_color}


def authenticate_player(username: str, password: str) -> dict | None:
    """Check password and return player data, or None if wrong.
    Legacy accounts (no password set) will adopt the provided password on first login."""
    conn = _get_conn()
    row = conn.execute("SELECT password_hash FROM players WHERE username = ?", (username,)).fetchone()
    if not row:
        return None
    stored = row["password_hash"]
    pw_hash = _hash_password(password)
    if stored == "" or stored is None:
        # Legacy account — adopt this password
        conn.execute("UPDATE players SET password_hash = ? WHERE username = ?", (pw_hash, username))
        conn.commit()
    elif stored != pw_hash:
        return None
    return load_player(username)


def player_exists(username: str) -> bool:
    conn = _get_conn()
    row = conn.execute("SELECT 1 FROM players WHERE username = ?", (username,)).fetchone()
    return row is not None


def save_player(username: str, data: dict):
    conn = _get_conn()
    npc_ids = json.dumps(data.get("npc_ids", []))
    state_json = json.dumps({
        "ki": data.get("ki", 20),
        "maxKi": data.get("maxKi", 20),
        "inf_ki": data.get("inf_ki", False),
        "blastLevel": data.get("blastLevel", 0),
        "kiSkillLevel": data.get("kiSkillLevel", 1),
        "kiSkillXp": data.get("kiSkillXp", 0),
        "realm_tier": data.get("realm_tier", 0),
        "realm_insight": data.get("realm_insight", 0),
        "realm_crystal_t1": data.get("realm_crystal_t1", 0),
        "ki_upgrades": data.get("ki_upgrades", {}),
        "stones": data.get("stones", 0),
        "bastalite": data.get("bastalite", 0),
        "crystal_pristine": data.get("crystal_pristine", 0),
        "crystal_normal": data.get("crystal_normal", 0),
        "crystal_poor": data.get("crystal_poor", 0),
        "armor_elite": data.get("armor_elite", False),
        "armor_elite_inv": data.get("armor_elite_inv", False),
        "ki_moves": data.get("ki_moves", []),
        "ki_denominations": data.get("ki_denominations", []),
        "ki_known_augments": data.get("ki_known_augments", {}),
        "ki_equipped_augments": data.get("ki_equipped_augments", {}),
        "aura_tint": data.get("aura_tint", 0x4fd6ff),
        "aura_alpha": data.get("aura_alpha", 0.42),
    })
    conn.execute("""
        INSERT INTO players (username, x, y, hp, max_hp, str, def, level, xp, logs, npc_ids, state_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(username) DO UPDATE SET
            x=excluded.x, y=excluded.y, hp=excluded.hp, max_hp=excluded.max_hp,
            str=excluded.str, def=excluded.def, level=excluded.level,
            xp=excluded.xp, logs=excluded.logs, npc_ids=excluded.npc_ids,
            state_json=excluded.state_json
    """, (
        username,
        data.get("x", 480), data.get("y", 480),
        data.get("hp", 20), data.get("maxHp", 20),
        data.get("str", 1), data.get("def", 1),
        data.get("level", 1), data.get("xp", 0),
        data.get("logs", 0), npc_ids, state_json,
    ))
    conn.commit()


def load_player(username: str) -> dict | None:
    conn = _get_conn()
    row = conn.execute("SELECT * FROM players WHERE username = ?", (username,)).fetchone()
    if not row:
        return None
    extra = {}
    try:
        extra = json.loads(row["state_json"]) if "state_json" in row.keys() and row["state_json"] else {}
    except Exception:
        extra = {}
    return {
        "username": row["username"],
        "chat_color": row["chat_color"] if "chat_color" in row.keys() else "#cccccc",
        "llm_model": row["llm_model"] if "llm_model" in row.keys() else "",
        "x": row["x"], "y": row["y"],
        "hp": row["hp"], "maxHp": row["max_hp"],
        "str": row["str"], "def": row["def"],
        "level": row["level"], "xp": row["xp"],
        "logs": row["logs"],
        "npc_ids": json.loads(row["npc_ids"]),
        "ki": extra.get("ki", 20),
        "maxKi": extra.get("maxKi", 20),
        "inf_ki": extra.get("inf_ki", False),
        "blastLevel": extra.get("blastLevel", 0),
        "kiSkillLevel": extra.get("kiSkillLevel", 1),
        "kiSkillXp": extra.get("kiSkillXp", 0),
        "realm_tier": extra.get("realm_tier", 0),
        "realm_insight": extra.get("realm_insight", 0),
        "realm_crystal_t1": extra.get("realm_crystal_t1", 0),
        "ki_upgrades": extra.get("ki_upgrades", {}),
        "stones": extra.get("stones", 0),
        "bastalite": extra.get("bastalite", 0),
        "crystal_pristine": extra.get("crystal_pristine", 0),
        "crystal_normal": extra.get("crystal_normal", 0),
        "crystal_poor": extra.get("crystal_poor", 0),
        "armor_elite": extra.get("armor_elite", False),
        "armor_elite_inv": extra.get("armor_elite_inv", False),
        "ki_moves": extra.get("ki_moves", []),
        "ki_denominations": extra.get("ki_denominations", []),
        "ki_known_augments": extra.get("ki_known_augments", {}),
        "ki_equipped_augments": extra.get("ki_equipped_augments", {}),
        "aura_tint": extra.get("aura_tint", 0x4fd6ff),
        "aura_alpha": extra.get("aura_alpha", 0.42),
    }


def create_player(username: str) -> dict:
    data = {"username": username, "npc_ids": []}
    save_player(username, data)
    return data


def update_llm_model(username: str, model: str):
    conn = _get_conn()
    conn.execute("UPDATE players SET llm_model = ? WHERE username = ?", (model, username))
    conn.commit()
    # Also update the server-wide default so other accounts pick it up
    set_setting("default_model", model)


def get_setting(key: str, default: str = "") -> str:
    conn = _get_conn()
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(key: str, value: str):
    conn = _get_conn()
    conn.execute("""
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
    """, (key, value))
    conn.commit()


def list_players() -> list[str]:
    conn = _get_conn()
    rows = conn.execute("SELECT username FROM players").fetchall()
    return [r["username"] for r in rows]


# ── NPC operations ────────────────────────────────────────────────────────────

def save_npc(npc_id: str, name: str, x: float, y: float, stats: dict, soul: dict) -> dict:
    conn = _get_conn()
    conn.execute("""
        INSERT INTO npcs (id, name, x, y, stats, soul)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            name=excluded.name, x=excluded.x, y=excluded.y,
            stats=excluded.stats, soul=excluded.soul
    """, (npc_id, name, x, y, json.dumps(stats), json.dumps(soul)))
    conn.commit()
    print(f"[db] Saved NPC {npc_id}")
    return {"ok": True, "id": npc_id}


def load_npc(npc_id: str) -> dict | None:
    conn = _get_conn()
    row = conn.execute("SELECT * FROM npcs WHERE id = ?", (npc_id,)).fetchone()
    if not row:
        return None
    data = {
        "id": row["id"],
        "name": row["name"],
        "x": row["x"], "y": row["y"],
        "stats": json.loads(row["stats"]),
        "soul": json.loads(row["soul"]),
    }
    print(f"[db] Loaded NPC {npc_id}")
    return data


def delete_npc(npc_id: str):
    conn = _get_conn()
    conn.execute("DELETE FROM npcs WHERE id = ?", (npc_id,))
    conn.commit()


def list_npcs() -> list[str]:
    conn = _get_conn()
    rows = conn.execute("SELECT id FROM npcs").fetchall()
    return [r["id"] for r in rows]


# ── World-object persistence ──────────────────────────────────────────────────

def save_ground_items(items: list):
    conn = _get_conn()
    conn.execute("DELETE FROM ground_items")
    for item in items:
        conn.execute("""
            INSERT INTO ground_items (id, x, y, resource, amount, placed)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (item["id"], item["x"], item["y"],
              item.get("resource", "Wood"), item.get("amount", 1),
              1 if item.get("_placed") else 0))
    conn.commit()


def load_ground_items() -> list:
    conn = _get_conn()
    rows = conn.execute("SELECT * FROM ground_items").fetchall()
    return [{
        "id": r["id"], "x": r["x"], "y": r["y"],
        "resource": r["resource"], "amount": r["amount"],
        "_placed": bool(r["placed"]),
    } for r in rows]


def save_fences(fences: dict):
    conn = _get_conn()
    conn.execute("DELETE FROM fences")
    for f in fences.values():
        if f.get("dead"):
            continue
        conn.execute("""
            INSERT INTO fences (id, x, y, tier, hp, max_hp, owner, gate, dead)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (f["id"], f["x"], f["y"], f["tier"],
              f["hp"], f["maxHp"], f["owner"],
              1 if f.get("gate") else 0, 1 if f.get("dead") else 0))
    conn.commit()


def load_fences() -> dict:
    conn = _get_conn()
    rows = conn.execute("SELECT * FROM fences WHERE dead = 0").fetchall()
    result = {}
    for r in rows:
        result[r["id"]] = {
            "id": r["id"], "x": r["x"], "y": r["y"],
            "tier": r["tier"], "hp": r["hp"], "maxHp": r["max_hp"],
            "owner": r["owner"], "gate": bool(r["gate"]),
            "dead": False, "last_hit_by": {},
        }
    return result


def save_dummies(dummies: dict):
    conn = _get_conn()
    conn.execute("DELETE FROM dummies")
    for d in dummies.values():
        if d.get("dead"):
            continue
        conn.execute("""
            INSERT INTO dummies (id, x, y, hp, max_hp, dead)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (d["id"], d["x"], d["y"], d["hp"], d["maxHp"],
              1 if d.get("dead") else 0))
    conn.commit()


def load_dummies() -> dict:
    conn = _get_conn()
    rows = conn.execute("SELECT * FROM dummies WHERE dead = 0").fetchall()
    result = {}
    for r in rows:
        result[r["id"]] = {
            "id": r["id"], "x": r["x"], "y": r["y"],
            "hp": r["hp"], "maxHp": r["max_hp"],
            "dead": False, "last_hit_by": {},
        }
    return result


def save_ki_targets(ki_targets: dict):
    conn = _get_conn()
    conn.execute("DELETE FROM ki_targets")
    for t in ki_targets.values():
        if t.get("dead"):
            continue
        conn.execute("""
            INSERT INTO ki_targets (id, x, y, hp, max_hp, owner, dead)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (t["id"], t["x"], t["y"], t["hp"], t["maxHp"],
              t.get("owner", ""), 0))
    conn.commit()


def load_ki_targets() -> dict:
    conn = _get_conn()
    rows = conn.execute("SELECT * FROM ki_targets WHERE dead = 0").fetchall()
    result = {}
    for r in rows:
        result[r["id"]] = {
            "id": r["id"], "x": r["x"], "y": r["y"],
            "hp": r["hp"], "maxHp": r["max_hp"],
            "owner": r["owner"], "dead": False,
        }
    return result


def save_anvils(anvils: dict):
    conn = _get_conn()
    conn.execute("DELETE FROM anvils")
    for a in anvils.values():
        if a.get("dead"):
            continue
        conn.execute("""
            INSERT INTO anvils (id, x, y, owner, dead)
            VALUES (?, ?, ?, ?, ?)
        """, (a["id"], a["x"], a["y"], a.get("owner", ""), 0))
    conn.commit()


def load_anvils() -> dict:
    conn = _get_conn()
    rows = conn.execute("SELECT * FROM anvils WHERE dead = 0").fetchall()
    result = {}
    for r in rows:
        result[r["id"]] = {
            "id": r["id"], "x": r["x"], "y": r["y"],
            "owner": r["owner"], "dead": False,
        }
    return result


# ── Dev-mode seed accounts ────────────────────────────────────────────────────

def ensure_dev_accounts():
    """Create test1/test2 accounts if they don't exist (dev mode only)."""
    for username in ("test1", "test2"):
        if not player_exists(username):
            register_player(username, "test")
            print(f"[db] Created dev account: {username}")
        else:
            # Ensure password is "test" (in case it was changed)
            pw_hash = _hash_password("test")
            conn = _get_conn()
            conn.execute("UPDATE players SET password_hash = ? WHERE username = ?",
                         (pw_hash, username))
            conn.commit()


# ── Migration — import existing JSON files ────────────────────────────────────

def migrate_json_files():
    """One-time import of existing JSON player/NPC files into the database."""
    conn = _get_conn()
    imported = 0

    # Players
    players_dir = BASE_DIR / "data" / "players"
    if players_dir.exists():
        for f in players_dir.glob("*.json"):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                username = data.get("username", f.stem)
                if not player_exists(username):
                    save_player(username, data)
                    imported += 1
            except Exception as e:
                print(f"[migrate] Skipping {f.name}: {e}")

    # NPCs
    npcs_dir = BASE_DIR / "data" / "npcs"
    if npcs_dir.exists():
        for f in npcs_dir.glob("*.json"):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                npc_id = data.get("id", f.stem)
                existing = load_npc(npc_id)
                if not existing:
                    save_npc(
                        npc_id,
                        data.get("name", "NPC"),
                        data.get("x", 480), data.get("y", 480),
                        data.get("stats", {}), data.get("soul", {}),
                    )
                    imported += 1
            except Exception as e:
                print(f"[migrate] Skipping {f.name}: {e}")

    if imported > 0:
        print(f"[migrate] Imported {imported} records from JSON files")
