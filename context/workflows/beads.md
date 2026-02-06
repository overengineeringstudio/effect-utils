# Beads Workflow

## Overview

We use [beads](https://github.com/steveyegge/beads) (`bd`) as a git-backed issue tracker for AI-assisted coding workflows. Issues are tracked in **centralized beads repos** separate from code repos, with commit correlation via devenv git hooks.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      megarepo root                           │
│                                                              │
│  Beads Repos (issue storage):                               │
│  ├── overeng-beads-public/   # Public, prefix: eu            │
│  └── schickling-beads/       # Private, prefix: sch         │
│                                                              │
│  Code Repos (no .beads/):                                   │
│  ├── effect-utils/     → uses overeng-beads-public          │
│  ├── livestore/        → uses overeng-beads-public          │
│  ├── schickling.dev/   → uses schickling-beads              │
│  └── ...                                                     │
│                                                              │
│  Module Host:                                                │
│  └── overeng-beads-public/nix/devenv-module.nix             │
│      (reusable devenv module for daemon + commit correlation)│
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Beads Repos

| Repo                   | Visibility | Prefix | Purpose                                  |
| ---------------------- | ---------- | ------ | ---------------------------------------- |
| `overeng-beads-public` | Public     | `eu`   | Overengineering projects + devenv module |
| `schickling-beads`     | Private    | `sch`  | Personal projects                        |

## Key Principles

### 1. Centralized beads repos

- Beads repos hold issues, code repos have NO `.beads/` directory
- Avoids branch conflicts in code repos
- Use `pkg:*` labels to categorize by project/package

### 2. Commit correlation via devenv

- Code repos import the devenv module from `overeng-beads-public`
- Hook detects issue references in format `(prefix-xxx)`
- Adds comment to beads issue with commit SHA + message

### 3. Daemon mode (auto-sync)

- Daemon serializes concurrent `bd` access via RPC (safe for shared worktrees)
- Auto-commits JSONL changes to `beads-sync` branch
- Auto-pulls remote changes (every 30s)
- Git push still requires manual `dt beads:sync` (daemon `--auto-push` has upstream detection bug)

## Setup

### Directory Structure

```
<megarepo-root>/
├── overeng-beads-public/  # Public beads + devenv module
│   ├── .beads/
│   ├── nix/devenv-module.nix
│   └── flake.nix
├── schickling-beads/      # Private beads
│   └── .beads/
├── effect-utils/          # Code repo (no .beads/)
└── ...
```

### Code Repo Setup (via devenv)

The beads devenv module runs a daemon for auto-sync (DB + JSONL, with JSONL as git-portable source of truth). The beads repo must be a megarepo member.

1. Add the beads repo as a megarepo member in `megarepo.json`:

```json
{
  "members": {
    "overeng-beads-public": "overengineeringstudio/overeng-beads-public"
  }
}
```

2. Add the flake input in `devenv.yaml`:

```yaml
inputs:
  overeng-beads-public:
    url: github:overengineeringstudio/overeng-beads-public
```

3. Import the module in `devenv.nix`:

```nix
{ inputs, ... }: {
  imports = [
    # Beads integration: env vars, sync task, commit correlation hook
    (inputs.overeng-beads-public.devenvModules.beads {
      beadsPrefix = "oep";                   # or "sch" for personal projects
      beadsRepoName = "overeng-beads-public"; # or "schickling-beads"
      # beadsRepoPath = "repos/overeng-beads-public";  # default, can be overridden
    })
  ];
}
```

> **Tip:** For local iteration on the module, temporarily switch to
> `import ./repos/overeng-beads-public/nix/devenv-module.nix { ... }` (don't commit this).

This provides:

- `bd` shell wrapper (runs from the beads repo)
- `dt beads:daemon:ensure` task (starts daemon if not running, idempotent)
- `dt beads:daemon:stop` task (stops daemon)
- `dt beads:sync` task (git pull + commit + push JSONL changes)
- Commit correlation git hook (cross-references commits with beads issues)

## Daily Workflow

### Creating Issues

```bash
# The `bd` wrapper runs from the beads repo automatically (no need to cd)
bd create "Implement feature X" -p 1 -t feature -l pkg:effect-utils

# Check ready work
bd ready
```

### Referencing Issues in Commits

Use parenthesized format in commit messages:

```bash
# In your code repo
git commit -m "Add retry logic (eu-abc123)"
```

The git hook will automatically add a comment to the beads issue.

### Syncing with Git

```bash
# Push JSONL changes to the beads repo (git pull + commit + push)
dt beads:sync
```

### Viewing Issues

```bash
# bd wrapper works from anywhere in the devenv
bd list

# Filter by package
bd list --label pkg:effect-utils

# Show issue with comments (including commit references)
bd show oep-abc123
```

## Commit Correlation

### How It Works

1. Commit message contains `(eu-xxx)` pattern
2. Git `post-commit` hook triggers
3. Hook extracts issue ID and adds comment to beads issue
4. Comment includes: commit SHA, repo name, commit message

### How the Hook Works (devenv module)

The devenv module installs the post-commit hook automatically via `git-hooks.hooks.beads-commit-correlation`. No manual hook installation needed.

The hook:

1. Reads the commit message
2. Extracts issue references matching `(prefix-xxx)` pattern
3. Runs `bd --no-daemon --no-db comment` from the beads repo
4. Adds a comment with commit SHA, repo name, and message
5. Skips silently if beads repo isn't materialized

## Configuration

### Environment Variables

The beads devenv module sets these automatically:

```bash
BEADS_PREFIX="oep"           # Issue prefix (set by module)
BEADS_REPO="$DEVENV_ROOT/repos/overeng-beads-public"  # Beads repo path
```

The `bd` shell wrapper cds to the beads repo automatically. When daemon is enabled, commands go through the daemon's RPC for serialized access.

## Constraints

### What NOT to do

1. **Don't create `.beads/` in code repos** - Use the centralized beads repo
2. **Don't forget parentheses** - Commit format must be `(oep-xxx)` not just `oep-xxx`
3. **Don't use `bd` with explicit `--no-db` flag** - The daemon manages DB↔JSONL sync automatically

### Trade-offs

This centralized pattern:

| Benefit                           | Trade-off                                      |
| --------------------------------- | ---------------------------------------------- |
| No branch conflicts in code repos | Need to switch to beads repo for `bd` commands |
| Single source of truth            | Commit correlation requires hook setup         |
| Clean code repo history           | Issues not versioned with code                 |

## Label Taxonomy

Labels use hierarchical `category:value` format for consistent filtering.

> **CRITICAL:** Only use labels defined below. Do not invent new labels. If a new label seems necessary, discuss with the user first before creating it. Undefined labels create noise and break filtering consistency.

### Package Labels (`pkg:`)

Component ownership - which package does this issue affect?

```
pkg:notion-effect-client
pkg:notion-effect-schema
pkg:notion-cli
pkg:effect-schema-form
pkg:effect-schema-form-aria
pkg:effect-react
pkg:react-inspector
pkg:effect-ai-claude-cli
pkg:effect-rpc-tanstack
pkg:effect-path
pkg:genie
pkg:mono
pkg:utils
pkg:oxc-config
pkg:cli-ui
pkg:infra                    # CI, Nix, monorepo config, devenv
```

### Quality Gates (`qa:`)

Track what's needed before closing:

```
qa:needs-review              # Requires code review
qa:needs-tests               # Missing test coverage
qa:needs-docs                # Missing documentation
qa:breaking-change           # API breaking change (requires major version bump)
```

### Size/Effort (`size:`)

Quick effort indicators for planning:

```
size:small                   # < 1 day
size:medium                  # 1-3 days
size:large                   # > 3 days
```

### Meta Labels (`meta:`)

Process and workflow markers:

```
meta:good-first-issue        # Good for new contributors
meta:technical-debt          # Cleanup/refactoring work
meta:perf                    # Performance related
meta:deps                    # Dependency updates
```

### Example Usage

```bash
# Create issue with labels
bd create "Add retry logic to Notion client" -t feature -p 2 \
  -l pkg:notion-effect-client,size:medium

# Find all Notion-related work
bd list --label-any pkg:notion-effect-client,pkg:notion-effect-schema,pkg:notion-cli

# Find quick wins needing review
bd list --label size:small,qa:needs-review

# Track breaking changes for next release
bd list --label qa:breaking-change --status open
```

### Detecting Undefined Labels

Use this command to find labels not in the taxonomy (for manual cleanup):

```bash
# Allowed labels (update if taxonomy changes)
ALLOWED_LABELS="pkg:notion-effect-client pkg:notion-effect-schema pkg:notion-cli pkg:effect-schema-form pkg:effect-schema-form-aria pkg:effect-react pkg:react-inspector pkg:effect-ai-claude-cli pkg:effect-rpc-tanstack pkg:effect-path pkg:genie pkg:mono pkg:utils pkg:oxc-config pkg:cli-ui pkg:infra qa:needs-review qa:needs-tests qa:needs-docs qa:breaking-change size:small size:medium size:large meta:good-first-issue meta:technical-debt meta:perf meta:deps"

# Find undefined labels
bd label list-all --json | jq -r '.[].label' | while read label; do
  if ! echo "$ALLOWED_LABELS" | grep -qw "$label"; then
    echo "Undefined: $label"
  fi
done
```

To find issues using an undefined label for cleanup:

```bash
bd list --label <undefined-label> --json | jq -r '.[].id'
```

## Future Considerations

- [ ] Explore beads feature request for cross-repo orphan detection ([#1196](https://github.com/steveyegge/beads/issues/1196))
- [ ] Investigate `--auto-push` fix upstream (currently broken: "no upstream configured" even with proper upstream)
