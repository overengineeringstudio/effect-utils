# Established sync is local-capture-first

Established sync captures local desired state from public SQLite and NotionMD `.nmd` files before any remote materialization can overwrite local artifacts. We reject unconditional pull-then-push ordering because live verification against a scratch Tasks Tracker row showed that it can overwrite local `.nmd` edits before planning, violating the no-unwanted-data-loss invariant.

**Status**: accepted

**Consequences**

Remote observation may update private base/remote projections, but local artifact writes are guarded and happen only after the planner has compared base, local desired state, and fresh remote observations. `sync`, `push`, and `sync --watch` must converge on the same planner/executor semantics instead of relying on command-specific ordering accidents.
