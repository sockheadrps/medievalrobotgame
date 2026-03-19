import os
import sys
from pathlib import Path

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, StreamingResponse, Response
from fastapi.staticfiles import StaticFiles

# Ensure local package-style imports (api/, core/, services/) resolve
# regardless of whether uvicorn is started from repo root or auxserver/.
THIS_DIR = Path(__file__).resolve().parent
if str(THIS_DIR) not in sys.path:
    sys.path.insert(0, str(THIS_DIR))

from api.maps import router as maps_router
from api.soul import router as soul_router
from api.ws import router as ws_router
from api.accounts import router as accounts_router
from api.playground_tests import router as playground_tests_router
from api.assets import router as assets_router
from core.config import STATIC_DIR, TEMPLATES_DIR, DEV_MODE, ASSETS_DIR, templates, LLM_CHAT_URL, LLM_API_KEY, MODEL
from services.database import init_db, migrate_json_files, ensure_dev_accounts
from services.asset_registry import asset_registry
from services.game_state import game, init_world_objects

app = FastAPI()

# Initialize SQLite database and migrate any existing JSON files
init_db()
migrate_json_files()
asset_registry.load_all(ASSETS_DIR)
init_world_objects()

if DEV_MODE:
    ensure_dev_accounts()


@app.on_event("shutdown")
def shutdown_save():
    """Save world state to DB on server shutdown."""
    print("[main] Saving world state before shutdown...")
    game.save_world()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
app.mount("/templates", StaticFiles(directory=str(TEMPLATES_DIR)), name="templates")
app.mount("/assets", StaticFiles(directory=str(ASSETS_DIR)), name="assets")

app.include_router(soul_router)
app.include_router(maps_router)
app.include_router(ws_router)
app.include_router(accounts_router)
app.include_router(playground_tests_router)
app.include_router(assets_router)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/api/debug/buildings")
def debug_buildings():
    """Dump all building state for debugging conveyors."""
    result = {}
    for bid, b in game.buildings.items():
        result[bid] = {
            "kind": b["kind"],
            "col": b["col"], "row": b["row"],
            "map": b.get("map", "level_01"),
            "direction": b.get("direction", ""),
            "out_direction": b.get("out_direction", ""),
            "held": b.get("_held"),
            "stored": b.get("stored", {}),
            "label": b.get("label", ""),
        }
    return result


@app.get("/asseteditor", response_class=HTMLResponse)
async def asseteditor_redirect(request: Request):
    return templates.TemplateResponse("asseteditor.html", {"request": request})


@app.get("/api/asset-manifest")
def asset_manifest():
    """Return all asset definitions + frame remap tables for the client."""
    return asset_registry.get_manifest()


@app.get("/playground", response_class=HTMLResponse)
async def playground(request: Request):
    return templates.TemplateResponse("playground.html", {"request": request})


@app.get("/api/aip")
async def aip_state():
    """JSON snapshot of the AI rival player's state for the dashboard."""
    from services.ai_player import ai_player
    return ai_player.get_dashboard_state()


@app.get("/aip", response_class=HTMLResponse)
async def aip_dashboard():
    """Live AI player dashboard."""
    return AIP_HTML


