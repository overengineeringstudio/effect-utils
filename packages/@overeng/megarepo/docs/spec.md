# Megarepo Specification

## Overview

Megarepo (`mr`) is a tool for composing multiple git repositories into a unified development environment. Each megarepo is itself a git repository that declares its member repos.

The system uses two files:

- **`megarepo.json`** - Declares **intent**: what repos and refs you want
- **`megarepo.lock`** - Records **resolved state**: exact commits checked out

## Core Concepts

### Megarepo

A git repository containing a `megarepo.json` file. The megarepo:

- Is the root of the composed environment
- Declares which repos are members
- Can be nested (megarepos can include other megarepos)
- Has its name derived from its git remote (or directory name if no remote)

### Member

A repository declared in `megarepo.json`. Members are:

- Symlinked from the global store into the megarepo (for remote sources)
- Materialized directly (for local path sources)
- Self-contained and work independently
- Not aware they're part of a megarepo

### Store

Global repository cache at `~/.megarepo/` (configurable via `MEGAREPO_STORE`).

The store uses **bare repos with worktrees per ref**:

```
~/.megarepo/
  github.com/
    owner/
      repo/
        .bare/                          # bare repository (shared git objects)
        HEAD -> refs/heads/main         # default branch tracking
        refs/
          heads/
            main/                       # worktree for 'main' branch
            feature%2Ffoo/              # worktree for 'feature/foo' (URL-encoded)
          tags/
            v1.0.0/                     # worktree for tag
          commits/
            abc123def456.../            # worktree for specific commit
```

**Path structure:** `refs/{type}/{encoded-ref}/`

The path reveals:

1. **Mutability** - `refs/heads/*` is mutable (branches), everything else is immutable
2. **Type** - `heads` (branch), `tags` (tag), `commits` (detached commit)
3. **Ref identity** - URL-encoded ref name

**Ref encoding:** Use percent-encoding (URL encoding) for ref names:

- `/` → `%2F`
- `%` → `%25`

| Git Ref        | Store Path                   |
| -------------- | ---------------------------- |
| `main`         | `refs/heads/main/`           |
| `feature/auth` | `refs/heads/feature%2Fauth/` |
| `v1.0.0`       | `refs/tags/v1.0.0/`          |
| `abc123...`    | `refs/commits/abc123.../`    |

---

## Source Types

### Remote Sources → Symlinked from Store

Remote sources (`owner/repo`, `https://...`) are:

- Cloned as bare repos to the store
- Checked out as worktrees per ref
- Symlinked into the megarepo

```
megarepo/
  effect -> ~/.megarepo/github.com/effect-ts/effect/refs/heads/main/
```

- Shared across all megarepos using the same repo+ref
- Changes affect all megarepos sharing that worktree
- Use different refs (branches) for independence

### Local Sources → Materialized Directly

Local paths (`./...`, `../...`) are:

- Cloned/copied directly into the megarepo
- NOT stored in `~/.megarepo/`
- NOT symlinked

```
megarepo/
  local-lib/                    # actual directory, not symlink
    .git/
    src/
```

- Each megarepo has its own independent copy
- Changes are local to this megarepo

---

## Environment Variables

| Variable           | Description                          | Default                   |
| ------------------ | ------------------------------------ | ------------------------- |
| `MEGAREPO_ROOT`    | Path to the megarepo root            | (auto-detected from $PWD) |
| `MEGAREPO_STORE`   | Global store location                | `~/.megarepo`             |
| `MEGAREPO_MEMBERS` | Comma-separated list of member names | (computed from config)    |

### `MEGAREPO_ROOT` Behavior

Commands auto-detect the megarepo root by searching up from `$PWD` for `megarepo.json`. The search walks all the way to the filesystem root and returns the **outermost** megarepo found (closest to `/`). If `MEGAREPO_ROOT` is set, it takes precedence over auto-detection.

**Nested Megarepos:** When megarepo A contains megarepo B as a member:

- If working inside the nested B, auto-detection finds A (outermost wins)
- If B is checked out standalone (not as member of another megarepo), auto-detection finds B

This "outer wins" rule ensures:

- Consistent environment across the entire development context
- No accidental scope changes when navigating into nested repos
- Clear hierarchy: you're always working in the context of one megarepo

**Edge Cases:**

