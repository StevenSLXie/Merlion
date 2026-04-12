# AGENTS Guidance

<!-- BEGIN MANUAL -->
## Purpose
- Merlion is a CLI coding agent runtime with tool execution, session persistence, and context orientation.

## Global Rules
- Prefer small, test-backed changes and keep docs/features in sync.
- Do not write outside the workspace root.
- Use path-guided exploration before broad repository scans.

## Major Areas
- `src/index.ts`: CLI bootstrap, config, session wiring, orientation.
- `src/runtime/`: loop/executor/session/usage orchestration.
- `src/tools/builtin/`: file/search/bash/git/meta tools.
- `src/context/`: orientation, compact, path guidance.
- `src/artifacts/`: AGENTS/progress/codebase index artifacts.

## Navigation Tips
- Runtime flow bugs: start at `src/runtime/loop.ts` then `executor.ts`.
- Startup/config issues: start at `src/index.ts` and `src/config/*`.
- Memory/index behavior: start at `src/context/*` and `src/artifacts/*`.

## High-Risk Areas
- `src/runtime/loop.ts`
- `src/index.ts`
- `src/tools/builtin/bash.ts`
<!-- END MANUAL -->

<!-- BEGIN AUTO -->
## Subareas
- (managed by directory AGENTS files)

## EntryPoints
- (keep in MANUAL if needed)

## RecentChanges
- src/index.ts
- docs/change_log/v0.1.5.log
- package-lock.json
- package.json
- README.md
- docs/features/050-ast-markdown-renderer-v2.md
- docs/todo.md
- docs/tracker.md

## HighChurnFiles
- docs/todo.md (changes=45)
- docs/tracker.md (changes=44)
- src/index.ts (changes=21)
- package.json (changes=14)
- src/cli/experience.ts (changes=14)
- src/runtime/loop.ts (changes=14)

## RecentCommits
- 2026-04-12 a321d19 fix(config): custom provider without baseURL now triggers setup wizard
- 2026-04-12 938f316 chore(release): bump version to 0.1.5
- 2026-04-12 8ec99d3 feat(cli): ast markdown rendering without raw markers
- 2026-04-12 323f80e feat(config): provider-agnostic onboarding wizard
- 2026-04-12 2d4c240 fix(observability): persist prompt cache tracker across turns and include tool schema tokens

## LastUpdated
- 2026-04-12
- directory: .
<!-- END AUTO -->
