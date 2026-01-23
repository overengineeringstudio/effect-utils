# Bun Issues

> **Status: TEMPORARILY USING PNPM**
>
> We're currently using pnpm due to the blocking issues below. Once these are fixed, we plan to switch back to bun.
>
> **Why we want bun:**
> - Significantly faster installs (when not hitting bugs)
> - bun's `file:` protocol already works like pnpm's `link:` (symlinks with own deps)
> - No need for `enableGlobalVirtualStore` workaround
>
> See `pnpm-issues.md` for our current pnpm setup, or the detailed comparison gist:
> https://gist.github.com/schickling/d05fe50fe4ffb1c2e9e48c8623579d7e

---

## Blocking Issues (must be fixed before switching back)

#### BUN-01: Bun install hang bug

- [bun install frequently hangs in monorepo (isolated linker) — no progress, no error, even with --verbose](https://github.com/oven-sh/bun/issues/22846)

Current workaround: `bun install --no-cache` seems to work but is much slower.

### BUN-02: Bun `file:` dependency slowness

Using `file:../path` dependencies is extremely slow (6-35+ seconds per package) because bun creates individual symlinks for **every file** in the target package, rather than a single symlink to the package root.

**Relevant issues:**

- [#13223 - bun install on projects with file: dependencies is very slow](https://github.com/oven-sh/bun/issues/13223)
- [#23453 - file protocol in package.json dependency](https://github.com/oven-sh/bun/issues/23453) (tracked internally as ENG-20854)
- [#25202 - bun i never exits, spikes cpu and memory on local file dependency](https://github.com/oven-sh/bun/issues/25202)

**Benchmarks (example monorepo with local file: deps):**
| Package | Registry Deps | Local `file:` Deps | Fresh Install Time |
|---------|---------------|--------------------|--------------------|
| `@example/shared` | 2 | 0 | 7ms |
| `@example/utils` | 143 | 0 | 441ms |
| `@example/common` | 216 | 3 | 6.5s |
| `@example/cli` | 267 | 6 | 35s |

**Solution:** Use `workspace:*` protocol instead of `file:` - workspaces create a single symlink to the package root.

```json
// Slow (symlinks every file)
"@example/utils": "file:../utils"

// Fast (single symlink to package root)
"@example/utils": "workspace:*"
```

Requires setting up a root `package.json` with workspaces config.

---

## Other Issues (non-blocking)

### BUN-03: Bun patchedDependencies bug

- [Patching falls over when using local path dependencies](https://github.com/oven-sh/bun/issues/13531)

---

## Key insight: bun `file:` ≈ pnpm `link:`

When comparing package managers for monorepo local dependencies:

| Protocol | Behavior |
|----------|----------|
| **bun `file:`** | Creates dir structure where nested `node_modules` symlinks back to source package's deps |
| **pnpm `link:`** | Direct symlink to source directory (package uses its own `node_modules`) |
| **pnpm `file:`** | Copies package, deps resolved from CONSUMER's context (different!) |

Both **bun `file:`** and **pnpm `link:`** give packages their OWN dependency resolution - matching published behavior. This is why bun doesn't have TS2742 issues with `file:` dependencies.

---

## Cleanup checklist when issues are fixed

Use these as concrete cleanup tasks once the corresponding Bun issues are resolved.

- **BUN-01**: Revert mk-bun-cli to bun-only installs (remove `depsManager`, `pnpmDepsHash`, pnpm install path).
- **BUN-02**: Drop pnpm fallback for local deps; switch back to bun `file:` or `workspace:*` with a single linker strategy.
- **BUN-03**: Re-enable bun patchedDependencies flow if it was disabled; remove any related pnpm-specific guidance.
- **All BUN issues resolved**:
  - Remove pnpm-specific code paths in `mk-bun-cli` and `mk-bun-cli/bun-deps.nix`.
  - Remove pnpm notes from docs (`pnpm-issues.md`, bun issues header).
  - Re-run `mr generate schema` if schema changes were made.
