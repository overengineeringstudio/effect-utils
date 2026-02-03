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

**Key implication:** Each ref has its own isolated worktree. Switching between refs (via `mr pin -c`) updates the symlink to point to a different worktree—it does NOT modify files in place like `git checkout`. This means uncommitted changes in one worktree are preserved when you switch to another ref.

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

| Variable                 | Description                         | Default              |
| ------------------------ | ----------------------------------- | -------------------- |
| `MEGAREPO_NIX_WORKSPACE` | Path to the generated Nix workspace | (computed from root) |

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

When a ref is specified via `#ref`, megarepo determines the ref type using a two-phase approach:

**Phase 1: Query the repository** (most accurate)

After cloning/fetching, megarepo queries the local bare repo to determine the actual ref type:

- Checks `refs/tags/{ref}` for tags
- Checks `refs/remotes/origin/{ref}` for branches

This ensures tags like `jq-1.6`, `release-v1.0`, etc. are correctly classified.

**Phase 2: Heuristic fallback** (when query unavailable)

If the ref type cannot be determined from the repository:

1. **40-char hex string** → commit (immutable)
2. **Semver-like pattern** → tag (immutable)
   - Strict: `v1.0.0`, `v1.0`, `1.0.0`, `1.0`
   - Prefixed: `prefix-1.0`, `prefix-v1.0.0` (e.g., `jq-1.6`, `release-v2.0`)
3. **Otherwise** → branch (mutable)

**Note:** The heuristic may still misclassify unusual branch/tag names. Future versions may support explicit `#tag:name` or `#branch:name` syntax for disambiguation.

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
    lockSync?: {
      enabled?: boolean // default: true (when nix generator is enabled)
      exclude?: string[] // members to exclude from lock sync
    }
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

| Field      | Description                                         |
| ---------- | --------------------------------------------------- |
| `url`      | Resolved URL (GitHub shorthand expanded)            |
| `ref`      | Current ref (branch, tag, or commit SHA)            |
| `commit`   | Resolved commit SHA (40 chars)                      |
| `pinned`   | If true, `mr sync --pull` won't refresh this member |
| `lockedAt` | Timestamp when this entry was resolved              |

**Note:** Local paths are NOT in the lock file - they're already local.

**Pinned vs Ref Type:**

The `pinned` flag and ref type serve different purposes:

- **Ref type** determines what the member tracks (branch = mutable, tag/commit = immutable)
- **Pinned flag** determines whether `sync --pull` should update the member

A pinned branch stays at its current commit even though branches are normally mutable.
An unpinned tag stays at the tagged commit because tags are inherently immutable.

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

### CLI Design Principles

- **Consistent member targeting**: Use `--member <name>` (or `-m <name>`) across all commands that operate on specific members
- **Explicit over implicit**: Named options preferred over positional arguments for clarity
- **Copy-paste ready hints**: Error messages and hints include concrete values, not placeholders

### Core Commands

#### `mr sync`

Bidirectional sync between worktrees and lock file. The default mode ensures members exist and updates the lock file to match current worktree HEADs.

```bash
mr sync [--pull] [--frozen] [--force] [--deep] [--only <members...>] [--skip <members...>] [--git-protocol <ssh|https|auto>] [--create-branches]
```

**Modes:**

| Mode    | Command            | Behavior                                                                |
| ------- | ------------------ | ----------------------------------------------------------------------- |
| Default | `mr sync`          | Ensure members exist, update lock to current worktree commits           |
| Pull    | `mr sync --pull`   | Fetch from remote, update worktrees to latest                           |
| Frozen  | `mr sync --frozen` | Clone if needed, apply lock → worktrees exactly, never modify lock (CI) |

**Member Filtering:**

| Option             | Behavior                                                     |
| ------------------ | ------------------------------------------------------------ |
| `--only <members>` | Only sync the specified members (comma-separated)            |
| `--skip <members>` | Sync all members except the specified ones (comma-separated) |

These options are mutually exclusive. When filtering is applied:

- Only the specified members are synced
- Generators skip members that weren't synced (graceful handling of missing paths)
- Lock file operations only affect synced members

