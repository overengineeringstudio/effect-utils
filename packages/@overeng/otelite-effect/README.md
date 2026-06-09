# @overeng/otelite-effect

A thin, Effect-native wrapper around the [`otelite`](../otelite) CLI — the Rust
local-OTLP-capture binary in this repo. It shells out via `@effect/platform`
`Command`, decodes the CLI's JSON contract with `Schema`, and exposes it as an
`Effect.Service` with tagged errors.

The CLI's machine-readable JSON output is the **single source of truth**. This
package is an adapter: it never reimplements capture or inspect logic
(see `context/otelite/decisions/0007`).

## API

```ts
import { NodeContext } from '@effect/platform-node'
import { Effect } from 'effect'
import { Otelite } from '@overeng/otelite-effect'

const program = Effect.gen(function* () {
  const otelite = yield* Otelite

  // Run a child under capture → typed `otelite.summary/v1`.
  const summary = yield* otelite.run({ command: ['node', 'app.js'] })

  // Inspect the capture → typed flat rows.
  const spans = yield* otelite.inspect({ src: summary.out, signal: 'traces' })

  // …or the per-signal report object.
  const report = yield* otelite.inspect({ src: summary.out, signal: 'traces', summary: true })
}).pipe(Effect.scoped, Effect.provide(Otelite.Default), Effect.provide(NodeContext.layer))
```

### Surface

- **Service** `Otelite` with `run(options)`, `inspect(options)`, and `version`.
  - `run` is **scoped**: when otelite mints the out-dir (no `out` given), it is
    removed on scope close.
  - `inspect` returns typed rows (`SpanRow` / `MetricRow` / `LogRow`) or, with
    `summary: true`, the report object (`TraceSummary` / `MetricSummary` /
    `LogSummary`).
- **Schema types** for the seven `otelite.<name>/v1` outputs:
  `Summary`, `SpanRow`, `MetricRow`, `LogRow`, `TraceSummary`, `MetricSummary`,
  `LogSummary`.
- **Tagged errors**: `OteliteSpawnError`, `OteliteChildFailed`,
  `OteliteCliError` (the CLI's `sysexits.h` taxonomy), `OteliteDecodeError`.

Requires a `CommandExecutor` + `FileSystem` in context (e.g. `NodeContext.layer`)
and the `otelite` binary on `PATH`.

## Tests

The tests run the **real** nix-built `otelite` binary — no mocks, no stubs.

In the repo's dev environment the binary is already on `PATH`: `devenv.nix` adds
the `otelite` flake package to `packages`, so `dt test:otelite-effect` (or
`dt test:run`) finds it via `Command.make("otelite", …)`.

Standalone (outside the dev shell), build it and prefix `PATH`:

```sh
nix build .#otelite
PATH="$PWD/result/bin:$PATH" pnpm vitest run
```
