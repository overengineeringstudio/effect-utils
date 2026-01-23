# TypeScript Integration

This guide covers configuring TypeScript for cross-repo type checking and imports.

## Project References

Use TypeScript project references to enable type-aware imports across members.

### Root tsconfig.json

```json
{
  "files": [],
  "references": [
    { "path": "./effect/packages/effect" },
    { "path": "./effect/packages/platform" },
    { "path": "./other-lib" },
    { "path": "./local-lib" }
  ]
}
```

### Member tsconfig.json

Each member should have `composite: true`:

```json
{
  "compilerOptions": {
    "composite": true,
    "declaration": true,
    "declarationMap": true,
    "outDir": "./dist"
  },
  "include": ["src/**/*"]
}
```

## Path Aliases

Configure path aliases for cleaner imports.

### Using paths

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@effect/*": ["./repos/effect/packages/*/src"],
      "@other/*": ["./repos/other-lib/packages/*/src"],
      "@local/*": ["./repos/local-lib/src/*"]
    }
  }
}
```

### Using exports in package.json

Modern approach using package.json exports:

```json
{
  "name": "effect",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./*": {
      "types": "./dist/*.d.ts",
      "import": "./dist/*.js"
    }
  }
}
```

Then import normally:

```typescript
import { Effect } from 'effect'
import { FileSystem } from '@effect/platform'
```

## Build Configuration

### Incremental Builds

Enable incremental builds for faster type checking:

```json
{
  "compilerOptions": {
    "incremental": true,
    "tsBuildInfoFile": "./.tsbuildinfo"
  }
}
```

### Build Order

Use `tsc --build` to respect project references:

```bash
# Build all projects in dependency order
tsc --build

# Build specific project and its dependencies
tsc --build ./local-lib

# Clean and rebuild
tsc --build --clean
```

## Watch Mode

### Single Project

```bash
tsc --watch
```

### All Projects

```bash
tsc --build --watch
```

### With megarepo exec

```bash
# Type check all members
mr exec "tsc --noEmit"

# Watch mode in specific member
mr exec "tsc --watch --noEmit" --member local-lib
```

## Editor Integration

### VS Code

Generate a workspace file for better multi-root support:

```bash
mr generate vscode
```

This creates `.vscode/megarepo.code-workspace` with:

- All members as workspace folders
- Shared settings
- Proper TypeScript project discovery

Open with: `code .vscode/megarepo.code-workspace`

### Workspace Settings

Add to `.vscode/settings.json`:

```json
{
  "typescript.tsdk": "node_modules/typescript/lib",
  "typescript.enablePromptUseWorkspaceTsdk": true,
  "typescript.preferences.includePackageJsonAutoImports": "on"
}
```

## Common Patterns

### Shared Types Package

Create a shared types package that other members import:

```
my-megarepo/
└── repos/
    ├── shared-types/
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/
    │       └── index.ts
    ├── app/  # imports from @my-org/shared-types
    └── api/  # imports from @my-org/shared-types
```

### Declaration Files

For members without TypeScript source, create declaration files:

```
member/
├── index.js
└── index.d.ts
```

### Strict Mode Gradual Adoption

Enable strict mode per-member:

```json
// Stricter member
{
  "compilerOptions": {
    "strict": true
  }
}

// Legacy member (gradual)
{
  "compilerOptions": {
    "strict": false,
    "strictNullChecks": true  // Enable incrementally
  }
}
```

## Troubleshooting

### Types Not Resolving

1. Ensure `composite: true` in member tsconfig
2. Check that `references` point to the right paths
3. Run `tsc --build` to generate declaration files

### Circular Dependencies

Project references don't allow cycles. Restructure to break cycles:

```
// Instead of A <-> B
// Use: A -> shared <- B
```

### Symlink Issues

TypeScript follows symlinks by default. If you need to preserve symlinks:

```json
{
  "compilerOptions": {
    "preserveSymlinks": true
  }
}
```

**Note:** This is rarely needed with megarepo since symlinks point to real directories.