- If `MEGAREPO_ROOT` is set but the directory no longer contains `megarepo.json`: commands should error
- If `MEGAREPO_ROOT` points to a path that is itself inside another megarepo: the explicit setting wins (explicit > automatic)
- Symlinked members: When entering a symlinked member, `MEGAREPO_ROOT` should still point to the outer megarepo

---

## Config File (`megarepo.json`)

The config declares intent using a unified string format:

```json
{
  "$schema": "https://raw.githubusercontent.com/.../megarepo.schema.json",
  "members": {
    "effect": "effect-ts/effect", // GitHub shorthand, default branch
    "effect-v3": "effect-ts/effect#v3.0.0", // specific tag
    "effect-next": "effect-ts/effect#next", // specific branch
    "gitlab-lib": "https://gitlab.com/org/repo", // non-GitHub URL
    "local-lib": "./packages/local" // local path
  },
  "generators": {
    "vscode": {
      "enabled": true
    }
  }
}
```

### Source String Parsing

| Pattern                      | Type   | Expansion                                        |
| ---------------------------- | ------ | ------------------------------------------------ |
| `owner/repo`                 | GitHub | `https://github.com/owner/repo` (default branch) |
| `owner/repo#ref`             | GitHub | `https://github.com/owner/repo` at `ref`         |
| `https://...`                | URL    | HTTPS URL                                        |
| `https://...#ref`            | URL    | HTTPS URL at `ref`                               |
| `git@host:path`              | URL    | SSH URL                                          |
| `git@host:path#ref`          | URL    | SSH URL at `ref`                                 |
| `./path`, `../path`, `/path` | Local  | Local filesystem path                            |

**Default branch:** When no `#ref` is specified, the remote's default branch is used (queried via `git ls-remote --symref`).

### Ref Classification

When a ref is specified via `#ref`:

1. **40-char hex string** → commit (immutable)
2. **Semver-like pattern** → tag (immutable)
   - Matches: `v1.0.0`, `v1.0`, `1.0.0`, `1.0`
   - Regex: `/^v?\d+\.\d+(\.\d+)?/`
3. **Otherwise** → branch (mutable)

**Note:** This heuristic may misclassify unusual branch/tag names. Future versions may support explicit `#tag:name` or `#branch:name` syntax.

### Config Schema

```typescript
interface MegarepoConfig {
  $schema?: string
  members: Record<string, string> // member name -> source string
  generators?: GeneratorsConfig
}

interface GeneratorsConfig {
  envrc?: {
    enabled?: boolean // default: true
  }
  vscode?: {
    enabled?: boolean // default: false
    exclude?: string[] // members to exclude from workspace
  }
  flake?: {
    enabled?: boolean // default: false
    skip?: string[] // members to skip in flake
  }
  devenv?: {
    enabled?: boolean // default: false
  }
}
```

---

## Lock File (`megarepo.lock`)

The lock file records resolved state and is committed to git for CI reproducibility:

```json
{
  "version": 1,
  "members": {
    "effect": {
      "url": "https://github.com/effect-ts/effect",
      "ref": "main",
      "commit": "abc123def456789...",
      "pinned": false,
      "lockedAt": "2024-01-15T10:30:00Z"
    },
    "effect-v3": {
      "url": "https://github.com/effect-ts/effect",
      "ref": "v3.0.0",
      "commit": "def456abc789...",
      "pinned": true,
      "lockedAt": "2024-01-10T08:00:00Z"
    }
  }
}
```

### Lock Entry Fields

| Field      | Description                                    |
| ---------- | ---------------------------------------------- |
| `url`      | Resolved URL (GitHub shorthand expanded)       |
| `ref`      | Original ref from config (for context)         |
| `commit`   | Resolved commit SHA (40 chars)                 |
| `pinned`   | If true, `mr update` won't refresh this member |
| `lockedAt` | Timestamp when this entry was resolved         |

**Note:** Local paths are NOT in the lock file - they're already local.

---

## Megarepo Name Derivation

The megarepo name is derived automatically (no `name` field in config):

1. **If git remote exists:** Extract from remote URL
   - `git@github.com:owner/repo.git` → `owner/repo`
   - `https://github.com/owner/repo` → `owner/repo`

2. **If no remote:** Use directory name
   - `/Users/dev/my-megarepo` → `my-megarepo`

