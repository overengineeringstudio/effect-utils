# Non-body lifecycle v1 boundaries fail closed with named guards

Status: proposed

v1 supports only: object-store refs, volatile-URL exclusion, preservation, and
proven external-URL attach. Everything beyond this scope fails closed with named
guards and dry-run-visible diagnostics.

Out-of-scope operations that fail closed in v1:

- Durable byte upload, replacement, and deletion
- Comment writes
- Untracked relation lookup
- Writable debug views

Destructive body modes (unknown-block deletion, Roughdraft review markup) are
permitted only when explicit, observable, and dry-run-covered. This is explicit
in the epic Decisions/Phase 6.

## Considered Options

| Option                                                                                       | Result   | Reason                                                                                                                                                      |
| -------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v1 fails closed on out-of-scope lifecycle operations with named guards + dry-run diagnostics | Selected | Explicit in epic scope; fail-closed with observable diagnostics is the system's core safety posture; destructive modes without dry-run coverage are unsafe. |

## Consequences

Users encountering out-of-scope lifecycle operations receive named guard failures
with dry-run-visible diagnostics, not silent no-ops or opaque errors. Future v2
scope expansions (durable upload, comment writes) must add named guards and
dry-run coverage before enabling.
