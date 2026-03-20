# Spec 10: Dead Code & Cleanup

## Goal
Remove unused files, commented-out code, and noisy debug logging. Flag multiplayer-only code without deleting it. Do this last — only after all other specs are complete and the codebase is stable.

## Current State Audit

- Likely unused files not yet audited (grep needed)
- Commented-out code blocks of unknown extent
- `console.log`/`console.warn` noise level in client unknown
- `print()` statements in server code not yet converted to `logging` module
- `RemotePlayer.js` and `RemoteNPC.js` exist but are multiplayer-only
- Multi-client broadcast logic in `ws.py` is multiplayer-only
- Implementation docs (`impl1.md`, `impl2.md`, `impl3.md`) may be outdated

## Gaps to Fill

- [ ] Grep for files imported nowhere — list candidates, review, delete confirmed unused files
- [ ] Remove commented-out code blocks longer than 5 lines
- [ ] Remove or archive outdated implementation docs (`impl1.md`, `impl2.md`, `impl3.md`) if they no longer reflect current code
- [ ] Audit `console.log`/`console.warn` in all client JS files — remove noisy debug logs, keep error/warning logs
- [ ] Audit `print()` statements in all Python server files — convert to `logging` module calls
- [ ] Add `// MULTIPLAYER` comment to `RemotePlayer.js`, `RemoteNPC.js`, and multi-client broadcast logic in `ws.py`
- [ ] Verify single-player path works without any multiplayer systems running

## Acceptance Criteria

- No files imported nowhere remain in the codebase
- No commented-out code blocks longer than 5 lines remain
- Client console output is not noisy during normal single-player gameplay
- All Python `print()` debug statements replaced with `logging` calls
- `RemotePlayer.js`, `RemoteNPC.js`, and multiplayer broadcast paths are marked `// MULTIPLAYER`
- Single-player game boots and plays correctly with multiplayer files present but inactive

## Risks & Notes

- **Do this last** — removing code before other refactor work is stable risks deleting something that's still needed.
- **Don't delete multiplayer code** — flag with comments only. Multiplayer is deferred, not abandoned.
- **Grep-based audit**: use `grep -r "import.*RemotePlayer\|require.*RemotePlayer"` style checks to confirm files are truly unused before deleting.
