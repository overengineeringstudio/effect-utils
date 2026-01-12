---
name: managing-dotdot-workspaces
description: Manage multi-repo workspaces with dotdot. Use when working with dotdot.config.ts files, cloning sibling repos, creating symlinks for monorepo packages, or setting up path dependencies across repos. Helps with bun, cargo, and nix flake relative path patterns. Covers replacing catalog: and workspace:* with actual versions and ../ paths.
---

# Managing dotdot Workspaces

dotdot manages multi-repo workspaces where sibling repos use `../` paths to depend on each other.

## Core Concept

```
workspace/
├── .DOTDOT_ROOT         # workspace marker
├── repo-a/              # git repo with its own config
│   └── dotdot.config.ts # declares dependencies
├── repo-b/              # depends on ../repo-a
│   └── dotdot.config.ts
├── @scope/              # symlinks for monorepo packages
│   └── utils -> ../monorepo/packages/@scope/utils
└── monorepo/            # exposes nested packages
```

## Config: dotdot.config.ts

Each repo declares its dependencies in its own config file:

```typescript
// repo-a/dotdot.config.ts
import { defineConfig } from 'dotdot'

export default defineConfig({
  repos: {
    'shared-lib': {
      url: 'git@github.com:org/shared-lib.git',
      rev: 'abc123...',
      install: 'bun install',
    },
    'my-monorepo': {
      url: 'git@github.com:org/my-monorepo.git',
      rev: 'def456...',
      install: 'pnpm install',
      packages: {
        '@scope/utils': { path: 'packages/@scope/utils', install: 'pnpm build' },
        '@scope/core': { path: 'packages/@scope/core' },
      },
    },
  },
})
```

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| `url` | Yes | Git clone URL |
| `rev` | No | Pinned commit SHA |
| `install` | No | Repo-level command after clone |
| `packages` | No | Nested packages to symlink at workspace root |

### Package Fields

| Field | Required | Description |
|-------|----------|-------------|
| `path` | Yes | Path within the repo |
| `install` | No | Package-level command (runs after repo install) |

## Commands

| Command | Description |
|---------|-------------|
| `dotdot init` | Create `.DOTDOT_ROOT` marker |
| `dotdot status` | Show repo states and revision status |
| `dotdot sync` | Clone missing repos, checkout pinned revisions |
| `dotdot update-revs` | Save current HEADs to config |
| `dotdot pull` | Pull all repos |
| `dotdot tree` | Show dependency tree |
| `dotdot link` | Create symlinks from packages configs |
| `dotdot exec -- cmd` | Run command in all repos |

## Path Dependencies by Ecosystem

### Bun/Node (package.json)

```json
{
  "dependencies": {
    "sibling-repo": "../sibling-repo",
    "@scope/utils": "../@scope/utils"
  }
}
```

**Do not use** `link:` or `file:` prefixes - they fail with bun.

### Rust (Cargo.toml)

```toml
[dependencies]
sibling-repo = { path = "../sibling-repo" }
myorg-utils = { path = "../myorg/utils" }
```

### Nix Flakes (flake.nix)

```nix
inputs = {
  sibling-repo.url = "git+file:../sibling-repo";
  # Deduplicate shared inputs
  other-repo.inputs.sibling-repo.follows = "sibling-repo";
};
```

**Do not use** `path:` - it cannot escape git repo boundaries.

### devenv (devenv.yaml)

```yaml
inputs:
  sibling-repo:
    url: git+file:../sibling-repo
```

## The Packages Pattern

When a monorepo has nested packages, use `packages` to create symlinks:

```typescript
// my-app/dotdot.config.ts
export default defineConfig({
  repos: {
    'my-monorepo': {
      url: '...',
      install: 'pnpm install',
      packages: {
        '@scope/utils': { path: 'packages/@scope/utils', install: 'pnpm build' },
        '@scope/core': { path: 'packages/@scope/core' },
      },
    },
  },
})
```

Creates:
```
workspace/
├── @scope/
│   ├── utils -> ../my-monorepo/packages/@scope/utils
│   └── core -> ../my-monorepo/packages/@scope/core
└── my-monorepo/
    └── packages/@scope/{utils,core}
```

