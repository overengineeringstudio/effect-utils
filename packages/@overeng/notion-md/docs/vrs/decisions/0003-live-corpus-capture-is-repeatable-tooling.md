# Live corpus capture is repeatable tooling

The fidelity corpus must be refreshed through repeatable live Notion tooling,
not by manually editing fixture values from memory or documentation. The capture
tool creates temporary pages from authored cases, records the real round-trip
body, archives scratch pages, and leaves a reviewable diff before the corpus is
accepted.

## Status

accepted

## Consequences

The capture path can remain a developer/test utility rather than public CLI
surface, but it is part of the verification contract for R35. A corpus marked
`pending-live-refresh` is not complete evidence for a release claim.
