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

### Current Status

**Blocked**: The Nix flake approach has persistent hash mismatch issues. Recommend switching to Option 1 (bunx) for pragmatic CI support.

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
