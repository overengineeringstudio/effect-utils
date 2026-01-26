# Devenv Issues

## Active Workarounds

### DEVENV-01: git-hooks causes shell to hang (devenv 2.0 regression)

**Issue:** https://github.com/cachix/devenv/issues/2433

**Affected repos:**
- schickling-stiftung
- livestore

**Symptoms:**
- `devenv info` works (evaluation succeeds)
- `devenv build` returns `{}` (succeeds)
- `devenv shell` hangs indefinitely, then fails with:
  ```
  Error: × Evaluation error: Failed to realize shell derivation
  ```

**Root cause:** Regression in devenv commit `328752c05f1745c7f613689a9df0bd1ffc8f3922` (Jan 24, 2026). Repos with older devenv locks (`c6267b9`, `a13cd68`) work fine.

**Workaround:** Disable git-hooks in `devenv.nix` AND comment out the beads module import:

```nix
{
  imports = [
    # NOTE: beads module disabled until https://github.com/cachix/devenv/issues/2433 is fixed
    # (inputs.overeng-beads-public.devenvModules.beads {
    #   beadsPrefix = "sch";
    #   beadsRepoName = "schickling-beads";
    # })
    # ... other imports
  ];

  # TODO: Re-enable once https://github.com/cachix/devenv/issues/2433 is fixed
  git-hooks.enable = false;

  enterShell = ''
    # Manual beads env vars (workaround for disabled beads module)
    export BEADS_DB="$PWD/repos/schickling-beads/.beads/beads.db"
    export BEADS_PREFIX="sch"
  '';
}
```

**Important:** Simply setting `git-hooks.enable = false` is NOT sufficient. The beads module from `overeng-beads-public` sets `git-hooks.hooks.beads-commit-correlation.enable = true`, which triggers the git-hooks infrastructure and causes the hang even when the top-level `git-hooks.enable = false` is set.

**Impact:** The beads post-commit hook (correlating commits to issues) is disabled. Commits won't automatically add comments to referenced beads issues. The `BEADS_DB` and `BEADS_PREFIX` env vars are manually set to allow `bd` commands to work.

**Verification:** Not a nix/git-hooks issue - the same config works in a pure nix flake.

**Minimal reproduction:** https://github.com/schickling-repros/devenv-git-hooks-hang

---

## Cleanup checklist when issues are fixed

- **DEVENV-01 fixed:**
  - Remove `git-hooks.enable = false;` from affected repos
  - Re-enable beads module import in affected repos
  - Remove manual `BEADS_DB`/`BEADS_PREFIX` env vars from `enterShell`
  - Affected repos:
    - `schickling-stiftung/devenv.nix`
    - `livestore/devenv.nix` (if applicable)
  - Run `devenv update` to get the fixed devenv version
  - Verify `devenv shell` works with git-hooks and beads module enabled
  - Delete this section from workarounds doc
