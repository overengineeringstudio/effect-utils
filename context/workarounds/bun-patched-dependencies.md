# Bun patchedDependencies Bug Workaround

> **Note:** This issue is specific to `file:` protocol dependencies. When we migrate to `workspace:*` protocol (see [bun-issues.md](./bun-issues.md#bun-workspace-pattern-future)), this issue may be resolved since workspace dependencies use a different resolution mechanism.

Update (2026-01-18-10:19): There's a fix coming:
https://github.com/oven-sh/bun/issues/13531

## Problem

When using bun with `file:` protocol dependencies across multiple repos (via a shared workspace), bun's `patchedDependencies` feature doesn't work correctly.

### Bug Description

Bun reads `patchedDependencies` from source packages (packages referenced via `file:`) and uses those paths, but resolves them relative to the **consumer's** location instead of the **source package's** location.

**Example:**

- Source package `@overeng/utils` at `effect-utils/packages/@overeng/utils` has:
  ```json
  "patchedDependencies": {
    "effect-distributed-lock@0.0.11": "../../../patches/effect-distributed-lock@0.0.11.patch"
  }
  ```
- Consumer package `misc.schickling.dev` at `schickling.dev/apps/misc.schickling.dev` depends on `@overeng/utils` via `file:`
- Bun tries to resolve `../../../patches/...` from the consumer's location, which points to the wrong place

The consumer's own `patchedDependencies` (which has the correct path) is **ignored** in favor of the source package's config.

### Why This Is Problematic

- Packages can be both consumers and sources (e.g., `@overeng/cli` depends on `@overeng/utils`)
- Different packages are at different directory depths
- No single relative path works for all consumers
- Symlinks work but aren't reproducible/portable

## Related Issues

- [Patching falls over when using local path dependencies](https://github.com/oven-sh/bun/issues/13531)

## Current Workaround

Instead of using bun's native `patchedDependencies` feature, we apply patches ourselves via `postinstall` scripts.

### Implementation

1. **Patches are centralized** at `effect-utils/patches/` (repo-relative paths)

2. **Genie's `packageJson` accepts a `patches` registry:**

   ```ts
   import { packageJson, type PatchesRegistry } from '@overeng/genie'
   import { patches } from '../../genie/repo.ts'

   export default packageJson({
     dependencies: { 'effect-distributed-lock': '0.0.11' },
     patches, // Registry of all available patches
   })
   ```

3. **Genie generates a `postinstall` script** that applies matching patches:

   ```json
   "scripts": {
     "postinstall": "patch --forward -p1 -d node_modules/effect-distributed-lock < ../../patches/effect-distributed-lock@0.0.11.patch || true"
   }
   ```

4. **`patch --forward`** makes it idempotent (skips already-applied patches)

5. **`|| true`** prevents install failures if patch was already applied

### Advantages of This Approach

- Works across any directory depth
- Explicit and composable via genie
- No manual setup or symlinks required
- Patches only applied when dependency versions match
- Existing postinstall scripts are preserved (chained)

### Known Issues with This Approach

> **Note:** These issues are specific to `file:` protocol. With `workspace:*` protocol, cache corruption should not occur.

The `postinstall` approach can cause Bun cache corruption with `file:` protocol dependencies during parallel installs.

**Error observed:**

```
✗ Install packages/@overeng/notion-cli (12.2s)
  │ ENOENT: failed copying files from cache to destination for package @overeng/notion-effect-client
  │ $ patch --forward -p1 -d node_modules/effect-distributed-lock < ../../../patches/effect-distributed-lock@0.0.11.patch || true

✗ Install scripts (12.6s)
  │ ENOENT: failed copying files from cache to destination for package @overeng/genie
  │ $ patch --forward -p1 -d node_modules/effect-distributed-lock < ../patches/effect-distributed-lock@0.0.11.patch || true
```

**Root cause:** Bun's cache-to-destination copy fails mid-operation for `file:` dependencies, leaving incomplete packages:

```bash
$ ls packages/@overeng/notion-cli/node_modules/@overeng/notion-effect-client/
dist/                    # partial
node_modules/
package.json.genie.ts    # symlink only

# Missing: package.json, src/, bun.lock, tsconfig.json
```

**Workaround:** Clean node_modules before installing:

```bash
rm -rf node_modules && dt bun:install
```

## Removing the Workaround

Once bun supports `workspace:*` properly (BUN-01, BUN-02 fixed) or the patchedDependencies bug is fixed:

1. Migrate to `workspace:*` protocol (see [bun-issues.md](./bun-issues.md#bun-workspace-pattern-future))
2. Test if `patchedDependencies` works correctly with workspace dependencies
3. If yes: remove `patches` parameter from `packageJson` calls, use native `patchedDependencies`
4. If no: keep postinstall workaround until upstream fix lands

### Files to Update

- `packages/@overeng/genie/src/runtime/package-json/mod.ts` - Remove patches logic (if native works)
- `genie/repo.ts` - Remove patches registry export
- All `package.json.genie.ts` files - Remove `patches` prop, add `patchedDependencies`
- This workaround file - Delete or archive
