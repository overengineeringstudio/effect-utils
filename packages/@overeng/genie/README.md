# @overeng/genie

TypeScript-based code generator for config files. Define your `package.json`, `tsconfig.json`, `oxlint.jsonc`, `oxfmt.jsonc`, and GitHub workflow files as TypeScript and generate them with consistent formatting.

## Installation (Nix)

Genie is distributed as a native binary via Nix. **This is the recommended installation method** to avoid chicken-egg problems: since genie generates `package.json` files, it must be available before `pnpm install`.

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

### `packageJSON`

Generate `package.json` files with proper field ordering and formatting.

```ts
import { packageJSON } from '@overeng/genie/lib'

export default packageJSON({
  name: '@myorg/my-package',
  version: '1.0.0',
  private: true,
  type: 'module',
  exports: { '.': './src/mod.ts' },
  dependencies: { effect: '^3.12.0' },
  devDependencies: { typescript: '^5.9.0' },
})
```

### `tsconfigJSON`

Generate `tsconfig.json` files with TypeScript compiler options.

```ts
import { tsconfigJSON } from '@overeng/genie/lib'

export default tsconfigJSON({
  extends: '../tsconfig.base.json',
  compilerOptions: {
    composite: true,
    rootDir: '.',
    outDir: './dist',
  },
  include: ['src/**/*.ts'],
  references: [{ path: '../other-package' }],
})
```

### `githubWorkflow`

Generate GitHub Actions workflow YAML files.

```ts
import { githubWorkflow } from '@overeng/genie/lib'

export default githubWorkflow({
  name: 'CI',
  on: {
    push: { branches: ['main'] },
    pull_request: { branches: ['main'] },
  },
  jobs: {
    test: {
      'runs-on': 'ubuntu-latest',
      steps: [
        { uses: 'actions/checkout@v4' },
        { run: 'npm test' },
      ],
    },
  },
})
```

### `oxlintConfig`

Generate `oxlint.jsonc` configuration files. See [oxlint configuration docs](https://oxc.rs/docs/guide/usage/linter/config) for reference.

```ts
import { oxlintConfig } from '@overeng/genie/lib'

export default oxlintConfig({
  plugins: ['import', 'typescript', 'unicorn', 'oxc'],
  jsPlugins: ['./custom-rules.ts'],
  categories: {
    correctness: 'error',
    suspicious: 'warn',
    pedantic: 'off',
    perf: 'warn',
    style: 'off',
    restriction: 'off',
  },
  rules: {
    'import/no-cycle': 'warn',
    'oxc/no-barrel-file': ['warn', { threshold: 0 }],
  },
  overrides: [
    { files: ['**/mod.ts'], rules: { 'oxc/no-barrel-file': 'off' } },
    { files: ['**/*.test.ts'], rules: { 'import/no-cycle': 'off' } },
  ],
})
```

### `oxfmtConfig`

Generate `oxfmt.jsonc` configuration files. See [oxfmt repository](https://github.com/nicksrandall/oxfmt) for reference.

```ts
import { oxfmtConfig } from '@overeng/genie/lib'

export default oxfmtConfig({
  semi: false,
  singleQuote: true,
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  trailingComma: 'all',
  experimentalSortImports: {
    groups: ['builtin', 'external', 'internal', ['parent', 'sibling', 'index']],
    internalPattern: ['@myorg/'],
    newlinesBetween: true,
  },
  experimentalSortPackageJson: true,
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
export const catalogRef = 'catalog:'
export const domLib = ['ES2022', 'DOM', 'DOM.Iterable'] as const
```

Then import in your `.genie.ts` files:

```ts
import { catalogRef } from '../genie/repo.ts'
import { packageJSON } from '@overeng/genie/lib'

export default packageJSON({
  dependencies: {
    effect: catalogRef,
  },
})
```
