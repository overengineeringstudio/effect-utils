# Store Authority Experiments

This file records non-normative store authority evidence.

## Split CAS Prune

Hypothesis:

- Two pnpm stores that share one package files pool are unsafe if one store runs
  raw prune using only its own metadata authority.

Result:

- Accepted. A profile-local prune can remove content needed by a sibling
  profile whose metadata is invisible to the pruning store.

Conclusion:

- Shared content pools need root-set GC authority, and raw profile-local prune
  must fail closed.

## Synthetic Store Trait Footprint

Hypothesis:

- Shared content traits reduce host-wide bytes and file counts versus isolated
  stores.

Result:

- Accepted as a design signal. Synthetic overlapping graphs showed a material
  footprint win for shared package content.

Conclusion:

- Preserve a sharing trait, but require integrated real-workspace benchmarks
  before changing defaults.
