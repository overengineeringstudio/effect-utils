# Workflows

Common usage patterns for megarepo.

## Daily Development

### Starting Work

```bash
cd my-megarepo
mr sync          # Ensure everything is up to date
mr update        # Get latest commits (optional)
```

### Making Changes Across Repos

Since members are symlinks to shared worktrees, changes persist:

```bash
cd repos/effect  # Enter a member
git checkout -b my-feature
# Make changes...
git commit -m "Add feature"
git push
```

The changes are visible from any megarepo sharing that worktree.

### Running Commands Across Members

```bash
# Check status everywhere
mr exec "git status"

# Install dependencies
mr exec "bun install"

# Run tests
mr exec "bun test"
```

## CI Reproducibility

### Committing Lock File

Always commit `megarepo.lock` for reproducible builds:

```bash
mr sync
git add megarepo.lock
git commit -m "Update lock file"
```

### CI Pipeline

Use `--frozen` to ensure exact reproducibility:

```yaml
# .github/workflows/ci.yml
steps:
  - uses: actions/checkout@v4
  - uses: oven-sh/setup-bun@v1

  - name: Sync megarepo
    run: bunx @overeng/megarepo sync --frozen

  - name: Run tests
    run: bun test
```

The `--frozen` flag:

- Requires lock file to exist
- Fails if config doesn't match lock
- Uses exact commits from lock
- Never fetches or resolves new refs

## Stabilizing for Release

### Pinning Dependencies

Pin members to prevent accidental updates:

```bash
mr pin effect
mr pin other-lib

# Lock file now has pinned: true for these members
git add megarepo.lock
git commit -m "Pin dependencies for v1.0 release"
```

### Updating Pinned Members

Pinned members are skipped by `mr update`:

```bash
mr update          # effect and other-lib stay pinned
mr update --force  # Update ALL including pinned
mr update --member effect --force  # Update just effect
```

### Unpinning After Release

```bash
mr unpin effect
mr unpin other-lib
mr update  # Now they update normally
```

## Investigating Regressions

### Testing a Specific Commit

```bash
# Pin to a known-good commit
# First, edit megarepo.json to use commit SHA
# effect: "effect-ts/effect#abc123def456..."
mr sync

# Test...

# Revert back
# effect: "effect-ts/effect#main"
mr update effect
```

### Comparing Versions

Use different member names for the same repo:

```json
{
  "members": {
    "effect-stable": "effect-ts/effect#v3.0.0",
    "effect-next": "effect-ts/effect#next"
  }
}
```

```bash
mr sync
# Now you have both versions available
diff repos/effect-stable/package.json repos/effect-next/package.json
```

## Shared Development

### Multiple Megarepos Sharing Worktrees

When two megarepos reference the same repo+ref, they share the worktree:

```
~/project-a/
└── repos/
    └── effect -> ~/.megarepo/github.com/effect-ts/effect/refs/heads/main/

~/project-b/
└── repos/
    └── effect -> ~/.megarepo/github.com/effect-ts/effect/refs/heads/main/
```

Changes in one are immediately visible in the other.

### Isolating Changes

To work independently, use different refs:

```bash
# project-a uses main
mr add effect-ts/effect#main --name effect

# project-b uses a feature branch
mr add effect-ts/effect#my-feature --name effect
```

## Nested Megarepos

When a member is itself a megarepo:

```bash
# Sync just this megarepo
mr sync

# Note about nested megarepos will be shown
# Note: 1 member(s) contain nested megarepos (member-name)
#       Run 'mr sync --deep' to sync them, or 'cd repos/<member> && mr sync'

# Sync recursively
mr sync --deep
```

## Store Management

### Checking Store Contents

```bash
mr store ls
# Store: /Users/you/.megarepo
#
#   github.com/effect-ts/effect
#   github.com/owner/repo
#
# 2 repo(s)
```

### Cleaning Up Unused Worktrees

```bash
# Preview what would be removed
mr store gc --dry-run

# Remove unused worktrees (preserves dirty ones)
mr store gc

# Force remove even dirty worktrees
mr store gc --force
```

### Pre-fetching Updates

```bash
# Fetch all repos in store (background task)
mr store fetch
```

## Environment Integration

### Direnv Setup

Generate the local Nix workspace and source environment variables:

```bash
mr generate nix
```

In your `.envrc`:

```bash
source_env_if_exists .envrc.generated.megarepo
use devenv
```

### VS Code Workspace

Enable in `megarepo.json`:

```json
{
  "members": { ... },
  "generators": {
    "vscode": {
      "enabled": true,
      "exclude": ["large-repo"]  // Optional: exclude from workspace
    }
  }
}
```

```bash
mr generate all
# Opens: .vscode/megarepo.code-workspace
```

## Troubleshooting

### Symlink Points to Wrong Location

```bash
mr sync  # Fixes symlinks automatically
```

### Member Not Synced

```bash
mr status  # Shows sync status
mr sync    # Syncs missing members
```

### Lock File Out of Sync

```bash
mr sync  # Updates lock file to match config
git diff megarepo.lock  # Review changes
git add megarepo.lock
git commit -m "Update lock file"
```

### Dirty Worktree Blocking Update

```bash
cd repos/member-name
git status  # Check what's dirty
git stash   # Or commit changes
cd ..
mr update
```
