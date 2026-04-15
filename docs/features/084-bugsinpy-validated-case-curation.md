## Goal

Refine the seeded `BugsInPy` medium-bench lane into a smaller validated set by:

1. hardening the local wrappers against common dataset/runtime incompatibilities, and
2. selecting 2-3 cases that actually run end-to-end on the current machine.

## Status

`implemented`

## Why

The initial seeded set proved the lane shape, but real upstream smoke runs showed three different failure modes:

1. old compiled dependencies fail on the current Python/toolchain
2. some requirements files contain invalid placeholder packages such as `pkg-resources==0.0.0`
3. some bug checkouts use `pytest` in `run_test.sh` without ensuring `pytest` is installed

If we do not separate seeded from validated cases, the medium bench will be noisy and untrustworthy.

## Changes

### Wrapper hardening

`scripts/bench_medium/bugsinpy/compile.ts` should:

1. sanitize requirements before installation
2. skip known-invalid placeholder packages
3. install `pytest` when relevant test commands require it and the environment does not already provide it

### Case curation

The case catalog should distinguish:

1. `seeded`: metadata present, not confirmed on this machine
2. `validated`: checkout, compile, relevant tests, and regression command all execute successfully when the repository is in a runnable state

For bug-fix tasks this means:

1. buggy baseline may still fail acceptance before agent edits
2. but the environment and test harness must be runnable without toolchain breakage

## Validation Criteria

A case is `validated` only if all of the following are true on the current machine:

1. upstream `bugsinpy-checkout` succeeds
2. local compile wrapper succeeds
3. relevant tests can be executed
4. broader regression command can be executed
5. Merlion can be launched against the case prompt without harness/runtime failure

Merlion does not need to solve every validated case on the first try for the case to remain in the validated pool.

## Initial Target

Promote only 2-3 cases into the validated pool after real end-to-end smoke runs.

Outcome:

1. retained a 3-case validated set:
   - `BIP001_THEFUCK_1`
   - `BIP002_THEFUCK_2`
   - `BIP003_THEFUCK_3`
2. removed unstable seeded cases from the default catalog
3. recorded concrete failure reasons for rejected candidates:
   - `black/1`: old `typed-ast` compile failure against current Python/toolchain
   - `PySnooper/1-2`: incomplete test dependency/import surface in the dataset checkout
   - `cookiecutter/1`: compile/install flow breaks inside the historical packaging stack
   - `youtube-dl/2`: targeted fix is reproducible, but broad regression is network-heavy and not stable enough for the default validated pool