**Default Mode Behavior:**

1. For each member in config:
   - If member exists → read current HEAD, update lock if different
   - If member NOT exists → clone/create worktree, add to lock
2. Does NOT fetch from remote
3. Updates lock file to reflect current worktree state

This mode is ideal for local iteration: make commits in worktrees, then `mr sync` to capture the current state in the lock file.

**Symlink drift detection:** In default mode, `mr sync` detects when there's a mismatch between:

- The ref in the lock file (e.g., `refactor/feature-branch`)
- The ref the source string resolves to (e.g., `dev` when no `#ref` is specified)

When drift is detected, the member is skipped with a helpful message:

```
symlink drift: lock says 'refactor/feature-branch' but source resolves to 'dev'
  hint: run 'mr sync --pull' to update to lock ref, or update megarepo.json to include #refactor/feature-branch
```

This prevents silent "already synced" messages when the lock and config are out of sync.

**Options:**

- `--pull` - Fetch from remote and update to latest commits (like old `mr update`)
- `--frozen` - CI mode: fail if lock is missing or stale, apply lock exactly
- `--force` / `-f` - Override dirty worktree check, update pinned members
- `--deep` - Recursively sync nested megarepos
- `--only <members>` - Only sync specified members (comma-separated, mutually exclusive with `--skip`)
- `--skip <members>` - Skip specified members (comma-separated, mutually exclusive with `--only`)
- `--git-protocol <ssh|https|auto>` - Git protocol for cloning (see below)
- `--create-branches` - Create branches that don't exist (from default branch)

#### Git Protocol Selection

The `--git-protocol` option controls which URL format is used when cloning repositories:

| Value   | Behavior                                                    |
| ------- | ----------------------------------------------------------- |
| `ssh`   | Always use SSH URLs (`git@github.com:owner/repo.git`)       |
| `https` | Always use HTTPS URLs (`https://github.com/owner/repo.git`) |
| `auto`  | Use lock file URL if available, otherwise SSH (default)     |

**CI Usage:** In CI environments without SSH keys configured, use `--git-protocol=https` to clone public repositories via HTTPS:

```bash
mr sync --frozen --git-protocol=https
```

**Note:** The `auto` mode prefers the URL stored in `megarepo.lock` (which is typically HTTPS), making it work well in most CI scenarios where the lock file exists.

#### `mr sync --pull`

Fetches from remotes and updates worktrees to latest commits:

1. Fetch from remote for each member
2. Resolve ref to latest commit
3. Update worktree to new commit
4. Update lock file entry

**Dirty worktree protection:** Fails if worktree has uncommitted changes or unpushed commits (use `--force` to override).

**Pinned members:** Skipped unless `--force` is used.

#### `mr sync --frozen`

Strict mode for CI that guarantees exact reproducibility:

- Lock file MUST exist
- Lock MUST cover all config members (no new members allowed)
- Uses locked commits exactly
- Fails if config has members not in lock
- **Clones and fetches if needed** - frozen mode will clone bare repos and fetch updates to materialize the locked state; it only prevents _updating_ the lock file
- **Uses commit-based worktree paths** (e.g., `refs/commits/<sha>/`) to guarantee the exact locked commit is checked out, regardless of what branch refs currently point to
- **Never modifies lock file** - the lock is read-only, all state comes from the committed lock

This commit-based path approach ensures that even if the store's bare repo has been updated by another operation, frozen mode always materializes the exact commits from the lock file.

**CI usage:** In a fresh CI environment, `mr sync --frozen` will clone repos and fetch as needed to materialize the exact commits specified in the lock file, then run generators. This provides reproducible builds without requiring a pre-populated store. The lock file is never modified.

#### `mr pin --member <member> [-c <ref>]`

Point a member to a specific ref and mark it as pinned:

```bash
mr pin -m effect                 # pin to current commit
mr pin -m effect -c main         # pin to main branch
mr pin -m effect -c v3.0.0       # pin to tag
mr pin -m effect -c abc123def    # pin to specific commit
```