AIP_HTML = """<!DOCTYPE html>
<html><head>
<title>AI Player Dashboard</title>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0a0a1e; color: #ccc; font-family: 'Consolas', monospace; font-size: 13px; padding: 16px; }
  h1 { color: #ff6644; font-size: 20px; margin-bottom: 12px; }
  h2 { color: #66aaff; font-size: 14px; margin: 12px 0 6px; border-bottom: 1px solid #222; padding-bottom: 4px; }
  .dashboard { display: grid; grid-template-columns: 1.15fr 1fr 1fr; gap: 16px; align-items: start; }
  .stack { display: grid; gap: 16px; align-content: start; }
  .card { background: #111; border: 1px solid #222; border-radius: 6px; padding: 12px; }
  .stat { display: inline-block; margin: 2px 8px 2px 0; }
  .stat b { color: #aaddff; }
  .log { max-height: 300px; overflow-y: auto; }
  .log div { padding: 2px 0; border-bottom: 1px solid #1a1a1a; }
  .log .time { color: #666; }
  .decision { background: #1a1a2e; padding: 8px; border-radius: 4px; margin: 4px 0; }
  .decision .goal { color: #ffcc44; font-weight: bold; font-size: 15px; }
  .decision .reason { color: #88aa88; }
  .npc { background: #0f0f20; padding: 6px 8px; margin: 4px 0; border-radius: 4px; border-left: 3px solid #44aa66; }
  .npc.dead { opacity: 0.4; border-left-color: #aa4444; }
  .rel { padding: 4px 0; }
  .rel .hostile { color: #ff6666; }
  .rel .friendly { color: #66ff66; }
  .rel .neutral { color: #aaaa66; }
  .diary { color: #aaccaa; padding: 4px 0; border-bottom: 1px solid #1a1a1a; }
  .diary .dtime { color: #556655; font-size: 11px; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 11px; }
  .badge.running { background: #224422; color: #66ff66; }
  .badge.stopped { background: #442222; color: #ff6666; }
  .badge.low { background: #223344; color: #99ccff; }
  .badge.medium { background: #443b22; color: #ffdd88; }
  .badge.high { background: #553322; color: #ffb366; }
  .badge.critical { background: #552222; color: #ff8888; }
  .speech { color: #ffcc88; font-style: italic; }
  .mono { white-space: pre-wrap; font-family: 'Consolas', monospace; color: #9fb3c8; line-height: 1.35; }
  .progress { margin-top: 6px; background: #151525; border: 1px solid #26263a; border-radius: 4px; height: 12px; overflow: hidden; }
  .progress > div { height: 100%; background: linear-gradient(90deg, #44aa66, #88ddaa); }
  #status { color: #556677; font-size: 11px; margin-bottom: 8px; }
  @media (max-width: 1400px) { .dashboard { grid-template-columns: 1fr 1fr; } }
  @media (max-width: 980px) { .dashboard { grid-template-columns: 1fr; } }
</style>
</head><body>
<h1>AI Player Dashboard</h1>
<div id="status">Loading...</div>
<div class="dashboard">
  <div class="stack">
    <div class="card" id="stats-card"></div>
    <div class="card" id="decision-card"></div>
    <div class="card" id="npcs-card"></div>
    <div class="card" id="tracked-card"></div>
    <div class="card" id="plan-card"></div>
  </div>
  <div class="stack">
    <div class="card" id="memory-card"></div>
  </div>
  <div class="stack">
    <div class="card" id="diary-card"></div>
    <div class="card" id="events-card"></div>
  </div>
</div>
<script>
async function refresh() {
  try {
    const r = await fetch('/api/aip');
    const d = await r.json();
    document.getElementById('status').textContent =
      `Think #${d.think_count} | ` + (d.running ? 'RUNNING' : 'STOPPED') +
      ` | Updated ${new Date().toLocaleTimeString()}`;

    // Stats
    const s = d.stats;
    document.getElementById('stats-card').innerHTML = `
      <h2>Stats <span class="badge ${d.running?'running':'stopped'}">${d.running?'RUNNING':'STOPPED'}</span></h2>
      <div class="stat"><b>HP:</b> ${s.hp}/${s.maxHp}</div>
      <div class="stat"><b>Ki:</b> ${s.ki}/${s.maxKi}</div>
      <div class="stat"><b>STR:</b> ${s.str}</div>
      <div class="stat"><b>DEF:</b> ${s.def}</div>
      <div class="stat"><b>Lv:</b> ${s.level}</div>
      <div class="stat"><b>XP:</b> ${s.xp}</div>
      <br>
      <div class="stat"><b>Logs:</b> ${s.logs}</div>
      <div class="stat"><b>Stones:</b> ${s.stones}</div>
      <div class="stat"><b>Crystals:</b> ${s.crystals}</div>
      <div class="stat"><b>Pos:</b> (${s.x}, ${s.y})</div>`;

    // Decision
    const dec = d.last_decision;
    document.getElementById('decision-card').innerHTML = `
      <h2>Last Decision</h2>
      <div class="decision">
        <div class="goal">${dec.goal || 'none'}</div>
        <div class="reason">${dec.reason || ''}</div>
        ${dec.speech ? '<div class="speech">"' + dec.speech + '"</div>' : ''}
        <div><b>Attitude:</b> ${dec.attitude || 'neutral'}
        ${dec.target ? ' | <b>Target:</b> ' + dec.target.type + ' #' + dec.target.id : ''}</div>
      </div>`;

    // NPCs
    const npcs = Object.entries(d.npcs || {});
    let npcHtml = '<h2>NPCs (' + npcs.length + ')</h2>';
    if (npcs.length === 0) npcHtml += '<div style="color:#666">No NPCs yet</div>';
    for (const [id, n] of npcs) {
      npcHtml += '<div class="npc' + (n.dead ? ' dead' : '') + '">' +
        '<b>' + n.name + '</b> ' +
        'HP:' + n.hp + '/' + n.maxHp + ' STR:' + n.str + ' Lv' + n.level +
        ' | Logs:' + n.logs + ' Stones:' + n.stones +
        ' | Task: <b>' + n.task + '</b>' +
        ' | (' + n.x + ',' + n.y + ')' +
        '</div>';
    }
    document.getElementById('npcs-card').innerHTML = npcHtml;

    // Tracked players / dossier
    const tracked = Object.entries(d.tracked_players || {});
    let trackedHtml = '<h2>Tracked Players</h2>';
    if (tracked.length === 0) trackedHtml += '<div style="color:#666">No player dossier entries yet</div>';
    for (const [pid, rel] of tracked) {
      trackedHtml += '<div class="npc">' +
        '<b>' + pid + '</b>' +
        ' | attitude: <b>' + (rel.attitude || 'neutral') + '</b>' +
        ' | threat: <b>' + (rel.threat_score || 0) + '</b>' +
        ' | msgs: ' + (rel.messages_received || 0) +
        ' | hits me: ' + (rel.attacks_on_me || 0) +
        ' | hits npcs: ' + (rel.attacks_on_npcs || 0) +
        ' | dummy hits: ' + (rel.dummy_hits || 0) +
        ' | KOs: ' + (rel.knockouts_inflicted || 0) +
        (rel.reason ? '<div>' + rel.reason + '</div>' : '') +
        (rel.last_message ? '<div><b>Last msg:</b> ' + rel.last_message + '</div>' : '') +
        (rel.last_action ? '<div><b>Last action:</b> ' + rel.last_action + '</div>' : '') +
        ((rel.notes || []).length ? '<div><b>Notes:</b> ' + rel.notes.join(' | ') + '</div>' : '') +
        '</div>';
    }
    document.getElementById('tracked-card').innerHTML = trackedHtml;

    // Mind / memory
    const m = d.memory;
    const mind = d.mind || {};
    const plan = d.plan_view || (m && m.plan) || (mind && mind.plan) || {};
    let memHtml = '<h2>Memory</h2>';
    memHtml += '<div><b>Mind Model:</b> ' + (mind.has_full_npc_soul ? 'Full NPC-style soul' : 'AI rival memory/strategy model') + '</div>';
    if (mind.current_attitude) memHtml += '<div><b>Current Attitude:</b> ' + mind.current_attitude + '</div>';
    if (mind.relationship_count != null) memHtml += '<div><b>Tracked Relationships:</b> ' + mind.relationship_count + '</div>';
    if (m.identity) memHtml += '<div><b>Identity:</b> ' + m.identity + '</div>';
    if (m.strategy) memHtml += '<div><b>Strategy:</b> ' + m.strategy + '</div>';
    if (mind.memory_summary) {
      memHtml += '<h2>Soul-Equivalent State</h2>';
      memHtml += '<div class="mono">' + mind.memory_summary.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') + '</div>';
    }

    // Relationships
    const rels = Object.entries(m.relationships || {});
    if (rels.length > 0) {
      memHtml += '<h2>Relationships</h2>';
      for (const [pid, rel] of rels) {
        memHtml += '<div class="rel"><span class="' + rel.attitude + '">' +
          rel.attitude.toUpperCase() + '</span> ' + pid +
          ' (x' + (rel.encounter_count||1) + ')' +
          (rel.reason ? ' - ' + rel.reason : '') + '</div>';
      }
    }
    document.getElementById('memory-card').innerHTML = memHtml;

    // Plan
    let planHtml = '<h2>Plan</h2>';
    if (plan && Object.keys(plan).length > 0) {
      planHtml += '<div><b>Phase:</b> ' + (plan.phase || 'unknown') + '</div>';
      planHtml += '<div><b>Strategy Type:</b> ' + (plan.strategy_type || 'unknown') + '</div>';
      planHtml += '<div><b>Current Objective:</b> ' + (plan.current_objective || 'none') +
        ' <span class="badge ' + (plan.priority || 'medium') + '">' + (plan.priority || 'medium').toUpperCase() + '</span></div>';
      if (plan.progress_pct != null) {
        const progressWidth = Math.max(0, Math.min(100, plan.progress_pct));
        planHtml += '<div><b>Progress:</b> ' + progressWidth + '% (' +
          (plan.completed_objectives ?? 0) + '/' + (plan.total_objectives ?? 0) + ' objectives)</div>' +
          '<div class="progress"><div style="width:' + progressWidth + '%"></div></div>';
      }
      if (plan.resource_targets) {
        planHtml += '<div><b>Targets:</b> logs ' + (plan.resource_targets.logs ?? 0) +
          ' | stones ' + (plan.resource_targets.stones ?? 0) +
          ' | crystals ' + (plan.resource_targets.crystals ?? 0) + '</div>';
      }
      if ((plan.threats || []).length) {
        planHtml += '<div><b>Threats:</b> ' + plan.threats.join(', ') + '</div>';
      }
      if ((plan.alliances || []).length) {
        planHtml += '<div><b>Alliances:</b> ' + plan.alliances.join(', ') + '</div>';
      }
      if ((plan.objectives || []).length) {
        planHtml += '<h2>Objectives</h2>';
        for (const objective of plan.objectives) {
          const target = objective.target_label ? ' target:' + objective.target_label : '';
          const objectivePriority = objective.priority === 'now' ? 'high' : (objective.priority === 'done' ? 'low' : 'medium');
          planHtml += '<div class="npc">' +
            '<b>' + (objective.goal || 'unknown') + '</b>' +
            ' | status: <b>' + (objective.status || 'pending') + '</b>' +
            ' | <span class="badge ' + objectivePriority + '">' + (objective.priority || 'queued') + '</span>' +
            target +
            '</div>';
        }
      }
      if (plan.last_updated_turn != null) {
        planHtml += '<div><b>Last Updated Think:</b> ' + plan.last_updated_turn + '</div>';
      }
    } else {
      planHtml += '<div style="color:#666">No structured plan yet</div>';
    }
    document.getElementById('plan-card').innerHTML = planHtml;

    // Diary
    let diaryHtml = '<h2>Diary</h2>';
    if (m.diary && m.diary.length > 0) {
      for (const entry of m.diary) {
        diaryHtml += '<div class="diary"><span class="dtime">' + entry.time + '</span> ' + entry.text + '</div>';
      }
    } else {
      diaryHtml += '<div style="color:#666">No diary entries yet</div>';
    }
    document.getElementById('diary-card').innerHTML = diaryHtml;

    // Events
    const events = (m.event_log || []).slice().reverse();
    let evHtml = '<h2>Event Log (' + events.length + ')</h2><div class="log">';
    for (const e of events) {
      evHtml += '<div>' + e + '</div>';
    }
    evHtml += '</div>';
    document.getElementById('events-card').innerHTML = evHtml;

  } catch(e) {
    document.getElementById('status').textContent = 'Error: ' + e.message;
  }
}
refresh();
setInterval(refresh, 2000);
</script>
</body></html>"""


