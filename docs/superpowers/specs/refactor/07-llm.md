# Spec 07: LLM Integration Cleanup

## Goal
Split `LLMClient.js` (796 lines) into focused responsibilities, move all prompt templates server-side, and harden `llm_gateway.py` with retry/timeout/logging.

## Current State Audit

- `LLMClient.js` is 796 lines mixing: prompt building, personality type metadata, vocabulary/phrase learning, and HTTP calls to Ollama
- `llm_gateway.py` is ~25 lines — bare-minimum proxy with no retry, timeout, or error standardization
- Prompts are hardcoded inline in `LLMClient.js`
- `auxserver/prompts/` directory exists (from `prompt_loader.py` and `template_renderer.py` infrastructure)
- Personality type metadata is duplicated between `NPC.js`/`NPCPersonality.js` (spec 05) and `LLMClient.js`
- No `GET /api/prompts/{name}` endpoint exists

## Gaps to Fill

- [ ] Move all client-side prompts from `LLMClient.js` to `.txt` template files in `auxserver/prompts/`
- [ ] Add `GET /api/prompts/{name}` endpoint that returns a rendered prompt template
- [ ] Update `LLMClient.js` to fetch prompt templates from server rather than containing them inline
- [ ] Extract personality type metadata from `LLMClient.js` to a shared data file (coordinate with spec 05 `NPCPersonality.js` to avoid duplication)
- [ ] Extract vocabulary/phrase learning from `LLMClient.js` to `NPCPersonality.js` (spec 05 work, referenced here)
- [ ] `LLMClient.js` should only: make HTTP calls to Ollama, return raw responses
- [ ] Expand `llm_gateway.py` with retry logic (configurable max retries)
- [ ] Add timeout handling to `llm_gateway.py`
- [ ] Add request logging to `llm_gateway.py` for debugging LLM call patterns
- [ ] Standardize error responses in `llm_gateway.py` when LLM is unreachable

## Acceptance Criteria

- `LLMClient.js` is under 150 lines and contains only HTTP call logic
- All prompts exist as `.txt` files in `auxserver/prompts/`
- `GET /api/prompts/{name}` returns rendered prompt text
- `llm_gateway.py` retries on failure and times out gracefully
- `llm_gateway.py` logs each LLM request (timestamp, model, prompt length, response length)
- Personality type metadata exists in exactly one place (not duplicated between `LLMClient.js` and `NPCPersonality.js`)

## Risks & Notes

- **Depends on spec 05** for `NPCPersonality.js` (vocabulary learning destination) and on spec 03 for the Ollama router.
- **Prompt rendering at fetch time**: the server renders templates with context variables before serving. Ensure the `GET /api/prompts/{name}` endpoint accepts context params (e.g., NPC name, personality type) as query params or POST body.
- **Client caching**: prompt templates don't change at runtime. Cache fetched templates in `LLMClient.js` to avoid re-fetching on every NPC conversation turn.
