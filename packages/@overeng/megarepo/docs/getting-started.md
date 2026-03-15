# Getting Started

This guide covers installing megarepo and creating a first workspace.

## Installation

```bash
bun add -D @overeng/megarepo
```

Or run it directly:

```bash
bunx @overeng/megarepo
```

## Create a Workspace

```bash
mkdir my-workspace
cd my-workspace
git init
mr init
```

Add members:

```bash
mr add effect-ts/effect
mr add effect-ts/effect#next --name effect-next
mr add effect-ts/effect#v3.0.0 --name effect-v3
mr add ../shared-lib --name shared-lib
```

Materialize the workspace:

```bash
mr fetch --apply
```

That creates `repos/*` symlinks pointing at canonical store worktrees and updates `megarepo.lock`.

## Record the Lock

To explicitly write the lock without fetching (e.g. after local changes):

```bash
mr lock
git add megarepo.json megarepo.lock
git commit -m "Initialize megarepo"
```

## Update Members Intentionally

To move branch-tracking members forward:

```bash
mr fetch --apply
mr fetch --apply --only effect
```

## CI Setup

Use lock application in CI:

```bash
mr apply --git-protocol=https
```

This requires a non-stale `megarepo.lock` and materializes the exact locked commits.

## Next Steps

- [Commands Reference](commands.md)
- [Workflows](workflows.md)
- [Bun Integration](integrations/bun.md)
- [TypeScript Integration](integrations/typescript.md)
