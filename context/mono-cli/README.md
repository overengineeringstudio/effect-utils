# Mono CLI Pattern

Framework for building Effect-based monorepo CLIs using `@overeng/mono`. Provides
reusable task primitives and command factories for common monorepo operations.

## Package

- Path: `packages/@overeng/mono`
- Exports: `@overeng/mono`

## Prerequisites

Expects `oxlint.json` and `oxfmt.json` config files at repo root. These are auto-discovered by oxlint/oxfmt. See [oxc-config guide](../oxc-config/README.md) for setup.

## Quick Start

```ts
#!/usr/bin/env bun

import {
  buildCommand,
  checkCommandWithTaskSystem,
  cleanCommand,
  lintCommand,
  runMonoCli,
  testCommand,
  tsCommand,
} from '@overeng/mono'

const genieConfig = {
  scanDirs: ['packages', 'scripts'],
  skipDirs: ['node_modules', 'dist', '.git'],
}

runMonoCli({
  name: 'mono',
  version: '0.1.0',
  description: 'Monorepo management CLI',
  commands: [
    buildCommand(),
    testCommand(),
    lintCommand(genieConfig),
    tsCommand(),
    cleanCommand(),
    checkCommandWithTaskSystem({ genieConfig }),
  ],
})
```

## Standard Commands

| Command | Description                               | Options                              |
| ------- | ----------------------------------------- | ------------------------------------ |
| `build` | Build all packages (tsc --build)          | -                                    |
| `test`  | Run tests                                 | `--unit`, `--integration`, `--watch` |
| `lint`  | Check formatting and linting              | `--fix`                              |
| `ts`    | TypeScript type checking                  | `--watch`, `--clean`                 |
| `clean` | Remove build artifacts                    | -                                    |
| `check` | Run all checks (genie + ts + lint + test) | -                                    |

## Configuration Types

### GenieCoverageConfig

```ts
interface GenieCoverageConfig {
  /** Directories to scan for config files that should have genie sources */
  scanDirs: string[]
  /** Directories to skip when scanning */
  skipDirs: string[]
}
```

### TypeCheckConfig

```ts
interface TypeCheckConfig {
  /** Path to tsconfig file (default: 'tsconfig.all.json') */
  tsconfigPath?: string
}
```

## Task Primitives

For custom commands or compositions, use the task primitives directly:

```ts
import {
  // Format
  formatCheck,
  formatFix,
  // Lint
  lintCheck,
  lintFix,
  // Genie
  checkGenieCoverage,
  genieCheck,
  // TypeScript
  typeCheck,
  typeCheckClean,
  typeCheckWatch,
  // Test
  testRun,
  testWatch,
  // Build
  build,
  // Composite
  allLintChecks,
  allLintFixes,
} from '@overeng/mono'
```

## Custom Commands

Add custom commands alongside standard ones:

```ts
import { Command } from '@effect/cli'
import { Effect } from 'effect'
import { runMonoCli, buildCommand, runCommand } from '@overeng/mono'

const deployCommand = Command.make('deploy', {}, () =>
  Effect.gen(function* () {
    yield* runCommand({ command: 'fly', args: ['deploy'] })
  }),
).pipe(Command.withDescription('Deploy to Fly.io'))

runMonoCli({
  name: 'mono',
  version: '0.1.0',
  description: 'My CLI',
  commands: [
    buildCommand(),
    deployCommand, // Custom command
  ],
})
```

## CI vs Interactive Mode

The check command automatically detects CI environments and adjusts output:

- **CI mode**: Sequential execution with GitHub Actions groups (`::group::`)
- **Interactive mode**: Concurrent execution with live inline progress display

## Utilities

```ts
import {
  IS_CI, // true in CI environments
  runCommand, // Run a shell command as Effect
  startProcess, // Start a long-running process
  ciGroup, // Start a CI group (or print header locally)
  ciGroupEnd, // End a CI group
} from '@overeng/mono'
```

## Package Setup

Add `@overeng/mono` to your scripts package:

```ts
// scripts/package.json.genie.ts
export default pkg.package({
  name: 'my-scripts',
  private: true,
  type: 'module',
  dependencies: [
    '@effect/cli',
    '@effect/platform',
    '@effect/platform-node',
    '@overeng/mono',
    'effect',
  ],
})
```

Add TypeScript reference:

```ts
// scripts/tsconfig.json.genie.ts
export default tsconfigJSON({
  extends: '../tsconfig.base.json',
  compilerOptions: { noEmit: true, rootDir: '.' },
  references: [{ path: '../effect-utils/packages/@overeng/mono' }],
})
```

## Layers Provided

`runMonoCli` automatically provides these layers:

- `NodeContext.layer` (FileSystem, CommandExecutor, etc.)
- `CurrentWorkingDirectory.live`
- `Logger.minimumLogLevel(LogLevel.Debug)`
