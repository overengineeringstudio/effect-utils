# 0016 Evidence Rigor Concentrated at Authority Transfer

Status: accepted

## Context

The prior contract required failure-capable RED/GREEN evidence at the actual
seam for every claim (former BUCK-R15), per platform/operation tuple, with an
admission calculus (PASS/FAIL/NO_VERDICT), OTel exact-readback, and
conformance fixtures as merge preconditions.

## Evidence and Argument

Decision
[0012](./0012-vertical-slice-replay-phase.md) records the observed cost:
execution frozen for nine days, three draft PRs, nothing merged, products
never proven end to end. The steelman for the regime is real — in an
agent-operated repository, fail-closed machine-checkable evidence substitutes
for human review — but the regime priced every increment, not the irreversible
ones.

## Options

| Option                            | Tradeoff                                                             | Outcome  |
| --------------------------------- | -------------------------------------------------------------------- | -------- |
| Full rigor at transfer only       | Hard gate exactly where irreversibility lives; light gates elsewhere | Accepted |
| Trim to per-slice pragmatic gates | Fastest; weakens the standing machine gate agents rely on at cutover | Rejected |
| Keep full admission regime        | Strongest standing proof; demonstrated to stop delivery              | Rejected |

## Decision

Authority transfer — the change that deletes a superseded producer — requires
fail-closed proof of hermeticity, invalidation causality, and independent
product import for the exact tuple (BUCK-R12). Outside transfer moments, gates
are ordinary CI green plus the BUCK-R06/R07 reuse and budget criteria. The
OTel correlation apparatus, admission envelope, NO_VERDICT calculus, and
cross-repository conformance fixtures are advisory: valuable, non-blocking,
hardened later if their absence is felt. Telemetry independence and native
evidence retention remain normative (BUCK-R13).

## Consequences

- Parallel-proof phases move at CI speed; irreversible steps keep the full
  gate.
- The former 05-evidence-verification and 06-admission-reuse subsystem
  contracts collapse into BUCK-R12/R13 and this record; their reusable
  content (evidence decoder tiers, sanitization rules) survives as advisory
  spec material where consumed.
- A future decision may re-promote specific advisory checks to blocking if
  evidence shows agents shipping wrong results through the light gates.
