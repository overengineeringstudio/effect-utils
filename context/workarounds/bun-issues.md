# Bun Issues

> **Status: TEMPORARILY USING PNPM**
>
> We're currently using pnpm because the repo's current pnpm-shaped workspace metadata does not switch over to Bun cleanly yet. Bun itself is closer than this document originally suggested.
>
> **Why we want bun:**
>
> - Significantly faster installs (when not hitting bugs)
> - Native TypeScript execution
> - Better monorepo tooling
>
> See `pnpm-issues.md` for our current pnpm setup.

---

## Latest Check

Checked on **March 6, 2026** with **Bun 1.3.10** from `github:NixOS/nixpkgs/master#bun`.

### What we tested

- `bun install --linker isolated` against isolated copies of real generated packages:
  - `@overeng/utils`
  - `@overeng/megarepo`
  - `@overeng/notion-cli`
- the same packages after teaching genie to generate Bun-native fields in `package.json`:
  - `workspaces`
  - top-level `patchedDependencies`
- follow-up installs after removing only the copied nested `@overeng/utils` Bun patch metadata to isolate the remaining failure mode

### Current conclusion

- **We cannot switch back to Bun by only replacing `pnpm install` with `bun install`.**
- **We likely can switch back after a repo migration that teaches genie to emit Bun-native `workspaces` and root-level patch metadata correctly.**
- In other words: the blocker is no longer generic workspace resolution. The remaining issue is Bun's handling of patched dependencies inside nested workspace packages.

### Observed status by issue

| ID         | Status in effect-utils                       | Notes                                                                                                                                                                                                                                                                                                   |
| ---------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **BUN-01** | **Not reproduced after explicit Bun config** | After the nested patch-metadata conflict was removed from the copied `@overeng/utils` workspace package, both `@overeng/megarepo` and `@overeng/notion-cli` installed successfully with `--linker isolated`, and `@overeng/notion-cli` no longer needed `--no-cache`. The upstream issue is still open. |
| **BUN-02** | **Not a current blocker here**               | This repo already uses `workspace:*` for internal deps. The old `file:` slowness issue is still real upstream, but it is not what currently blocks effect-utils.                                                                                                                                        |
| **BUN-03** | **Partially reproduced in workspace mode**   | Bun applied the patch correctly for `@overeng/utils` as the install root, but app/workspace installs failed when a nested workspace package also declared Bun-style `patchedDependencies`.                                                                                                              |
| **BUN-04** | **Resolved by Phase 1 metadata generation**  | Bun 1.3.10 can consume the migrated `workspaces` metadata. The older `pnpm-workspace.yaml`-only shape is still not enough for Bun, but this is no longer the active blocker once genie emits Bun-native fields.                                                                                         |
| **BUN-05** | **Current blocker**                          | Bun 1.3.10 resolves `patchedDependencies` from nested workspace packages incorrectly during app/workspace installs.                                                                                                                                                                                     |

---

## Blocking Issues (must be fixed before switching back)

### BUN-05: Bun misresolves patchedDependencies from nested workspace packages

What happens with the migrated package shapes:

- `@overeng/utils` installs successfully as the root package and Bun applies the `effect-distributed-lock` patch
- `@overeng/megarepo` and `@overeng/notion-cli` fail even though their root `package.json` contains the correct Bun patch path (`../utils/patches/...`)
- the decisive Bun error is:
  - `error: Couldn't find patch file: 'patches/effect-distributed-lock@0.0.11.patch'`

Why this matters:

- Bun appears to read Bun-style patch metadata from the nested `@overeng/utils` workspace package and resolve its local `patches/...` path from the app root
- that breaks app installs even though the root package has already recomposed the patch correctly

Validation:

- removing only the copied nested `@overeng/utils` Bun patch metadata made both `@overeng/megarepo` and `@overeng/notion-cli` install successfully with `--linker isolated`
- after that targeted change, the previous `@overeng/notion-cli` `--no-cache` workaround was no longer needed

Impact:

- Bun-native `workspaces` are viable for this repo
- patch metadata cannot currently be emitted naively on both the root package and nested workspace packages
- we need a principled Bun patch strategy before switching installs back to Bun

Current workaround:

- keep pnpm as the default installer
- continue Bun testing against generated `workspaces`
- treat nested-workspace Bun patch metadata as the active blocker to solve next

### BUN-04: Bun cannot consume our current per-package pnpm workspace metadata

Relevant issue:

- [#23026 - Workspace link dependencies to non-existent folders aren't supported yet in pnpm-lock.yaml migration](https://github.com/oven-sh/bun/issues/23026)

What happens today when we run `bun install` against the current generated files:

- Bun warns that `pnpm-lock.yaml` migration cannot handle the workspace entries
- it leaves `pnpm.patchedDependencies` untouched
- it does **not** synthesize a `workspaces` field in `package.json`
- it then fails with workspace resolution errors such as:
  - `NonExistentWorkspaceDependency: failed to migrate lockfile: 'pnpm-lock.yaml'`
  - `Workspace dependency "@overeng/utils-dev" not found`

Impact:

- Our current per-package `pnpm-workspace.yaml` pattern is not enough for Bun.
- Switching package managers requires generating Bun-native workspace metadata first.

Current workaround:

- Keep using pnpm for the generated per-package workspace setup.
- When testing Bun, add explicit `workspaces` first, then isolate patch handling separately.

### BUN-01: Bun install hang bug

- [bun install frequently hangs in monorepo (isolated linker) — no progress, no error, even with --verbose](https://github.com/oven-sh/bun/issues/22846)

Current repo status:

- We observed one timeout while Bun was still in the broken pnpm migration path.
- We did **not** reproduce the hang once Bun had explicit `workspaces` and top-level `patchedDependencies`.
- This means the issue is no longer the clearest reason to stay on pnpm for effect-utils, but the upstream issue is still open.

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

Current repo status:

- Reproduced only in the nested-workspace case.
- Bun applied our `effect-distributed-lock@0.0.11` patch correctly when `@overeng/utils` was the install root.
- Bun failed when the same patch metadata was also present on the nested `@overeng/utils` workspace package during app installs.

---

## Bun Workspace Pattern (Future)

When we switch to Bun, we should keep `workspace:*` and generate Bun-native `workspaces` directly into each package's `package.json`.

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

We'll extend genie to generate:

- `workspaces` in `package.json`
- top-level `patchedDependencies` in `package.json`

The same dependency analysis used for `pnpm-workspace.yaml` should remain the source of truth.

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

- **BUN-04**: Keep generating Bun-native `workspaces` in `package.json`; this part is now validated.
- **BUN-01**: Re-check whether the isolated-linker hang is still reproducible after the metadata migration lands.
- **BUN-02**: Keep avoiding `file:` for internal packages; `workspace:*` remains the standard.
- **BUN-03 / BUN-05**: Define a Bun patch strategy that does not rely on nested workspace packages carrying root-relative patch metadata during app installs.
- **All BUN issues resolved**:
  - Remove pnpm-specific code paths in `mk-bun-cli` and `mk-bun-cli/bun-deps.nix`.
  - Update genie to generate the final Bun patch metadata shape in `package.json`.
  - Remove `pnpm-workspace.yaml.genie.ts` files (or keep for pnpm compatibility).
  - Update docs to reflect bun as primary package manager.
