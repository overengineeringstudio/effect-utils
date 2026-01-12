# Commands

## `dotdot init`

Initialize a new workspace in the current directory.

```bash
dotdot init
```

**Creates:**
- `dotdot.json` - Workspace configuration file with empty repos

**Behavior:**
- Fails if `dotdot.json` already exists
- Creates config file with `$schema` reference and empty `repos` object

## `dotdot status`

Show the status of all repos in the workspace.

```bash
dotdot status
```

**Output:**
```
dotdot workspace: /path/to/workspace

Declared repos (3):
  shared-lib: main@abc1234
  effect-utils: main@def5678 *dirty* [diverged from old1234]
  missing-repo: MISSING

Undeclared repos (1):
  extra-repo: main@ghi9012 [not in config]
```

**Information shown:**
- Workspace root path
- For each declared repo:
  - Name
  - Current branch
  - Short revision (7 chars)
  - `*dirty*` if working tree has changes
  - `[diverged from xxx]` if current rev differs from pinned
  - `[no pin]` if no revision pinned
  - `MISSING` if directory doesn't exist
  - `(in: repo-a, repo-b)` if declared in multiple configs
- Undeclared repos (git repos not in any config)

## `dotdot sync`

Clone all declared repos that are missing and checkout pinned revisions.

```bash
dotdot sync
dotdot sync --dry-run
dotdot sync --max-parallel=4
```

**Flags:**
- `--dry-run` - Preview what would be done
- `--mode` - Execution mode (default: `topo-parallel`, see `exec` for all modes)
- `--max-parallel` - Limit parallel operations

**Behavior:**
- Find all declared repos across all configs
- Clone repos with `MISSING` status from configured URL
- Checkout pinned revision if specified
- Run repo-level `install` command if specified
- Run package-level `install` commands if specified
- Default mode (`topo-parallel`) respects dependency order

**Output:**
```
dotdot workspace: /path/to/workspace
Found 3 declared repo(s)

Syncing shared-lib...
  cloned: Cloned at abc1234
Syncing design-system...
  cloned: Cloned at def5678
  installed: pnpm install
  @acme/components: pnpm build
  @acme/tokens: (no install)
Syncing existing-repo...
  skipped: Already exists

Done: 2 cloned, 1 skipped
```

## `dotdot update-revs [repos...]`

Pin current HEAD revisions to configs.

```bash
# Pin all repos
dotdot update-revs

# Pin specific repos
dotdot update-revs shared-lib effect-utils

# Preview changes
dotdot update-revs --dry-run
```

**Behavior:**
- Get current HEAD for each repo
- Update `rev` in the declaring config file
- Report changes made

**Output:**
```
dotdot workspace: /path/to/workspace
Updating 3 repo(s)...

  shared-lib: updated abc1234 → def5678
  effect-utils: unchanged (ghi9012)
  other-repo: skipped (directory does not exist)

Done: 1 updated, 1 unchanged, 1 skipped
```

## `dotdot pull`

Pull all repos from their remotes.

```bash
dotdot pull
dotdot pull --max-parallel=4
```

**Flags:**
- `--mode` - Execution mode (default: `parallel`, see `exec` for all modes)
- `--max-parallel` - Limit parallel operations

**Behavior:**
- Run `git pull` in each repo
- Default mode is `parallel` (git operations are independent)
- Skip repos with dirty working trees
- Skip repos in detached HEAD state
- Report success/failure per repo
- Warn if repo becomes diverged from pinned rev

**Output:**
```
dotdot workspace: /path/to/workspace
Pulling 3 repo(s)...

Pulling shared-lib...
  ✓ Pulled
Pulling effect-utils...
  ⚠ Pulled (now diverged from pinned revision)
Pulling dirty-repo...
  ○ Working tree has uncommitted changes

Done: 2 pulled, 1 diverged, 1 skipped

Warning: Some repos are now diverged from their pinned revisions.
Run `dotdot update-revs` to update pins, or `dotdot sync` to reset to pinned revisions.
```

## `dotdot tree`

Show dependency tree of repos.

```bash
dotdot tree
dotdot tree --conflicts
```

**Output:**
```
dotdot workspace: /path/to/workspace

Dependency tree:

repo-a/
├── shared-lib @ abc1234
└── effect-utils @ def5678

repo-b/
├── shared-lib @ abc1234 [CONFLICT]
└── other-lib @ ghi9012

1 repo(s) declared in multiple configs

Warning: 1 repo(s) have revision conflicts!
Run `dotdot tree --conflicts` to see details
```

