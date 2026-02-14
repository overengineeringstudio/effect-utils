# Composition Patterns

For general composition patterns (package structure, dependency conventions, workspace deps, CI patterns), see the `sk-repo-composition` skill in dotfiles. This file covers effect-utils-specific details and workarounds.

## Git Workflow (Worktrees)

To enforce a worktree workflow (no commits on the default branch, and optionally no commits from the primary worktree), import the reusable effect-utils devenv module:

```nix
imports = [
  (inputs.effect-utils.devenvModules.tasks.worktree-guard {})
];
```

## Related Issues

Package manager limitations that motivated the per-package lockfile approach:

- [pnpm#10302](https://github.com/pnpm/pnpm/issues/10302) - No support for extending child workspaces
- [bun#10640](https://github.com/oven-sh/bun/issues/10640) - Filter fails for nested workspaces
- [bun#11295](https://github.com/oven-sh/bun/issues/11295) - ENOENT errors with nested workspaces

See [bun-issues.md](../workarounds/bun-issues.md) for package manager migration plans.

## Tips

- If Effect types mismatch, check for duplicate versions in nested `node_modules`
- **Avoid** these unnecessary workarounds: `preserveSymlinks`, path mappings for Effect, postinstall cleanup scripts, `bunfig.toml` tweaks
