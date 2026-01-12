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
├── dotdot.json
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

### 2. Distributed Configs

**Decision:** Each repo can have its own `dotdot.json` declaring its dependencies. The workspace root config serves as both the workspace marker and a place to declare shared dependencies.

**Rationale:**
- Each repo can own its own dependency declarations
- No single point of failure or merge conflicts
- Repos remain portable - they work independently
- Diamond dependencies are detected and reported
- Deduplication happens automatically at runtime

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

### 4. Workspace Marker

**Decision:** Workspace root is marked by a `dotdot.json` file, discovered by walking up from the current directory.

**Rationale:**
- Works from any subdirectory
- No environment variables required
- Matches git's `.git` discovery pattern
- No hidden state - config file is the marker
- Single file serves dual purpose: workspace marker + shared config

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

## Anti-Patterns Avoided

- **Reinventing git** - We use git, not replace it
- **Complex dependency resolution** - Not a package manager
- **Requiring connectivity** - Works offline once cloned
- **Hidden state** - Config is visible and version-controllable
- **Vendor lock-in** - Repos work without dotdot
- **Central manifests** - Each repo owns its dependencies

## Trade-offs Accepted

| Trade-off | Reasoning |
|-----------|-----------|
| JSON config (not code) | Universal format over programmable config - most users don't need dynamic config |
| No branch tracking | Revisions are more precise, branches can change |
| Manual `packages` setup | Explicit is better than magic symlink detection |
| No workspace-level git | Each repo manages its own git independently |
| Distributed configs | Avoids merge conflicts, enables repo portability |
