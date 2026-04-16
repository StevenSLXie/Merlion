## Goal

Add a separate `SWE-bench Lite` benchmark lane that lets Merlion generate
patches on the host machine and evaluate them through the official
Docker-based SWE-bench harness.

## Status

`planned`

## Why

The current benchmark stack has two useful layers:

1. `bench/phase0` for fast, fixture-sized regressions
2. `bench_medium/bugsinpy` for real repository checkout, dependency install,
   and test execution on the host machine

That medium lane is intentionally lighter than SWE-bench. It avoids
per-instance Docker orchestration and is therefore much easier to run locally.
However, it also leaves out an important pressure test:

1. containerized, reproducible environment setup per benchmark instance
2. patch export in the exact format expected by an external benchmark harness
3. evaluation against a widely used software-engineering benchmark

If Merlion should be compared on a more standard bug-fixing benchmark, the
next step is not to replace `BugsInPy`, but to add a separate bridge lane for
`SWE-bench Lite`.

## Design Direction

Phase 1 should prefer the smallest viable integration:

1. Merlion runs on the host machine against a checked-out workspace
2. the runner exports a git-style patch for each instance
3. the official SWE-bench harness evaluates that patch in Docker

This keeps the first implementation bounded. It avoids embedding Merlion
inside the evaluation containers before the patch/export/evaluate loop is
proven end-to-end.

## Scope

This feature adds:

1. a new benchmark root: `bench_medium/swebench_lite/`
2. a small curated catalog of `SWE-bench Lite` instances
3. a runner that prepares host workspaces, runs Merlion, and exports
   `predictions.jsonl`
4. a harness bridge that invokes the official SWE-bench evaluation flow
5. result import/adaptation so Merlion bench summaries can point to
   per-instance resolution status and harness logs
6. environment preflight checks for Docker availability and basic disk/RAM
   guidance

This feature does not:

1. replace `bench:phase0`
2. replace `bench:bugsinpy`
3. run the full `SWE-bench` dataset by default
4. run Merlion inside Docker containers
5. make SWE-bench part of default CI

## Non-Goals

The first version should not:

1. implement a custom re-creation of the SWE-bench harness
2. maintain a fork of SWE-bench Dockerfiles or grading logic
3. support every SWE-bench subset and evaluation mode
4. optimize large-scale image caching for multi-hundred-instance runs
5. auto-install Docker or large external dependencies for the user

## Preconditions

The runner should fail fast with a clear message unless these requirements are
met:

1. `docker` is installed and available on `PATH`
2. the user has enough local resources for Docker-based evaluation
3. a local `SWE-bench` checkout or installed harness is configured
4. network access is available when the harness needs to pull/build images

The docs should explicitly state that SWE-bench's official Docker guidance is
materially heavier than the current `BugsInPy` lane and may require roughly:

1. at least 120GB free disk
2. at least 16GB RAM

## Directory Layout

New files should live under:

1. `bench_medium/swebench_lite/README.md`
2. `bench_medium/swebench_lite/cases/<case-id>/case.json`
3. `bench_medium/swebench_lite/cases/<case-id>/task.md`
4. `scripts/bench_medium/swebench_lite/common.ts`
5. `scripts/bench_medium/swebench_lite/prepare.ts`
6. `scripts/bench_medium/swebench_lite/export_predictions.ts`
7. `scripts/bench_medium/swebench_lite/evaluate.ts`
8. `scripts/bench_medium/swebench_lite/run.ts`

## Case Contract

Each curated case directory should contain:

1. `case.json`
2. `task.md`

`case.json` should define:

1. `id`
2. `instance_id`
3. `repo`
4. `subset`
5. `timeout_sec`
6. `status`
7. `tags`
8. `notes`

`task.md` should hold the user-facing issue prompt presented to Merlion.

The initial curated set should stay small, on the order of 3-10 instances, so
the host-generate / harness-evaluate loop can be debugged cheaply.

## Runner Design

The new lane should be separate from both:

1. `scripts/bench/run_phase0.ts`
2. `scripts/bench_medium/bugsinpy/run.ts`

Entry point:

1. `node --experimental-strip-types scripts/bench_medium/swebench_lite/run.ts`

Environment:

