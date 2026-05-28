# notion-datasource-sync Docs

These docs describe how to use `@overeng/notion-datasource-sync`. The local
user API is `workspace/notion.sqlite`; the internal sync-control store is
`workspace/.notion-datasource-sync/store.sqlite`. The design source of truth
lives in the package-local [VRS](./vrs/spec.md).
Follow-up production-readiness work is tracked in
[GitHub issue #698](https://github.com/overengineeringstudio/effect-utils/issues/698).

Start here:

- [Getting Started](./getting-started.md): establish a workspace with
  `sync --from-notion`, query `notion.sqlite`, create write intents, and run
  established sync.
- [Canonical SQLite Replica](./canonical-replica.md): the default 1:1
  `notion.sqlite` contract with canonical writable `rows`, `schema`, and
  `schema_properties`.
- [CLI Reference](./cli.md): commands, flags, environment variables, and output
  shape.
- [Sync Safety](./sync-safety.md): public replica, write intents, internal event
  log, outbox, fail-closed guards, and conflict policy.
- [Supported Capabilities](./capabilities.md): currently supported, guarded,
  and unsupported Notion surfaces.
- [Testing And Demo](./testing.md): unit/fake/live E2E, durable ledgers, and the
  automated demo page.
- [Troubleshooting](./troubleshooting.md): common setup and sync failures.
- [VRS](./vrs/spec.md): requirements-derived system contract and verification
  plan.
