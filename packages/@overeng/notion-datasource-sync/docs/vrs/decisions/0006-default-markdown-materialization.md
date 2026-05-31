# Normal Sync Converges Rows And Markdown

Datasource sync treats the SQLite replica and `.nmd` page bodies as one
workspace experience. Users commonly edit row properties and page bodies
together, so normal sync behaves like a file sync product: it keeps all modeled
surfaces converged without asking the user to choose which surfaces participate.

**Status**: accepted

**Consequences**

The planner must still keep conflicts surface-scoped. Full convergence does not
justify unrelated body conflicts during a property-only edit: a body conflict
requires captured local body desired state, a body read-after-write mismatch, or
a body-specific adapter guard for the same page. Selective or suppressed
surfaces remain advanced escape hatches for tests, debugging, and explicit
policy boundaries, not normal product modes.
