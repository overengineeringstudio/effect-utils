# dotdot

Opinionated multi-repo workspace management CLI - an alternative to Git submodules.

## Status

**Early development** - Core commands implemented, documentation in progress.

## Why dotdot?

Existing tools for managing multiple repos have significant trade-offs:

| Approach | Pain points |
|----------|-------------|
| **Git submodules** | Nested repos, complex commands, detached HEAD, merge conflicts in pointers |
| **Monorepo** (pnpm/yarn workspaces) | Single git repo for everything, can't mix ecosystems, large clones |
| **Monorepo orchestrators** (nx, turborepo) | Complex setup, monorepo-centric, heavy tooling |
| **Manual scripts** | No dependency tracking, no reproducibility, reinventing the wheel |

dotdot takes a different approach: **flat peer repos with simple `../` paths**.

- Each repo stays independent (separate git history, access control, CI)
- Dependencies are declared per-repo and deduplicated at workspace level
- Topological execution for builds without complex configuration
- Works with any ecosystem (bun, cargo, nix flakes)

## Quick Start

```bash
# Initialize a workspace
mkdir my-workspace && cd my-workspace
dotdot init

# Check workspace status
dotdot status

# Clone all declared dependencies
dotdot sync

# Run a command across all repos
dotdot exec -- pnpm build
```

## Workspace Structure

```
my-workspace/
├── dotdot.generated.json           # Workspace config (also serves as marker)
├── repo-a/
│   ├── .git/
│   └── dotdot.json       # Declares dependencies (optional)
├── repo-b/
│   ├── .git/
│   └── dotdot.json
└── shared-lib/           # Shared dependency (deduplicated)
    └── .git/
```

All repos are flat peers. See [Core Concepts](./docs/concepts.md) for details.

## Configuration

Dependencies are declared in `dotdot.json` (language-agnostic JSON format):

```json
{
  "$schema": "https://raw.githubusercontent.com/overengineeringstudio/dotdot/main/schema/dotdot.schema.json",
  "repos": {
    "shared-lib": {
      "url": "git@github.com:org/shared-lib.git",
      "rev": "abc123...",
      "install": "pnpm install"
    }
  }
}
```

See [Core Concepts](./docs/concepts.md) for all configuration options.

## Commands

| Command | Description |
|---------|-------------|
| `dotdot init` | Initialize workspace (creates `dotdot.json`) |
| `dotdot status` | Show repo states and revision status |
| `dotdot sync` | Clone missing repos, checkout pinned revisions |
| `dotdot update-revs` | Pin current HEAD revisions to configs |
| `dotdot pull` | Pull all repos from remotes |
| `dotdot tree` | Show dependency tree, detect conflicts |
| `dotdot link` | Create symlinks from `packages` configs |
| `dotdot exec` | Run command in all repos (topological order) |
| `dotdot schema` | Generate JSON schema file |

See [Commands](./docs/commands.md) for full reference including execution modes.

## Documentation

- [Core Concepts](./docs/concepts.md) - Workspace, repos, configuration, expose
- [Commands](./docs/commands.md) - CLI reference with execution modes
- [Workflows](./docs/workflows.md) - Common usage patterns
- [Design Decisions](./docs/design-decisions.md) - Rationale and trade-offs
- [Using with Bun](./docs/usage-patterns/bun.md) - Configuration for Bun package manager
- [Using with Genie](./docs/usage-patterns/genie.md) - Cross-repo config generation
