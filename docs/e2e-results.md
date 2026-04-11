# E2E Test Results Log

Each row = one `npm run test:e2e` invocation.
After every run, append a row and fill in the per-scenario token column from the usage archives in `.merlion/e2e-usage/`.

## Summary Table

| Date | Model | Pass | Fail | Notes |
|------|-------|------|------|-------|
| 2026-04-11 | qwen/qwen3-coder | 11/12 | 1 | `e2e-edit` max_turns_exceeded (30 turns, 86k tokens — known edit_file retry loop) |
| 2026-04-11 | moonshotai/kimi-k2.5 | 12/12 | 0 | First full-pass run. Sequential mode established. |

---

## 2026-04-11 — moonshotai/kimi-k2.5 (sequential, baseline run)

**Command:** `MERLION_E2E_MODEL=moonshotai/kimi-k2.5 npm run test:e2e`
**Concurrency:** `--test-concurrency=1`
**Total wall time:** ~218s

| Scenario | Status | Turns | Total tokens | Cached tokens |
|----------|--------|-------|-------------|---------------|
| e2e-bash | ✅ | 2 | 828 | — |
| e2e-bash-pipeline | ✅ | 2 | 807 | — |
| e2e-read | ✅ | 2 | 794 | — |
| e2e-search | ✅ | 2 | 982 | — |
| e2e-create | ✅ | 2 | 940 | — |
| e2e-tool-error | ✅ | 2 | 827 | — |
| e2e-concurrent | ✅ | 2 | 961 | — |
| e2e-multi-tool | ✅ | 3 | 1,430 | — |
| e2e-edit | ✅ | 3 | 1,599 | — |
| e2e-context-caching | ✅ | 3 | ~2,000 est | 832 (provider cache hit confirmed) |
| e2e-max-turns | ✅ | 1 | ~500 est | — |
| e2e-session-resume | ✅ | ~4 | ~3,000 est | — |

**Observations:**
- kimi-k2.5 completes every task in 2–3 turns vs qwen3-coder's 30-turn retry loops on edit_file
- Context caching confirmed working: 832 cached tokens across 3 turns
- Session resume (JSONL persist → load → initialMessages) works end-to-end
- Running 12 tests in parallel caused API rate-limit flakes (3 failures); serial mode is stable

---

## 2026-04-11 — qwen/qwen3-coder (parallel, initial baseline)

**Command:** `npm run test:e2e` (parallel at the time)

| Scenario | Status | Turns | Total tokens | Notes |
|----------|--------|-------|-------------|-------|
| e2e-bash | ✅ | 2 | ~4,000 | |
| e2e-bash-pipeline | ✅ | 2 | ~4,000 | |
| e2e-read | ✅ | 2 | ~4,000 | |
| e2e-search | ✅ | 2 | ~4,000 | |
| e2e-create | ✅ | 2 | ~4,000 | |
| e2e-tool-error | ✅ | 2 | ~4,000 | |
| e2e-concurrent | ✅ | 2 | ~4,000 | |
| e2e-multi-tool | ✅ | 3 | ~8,000 | |
| e2e-edit | ❌ | 30 | 86,826 | max_turns_exceeded — edit_file parameter corruption loop |
| e2e-context-caching | ✅ | 3 | — | 2,677 cached tokens |
| e2e-max-turns | ✅ | 1 | — | |
| e2e-session-resume | ✅ | ~4 | — | |
