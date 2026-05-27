# notion-datasource-sync Docs

These docs describe how to use `@overeng/notion-datasource-sync`. The design
source of truth lives in the package-local [VRS](./vrs/spec.md).
Follow-up production-readiness work is tracked in
[GitHub issue #698](https://github.com/overengineeringstudio/effect-utils/issues/698).

Start here:

- [Getting Started](./getting-started.md): establish a workspace with
  `sync --from-notion`, run established sync, and inspect local state.
- [CLI Reference](./cli.md): commands, flags, environment variables, and output
  shape.
- [Sync Safety](./sync-safety.md): event log, outbox, fail-closed guards, and
  conflict policy.
- [Supported Capabilities](./capabilities.md): currently supported, guarded,
  and unsupported Notion surfaces.
- [Testing And Demo](./testing.md): unit/fake/live E2E, durable ledgers, and the
  automated demo page.
- [Troubleshooting](./troubleshooting.md): common setup and sync failures.
- [VRS](./vrs/spec.md): requirements-derived system contract and verification
  plan.
