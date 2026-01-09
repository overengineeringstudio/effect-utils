# Architecture

## Composition Hierarchy

```
┌─────────────────────────────────────────────────────────────────┐
│                      effect-utils (foundation)                   │
│  • Core catalog (Effect, React, TypeScript, Vite, testing)      │
│  • TypeScript config utilities                                   │
│  • genie package (config generators)                            │
└─────────────────────────────────────────────────────────────────┘
                              ▲
          ┌───────────────────┼───────────────────┐
          │                   │                   │
┌─────────┴─────────┐ ┌───────┴───────┐ ┌────────┴────────┐
│      lib-a        │ │     lib-b     │ │     my-app      │
│  + domain pkgs    │ │  + domain pkgs│ │  + app-specific │
└───────────────────┘ └───────────────┘ └─────────────────┘
```

Arrows point **upward**: parents import from children, never reverse.

## Directory Structure

```
my-app/                           <- Parent repo
├── genie/repo.ts                 <- Composes catalog from children
├── pnpm-workspace.yaml.genie.ts
├── tsconfig.base.json.genie.ts
├── devenv.yaml + devenv.nix
├── node_modules/
│   ├── @overeng/utils            -> submodules/effect-utils/packages/@overeng/utils (symlink!)
│   └── react/                    <- Regular npm dependency
└── submodules/
    └── effect-utils/
        ├── genie/repo.ts         <- Base catalog
        └── packages/@overeng/*/
```

## How Symlinks Work

1. `pnpm install` creates symlinks to `.pnpm/` store
2. pnpm-compose replaces them with symlinks to submodule source
3. `pnpm install --lockfile-only` updates lockfile without touching symlinks

This means changes in `submodules/effect-utils/packages/@overeng/utils/src/` are immediately visible to your app - no reinstall needed.

## Multi-level Composition

When lib-a and lib-b both depend on effect-utils:

```
my-app/
├── genie/repo.ts                 <- Composes ALL catalogs
└── submodules/
    ├── effect-utils/             <- Shared foundation
    ├── lib-a/
    │   └── genie/repo.ts         <- imports from ../effect-utils/genie/repo.ts
    └── lib-b/
        └── genie/repo.ts         <- imports from ../effect-utils/genie/repo.ts
```

pnpm-compose ensures all packages from effect-utils resolve to a single location, avoiding version conflicts.