---

## Symlinks

### Absolute Symlinks

Megarepo uses **absolute symlinks** for all member links:

```
my-megarepo/effect-utils -> /Users/dev/.megarepo/github.com/overeng/effect-utils/refs/heads/main
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

Ensures worktrees exist and symlinks are correct. Does NOT pull or re-resolve refs.

```bash
mr sync [--frozen] [--deep]
```

**Behavior:**

1. For each member in config:
   - If in lock → use locked commit
   - If NOT in lock → resolve ref from remote, add to lock
2. Ensure bare repo exists (clone if needed)
3. Ensure worktree exists at locked commit (create if needed)
4. Ensure symlink points to correct worktree
5. Run generators

**Key point:** `mr sync` uses the lock file as-is. It only resolves refs for NEW members not yet in the lock. To update existing members, use `mr update`.

**Options:**

- `--frozen` - CI mode: fail if lock is missing or stale
- `--deep` - Recursively sync nested megarepos

#### `mr sync --frozen`

Strict mode for CI:

- Lock file MUST exist
- Lock MUST cover all config members (no new members allowed)
- Uses locked commits exactly
- Fails if config has members not in lock

### Update Commands

#### `mr update [member]`

Re-resolves refs from remotes and updates the lock file. This is how you get newer commits.

```bash
mr update              # update all non-pinned members
mr update effect       # update specific member (even if pinned)
mr update --all        # update ALL members including pinned
```

**Behavior:**

1. For each member to update:
   - Fetch from remote
   - Resolve ref to latest commit
   - Update lock file entry
   - Update worktree to new commit
2. Skip pinned members (unless specifically named or `--all`)

**Example:** If `effect` tracks `main` and lock says `main=abc123`, running `mr update effect` will fetch, resolve main to `def456`, update lock, and checkout `def456`.

#### `mr pin <member> [--commit=SHA]`

Mark a member as pinned:

```bash
mr pin effect              # pin to current commit
mr pin effect --commit=abc # pin to specific commit
```

- Sets `pinned: true` in lock file
- Pinned members won't update with `mr update`

#### `mr unpin <member>`

Remove pin from a member:

```bash
mr unpin effect
```

- Sets `pinned: false` in lock file
- Next `mr update` will refresh to latest

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
# - Each member: sync state, git state, pinned status
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

#### `mr exec`

Execute command across members.

```bash
mr exec <command> [--mode parallel|sequential|topo]
mr exec "git status"
mr exec --mode parallel "bun install"
```

#### `mr root`

Finds and prints the megarepo root directory by searching up from current directory.

```bash
mr root
# /Users/dev/my-megarepo

mr root --json
# {"root": "/Users/dev/my-megarepo", "name": "owner/my-megarepo"}
```

### Store Commands

#### `mr store gc`

Garbage collect unused worktrees:

```bash
mr store gc [--dry-run] [--force]
```

**Behavior:**

1. Read current megarepo's lock file to find in-use worktrees
2. Walk the store to find all worktrees
3. Remove worktrees not referenced by the lock

**Options:**

- `--dry-run`: show what would be removed
- `--force`: remove even dirty worktrees

**Safety:** Skips worktrees with uncommitted changes or unpushed commits unless `--force`.

**Scope:** Only considers the current megarepo's lock file. Worktrees used by other megarepos may be removed. Run from each megarepo to preserve its worktrees, or manually verify before using `--force`.

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

## Workflows

### Development (tracking latest)

```bash
# Config: effect tracks main branch
mr sync                    # resolves main → abc123, creates lock
# ... time passes ...
mr update                  # re-resolves main → def456
```

### CI (reproducible builds)

```bash
# Lock file is committed to git
mr sync --frozen           # uses exactly what's in lock
```

### Stabilizing for release

```bash
mr pin effect              # marks effect as pinned
mr pin other-lib
git add megarepo.lock
git commit -m "Pin dependencies for release"

