# Megarepo Specification

## Overview

Megarepo (`mr`) is a tool for composing multiple git repositories into a unified development environment. Each megarepo is itself a git repository that declares its member repos.

## Core Concepts

### Megarepo
A git repository containing a `megarepo.json` file. The megarepo:
- Is the root of the composed environment
- Declares which repos are members
- Can be nested (megarepos can include other megarepos)
- Has its name derived from its git remote (or directory name if no remote)

### Member
A repository declared in `megarepo.json`. Members are:
- Symlinked from the global store into the megarepo
- Self-contained and work independently
- Not aware they're part of a megarepo

### Store
Global repository cache at `~/.megarepo/` (configurable via `MEGAREPO_STORE`):
```
~/.megarepo/
├── github.com/
│   ├── owner/repo/          # bare repo or main worktree
│   └── another/repo/
└── local/
    └── repo-name/           # for repos without remote
```

### Isolation
When a member needs independent changes (different branch), it's "isolated":
- A git worktree is created inside the megarepo directory
- Replaces the symlink with an actual directory
- Allows divergent work without affecting the store

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MEGAREPO_ROOT` | Path to the megarepo root | (required, set externally) |
| `MEGAREPO_STORE` | Global store location | `~/.megarepo` |
| `MEGAREPO_MEMBERS` | Comma-separated list of member names | (computed from config) |

### `MEGAREPO_ROOT` Behavior

**Important:** `MEGAREPO_ROOT` is required for most commands. It must be set externally (via shell config or `mr env`).

**Nested Megarepos:** When megarepo A contains megarepo B as a member:
- If working inside the nested B, `MEGAREPO_ROOT` remains A (outer wins)
- If B is checked out standalone (not as member of another megarepo), `MEGAREPO_ROOT` is B

This "outer wins" rule ensures:
- Consistent environment across the entire development context
- No accidental scope changes when navigating into nested repos
- Clear hierarchy: you're always working in the context of one megarepo

**Edge Cases:**
- If `MEGAREPO_ROOT` is set but the directory no longer contains `megarepo.json`: commands should error
- If `MEGAREPO_ROOT` points to a path that is itself inside another megarepo: the explicit setting wins (explicit > automatic)
- Symlinked members: When entering a symlinked member, `MEGAREPO_ROOT` should still point to the outer megarepo

---

## Config Schema (`megarepo.json`)

```typescript
interface MegarepoConfig {
  // Optional schema reference
  "$schema"?: string

  // Members: repos to include in this megarepo
  members: Record<string, MemberConfig>

  // Generators: optional config file generation
  generators?: GeneratorsConfig
}

interface MemberConfig {
  // GitHub shorthand: "owner/repo"
  github?: string

  // Full git URL (for non-GitHub remotes)
  url?: string

  // Local file path (for local repos without remote)
  path?: string

  // Pin to specific ref (tag, branch, commit)
  pin?: string

  // Isolate: create worktree at this branch instead of symlink
  isolated?: string
}

interface GeneratorsConfig {
  envrc?: {
    enabled?: boolean   // default: true
  }
  vscode?: {
    enabled?: boolean   // default: false
    exclude?: string[]  // members to exclude from workspace
  }
  flake?: {
    enabled?: boolean   // default: false
    skip?: string[]     // members to skip in flake
  }
  devenv?: {
    enabled?: boolean   // default: false
    // TBD
  }
}
```

**Member source priority:** `github` > `url` > `path` (only one should be specified)

### Example

```json
{
  "$schema": "https://raw.githubusercontent.com/.../megarepo.schema.json",
  "members": {
    "effect-utils": {
      "github": "overengineeringstudio/effect-utils"
    },
    "livestore": {
      "github": "shareup/livestore",
      "isolated": "feature-notifications"
    },
    "api-gateway": {
      "github": "shareup/api-gateway",
      "pin": "v2.3.1"
    },
    "internal-tool": {
      "url": "git@gitlab.company.com:team/internal-tool.git"
    },
    "local-experiments": {
      "path": "/Users/dev/experiments/local-project"
    }
  },
  "generators": {
    "vscode": {
      "exclude": ["docs"]
    }
  }
}
```

---

## Megarepo Name Derivation

The megarepo name is derived automatically (no `name` field in config):

1. **If git remote exists:** Extract from remote URL
   - `git@github.com:owner/repo.git` → `owner/repo`
   - `https://github.com/owner/repo` → `owner/repo`