**Behavior:**

1. Updates `megarepo.json` to use the specified ref (if `-c` provided)
2. Creates a new worktree for that ref (if it doesn't exist)
3. Updates the symlink in `repos/` to point to the new worktree
4. Sets `pinned: true` in lock file
5. Pinned members won't update with `mr sync --pull`

**Worktree preservation:** Unlike `git checkout`, switching refs does NOT modify the current worktree. Each ref has its own worktree in the store. The previous worktree remains untouched with any uncommitted changes preserved. This enables safe context-switching between branches without stashing or committing work-in-progress.

**Ref types and immutability:**

The ref type determines mutability, not the `pin` command itself:

| Ref Type | Example                 | Mutability | Behavior on `sync --pull` (if unpinned) |
| -------- | ----------------------- | ---------- | --------------------------------------- |
| Branch   | `main`, `feature/foo`   | Mutable    | Updates to latest commit                |
| Tag      | `v3.0.0`, `release-1.0` | Immutable  | Stays at tagged commit                  |
| Commit   | `abc123def...`          | Immutable  | Stays at exact commit                   |

When pinned, the member stays at its current commit regardless of ref type.

#### `mr unpin --member <member>`

Remove pin from a member:

```bash
mr unpin -m effect
```

- Sets `pinned: false` in lock file
- Next `mr sync --pull` will refresh to latest (for branch refs)
- Tags and commits remain at their fixed points even when unpinned

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
# - Symlink drift warnings (when symlink points to wrong worktree)
```

**Symlink drift detection:** Warns when a member's symlink points to a different worktree than expected by the lock file. This can happen when:

- The lock file was updated (e.g., by a teammate) but `mr sync` wasn't run
- The source string in `megarepo.json` was changed without syncing

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

#### `mr store status`

Show detailed store health and detect issues:

```bash
mr store status [--json]
# Shows:
# - Store location and disk usage
# - Number of repos and worktrees
# - Invalid or problematic worktrees
```

**Detected Issues:**

| Issue             | Description                                    | Severity |
| ----------------- | ---------------------------------------------- | -------- |
| `dirty`           | Worktree has uncommitted changes               | warning  |
| `unpushed`        | Worktree has commits not pushed to remote      | warning  |
| `ref_mismatch`    | Checked-out branch doesn't match worktree path | error    |
| `missing_bare`    | Worktree exists but `.bare/` repo is missing   | error    |
| `broken_worktree` | Worktree directory is corrupted or incomplete  | error    |
| `orphaned`        | Not referenced by current megarepo's lock      | info     |

**Example output:**

```
Store: ~/.megarepo (2.3 GB)
  12 repos, 47 worktrees

Issues:
  ✗ github.com/effect-ts/effect/refs/heads/main
    ref_mismatch: path says 'main' but HEAD is 'feature/experiment'

  ⚠ github.com/livestorejs/livestore/refs/heads/dev
    dirty: 3 uncommitted changes

  ⚠ github.com/org/repo/refs/heads/old-branch
    orphaned: not in current megarepo.lock
```

**Ref mismatch detection:** Similar to symlink drift in `mr status`, this detects when a worktree's actual git HEAD doesn't match what the store path implies. This can happen if someone ran `git checkout` directly inside a worktree instead of using `mr pin`.

**Use with GC:**

```bash
mr store status              # identify issues
mr store gc --dry-run        # see what would be cleaned
mr store gc                  # clean orphaned worktrees
```

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

### Local Development (iterating on commits)

```bash
# Initial setup
mr sync                    # clone members, create lock

# Make changes in worktrees
cd repos/effect && git commit -m "fix bug"
cd repos/other-lib && git commit -m "add feature"

# Capture current state in lock file
mr sync                    # updates lock to current worktree HEADs
git add megarepo.lock
git commit -m "Update dependencies"
```

### Development (tracking latest from remote)

```bash
# Config: effect tracks main branch
mr sync                    # ensure members exist
# ... time passes ...
mr sync --pull             # fetch and update to latest commits
```

### CI (reproducible builds)

```bash
# Lock file is committed to git
mr sync --frozen           # uses exactly what's in lock

# Skip members that can't be cloned (e.g., private repos without auth)
mr sync --frozen --skip private-repo

# Use HTTPS for public repos when SSH keys aren't available
mr sync --frozen --git-protocol=https
```

### Stabilizing for release

```bash
mr pin -m effect              # marks effect as pinned
mr pin -m other-lib
git add megarepo.lock
git commit -m "Pin dependencies for release"

# Later updates skip pinned members
mr sync --pull             # effect stays pinned, others update
```

### Switching branches

```bash
# Switch to a feature branch (preserves main worktree with any uncommitted changes)
mr pin -m effect -c feature/new-api

# Work on the feature branch...
cd repos/effect && git commit -m "implement feature"

# Switch back to main (feature branch worktree preserved)
mr pin -m effect -c main

# Allow updates again
mr unpin -m effect
mr sync --pull                   # update to latest main
```

### Investigating a regression

```bash
mr pin -m effect -c abc123          # pin to known-good commit
# ... test ...
mr pin -m effect -c main            # back to main branch
mr unpin -m effect                  # allow updates
mr sync --pull                      # update to latest
```

### Creating a new feature branch

There are two ways to create a new branch that doesn't exist yet:

**Using `--create-branches` flag:**

```bash
# In megarepo.json: "dotfiles": "schickling/dotfiles#new-feature"
mr sync --create-branches        # creates missing branches from default branch
```

**Interactive mode (TTY only):**

If you specify a branch that doesn't exist and you're running in an interactive terminal, `mr sync` will prompt:

```bash
# In megarepo.json: "dotfiles": "schickling/dotfiles#new-feature"
mr sync

# Output:
# Branch 'new-feature' doesn't exist in schickling/dotfiles.
#   [c] Create from default branch (main)
#   [s] Skip this member
#   [a] Abort sync
# Choice: c
# ✓ Created branch 'new-feature' from 'main'
# ✓ dotfiles synced (new-feature)
```

In non-interactive mode without `--create-branches`, missing refs result in an error.

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

### `mr sync` (Default Mode) Strategy

1. **For existing members:** Read current worktree HEAD, update lock if different
2. **For new members:** Clone bare repo, create worktree, add to lock
3. **For removed members:** Remove symlink from `repos/`, remove entry from lock file
4. **Ensure symlink:** Create or fix symlink to worktree

Default mode does NOT fetch from remote. It reads current worktree state and updates the lock file to match.

**Removed member detection:** After syncing configured members, the sync command scans the `repos/` directory for orphaned symlinks (entries not in the current config). These are automatically removed to keep the workspace clean. The corresponding lock file entries are also removed. Note: The underlying worktrees in the store are NOT removed - use `mr store gc` to clean up unused worktrees.

### `mr sync --pull` Strategy

1. **Fetch:** Get latest refs from remote
2. **Check dirty:** Fail if worktree has uncommitted changes (unless `--force`)
3. **Resolve:** Find current commit for the ref
4. **Update worktree:** Checkout new commit
5. **Update lock:** Write new commit to lock file

### `mr sync --frozen` Strategy

1. **Validate lock:** Fail if lock missing or stale
2. **Use locked commits:** Checkout exact commits from lock
3. **Never modify lock:** Lock file is read-only
4. **Regenerate outputs:** Always run all configured generators after syncing (skipped for `--dry-run`)

### Symlink Strategy

- Symlinks are absolute paths
- Point from `repos/` to the store worktree
- Only for remote sources (local paths are materialized)

### Conflict Resolution

- **Remote member exists as directory (not symlink):** Error - user must remove or rename
- **Local member already exists:** Skip - don't overwrite existing local content
- **Symlink points to wrong location:** Update symlink silently
- **Orphaned symlink (member removed from config):** Remove symlink automatically

---

## Generators

### Generator Best Practices

#### Idempotent File Generation

Generators must produce stable output to avoid unnecessary file system churn and tool re-evaluations (e.g., direnv reloads). The key principle: **only write files when functional content changes**.

**Content Hash Approach:**

Generated files include a content hash in the header that represents the functional content (everything except metadata like timestamps):

```bash
# Generated by megarepo - do not edit manually
# Regenerate with: mr generate nix
# Generated at: 2026-02-03 12:00:00 +01:00
# MR version: 0.1.0
# Content hash: abc12345

<functional content here>
```

**How it works:**

1. Generator produces functional content (the actual shell script, config, etc.)
2. Compute hash of functional content
3. Read existing file, extract hash from header (if present)
4. If hashes match → skip write (content unchanged)
5. If hashes differ → write new file with updated timestamp and hash

**Benefits:**

- Timestamps update only when content actually changes
- File modification time reflects real changes, not regeneration runs
- Tools watching for file changes (direnv, file watchers) aren't triggered spuriously
- Supports R12 requirement: shell environments remain stable when nothing meaningful changed

### Generator Output Locations

| Generator | Output Path                                  |
| --------- | -------------------------------------------- |
| nix       | `<megarepo>/.envrc.generated.megarepo`       |
| nix       | `<megarepo>/.direnv/megarepo-nix/workspace`  |
| VSCode    | `<megarepo>/.vscode/megarepo.code-workspace` |

### nix Generator

Generates a local Nix workspace and `.envrc.generated.megarepo` for direnv integration.

`mr sync` always runs all configured generators after syncing members (unless `--dry-run`).

**Output (`.envrc.generated.megarepo`):**

```bash
# Generated by megarepo - do not edit manually
# Generated at: 2026-01-23 16:29:32 +01:00
# Generator: mr 0.1.0
# Regenerate with: mr generate nix

find_megarepo_root_nearest() {
  local current="$1"
  local last=""
  while [ -n "$current" ] && [ "$current" != "/" ] && [ "$current" != "$last" ]; do
    if [ -f "$current/megarepo.json" ]; then
      echo "$current"
      return 0
    fi
    last="$current"
    current="$(dirname "$current")"
  done
  return 1
}

find_megarepo_root_outermost() {
  local current="$1"
  local last=""
  local candidate=""
  while [ -n "$current" ] && [ "$current" != "/" ] && [ "$current" != "$last" ]; do
    if [ -f "$current/megarepo.json" ]; then
      candidate="$current"
    fi
    last="$current"
    current="$(dirname "$current")"
  done
  if [ -n "$candidate" ]; then
    echo "$candidate"
    return 0
  fi
  return 1
}

MEGAREPO_ROOT_NEAREST="$(find_megarepo_root_nearest "$(pwd)")" || {
  echo "megarepo: megarepo.json not found in parent dirs of $(pwd)" >&2
  return 1 2>/dev/null || exit 1
}
MEGAREPO_ROOT_OUTERMOST="$(find_megarepo_root_outermost "$MEGAREPO_ROOT_NEAREST")" || {
  echo "megarepo: megarepo.json not found above $MEGAREPO_ROOT_NEAREST" >&2
  return 1 2>/dev/null || exit 1
}
MEGAREPO_ROOT_NEAREST="${MEGAREPO_ROOT_NEAREST%/}/"
MEGAREPO_ROOT_OUTERMOST="${MEGAREPO_ROOT_OUTERMOST%/}/"

export MEGAREPO_ROOT_OUTERMOST
export MEGAREPO_ROOT_NEAREST
export MEGAREPO_MEMBERS="effect-utils,livestore,api-gateway"
export MEGAREPO_NIX_WORKSPACE="${MEGAREPO_ROOT_NEAREST}.direnv/megarepo-nix/workspace"
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

`mr generate nix` only writes `.envrc.generated.megarepo`. `.envrc.local` is reserved for user customization and is never modified by generators.

### Nix Lock Sync

When the nix generator is enabled, megarepo automatically synchronizes `flake.lock` and `devenv.lock` files in member repos to keep them in sync with `megarepo.lock`.

**The Problem:**

When repo A (a megarepo member) depends on repo B (also a megarepo member) via Nix flake inputs, you get duplicate version tracking:

1. `megarepo.lock` tracks commit for repo B
2. `repos/A/flake.lock` or `repos/A/devenv.lock` also tracks commit for repo B

These can drift, causing CI reproducibility issues and confusion.

**The Solution:**

During `mr sync`, after `megarepo.lock` is updated, megarepo scans each member repo for `flake.lock` and `devenv.lock` files. For any input that matches another megarepo member (by URL), it updates the `rev` to match `megarepo.lock`.

**How it works:**

1. Matches flake inputs to megarepo members by comparing URLs (GitHub owner/repo or git URL)
2. If a match is found and the `rev` differs, updates to the commit from `megarepo.lock`
3. Removes `narHash` and `lastModified` fields (Nix recalculates these on demand)

**Configuration:**

Lock sync is **enabled by default** when the nix generator is enabled. To opt out:

```json
{
  "generators": {
    "nix": {
      "enabled": true,
      "lockSync": {
        "enabled": false
      }
    }
  }
}
```

To exclude specific members from lock sync:

```json
{
  "generators": {
    "nix": {
      "enabled": true,
      "lockSync": {
        "exclude": ["member-to-skip"]
      }
    }
  }
}
```

**Example:**

Given `megarepo.lock`:

```json
{
  "members": {
    "effect-utils": {
      "url": "https://github.com/overeng/effect-utils",
      "commit": "abc123..."
    }
  }
}
```

And `repos/my-app/flake.lock` with an input referencing effect-utils at a different commit:

```json
{
  "nodes": {
    "effect-utils": {
      "locked": {
        "owner": "overeng",
        "repo": "effect-utils",
        "rev": "old-commit...",
        "type": "github"
      }
    }
  }
}
```

After `mr sync`, the flake.lock will be updated to:

```json
{
  "nodes": {
    "effect-utils": {
      "locked": {
        "owner": "overeng",
        "repo": "effect-utils",
        "rev": "abc123...",
        "type": "github"
      }
    }
  }
}
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

### Symlink drift detected

```
Skipped: effect (symlink drift: lock says 'refactor/feature' but source resolves to 'dev')
  hint: run 'mr sync --pull' to update to lock ref, or update megarepo.json to include #refactor/feature
```

This occurs when:

- The lock file specifies one ref (e.g., from a previous sync or teammate's commit)
- But the source string in `megarepo.json` resolves to a different ref

**Resolution options:**

- Run `mr sync --pull` to fetch and update to the lock file's ref
- Update `megarepo.json` to explicitly specify the ref: `"effect": "effect-ts/effect#refactor/feature"`
- If the lock is outdated, update it by checking out the desired ref and running `mr sync`

### Store worktree ref mismatch

```
✗ github.com/effect-ts/effect/refs/heads/main
  ref_mismatch: path says 'main' but HEAD is 'feature/experiment'
```

This occurs when someone uses `git checkout` directly inside a store worktree. The store path implies one ref, but git is on a different branch.

**Resolution:**

- If the checkout was intentional: use `mr pin -m <member> -c <new-ref>` to create the proper worktree
- If accidental: `cd` into the worktree and `git checkout <expected-ref>`
- To prevent: always use `mr pin` to switch refs, not `git checkout`

---

## Invariants

1. **Remote worktrees only in store**: No remote worktree exists outside `~/.megarepo/`
2. **Local paths in megarepo**: Local sources are cloned directly, not symlinked
3. **Symlinks only for remotes**: Megarepos symlink to store for remote sources only
4. **Bare repo always exists**: If any worktree exists, `.bare/` exists
5. **Path reveals mutability**: `refs/heads/*` is mutable, all else immutable
6. **Lock file is source of truth**: Sync uses lock for commits, config for intent
7. **No silent drift**: Sync never reports "already synced" when lock and symlink refs differ
8. **Worktree path matches HEAD**: The ref encoded in a worktree's store path should match its git HEAD

---

## Non-Goals (v1)

- Package-level management (handled by repos themselves)
- Build orchestration (use mono or similar)
- Dependency resolution between members
