## Goal

Harden the BugsInPy curation loop so more candidate cases can be evaluated on the
current machine with less manual guesswork.

## Status

`implemented`

## Why

Fixed-baseline probes exposed two harness-level issues:

1. some historical projects expect `python -m pip` to exist inside the created
   venv during editable/self installs, but the fresh environment is not always
   reliable enough for that assumption,
2. `probe.ts` only writes a final `summary.json`, which makes long-running case
   curation batches hard to inspect while they are still in progress.

Those failures are not agent failures. They are runner-quality gaps, and they
directly slow down the effort to build an 8-10 case local medium bench.

## Changes

### Venv bootstrap hardening

`scripts/bench_medium/bugsinpy/compile.ts` should explicitly bootstrap the venv
before installing project requirements:

1. run `python -m ensurepip --upgrade`

This keeps the environment in a usable baseline for editable installs without
adding an unconditional network dependency to every probe/test run.

### Probe observability

`scripts/bench_medium/bugsinpy/probe.ts` should persist per-case result files as
soon as each probe case finishes, not only at the end of the whole batch.

Outcome:

1. long probe batches can be inspected incrementally,
2. failed candidates can be triaged without waiting for the whole project set,
3. curation can stop early when a project clearly does not fit the current
   machine.
