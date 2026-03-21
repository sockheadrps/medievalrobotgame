import os

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse, Response

from core.config import LLM_CHAT_URL, LLM_API_KEY, MODEL

router = APIRouter()

OLLAMA_BASE = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")


# ── Legacy Ollama proxy (kept for compatibility) ───────────────────────────────

@router.api_route("/ollama/{path:path}", methods=["GET", "POST"])
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


@router.get("/llm/models")
async def llm_models():
    return {"models": [{"id": MODEL, "name": MODEL}]}


@router.post("/llm/chat/completions")
async def llm_chat_completions(request: Request):
    payload = await request.json()
    # Always use the server-configured model, ignore whatever the client sent
    payload["model"] = MODEL
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
