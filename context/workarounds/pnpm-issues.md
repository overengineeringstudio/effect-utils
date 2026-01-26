# pnpm Issues

---

## PNPM-01: `file:` dependencies cause TypeScript errors

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

## Our Solution: Protocol Selection by Context

Different dependency protocols work best in different contexts:

| Context | Protocol | Why |
|---------|----------|-----|
| **Same-repo siblings** | `link:../pkg` | Simple relative paths, own dependency resolution |
| **Cross-repo deps** | `workspace:*` | Works with per-package workspaces, proper symlink resolution |
| **External examples/docs** | `file:` + `enableGlobalVirtualStore` | Behaves like npm consumers |

### 1. Same-repo dependencies: `link:` protocol

For packages within the same repository referencing siblings:

```json
// In effect-utils packages:
"@overeng/utils": "link:../utils"
```

**Key insight:** `pnpm link:` creates symlinks where each package uses its OWN `node_modules`, matching how published packages behave.

**Where we use `link:`:**
- effect-utils: All `@overeng/*` internal packages (via genie catalog)

### 2. Cross-repo dependencies: `workspace:*` protocol

For consuming packages from another repository (e.g., oi consuming livestore):

```json
// In oi/package.json:
"@livestore/sync-cf": "workspace:*"
```

**Requires per-package `pnpm-workspace.yaml`:**

```yaml
# In oi/pnpm-workspace.yaml:
packages:
  - .
  - ../../repos/livestore/packages/@livestore/*
```

**Why `workspace:*` instead of `file:`:**

The `file:` protocol breaks when the referenced package has internal `link:` dependencies:

1. pnpm copies `file:` deps into `.pnpm/` directory
2. Internal `link:../sibling` paths get reinterpreted relative to `.pnpm/` location
3. Symlinks resolve to wrong directories (e.g., `flakes/common` instead of `livestore/packages/@livestore/common`)

With `workspace:*`:
1. pnpm creates direct symlinks to source packages (not copies in `.pnpm/`)
2. Internal `link:` deps resolve correctly relative to original source location
3. Each package maintains its own dependency resolution

**Where we use `workspace:*`:**
- livestore: All `@livestore/*` and `@local/*` packages (via `genie/repo.ts`)
- oi: References to `@livestore/*` packages (via `genie/internal.ts`)
- Any cross-repo consumption scenario

**Per-package workspace pattern:**

Each package has its own `pnpm-workspace.yaml` including siblings:

```yaml
# In livestore/packages/@livestore/sync-cf/pnpm-workspace.yaml:
packages:
  - .
  - ../*
```

This enables:
1. No monorepo root workspace needed
2. Each package is self-contained
3. External consumers include packages in their own workspace

### 3. Backup: `enableGlobalVirtualStore` for `file:` deps

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

**Note:** The `workspace:*` pattern may need adaptation for bun, which has different workspace semantics.

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

## PNPM-02: Parallel installs cause store corruption with `enableGlobalVirtualStore`