# ── Legacy Ollama proxy (kept for compatibility) ───────────────────────────────
OLLAMA_BASE = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")

@app.api_route("/ollama/{path:path}", methods=["GET", "POST"])
async def ollama_proxy(path: str, request: Request):
    url = f"{OLLAMA_BASE}/{path}"
    body = await request.body()
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.request(
            method=request.method,
            url=url,
            content=body,
            headers={"Content-Type": "application/json"},
        )
    return StreamingResponse(
        iter([resp.content]),
        status_code=resp.status_code,
        headers={"Content-Type": resp.headers.get("Content-Type", "application/json")},
    )


@app.get("/llm/models")
async def llm_models():
    return {"models": [{"id": MODEL, "name": MODEL}]}


@app.post("/llm/chat/completions")
async def llm_chat_completions(request: Request):
    payload = await request.json()
    headers = {"Content-Type": "application/json"}
    if LLM_API_KEY:
        headers["Authorization"] = f"Bearer {LLM_API_KEY}"
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(LLM_CHAT_URL, json=payload, headers=headers)
    return Response(
        content=resp.content,
        status_code=resp.status_code,
        media_type=resp.headers.get("Content-Type", "application/json"),
    )


# Serve built frontend (Docker puts it in /app/static/game)
GAME_DIR = THIS_DIR / "static" / "game"
if GAME_DIR.exists():
    app.mount("/", StaticFiles(directory=str(GAME_DIR), html=True), name="frontend")
