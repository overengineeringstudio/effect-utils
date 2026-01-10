# pnpm Internals

Understanding pnpm's internal behavior is essential for pnpm-compose. This document captures findings from experimentation and source analysis.

## State files

pnpm v10 uses two state files in `node_modules/`:

| File                            | Purpose                     | Created when              |
| ------------------------------- | --------------------------- | ------------------------- |
| `.modules.yaml`                 | npm registry package config | Any npm package installed |
| `.pnpm-workspace-state-v1.json` | Workspace package state     | Workspace packages exist  |

### `.modules.yaml`

Stores pnpm configuration, NOT symlink targets:

```yaml
layoutVersion: 5 # node_modules structure version
nodeLinker: isolated # isolated, hoisted, or pnp
packageManager: pnpm@10.17.1
prunedAt: Wed, 07 Jan 2026 18:23:02 GMT
storeDir: /Users/.../pnpm/store/v10
virtualStoreDir: .pnpm
hoistPattern: ['*']
hoistedDependencies:
  'lodash@4.17.21':
    lodash: private
```

### `.pnpm-workspace-state-v1.json`

Tracks workspace packages and validation state:

```json
{
  "lastValidatedTimestamp": 1767810133289,
  "projects": {
    "/path/to/root": { "name": "my-app" },
    "/path/to/packages/utils": { "name": "@acme/utils", "version": "1.0.0" }
  },
  "settings": {
    "nodeLinker": "isolated",
    "workspacePackagePatterns": ["packages/*", "submodules/lib/packages/*"]
  }
}
```

## Symlink behavior

pnpm determines expected symlinks from **lockfile + workspace config**, not from state files.

| Action                         | npm pkg symlinks                   | workspace pkg symlinks             |
| ------------------------------ | ---------------------------------- | ---------------------------------- |
| `pnpm install`                 | Restores to .pnpm store            | Restores to workspace source       |
| `pnpm install --lockfile-only` | **Preserves** manual overrides     | **Preserves** manual overrides     |
| Manual symlink change          | Overwritten by next `pnpm install` | Overwritten by next `pnpm install` |

**Key insight**: `pnpm install` always restores symlinks to expected targets. `--lockfile-only` only updates the lockfile and leaves symlinks untouched.

## Why the symlink dance works

1. `pnpm install` creates symlinks: `node_modules/effect → .pnpm/effect@3.x/node_modules/effect`
2. We replace with our override: `node_modules/effect → submodules/effect/packages/effect`
3. `pnpm install --lockfile-only` updates lockfile but **preserves our symlink**

This works because `--lockfile-only` skips the linking phase entirely.

## Corruption scenarios

### Scenario: `pnpm install` run in submodule

**What happens:**

1. User/agent runs `pnpm install` inside `submodules/lib/`
2. pnpm creates `submodules/lib/node_modules/` with its own .pnpm store
3. Parent workspace symlinks now point to wrong locations
4. Import resolution fails with confusing errors

**Detection signals:**

- `submodules/*/node_modules/` directories exist
- `submodules/*/node_modules/.modules.yaml` exists
- Multiple `.pnpm` directories in the tree

**Symptoms:**

- "Cannot find module" errors
- Type errors from duplicate type definitions
- Wrong package versions being resolved
- Inconsistent behavior between packages

### Scenario: Lockfile out of sync

**What happens:**

1. Submodule's lockfile diverges from parent's understanding
2. `pnpm install --lockfile-only` updates lockfile but symlinks become stale

**Detection:**

- Compare lockfile hashes before/after operations

## Detection strategies

### Check for pnpm-specific files in submodules

Look for `.modules.yaml` or `.pnpm/` directory - these are pnpm-specific and indicate `pnpm install` was run. This distinguishes from legitimate node_modules created by bun or other tools.

```typescript
const detectPnpmCorruption = (composedRepos: ComposedRepo[]) =>
  Effect.gen(function* () {
    const corrupted: string[] = []
    for (const repo of composedRepos) {
      const modulesYaml = `${repo.path}/node_modules/.modules.yaml`
      const pnpmDir = `${repo.path}/node_modules/.pnpm`
      if ((yield* fs.exists(modulesYaml)) || (yield* fs.exists(pnpmDir))) {
        corrupted.push(repo.path)
      }
    }
    return corrupted
  })
```

### Validate symlink targets

Compare actual symlink targets against expected targets from workspace config.

## Repair strategies

### Clean submodule node_modules

```bash
rm -rf submodules/*/node_modules
```

Then re-run the symlink dance from the parent repo.

### Automatic repair

When corruption is detected:

1. Log clear warning explaining what happened
2. Remove rogue node_modules
3. Re-run the symlink dance

## layoutVersion compatibility

The `layoutVersion` in `.modules.yaml` indicates pnpm's internal structure version:

- Version 5: Current as of pnpm v10
- If this changes in future pnpm versions, may need clean install

## References

- [@pnpm/modules-yaml](https://github.com/pnpm/modules-yaml) - State file handling
- [pnpm store structure](https://pnpm.io/symlinked-node-modules-structure) - How .pnpm works
