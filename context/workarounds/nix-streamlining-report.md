# Nix Streamlining Report

Date: 2026-01-16
Scope: effect-utils Nix/direnv/devenv workflow streamlining

## Goals Recap

- Keep Nix builds pure (no --impure) and deterministic.
- Support dirty local changes in dotdot workspaces.
- Avoid copying heavy artifacts (node_modules).
- Keep peer repo usage minimal and composable.
- Improve error messages and reduce setup complexity.

## Constraints

- No impure builds, even for dirty local iteration.
- Must work in effect-utils and peer repos (devenv + flake).
- Do not copy node_modules into build output.
- Default to dotdot workspace layout (siblings).

## What Changed (Summary)

- Introduced reusable direnv helpers so peer repos can keep .envrc to a one-liner.
- Added a minimal staging workflow for dirty builds under `.direnv/cli-workspace`.
- Added flake outputs for direnv helper scripts.
- Aligned devenv bunDeps hashes with flake build hashes.
- Documented behavior, customization, and reuse patterns.

## Key Implementation Details

- New helper outputs in `flake.nix`:
  - `direnv.autoRebuildClis`
  - `direnv.peerEnvrc`
  - `direnv.peerEnvrcEffectUtils`
  - `direnv.effectUtilsEnvrc`
- New helper scripts:
  - `nix/direnv/auto-rebuild-clis.nix`
  - `nix/direnv/peer-envrc.nix`
  - `nix/direnv/peer-envrc-effect-utils.nix`
  - `nix/direnv/effect-utils-envrc.nix`
- Peer repo usage is now:
  - `source "$(nix eval --raw --no-write-lock-file "$WORKSPACE_ROOT/../effect-utils#direnv.peerEnvrcEffectUtils")"`
- Dirty builds stage a minimal workspace under `.direnv/cli-workspace` using rsync
  with `.gitignore` filtering and explicit includes.
- Staging now strips `-dirty` from `NIX_CLI_DIRTY_PACKAGES` so include paths resolve
  to real package directories.

## mk-bun-cli Patterns and Rationale

These patterns live in `nix/mk-bun-cli.nix` and are needed to keep builds pure,
fast, and reliable while supporting local changes.

- **Clean, minimal source staging**: `cleanSourceWith` filters out heavy or
  ephemeral paths (node_modules, result, caches). This keeps the source input
  stable and reduces rebuild churn.

```nix
workspaceSrc = lib.cleanSourceWith {
  src = workspaceRootPath;
  filter = sourceFilter workspaceRootPath;
};
```

- **Workspace copy for writable builds**: the derivation stages a writable copy
  of the workspace (tar pipe) so Bun and tsc can write caches without polluting
  source inputs. This also keeps sandbox writes confined.

```sh
workspace="$PWD/workspace"
mkdir -p "$workspace"
(cd "${workspaceSrc}" && tar -cf - .) | (cd "$workspace" && tar -xf -)
chmod -R u+w "$workspace"
```

- **Fixed-output bunDeps snapshot**: bun installs run inside a fixed-output
  derivation keyed by `bunDepsHash` to make dependency resolution deterministic
  and cacheable across builds.

```nix
outputHashMode = "recursive";
outputHashAlgo = "sha256";
outputHash = bunDepsHash;
```

- **Local file dependency handling**: local dependencies (file: / relative) are
  detected from package.json and installed within bunDeps; their node_modules
  are copied into the bunDeps output and then linked into the build workspace.
  This preserves purity while still allowing local package links.

```nix
isLocal = value: lib.hasPrefix "./" value || lib.hasPrefix "../" value || lib.hasPrefix "file:" value;
```

```sh
ln -s "$dep_source" "$package_path/node_modules/$dep_name"
```

- **Bun install failure hints**: bun install is wrapped to emit a clear error
  when bun.lock drifts from the frozen bunDepsHash, with a direct command to
  refresh the hash.

```sh
if grep -q "lockfile had changes" "$bun_log"; then
  echo "mk-bun-cli: bun.lock changed while bunDepsHash is frozen" >&2
fi
echo "mk-bun-cli: bunDepsHash may be stale; update it (mono nix hash --package ${name})" >&2
```

