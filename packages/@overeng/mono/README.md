# @overeng/mono

Framework for building Effect-based monorepo CLIs with reusable task primitives and commands.

## Features

- Pre-built commands for common monorepo tasks (build, test, lint, typecheck, clean)
- CI-aware output with GitHub Actions groups
- Interactive mode with live progress via TaskRunner
- Composable task primitives for custom workflows

## Usage

```ts
#!/usr/bin/env bun
import {
  runMonoCli,
  buildCommand,
  testCommand,
  lintCommand,
  tsCommand,
  cleanCommand,
  checkCommand,
  createStandardCheckConfig,
} from '@overeng/mono'

const oxcConfig = { configPath: 'packages/@overeng/oxc-config' }
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
    lintCommand({ oxcConfig, genieConfig }),
    tsCommand(),
    cleanCommand(),
    checkCommand(createStandardCheckConfig({ oxcConfig, genieConfig })),
  ],
})
```

## Commands

| Command | Description                                               |
| ------- | --------------------------------------------------------- |
| `build` | Build all packages (tsc --build)                          |
| `test`  | Run tests with vitest                                     |
| `lint`  | Check formatting and linting (--fix to auto-fix)          |
| `ts`    | Type check (--watch, --clean options)                     |
| `clean` | Remove build artifacts                                    |
| `check` | Run all checks (genie + typecheck + format + lint + test) |

## Task Primitives

For custom commands, use the underlying task primitives:

```ts
import {
  // Format
  formatCheck,
  formatFix,
  // Lint
  lintCheck,
  lintFix,
  // Genie
  genieCheck,
  checkGenieCoverage,
  // TypeScript
  typeCheck,
  typeCheckWatch,
  typeCheckClean,
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

## CI vs Interactive Mode

The `check` command automatically detects CI environments:

- **CI mode**: Sequential execution with GitHub Actions groups for collapsible output
- **Interactive mode**: Concurrent execution with live TaskRunner progress display
