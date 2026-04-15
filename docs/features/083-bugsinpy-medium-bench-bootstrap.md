## Goal

Add a separate `BugsInPy`-backed medium-weight benchmark lane under its own folder so Merlion can be evaluated on real Python bug-fix tasks without merging this workflow into the existing lightweight `bench/phase0` path.

## Status

`implemented`

## Why

The current `bench/` tasks are useful for fast, deterministic regressions, but they remain fixture-sized. They do not pressure:

1. real repository checkout/setup,
2. Python dependency installation,
3. relevant-test versus broader-regression execution,
4. task prompts derived from real bug metadata.

`BugsInPy` is a better fit for a medium bench than SWE-bench because it keeps the task unit at “real bug in a real Python project” while avoiding full Docker-per-instance orchestration.

## Scope

This feature adds:

1. a separate benchmark root: `bench_medium/bugsinpy/`
2. a seeded case catalog with a few curated examples
3. a minimal runner for checkout → compile → optional agent run → acceptance/regression
4. local wrappers that avoid mutating the user shell profile
5. tests around discovery, metadata parsing, and local fake-run execution

This feature does not:

1. auto-download the full BugsInPy dataset into the repository
2. replace the existing `bench:phase0` workflow
3. guarantee every seeded case is validated against the upstream dataset in CI

## Directory Layout

New files live in:

1. `bench_medium/bugsinpy/README.md`
2. `bench_medium/bugsinpy/cases/<case-id>/case.json`
3. `bench_medium/bugsinpy/cases/<case-id>/task.md`
4. `scripts/bench_medium/bugsinpy/common.ts`
5. `scripts/bench_medium/bugsinpy/compile.ts`
6. `scripts/bench_medium/bugsinpy/test.ts`
7. `scripts/bench_medium/bugsinpy/run.ts`

## Case Contract

Each seeded case directory contains:

1. `case.json`
2. `task.md`

`case.json` defines:

1. `id`
2. `title`
3. `project`
4. `bug_id`
5. `version`
6. `timeout_sec`
7. `acceptance_mode`
8. `regression_mode`
9. `python_version_hint`
10. `tags`
11. `status`
12. `notes`

The prompt remains in `task.md` so the benchmark can preserve a user-facing issue statement separate from machine metadata.

## Runner Design

The medium bench runner is intentionally separate from `scripts/bench/run_phase0.ts`.

Entry point:

1. `node --experimental-strip-types scripts/bench_medium/bugsinpy/run.ts`

Environment:

1. `MERLION_BUGSINPY_HOME` or `BUGSINPY_HOME`
2. `MERLION_BUGSINPY_CASE_FILTER`
3. `MERLION_BUGSINPY_RUN_AGENT=1`
4. `MERLION_BUGSINPY_CONCURRENCY=<n>`

Per case flow:

1. create `bench_medium/results/<timestamp>/<case-id>/workspace`
2. call upstream `bugsinpy-checkout`
3. compile the checkout using Merlion’s wrapper
4. optionally run Merlion against the case prompt
5. run acceptance in `relevant` mode
6. run regression in `all` or `relevant` mode
7. emit `<case-id>.result.json`

## Wrapper Design

### Checkout

Checkout still delegates to upstream `bugsinpy-checkout` because it already encodes:

1. project repo cloning
2. bug/fixed commit switching
3. bug metadata materialization

### Compile

We do not invoke upstream `bugsinpy-compile` directly because it mutates shell-profile state.

Instead, Merlion’s compile wrapper:

1. validates the checkout directory
2. parses `bugsinpy_bug.info`
3. computes `PYTHONPATH` from its `pythonpath` entry
4. creates `env/` with `python3 -m venv`
5. installs requirements from `bugsinpy_requirements.txt`
6. runs `bugsinpy_setup.sh` when present
7. writes `bugsinpy_compile_flag`

This keeps all environment mutation inside the case workspace.

### Test

We also provide a local test wrapper instead of relying on upstream `bugsinpy-test`.

Supported modes:

1. `relevant`
2. `all`
3. `single`

The wrapper:

1. reuses `env/`
2. injects computed `PYTHONPATH`
3. runs commands from `bugsinpy_run_test.sh` for `relevant`
4. falls back to `pytest` or `unittest discover` for `all`
5. returns a proper non-zero exit when any relevant command fails

## Seeded Cases

First batch is intentionally small and metadata-only:

1. `BIP001_BLACK_1`
2. `BIP002_YOUTUBEDL_2`
3. `BIP003_PANDAS_12`

These are seeded so the runner can be exercised with real-looking case metadata while upstream validation remains optional and manual.

## Validation

Required validation for this feature:

1. unit tests for case discovery and bug-info parsing
2. local fake-run integration test with a stub `BugsInPy` home
3. two unrelated local E2E checks from the main runtime suite

## Follow-ups

Next steps after this bootstrap:

1. add an importer that snapshots selected upstream bug metadata into lock files
2. validate which seeded cases are stable enough to enable by default
3. add a Python-only cost/runtime budget layer for medium bench runs
