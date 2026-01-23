# Bun CLI Build Pattern

Reusable Nix builder for Bun-compiled TypeScript CLIs. Designed for megarepo
workspaces and standalone repos: mk-bun-cli expects a workspace root and
builds a package inside it.

## Builder

- Path: `nix/workspace-tools/lib/mk-bun-cli.nix`
- Inputs: `pkgs`
- Versioning: reads `packageJsonPath` for base version, appends `+<gitRev>`
- Typecheck: runs `tsc --project <tsconfig> --noEmit` when `typecheck = true`
- Default `typecheckTsconfig`: `<packageDir>/tsconfig.json`
- Deps: fixed-output bun deps for the package dir (single install)
- Smoke test: runs the built binary with `smokeTestArgs` (default `--help`)
  and can optionally run from a custom working directory.

### mkBunCli arguments

| Argument            | Required | Default                      | Notes                                          |
| ------------------- | -------- | ---------------------------- | ---------------------------------------------- |
| `name`              | yes      | -                            | Derivation name and default binary name.       |
| `entry`             | yes      | -                            | CLI entry file relative to `workspaceRoot`.    |
| `packageDir`        | yes      | -                            | Package directory relative to `workspaceRoot`. |
| `workspaceRoot`     | yes      | -                            | Workspace root (flake input or path).          |
| `bunDepsHash`       | yes      | -                            | Fixed-output hash for bun deps snapshot.       |
| `binaryName`        | no       | `name`                       | Output binary name.                            |
| `packageJsonPath`   | no       | `<packageDir>/package.json`  | Used for version extraction.                   |
| `gitRev`            | no       | `"unknown"`                  | Version suffix appended as `+<gitRev>`.        |
| `typecheck`         | no       | `true`                       | Run `tsc --noEmit` with `typecheckTsconfig`.   |
| `typecheckTsconfig` | no       | `<packageDir>/tsconfig.json` | Tsconfig path relative to `workspaceRoot`.     |
| `smokeTestArgs`     | no       | `["--help"]`                 | Arguments for post-build smoke test.           |
| `smokeTestCwd`      | no       | `null`                       | Relative working directory for the smoke test. |
| `smokeTestSetup`    | no       | `null`                       | Shell snippet to prepare the smoke test dir.   |
| `dirty`             | no       | `false`                      | Optional local-deps overlay (rarely needed).   |

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
  mkBunCli = import ../../../../nix/workspace-tools/lib/mk-bun-cli.nix {
    inherit pkgs;
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
  mkBunCli = import "${effect-utils}/nix/workspace-tools/lib/mk-bun-cli.nix" {
    inherit pkgs;
  };
  gitRev = self.sourceInfo.dirtyShortRev or self.sourceInfo.shortRev or self.sourceInfo.rev or "unknown";
in
{
  packages.${system}.my-cli = mkBunCli {
    name = "my-cli";
    entry = "app/src/cli.ts";
    packageDir = "app";
    workspaceRoot = self;
    bunDepsHash = "sha256-...";
    inherit gitRev;
  };
}
```

## Local changes

Inside a megarepo, use the generated local workspace path to avoid slow `path:.`
hashing and keep builds pure. Build from the local workspace flake instead of
the repo root:

```bash
nix build --no-write-lock-file --no-link \\
  "path:$MEGAREPO_NIX_WORKSPACE#packages.<system>.my-repo.my-cli"
```

For standalone repos (outside a megarepo), use `path:.#my-cli` as usual.

## Notes

- `bun.lock` must exist in `packageDir` (each package is self-contained).
- Local file dependencies must also include `bun.lock`; mk-bun-cli snapshots
  their dependencies to keep builds deterministic.
- mk-bun-cli assumes the workspace layout already exists; it does not create
  workspace symlinks for you.
- Package-local flakes in effect-utils are not the git root, so `sourceInfo.*`
  may be `none`.
- When in doubt, pass `gitRev` from the calling repo’s flake (`self.sourceInfo`).

## Troubleshooting

See [troubleshooting.md](./troubleshooting.md) for sub-flake purity boundaries,
stale bunDeps snapshots, and local iteration tips.
