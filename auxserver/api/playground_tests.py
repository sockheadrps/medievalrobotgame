import json
import time
import uuid
from pathlib import Path
from fastapi import APIRouter, HTTPException, Request
from core.config import BASE_DIR

router = APIRouter()

DATA_DIR = BASE_DIR / "data" / "playground_tests"
INDEX_FILE = DATA_DIR / "index.json"

DATA_DIR.mkdir(parents=True, exist_ok=True)


def _load_index():
    if INDEX_FILE.exists():
        try:
            return json.loads(INDEX_FILE.read_text())
        except Exception:
            return []
    return []


def _save_index(entries):
    INDEX_FILE.write_text(json.dumps(entries, indent=2))


def _summary_from_test(test):
    initial = test.get("initial_state", {}).get("emotions", {})
    final = test.get("final_state", {}).get("emotions", {})
    def _delta(k):
        return round((final.get(k, 0) - initial.get(k, 0)), 4)
    steps = test.get("steps", [])
    escalation_max = 0
    clamp_hits = 0
    for s in steps:
        esc = s.get("escalation") or 0
        escalation_max = max(escalation_max, esc)
        if s.get("clamp_hits"):
            clamp_hits += 1
    return {
        "trust_delta": _delta("trust"),
        "fear_delta": _delta("fear"),
        "anger_delta": _delta("anger"),
        "escalation_max": escalation_max,
        "clamp_hits": clamp_hits,
        "fallbacks": test.get("fallbacks", 0),
        "memory_count": len(test.get("final_state", {}).get("memories", []) or []),
    }


def _series_from_test(test):
    steps = test.get("steps", [])
    initial = test.get("initial_state", {}).get("emotions", {})
    trust = [initial.get("trust", 0)]
    fear = [initial.get("fear", 0)]
    anger = [initial.get("anger", 0)]
    for s in steps:
        after = s.get("after", {})
        if after:
            trust.append(after.get("trust", trust[-1]))
            fear.append(after.get("fear", fear[-1]))
            anger.append(after.get("anger", anger[-1]))
    return {"trust": trust, "fear": fear, "anger": anger}


@router.post("/playground/tests")
async def create_test(request: Request):
    test = await request.json()
    test_id = test.get("id") or f"test_{time.strftime('%Y-%m-%d_%H%M%S')}_{uuid.uuid4().hex[:6]}"
    test["id"] = test_id
    if "created_at" not in test:
        test["created_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    if "summary" not in test:
        test["summary"] = _summary_from_test(test)

    path = DATA_DIR / f"{test_id}.json"
    path.write_text(json.dumps(test, indent=2))

    index = _load_index()
    index_entry = {
        "id": test_id,
        "name": test.get("name", test_id),
        "created_at": test.get("created_at"),
        "mode": test.get("mode"),
        "summary": test.get("summary"),
    }
    # Remove existing entry with same id
    index = [e for e in index if e.get("id") != test_id]
    index.insert(0, index_entry)
    _save_index(index)

    return {"id": test_id, "status": "saved"}


@router.get("/playground/tests")
async def list_tests():
    return {"tests": _load_index()}


@router.get("/playground/tests/{test_id}")
async def get_test(test_id: str):
    path = DATA_DIR / f"{test_id}.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Test not found")
    return json.loads(path.read_text())


@router.get("/playground/compare")
async def compare_tests(id: str, id2: str = None):
    if not id2:
        raise HTTPException(status_code=400, detail="Provide id and id2")
    path_a = DATA_DIR / f"{id}.json"
    path_b = DATA_DIR / f"{id2}.json"
    if not path_a.exists() or not path_b.exists():
        raise HTTPException(status_code=404, detail="Test not found")
    a = json.loads(path_a.read_text())
    b = json.loads(path_b.read_text())

    summary_a = a.get("summary") or _summary_from_test(a)
    summary_b = b.get("summary") or _summary_from_test(b)

    diff = {}
    for key in ["trust_delta", "fear_delta", "anger_delta", "escalation_max", "clamp_hits", "fallbacks", "memory_count"]:
        diff[key] = round((summary_b.get(key, 0) - summary_a.get(key, 0)), 4)

    charts = {
        "a": _series_from_test(a),
        "b": _series_from_test(b),
    }

    return {"a": summary_a, "b": summary_b, "diff": diff, "charts": charts}
