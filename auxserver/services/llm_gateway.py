"""LLM Gateway — OpenAI-compatible chat completions (NanoGPT / any v1 endpoint)."""
import logging
import time
import httpx

import core.config as cfg

logger = logging.getLogger(__name__)

MAX_RETRIES = 3
TIMEOUT_SECONDS = 30

logger.info("LLM gateway: url=%s model=%s api_key_set=%s",
            cfg.LLM_CHAT_URL, cfg.MODEL, bool(cfg.LLM_API_KEY))


async def chat_completion(
    messages: list,
    temperature: float = 0.7,
    max_tokens: int = 300,
    timeout: float = TIMEOUT_SECONDS,
    max_retries: int = MAX_RETRIES,
) -> str:
    """Call the configured LLM endpoint and return the assistant reply as a string."""
    url = cfg.LLM_CHAT_URL
    headers = {"Content-Type": "application/json"}
    if cfg.LLM_API_KEY:
        headers["Authorization"] = f"Bearer {cfg.LLM_API_KEY}"

    payload = {
        "model": cfg.MODEL,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }

    last_error = None
    for attempt in range(1, max_retries + 1):
        t0 = time.monotonic()
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(url, json=payload, headers=headers)
                resp.raise_for_status()
                elapsed = time.monotonic() - t0
                data = resp.json()
                content = data["choices"][0]["message"]["content"]
                logger.info(
                    "LLM call succeeded attempt=%d model=%s elapsed=%.2fs",
                    attempt, cfg.MODEL, elapsed,
                )
                return content
        except (httpx.RequestError, httpx.HTTPStatusError) as e:
            elapsed = time.monotonic() - t0
            logger.warning(
                "LLM call failed attempt=%d/%d elapsed=%.2fs type=%s error=%r url=%s",
                attempt, max_retries, elapsed, type(e).__name__, str(e), url,
            )
            last_error = e

    logger.error("LLM unreachable after %d attempts. url=%s model=%s api_key_set=%s",
                 max_retries, url, cfg.MODEL, bool(cfg.LLM_API_KEY))
    raise httpx.RequestError(f"LLM unreachable: {last_error}")
