# Build Authority Spec

This document specifies authority admission and accounting. It builds on
[requirements.md](./requirements.md).

## Status

Active.

## Scope

Owns the ledger contract, not private instance rows, CI check names, or fleet
deployment. ADR [0031](../.decisions/0031-complexity-gate-and-authority-ledger.md)
records the historical tradeoffs and amendments.

## Authority Ledger

The Deletion Ledger (ontology) is one machine-readable instance per
composition root, next to the composition lock, rendered into every progress
view ([decision 0031](../.decisions/0031-complexity-gate-and-authority-ledger.md)).
This node owns the contract; the instance and its check live in the
composition root because rows name private repositories.

```text
ledger
  version                       contract version
  repos[]                       every composed member: name, remote, ledger path patterns
                                (what counts as build machinery: include/exclude globs)
    legacyMarkers               per consumer close: path globs and text markers
                                (path glob, extended regex); exceptions pair an
                                exact path with an excluded row that declares it
  rows[]                        one per (repo, operation, subject)
    id                          "<repo>/<operation>/<subject>"
    operation                   Semantic Operation (typecheck, dist, unit-test, lint, format,
                                product, dependency-view, ...)
    subject                     package, crate, or root the operation is for
    status                      buck-owned | residual | legacy | claimed | excluded
    producer                    current producer (buck | devenv | nix | pnpm | cargo | other)
    target                      Buck label once buck-owned or claimed
    dissolution                 for residual/legacy: the condition that retires the producer
    exclusion                   for excluded: why it is outside Buck by policy (unbounded, live)
    excludedPaths               for excluded: exact repository-relative files
                                exempted from close markers by that row
    transfer                    pr, merged revision, deleted producers (BUILD.AUTH-R09)
    net                         added, deleted, measured-at revision, measuring command,
                                amortization rationale when added > deleted (BUILD.AUTH-R15)
    benchmark                   warm no-op, fresh with warm cache, hit rate unchanged,
                                CI delta, evidence URI (BUILD.AUTH-R16)
    owner                       agent or human identity that holds the row while claimed
  closes[]                      one per consumer adoption close: repo, revision, repo net,
                                cumulative net (recorded, not gated)
  reconciliations[]             trajectory snapshots: revision, cumulative net, date
```

Semantics the check enforces:

- A row's `status` is derived from its fields, never free: `buck-owned`
  requires `transfer.merged` and `net`; `claimed` requires `owner` and an
  open `transfer.pr`; `residual`/`legacy` require `dissolution`; `excluded`
  requires `exclusion`.
- `net` is recomputed from the merged revision using the repo's path patterns;
  a stored value that disagrees fails the check.
- A consumer closes when it has no `residual`, `legacy`, or `claimed` rows,
  and its legacy builders, FOD hashes, and prepared-install glue are deleted.
  At the close revision the check scans tracked paths and text markers declared
  for that consumer, plus legacy Nix builder paths derived from row evidence;
  a match blocks close unless its exact path is declared by an excluded row
  in the same repository and named in a marker exception. Missing marker
  declarations and exceptions outside their excluded row paths block close.
  The platform hub records `hubReady` (revision) when its residual list reaches
  zero, a milestone rather than a close (BUILD.AUTH-R15 as amended).
  The consumer's row sum and amortization rationale remain recorded for
  reporting; neither a negative sum nor a later sign change gates its close.
- The last reconciliation's cumulative net must be lower than the previous
  one's (BUILD.AUTH-R15 trajectory); the cumulative sum itself carries no sign test.
- Rendering is deterministic: the same instance renders the same progress
  view; the view carries no fact absent from the instance.
- The instance carries no secrets and no fleet endpoints; those stay in the
  member configuration it references.
