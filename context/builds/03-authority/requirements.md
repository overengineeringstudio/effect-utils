# Build Authority Requirements

This subsystem owns admission, deletion and complexity accounting. It refines
BUILD-R02 and supplies the contract consumed by Buck and private consumer profiles.

## Assumptions

- **BUILD.AUTH-A01 Instance ownership:** The composition root owns ledger data;
  the reusable public contract contains no private repository rows.

## Acceptable Tradeoffs

- **BUILD.AUTH-T01 Amortized foundation:** A foundation may grow machinery when
  recorded deletion across consumers reduces cumulative complexity.

## Requirements

- **BUILD.AUTH-R09 Deletion ledger:** Every admission names the devenv task, script,
  CI job, Nix builder, or install step it supersedes, and the transfer change
  deletes it. The ledger is machine-readable: one row per operation per
  repository, held in the composition root (the megarepo that composes every
  consumer) and rendered — never hand-typed — into any progress view
  ([decision 0031](../.decisions/0031-complexity-gate-and-authority-ledger.md)).
  A subsystem with no dissolution condition is a design defect, not an
  exemption.

- **BUILD.AUTH-R12 Evidence at transfer:** Authority transfer — the change that
  deletes a superseded producer — requires fail-closed proof of hermeticity,
  invalidation causality, and (where products cross the bridge) independent
  import for the exact tuple. Outside transfer moments, gates are ordinary CI
  green plus the budget criteria; richer evidence (OTel correlation, admission
  envelopes, conformance fixtures) is advisory
  ([decision 0016](../.decisions/0016-evidence-rigor-at-transfer.md)).

- **BUILD.AUTH-R14 Portability hygiene:** Shared rules, schemas, and fixtures contain
  no repository-private paths, labels, fleet names, endpoints, or secrets, so a
  second consumer can extract them without rework. Extraction mechanics are
  decided when that consumer adopts, not before.


- **BUILD.AUTH-R15 Net complexity gate:** The adoption reduces global build
  complexity; growth in one place is justified only by larger deletion
  elsewhere. The ledger (BUILD.AUTH-R09) carries, per row, build-machinery lines added
  versus legacy lines deleted (excluding VRS documents, tests, and lockfiles).
  A consumer closes when every ledger row for that consumer is Buck-owned or
  excluded and its legacy build machinery (builders, FOD hashes, and
  prepared-install glue) is deleted. A close records the consumer's net, including
  amortization, for reporting; its sign does not gate the close. A single change
  may be net positive when its row records the amortization rationale
  ([decision 0031](../.decisions/0031-complexity-gate-and-authority-ledger.md),
  Amendment 3). The cumulative sum across repositories carries a trajectory:
  at every reconciliation it must be lower than at the previous reconciliation,
  or admissions pause until it is (decision 0031, Amendments 1 and 2). The
  platform hub (effect-utils) carries foundation cost amortized across its
  consumers: its residual list reaching zero records a hub-ready milestone,
  not a consumer close (decision 0031, Amendment 2).
  When BUILD.AUTH-R15 conflicts with coverage (BUILD.BUCK-R01) or the wall-clock budgets
  (BUILD.BUCK-R07), BUILD.AUTH-R15 wins: the others are constraints with tolerances.

- **BUILD.AUTH-R16 Benchmark evidence:** Efficiency claims are measured, never
  asserted. Each admission's ledger row records warm no-op time, fresh-context
  time with a warm shared cache, cache hit rate for unchanged targets, and CI
  wall-clock delta against the pre-admission baseline. A regression against the
  BUILD.BUCK-R07 budgets or the recorded baseline blocks further widening until it is
  fixed or explicitly accepted in a decision record.
