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
const baseVersion = '0.1.0'
const cliVersion = process.env.CLI_VERSION
const version = cliVersion === undefined || cliVersion.length === 0 ? baseVersion : cliVersion
```

## Inside effect-utils

```nix
let
  mkBunCli = import ../../../../nix/mk-bun-cli.nix {
    inherit pkgs pkgsUnstable;
  };
in
mkBunCli {
  name = "genie";
  entry = "packages/@overeng/genie/src/build/cli.ts";
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
- Package-local flakes in effect-utils are not the git root, so `sourceInfo.*`
  may be `none`.
- When in doubt, pass `gitRev` from the calling repo’s flake (`self.sourceInfo`).
