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

- Symlinked from the global store into `repos/` (for remote sources)
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
- Symlinked into the megarepo under `repos/`

```
megarepo/
  repos/
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
  repos/
    local-lib/                  # actual directory, not symlink
      .git/
      src/
```

- Each megarepo has its own independent copy
- Changes are local to this megarepo

---

## Environment Variables

### Core Environment Variables

These are set by `mr` itself and are available in all megarepos:

| Variable                  | Description                          | Default                   |
| ------------------------- | ------------------------------------ | ------------------------- |
| `MEGAREPO_ROOT_OUTERMOST` | Path to the outermost megarepo root  | (auto-detected from $PWD) |
| `MEGAREPO_ROOT_NEAREST`   | Path to the nearest megarepo root    | (auto-detected from $PWD) |
| `MEGAREPO_STORE`          | Global store location                | `~/.megarepo`             |
| `MEGAREPO_MEMBERS`        | Comma-separated list of member names | (computed from config)    |

### Generator-Added Environment Variables

Generators act like plugins. Their env vars are only set when the generator
is enabled and `mr generate` has been run.

#### Nix Generator

| Variable                 | Description                         | Default                |
| ------------------------ | ----------------------------------- | ---------------------- |
| `MEGAREPO_NIX_WORKSPACE` | Path to the generated Nix workspace | (computed from config) |

### Root discovery behavior

Commands auto-detect megarepo roots by searching up from `$PWD` for `megarepo.json`.
The search captures both:

- **Outermost root**: the highest `megarepo.json` in the directory tree (closest to `/`).
- **Nearest root**: the first `megarepo.json` found when walking upward from `$PWD`.

The `mr env` command and generators expose both values via
`MEGAREPO_ROOT_OUTERMOST` and `MEGAREPO_ROOT_NEAREST` for tooling to consume.

**Nested megarepos:** When megarepo A contains megarepo B as a member:

- If working inside nested B, the nearest root is B and the outermost root is A.
- If B is checked out standalone (not as a member), both roots resolve to B.

The outermost-root rule ensures:

- Consistent environment across the entire development context
- No accidental scope changes when navigating into nested repos
- Clear hierarchy: you're always working in the context of one megarepo

**Edge Cases:**

- If either root points to a path that no longer contains `megarepo.json`, consumers should treat it as invalid.
- Symlinked members: when entering a symlinked member, the outermost root should still point to the top-level megarepo.

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
  nix?: {
    enabled?: boolean // default: false
    workspaceDir?: string // default: .direnv/megarepo-nix/workspace
  }
  vscode?: {
    enabled?: boolean // default: false
    exclude?: string[] // members to exclude from workspace
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
my-megarepo/repos/effect-utils -> /Users/dev/.megarepo/github.com/overeng/effect-utils/refs/heads/main
```

**Rationale:**

- The `repos/` directory is gitignored so symlinks are never committed
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

Strict mode for CI that guarantees exact reproducibility:

- Lock file MUST exist
- Lock MUST cover all config members (no new members allowed)
- Uses locked commits exactly
- Fails if config has members not in lock
- **Uses commit-based worktree paths** (e.g., `refs/commits/<sha>/`) to guarantee the exact locked commit is checked out, regardless of what branch refs currently point to

This commit-based path approach ensures that even if the store's bare repo has been updated by another operation, frozen mode always materializes the exact commits from the lock file.

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
- Pinned members use commit-based worktree paths (like `--frozen`), guaranteeing they stay at the exact pinned commit

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
# export MEGAREPO_ROOT_OUTERMOST=/path/to/megarepo
# export MEGAREPO_ROOT_NEAREST=/path/to/megarepo
# export MEGAREPO_MEMBERS=effect-utils,livestore,...
# export MEGAREPO_NIX_WORKSPACE=/path/to/megarepo/.direnv/megarepo-nix/workspace
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
├── .envrc.generated.megarepo                # Generated by nix generator
└── repos/
    ├── effect -> ~/.megarepo/github.com/effect-ts/effect/refs/heads/main/
    ├── local-lib/              # Local path: actual directory, not symlink
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
- Point from `repos/` to the store worktree
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
| nix       | `<megarepo>/.envrc.generated.megarepo`       |
| nix       | `<megarepo>/.direnv/megarepo-nix/workspace`  |
| VSCode    | `<megarepo>/.vscode/megarepo.code-workspace` |

### nix Generator

Generates a local Nix workspace and `.envrc.generated.megarepo` for direnv integration.

**Output (`.envrc.generated.megarepo`):**

```bash
# Generated by megarepo - do not edit manually
# Regenerate with: mr generate nix

export MEGAREPO_ROOT_OUTERMOST="/Users/dev/my-megarepo"
export MEGAREPO_ROOT_NEAREST="/Users/dev/my-megarepo"
export MEGAREPO_MEMBERS="effect-utils,livestore,api-gateway"
export MEGAREPO_NIX_WORKSPACE="/Users/dev/my-megarepo/.direnv/megarepo-nix/workspace"
```

**Workspace flake usage:**

```bash
nix build "path:$MEGAREPO_NIX_WORKSPACE#packages.<system>.effect-utils.genie"
```

**Integration pattern:**

The megarepo's `.envrc` (committed to git) should source the generated file:

```bash
# .envrc
source_env_if_exists .envrc.generated.megarepo

# Rest of megarepo's devenv/nix setup
use devenv
```

---

## Shell Integration

### With direnv (recommended)

The nix generator creates `.envrc.generated.megarepo` which sets environment variables. Source it from your `.envrc`:

```bash
# .envrc
source_env_if_exists .envrc.generated.megarepo
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
