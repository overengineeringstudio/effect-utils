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
mr sync [--pull] [--force] [--frozen] [--all] [--only <members>] [--skip <members>] [--dry-run]
```

**Options:**

| Option      | Description                                    |
| ----------- | ---------------------------------------------- |
| `--pull`    | Fetch from remote and update to latest commits |
| `--force`   | Override dirty worktree checks                 |
| `--frozen`  | CI mode: fail if lock is missing or stale      |
| `--all`     | Recursively sync nested megarepos              |
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

**JSON output (`--output json` / `--output ndjson`):**

The sync command emits a machine-readable state object.

- `_tag`: one of `Syncing` | `Success` | `Error` | `Interrupted`
- `results`: root megarepo member results (direct members only)
- `syncErrors`: flattened list of all errors across the full nested tree (includes nested megarepos)
- `syncErrorCount`: total number of errors across the full nested tree
- `syncTree`: full recursive tree for `--all` runs (root + nested results)

This means `mr sync --all` can fail because of nested errors even if all root-level members succeeded; the nested failures are discoverable via `syncErrors` and `syncTree`.

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

Point a member to a specific ref and mark it as pinned.

```bash
mr pin <member> [-c <ref>]
```

**Options:**

| Option | Description                                  |
| ------ | -------------------------------------------- |
| `-c`   | Ref to point to (branch, tag, or commit SHA) |

**Examples:**

```bash
mr pin effect                 # pin to current commit
mr pin effect -c main         # switch to and pin main branch
mr pin effect -c v3.0.0       # switch to and pin tag
mr pin effect -c feature/foo  # switch to and pin feature branch
mr pin effect -c abc123def    # pin to specific commit
```

**Behavior:**

1. If `-c <ref>` provided: updates `megarepo.json` with the new ref
2. Creates a new worktree for that ref in the store (if it doesn't exist)
3. Updates the symlink in `repos/` to point to the new worktree
4. Sets `pinned: true` in lock file

**Worktree preservation:** Unlike `git checkout`, switching refs does NOT modify the current worktree. Each ref has its own isolated worktree in the store. The previous worktree remains untouched with any uncommitted changes preserved.

### `mr unpin`

Remove pin from a member, allowing it to update on `sync --pull`.

```bash
mr unpin <member>
```

After unpinning:

- Branch refs will update to latest on `mr sync --pull`
- Tag and commit refs remain at their fixed points (they're inherently immutable)

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
export MEGAREPO_STORE="~/.megarepo"
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

- `.vscode/megarepo.code-workspace` (when `generators.vscode.enabled = true`)

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
