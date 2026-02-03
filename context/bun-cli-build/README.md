# Bun CLI Build Pattern

> This extends the [nix-devenv](../nix-devenv/) foundation. See [requirements.md](../nix-devenv/requirements.md) for assumptions (A1-A3) and base requirements (R1-R19).

Reusable Nix builder for Bun-compiled TypeScript CLIs. Designed for megarepo
workspaces and standalone repos: mk-bun-cli expects a workspace root and
builds a package inside it.

## Builder

- Path: `nix/workspace-tools/lib/mk-bun-cli.nix`
- Inputs: `pkgs`
- Versioning: embeds structured JSON stamp with version, git rev, and commit timestamp
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
| `gitRev`            | no       | `"unknown"`                  | Git short revision.                            |
| `commitTs`          | no       | `0`                          | Git commit timestamp (Unix seconds).           |
| `dirty`             | no       | `false`                      | Whether build includes uncommitted changes.    |
| `typecheck`         | no       | `true`                       | Run `tsc --noEmit` with `typecheckTsconfig`.   |
| `typecheckTsconfig` | no       | `<packageDir>/tsconfig.json` | Tsconfig path relative to `workspaceRoot`.     |
| `smokeTestArgs`     | no       | `["--help"]`                 | Arguments for post-build smoke test.           |
| `smokeTestCwd`      | no       | `null`                       | Relative working directory for the smoke test. |
| `smokeTestSetup`    | no       | `null`                       | Shell snippet to prepare the smoke test dir.   |

## CLI Version Pattern

```ts
import { resolveCliVersion } from '@overeng/utils/node/cli-version'

const baseVersion = '0.1.0'
// Build stamp placeholder replaced by nix build with NixStamp JSON
const buildStamp = '__CLI_BUILD_STAMP__'
const version = resolveCliVersion({
  baseVersion,
  buildStamp,
})
```

`mk-bun-cli` performs a literal search/replace for
`const buildStamp = '__CLI_BUILD_STAMP__'` in the entry file and replaces it
with a NixStamp JSON containing version metadata. The substitution is enforced
with `--replace-fail`, so builds will fail if the exact placeholder line is missing.

## Stamp Types (Tagged Union)

The system uses two stamp types:

### LocalStamp (runtime, env var)

Set via `CLI_BUILD_STAMP` env var when entering a dev shell:

```json
{ "type": "local", "rev": "abc123", "ts": 1738000000, "dirty": true }
```

- `type`: Always `"local"`
- `rev`: Git short revision
- `ts`: Unix timestamp when shell was entered
- `dirty`: Whether there were uncommitted changes

### NixStamp (build-time, embedded)

Embedded in binary at Nix build time:

```json
{ "type": "nix", "version": "0.1.0", "rev": "def456", "commitTs": 1737900000, "dirty": false }
```

- `type`: Always `"nix"`
- `version`: Package version from package.json
- `rev`: Git short revision
- `commitTs`: Git commit timestamp (reproducible)
- `dirty`: Whether build included uncommitted changes
- `buildTs`: (optional) Wall-clock build time for impure builds

## Version Output

`resolveCliVersion` renders human-friendly version strings with relative time:

| Context                 | Example Output                                                                    |
| ----------------------- | --------------------------------------------------------------------------------- |
| Local dev, dirty        | `0.1.0 — running from local source (abc123, 5 min ago, with uncommitted changes)` |
| Local dev, clean        | `0.1.0 — running from local source (abc123, 2 hours ago)`                         |
| Nix build (pure), clean | `0.1.0+def456 — committed 3 days ago`                                             |
| Nix build (pure), dirty | `0.1.0+def456-dirty — committed 3 days ago, with uncommitted changes`             |
| Nix build (impure)      | `0.1.0+def456 — built 2 hours ago`                                                |
| No stamp                | `0.1.0`                                                                           |

The relative time formatting uses medium granularity:

- `just now` (< 1 min)
- `5 min ago` (1-59 min)
- `2 hours ago` (1-23 hours)
- `3 days ago` (1-6 days)
- `2 weeks ago` (7-30 days)
- `Jan 15` (> 30 days)

For Nix builds, the time shown is the **commit timestamp** (reproducible), not
the build time. This tells you how old the code is. For impure builds, the
actual build timestamp is shown instead.

## Shell Hook Setup

To enable runtime stamps for local dev, use the helper from effect-utils:

- `effect-utils.lib.cliBuildStamp { pkgs }` returns `{ package, shellHook }`
- Include `${shellHook}` in your shell entry hook (`enterShell` in devenv)
- The shellHook exports `CLI_BUILD_STAMP` with a LocalStamp JSON

```nix
let
  cliBuildStamp = effectUtils.lib.cliBuildStamp { inherit pkgs; };
in
{
  enterShell = ''
    ${cliBuildStamp.shellHook}
  '';
}
```

## Inside effect-utils

```nix
let
  mkBunCli = import ../../../../nix/workspace-tools/lib/mk-bun-cli.nix {
    inherit pkgs;
  };
  gitRev = self.sourceInfo.dirtyShortRev or self.sourceInfo.shortRev or "unknown";
  commitTs = self.sourceInfo.lastModified or 0;
  dirty = self.sourceInfo ? dirtyShortRev;
in
mkBunCli {
  name = "genie";
  entry = "packages/@overeng/genie/src/build/mod.ts";
  packageDir = "packages/@overeng/genie";
  workspaceRoot = self;
  bunDepsHash = "sha256-...";
  typecheckTsconfig = "packages/@overeng/genie/tsconfig.json";
  inherit gitRev commitTs dirty;
}
```

## Outside effect-utils (flake input)

Pass version info from the parent repo so the built binary reflects the
parent's commit:

```nix
let
  mkBunCli = import "${effect-utils}/nix/workspace-tools/lib/mk-bun-cli.nix" {
    inherit pkgs;
  };
  gitRev = self.sourceInfo.dirtyShortRev or self.sourceInfo.shortRev or "unknown";
  commitTs = self.sourceInfo.lastModified or 0;
  dirty = self.sourceInfo ? dirtyShortRev;
in
{
  packages.${system}.my-cli = mkBunCli {
    name = "my-cli";
    entry = "app/src/cli.ts";
    packageDir = "app";
    workspaceRoot = self;
    bunDepsHash = "sha256-...";
    inherit gitRev commitTs dirty;
  };
}
```

## Local changes

For builds, use direct paths and `--override-input` for local dependencies:

```bash
nix build --no-write-lock-file --no-link \
  "path:$DEVENV_ROOT/repos/my-repo#packages.<system>.my-cli" \
  --override-input effect-utils "path:$DEVENV_ROOT/repos/effect-utils"
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
- When in doubt, pass `gitRev`, `commitTs`, and `dirty` from the calling repo's
  flake (`self.sourceInfo`).

## Troubleshooting

See [troubleshooting.md](./troubleshooting.md) for sub-flake purity boundaries,
stale bunDeps snapshots, and local iteration tips.
