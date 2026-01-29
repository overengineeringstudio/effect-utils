# Nix Build Sandbox Constraints

## Megarepo CI Challenge: Installing `mr` via Nix Flake

### Problem

Repos that depend on effect-utils via megarepo need to run `mr sync --frozen` in CI before devenv is available. This creates a chicken-and-egg problem:

1. `mr` CLI comes from devenv (via `cliPackages.megarepo`)
2. devenv needs effect-utils to be synced first (for imports in `devenv.nix`)
3. We can't run `mr sync` without `mr`

### Attempted Solution: Install `mr` from effect-utils Flake

```yaml
- name: Install megarepo CLI
  run: nix profile install github:overengineeringstudio/effect-utils#megarepo
  shell: bash

- name: Sync megarepo dependencies
  run: mr sync --frozen
  shell: bash
```

### Issue: pnpm Deps Hash Mismatch

The megarepo Nix build uses `pnpmDepsHash` for reproducible builds. However, pnpm resolves slightly different content based on:

- pnpm version differences
- npm registry state at fetch time
- Platform/architecture differences

This causes hash mismatches in CI:

```
error: hash mismatch in fixed-output derivation 'megarepo-pnpm-deps.drv':
         specified: sha256-ABC...
            got:    sha256-XYZ...
```

The hash keeps changing between local builds and CI environments, making the flake-based approach unreliable.

### Options

#### Option 1: Use `bunx` Instead of Nix Flake (Recommended)

Install bun in CI and run megarepo via bunx:

```yaml
- uses: oven-sh/setup-bun@v1

- name: Sync megarepo dependencies
  run: bunx @overeng/megarepo sync --frozen
  shell: bash
```

**Pros:**

- No hash mismatch issues
- Simpler CI setup
- Faster (no Nix build)

**Cons:**

- Requires bun setup step
- Less "pure" than Nix approach

#### Option 2: Pin to Specific Flake Commit

Use a pinned commit instead of `main`:

```yaml
- run: nix profile install github:overengineeringstudio/effect-utils/<commit>#megarepo
```

**Pros:**

- Reproducible once hash is correct for that commit

**Cons:**

- Requires manual updates when effect-utils changes
- Still susceptible to hash drift if pnpm-lock changes

#### Option 3: Pre-built Binary Release

Publish pre-built `mr` binaries as GitHub releases:

```yaml
- run: curl -L https://github.com/.../releases/download/v1.0/mr-linux-x64 -o /usr/local/bin/mr
```

**Pros:**

- No build step in CI
- Fully reproducible

**Cons:**

- Requires release automation
- Binary management overhead

#### Option 4: Skip `mr sync` - Clone Manually

Clone effect-utils directly without megarepo:

```yaml
- run: git clone --depth 1 https://github.com/overengineeringstudio/effect-utils repos/effect-utils
```

**Pros:**

- No megarepo dependency in CI
- Simple

**Cons:**

- Doesn't use megarepo.lock (no commit pinning)
- Duplicates megarepo logic

### Current Status (Updated 2026-01-26)

**Progress**: The Nix flake approach now works with `--refresh` flag to bypass cache:

```yaml
- name: Install megarepo CLI
  run: nix profile install --refresh github:overengineeringstudio/effect-utils#megarepo
  shell: bash
```

**Resolved Issues:**

1. ✅ `mr sync --frozen` now allows cloning in fresh CI environments (fix in commit 693eb6b)
2. ✅ Added `--refresh` to bypass nix flake cache and get latest megarepo version

**Remaining Issues:**

1. GitHub shorthand sources (`owner/repo`) use SSH URLs which fail without SSH keys - use HTTPS URLs instead
2. Path resolution issue with devenv inputs (see below)

---

## Megarepo + Devenv Path Resolution Issue

### Problem

When `devenv.yaml` references paths inside megarepo members:

```yaml
playwright:
  url: path:repos/effect-utils/nix/playwright-flake
```

The `repos/effect-utils` is a symlink to the megarepo store (`~/.megarepo/github.com/.../refs/commits/...`). When devenv/nix tries to resolve this path, it fails with:

```
error: '«unknown»/.megarepo/github.com/overengineeringstudio/effect-utils/refs/commits/.../nix/playwright-flake/.devenv.flake.nix' does not exist
```

The `«unknown»` indicates nix couldn't resolve the home directory or symlink target properly.

### Root Cause Analysis

1. Megarepo creates symlinks from `repos/<member>` to store paths like `~/.megarepo/.../refs/commits/<sha>/`
2. devenv.yaml uses relative paths like `path:repos/effect-utils/...`
3. When devenv resolves these paths, it follows symlinks but loses the ability to resolve `~` or `$HOME`
4. The path becomes invalid from nix's perspective

### Additional Issue: Wrong devenv Version in CI

The CI currently installs devenv via:

```yaml
run: nix profile install nixpkgs#devenv
```

This installs devenv from nixpkgs, which may NOT be devenv 2.0. The project uses devenv.lock version 7 (devenv 2.0).

### Options

See "Current Blocker Options" section below.

---

## Resolution (2026-01-26)

### Root Cause

Nix flakes explicitly **do not follow symlinks** in path inputs for security and reproducibility reasons. This is a fundamental Nix limitation, not a megarepo bug.

### Solution: Use GitHub URLs

Changed all `devenv.yaml` files to use GitHub URLs instead of local paths through symlinks:

```yaml
# Before (broken):
playwright:
  url: path:repos/effect-utils/nix/playwright-flake

# After (works):
playwright:
  url: github:overengineeringstudio/effect-utils?dir=nix/playwright-flake
```

**Fixed repos:**

- `schickling-stiftung`
- `livestore`
- `schickling.dev`

### Documentation

See [Megarepo Nix Integration Guide](../../packages/@overeng/megarepo/docs/integrations/nix.md) for:

- Full explanation of the symlink limitation
- Patterns to avoid
- When local paths are OK

---

## The `/usr/bin/env` Problem

### Context

Nix builds run in a **sandboxed environment** that isolates the build from the host system. This sandbox does not include standard FHS paths like `/usr/bin/`. When npm/pnpm packages have lifecycle scripts (postinstall, prepare) that invoke binaries with `#!/usr/bin/env node` shebangs, they fail:

```
sh: /build/workspace/.../node_modules/.bin/effect-language-service: /usr/bin/env: bad interpreter: No such file or directory
```

### Why This Happens

1. Many npm packages ship binaries with `#!/usr/bin/env node` shebangs
2. pnpm/npm runs lifecycle scripts (`prepare`, `postinstall`) during `install`
3. In the Nix sandbox, `/usr/bin/env` doesn't exist
4. The script fails, causing the entire dependency installation to fail

## References

- [Nix manual: patchShebangs](https://nixos.org/manual/nixpkgs/stable/#fun-patchShebangs)
- [pnpm --ignore-scripts](https://pnpm.io/cli/install#--ignore-scripts)
- [NixOS Discourse: FHS and shebangs](https://discourse.nixos.org/t/how-to-handle-usr-bin-env-in-nix-builds/5695)
