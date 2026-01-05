# @overeng/utils

Shared Effect utilities for the overeng ecosystem.

## Installation

```bash
bun add @overeng/utils
```

## Features

### Key Features

- Workspace-aware command helpers (`cmd`, `cmdText`) with optional logging and retention
- Effect-native access to current working directory via `CurrentWorkingDirectory`
- Workspace root service backed by `WORKSPACE_ROOT` via `EffectUtilsWorkspace`
- File system-backed distributed locks with TTL expiration and atomic operations

### Distributed Lock / Semaphore

This package re-exports and extends [effect-distributed-lock](https://github.com/ethanniser/effect-distributed-lock) with additional backing implementations.

#### File System Backing

For single-machine scenarios where you need to coordinate locks across multiple Node.js processes (e.g., parallel builds, CLI tools), use the file-based backing:

```typescript
import { FileSystemBacking } from '@overeng/utils/node'
import { DistributedSemaphore } from '@overeng/utils'
import { Effect, Duration } from 'effect'
import { NodeContext } from '@effect/platform-node'

const program = Effect.gen(function* () {
  const semaphore = yield* DistributedSemaphore.make({
    key: 'my-resource',
    limit: 1,
    ttl: Duration.seconds(30),
  })

  yield* semaphore.withPermit(
    Effect.gen(function* () {
      // Critical section - only one process can execute this at a time
      yield* Effect.log('Acquired lock, doing work...')
      yield* Effect.sleep(Duration.seconds(5))
    }),
  )
})

const backingLayer = FileSystemBacking.layer({
  lockDir: '/tmp/my-app-locks',
})

program.pipe(
  Effect.provide(backingLayer),
  Effect.provide(NodeContext.layer),
  Effect.runPromise,
)
```

#### How It Works

```
{lockDir}/
  {key}/
    {holderId-1}.lock   # Contains { permits: N, expiresAt: timestamp }
    {holderId-2}.lock
```

- Each semaphore key gets its own subdirectory
- Each holder gets its own lock file with permit count and expiry
- Lock files are written atomically using write-to-temp-then-rename
- TTL-based expiration handles crashed processes with automatic cleanup
- File system watching provides push-based notifications when permits are released

#### Force Revoke / Lock Stealing

The file-system backing provides additional functions for forcibly revoking locks, useful for recovering from dead processes or administrative intervention:

```typescript
import { FileSystemBacking } from '@overeng/utils/node'
import { Effect } from 'effect'

const options = { lockDir: '/tmp/my-app-locks' }

// List all active holders for a key
const holders = yield* FileSystemBacking.listHolders(options, 'my-resource')
// Returns: [{ holderId: 'abc', permits: 1, expiresAt: 1234567890 }, ...]

// Force revoke a specific holder's permits
const revokedPermits = yield* FileSystemBacking.forceRevoke(
  options,
  'my-resource',
  'holder-id-to-revoke',
)

// Nuclear option: revoke all holders for a key
const allRevoked = yield* FileSystemBacking.forceRevokeAll(options, 'my-resource')
// Returns: [{ holderId: 'abc', permits: 1 }, { holderId: 'def', permits: 2 }]
```

After a force revoke, the victim holder's next TTL refresh will fail, triggering `LockLostError` in their `withPermits` scope.

See upstream feature request: https://github.com/ethanniser/effect-distributed-lock/issues/9

#### Limitations

- **Eventually consistent permit counting**: While individual lock file operations are atomic, the total permit count across holders is read from multiple files
- **Single machine only**: For distributed systems across multiple machines, use the Redis backing from [`effect-distributed-lock`](https://github.com/ethanniser/effect-distributed-lock)

## Exports

### Isomorphic (`@overeng/utils`)

Re-exports from [`effect-distributed-lock`](https://github.com/ethanniser/effect-distributed-lock):

- `DistributedSemaphore` - Main semaphore interface
- `DistributedSemaphoreBacking` - Backing store service interface
- `SemaphoreBackingError` - Error type for backing operations
- `LockLostError` - Error when lock TTL expires unexpectedly
- `Backing` - Backing module namespace

Debug utilities:

- `withScopeDebug` - Enable scope/finalizer tracing for an effect
- `addTracedFinalizer` - Register a finalizer with debug logging
- `withTracedScope` - Run an effect in a traced scope
- `traceFinalizer` - Wrap a finalizer effect with tracing

### Node (`@overeng/utils/node`)

- `makeFileLogger` - Pretty-printed file logger with span support
- `dumpActiveHandles` - Inspect active Node.js handles preventing exit
- `monitorActiveHandles` - Periodic monitoring of active handles
- `logActiveHandles` - Log active handles to Effect logger
- `FileSystemBacking` - File-based backing implementation for Node.js
  - `layer` - Create the backing layer
  - `forceRevoke` - Forcibly revoke a holder's permits
  - `forceRevokeAll` - Revoke all holders for a key
  - `listHolders` - List active holders with their info
  - `HolderInfo` - Type for holder information
  - `HolderNotFoundError` - Error when target holder doesn't exist
- `CurrentWorkingDirectory` - Service capturing process CWD, with test overrides
- `EffectUtilsWorkspace` - Workspace root service backed by `WORKSPACE_ROOT`
- `cmd` - Command runner returning exit codes with optional logging/retention
- `cmdText` - Command runner returning stdout as text

### File Logger

`makeFileLogger` creates a Layer that writes pretty-printed logs to a file. Useful for debugging long-running processes or capturing logs from background workers.

```ts
import { Effect } from 'effect'
import { makeFileLogger } from '@overeng/utils/node'

const program = Effect.gen(function* () {
  yield* Effect.log('Application started')
  yield* Effect.logDebug('Debug details', { config: { port: 3000 } })

  yield* Effect.gen(function* () {
    yield* Effect.log('Inside operation')
  }).pipe(Effect.withSpan('my-operation'))
})

program.pipe(
  Effect.provide(makeFileLogger('/tmp/app.log', { threadName: 'main' })),
  Effect.runPromise,
)
```

Output in `/tmp/app.log`:

```
[14:23:45.123 main] INFO (#0): Application started
[14:23:45.124 main] DEBUG (#0): Debug details
  { config: { port: 3000 } }
[14:23:45.125 main] INFO (#0) my-operation (2ms): Inside operation
```

Options:

- `threadName` - Label to identify the log source (e.g., 'main', 'worker-1')
- `colors` - Include ANSI color codes (default: false, useful when tailing with `less -R`)

### Workspace Helpers

`CurrentWorkingDirectory` exposes the current working directory through the Effect
environment so it can be overridden in tests or nested executions. Utilities like
`cmd` and `cmdText` read from this service.

```ts
import { NodeContext } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { cmd, CurrentWorkingDirectory } from '@overeng/utils/node'

const program = Effect.gen(function* () {
  yield* cmd(['echo', 'hello'])
})

program.pipe(
  Effect.provide(Layer.mergeAll(NodeContext.layer, CurrentWorkingDirectory.live)),
  Effect.runPromise,
)
```

Use `EffectUtilsWorkspace` when you want a workspace root derived from `WORKSPACE_ROOT`:

```ts
import { Effect, Layer } from 'effect'
import { EffectUtilsWorkspace } from '@overeng/utils/node'

const WorkspaceLayer = Layer.mergeAll(
  EffectUtilsWorkspace.live,
  EffectUtilsWorkspace.toCwd('packages'),
)
```

### Browser (`@overeng/utils/browser`)

Debug utilities for browser environments:

- `BroadcastLoggerLive` - Logger layer that broadcasts via BroadcastChannel (worker side)
- `makeBroadcastLogger` - Create a broadcast logger for SharedWorkers
- `makeLogBridgeLive` - Effect-native log bridge with source filtering (tab side)
- `logStream` - Stream of broadcast log entries for custom processing
- `formatLogEntry` - Format a log entry for display

Other browser utilities:

- `base64` - Base64 encoding/decoding
- `OPFS` - Origin Private File System utilities
- `WebLock` - Web Locks API utilities
- `prettyBytes` - Byte formatting

### SharedWorker Log Bridging

Capture logs from SharedWorkers and display them in a tab. Supports multiple workers via the `source` identifier.

```ts
// ═══════════════════════════════════════════════════════════════════════════
// SharedWorker side (sync-worker.ts)
// ═══════════════════════════════════════════════════════════════════════════
import { Effect } from 'effect'
import { BroadcastLoggerLive } from '@overeng/utils/browser'

const workerProgram = Effect.gen(function* () {
  yield* Effect.log('Sync worker initialized')
  yield* Effect.logDebug('Connecting to database...')

  yield* Effect.gen(function* () {
    yield* Effect.log('Syncing records')
  }).pipe(Effect.withSpan('sync-operation'))
}).pipe(
  // All Effect.log calls broadcast to connected tabs
  Effect.provide(BroadcastLoggerLive('sync-worker'))
)

// ═══════════════════════════════════════════════════════════════════════════
// Tab side (main.ts) - Option 1: Effect-native bridge (recommended)
// ═══════════════════════════════════════════════════════════════════════════
import { Effect } from 'effect'
import { makeLogBridgeLive } from '@overeng/utils/browser'

const app = Effect.gen(function* () {
  yield* Effect.log('App started')
  // Worker logs appear through Effect's logger with annotations
}).pipe(
  Effect.provide(makeLogBridgeLive()),
  // Or filter to specific workers:
  // Effect.provide(makeLogBridgeLive({ sources: ['sync-worker'] })),
  Effect.scoped,
)

// ═══════════════════════════════════════════════════════════════════════════
// Tab side - Option 2: Stream-based processing
// ═══════════════════════════════════════════════════════════════════════════
import { Effect, Stream } from 'effect'
import { logStream, formatLogEntry } from '@overeng/utils/browser'

const logViewer = logStream.pipe(
  Stream.filter((entry) => entry.source === 'sync-worker'),
  Stream.runForEach((entry) =>
    Effect.sync(() => console.log(formatLogEntry(entry)))
  ),
)
```

## Known Issues

This package uses a bun patch for [`effect-distributed-lock`](https://github.com/ethanniser/effect-distributed-lock)@0.0.10 to work around a packaging issue where the published npm package is missing the `dist` folder.

See: https://github.com/ethanniser/effect-distributed-lock/issues/7

The patch modifies the package exports to point to the TypeScript source files instead of the missing compiled output.

## Upstream Contribution

The `FileSystemBacking` implementation in this package has been proposed for inclusion in the upstream [`effect-distributed-lock`](https://github.com/ethanniser/effect-distributed-lock) package.

See: https://github.com/ethanniser/effect-distributed-lock/issues/8
