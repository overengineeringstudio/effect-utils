# Using dotdot with Genie

Genie generates config files (`package.json`, `tsconfig.json`, etc.) from TypeScript source files. Combined with dotdot, it enables shared configuration across independent repos.

## How It Works

Write `*.genie.ts` files that export configuration objects:

```typescript
// package.json.genie.ts
import { packageJson, catalog } from '../shared-lib/genie/external.ts'

export default packageJson({
  name: '@org/my-app',
  dependencies: {
    '@org/shared-lib': 'file:../shared-lib',
    ...catalog.pick('effect', 'typescript'),
  },
})
```

Run genie to generate the actual files:

```bash
genie generate
```

## Cross-Repo Configuration

Each repo can expose genie utilities for peer repos via a `genie/external.ts` file:

```typescript
// shared-lib/genie/external.ts
export { catalog, packageJson, baseTsconfigOptions } from './internal.ts'
```

Peer repos import these with relative `../` paths:

```typescript
// my-app/package.json.genie.ts
import { catalog } from '../shared-lib/genie/external.ts'
```

## Benefits with dotdot

- **Shared catalogs** - Single source of truth for dependency versions across repos
- **Composable configs** - Base tsconfig options, shared package.json defaults
- **Type-safe** - TypeScript validation of configuration
- **Live updates** - Changes in shared-lib's genie exports are immediately available (via dotdot's flat structure)

## Typical Setup

```
workspace/
├── shared-lib/
│   └── genie/
│       ├── internal.ts    # Private utilities
│       └── external.ts    # Re-exports for peer repos
├── my-app/
│   ├── package.json.genie.ts
│   └── tsconfig.json.genie.ts
└── other-repo/
    └── package.json.genie.ts
```

## Regenerating After Changes

When shared configuration changes:

```bash
dotdot exec -- genie generate
```
