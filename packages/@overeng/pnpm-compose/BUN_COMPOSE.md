# bun-compose Research & Plan

Research and planning for a bun-based equivalent to pnpm-compose.

**Goal**: Long-term migration from pnpm to bun for package management in composed monorepos.

## Test Environment Setup

To reproduce these experiments, create the following structure:

```
consumer-repo/
├── package.json           # Root with workspaces + catalog
├── bunfig.toml            # Optional: linker = "isolated"
├── src/
│   └── main.ts            # Consumer code importing submodule
└── submodules/
    └── lib/               # Git submodule (real directory, not symlink)
        └── packages/
            └── utils/
                ├── package.json   # Workspace package using catalog:
                └── src/
                    └── mod.ts     # Effect-based utility
```

**consumer-repo/package.json:**
```json
{
  "name": "consumer-repo",
  "private": true,
  "workspaces": {
    "packages": ["submodules/lib/packages/*"],
    "catalog": { "effect": "3.12.0" }
  },
  "dependencies": {
    "@lib/utils": "workspace:*",
    "effect": "catalog:"
  }
}
```

**submodules/lib/packages/utils/package.json:**
```json
{
  "name": "@lib/utils",
  "version": "0.1.0",
  "dependencies": {
    "effect": "catalog:"
  }
}
```

## Experiment Results (2026-01-08)

### Finding 1: Symlinks in workspace globs

**❌ Bun does NOT follow symlinks in workspace glob patterns**

```bash
# This fails - symlink not followed
"workspaces": ["submodules/lib/packages/*"]  # where lib is a symlink
# Error: "Searched in './*'" - bun falls back to default
```

**✅ Real directories work fine (git submodules are real directories)**

```bash
# This works - git submodule is a real directory
"workspaces": ["submodules/lib/packages/*"]  # where lib is copied/cloned
# Success: workspace packages discovered
```

**Impact**: Not a blocker - git submodules are real directories, not symlinks.

### Finding 2: No linking dance needed

**✅ Bun doesn't create node_modules in workspace packages by default**

Unlike pnpm which creates `node_modules` in each workspace package, bun's isolated linker stores everything in root `node_modules/.bun/`:

```
consumer/
├── node_modules/
│   ├── .bun/
│   │   ├── effect@3.12.0/
│   │   └── ...
│   └── @lib/
│       └── utils -> ../../submodules/lib/packages/utils  # symlink to source
└── submodules/lib/
    └── packages/utils/
        └── (no node_modules!)  ← Key difference from pnpm
```

**✅ Running `bun install` in submodule doesn't corrupt parent**

Even if someone runs `bun install` in the submodule, it creates a separate node_modules that doesn't interfere with the parent workspace. This eliminates the need for the guard wrapper.

### Finding 3: Catalog enforces version alignment

**❌ Version mismatch causes runtime errors**

```
# consumer: effect@3.12.0, submodule: effect@3.11.0
RuntimeException: Cannot execute an Effect versioned 3.11.0 with a Runtime of version 3.12.0
```

**✅ Root catalog with `catalog:` protocol works**

```json
// consumer/package.json
{
  "workspaces": {
    "packages": ["submodules/lib/packages/*"],
    "catalog": { "effect": "3.12.0" }
  }
}

// submodule package uses catalog:
{ "dependencies": { "effect": "catalog:" } }
```

Result: Single version installed, code works.

### Finding 4: Submodule resolution

**✅ Submodule packages resolve deps from root node_modules**

```bash
# From submodule directory:
cd submodules/lib/packages/utils
bun -e "import { Effect } from 'effect'; console.log('works!')"
# Success - resolves from root node_modules/.bun/
```

## Comparison: pnpm-compose vs bun-compose

| Feature | pnpm | bun | Notes |
|---------|------|-----|-------|
| Submodule in workspace | ✅ | ✅ | Both work with real directories |
| Symlink in glob | ✅ | ❌ | Bun doesn't follow symlinks |
| Linking dance needed | **Yes** | No | Major simplification |
| Submodule install corruption | Risk | **Safe** | Bun isolates better |
| Catalog location | pnpm-workspace.yaml | package.json | Different file |
| Catalog alignment | Manual check | Manual check | Same need |
| Version mismatch | Runtime error | Runtime error | Both need alignment |

## Key Architecture Difference