**With `--conflicts`:**
```
Found 1 repo(s) with revision conflicts:

shared-lib:
  Declared in: repo-a, repo-b
  Conflicting revisions:
    - abc1234
    - xyz9876
```

## `dotdot link`

Create/update symlinks based on `packages` configuration.

```bash
dotdot link
dotdot link --dry-run
```

**Behavior:**
- Read all `packages` configs
- Create symlinks at workspace root (key becomes symlink name, `path` is target)
- Report conflicts if multiple repos declare same package name

**Output:**
```
dotdot workspace: /path/to/workspace

Creating symlinks...
  @acme/components -> design-system/packages/@acme/components
  @acme/tokens -> design-system/packages/@acme/tokens

Done: 2 symlinks created
```

## `dotdot exec <command>`

Run a command in all repos.

```bash
dotdot exec -- pnpm build
dotdot exec -- git status
```

**Execution modes (`--mode`):**

| Mode | Respects deps | Parallelism | Description |
|------|---------------|-------------|-------------|
| `topo-parallel` | ✓ | ✓ | Parallel within dependency levels (default) |
| `topo` | ✓ | ✗ | One at a time, dependency order |
| `parallel` | ✗ | ✓ | All at once, ignore deps |
| `sequential` | ✗ | ✗ | One at a time, alphabetical |

**Concurrency limit (`--max-parallel`):**

Limits parallel jobs. Only valid with `topo-parallel` or `parallel` modes.

```bash
# Default: topo-parallel (fast, respects dependencies)
dotdot exec -- pnpm build

# Explicit modes
dotdot exec --mode=topo-parallel -- pnpm build   # parallel, respects deps
dotdot exec --mode=topo -- pnpm build            # sequential, respects deps
dotdot exec --mode=parallel -- git fetch         # parallel, ignores deps
dotdot exec --mode=sequential -- git status      # sequential, alphabetical

# Limit concurrency
dotdot exec --max-parallel=4 -- pnpm build
dotdot exec --mode=parallel --max-parallel=4 -- git fetch

# Invalid (CLI error)
dotdot exec --mode=topo --max-parallel=4 -- cmd
dotdot exec --mode=sequential --max-parallel=4 -- cmd
```

**Behavior:**
- Run command in each repo directory
- Default mode (`topo-parallel`) runs repos in parallel while respecting dependency order
- Stream output with repo prefix
- Report exit codes

**Output:**
```
dotdot workspace: /path/to/workspace

Running in 3 repo(s)...

[shared-lib] pnpm build
Done in 1.2s

[effect-utils] pnpm build
Done in 0.8s

[other-repo] pnpm build
Done in 1.5s

Done: 3 succeeded, 0 failed
```

## `dotdot schema`

Generate JSON Schema for `dotdot.json` files.

```bash
# Print to stdout
dotdot schema

# Write to file
dotdot schema -o schema/dotdot.schema.json
```

**Flags:**
- `-o, --output <file>` - Output file path (prints to stdout if omitted)

**Use cases:**
- Generate schema for editor autocompletion
- Validate config files
- Update published schema

## Execution Modes

Commands that operate on multiple repos support execution modes via `--mode`:

| Mode | Respects deps | Parallelism | Description |
|------|---------------|-------------|-------------|
| `topo-parallel` | ✓ | ✓ | Parallel within dependency levels |
| `topo` | ✓ | ✗ | One at a time, dependency order |
| `parallel` | ✗ | ✓ | All at once, ignore deps |
| `sequential` | ✗ | ✗ | One at a time, alphabetical |

**Defaults by command:**

| Command | Default mode | Rationale |
|---------|--------------|-----------|
| `exec` | `topo-parallel` | Build commands need dependency order |
| `sync` | `topo-parallel` | Install commands may have cross-repo deps |
| `pull` | `parallel` | Git operations are independent |

**Concurrency limiting:**

Use `--max-parallel=N` to limit parallel jobs. Only valid with `topo-parallel` or `parallel` modes.

## Command Design Principles

1. **Verbose but concise output** - Show what's happening, but don't overwhelm
2. **No surprises** - Commands do what they say, nothing more
3. **Git-native** - Augment git, don't replace it
4. **Fail fast** - Stop on first error, report clearly
5. **Idempotent where possible** - Running twice should be safe
