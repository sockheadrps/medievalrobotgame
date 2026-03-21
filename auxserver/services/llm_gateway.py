"""LLM Gateway — proxies requests to Ollama with retry, timeout, and logging."""
import logging
import time
import httpx

logger = logging.getLogger(__name__)

MAX_RETRIES = 3
TIMEOUT_SECONDS = 30


async def call_llm(url: str, payload: dict) -> dict:
    """Call Ollama with retry on failure and timeout."""
    last_error = None

    for attempt in range(1, MAX_RETRIES + 1):
        t0 = time.monotonic()
        try:
            async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
                resp = await client.post(url, json=payload)
                resp.raise_for_status()
                elapsed = time.monotonic() - t0
                logger.info(
                    "LLM call succeeded attempt=%d model=%s elapsed=%.2fs",
                    attempt,
                    payload.get("model", "unknown"),
                    elapsed,
                )
                return resp.json()
        except (httpx.RequestError, httpx.HTTPStatusError) as e:
            elapsed = time.monotonic() - t0
            logger.warning(
                "LLM call failed attempt=%d/%d elapsed=%.2fs error=%s",
                attempt, MAX_RETRIES, elapsed, e,
            )
            last_error = e

    logger.error("LLM unreachable after %d attempts: %s", MAX_RETRIES, last_error)
    return {"error": "LLM unreachable", "detail": str(last_error)}
