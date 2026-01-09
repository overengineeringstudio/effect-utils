# @overeng/genie

TypeScript-based code generator for config files. Define your `package.json`, `tsconfig.json`, `oxlint.jsonc`, `oxfmt.jsonc`, and GitHub workflow files as TypeScript and generate them with consistent formatting.

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
      inputs.nixpkgsUnstable.follows = "nixpkgsUnstable";
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
  genie = inputs.genie.packages.${pkgs.system}.default;
in
{
  packages = [ genie ];
}
```

### Rebuilding after changes

```bash
# After modifying genie source code
mono nix build --package genie

# After bun.lock changes (updates dependency hash)
mono nix hash --package genie

# Reload direnv to pick up rebuilt binaries
mono nix reload
```

## Usage

### CLI

```bash
# Generate all config files
mono genie

# Check if files are up to date (for CI)
mono genie --check

# Watch mode - regenerate on changes
mono genie --watch

# Generate writable files (default is read-only)
mono genie --writeable
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

Run `mono genie` to generate `package.json` from the source file.

## Generators

Each generator has its own documentation:

- **[package-json](./src/lib/package-json/README.md)** - Generate `package.json` files with field ordering, dependency inference, and validation
- **[tsconfig-json](./src/lib/tsconfig-json/README.md)** - Generate `tsconfig.json` files with TypeScript compiler options
- **[github-workflow](./src/lib/github-workflow/README.md)** - Generate GitHub Actions workflow YAML files
- **[oxlint-config](./src/lib/oxlint-config/README.md)** - Generate `oxlint.jsonc` configuration files
- **[oxfmt-config](./src/lib/oxfmt-config/README.md)** - Generate `oxfmt.jsonc` configuration files
- **[pnpm-workspace](./src/lib/pnpm-workspace/README.md)** - Generate `pnpm-workspace.yaml` files

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

export default packageJsonWithContext(
  {
    name: '@myorg/my-package',
    dependencies: ['effect'],
  },
  { catalog, workspacePackages: workspacePackagePatterns },
)
```
