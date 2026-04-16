## Goal

Turn the BugsInPy medium-bench lane into a repeatable improvement loop:

1. probe candidate cases on the `fixed` baseline to verify they are locally runnable,
2. run Merlion on the corresponding `buggy` cases,
3. summarize failures into actionable agent/runtime improvement buckets.

## Status

`implemented`

## Why

The previous validated pool used a weaker notion of validation:

1. checkout succeeds
2. compile succeeds
3. relevant failing test executes on the buggy version

That is useful, but it does not guarantee that the case is fully verifiable on the current machine. For improvement work, the stronger standard is:

1. the `fixed` version passes acceptance and regression locally,
2. the `buggy` version can be handed to Merlion,
3. post-run outcomes can be grouped into concrete failure modes.

## Added Scripts

1. `scripts/bench_medium/bugsinpy/probe.ts`
2. `scripts/bench_medium/bugsinpy/analyze_runs.ts`

## Probe Design

`probe.ts` creates ephemeral case specs and runs them through the existing BugsInPy runner.

Supported inputs:

1. `MERLION_BUGSINPY_HOME`
2. `MERLION_BUGSINPY_PROBE_PROJECT`
3. `MERLION_BUGSINPY_PROBE_BUG_IDS`
4. `MERLION_BUGSINPY_PROBE_VERSION=buggy|fixed`
5. `MERLION_BUGSINPY_PROBE_RUN_AGENT=0|1`

The main intended workflow is:

1. probe `fixed` candidates first
2. keep only cases that pass locally
3. run Merlion on the matching `buggy` cases

The compile wrapper also rewrites self-referential VCS requirements such as
`git+https://...#egg=<current-project>` to a local editable install. Without
that normalization, several historically pinned BugsInPy cases fail during
compile for network reasons even though the checked-out workspace itself is
locally runnable.

## Analysis Design

`analyze_runs.ts` reads a bench run directory and classifies results into buckets:

1. `environment`
2. `agent_runtime`
3. `target_bug_unsolved`
4. `regression_after_fix`
5. `success`

This is intentionally simple. The point is not to replace manual analysis, but to make recurring failure patterns visible.

## Outcome

The default curation direction is now:

1. fixed-baseline pass first
2. then buggy-case agent run
3. then agent-gap analysis

## Current Snapshot

Validated local fixed-baseline pool:

1. `thefuck 1-8`

Agent rerun snapshot on `2026-04-16`:

1. baseline before runtime improvements: `6/8`
2. after bug-fix source-first + convergence guardrails: `8/8`

The most important lesson from this loop is methodological:

1. `git diff tests/**` inside a BugsInPy workspace is not enough to prove the agent rewrote tests, because checkout may already materialize benchmark-specific failing tests
2. failure classification must prefer agent stdout / command results / source diffs over naive workspace status
