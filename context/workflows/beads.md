# Beads Workflow

## Overview

We use [beads](https://github.com/steveyegge/beads) (`bd`) as a git-backed issue tracker for AI-assisted coding workflows. Issues are tracked in **centralized beads repos** separate from code repos, with commit correlation via devenv git hooks.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      megarepo root                           │
│                                                              │
│  Beads Repos (issue storage):                               │
│  ├── overeng-beads-public/   # Public, prefix: eu, Linear   │
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
│      (reusable devenv module for commit correlation)        │
│                                                              │
└─────────────────────────────────────────────────────────────┘
                             │
                             │ Linear sync (overeng-beads-public only)
                             ▼
┌─────────────────────────────────────────────────────────────┐
│  Linear EU Team                                              │
│  - Issues synced from overeng-beads-public                  │
│  - Labels: pkg:*, size:*, qa:*, meta:*                      │
└─────────────────────────────────────────────────────────────┘
```

## Beads Repos

| Repo                   | Visibility | Prefix | Linear Sync   | Purpose                                  |
| ---------------------- | ---------- | ------ | ------------- | ---------------------------------------- |
| `overeng-beads-public` | Public     | `eu`   | Yes (EU team) | Overengineering projects + devenv module |
| `schickling-beads`     | Private    | `sch`  | No            | Personal projects                        |

## Key Principles

### 1. Centralized beads repos

- Beads repos hold issues, code repos have NO `.beads/` directory
- Avoids branch conflicts in code repos
- Use `pkg:*` labels to categorize by project/package

### 2. Commit correlation via devenv

- Code repos import the devenv module from `overeng-beads-public`
- Hook detects issue references in format `(prefix-xxx)`
- Adds comment to beads issue with commit SHA + message

### 3. Linear sync (optional)

- `overeng-beads-public` syncs with Linear team EU
- `schickling-beads` does not sync to Linear

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

1. Add `overeng-beads-public` as flake input in `devenv.yaml`:

```yaml
inputs:
  overeng-beads-public:
    url: github:overengineeringstudio/overeng-beads-public
    flake: true
```

2. Import the module in `devenv.nix`:

```nix
{ inputs, ... }: {
  imports = [
    (inputs.overeng-beads-public.devenvModules.beads {
      beadsPrefix = "eu";                    # or "sch" for personal projects
      beadsRepoName = "overeng-beads-public"; # or "schickling-beads"
    })
  ];
}
```

### Linear Sync (in overeng-beads-public)

```bash
cd overeng-beads-public
bd config set linear.api_key "$LINEAR_API_KEY"
bd config set linear.team_id "your-team-uuid"
```

## Daily Workflow

### Creating Issues

```bash
# Run from overeng-beads directory
cd "$MEGAREPO_ROOT_OUTERMOST/overeng-beads-public"

# Create issue with package label
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

### Linear Sync

```bash
# Run from overeng-beads directory
cd "$MEGAREPO_ROOT_OUTERMOST/overeng-beads-public"

# Pull from Linear (import team changes)
bd linear sync --pull

# Push local changes to Linear
bd linear sync --push

# Bidirectional sync
bd linear sync
```

### Viewing Issues

```bash
# From overeng-beads
bd list

# Filter by package
bd list --label pkg:effect-utils

# Show issue with comments (including commit references)
bd show eu-abc123
```

## Commit Correlation

### How It Works

1. Commit message contains `(eu-xxx)` pattern
2. Git `post-commit` hook triggers
3. Hook extracts issue ID and adds comment to beads issue
4. Comment includes: commit SHA, repo name, commit message

### Post-Commit Hook

Install this hook in each code repo at `.git/hooks/post-commit`:

```bash
#!/usr/bin/env bash
# Post-commit hook: Add comments to beads issues referenced in commit messages
# Pattern: (prefix-xxx) where prefix is configured in BEADS_PREFIX

set -euo pipefail

# Configuration via environment (set in .envrc)
BEADS_DB="${BEADS_DB:-}"
BEADS_PREFIX="${BEADS_PREFIX:-eu}"

if [ -z "$BEADS_DB" ]; then
    exit 0  # Skip if not configured
fi

# Get commit info
COMMIT_SHA=$(git rev-parse HEAD)
COMMIT_SHORT=$(git rev-parse --short HEAD)
COMMIT_MSG=$(git log -1 --format=%B)
REPO_NAME=$(basename "$(git rev-parse --show-toplevel)")

# Extract issue references matching (prefix-xxx) pattern
ISSUES=$(echo "$COMMIT_MSG" | grep -oE "\(${BEADS_PREFIX}-[a-z0-9]+\)" | tr -d '()' || true)

if [ -z "$ISSUES" ]; then
    exit 0
fi

# Check if bd is available
if ! command -v bd &> /dev/null; then
    BD_CMD="nix shell github:steveyegge/beads --command bd"
else
    BD_CMD="bd"
fi

# Add comment to each referenced issue
for issue_id in $ISSUES; do
    comment="Commit ${COMMIT_SHORT} in ${REPO_NAME}: ${COMMIT_MSG%%$'\n'*}"
    $BD_CMD --no-daemon --db "$BEADS_DB" comment "$issue_id" "$comment" 2>/dev/null || true
done
```

Make it executable:

```bash
chmod +x .git/hooks/post-commit
```

### Devenv Integration

For projects using devenv, add hook installation to `devenv.nix`:

```nix
{
  enterShell = ''
    # Install beads post-commit hook if not present
    if [ ! -f .git/hooks/post-commit ]; then
      cp ${./scripts/beads-post-commit.sh} .git/hooks/post-commit
      chmod +x .git/hooks/post-commit
    fi
  '';
}
```

## Configuration

### Environment Variables (Code Repos)

Add to `.envrc` in each code repo:

```bash
# Beads configuration for commit correlation
export BEADS_DB="$PWD/../overeng-beads/.beads/beads.db"
export BEADS_PREFIX="eu"
```

### Environment Variables (overeng-beads)

```bash
# Disable daemon (recommended for simpler setup)
export BEADS_NO_DAEMON=true

# Linear credentials (alternative to bd config)
export LINEAR_API_KEY="lin_api_..."
export LINEAR_TEAM_ID="team-uuid"
```

### Beads Config (`overeng-beads/.beads/config.yaml`)

```yaml
issue_prefix: eu
sync-branch: 'main'
```

## Constraints

### What NOT to do

1. **Don't create `.beads/` in code repos** - Use the centralized `overeng-beads` repo
2. **Don't forget parentheses** - Commit format must be `(eu-xxx)` not just `eu-xxx`
3. **Don't run `bd` commands from code repos** - Always run from `overeng-beads`

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
pkg:dotdot
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
ALLOWED_LABELS="pkg:notion-effect-client pkg:notion-effect-schema pkg:notion-cli pkg:effect-schema-form pkg:effect-schema-form-aria pkg:effect-react pkg:react-inspector pkg:effect-ai-claude-cli pkg:effect-rpc-tanstack pkg:effect-path pkg:genie pkg:mono pkg:dotdot pkg:utils pkg:oxc-config pkg:cli-ui pkg:infra qa:needs-review qa:needs-tests qa:needs-docs qa:breaking-change size:small size:medium size:large meta:good-first-issue meta:technical-debt meta:perf meta:deps"

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

- [ ] Create reusable hook script in shared location (e.g., `dotfiles/scripts/beads-post-commit.sh`)
- [ ] Add hook auto-installation to devenv for all code repos
- [ ] Explore beads feature request for cross-repo orphan detection ([#1196](https://github.com/steveyegge/beads/issues/1196))
- [ ] Consider Linear label sync ([#1191](https://github.com/steveyegge/beads/issues/1191))
