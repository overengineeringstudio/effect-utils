# package-json

Generate `package.json` files with proper field ordering and formatting.

## Functions

### `packageJSON`

Basic package.json generator with validation warnings.

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

### `packageJsonWithContext`

Advanced generator with dependency inference from catalog and workspace packages.

```ts
import { packageJsonWithContext } from '@overeng/genie/lib'
import { catalog, workspacePackagePatterns } from '../../../genie/repo.ts'

export default packageJsonWithContext({
  config: {
    name: '@myorg/my-package',
    version: '1.0.0',
    type: 'module',
    exports: { '.': './src/mod.ts' },
    // Dependencies as array - resolved to catalog: or workspace:*
    dependencies: ['effect', '@effect/platform', '@myorg/utils'],
    devDependencies: ['vitest', 'typescript'],
    // Peer deps with range expansion
    peerDependencies: { effect: '^', react: '~' },
  },
  context: { catalog, workspacePackages: workspacePackagePatterns },
})
```

## Features

- **Field ordering**: Fields sorted in conventional order (name, version, type, exports, dependencies, ...)
- **Export condition ordering**: Conditions sorted (types first, default last)
- **Dependency inference**: `string[]` dependencies resolved to `catalog:` or `workspace:*`
- **Peer dep expansion**: `'^'` or `'~'` expanded to catalog version with range prefix
- **Validation**: Warns on missing name/version for non-private packages
- **Error on unknown deps**: Catches typos by throwing on unresolved dependencies

## Context

The `packageJsonWithContext` function requires a context object:

```ts
type PackageJsonContext = {
  /** Catalog of package versions (package name -> version string) */
  catalog: Record<string, string>
  /** List of workspace package name patterns (e.g., '@myorg/*') */
  workspacePackages: readonly string[]
}
```

Typically defined in `genie/repo.ts`:

```ts
export const catalog = {
  effect: '3.12.0',
  '@effect/platform': '0.90.0',
  // ...
}

export const workspacePackagePatterns = ['@myorg/*'] as const
```