2. **If no remote:** Use directory name
   - `/Users/dev/my-workspace` → `my-workspace`

---

## Symlinks

### Absolute Symlinks
Megarepo uses **absolute symlinks** for all member links:

```
my-megarepo/effect-utils -> /Users/dev/.megarepo/github.com/overeng/effect-utils
```

**Rationale:**
- Symlinks are never committed to git (gitignored)
- Each machine has its own store location anyway
- Absolute paths are simpler and avoid path resolution complexity
- No issues with moving the megarepo directory

---

## Commands

### Core Commands

#### `mr sync`
Main command that:
1. Ensures all members are cloned to store
2. Creates symlinks (or worktrees for isolated members)
3. Runs generators

```bash
mr sync [--dry-run] [--deep]
```

Options:
- `--deep` - Recursively sync nested megarepos

### Convenience Commands

#### `mr init`
Initialize a new megarepo in current directory.

```bash
mr init
# Creates megarepo.json with empty members
# Fails if not a git repo
```

#### `mr status`
Show megarepo state.

```bash
mr status
# Shows:
# - Megarepo name (derived)
# - Each member: sync state, git state, isolated status
```

#### `mr env`
Print environment variables for shell integration.

```bash
mr env [--shell bash|zsh|fish]
# Outputs:
# export MEGAREPO_ROOT=/path/to/megarepo
# export MEGAREPO_MEMBERS=effect-utils,livestore,...
```

#### `mr ls`
List members.

```bash
mr ls [--format json|table]
```

#### `mr update`
Pull all members from remotes.

```bash
mr update [--update-pins]  # --update-pins updates pinned refs in config
```

#### `mr exec`
Execute command across members.

```bash
mr exec <command> [--mode parallel|sequential|topo]
mr exec "git status"
mr exec --mode parallel "bun install"
```

#### `mr isolate <member> <branch>`
Convert symlink to worktree for independent work.

```bash
mr isolate livestore feature-notifications
# Creates worktree at ./livestore on branch feature-notifications
# Updates config: isolated: "feature-notifications"
```

#### `mr unisolate <member>`
Convert worktree back to symlink.

```bash
mr unisolate livestore
# Removes worktree, restores symlink
# Removes isolated field from config
```

### Store Commands

#### `mr store ls`
List repos in global store.

#### `mr store add <repo>`
Add repo to store without adding to megarepo.

```bash
mr store add github.com/owner/repo
```

#### `mr store fetch`
Fetch all repos in store.

### Common Options

All commands support:
- `--json` - Output JSON instead of formatted text (for scripting/tooling)
- `--dry-run` - Show what would be done
- `--verbose` / `-v` - Verbose output

---

## `mr root` Command

Finds and prints the megarepo root directory by searching up from current directory.

```bash
mr root
# /Users/dev/my-megarepo

mr root --json
# {"root": "/Users/dev/my-megarepo", "name": "owner/my-megarepo"}
```

**Use cases:**
- Scripts that need megarepo context outside direnv
- Shell integration for users not using direnv
- Debugging / verification

**Behavior:**
- Searches up from `$PWD` for `megarepo.json`
- If `MEGAREPO_ROOT` is set and valid, returns that (respects explicit setting)
- Exits with error if no megarepo found

---

## Directory Layout

After `mr sync`, a megarepo looks like:

```
my-megarepo/                    # Git repo (the megarepo itself)
├── .git/
├── megarepo.json
├── .envrc.local                # Generated by envrc generator
├── effect-utils -> /Users/dev/.megarepo/github.com/overeng/effect-utils
├── livestore/                  # Isolated: actual worktree, not symlink
│   ├── .git                    # Worktree git file
│   ├── megarepo.json           # livestore is also a megarepo
│   ├── effect-utils -> /Users/dev/.megarepo/github.com/overeng/effect-utils
│   └── ...                     # livestore depends on effect-utils too
└── api-gateway -> /Users/dev/.megarepo/github.com/shareup/api-gateway
```

