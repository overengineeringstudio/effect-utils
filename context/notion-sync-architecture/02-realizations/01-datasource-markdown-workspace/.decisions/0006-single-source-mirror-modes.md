# Single-source modes mirror the declared authority

Status: accepted

Datasource workspaces should follow the same single-source rule as NotionMD:
`remote` means Notion wins and local drift is overwritten; `local` means the
workspace wins and remote drift is overwritten. `status` and `sync --dry-run`
must report the consequence before mutation, but concurrent-edit detection is
not promised in single-source modes.

Bidirectional safety belongs to `shared`. That is the mode that requires durable
bases, accepted intents, outbox, conflict records, leases, checkpoints, and
repair state under `.notion/v1/`.

## Consequences

In `remote` mode, data files and `pages/v1/**/*.nmd` are generated mirror outputs.
Hidden `.notion/v1/` state may optimize incremental pulls, but deleting it must not
change correctness. In `local` mode, hidden state is mostly optional except for
minimal idempotency/retry state needed for safe local-created pages.
