# Internals — Reconciler internals

Deep dive into how the custom reconciler is implemented: host config
surface, fiber-to-block mapping, commit phase, mutation coalescing, and
invariants the implementation relies on. Aimed at contributors changing the
reconciler itself, not at integrators.

<!-- TODO: document the HostConfig surface we implement -->
<!-- TODO: explain the commit-phase strategy (batching, ordering) -->
<!-- TODO: list invariants with references to the assertions that enforce them -->
<!-- TODO: cross-link concepts/reconciler.md for the user-facing view -->
