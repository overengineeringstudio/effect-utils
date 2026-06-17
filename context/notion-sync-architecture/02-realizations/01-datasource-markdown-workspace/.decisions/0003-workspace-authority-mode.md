# Use one workspace authority mode for both local surfaces

Status: accepted

Datasource workspaces should reuse the NotionMD `source` vocabulary:
`local`, `remote`, and `shared`. The mode is declared at workspace level and is
inherited by both data files and `pages/v1/**/*.nmd`; the two user surfaces must not
declare independent conflicting authority modes.

`remote` is a Notion-authoritative mirror/export mode. `local` is a local
workspace-authoritative apply mode. `shared` is the bidirectional authoring mode
and the only mode that promises base-anchored concurrent-edit detection and
conflict refusal.

## Consequences

Hidden `.notion/v1/` state is required when the system promises durable shared-sync
behavior: bases, accepted intents, outbox, conflicts, leases, checkpoints,
tombstones, path claims, own-write suppression, repair, first-class writable
watch, or destructive-action proof. In single-source mirror modes, hidden state
may be used as cache/checkpoint material, but deleting it must not change the
authority contract or correctness; it may only make sync slower or require
re-observation. Local create/retry safety may still require minimal idempotency
state.