> **Status: KNOWN BUG** - [pnpm#10232](https://github.com/pnpm/pnpm/issues/10232) - No fix yet
>
> Tracked in: [pnpm#9696](https://github.com/pnpm/pnpm/issues/9696) (GVS improvements)

When running multiple `pnpm install` commands in parallel with `enableGlobalVirtualStore`, race conditions corrupt the global pnpm store. This is a **known, open bug** in pnpm.

**Root cause:** The pnpm module creates separate tasks (`pnpm:install:<name>`) for each package, all running concurrently after `genie:run`. When multiple pnpm processes try to create hardlinks/symlinks in the same global store (`~/Library/pnpm/store/v10/links/`), they race to rename temp directories.

**Note:** `enableGlobalVirtualStore` is marked **experimental** in pnpm docs. pnpm auto-disables it in CI environments partly because of these stability issues.

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

**Using `enableGlobalVirtualStore` makes this worse** because even more paths are shared in the global store. The traditional per-project virtual store (`node_modules/.pnpm`) handles concurrent access more safely.

**Potential fixes:**

1. **Disable GVS for parallel installs** - If using `link:` protocol for internal deps, GVS may not be needed
2. **Single root install** (recommended) - Run `pnpm install` once at workspace root with `pnpm-workspace.yaml`. This is pnpm's intended monorepo workflow.
3. **Serialize installs** - Chain tasks so only one runs at a time (slow but safe)
4. **Use `--frozen-lockfile`** - Reduces store writes but doesn't fully prevent races

**Recovery from corrupted store:**

```bash
# Clean the corrupted links directory
rm -rf ~/Library/pnpm/store/v10/links

# Then reinstall
pnpm install
```

---

## PNPM-03: `enableGlobalVirtualStore` breaks TypeScript type inference for callback parameters

> **Status: SOLVED** - Use TypeScript `paths` mapping to redirect `react` resolution
>
> **Workaround:** Add `paths` mapping in tsconfig to point `react` to the project's `@types/react`

When using `enableGlobalVirtualStore`, TypeScript fails to infer types for callback parameters in libraries like `react-aria-components`, resulting in `TS7006: Parameter implicitly has an 'any' type` errors.

**Symptoms:**

```
LiteralField.tsx(74,33): error TS7006: Parameter 'keys' implicitly has an 'any' type.
LiteralField.tsx(101,27): error TS7006: Parameter 'key' implicitly has an 'any' type.
NumberField.tsx(98,18): error TS7006: Parameter 'v' implicitly has an 'any' type.
```

On code like:

```tsx
<ToggleButtonGroup onSelectionChange={(keys) => ...}>  // keys is 'any'
<Select onSelectionChange={(key) => ...}>              // key is 'any'
<AriaNumberField onChange={(v) => ...}>                // v is 'any'
```

**Root cause:** When `enableGlobalVirtualStore` is enabled, pnpm symlinks packages to the global store (`~/Library/pnpm/store/v10/links/...`) instead of the local `.pnpm` directory. This breaks TypeScript's type resolution because:

1. TypeScript resolves `react-aria-components` to its real path in the global store
2. When `react-aria-components` types need to resolve `react` types, TypeScript walks up the directory tree
3. Since the real path is in the global pnpm store, it can't find `@types/react` (which exists in the project's `node_modules/@types`)
4. So `react-aria-components` resolves `react` as a JS file without types
5. This causes callback parameters to lose type inference (become `any`)

**Comparison of type resolution:**

| Config                              | `virtualStoreDir`                | react-aria-components resolves react to   | Type inference |
| ----------------------------------- | -------------------------------- | ----------------------------------------- | -------------- |
| Local (default)                     | `.pnpm`                          | `project/node_modules/@types/react`       | Works          |
| Global (`enableGlobalVirtualStore`) | `~/Library/pnpm/store/v10/links` | `~/Library/.../react/index.js` (no types) | Broken         |

**You can verify this with `--traceResolution`:**

```bash
tsc --build --traceResolution 2>&1 | grep -A30 "Resolving module 'react' from.*react-aria-components"
```

With global virtual store, you'll see TypeScript fail to find `@types/react` and fall back to the JS file:

```
Directory '~/Library/pnpm/store/v10/links/@/react-aria-components/.../node_modules/@types' does not exist
...
Module name 'react' was successfully resolved to '~/Library/.../react/index.js'  # JS, not .d.ts!
```

**Potential fixes:**

1. **Add explicit type annotations** - Works but verbose and defeats the purpose of inference
2. **Disable `enableGlobalVirtualStore`** - But then you get TS2742 errors from the first issue above
3. **Add `typeRoots` in tsconfig** - Doesn't help because the resolution happens from within the library's types
4. **Ensure `@types/react` is symlinked alongside `react-aria-components`** - Not easily configurable in pnpm
5. **Use TypeScript `paths` mapping** - **WORKS!** Redirects `react` resolution to project's `@types/react`

**Solution: Use `paths` mapping in tsconfig**

Add the following to your `tsconfig.json`:

```json
{
  "compilerOptions": {
    "paths": {
      "react": ["./node_modules/@types/react"]
    }
  }
}
```

Note: `baseUrl` is not required for `paths` in TypeScript 5.x+.

This tells TypeScript to resolve `react` imports (including those from `react-aria-components` types) to the project's `@types/react` instead of walking up from the global store.

**Why this works:** The `paths` mapping is applied globally to all type resolution, including resolution happening within dependency type definitions. So when `react-aria-components/dist/types.d.ts` imports `react`, TypeScript uses the path mapping instead of node module resolution, finding `@types/react` in the project.

**Note:** This requires `@types/react` to be installed as a dependency in the package.

### Variant: JSX `key` prop missing from IntrinsicAttributes

The same underlying issue affects packages that use `jsxImportSource` (custom JSX runtimes). When using `@opentui/react` or similar packages with `jsxImportSource`, the `key` prop is missing from `IntrinsicAttributes`:

**Symptoms:**

```
error TS2322: Type '{ key: string; name: string; }' is not assignable to type 'IntrinsicAttributes & ItemProps'.
  Property 'key' does not exist on type 'IntrinsicAttributes & ItemProps'.
```

**Root cause:** The custom JSX package's type definitions extend `React.Attributes` for `IntrinsicAttributes`:

```typescript
// In @opentui/react/jsx-namespace.d.ts
interface IntrinsicAttributes extends React.Attributes {}
```

When TypeScript can't resolve `React.Attributes` from the global store (same issue as above), the `key` prop is lost.

**Solution: Module augmentation**

Create a `.d.ts` file that augments the JSX runtime module:

```typescript
// src/opentui-jsx-fix.d.ts
import type { Key } from 'react'

declare module '@opentui/react/jsx-runtime' {
  namespace JSX {
    interface IntrinsicAttributes {
      key?: Key | null | undefined
    }
  }
}
```

This directly adds the `key` prop to the JSX namespace, bypassing the broken `React.Attributes` resolution.

**Note:** The `paths` workaround for `react` doesn't help here because `jsxImportSource` resolution works differently - TypeScript resolves the JSX runtime from the package location, not using standard module resolution.

---

## PNPM-04: `patchedDependencies` and `link:` protocol isolation

> **Status: DOCUMENTED** - Important consideration when switching back to bun

When using pnpm's `link:` protocol for internal packages, **patches must be configured in the package that directly depends on the patched dependency**, not in consuming packages.

### How it works with pnpm

With `link:`, each package uses its **own** `node_modules`:

```
# misc.schickling.dev depends on @overeng/utils via link:
misc.schickling.dev/
  node_modules/
    @overeng/utils -> ../../repos/effect-utils/packages/@overeng/utils  # symlink
    # NO effect-distributed-lock here!

@overeng/utils/
  node_modules/
    effect-distributed-lock/  # installed here, with patch applied
```

**Key behaviors:**

1. `effect-distributed-lock` is installed in `@overeng/utils/node_modules/`, not in consuming packages
2. Only `@overeng/utils` needs `pnpm.patchedDependencies` configured
3. pnpm **errors** if you add `patchedDependencies` for packages not in your dependency tree:
   ```
   ERR_PNPM_UNUSED_PATCH  The following patches were not used: effect-distributed-lock@0.0.11
   ```

### Potential footgun when switching to bun

**This behavior may differ with bun.** Bun might:

1. Hoist transitive dependencies into consuming packages' `node_modules`
2. Use different `file:`/`link:` semantics
3. Require `patchedDependencies` (top-level, not under `pnpm`) in all consuming packages

**When switching back to bun, verify:**

1. Where `effect-distributed-lock` gets installed (check each package's `node_modules`)
2. Whether the patch from `@overeng/utils` applies transitively
3. If not, add `patchedDependencies` to all packages that use `@overeng/utils`:

```json
{
  "patchedDependencies": {
    "effect-distributed-lock@0.0.11": "path/to/patches/effect-distributed-lock@0.0.11.patch"
  }
}
```

**Testing the patch:**

```bash
# Check if RedisBacking export is removed (patch applied)
grep "export.*RedisBacking" node_modules/effect-distributed-lock/dist/index.js
# Should return nothing if patch is applied
```

### Current configuration (pnpm)

- **Only** `@overeng/utils` has `pnpm.patchedDependencies`
- All other packages removed both `postinstall` scripts AND `patchedDependencies`
- Consuming packages get the patched version through the `link:` symlink

---

## Related

- **Detailed comparison gist:** https://gist.github.com/schickling/d05fe50fe4ffb1c2e9e48c8623579d7e
- pnpm docs on `file:` protocol: https://pnpm.io/package_json#dependencies
- pnpm docs on workspaces: https://pnpm.io/workspaces
- pnpm `enableGlobalVirtualStore` docs: https://pnpm.io/npmrc#enableglobalvirtualstore
- [pnpm#10232](https://github.com/pnpm/pnpm/issues/10232) - ERR_PNPM_ENOTEMPTY for concurrent pnpm install with GVS
- [pnpm#9696](https://github.com/pnpm/pnpm/issues/9696) - Improvements to global virtual store (tracking issue)