```
pnpm approach:                     bun approach:
─────────────────────────────────  ─────────────────────────────────
consumer/                          consumer/
├── node_modules/                  ├── node_modules/
│   └── .pnpm/...                  │   ├── .bun/effect@3.12.0/
└── submodules/lib/                │   └── @lib/utils -> ...
    └── packages/utils/            └── submodules/lib/
        └── node_modules/ ⚠️           └── packages/utils/
            └── effect -> ...              └── (clean!) ✅

pnpm: Each workspace pkg gets      bun: All deps in root .bun/,
      its own node_modules               workspace pkgs stay clean
      → requires linking dance           → just works
```

## bun-compose: Simplified Scope

With bun, the compose tool becomes much simpler:

### What's NOT needed (vs pnpm-compose)

1. ~~Symlink dance~~ - bun handles workspace packages correctly
2. ~~Guard wrapper~~ - submodule installs don't corrupt parent
3. ~~node_modules cleanup~~ - bun doesn't pollute submodules

### What IS needed

1. **Catalog alignment check** - validate versions match across repos
2. **Genie integration** - compose package.json from child repos
3. **List command** - show composed repos and their status

### Proposed CLI

```bash
bun-compose check    # Validate catalog alignment across repos
bun-compose list     # Show composed repos and catalog status
bun-compose install  # Just runs `bun install` (no dance needed)
```

### Proposed Config

Same as pnpm-compose, reuse existing config:

```ts
// bun-compose.config.ts (or reuse pnpm-compose.config.ts)
export default {
  exclude: [
    'submodules/effect',    // Reference-only
    'submodules/mautrix-x', // Reference-only
  ],
}
```

## Bun Workspace Features Reference

| Feature | Status | Notes |
|---------|--------|-------|
| Workspaces | ✅ | `"workspaces": ["packages/*"]` in package.json |
| Catalog | ✅ | `workspaces.catalog` or top-level `catalog` |
| `workspace:*` protocol | ✅ | Standard workspace dependency syntax |
| `catalog:` protocol | ✅ | References catalog versions |
| Isolated linker | ✅ | `linker = "isolated"` in bunfig.toml |
| `linkWorkspacePackages` | ✅ | Can disable auto-linking (v1.2.16+) |
| Text lockfile | ✅ | `bun.lock` (default since v1.2) |

## Implementation Plan

### Phase 1: Validate with real complexity

- [ ] Test with real-world structure (3+ submodules, 100+ packages)
- [ ] Test standalone submodule operation (can submodule work alone?)
- [ ] Measure performance vs pnpm

### Phase 2: bun-compose MVP

- [ ] Fork pnpm-compose structure or create new package
- [ ] Implement `check` command (catalog alignment)
- [ ] Implement `list` command
- [ ] Implement `install` command (thin wrapper around `bun install`)

### Phase 3: Genie integration

- [ ] Support bun's catalog format in package.json.genie.ts
- [ ] Compose workspaces.catalog from child repos
- [ ] Validate during genie generation

### Phase 4: Migration

- [ ] Migrate effect-utils to bun internally
- [ ] Test composition in a consumer repo
- [ ] Plan consumer repo migration

## Open Questions

1. **Lockfile in submodules**: What if submodule has its own `bun.lock`? Does it conflict?
2. **Standalone operation**: Can submodule work standalone AND as composed workspace?
3. **CI/CD**: How to set up bun in GitHub Actions with Nix?
4. **Publishing**: Does `bun publish` handle `catalog:` replacement correctly?

## Related Resources

- [Bun Workspaces Guide](https://bun.sh/docs/guides/install/workspaces)
- [Bun Catalogs](https://bun.com/docs/pm/catalogs)
- [Bun Linker Config](https://bun.sh/docs/runtime/bunfig)
- [Issue: linkWorkspacePackages](https://github.com/oven-sh/bun/issues/8811) - resolved v1.2.16
- [Issue: Catalog bugs in v1.3](https://github.com/oven-sh/bun/issues/23615)

## Conclusion

**bun-compose is viable and significantly simpler than pnpm-compose.**

The main complexity (symlink dance) is eliminated. The tool becomes a thin wrapper focused on catalog alignment validation, which is the same problem we solve with pnpm-compose today.

Migration path: Start with effect-utils as a test case, then expand to consumer repos.
