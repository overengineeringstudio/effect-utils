# @overeng/genie

TypeScript-based code generator for config files. Define your `package.json`, `tsconfig.json`, `oxlint.jsonc`, `oxfmt.jsonc`, and GitHub workflow files as TypeScript and generate them with consistent formatting.

Architecture and subsystem behavior are documented in the VRS set:

- [docs/vision.md](./docs/vision.md)
- [docs/requirements.md](./docs/requirements.md)
- [docs/spec.md](./docs/spec.md)

## Installation (Nix)

Genie is distributed as a native binary via Nix. **This is the only supported installation method** to avoid chicken-egg problems: since genie generates `package.json` files, it must be available before `pnpm install`.

### In your flake.nix

```nix
{
  inputs = {
    # ... other inputs ...
    genie = {
      url = "path:./path/to/effect-utils/packages/@overeng/genie";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-utils.follows = "flake-utils";
    };
  };

  outputs = { self, nixpkgs, genie, ... }:
    {
      devShell = pkgs.mkShell {
        buildInputs = [
          genie.packages.${system}.default
        ];
      };
    };
}
```

### In devenv.yaml

```yaml
inputs:
  genie:
    url: path:./packages/@overeng/genie
```

Then in `devenv.nix`:

```nix
{ pkgs, inputs, ... }:
let
  genie = inputs.genie.packages.${pkgs.stdenv.hostPlatform.system}.default;
in
{
  packages = [ genie ];
}
```

### Rebuilding after changes

```bash
# After modifying genie source code
devenv tasks run nix:build:genie

# After repo-root pnpm-lock.yaml changes (updates dependency hash)
refresh Nix FOD hashes for genie with the repo workflow

# Build all CLI packages (optional)
devenv tasks run nix:build
```

## Usage

### CLI (via devenv tasks)

```bash
# Generate all config files
devenv tasks run genie:run

# Check if files are up to date (for CI)
devenv tasks run genie:check

# Watch mode - regenerate on changes
devenv tasks run genie:watch
```

Or use the `genie` binary directly for additional options:

```bash
genie --writeable  # Generate writable files (default is read-only)
genie --dry-run    # Preview changes without writing
```

### Creating a Generator

Create a `.genie.ts` file next to the config file you want to generate:

```ts
// package.json.genie.ts
import { packageJSON } from '@overeng/genie/lib'

export default packageJSON({
  name: '@myorg/my-package',
  version: '1.0.0',
  type: 'module',
  exports: {
    '.': './src/mod.ts',
  },
  dependencies: {
    effect: '^3.12.0',
  },
})
```

Run `devenv tasks run genie:run` to generate `package.json` from the source file.

### GitHub repository settings

Generate `.github/repo-settings.json` from one typed source:

```ts
import { githubRepoSettings, githubRuleset } from '@overeng/genie'

export default githubRepoSettings({
  repository: {
    allow_auto_merge: true,
    delete_branch_on_merge: true,
    allow_update_branch: true,
    allow_squash_merge: true,
    allow_merge_commit: false,
    allow_rebase_merge: false,
    squash_merge_commit_title: 'PR_TITLE',
  },
  rulesets: [
    githubRuleset({
      name: 'protect-main',
      enforcement: 'active',
      rules: [{ type: 'non_fast_forward' }, { type: 'deletion' }],
    }),
  ],
})
```

Plain-flake consumers do not need devenv:

```bash
# Read-only diff; exits non-zero when repository fields or rulesets drift.
nix run github:overengineeringstudio/effect-utils#gh-check-settings -- \
  --repo owner/name --file .github/repo-settings.json

# PATCH explicitly declared repository fields; create/update rulesets by name.
nix run github:overengineeringstudio/effect-utils#gh-apply-settings -- \
  --repo owner/name --file .github/repo-settings.json
```

The apps package `gh` and use its existing authentication (`gh auth login` or
`GH_TOKEN`). Omitted repository fields and unrelated rulesets are unmanaged.
Rulesets inherited from an organization are not modified. Duplicate desired
ruleset names are rejected before any write. Applying several GitHub API
updates is not transactional: an API failure may leave earlier updates applied;
rerunning apply reconciles the remaining drift.

The `devenvModules.tasks.github-ruleset` module exposes the same
`gh:apply-settings` / `gh:check-settings` operations as thin wrappers,
configured with `{ repo = "owner/name"; }`. Its legacy `ruleset` parameter
remains optional and asserts the expected name. Historical JSON files containing
one raw `githubRuleset` payload remain supported; those files control only that
ruleset and do not change repository settings.

Existing raw-ruleset consumers can adopt the envelope to manage repository merge
settings. Their current payloads do not require an immediate migration.

## Generators

Each generator has its own documentation:

- **[package-json](./src/lib/package-json/README.md)** - Generate `package.json` files with field ordering, dependency inference, and validation
- **[tsconfig-json](./src/lib/tsconfig-json/README.md)** - Generate `tsconfig.json` files with TypeScript compiler options
- **[github-workflow](./src/lib/github-workflow/README.md)** - Generate GitHub Actions workflow YAML files
- **[github-action](./src/runtime/github-action/README.md)** - Generate GitHub Action metadata (`action.yml`) files
- **[oxlint-config](./src/lib/oxlint-config/README.md)** - Generate `oxlint.jsonc` configuration files
- **[oxfmt-config](./src/lib/oxfmt-config/README.md)** - Generate `oxfmt.jsonc` configuration files
- **[pnpm-workspace](./src/lib/pnpm-workspace/README.md)** - Generate `pnpm-workspace.yaml` files

## Composition Helpers

The canonical `@overeng/genie` export exposes the thin artifact builders. Use
`@overeng/genie/composition` for reusable cross-artifact helpers that consume
structured generator metadata explicitly.

```ts
import { tsconfigJson } from '@overeng/genie'
import { tsconfigReferencesFromPackages } from '@overeng/genie/composition'

import appPkg from './package.json.genie.ts'

export default tsconfigJson({
  compilerOptions: { composite: true },
  references: tsconfigReferencesFromPackages({ from: appPkg }),
})
```

## Features

- **Read-only output** - Generated files are marked read-only by default to prevent accidental edits
- **Header comments** - Adds source file reference to generated files (where supported)
- **Formatting** - Automatically formats JSON/YAML output via oxfmt
- **Check mode** - Verify files are up to date in CI without regenerating
- **Watch mode** - Auto-regenerate on source file changes

## Shared Constants

For monorepos, define shared constants in a central file:

```ts
// genie/repo.ts
export const catalog = {
  effect: '3.12.0',
  '@effect/platform': '0.90.0',
  // ...
}

export const workspacePackagePatterns = ['@myorg/*'] as const
```

Then import in your `.genie.ts` files:

```ts
import { packageJsonWithContext } from '@overeng/genie/lib'
import { catalog, workspacePackagePatterns } from '../genie/repo.ts'

export default packageJsonWithContext({
  config: {
    name: '@myorg/my-package',
    dependencies: ['effect'],
  },
  context: { catalog, workspacePackages: workspacePackagePatterns },
})
```
