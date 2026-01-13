# Architecture

## Workspace Structure

```
my-workspace/                     <- dotdot workspace
├── dotdot-root.json              <- Workspace marker (auto-generated)
├── my-app/                       <- Your main repo
│   ├── .git/
│   ├── dotdot.json               <- Declares dependencies
│   ├── genie/repo.ts             <- Composes catalog from dependencies
│   ├── package.json
│   └── src/
├── effect-utils/                 <- Dependency repo (flat peer)
│   ├── .git/
│   ├── genie/repo.ts             <- Base catalog
│   └── packages/@overeng/*/
└── @overeng/                     <- Symlinks to nested packages
    ├── utils -> ../effect-utils/packages/@overeng/utils
    └── genie -> ../effect-utils/packages/@overeng/genie
```

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

Dependencies flow **upward**: repos import from their dependencies via `../` paths.

## How Symlinks Work

When a dependency has nested packages (like effect-utils with `packages/@overeng/*`), dotdot creates symlinks at the workspace root:

1. `dotdot sync` clones the dependency repo
2. `dotdot link` creates symlinks from `packages` config
3. Your repo uses `../@overeng/utils` instead of `../effect-utils/packages/@overeng/utils`

This simplifies path dependencies:

```json
{
  "dependencies": {
    "@overeng/utils": "../@overeng/utils"
  }
}
```

## Multi-level Composition

When lib-a and lib-b both depend on effect-utils:

```
my-workspace/
├── dotdot-root.json
├── my-app/
│   └── dotdot.json         <- Declares effect-utils, lib-a, lib-b
├── lib-a/
│   └── dotdot.json         <- Declares effect-utils
├── lib-b/
│   └── dotdot.json         <- Declares effect-utils
├── effect-utils/           <- Only one copy, deduplicated
└── @overeng/               <- Symlinks from effect-utils
```

dotdot ensures:

- Only one copy of each repo exists in the workspace
- Revision conflicts are detected and reported
- All repos can share the same dependency via relative paths
