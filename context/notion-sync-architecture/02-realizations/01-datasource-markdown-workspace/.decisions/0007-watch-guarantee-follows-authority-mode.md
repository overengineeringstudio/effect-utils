# Watch guarantees follow the authority mode

Status: accepted

`sync --watch` may exist in `remote`, `local`, and `shared` datasource
workspaces, but it must not imply the same guarantee in every mode. In `remote`,
watch regenerates the local mirror from Notion. In `local`, watch applies local
desired state to Notion. Only `shared --watch` promises durable bidirectional
live sync with local and remote intake, outbox, leases, conflicts, and repair.

## Consequences

Single-source watch modes may use lightweight hidden cache/checkpoint state.
They do not need the full `.notion/v1/` control plane unless they add retry,
idempotency, or first-class repair promises that require it. Command output must
make the active guarantee explicit so users do not mistake mirror watch for
bidirectional conflict-safe watch.
