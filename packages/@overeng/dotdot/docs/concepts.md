# Core Concepts

## Workspace

A directory containing multiple peer repositories managed by dotdot. The workspace root is identified by the presence of a `dotdot.json` configuration file.

```
my-workspace/
├── dotdot.json           # Root config (workspace marker)
├── repo-a/               # Peer repo
│   ├── .git/
│   └── dotdot.json       # Declares repo-a's dependencies (optional)
├── repo-b/               # Peer repo
│   ├── .git/
│   └── dotdot.json       # Declares repo-b's dependencies (optional)
└── shared-lib/           # Shared dependency
    └── .git/
```

**Key characteristics:**
- Workspace root is found by walking up from current directory looking for `dotdot.json`
- All repos are flat peers at the same level (no nesting)
- Each repo can have its own `dotdot.json` declaring its dependencies
- Dependencies from all configs are deduplicated at the workspace level

## Repository

A git repository within a workspace. Can be in one of these states:

| State | Description |
|-------|-------------|
| **Declared + Exists** | In config and cloned |
| **Declared + Missing** | In config but not cloned |
| **Undeclared** | Cloned but not in any config |

Repos are identified by their directory name (which matches the key in the config).

## Configuration

Each repo uses a JSON configuration file to declare its dependencies. The format is language-agnostic - dotdot works with any ecosystem.

### Config File Location

```
workspace/
├── dotdot.json           # Root workspace config
├── repo-a/
│   └── dotdot.json       # Declares repo-a's dependencies
├── repo-b/
│   └── dotdot.json       # Declares repo-b's dependencies
└── shared-lib/           # May or may not have its own config
```

### Config Schema

```json
{
  "$schema": "https://raw.githubusercontent.com/overengineeringstudio/dotdot/main/schema/dotdot.schema.json",
  "repos": {
    "shared-lib": {
      "url": "git@github.com:org/shared-lib.git",
      "rev": "abc123...",
      "install": "pnpm install",
      "packages": {
        "@org/utils": {
          "path": "packages/@org/utils",
          "install": "pnpm build"
        }
      }
    }
  }
}
```

**Schema fields:**
- `$schema` - Optional: JSON Schema URL for editor support
- `repos` - Required: map of repo name to config
  - `url` - Required: git remote URL
  - `rev` - Optional: pinned commit SHA
  - `install` - Optional: command to run after cloning
  - `packages` - Optional: nested packages to expose

### Config Aggregation

When collecting configs, dotdot:
1. Scans each repo directory for `dotdot.json` files
2. Merges all declared repos into a flat, deduplicated list
3. Tracks which config(s) each dependency is declared in
4. Detects and reports conflicts (same repo with different revisions)

If the same repo is declared in multiple configs with different revisions, dotdot reports this as a conflict.

## Revision Pinning

Each repo can have a pinned revision (commit SHA) in its config.

**Status determination:**
- **ok**: Current HEAD matches pinned revision
- **diverged**: Current HEAD differs from pinned revision
- **no-pin**: No revision specified in config

This enables reproducible workspace states - restore all repos, checkout pinned revisions, and you have an exact snapshot.

## Deduplication

When multiple repos declare the same dependency:
- Only one copy exists in the workspace
- All repos share the same cloned directory
- Revision conflicts are detected and reported

Example:
```
repo-a/dotdot.config.ts declares: shared-lib @ abc123
repo-b/dotdot.config.ts declares: shared-lib @ abc123
→ Result: Single shared-lib/ directory, no conflict

repo-a/dotdot.config.ts declares: shared-lib @ abc123
repo-b/dotdot.config.ts declares: shared-lib @ def456
→ Result: Single shared-lib/ directory, CONFLICT reported
```

## Packages

Packages are conceptually mini-repositories within a repo. This is a convenience feature for cases where splitting into separate repos would bring too much maintenance overhead (separate git histories, CI configs, etc.), but you still want the benefits of dotdot's flat workspace model.

By declaring packages, you get:
- Each package symlinked to the workspace root (just like a real repo)
- Simple `../` paths from other repos
- Per-package install commands

Think of it as: "I'd make these separate repos, but it's not worth the overhead. Packages let me keep them together while treating them as independent units."

### Package Schema

```json
{
  "packages": {
    "<symlink-name>": {
      "path": "path/within/repo",
      "install": "optional build command"
    }
  }
}
```

The key (e.g., `@acme/components`) becomes the symlink name at workspace root. The `path` specifies where the package lives within the repo.

### Example: Exposing Monorepo Packages

**Scenario:** You have a monorepo with scoped packages that other repos need to depend on.

```json
{
  "$schema": "https://raw.githubusercontent.com/overengineeringstudio/dotdot/main/schema/dotdot.schema.json",
  "repos": {
    "design-system": {
      "url": "git@github.com:org/design-system.git",
      "rev": "abc1234...",
      "install": "pnpm install",
      "packages": {
        "@acme/components": {
          "path": "packages/@acme/components",
          "install": "pnpm build"
        },
        "@acme/tokens": {
          "path": "packages/@acme/tokens"
        }
      }
    }
  }
}
```

**Before `dotdot link`:**
```
my-workspace/
├── dotdot.json
├── my-app/
│   ├── dotdot.json
│   └── package.json         # wants to import @acme/components
└── design-system/
    └── packages/
        └── @acme/
            ├── components/   # The actual package
            │   ├── package.json
            │   └── src/
            └── tokens/       # The actual package
                ├── package.json
                └── src/
```

**After `dotdot link`:**
```
my-workspace/
├── dotdot.json
├── @acme/                           # Created by dotdot
│   ├── components -> ../design-system/packages/@acme/components
│   └── tokens -> ../design-system/packages/@acme/tokens
├── my-app/
│   ├── dotdot.json
│   └── package.json
└── design-system/
    └── packages/@acme/{components,tokens}
```

**Command output:**
```
$ dotdot link

dotdot workspace: /path/to/my-workspace

Creating symlinks...
  @acme/components -> design-system/packages/@acme/components
  @acme/tokens -> design-system/packages/@acme/tokens

Done: 2 symlinks created
```

### Install Order

When `dotdot sync` runs, install commands execute in this order:
1. Repo-level `install` (e.g., `pnpm install`)
2. Package-level `install` for each package (e.g., `pnpm build`)

This allows you to install dependencies first, then build individual packages.

### Using Packages

Now `my-app` can reference the packages with simple relative paths:

```json
// my-app/package.json
{
  "dependencies": {
    "@acme/components": "../@acme/components",
    "@acme/tokens": "../@acme/tokens"
  }
}
```

Instead of the verbose path:
```json
{
  "dependencies": {
    "@acme/components": "../design-system/packages/@acme/components"
  }
}
```

### Benefits

- **Monorepo-style imports** - `import { Button } from '@acme/components'`
- **Tool compatibility** - Works with pnpm workspaces, TypeScript paths
- **No nesting** - All repos remain flat peers at workspace root
- **Simpler paths** - `../@acme/components` instead of `../design-system/packages/@acme/components`
- **Per-package install** - Build individual packages after repo-level install
- **Easy promotion** - Promote a package to its own repo, or merge a repo back into another as a package, with minimal config changes

## Dependency Graph

When repos declare other repos as dependencies, dotdot:
- Builds a dependency graph across all configs
- Detects diamond dependencies (A→B, A→C, B→C, C→C)
- Reports revision conflicts when different configs pin different revisions
- Clones transitively required repos during `sync`
