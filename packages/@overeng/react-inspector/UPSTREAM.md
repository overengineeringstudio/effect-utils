# Upstream Tracking

This package is a fork of [storybookjs/react-inspector](https://github.com/storybookjs/react-inspector).

## Upstream Information

- **Original repo:** https://github.com/storybookjs/react-inspector
- **Our fork repo:** https://github.com/overengineeringstudio/react-inspector
- **Last synced:** 2024-12-17
- **Upstream commit:** `c0cfe13` (HEAD of main at sync time)
- **Upstream version:** 8.0.0

## Syncing with Upstream

To sync with upstream changes:

```bash
# Add upstream remote (one-time setup)
git remote add react-inspector-upstream https://github.com/storybookjs/react-inspector

# Fetch upstream changes
git fetch react-inspector-upstream

# View upstream changes since last sync
git log c0cfe13..react-inspector-upstream/main --oneline

# Cherry-pick or manually apply relevant changes to this package
```

## Fork-Specific Changes

See `FORK_CHANGELOG.md` for detailed documentation of all changes made in this fork.

### Summary of Fork Additions

1. **Effect Schema Support** (`src/schema/`)
   - Schema-aware object inspection with Effect annotations
   - `withSchemaSupport()` HOC and `SchemaProvider` context

2. **React 19 Compatibility**
   - Type fixes for React 19 compatibility

3. **Monorepo Integration**
   - Adapted for pnpm workspace with catalog dependencies
   - Uses workspace tsconfig patterns

## Files Structure

```
src/
├── schema/           # Fork addition: Effect Schema support
├── object-inspector/ # Upstream
├── table-inspector/  # Upstream
├── dom-inspector/    # Upstream
├── tree-view/        # Upstream
├── object/           # Upstream
├── styles/           # Upstream
└── utils/            # Upstream
```
