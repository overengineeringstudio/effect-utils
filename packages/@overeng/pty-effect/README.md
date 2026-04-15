# @overeng/pty-effect

Effect-native wrapper around [`@myobie/pty`](https://github.com/myobie/pty) for
spawning and driving pseudoterminal sessions inside Effect programs.

## Status

This package now has two layers:

- the root `@overeng/pty-effect` entrypoint wraps `@myobie/pty/testing` for
  scope-bound PTY sessions in tests
- the `@overeng/pty-effect/client` subpath wraps PTY's detached daemon client
  API for long-lived sessions, tags/metadata, stats, and event streams

Both track PTY's published `0.8.x` package surface. The `/client` wrapper keeps
the Effect-first API while staying aligned with PTY session tags, session/event
schemas, and daemon lifecycle semantics.

Platform support: macOS and Linux. `@myobie/pty` is Unix-only.

## Install

```sh
pnpm add @overeng/pty-effect @myobie/pty effect
```

## Quick start

```ts
import { Effect, Schedule } from 'effect'
import { makePtySession, PtySpec_ } from '@overeng/pty-effect'

const program = Effect.scoped(
  Effect.gen(function* () {
    const session = yield* makePtySession(PtySpec_.spawn({ command: 'bash', args: ['--norc'] }))

    yield* session.type({ text: 'echo hello-world' })
    yield* session.press({ key: 'return' as never })

    const ss = yield* session.waitForText({
      needle: 'hello-world',
      schedule: Schedule.spaced('20 millis'),
    })
    console.log(ss.lines)
  }),
)
```

The session is bound to the surrounding `Scope`. When the scope closes (normal
exit, error, interruption, timeout), the underlying process is killed and the
xterm-headless buffer is released. There is no leak path.

## Concepts

### `PtySpec`

Tagged union describing how to create a session.

- `PtySpec_.spawn({ command, args?, cwd?, env?, size? })` — direct PTY backed
  by a child process. Use for testing CLI tools and TUI apps.
- `PtySpec_.server({ command, args?, cwd?, size?, name? })` — persistent
  `PtyServer` with a Unix socket. Use when you need detach/reattach,
  multi-client, or to test resize negotiation. Call `session.attach` after
  spawn to start receiving output.

### `PtySession`

Effect-native handle. All methods return `Effect`s tagged with `PtyError`.

All methods take a single object argument and return `Effect`s tagged with `PtyError`.

| Method                                      | Effect                                 |
| ------------------------------------------- | -------------------------------------- |
| `screenshot`                                | `Effect<Screenshot, PtyError>`         |
| `screenshots({ schedule })`                 | `Stream<Screenshot, PtyError>`         |
| `write({ data })`                           | `Effect<void, PtyError>`               |
| `type({ text })`                            | `Effect<void, PtyError>`               |
| `press({ key })`                            | `Effect<void, PtyError>`               |
| `resize({ rows, cols })`                    | `Effect<void, PtyError>`               |
| `attach`                                    | `Effect<void, PtyError>` (server-mode) |
| `reconnect`                                 | `Effect<void, PtyError>` (server-mode) |
| `waitFor({ predicate, schedule?, label? })` | `Effect<A, PtyError>`                  |
| `waitForText({ needle, schedule? })`        | `Effect<Screenshot, PtyError>`         |
| `waitForAbsent({ needle, schedule? })`      | `Effect<Screenshot, PtyError>`         |

### `Schedule`-driven polling

`waitFor*` is implemented as `Stream.repeatEffectWithSchedule(screenshot,
schedule) >> filterMap(predicate) >> runHead`. Pass any `Schedule` to control
cadence and backoff:

```ts
import { Schedule } from 'effect'

// Tight initial polls, falling back to a slower steady state.
const adaptive = Schedule.exponential('5 millis').pipe(
  Schedule.either(Schedule.spaced('200 millis')),
)

yield * session.waitForText({ needle: 'Ready', schedule: adaptive })
```

This composes naturally with `Effect.timeout`, `Effect.race`, and
`Effect.interrupt` for deadlines and cancellation — no `setTimeout`-based
polling, no detached promises.

### `PtyError`

Single `Schema.TaggedError` union with a `reason` discriminator. Schema-based
so it serializes cleanly across worker boundaries.

```ts
class PtyError extends Schema.TaggedError(...)('PtyError', {
  reason: Schema.Literal(
    'SpawnFailed', 'ConnectFailed', 'WriteFailed', 'ResizeFailed',
    'Timeout', 'UnexpectedExit', 'BadName', 'Closed',
  ),
  method: Schema.String,
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect),
}) {}
```

### `PtySpawner` service + Layer

For dependency-injected use:

```ts
import { Effect, Layer } from 'effect'
import { PtySpawner, layer as ptyLayer } from '@overeng/pty-effect'

const program = Effect.gen(function* () {
  const spawner = yield* PtySpawner
  const session = yield* spawner.spawn(PtySpec_.spawn({ command: 'cat' }))
  // ...
})

Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(ptyLayer)))
```

## Design notes

### Scope-bound, kill-on-close, no leak path

`PtySession` is acquired with `Effect.acquireRelease`. The release calls
upstream's `session.close()`, which kills the child (spawn mode) or destroys
the socket and `PtyServer` (server mode).

We deliberately do not expose a "leak the daemon" escape hatch. Effect's
scoping contract is: when the scope closes, resources are released. A pty
that survives its owning scope is either (a) a long-lived service that
should own its own root scope (build it as a `Layer.scopedDiscard` whose
scope outlives the workload), or (b) a bug. There's no third option that
isn't a footgun.

This is a tradeoff against `@myobie/pty`'s native model, where daemons
persist by default and clients freely attach/detach. If you want that
behavior, use the `/client` subpath, which exposes the detached PTY daemon
surface through `PtyClient`.

### Why `Stream<Screenshot>`, not `Stream<Uint8Array>`

Upstream's `Session` is built on `xterm-headless`. There is no exposed byte
stream — the public observable surface is the rendered terminal state via
`screenshot()`. Wrapping it as `Stream<Screenshot>` is faithful to that
model and good enough for every TUI testing use case we have today.

If/when we need raw bytes (e.g. for a pipe-to-disk recorder), it'll come
from the future `/client` subpath, where `SessionConnection`'s `data` event
gives us bytes directly.

### Bun compatibility

PTY's published `spawnDaemon` launches its detached server via
`process.execPath`. That works in Node, but Bun-built CLIs need a Node-based
launcher so the upstream PTY server still boots in a Node runtime with the
native addon available. The `/client` wrapper handles that internally while
preserving PTY's daemon config model instead of falling back to the CLI.

### Test isolation

Tests set `PTY_SESSION_DIR` to a per-test temp directory before constructing
each session. This prevents server-mode socket/pid/lock files from colliding
across tests, processes, or developer machines. See
`src/PtySession.test.ts:withIsolatedDir`.

## Roadmap

- `Stream<PtyEvent, PtyError>` on `PtySession` (schemas already defined).
- `Sink<void, string, never, PtyError>` for piping a `Stream` of input into
  a session.
- Continue closing the small parity gap between the published PTY client API
  and the Effect wrapper for stateless helpers such as socket/path utilities.
