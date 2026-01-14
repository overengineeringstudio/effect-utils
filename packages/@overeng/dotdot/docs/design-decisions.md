# Design Decisions

dotdot is opinionated about multi-repo workspace management. These are the stances we've taken.

## Principles

- **Simple** - Flat structure, `../` paths, minimal concepts
- **Principled** - No magic, predictable behavior, visible config
- **Git-native** - Augment git, don't replace it
- **Independent** - Each repo works on its own
- **Tool-agnostic** - Works with any ecosystem

## Decisions

### 1. Flat Peer Repos

**Decision:** Repos are cloned as peers at the workspace root, never nested.

```
# YES - flat structure
workspace/
├── dotdot-root.json
├── repo-a/
├── repo-b/
└── repo-c/

# NO - nested (submodule style)
workspace/
└── repo-a/
    └── vendor/
        ├── repo-b/
        └── repo-c/
```

**Rationale:**

- Simpler mental model
- Universal `../` paths work everywhere
- Each repo is a first-class citizen
- Avoids nested `.git` issues
- Better IDE and tooling support

### 2. Distributed Configs with Two-Phase Resolution

**Decision:** Each member repo can have its own `dotdot.json` declaring its dependencies. The workspace root has `dotdot-root.json` which is the **single source of truth** for all commands.

**Two-Phase Model:**

1. **Sync Phase (`dotdot sync`):**
   - Collects all member repo configs (`dotdot.json` files)
   - Merges them into `dotdot-root.json`
   - This is the ONLY command that reads member configs

2. **Execution Phase (all other commands):**
   - Read ONLY from `dotdot-root.json`
   - If root config is out of sync with member configs, error and require `dotdot sync`
   - Simple, predictable behavior

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  repo-a/        │     │  repo-b/        │     │  repo-c/        │
│  dotdot.json    │     │  dotdot.json    │     │  (no config)    │
└────────┬────────┘     └────────┬────────┘     └─────────────────┘
         │                       │
         └───────────┬───────────┘
                     │
              dotdot sync
                     │
                     ▼
         ┌───────────────────────┐
         │   dotdot-root.json    │  ◄── Source of truth for all commands
         └───────────────────────┘
```

**Rationale:**

- Each repo can own its own dependency declarations
- Repos remain portable - they work independently
- Root config is the single source of truth (no merging at runtime)
- Clear error when configs are out of sync
- Simpler implementation - commands just read one file
- Predictable behavior - what you see in root config is what you get

### 3. Revision Pinning

**Decision:** Store commit SHAs in config for reproducibility.

```json
{
  "repos": {
    "my-repo": {
      "url": "git@github.com:org/repo.git",
      "rev": "abc123def456..."
    }
  }
}
```

**Rationale:**

- Exact reproducibility
- CI can restore exact workspace state
- Easy to see what changed when pins update
- Git-native (no custom locking)

### 4. Workspace Marker & Config File Separation

**Decision:** Workspace root is marked by `dotdot-root.json`. Member repos use `dotdot.json`. These are mutually exclusive:

```
workspace-root/
├── dotdot-root.json    # ONLY generated config here (no dotdot.json)
├── repo-a/
│   └── dotdot.json          # ONLY regular config here (no generated)
├── repo-b/
│   └── dotdot.json
└── repo-c/                  # repos without config are fine
```

**Rules:**

- Workspace root: ONLY `dotdot-root.json` (never `dotdot.json`)
- Member repos: ONLY `dotdot.json` (never `dotdot-root.json`)

**Rationale:**

- Clear separation prevents ambiguity about which file is authoritative
- Generated config is the single source of truth at workspace level
- Member repos declare dependencies without polluting workspace root
- `dotdot sync <path>` initializes a workspace by creating the generated config
- No confusion about "which config wins" - they exist at different levels

### 5. Git-Native Operations

**Decision:** dotdot calls git directly, doesn't reimplement version control.

**Rationale:**

- Leverage git's reliability and features
- All git commands still work
- No learning curve for git operations
- Easy to debug and understand

### 6. Language-Agnostic Config

**Decision:** Configuration uses JSON format (`dotdot.json`) with optional JSON Schema for editor support.

**Rationale:**

- Works with any language/ecosystem (not just TypeScript)
- Universal JSON format - no runtime dependencies for config
- JSON Schema provides autocomplete and validation in editors
- TypeScript is an implementation detail, not a usage requirement
- Enables use with Rust, Go, Python, or any other toolchain

### 7. Config Semantics: Self-Description vs Dependencies

**Decision:** Member configs have two distinct sections:

- `exposes` - packages THIS repo provides to the workspace
- `deps` - other repos THIS repo depends on

```json
// Member config (dotdot.json)
{
  "exposes": {
    "shared-lib": { "path": "packages/shared", "install": "pnpm build" }
  },
  "deps": {
    "repo-b": { "url": "git@...", "rev": "abc123", "install": "bun install" }
  }
}
```

Root config aggregates all into flat `repos` + `packages` index:

```json
// Root config (dotdot-root.json)
{
  "repos": {
    "repo-a": { "url": "git@...", "rev": "..." },
    "repo-b": { "url": "git@...", "rev": "..." }
  },
  "packages": {
    "shared-lib": { "repo": "repo-a", "path": "packages/shared", "install": "pnpm build" }
  }
}
```

**Rationale:**

- Clear semantic separation - no ambiguity about "who provides what"
- A repo describes itself (exposes) and its needs (deps)
- Root config is a flat aggregation for fast command execution
- Packages index enables efficient symlink creation without scanning

### 8. Repo Validity & Dangling Detection

**Decision:** A repo in the workspace is valid if ANY of these conditions are true:

1. **Has a member config** (`dotdot.json`) - it's a workspace member
2. **Is declared as a dependency** (in some other repo's `deps`) - it's an external dep

Repos that exist in the workspace but have NO config AND are NOT a dependency of anything are considered "dangling" - a warning is shown during sync.

```
workspace/
├── dotdot-root.json
├── repo-a/           # Valid: has dotdot.json (workspace member)
│   └── dotdot.json
├── repo-b/           # Valid: declared as dep in repo-a (external dep)
│   └── (no config)
└── orphan-repo/      # Warning: dangling (no config, nothing depends on it)
    └── (no config)
```

**Rationale:**

- External dependencies (libraries) don't need dotdot configs
- Dangling repos are likely orphaned/forgotten - warn to help cleanup
- Clear rules about what "belongs" in a workspace
- Explicit about workspace membership vs external dependencies

## Anti-Patterns Avoided

- **Reinventing git** - We use git, not replace it
- **Complex dependency resolution** - Not a package manager
- **Requiring connectivity** - Works offline once cloned
- **Hidden state** - Config is visible and version-controllable
- **Vendor lock-in** - Repos work without dotdot
- **Central manifests** - Each repo owns its dependencies

## Trade-offs Accepted

| Trade-off               | Reasoning                                                                        |
| ----------------------- | -------------------------------------------------------------------------------- |
| JSON config (not code)  | Universal format over programmable config - most users don't need dynamic config |
| No branch tracking      | Revisions are more precise, branches can change                                  |
| Manual `packages` setup | Explicit is better than magic symlink detection                                  |
| No workspace-level git  | Each repo manages its own git independently                                      |
| Distributed configs     | Avoids merge conflicts, enables repo portability                                 |
