# @overeng/utils

Shared Effect utilities for the overeng ecosystem.

## Installation

```bash
pnpm add @overeng/utils
```

## Features

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

### Node (`@overeng/utils/node`)

- `FileSystemBacking` - File-based backing implementation for Node.js
- `CurrentWorkingDirectory` - Service capturing process CWD, with test overrides
- `EffectUtilsWorkspace` - Workspace root service backed by `WORKSPACE_ROOT`
- `cmd` - Command runner returning exit codes with optional logging/retention
- `cmdText` - Command runner returning stdout as text

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

## Known Issues

This package uses a pnpm patch for [`effect-distributed-lock`](https://github.com/ethanniser/effect-distributed-lock)@0.0.10 to work around a packaging issue where the published npm package is missing the `dist` folder.

See: https://github.com/ethanniser/effect-distributed-lock/issues/7

The patch modifies the package exports to point to the TypeScript source files instead of the missing compiled output.

## Upstream Contribution

The `FileSystemBacking` implementation in this package has been proposed for inclusion in the upstream [`effect-distributed-lock`](https://github.com/ethanniser/effect-distributed-lock) package.

See: https://github.com/ethanniser/effect-distributed-lock/issues/8
