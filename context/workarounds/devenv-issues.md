# Devenv Issues

## Active Workarounds

### DEVENV-01: git-hooks not installed when symlink exists (git-hooks.nix bug)

**Issue:** https://github.com/cachix/devenv/issues/2455

**Affected repos:** All repos using devenv with `git-hooks.hooks.*` configuration

**Symptoms:**

- `.pre-commit-config.yaml` symlink exists and points to correct nix store path
- But `.git/hooks/pre-commit` (and other configured hooks) don't exist
- Pre-commit hooks don't run on `git commit`

**Root cause:** The `devenv-git-hooks-install` script uses the `.pre-commit-config.yaml` symlink as a proxy for "hooks are installed". However, `devenv:files` creates this symlink BEFORE `devenv:git-hooks:install` runs, causing the install script to skip the actual hook installation.

**Workaround:** Import the `git-hooks-fix` module from effect-utils:

```nix
# In devenv.nix
imports = [
  inputs.effect-utils.devenvModules.tasks.git-hooks-fix
  # ... other imports
];
```

This adds a `git-hooks:ensure` task that runs after `devenv:git-hooks:install` and uses `prek` to directly install any missing hooks.

**Minimal reproduction:** https://github.com/schickling-repros/devenv-git-hooks-not-installed

---

## Cleanup checklist when issues are fixed

- **DEVENV-01 fixed:**
  - Remove `inputs.effect-utils.devenvModules.tasks.git-hooks-fix` import from all repos
  - Remove `./nix/devenv-modules/tasks/shared/git-hooks-fix.nix` import from effect-utils devenv.nix
  - Optionally remove `git-hooks-fix.nix` module and flake export (or keep for backwards compat)
  - Verify hooks are installed on fresh clone without the workaround
