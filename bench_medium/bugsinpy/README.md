# BugsInPy Medium Bench

This directory hosts a separate medium-weight benchmark lane backed by the upstream `BugsInPy` dataset.

It is intentionally separate from the fast fixture-based `bench/phase0` workflow.

## What it is for

Use this lane when you want tasks that pressure:

1. real Python project checkout
2. dependency installation
3. bug-specific relevant tests
4. broader regression passes

## Requirements

1. A local clone of `BugsInPy`
2. Python 3 with `venv`
3. Network access the first time upstream project repositories are cloned by `bugsinpy-checkout`

## Environment

Set one of:

1. `MERLION_BUGSINPY_HOME=/path/to/BugsInPy`
2. `BUGSINPY_HOME=/path/to/BugsInPy`

Optional:

1. `MERLION_BUGSINPY_CASE_FILTER=black`
2. `MERLION_BUGSINPY_RUN_AGENT=1`
3. `MERLION_BUGSINPY_CONCURRENCY=2`

## Run

Smoke run without Merlion:

```bash
MERLION_BUGSINPY_HOME=/path/to/BugsInPy \
MERLION_BUGSINPY_CASE_FILTER=black \
node --experimental-strip-types scripts/bench_medium/bugsinpy/run.ts
```

Run with Merlion enabled:

```bash
MERLION_BUGSINPY_HOME=/path/to/BugsInPy \
MERLION_BUGSINPY_RUN_AGENT=1 \
MERLION_BUGSINPY_CASE_FILTER=black \
node --experimental-strip-types scripts/bench_medium/bugsinpy/run.ts
```

Artifacts are written under:

1. `bench_medium/bugsinpy/results/<timestamp>/summary.json`
2. `<case-id>.result.json`

## Design Notes

1. Checkout still uses upstream `bugsinpy-checkout`.
2. Compile and test are wrapped locally so we do not rely on upstream shell-profile mutation.
3. Seeded cases are intentionally small in number and not all are marked upstream-validated yet.
4. Some upstream bugs are pinned to older dependency stacks and may require a specific Python/toolchain combination before they become stable validated cases.
