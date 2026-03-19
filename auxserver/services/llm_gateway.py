import httpx

from core.config import LLM_API_KEY, LLM_CHAT_URL, MODEL


def _headers():
    headers = {"Content-Type": "application/json"}
    if LLM_API_KEY:
        headers["Authorization"] = f"Bearer {LLM_API_KEY}"
    return headers


async def chat_completion(messages, *, temperature=0.7, max_tokens=300, model=None, timeout=60.0):
    payload = {
        "model": model or MODEL,
        "messages": messages,
        "stream": False,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(LLM_CHAT_URL, json=payload, headers=_headers())
        resp.raise_for_status()
    data = resp.json()
    return ((data.get("choices") or [{}])[0].get("message") or {}).get("content", "").strip()