1. `MERLION_SWEBENCH_HOME=/path/to/SWE-bench`
2. `MERLION_SWEBENCH_CASE_FILTER=<needle>`
3. `MERLION_SWEBENCH_RUN_AGENT=1`
4. `MERLION_SWEBENCH_CONCURRENCY=<n>`
5. `MERLION_SWEBENCH_DATASET_NAME=princeton-nlp/SWE-bench_Lite`
6. `MERLION_SWEBENCH_EVAL_WORKERS=<n>`

Per case flow:

1. create `bench_medium/swebench_lite/results/<timestamp>/<case-id>/workspace`
2. materialize the target repository at the benchmark instance base commit
3. write the issue prompt into `task.md`-backed run metadata
4. optionally run Merlion against the workspace
5. collect a git diff patch from the workspace
6. emit one `predictions.jsonl` record per attempted case
7. invoke the official SWE-bench harness over the produced predictions
8. write adapted Merlion result files plus links/paths to harness artifacts

## Evaluation Bridge

The bridge should treat the official SWE-bench harness as the grading source of
truth.

That means the Merlion side should only be responsible for:

1. preparing a runnable workspace for the instance
2. producing a valid patch
3. packaging predictions in harness format
4. importing harness results back into Merlion summaries

It should not duplicate:

1. patch application logic
2. container build logic
3. grading or resolved/unresolved classification

## Prediction Format

The bridge should emit standard JSONL prediction records with:

1. `instance_id`
2. `model_name_or_path`
3. `model_patch`

`model_patch` should come from a deterministic git diff export step. If no diff
is produced, the case should still be recorded as an attempted run with an
explicit `no_patch` failure bucket on the Merlion side.

## Result Model

Merlion should preserve its own per-case run record, but attach harness-facing
status instead of inventing a second scoring system.

Suggested per-case fields:

1. `case_id`
2. `instance_id`
3. `status`: `resolved | unresolved | failed | skipped`
4. `workspace`
5. `patch_path`
6. `prediction_record`
7. `harness_result`
8. `failure_reason`

Suggested summary fields:

1. total attempted cases
2. cases with patch output
3. cases resolved by harness
4. harness failures vs agent/runtime failures
5. paths to `predictions.jsonl`, harness `results.json`, and instance logs

## Failure Buckets

The first version should classify failures into a small set of actionable
groups:

1. `environment_preflight`
2. `workspace_prepare`
3. `agent_runtime`
4. `no_patch`
5. `harness_infra`
6. `unresolved`
7. `resolved`

This keeps post-run analysis aligned with the existing `BugsInPy` direction
without pretending Merlion itself is the final grader.

## Open Design Questions

These choices should be resolved before implementation:

1. how instance repositories/base commits are materialized on the host side
2. whether to require a local `SWE-bench` clone or support an installed Python
   package plus dataset download flow
3. whether host-side workspace preparation should reuse harness metadata or keep
   a Merlion-owned case snapshot
4. whether the first version should evaluate one combined `predictions.jsonl`
   batch or one case at a time for easier debugging
5. how much harness output should be mirrored into Merlion-native result files

## Implementation Phases

### Phase 1: Single-case proof

Build the narrowest possible end-to-end path:

1. one curated Lite instance
2. host workspace prep
3. Merlion patch generation
4. prediction export
5. official harness evaluation
6. result import

Success condition:

1. one command produces both a Merlion result file and an official harness
   result directory

### Phase 2: Small curated batch

Expand to a small pool:

1. 3-10 curated instances
2. case filtering
3. sequential or low-concurrency execution
4. summary aggregation and failure classification

Success condition:

1. the lane is useful for local comparison work and not dominated by harness
   setup confusion

### Phase 3: Hardening

Only after the bridge is stable:

1. improve Docker preflight and cleanup guidance
2. tune concurrency and caching defaults
3. add optional helper commands for pruning or inspecting harness artifacts

Success condition:

1. repeated local runs are understandable and operationally manageable

## Validation

Required validation for implementation:

1. unit tests for prediction export and result import logic
2. runner tests for preflight error reporting without Docker
3. one smoke path that can be enabled only in appropriately provisioned
   environments
4. documentation that clearly distinguishes host-side agent execution from
   Docker-side evaluation

## Success Criteria

This feature is successful if:

1. Merlion can run on a small `SWE-bench Lite` subset without changing the main
   runtime architecture
2. official SWE-bench harness results become visible from Merlion bench outputs
3. the operational cost is explicit enough that users can choose between
   `phase0`, `BugsInPy`, and `SWE-bench Lite` based on speed versus fidelity