Now any repo can use `../@scope/utils` instead of `../my-monorepo/packages/@scope/utils`.

## Distributed Configs

Each repo has its own `dotdot.config.ts` declaring its dependencies. All repos are **flattened to workspace level** - never cloned inside other repos.

```
workspace/
├── .DOTDOT_ROOT
├── repo-a/
│   └── dotdot.config.ts  # declares shared-lib
├── repo-b/
│   └── dotdot.config.ts  # also declares shared-lib
└── shared-lib/           # only one copy, deduplicated
```

When the same repo is declared in multiple configs:
- Only one copy exists in the workspace
- Revision conflicts are detected and reported
- Use `dotdot tree --conflicts` to see conflicts

## Common Tasks

### Set up a new workspace
1. `mkdir workspace && cd workspace`
2. `dotdot init` (creates `.DOTDOT_ROOT`)
3. `git clone` your main repo
4. Run `dotdot sync` to get all dependencies

### Add a dependency to another repo
1. Add entry to your repo's `dotdot.config.ts`
2. Run `dotdot sync` from workspace root
3. Use `../repo-name` in your package.json/Cargo.toml/flake.nix

### Pin current state
```bash
dotdot update-revs  # saves all current HEADs to config files
```

### Restore to pinned state
```bash
dotdot sync  # clones missing repos, checks out pinned revisions
```

## Migrating to dotdot

### From a Bun Monorepo

A bun workspace monorepo uses features that don't work across repos:

| Bun Workspace | dotdot Equivalent |
|---------------|-------------------|
| `"dep": "catalog:"` | `"dep": "^1.2.3"` (actual version) |
| `"pkg": "workspace:*"` | `"pkg": "../pkg"` (relative path) |
| Single `bun install` at root | `bun install` per repo |
| Single `bun.lock` | Lockfile per repo |

**Migration steps:**

1. **Decide what stays together** - Tightly coupled packages can remain in a monorepo and use `packages`

2. **Replace catalog: dependencies** - Change to actual version strings
   ```json
   // Before
   { "effect": "catalog:" }
   // After
   { "effect": "^3.12.0" }
   ```

3. **Replace workspace: with paths** - For packages becoming separate repos
   ```json
   // Before
   { "@myorg/utils": "workspace:*" }
   // After
   { "@myorg/utils": "../@myorg/utils" }
   ```

4. **Create dotdot.config.ts** - In each repo that has dependencies
   ```typescript
   import { defineConfig } from 'dotdot'

   export default defineConfig({
     repos: {
       'my-monorepo': {
         url: 'git@github.com:org/my-monorepo.git',
         install: 'bun install',
         packages: {
           '@myorg/utils': { path: 'packages/@myorg/utils' },
           '@myorg/core': { path: 'packages/@myorg/core' },
         },
       },
     },
   })
   ```

5. **Split repos if needed** - Move packages to their own git repos

6. **Run bun install in each repo** - No single root install anymore

### Hybrid Approach

Keep tightly coupled packages in a monorepo, link to external repos:

```typescript
// my-app/dotdot.config.ts
export default defineConfig({
  repos: {
    // Monorepo with internal packages
    'core-packages': {
      url: '...',
      install: 'pnpm install',
      packages: {
        '@myorg/utils': { path: 'packages/@myorg/utils' },
        '@myorg/types': { path: 'packages/@myorg/types' },
      },
    },
    // Standalone repos
    'shared-lib': { url: '...', install: 'bun install' },
  },
})
```

### What You Lose

- Single `bun install` for everything
- Atomic commits across packages
- `catalog:` for shared dependency versions
- `--filter` workspace commands
- Single lockfile

### What You Gain

- Independent repo lifecycles
- Separate access control per repo
- Mix ecosystems (bun + rust + nix)
- Smaller clones for focused work
- Clearer ownership boundaries

## Important Constraints

1. **No dependency files at workspace root** - The root has no parent, so `../` doesn't work there
2. **Each repo cloned once** - Even if declared in multiple dotdot.config.ts files
3. **Symlinks for scoped packages** - `@scope/name` symlinks need parent directory created first
4. **Git repos required for nix** - `git+file:` only works with git repositories
5. **Files must be staged for nix** - Run `git add flake.nix` before `nix flake show`
