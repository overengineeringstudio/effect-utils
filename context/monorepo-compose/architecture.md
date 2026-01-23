# Architecture

## Workspace Structure (Megarepo)

```
my-workspace/                                  <- megarepo root
├── megarepo.json                              <- repo list
├── repos/
│   ├── my-app/                                <- repo symlink
│   │   ├── .git/
│   │   ├── package.json
│   │   └── src/
│   └── effect-utils/                          <- repo symlink
│       ├── .git/
│       ├── genie/repo.ts
│       └── packages/@overeng/*/
└── .direnv/megarepo-nix/workspace/            <- local Nix workspace
    ├── flake.nix
    ├── my-app/
    └── effect-utils/
```

Repo symlinks point into the megarepo store (outside the workspace), while the
local Nix workspace provides a filtered copy for fast `nix` eval/builds.

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

Dependencies flow **upward**: repos import from their dependencies via `../` paths
inside `repos/` (for example `repos/my-app` depends on `../effect-utils`).

## Multi-level Composition

When multiple repos depend on effect-utils:

```
my-workspace/
├── megarepo.json
├── repos/
│   ├── my-app/
│   ├── lib-a/
│   ├── lib-b/
│   └── effect-utils/       <- Only one copy, deduplicated
```

The megarepo ensures:

- Only one copy of each repo exists in the workspace
- Revision conflicts are detected and reported
- All repos can share the same dependency via relative paths