### Nested Megarepos

Members can themselves be megarepos with their own `megarepo.json`. When a member depends on another repo:

1. **The member declares its own dependencies** in its `megarepo.json`
2. **Running `mr sync` in the member** creates symlinks within that member
3. **Shared dependencies** (like `effect-utils` above) point to the same store location

**Example:** If `livestore` has its own `megarepo.json`:
```json
{
  "members": {
    "effect-utils": { "github": "overengineeringstudio/effect-utils" }
  }
}
```

Both `my-megarepo/effect-utils` and `my-megarepo/livestore/effect-utils` symlink to the same store path, ensuring consistency.

### Sync Behavior for Nested Megarepos

**Default (shallow):** `mr sync` only syncs the current megarepo's direct members.

**Recursive:** `mr sync --deep` syncs nested megarepos recursively.

```bash
mr sync          # Shallow - only direct members
mr sync --deep   # Recursive - includes nested megarepos
```

**Actionable feedback:** When running shallow sync, if any members are themselves megarepos that need syncing, show a hint:

```
✓ Synced 3 members

Note: 2 members contain nested megarepos (livestore, api-gateway)
      Run `mr sync --deep` to sync them, or `cd <member> && mr sync`
```

This keeps the default fast while making the recursive option discoverable.

---

## Sync Behavior

### Clone Strategy
1. Check if repo exists in store
2. If not, clone to store
3. For pinned refs: checkout specific ref
4. For isolated: create worktree in megarepo directory

### Symlink Strategy
- Symlinks are absolute paths
- Point from megarepo directory to store

### Conflict Resolution
- If member directory exists but isn't a symlink: error (user must resolve)
- If symlink points to wrong location: update symlink

---

## Shell Integration

Recommended shell config (e.g., in `.zshrc`):

```bash
# Manual approach - run when entering megarepo
alias mr-enter='eval "$(mr env)"'

# Or auto-detect on directory change (if mr root is implemented)
_mr_chpwd() {
  if [[ -f "$PWD/megarepo.json" ]]; then
    eval "$(mr env --shell zsh 2>/dev/null)"
  fi
}
chpwd_functions+=(_mr_chpwd)
```

---

## Generators

### Generator Output Locations

| Generator | Output Path |
|-----------|-------------|
| envrc | `<megarepo>/.envrc.local` |
| VSCode | `<megarepo>/.vscode/megarepo.code-workspace` |
| Nix Flake | `<megarepo>/flake.nix` |
| devenv | `<megarepo>/devenv.nix` |

### envrc Generator

Generates environment variable configuration for direnv integration.

**Config:**
```json
{
  "generators": {
    "envrc": {
      "enabled": true
    }
  }
}
```

**Output (`.envrc.local`):**
```bash
# Generated by megarepo - do not edit manually
# Regenerate with: mr sync

export MEGAREPO_ROOT="/Users/dev/my-megarepo"
export MEGAREPO_MEMBERS="effect-utils,livestore,api-gateway"
```

**Integration pattern:**

The megarepo's `.envrc` (committed to git) should source the generated file:
```bash
# .envrc
source_env_if_exists .envrc.local

# Rest of megarepo's devenv/nix setup
use devenv
```

**Member repos** that want megarepo awareness can add to their `.envrc`:
```bash
# At top of member's .envrc
source_up_if_exists  # Inherits MEGAREPO_ROOT from parent if present

# Member's own setup
use devenv
```

This pattern ensures:
- `.envrc.local` is gitignored (machine-specific paths)
- Outer megarepo context is preserved when entering members
- Members work standalone when not inside a megarepo

---

## Non-Goals (v1)

- Package-level management (handled by repos themselves)
- Build orchestration (use mono or similar)
- Dependency resolution between members
- Lock files for member versions
- Migration from dotdot (users can manually convert)
