# Builtin Tools AGENTS Guidance

<!-- BEGIN MANUAL -->
## Purpose
- Implements builtin tool contracts used by the runtime loop.

## Key Files / Entry Points
- `index.ts`: registry wiring.
- `read_file.ts` / `edit_file.ts` / `write_file.ts`: file operations.
- `search.ts` / `grep.ts` / `glob.ts`: local discovery.
- `bash.ts`: shell command execution wrapper.

## Local Constraints
- Keep path validation through `fs_common.ts`.
- Preserve compatibility aliases in file tool APIs.
- Tool results should stay concise and budget-aware.
<!-- END MANUAL -->

<!-- BEGIN AUTO -->
## Subareas
- (managed by directory AGENTS files)

## EntryPoints
- (keep in MANUAL if needed)

## RecentChanges
- src/tools/builtin/bash.ts
- src/tools/builtin/AGENTS.md
- src/tools/builtin/config.ts
- src/tools/builtin/config_get.ts
- src/tools/builtin/config_set.ts
- src/tools/builtin/todo_write.ts
- src/tools/builtin/glob.ts
- src/tools/builtin/grep.ts

## HighChurnFiles
- src/tools/builtin/bash.ts (changes=4)
- src/tools/builtin/edit_file.ts (changes=4)
- src/tools/builtin/glob.ts (changes=3)
- src/tools/builtin/grep.ts (changes=3)
- src/tools/builtin/index.ts (changes=3)
- src/tools/builtin/todo_write.ts (changes=3)

## RecentCommits
- 2026-04-12 675a944 chore(release): finalize 0.1.6 residual changes
- 2026-04-12 4d9ff8f feat(context): path-guided AGENTS maps and commit-time maintenance
- 2026-04-12 323f80e feat(config): provider-agnostic onboarding wizard
- 2026-04-12 5e4e56b feat(policy): enforce version changelog and move runtime artifacts under .merlion
- 2026-04-12 9fc8376 docs: add bilingual README and fix bash .git command autocorrect

## LastUpdated
- 2026-04-12
- directory: src/tools/builtin
<!-- END AUTO -->
