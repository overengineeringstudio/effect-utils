# 2026-06-22 Split Files Pool Prune

## Question

Can two pnpm stores safely use independent mutable indexes over one shared
`v11/files` pool while each store retains native prune authority?

## Method

- Created sibling stores with separate metadata and one shared package-files
  pool.
- Installed overlapping dependency graphs.
- Ran raw profile-local prune through only one store.
- Checked the sibling store and attempted offline reinstall.

## Result

The profile-local prune removed content still required by the sibling whose
metadata was invisible to the pruning store. Store status could appear clean
while the sibling offline reinstall failed.

## Conclusion

Mutually invisible writable indexes cannot each own destructive GC over one
package-files pool. That realization requires an independent complete root-set
GC authority or must remain append-only/fail closed. The finding falsifies the
historical split-`v11/files` implementation; it does not make a shared mutable
whole-store index satisfy the pure reuse boundary.

## VRS Impact

- Rejects a direct return to split `v11/files` under DMP.STORE-R03 and
  DMP.STORE-R15.
- Constrains DELTA-001 resolution to an immutable seed/artifact or a GC design
  that can prove complete reachability without shared mutable consumer state.
