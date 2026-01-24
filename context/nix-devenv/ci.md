# Nix Build Sandbox Constraints

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

### Affected Packages

Any package with a `prepare` or `postinstall` script that runs a Node.js binary:

- `effect-language-service` (runs `effect-language-service patch` in prepare)
- Packages that apply patches via postinstall scripts

## Solutions

### Option 1: Disable Lifecycle Scripts (Recommended for deps stage)

Use `--ignore-scripts` during dependency installation in Nix builds:

```nix
# In pnpm deps derivation
pnpm install --frozen-lockfile --ignore-scripts
```

**Pros:** Simple, avoids all shebang issues
**Cons:** Skips legitimate postinstall scripts (native builds, patches)

### Option 2: Patch Shebangs in Derivation

Nix provides `patchShebangs` to rewrite shebangs to use Nix store paths:

```nix
{ pkgs, ... }:

pkgs.stdenv.mkDerivation {
  # ...
  nativeBuildInputs = [ pkgs.nodejs ];
  
  postInstall = ''
    patchShebangs node_modules/.bin
  '';
}
```

This rewrites `#!/usr/bin/env node` to `#!/nix/store/...-nodejs-.../bin/node`.

**Pros:** Scripts still run, native builds work
**Cons:** Must run after install, before scripts execute (chicken-egg problem)

### Option 3: Use `--shamefully-hoist` + `patchShebangs` Pre-Install

For the deps derivation, run `patchShebangs` on binaries before pnpm links them:

```nix
buildPhase = ''
  # Install without running scripts
  pnpm install --frozen-lockfile --ignore-scripts
  
  # Patch all shebangs in node_modules
  patchShebangs node_modules
  
  # Now run the lifecycle scripts manually if needed
  pnpm rebuild
'';
```

### Option 4: Remove Problematic Scripts from Packages

For packages we control (like effect-utils CLIs), remove or conditionalize the prepare script:

```json
{
  "scripts": {
    "prepare": "[ -z \"$NIX_BUILD\" ] && effect-language-service patch || true"
  }
}
```

Or remove `prepare` entirely and run it manually during development.

## Recommendation for effect-utils CLI Builds

For `mkBunCli` / `mkPnpmCli` helpers:

1. **Always use `--ignore-scripts`** during the deps derivation
2. **Document** that prepare/postinstall scripts won't run in Nix builds
3. If scripts are essential (native builds), use Option 3 with explicit `patchShebangs` + `rebuild`

## CI Considerations

### GitHub Actions with Nix

When using `devenv shell` in CI:

1. The devenv flake builds packages from effect-utils
2. These packages use `mkBunCli`/`mkPnpmCli` which create deps derivations
3. The deps derivation runs pnpm/bun install
4. Lifecycle scripts fail if they have `/usr/bin/env` shebangs

**Solution:** Ensure effect-utils CLI builds use `--ignore-scripts` in the deps stage.

### megarepo:generate in CI

The `megarepo:generate` task runs `mr generate nix --deep`. In CI:

- `megarepo.json` exists (committed)
- But `repos/` symlinks point to local megarepo workspace (doesn't exist in CI)
- `mr generate` fails because it expects repos to exist

**Solution:** Either:
1. Skip `megarepo:generate` in CI (check `$CI` env var)
2. Run `mr sync --frozen` first to clone repos from `megarepo.lock`

## References

- [Nix manual: patchShebangs](https://nixos.org/manual/nixpkgs/stable/#fun-patchShebangs)
- [pnpm --ignore-scripts](https://pnpm.io/cli/install#--ignore-scripts)
- [NixOS Discourse: FHS and shebangs](https://discourse.nixos.org/t/how-to-handle-usr-bin-env-in-nix-builds/5695)
