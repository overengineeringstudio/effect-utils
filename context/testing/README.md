# Testing Guide

This guide establishes testing conventions for effect-utils packages.

## Philosophy

- **Unit tests are always fast** — No I/O, no network, no git. Pure logic only. Target: <100ms per test.
- **Integration tests can be slower** — Real filesystems, git operations, network calls belong here.
- **No mocking unless necessary** — Prefer real implementations. Use Effect layers for dependency injection.
- **Effect-first** — Use `@effect/vitest`, Effect filesystem, and Effect patterns throughout.

## File Naming Conventions

Tests are **colocated** with source files in `src/`:

| Pattern                 | Purpose                               | Speed         |
| ----------------------- | ------------------------------------- | ------------- |
| `*.unit.test.ts`        | Unit tests (pure logic)               | Fast (<100ms) |
| `*.integration.test.ts` | Integration tests (I/O, git, network) | Slower        |
| `*.pw.test.ts`          | Playwright browser tests              | Slowest       |

```
src/
├── lib/
│   ├── graph.ts
│   ├── graph.unit.test.ts      # Unit tests next to source
│   ├── config.ts
│   └── config.unit.test.ts
├── commands/
│   ├── sync.ts
│   └── sync.integration.test.ts  # Integration test for command
└── mod.ts
```

## Running Tests via Mono

Never use `package.json` scripts. Use devenv tasks via `dt`:

```bash
dt test:run           # Run all tests
dt test:utils         # Single package (fast feedback loop)
dt test:integration   # Integration tests only
dt test:watch         # Watch mode for development
```

**Pre-commit checklist:**

```bash
dt ts:check           # Type check
dt lint:check         # Lint check
dt test:run           # Run tests
# Or run all at once:
dt check:all          # Type check + lint + test
```

## Effect Testing with @effect/vitest

Always use `@effect/vitest` instead of plain vitest. Import from the custom `Vitest` wrapper for enhanced patterns:

```typescript
import { Vitest } from '@overeng/utils-dev/node-vitest'
import { Effect, Layer } from 'effect'
import { expect } from 'vitest'
```

### The `withTestCtx` Pattern (Recommended)

**All Effect test bodies should use `withTestCtx`** for automatic layer provision, timeout management, logging, and OTEL integration:

```typescript
import { Vitest } from '@overeng/utils-dev/node-vitest'
import { Duration, Effect, Layer } from 'effect'
import { NodeContext } from '@effect/platform-node'

const testTimeout = Duration.toMillis(Duration.minutes(2))

const withTestCtx = ({ suffix }: { suffix?: string } = {}) =>
  Vitest.makeWithTestCtx({
    suffix,
    timeout: testTimeout,
    makeLayer: (testContext) =>
      Layer.mergeAll(
        NodeContext.layer,
        // Add test-specific services here
      ),
  })

Vitest.describe('MyFeature', { timeout: testTimeout }, () => {
  Vitest.scopedLive('does something', (test) =>
    Effect.gen(function* () {
      const result = yield* someEffect()
      expect(result).toBe(expected)
    }).pipe(withTestCtx()(test)),
  )
})
```

**Benefits of `withTestCtx`:**

- Automatic layer composition and provision
- Test timeout management
- Scoped resource cleanup
- Logging with test context
- OTEL tracing integration
- Consistent test setup across the codebase

### Simple Effect Tests

For simple tests without custom layers, use `it.effect`:

```typescript
import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { expect } from 'vitest'

describe('pure logic', () => {
  it.effect('parses input', () =>
    Effect.gen(function* () {
      const result = yield* parseInput('test')
      expect(result).toBe('TEST')
    }),
  )
})
```

### Scoped Resources

Use `Effect.scoped` for automatic cleanup when not using `withTestCtx`:

```typescript
it.effect('creates temp resources', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const tempDir = yield* fs.makeTempDirectory()
    // tempDir is automatically cleaned up after test
  }).pipe(Effect.provide(NodeContext.layer), Effect.scoped),
)
```

## Property-Based Testing

**Always use Effect property tests** with `Vitest.scopedLive.prop` or `Vitest.asProp`. See `@overeng/utils-dev/src/node-vitest/Vitest.ts` for the full implementation.

### Effect Property Tests with `withTestCtx` (Recommended)

Use `Vitest.scopedLive.prop` for property tests that need layers:

```typescript
import { Vitest } from '@overeng/utils-dev/node-vitest'
import { Schema } from 'effect'

const StorageType = Schema.Literal('memory', 'fs')
const AdapterType = Schema.Literal('direct', 'worker')

Vitest.describe.concurrent('sync tests', { timeout: testTimeout }, () => {
  Vitest.scopedLive.prop(
    'syncs data between clients',
    [StorageType, AdapterType],
    ([storageType, adapterType], test) =>
      Effect.gen(function* () {
        const client = yield* makeClient({ storageType, adapterType })
        const result = yield* client.sync()
        expect(result.synced).toBe(true)
      }).pipe(withTestCtx()(test)),
    { fastCheck: { numRuns: 4 } },
  )
})
```

### Complex Property Tests with `Vitest.asProp`

For property tests with many parameters and custom suffixes for debugging:

```typescript
import { Vitest } from '@overeng/utils-dev/node-vitest'
import { stringifyObject } from '@overeng/utils'

const CreateCount = Schema.Int.pipe(Schema.between(1, 100))
const BatchSize = Schema.Literal(1, 10, 50)

Vitest.asProp(
  Vitest.scopedLive,
  'concurrent operations',
  {
    storageType: StorageType,
    countA: CreateCount,
    countB: CreateCount,
    batchSize: BatchSize,
  },
  ({ storageType, countA, countB, batchSize }, test, { numRuns, runIndex }) =>
    Effect.gen(function* () {
      yield* Effect.log('Starting run', { storageType, countA, countB, batchSize })

      const [clientA, clientB] = yield* Effect.all(
        [makeClient({ id: 'a', storageType }), makeClient({ id: 'b', storageType })],
        { concurrency: 'unbounded' },
      )

      yield* clientA.createItems(countA, batchSize).pipe(Effect.fork)
      yield* clientB.createItems(countB, batchSize).pipe(Effect.fork)

      const total = countA + countB
      yield* waitForSync(clientA, clientB, total)
    }).pipe(
      withTestCtx({
        suffix: stringifyObject({ storageType, countA, countB, batchSize }),
      })(test),
      Effect.logDuration(`Run ${runIndex + 1}/${numRuns}`),
    ),
  { fastCheck: { numRuns: IS_CI ? 6 : 20 } },
)
```

### Schema-Based Arbitraries

Use Effect Schema types directly as property test parameters:

```typescript
const TodoSchema = Schema.Struct({
  id: Schema.UUID,
  text: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100)),
  completed: Schema.Boolean,
})

Vitest.scopedLive.prop('processes any todo', [TodoSchema], ([todo], test) =>
  Effect.gen(function* () {
    const result = yield* processTodo(todo)
    expect(result.id).toBe(todo.id)
  }).pipe(withTestCtx()(test)),
)
```

### Debugger-Aware Configuration

Use `Vitest.DEBUGGER_ACTIVE` to switch between debug and CI configurations:

```typescript
Vitest.asProp(
  Vitest.scopedLive,
  'my prop test',
  Vitest.DEBUGGER_ACTIVE
    ? {
        // Fixed values for debugging
        storageType: Schema.Literal('fs'),
        count: Schema.Literal(3),
      }
    : {
        // Full range for CI/normal runs
        storageType: StorageType,
        count: CreateCount,
      },
  (params, test) =>
    Effect.gen(function* () {
      // test body
    }).pipe(withTestCtx()(test)),
  Vitest.DEBUGGER_ACTIVE
    ? { fastCheck: { numRuns: 1 }, timeout: testTimeout * 100 }
    : { fastCheck: { numRuns: IS_CI ? 6 : 20 } },
)
```

## What Belongs Where

### Unit Tests (`.unit.test.ts`)

✅ **Include:**

- Pure functions
- Schema validation
- Graph algorithms
- State machines
- Parsers
- Transformers
- Business logic

❌ **Exclude:**

- File system operations
- Git commands
- Network requests
- Database queries
- External process execution

### Integration Tests (`.integration.test.ts`)

✅ **Include:**

- CLI commands
- File system operations
- Git operations
- Network calls
- End-to-end workflows
- Multi-component interactions

## Effect FileSystem (Not node:fs)

**Never use `node:fs` directly.** Use Effect's `FileSystem` service:

```typescript
// ❌ Don't do this
import fs from 'node:fs'
fs.writeFileSync(path, content)

// ✅ Do this
import { FileSystem } from '@effect/platform'
import { NodeFileSystem } from '@effect/platform-node'

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  yield* fs.writeFileString(path, content)
})

// Provide the layer
program.pipe(Effect.provide(NodeFileSystem.layer))
```

### Temporary Directories

```typescript
it.effect('works with temp files', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    // Automatically cleaned up with Effect.scoped
    const tempDir = yield* fs.makeTempDirectory()

    yield* fs.writeFileString(`${tempDir}/test.txt`, 'content')
    const content = yield* fs.readFileString(`${tempDir}/test.txt`)

    expect(content).toBe('content')
  }).pipe(Effect.provide(NodeFileSystem.layer), Effect.scoped),
)
```

## Vitest Configuration

Each package should have a `vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Unit tests only by default
    include: ['src/**/*.unit.test.ts'],
    // Exclude integration and playwright tests
    exclude: ['src/**/*.integration.test.ts', 'src/**/*.pw.test.ts'],
    // Required for @effect/vitest
    server: { deps: { inline: ['@effect/vitest'] } },
  },
})
```

For integration tests, create `vitest.integration.config.ts`:

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    server: { deps: { inline: ['@effect/vitest'] } },
  },
})
```

## Playwright Configuration

For browser tests (`.pw.test.ts`), use `createPlaywrightConfig`:

```typescript
import { createPlaywrightConfig } from '@overeng/utils/node/playwright'

export default createPlaywrightConfig({
  testDir: './src',
  testMatch: '**/*.pw.test.ts',
  webServer: {
    command: './node_modules/.bin/vite --port {{port}}',
  },
})
```

**Port injection:** The `{{port}}` placeholder is replaced at runtime with a dynamically allocated free port. This avoids port conflicts when running multiple Playwright test suites in parallel (e.g., across different packages in a monorepo or parallel CI jobs). Never hardcode ports in test configurations.

## Anti-Patterns

| ❌ Avoid                            | ✅ Instead                                  |
| ----------------------------------- | ------------------------------------------- |
| `node:fs`                           | `@effect/platform` FileSystem               |
| `setTimeout` / `sleep` for timing   | `TestClock` or proper async coordination    |
| Mocking when real impl works        | Effect layers for dependency injection      |
| `package.json` scripts              | `mono` CLI                                  |
| Tests in separate `test/` directory | Colocate with source in `src/`              |
| `*.test.ts` (ambiguous)             | `*.unit.test.ts` or `*.integration.test.ts` |
| `it.prop()` (non-Effect)            | `Vitest.scopedLive.prop()` with Effect      |
| Manual layer provision in each test | `withTestCtx` / `makeWithTestCtx`           |
| `Effect.runPromise` in tests        | `Vitest.scopedLive` or `it.effect`          |
