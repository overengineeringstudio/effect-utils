# pnpm Issues

## pnpm `file:` dependencies cause TypeScript errors

> **Status: SOLVED** - Use `link:` protocol (primary) + `enableGlobalVirtualStore` (for remaining `file:` deps)
>
> For a detailed comparison of bun vs pnpm monorepo linking behavior, see:
> https://gist.github.com/schickling/d05fe50fe4ffb1c2e9e48c8623579d7e

When using pnpm with `file:../path` dependencies in a non-workspace monorepo, TypeScript type-checking fails with TS2742 "type portability" errors.

**Root cause:** When packages have separate `pnpm-lock.yaml` files (not a pnpm workspace), pnpm creates isolated `.pnpm` directories per package. Even if packages depend on the same version of a library (e.g., `effect@3.19.14`), TypeScript sees different paths during declaration emit, causing TS2742 errors.

**Symptoms:**

1. **TS2742 - Type portability errors**
   ```
   error TS2742: The inferred type of 'X' cannot be named without a reference to 
   '.pnpm/effect@3.19.14/node_modules/effect/Option'. This is likely not portable.
   ```
   Types from dependencies like `effect` cannot be resolved across the pnpm symlink boundaries because each package has its own `.pnpm` directory with different paths.

**Example error paths showing the problem:**
```
# Same effect version, but different hashed paths!
packages/@example/utils/node_modules/.pnpm/effect@3.19.14_xyz123.../node_modules/effect
packages/@example/common/node_modules/.pnpm/effect@3.19.14_abc456.../node_modules/effect
```

---

## Our Solution: Two-Part Approach

We use a combination of two techniques:

### 1. Primary: Use `link:` protocol for internal packages

All internal package dependencies use `link:` instead of `file:`:

```json
// file: copies package, deps resolved from CONSUMER's context (BAD)
"@example/utils": "file:../utils"

// link: symlinks package, uses its OWN node_modules (GOOD)
"@example/utils": "link:../utils"
```

**Key insight:** `pnpm link:` behaves like `bun file:` - both give packages their OWN dependency resolution, matching how published packages behave.

**Where we use `link:`:**
- effect-utils: All `@overeng/*` internal packages (via `genie/internal.ts`)
- livestore: All `@livestore/*` and `@local/*` packages (via `genie/repo.ts`)
- schickling.dev: All `@overeng/*` cross-repo deps (via `genie/internal.ts`)

### 2. Backup: `enableGlobalVirtualStore` for remaining `file:` deps

Some locations still use `file:` (docs, tests, examples that need to behave like external consumers). For these, we use pnpm's experimental `enableGlobalVirtualStore`:

```bash
npm_config_enable_global_virtual_store=true pnpm install
```

**Why this works:** Instead of each package having its own `.pnpm` directory:
```
# Before (different paths = TS2742 errors)
packages/a/node_modules/.pnpm/effect@3.19.14_hash1/...
packages/b/node_modules/.pnpm/effect@3.19.14_hash2/...

# After (same global path = TypeScript happy)
~/Library/pnpm/store/v10/links/effect@3.19.14/...
```

**Implementation in devenv:**
```nix
# In pnpm.nix task
npm_config_enable_global_virtual_store=true pnpm install
```

**Requirements:**
- pnpm 10.12.1+ (we use 10.28.0)
- Must set via env var because pnpm auto-disables in CI-like environments

---

## Future: Switch back to bun

We're using pnpm temporarily due to bun bugs (see `bun-issues.md`). Once these are fixed, we plan to switch back to bun:

- bun's `file:` protocol already works like pnpm's `link:` (symlinks with own deps)
- bun is significantly faster for installs
- No need for `enableGlobalVirtualStore` workaround with bun

**Tracked bun issues:**
- [#13223 - file: deps extremely slow](https://github.com/oven-sh/bun/issues/13223)
- [#22846 - install hangs in monorepo](https://github.com/oven-sh/bun/issues/22846)

---

## Other TS errors (less common)

These are generally fixed by the above solutions, but documented for reference:

2. **TS7016 - Missing declaration files**
   ```
   error TS7016: Could not find a declaration file for module '@example/wa-sqlite/dist/file.mjs'.
   ```

3. **TS2688 - Missing type definitions**
   ```
   error TS2688: Cannot find type definition file for 'bun'.
   ```

4. **TS2300 - Duplicate identifiers**
   ```
   error TS2300: Duplicate identifier 'TODO'.
   ```

---

## Parallel pnpm installs cause store corruption

> **Status: UNSOLVED** - Need to switch to single root install or serialize tasks

When running multiple `pnpm install` commands in parallel (as the devenv pnpm module does), race conditions corrupt the global pnpm store.

**Root cause:** The pnpm module creates separate tasks (`pnpm:install:<name>`) for each package, all running concurrently after `genie:run`. When multiple pnpm processes try to create hardlinks/symlinks in the same global store (`~/Library/pnpm/store/v10/links/`), they race to rename temp directories.

**Symptoms:**
```
ERR_PNPM_ENOTEMPTY  ENOTEMPTY: directory not empty, rename 
'~/Library/pnpm/store/v10/links/@opentelemetry/api/1.9.0/.../node_modules/@opentelemetry/api_tmp_62863' 
-> '~/Library/pnpm/store/v10/links/@opentelemetry/api/1.9.0/.../node_modules/@opentelemetry/api'
```

The temp directory PIDs (62863, 62892, etc.) show different processes racing on the same paths.

**Why it happens:**
1. Process A creates `@opentelemetry/api_tmp_62863`
2. Process B creates `@opentelemetry/api_tmp_62892`
3. Process A tries to rename its temp dir to `@opentelemetry/api`
4. Process B already renamed its temp dir there
5. Process A fails with `ENOTEMPTY`

**Using `enableGlobalVirtualStore` makes this worse** because even more paths are shared in the global store.

**Potential fixes:**
1. **Single root install** (recommended) - Run `pnpm install` once at workspace root with `pnpm-workspace.yaml`. This is pnpm's intended monorepo workflow.
2. **Serialize installs** - Chain tasks so only one runs at a time (slow but safe)
3. **Use `--frozen-lockfile`** - Reduces store writes but doesn't fully prevent races

**Recovery from corrupted store:**
```bash
# Clean the corrupted links directory
rm -rf ~/Library/pnpm/store/v10/links

# Then reinstall
pnpm install
```

---

## Related

- **Detailed comparison gist:** https://gist.github.com/schickling/d05fe50fe4ffb1c2e9e48c8623579d7e
- pnpm docs on `file:` protocol: https://pnpm.io/package_json#dependencies
- pnpm docs on workspaces: https://pnpm.io/workspaces
- pnpm `enableGlobalVirtualStore` docs: https://pnpm.io/npmrc#enableglobalvirtualstore