# Later updates skip pinned members
mr update                  # effect stays pinned, others update
```

### Investigating a regression

```bash
mr pin effect --commit=abc123   # pin to known-good commit
mr sync                          # checkout that commit
# ... test ...
mr unpin effect                  # remove pin
mr update effect                 # back to latest
```

---

## Directory Layout

After `mr sync`, a megarepo looks like:

```
my-megarepo/                    # Git repo (the megarepo itself)
├── .git/
├── megarepo.json
├── megarepo.lock               # Committed for CI reproducibility
├── .envrc.local                # Generated by envrc generator
├── effect -> ~/.megarepo/github.com/effect-ts/effect/refs/heads/main/
├── local-lib/                  # Local path: actual directory, not symlink
│   ├── .git/
│   └── ...
└── api-gateway -> ~/.megarepo/github.com/shareup/api-gateway/refs/tags/v2.0.0/
```

### Nested Megarepos

Members can themselves be megarepos with their own `megarepo.json`. When a member depends on another repo:

1. **The member declares its own dependencies** in its `megarepo.json`
2. **Running `mr sync` in the member** creates symlinks within that member
3. **Shared dependencies** point to the same store worktree

**Sync Behavior for Nested Megarepos:**

- **Default (shallow):** `mr sync` only syncs the current megarepo's direct members
- **Recursive:** `mr sync --deep` syncs nested megarepos recursively

```bash
mr sync          # Shallow - only direct members
mr sync --deep   # Recursive - includes nested megarepos
```

---

## Sync Behavior

### `mr sync` Strategy

1. **Check lock:** If member is in lock, use that commit
2. **Resolve new members:** If member is NOT in lock, resolve ref from remote and add to lock
3. **Ensure bare repo:** Clone as bare if not in store
4. **Ensure worktree:** Create worktree at locked commit if not exists
5. **Ensure symlink:** Create or fix symlink to worktree

`mr sync` does NOT fetch or pull. It materializes the state declared in the lock file.

### `mr update` Strategy

1. **Fetch:** Get latest refs from remote
2. **Resolve:** Find current commit for the ref
3. **Update lock:** Write new commit to lock file
4. **Update worktree:** Checkout new commit

### Symlink Strategy

- Symlinks are absolute paths
- Point from megarepo directory to store worktree
- Only for remote sources (local paths are materialized)

### Conflict Resolution

- **Remote member exists as directory (not symlink):** Error - user must remove or rename
- **Local member already exists:** Skip - don't overwrite existing local content
- **Symlink points to wrong location:** Update symlink silently

---

## Generators

### Generator Output Locations

| Generator | Output Path                                  |
| --------- | -------------------------------------------- |
| envrc     | `<megarepo>/.envrc.local`                    |
| VSCode    | `<megarepo>/.vscode/megarepo.code-workspace` |
| Nix Flake | `<megarepo>/flake.nix`                       |
| devenv    | `<megarepo>/devenv.nix`                      |

### envrc Generator

Generates environment variable configuration for direnv integration.

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

---

## Shell Integration

### With direnv (recommended)

The envrc generator creates `.envrc.local` which sets environment variables. Source it from your `.envrc`:

```bash
# .envrc
source_env_if_exists .envrc.local
use devenv
```

### Manual

```bash
eval "$(mr env)"
```

---

## Error Handling

### Worktree has local changes during sync

```
Error: Member 'effect' has uncommitted changes
  Path: ~/.megarepo/github.com/effect-ts/effect/refs/heads/main/

Options:
  - Commit or stash changes, then retry
  - Create a branch for your changes
  - Use --force to discard changes (DANGEROUS)
```

### Lock is stale (--frozen mode)

```
Error: Lock file is out of sync with config

  Added members: new-lib
  Removed members: old-lib
  Changed refs: effect (main -> next)

Run 'mr sync' to update lock file, then commit.
```

### Local path doesn't exist

```
Error: Local path does not exist: ./packages/missing

Check that the path is correct relative to the megarepo root.
```

---

## Invariants

1. **Remote worktrees only in store**: No remote worktree exists outside `~/.megarepo/`
2. **Local paths in megarepo**: Local sources are cloned directly, not symlinked
3. **Symlinks only for remotes**: Megarepos symlink to store for remote sources only
4. **Bare repo always exists**: If any worktree exists, `.bare/` exists
5. **Path reveals mutability**: `refs/heads/*` is mutable, all else immutable
6. **Lock file is source of truth**: Sync uses lock for commits, config for intent

---

## Non-Goals (v1)

- Package-level management (handled by repos themselves)
- Build orchestration (use mono or similar)
- Dependency resolution between members
- Migration from dotdot (users can manually convert)
