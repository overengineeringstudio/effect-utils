# 0009 Completeness Is Enforced For Opt-In Roots

Status: accepted

## Context

The closure-completeness assertion (`DMP.NIX.NATIVE-R08`) must roll out across
many `mkPnpmCli` consumers without breaking roots that carry no bindings, while
staying consistent with the strict-scan principle that a prepared-deps purity
boundary uses one convergent transition rather than a lenient report-only phase
(`0004`).

## Evidence and Argument

- For an opt-in root, the families _are_ required data, so report-only would be
  the exact ambiguity `0004` rejects. Hard-from-day-one is the `0004`-consistent
  choice.
- For a non-opt-in root, the families are genuinely not part of the artifact, so
  there is nothing to enforce — this is scope, not leniency.
- This keeps the upstream landing behaviorally inert for every existing
  consumer: nothing opts in on the merge, so nothing changes until a consumer
  deliberately turns on inclusion.

## Options

| Option                                                     | Tradeoff                                                                                                   | Outcome  |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------- |
| Enforcement bound to the per-root optional-binding opt-in  | Hard from the first build for opt-in roots; non-opt-in roots are out of scope, so the landing stays inert  | Accepted |
| Global report-only-then-strict rollout phase               | Runs a lenient completeness policy beside a strict one for the same boundary, which `0004` forbids         | Rejected |

## Decision

Bind completeness enforcement to the root's optional-binding opt-in
(`DMP.NIX-R11`), not to a global report-only-then-strict phase:

- A root that opts into optional bindings is enforced **hard** from its first
  build — a missing declared binding fails the prepared-deps scan.
- A root that does not opt in is **not subject** to completeness (its families
  are not required); the assertion is advisory context only.

There is never a lenient completeness policy running beside a strict one for the
same boundary, which is what `0004` forbids.

## Consequences

- The guarantee becomes real for a root exactly when that root opts in and
  refreshes its hash — a single atomic change, not a two-phase migration.
- A future decision to make binding inclusion the default for a class of roots is
  a deliberate scope expansion. It must be sequenced as a versioned prepared-deps
  transition (in the spirit of `0004`: convergent, hash-refreshing, no
  report-only tail), not introduced as a lenient default.
- Advisory completeness output on non-opt-in roots is a diagnostic aid only and
  must not gate their builds.
