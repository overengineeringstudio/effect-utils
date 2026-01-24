# @overeng/mono Package

> **Note:** The `mono` CLI has been fully migrated to `dt` (devenv tasks). This package now serves as a **reusable framework** for building Effect-based CLIs, not as a direct CLI tool.

## What This Package Provides

`@overeng/mono` is a framework for building Effect-based monorepo CLIs. It provides:

- **Task primitives** - Reusable functions for common operations (lint, test, build, etc.)
- **Command factories** - Pre-built CLI commands using `@effect/cli`
- **Task system** - Concurrent task execution with live progress UI
- **Utilities** - Process management, CI detection, command execution

## Package Location

- Path: `packages/@overeng/mono`
- Exports: `@overeng/mono`

## Current Usage

While this repo now uses `dt` for all task execution, the `@overeng/mono` package remains useful for:

1. **Building CLIs in other repos** that want Effect-based task execution
2. **The task system UI** (`@overeng/mono/task-system`) for concurrent task rendering
3. **Utility functions** like `runCommand`, `startProcess`, `ciGroup`

## Task Primitives

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

## Utilities

```ts
import {
  IS_CI,        // true in CI environments
  runCommand,   // Run a shell command as Effect
  startProcess, // Start a long-running process
  ciGroup,      // Start a CI group (or print header locally)
  ciGroupEnd,   // End a CI group
} from '@overeng/mono'
```

## Task System

The task system provides concurrent task execution with live progress UI:

```ts
import { runTaskGraph, opentuiRenderer } from '@overeng/mono/task-system'
```

See `packages/@overeng/mono/src/task-system/` for details.

## For This Repo: Use `dt` Instead

All development tasks in this repo should use `dt`:

```bash
dt ts:check      # TypeScript checking
dt lint:check    # Linting
dt test:run      # Run tests
dt check:quick   # All quick checks
dt check:all     # All checks including tests
```

See [AGENTS.md](/AGENTS.md) for the full command reference.
