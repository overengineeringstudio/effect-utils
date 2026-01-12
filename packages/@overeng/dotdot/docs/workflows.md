# Workflows

## 1. Starting a New Multi-Repo Project

Create a workspace and add repos.

```bash
# Create workspace directory
mkdir my-project && cd my-project

# Initialize dotdot
dotdot init

# Clone your main repo
git clone git@github.com:org/frontend.git

# Sync all declared dependencies
dotdot sync

# Check status
dotdot status
```

**Result:**
```
my-project/
├── dotdot.json           # Root config (can also be in frontend/)
├── frontend/
│   └── dotdot.json       # Declares dependencies
├── backend/
│   └── dotdot.json       # Declares dependencies
└── shared-types/
```

## 2. Onboarding to Existing Project

Join a team with an established multi-repo setup.

```bash
# Clone the primary repo (contains dotdot.json)
git clone git@github.com:org/my-app.git
cd my-app

# Sync all declared repos
dotdot sync

# Check everything is in place
dotdot status
```

The primary repo's `dotdot.json` declares dependencies:
```json
{
  "$schema": "https://raw.githubusercontent.com/overengineeringstudio/dotdot/main/schema/dotdot.schema.json",
  "repos": {
    "shared-lib": { "url": "git@github.com:org/shared-lib.git", "rev": "abc123" },
    "effect-utils": { "url": "git@github.com:org/effect-utils.git", "rev": "def456" }
  }
}
```

After `dotdot sync`:
```
workspace/
├── dotdot.json
├── my-app/
│   └── dotdot.json
├── shared-lib/           # Restored
└── effect-utils/         # Restored
```

## 3. Day-to-Day Development

```bash
# Morning: check status
dotdot status

# Output shows:
# - Which repos have uncommitted changes (*dirty*)
# - Which repos diverged from pinned revisions
# - Any undeclared repos

# Pull latest
dotdot pull

# Work in individual repos
cd frontend && git checkout -b feature/new-ui
# ... make changes ...
cd ../backend && git checkout -b feature/new-api
# ... make changes ...

# Check status again
dotdot status
```

## 4. Pinning Revisions

Lock workspace to specific commits for reproducibility.

```bash
# After testing, update pins to current revisions
dotdot update-revs

# This updates dotdot.json:
# "repos": {
#   "shared-lib": { "url": "...", "rev": "new-sha-1" },
#   "effect-utils": { "url": "...", "rev": "new-sha-2" }
# }

# Commit the config change
git add dotdot.json
git commit -m "Pin repos to tested revisions"
```

## 5. Handling Diverged Repos

When a repo's current revision differs from the pinned revision.

```bash
dotdot status
# Shows: shared-lib: main@abc1234 [diverged from old5678]

# Option 1: Reset to pinned revision
cd shared-lib && git checkout old5678

# Option 2: Update pin to current revision
dotdot update-revs shared-lib
```

## 6. Nested Dependencies

When repos declare their own dependencies, dotdot deduplicates them.

```
my-workspace/
├── dotdot.json
├── app/
│   └── dotdot.json       # Declares: lib-a, lib-b
├── lib-a/
│   └── dotdot.json       # Declares: lib-b, lib-c
├── lib-b/                # Deduplicated
└── lib-c/                # Deduplicated
```

dotdot aggregates all configs:
```bash
dotdot status

# Declared repos (4):
#   app: main@...
#   lib-a: main@... (in: app)
#   lib-b: main@... (in: app, lib-a)
#   lib-c: main@... (in: lib-a)
```

## 7. Tool Integration

### pnpm Workspaces

```yaml
# pnpm-workspace.yaml
packages:
  - 'frontend'
  - 'backend'
  - 'shared-types'
```

```bash
# Install all dependencies
pnpm install

# Run command across packages
pnpm -r build
```

### TypeScript Paths

```json
// tsconfig.json
{
  "compilerOptions": {
    "paths": {
      "@shared/*": ["../shared-types/src/*"]
    }
  }
}
```

### Nix Flakes

```nix
# flake.nix
{
  inputs = {
    frontend.url = "path:./frontend";
    backend.url = "path:./backend";
    shared-types.url = "path:./shared-types";
  };
}
```

## 8. CI/CD Integration

```yaml
# .github/workflows/ci.yml
jobs:
  build:
    steps:
      - uses: actions/checkout@v4

      # Sync peer repos
      - name: Setup dotdot
        run: |
          # Install dotdot
          npm install -g dotdot
          # Sync all declared repos
          dotdot sync

      - name: Build
        run: |
          pnpm install
          pnpm build
```

## 9. Managing Symlinks with Packages

When you need monorepo-style imports without nesting.

```json
{
  "$schema": "https://raw.githubusercontent.com/overengineeringstudio/dotdot/main/schema/dotdot.schema.json",
  "repos": {
    "shared-lib": {
      "url": "git@github.com:org/shared-lib.git",
      "install": "pnpm install",
      "packages": {
        "@org/utils": { "path": "packages/utils", "install": "pnpm build" },
        "@org/types": { "path": "packages/types" }
      }
    }
  }
}
```

```bash
dotdot link

# Creates:
# workspace/@org/utils -> workspace/shared-lib/packages/utils
# workspace/@org/types -> workspace/shared-lib/packages/types
```

Now other repos can reference with simple paths:
```json
// package.json
{
  "dependencies": {
    "@org/utils": "../@org/utils",
    "@org/types": "../@org/types"
  }
}
```

## 10. Resolving Conflicts

When multiple repos pin different revisions of the same dependency:

```bash
dotdot tree --conflicts

# Output:
# shared-lib:
#   Declared in: app, lib-a
#   Conflicting revisions:
#     - abc1234
#     - xyz9876
```

**Resolution options:**
1. Align configs to use the same revision
2. Update one repo to work with the other's pinned revision
3. Use the latest revision and update all configs: `dotdot update-revs shared-lib`
