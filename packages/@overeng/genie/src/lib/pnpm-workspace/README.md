# pnpm-workspace

Generate `pnpm-workspace.yaml` files for pnpm monorepos.

## Usage

```ts
import { pnpmWorkspace } from '@overeng/genie/lib'
import { catalog, workspacePackages, onlyBuiltDependencies } from './genie/repo.ts'

export default pnpmWorkspace({
  packages: workspacePackages,
  catalog,
  onlyBuiltDependencies,
})
```

## Features

- **Workspace packages**: Define which directories contain workspace packages
- **Catalog**: Centralized version management for dependencies
- **Build-only dependencies**: Configure packages that should only be built (not hoisted)

## Configuration

Typically used with a `genie/repo.ts` file:

```ts
// genie/repo.ts
export const workspacePackages = [
  'packages/*',
  'apps/*',
] as const

export const catalog = {
  effect: '3.12.0',
  '@effect/platform': '0.90.0',
  typescript: '5.9.0',
  vitest: '3.0.0',
  // ...
}

export const onlyBuiltDependencies = [
  'esbuild',
  '@esbuild/*',
] as const
```
