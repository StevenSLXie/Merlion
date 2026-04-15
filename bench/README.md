# Bench Phase-0

This directory contains the non-Docker, rules-based E2E benchmark setup.

For a separate medium-weight benchmark lane backed by `BugsInPy`, see:

1. [bench_medium/bugsinpy/README.md](/Users/xieshuanglong/Documents/Code/Merlion/bench_medium/bugsinpy/README.md)

## Layout

1. `task.schema.json`: schema for each task config.
2. `score.schema.json`: schema for per-task scoring result.
3. `tasks/`: task definitions grouped by template repo.

## Task Directory Contract

Each task directory should contain:

1. `task.md`
2. `task.yaml`
3. `acceptance.sh`
4. `regression.sh` (optional)
5. `prepare.sh` (optional)

## Notes

1. Phase-0 intentionally avoids Docker.
2. Hard-fail rules and score weights are defined in feature doc `067`.
3. Later phases can plug a containerized runner without changing task metadata.

## Run

```bash
npm run bench:phase0
```

Artifacts are generated under `bench/results/<timestamp>/`.

## Environment

1. `MERLION_BENCH_RUN_AGENT=1` enables the agent run.
2. `MERLION_BENCH_TASK_FILTER=<substring>` runs a subset of tasks.
3. `MERLION_BENCH_CONCURRENCY=<n>` runs multiple task directories in parallel.

Example:

```bash
MERLION_BENCH_RUN_AGENT=1 MERLION_BENCH_CONCURRENCY=4 npm run bench:phase0
```

## Analyze Failures

```bash
npm run bench:analyze -- bench/results/<timestamp>
```

If no run dir is provided, the analyzer uses the latest directory under `bench/results/`.

It writes:

1. `analysis.json`
2. `analysis.md`

The analysis report classifies every non-100 task as either:

1. `test_case_issue`
2. `merlion_issue`

And records proposed follow-up iterations for the latter.
