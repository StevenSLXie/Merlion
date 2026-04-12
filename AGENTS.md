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
- docs/change_log/v0.1.7.log
- package-lock.json
- package.json
- tests/e2e/e2e_agents_auto_maintenance.test.ts
- tests/e2e/e2e_path_guidance_lifecycle.test.ts
- docs/change_log/v0.1.6.log
- src/config/wizard.ts
- src/tools/builtin/bash.ts

## HighChurnFiles
- docs/todo.md (changes=45)
- docs/tracker.md (changes=44)
- src/index.ts (changes=22)
- package.json (changes=16)
- src/cli/experience.ts (changes=15)
- src/runtime/loop.ts (changes=15)

## RecentCommits
- 2026-04-12 6fa8b4c chore(release): bump version to 0.1.7
- 2026-04-12 8715a15 test(e2e): cover path guidance and AGENTS auto maintenance
- 2026-04-12 675a944 chore(release): finalize 0.1.6 residual changes
- 2026-04-12 4d9ff8f feat(context): path-guided AGENTS maps and commit-time maintenance
- 2026-04-12 a321d19 fix(config): custom provider without baseURL now triggers setup wizard

## LastUpdated
- 2026-04-12
- directory: .
<!-- END AUTO -->