- **Stale bunDepsHash detection**: the bunDeps derivation stores a sha256 hash
  of `bun.lock` at build time. The main derivation compares this against the
  current `bun.lock` before running tsc/bun build. If they differ, the build
  fails fast with an actionable error instead of cryptic downstream failures
  (like TS41 messages or missing packages).

```sh
# In bunDeps: store hash before bun install
sha256sum "$package_path/bun.lock" | cut -d' ' -f1 > "$out/.source-bun-lock-hash"

# In main build: compare before expensive operations
if [ "$current_lock_hash" != "$stored_lock_hash" ]; then
  echo "ERROR: bunDepsHash is stale! Run: mono nix hash --package ${name}"
  exit 1
fi
```

- **No node_modules copying**: the build links bunDeps into the workspace
  instead of copying node_modules, keeping outputs small and avoiding duplicate
  trees.

```sh
if ${lib.boolToString dirty}; then
  ln -s "${bunDeps}/node_modules/.bin" "$package_path/node_modules/.bin"
else
  ln -s "${bunDeps}/node_modules" "$package_path/node_modules"
fi
```

- **Version injection + smoke test**: the entry file is patched with the build
  version, and a smoke test runs the CLI to validate output inside the build.

```sh
substituteInPlace "$workspace/${entry}" \
  --replace-fail "const buildVersion = '__CLI_VERSION__'" "const buildVersion = '${fullVersion}'"
```

```sh
(cd "$smoke_test_cwd" && "$build_output" ${smokeTestArgsChecked})
```

- **Skip typecheck in dirty mode**: dirty builds skip tsc to avoid TS6305 when
  references are missing, while still enforcing typecheck in clean builds.

```nix
typecheckEnabled = typecheck && !dirty;
```

## Tradeoffs and Rationale

- **Staged workspace vs direct path**: staging keeps builds pure and avoids
  `path:` restrictions outside the flake root, at the cost of a lightweight
  rsync step.
- **One-liner peer usage**: favors ergonomics for common sibling layout; advanced
  overrides still available via env vars.
- **Skip typecheck in dirty builds**: avoids TS6305 when references are missing,
  but reduces typecheck coverage for dirty builds.
- **No `node_modules` copying**: bunDeps are linked/symlinked into the staged
  workspace to keep outputs lean.

## Documentation Updates

- `context/monorepo-compose/devenv-setup.md`
  - One-liner peer repo template.
  - Behavior matrix (effect-utils vs peer, auto-rebuild vs dirty mode).
  - Advanced overrides section.
  - Reuse for peer repo CLIs (with flake/output example).
- `context/bun-cli-build/README.md`
- `context/bun-cli-build/requirements.md`

## Validation and Findings

- `direnv reload` succeeds across:
  - `effect-utils` (clean + `NIX_CLI_DIRTY=1`)
  - `schickling.dev` (clean + dirty)
  - `livestore` (clean + dirty)
- Staged workspace now includes `packages/@overeng/dotdot/src/lib/result-utils.ts`
  even when `NIX_CLI_DIRTY_PACKAGES` uses `*-dirty` names.
- `direnv exec . true` still fails in effect-utils due to TS41 diagnostics from
  the Effect language service plugin in dotdot:
  - `packages/@overeng/dotdot/src/lib/loader.ts`
  - `packages/@overeng/dotdot/src/lib/workspace-service.ts`
  - `packages/@overeng/dotdot/src/test-utils/setup.ts`
  This is a known separate issue (Effect LSP/TS41) and not a staging failure.

## Notable Fixes

- Updated `devenv.nix` bunDeps hashes to match flake builds:
  - genie: `sha256-o3JZv9lq3IXroGSmvQK7yBePEHVWxU/ZwC3lrEcr3lo=`
  - dotdot: `sha256-lAvLdjaEG2NRLyP7Y12w7Arlua5rkMnrVJEeQXgM3Ms=`
  This removed `@overeng/cli-ui` missing module errors in devenv builds.


## Files Touched (High-Level)

- `flake.nix`
- `devenv.nix`
- `nix/mk-bun-cli.nix`
- `nix/direnv/*.nix`
- `context/monorepo-compose/devenv-setup.md`
- `context/bun-cli-build/*`
