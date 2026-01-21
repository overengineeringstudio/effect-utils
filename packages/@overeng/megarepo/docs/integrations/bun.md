# Bun Integration

This guide covers setting up bun workspaces with megarepo members.

## Workspace Configuration

Create a `package.json` in your megarepo root with workspace patterns:

```json
{
  "name": "my-megarepo",
  "private": true,
  "workspaces": ["effect/packages/*", "other-lib/packages/*", "local-lib"]
}
```

**Note:** Since members are symlinks, you reference their actual package paths.

## Discovering Packages

Use environment variables to dynamically discover member packages:

```bash
# .envrc
source_env_if_exists .envrc.local

# MEGAREPO_MEMBERS is now available
# e.g., "effect,other-lib,local-lib"
```

## Installing Dependencies

```bash
# Install all workspace dependencies
bun install

# Or use megarepo exec
mr exec "bun install"
```

## Cross-Member Dependencies

Members can depend on each other using workspace protocol:

```json
{
  "name": "@my-org/app",
  "dependencies": {
    "effect": "workspace:*",
    "@other/lib": "workspace:*"
  }
}
```

Bun resolves these to the local workspace packages.

## Scripts Across Members

Run scripts across all members:

```bash
# Run build in all members
mr exec "bun run build"

# Run tests
mr exec "bun test"

# Run a specific script
mr exec "bun run lint:fix"
```

## Example Directory Structure

```
my-megarepo/
├── package.json           # Root workspace config
├── bun.lock              # Root lockfile
├── megarepo.json
├── megarepo.lock
├── effect -> ~/.megarepo/.../
│   └── packages/
│       ├── effect/
│       │   └── package.json
│       └── platform/
│           └── package.json
├── other-lib -> ~/.megarepo/.../
│   └── packages/
│       └── core/
│           └── package.json
└── local-lib/
    └── package.json
```

## Tips

### Separate Lockfiles

Each member maintains its own lockfile. The root `bun.lock` handles workspace resolution:

```bash
# Update root lockfile
bun install

# Update a member's dependencies
cd effect
bun install
```

### Hoisting

Bun hoists common dependencies to the root `node_modules`. Members' `node_modules` contain symlinks to the hoisted packages.

### Watching Across Members

For development servers that watch for changes:

```bash
# Run dev server that watches all workspace packages
bun run dev
```

Since members are symlinks, file watchers see changes immediately.
