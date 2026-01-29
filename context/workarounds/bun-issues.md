# Bun Issues

> **Status: TEMPORARILY USING PNPM**
>
> We're currently using pnpm due to the blocking issues below. Once these are fixed, we plan to switch back to bun.
>
> **Why we want bun:**
>
> - Significantly faster installs (when not hitting bugs)
> - Native TypeScript execution
> - Better monorepo tooling
>
> See `pnpm-issues.md` for our current pnpm setup.

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

This aligns with our pnpm pattern - see "Bun Workspace Pattern" section below.

---

## Other Issues (non-blocking)

### BUN-03: Bun patchedDependencies bug

- [Patching falls over when using local path dependencies](https://github.com/oven-sh/bun/issues/13531)

---

## Bun Workspace Pattern (Future)

When we switch to bun, we'll use the same `workspace:*` protocol as pnpm, with per-package workspace declarations.

### Per-Package Workspaces

Each package declares its workspace scope in its own `package.json`:

```json
{
  "name": "@livestore/devtools",
  "workspaces": [".", "../common", "../utils", "../../repos/effect-utils/packages/@overeng/*"],
  "dependencies": {
    "@livestore/common": "workspace:*",
    "@overeng/utils": "workspace:*"
  }
}
```

This mirrors our pnpm pattern where each package has its own `pnpm-workspace.yaml`.

### Why Per-Package Workspaces

1. **No monorepo root required** - Works with megarepo pattern
2. **Self-contained packages** - Each package declares its own workspace scope
3. **Cross-repo consumption** - External repos can include packages in their workspace
4. **Same dependency declarations** - `workspace:*` works identically in both pnpm and bun

### Genie Integration

We'll extend genie to generate the `workspaces` field in `package.json` based on the same dependency analysis used for `pnpm-workspace.yaml`.

---

## Historical Context: Protocol Comparison

> This section explains the protocol differences for reference. Our standard is now `workspace:*` for both pnpm and bun.

| Protocol          | Behavior                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------- |
| **bun `file:`**   | Creates dir structure where nested `node_modules` symlinks back to source package's deps |
| **pnpm `link:`**  | Direct symlink to source directory (package uses its own `node_modules`)                 |
| **pnpm `file:`**  | Copies package, deps resolved from CONSUMER's context (causes TS2742 errors)             |
| **`workspace:*`** | Both managers: symlink to package root, correct dependency resolution                    |

Both **bun `file:`** and **pnpm `link:`** give packages their OWN dependency resolution - matching published behavior. However, `workspace:*` is preferred as it's consistent across package managers.

---

## Cleanup Checklist (When Issues Are Fixed)

Use these as concrete cleanup tasks once the corresponding Bun issues are resolved.

- **BUN-01**: Revert mk-bun-cli to bun-only installs (remove `depsManager`, `pnpmDepsHash`, pnpm install path).
- **BUN-02**: Switch to `workspace:*` with per-package workspaces in `package.json`.
- **BUN-03**: Re-enable bun patchedDependencies flow; remove postinstall patch workaround.
- **All BUN issues resolved**:
  - Remove pnpm-specific code paths in `mk-bun-cli` and `mk-bun-cli/bun-deps.nix`.
  - Update genie to generate `workspaces` field in `package.json` instead of `pnpm-workspace.yaml`.
  - Remove `pnpm-workspace.yaml.genie.ts` files (or keep for pnpm compatibility).
  - Update docs to reflect bun as primary package manager.
