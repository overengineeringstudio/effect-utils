# Commands Reference

All commands support `--json` for machine-readable output.

## Core Commands

### `mr init`

Initialize a new megarepo in the current directory.

```bash
mr init
```

- Requires the directory to be a git repository
- Creates `megarepo.json` with empty members
- Fails if `megarepo.json` already exists

### `mr sync`

Ensure worktrees exist and symlinks are correct.

```bash
mr sync [--pull] [--force] [--frozen] [--deep] [--only <members>] [--skip <members>] [--dry-run]
```

**Options:**

| Option      | Description                                    |
| ----------- | ---------------------------------------------- |
| `--pull`    | Fetch from remote and update to latest commits |
| `--force`   | Override dirty worktree checks                 |
| `--frozen`  | CI mode: fail if lock is missing or stale      |
| `--deep`    | Recursively sync nested megarepos              |
| `--only`    | Only sync specified members (comma-separated)  |
| `--skip`    | Skip specified members (comma-separated)       |
| `--dry-run` | Show what would be done without making changes |

**Behavior:**

1. For each member in config:
   - If in lock → use locked commit
   - If NOT in lock → resolve ref from remote, add to lock
2. Clone bare repo to store if needed
3. Create worktree at locked commit if needed
4. Create symlink under `repos/` pointing to the worktree
5. Write updated lock file
6. Run all configured generators (skipped for `--dry-run`)

**`--frozen` mode:**

- Lock file MUST exist
- Lock MUST cover all config members
- Uses locked commits exactly
- Fails if config has members not in lock

### `mr update`

Re-resolve refs from remotes and update the lock file.

```bash
mr update [--member <name>] [--force]
```

**Options:**

| Option         | Description             |
| -------------- | ----------------------- |
| `--member, -m` | Update only this member |
| `--force, -f`  | Update even if pinned   |

**Behavior:**

1. Fetch from remote
2. Resolve ref to latest commit
3. Update lock file entry
4. Checkout new commit in worktree

Skips pinned members unless `--force` or explicitly named.

### `mr add`

Add a member to `megarepo.json`.

```bash
mr add <repo> [--name <name>] [--sync]
```

**Arguments:**

| Argument | Description                                           |
| -------- | ----------------------------------------------------- |
| `repo`   | Repository reference (GitHub shorthand, URL, or path) |

**Options:**

| Option       | Description                                      |
| ------------ | ------------------------------------------------ |
| `--name, -n` | Override the member name (defaults to repo name) |
| `--sync, -s` | Sync the added repo immediately                  |

**Examples:**

```bash
mr add effect-ts/effect
mr add effect-ts/effect#v3.0.0 --name effect-v3
mr add https://gitlab.com/org/repo --name gitlab-lib
mr add ./packages/local --name local-lib
mr add effect-ts/effect --sync  # Add and sync immediately
```

## Pin Commands

### `mr pin`

Pin a member to its current commit. Pinned members won't update with `mr update`.

```bash
mr pin <member>
```

### `mr unpin`

Remove pin from a member.

```bash
mr unpin <member>
```

## Info Commands

### `mr root`

Print the megarepo root directory.

```bash
mr root [--json]
```

Searches up from current directory for `megarepo.json`.

### `mr status`

Show megarepo state.

```bash
mr status [--json]
```

Displays:

- Megarepo name (derived from git remote)
- Root path
- Member count and sync status

### `mr ls`

List members.

```bash
mr ls [--json]
```

### `mr env`

Print environment variables for shell integration.

```bash
mr env [--shell bash|zsh|fish] [--json]
```

Output:

```bash
export MEGAREPO_ROOT_OUTERMOST="/path/to/megarepo"
export MEGAREPO_ROOT_NEAREST="/path/to/megarepo"
export MEGAREPO_MEMBERS="effect,other-lib"
export MEGAREPO_NIX_WORKSPACE="/path/to/megarepo/.direnv/megarepo-nix/workspace"
```

## Exec Command

### `mr exec`

Execute a command across members.

```bash
mr exec <command> [--member <name>]
```

**Options:**

| Option         | Description             |
| -------------- | ----------------------- |
| `--member, -m` | Run only in this member |

**Examples:**

```bash
mr exec "git status"
mr exec "bun install" --member effect
mr exec "git pull"
```

## Store Commands

### `mr store ls`

List repos in the global store.

```bash
mr store ls [--json]
```

### `mr store fetch`

Fetch all repos in the store.

```bash
mr store fetch [--json]
```

### `mr store gc`

Garbage collect unused worktrees.

```bash
mr store gc [--dry-run] [--force] [--all]
```

**Options:**

| Option        | Description                                       |
| ------------- | ------------------------------------------------- |
| `--dry-run`   | Show what would be removed                        |
| `--force, -f` | Remove dirty worktrees (with uncommitted changes) |
| `--all`       | Remove all worktrees (not just unused)            |

**Safety:** Skips worktrees with uncommitted changes unless `--force`.

## Generate Commands

### `mr generate all`

Generate all configured outputs.

```bash
mr generate all [--json]
```

Generates based on `generators` config:

- `.envrc.generated.megarepo` + `.direnv/megarepo-nix/workspace` (when `generators.nix.enabled = true`)
- `.vscode/megarepo.code-workspace` (default: disabled)
- `schema/megarepo.schema.json` (always)

### `mr generate nix`

Generate the local Nix workspace and `.envrc.generated.megarepo`.

```bash
mr generate nix [--json]
```

### `mr generate vscode`

Generate VS Code workspace file.

```bash
mr generate vscode [--exclude <members>] [--json]
```

**Options:**

| Option      | Description                                |
| ----------- | ------------------------------------------ |
| `--exclude` | Comma-separated list of members to exclude |

### `mr generate schema`

Generate JSON Schema for editor support.

```bash
mr generate schema [--output <path>] [--json]
```

## Common Options

All commands support:

| Option   | Description                           |
| -------- | ------------------------------------- |
| `--json` | Output JSON instead of formatted text |
| `--help` | Show help                             |
