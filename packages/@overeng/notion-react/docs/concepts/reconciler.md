# Reconciler

How the custom reconciler maps React trees to Notion block operations:
mount / update / move / unmount semantics, batching, ordering guarantees,
and the relationship between a render pass and the resulting mutation
sequence sent to the Notion API. Orients integrators on what is and isn't
safe to do across renders.

<!-- TODO: harvest from context/vrs/spec.md reconciler sections -->
<!-- TODO: include a minimal mount → update → unmount trace example -->
<!-- TODO: explicitly list non-goals (e.g. concurrent mode, suspense) -->
