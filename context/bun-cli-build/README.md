# Bun CLI Build Pattern

Reusable Nix builder for Bun-compiled TypeScript CLIs. Designed for dotdot
workspaces: mk-bun-cli expects a dotdot workspace root and builds a package
inside it.

## Builder

- Path: `nix/mk-bun-cli.nix`
- Inputs: `pkgs`, `pkgsUnstable`
- Versioning: reads `packageJsonPath` for base version, appends `+<gitRev>`
- Typecheck: runs `tsc --project <tsconfig> --noEmit` when `typecheck = true`
- Default `typecheckTsconfig`: `<packageDir>/tsconfig.json`
- Deps: fixed-output bun deps for the package dir (single install)
- Smoke test: runs the built binary with `smokeTestArgs` (default `--help`)

### mkBunCli arguments

| Argument | Required | Default | Notes |
| --- | --- | --- | --- |
| `name` | yes | - | Derivation name and default binary name. |
| `entry` | yes | - | CLI entry file relative to `workspaceRoot`. |
| `packageDir` | yes | - | Package directory relative to `workspaceRoot`. |
| `workspaceRoot` | yes | - | Dotdot workspace root (flake input or path). |
| `bunDepsHash` | yes | - | Fixed-output hash for bun deps snapshot. |
| `binaryName` | no | `name` | Output binary name. |
| `packageJsonPath` | no | `<packageDir>/package.json` | Used for version extraction. |
| `gitRev` | no | `"unknown"` | Version suffix appended as `+<gitRev>`. |
| `typecheck` | no | `true` | Run `tsc --noEmit` with `typecheckTsconfig`. |
| `typecheckTsconfig` | no | `<packageDir>/tsconfig.json` | Tsconfig path relative to `workspaceRoot`. |
| `smokeTestArgs` | no | `["--help"]` | Arguments for post-build smoke test. |
| `dirty` | no | `false` | Copy bun deps locally and overlay local deps. |

## CLI Version Pattern

```ts
import { resolveCliVersion } from '@overeng/utils/node/cli-version'

const baseVersion = '0.1.0'
const buildVersion = '__CLI_VERSION__'
const version = resolveCliVersion({
  baseVersion,
  buildVersion,
  runtimeStampEnvVar: 'NIX_CLI_BUILD_STAMP',
})
```

`mk-bun-cli` performs a literal search/replace for
`const buildVersion = '__CLI_VERSION__'` in the entry file and replaces it
with the resolved version string. The resolved version is:

- `<package.json version>` when `gitRev = "unknown"`
- `<package.json version>+<gitRev>` otherwise

The substitution is enforced with `--replace-fail`, so builds will fail if the
exact placeholder line is missing.

If the placeholder remains (for example in local/dev runs or when `gitRev` is
`"unknown"`), the CLI code can attach a runtime stamp via
`resolveCliVersion`. In effect-utils, the devenv shell hook (via
`cliBuildStamp.shellHook`) sets `NIX_CLI_BUILD_STAMP` to
`<git-short-sha>+<YYYY-MM-DDTHH:MM:SS+/-HH:MM>[-dirty]`. CLIs call
`resolveCliVersion({ baseVersion, buildVersion, runtimeStampEnvVar })`, so the
final version becomes:

- `<package.json version>+<NIX_CLI_BUILD_STAMP>` when the placeholder is still present
- `<buildVersion> (stamp <NIX_CLI_BUILD_STAMP>)` when a build version was injected and the stamp is set
- the injected build version otherwise

This creates a single end-to-end pattern: build-time injection when available,
runtime stamp when not, and a stable base version as fallback.

To avoid re-implementing the stamp logic in each repo, use the helper from
effect-utils:

- `effect-utils.lib.cliBuildStamp { pkgs; }` returns `{ package, shellHook }`
- add `package` to your shell `buildInputs` and append `${shellHook}` to your
  shell entry hook (`enterShell` in devenv or `shellHook` in `mkShell`)
- the helper sets `NIX_CLI_BUILD_STAMP` using `WORKSPACE_ROOT` or
  `CLI_BUILD_STAMP_ROOT`

When using direnv + devenv, `.envrc` runs `use devenv`, which executes
`enterShell` from `devenv.nix`. That is where `cliBuildStamp.shellHook` runs and
exports `NIX_CLI_BUILD_STAMP`, so every `direnv reload` refreshes the runtime
stamp in the current shell.

## Inside effect-utils

```nix
let
  mkBunCli = import ../../../../nix/mk-bun-cli.nix {
    inherit pkgs pkgsUnstable;
  };
in
mkBunCli {
  name = "genie";
  entry = "packages/@overeng/genie/src/build/mod.ts";
  packageDir = "packages/@overeng/genie";
  workspaceRoot = self;
  bunDepsHash = "sha256-...";
  typecheckTsconfig = "packages/@overeng/genie/tsconfig.json";
  gitRev = self.sourceInfo.dirtyShortRev or self.sourceInfo.shortRev or self.sourceInfo.rev or "unknown";
}
```

## Outside effect-utils (flake input)

Prefer passing `gitRev` from the parent repo so the built binary reflects the
parent’s commit:

```nix
let
  mkBunCli = import "${effect-utils}/nix/mk-bun-cli.nix" {
    inherit pkgs pkgsUnstable;
  };
  gitRev = self.sourceInfo.dirtyShortRev or self.sourceInfo.shortRev or self.sourceInfo.rev or "unknown";
in
{
  packages.${system}.my-cli = mkBunCli {
    name = "my-cli";
    entry = "app/src/cli.ts";
    packageDir = "app";
    workspaceRoot = inputs.workspace;
    bunDepsHash = "sha256-...";
    inherit gitRev;
  };
}
```

## Local changes

Use a dotdot workspace root as a `path:` input and pass it to `workspaceRoot`.
For local edits, set `dirty = true` so mk-bun-cli overlays local deps on top of
the bun deps snapshot. When using a `path:` input, refresh the input to pick up
dirty changes:

```bash
nix flake update workspace
nix build .#my-cli --override-input workspace path:/path/to/workspace
```

## Notes

- `bun.lock` must exist in `packageDir` (dotdot expects self-contained packages).
- mk-bun-cli assumes the dotdot workspace layout already exists; it does not run
  `dotdot link` or create workspace symlinks for you.
- Package-local flakes in effect-utils are not the git root, so `sourceInfo.*`
  may be `none`.
- When in doubt, pass `gitRev` from the calling repo’s flake (`self.sourceInfo`).

## Troubleshooting

See [troubleshooting.md](./troubleshooting.md) for sub-flake purity boundaries,
stale bunDeps snapshots, and local iteration tips.
