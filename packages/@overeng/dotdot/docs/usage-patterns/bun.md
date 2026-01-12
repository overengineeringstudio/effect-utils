# Using dotdot with Bun

Bun handles package installation within each repo. This guide covers configuration for dotdot's flat peer repo model.

## Core Setup

### Avoid Bun Monorepo Features

Bun's monorepo features assume centralized dependency management. dotdot repos are independent.

**Don't use:** `workspaces`, `bun link`, shared lockfiles, catalog

**Do use:** `file:` protocol, per-package `bun.lock`, `--isolated` mode

### Package References

```json
{
  "dependencies": {
    "@org/shared-lib": "file:../shared-lib"
  }
}
```

### Isolated Mode (Recommended)

Prevents transitive dependency conflicts by keeping each package's deps nested:

```toml
# bunfig.toml
[install]
isolated = true
```

Without isolation, Bun hoists deps which can cause version conflicts when `file:` dependencies have different version requirements than the consumer.

### Per-Package Lock Files

Each repo gets its own `bun.lock`. Commit it to git. The lockfile tracks transitive deps from `file:` refs using path prefixes:

```json
{
  "packages": {
    "@org/shared-lib": ["@org/shared-lib@file:../shared-lib", {...}],
    "@org/shared-lib/effect": ["effect@3.14.8", ...]
  }
}
```

## Symlink Behavior

Bun symlinks `file:` dependencies rather than copying. This is exactly what dotdot needs:

```
app/node_modules/@org/shared-lib/src/mod.ts
  → /workspace/shared-lib/src/mod.ts
```

**Benefits:**
- Live updates - source changes visible immediately without reinstalling
- No duplication - multiple consumers share actual source files
- Fast installs - no copying required

**When to reinstall:**
- `file:` dep adds/removes dependencies in its package.json
- You add/remove a `file:` dependency

**No reinstall needed:**
- Source file changes in any repo

## Gotchas

### Install Order

`file:` deps' node_modules are **not** auto-installed. Install each repo independently:

```bash
dotdot exec -- bun install
```

### Workspace Auto-Detection

Bun looks for `workspaces` in package.json to detect monorepos. If any repo accidentally declares this, Bun may hoist dependencies incorrectly. Keep `workspaces` out of all package.json files.

### Cache Invalidation

After renaming or moving a `file:` dependency:

```bash
bun install --force
```

### Circular Dependencies

Bun handles circular `file:` refs at install time, but runtime initialization order can still cause issues if modules depend on each other during load.

## TypeScript

For cross-repo imports, configure paths:

```json
{
  "compilerOptions": {
    "moduleResolution": "bundler",
    "paths": {
      "@org/shared-lib": ["../shared-lib/src/mod.ts"],
      "@org/shared-lib/*": ["../shared-lib/src/*"]
    }
  }
}
```

Or rely on Bun's runtime resolution for `.ts` imports.
