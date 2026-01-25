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

**Workaround:** Disable git-hooks in `devenv.nix`:

```nix
{
  # TODO: Re-enable once https://github.com/cachix/devenv/issues/2433 is fixed
  git-hooks.enable = false;
}
```

**Impact:** The beads post-commit hook (correlating commits to issues) is disabled. Commits won't automatically add comments to referenced beads issues.

**Verification:** Not a nix/git-hooks issue - the same config works in a pure nix flake.

**Minimal reproduction:** https://github.com/schickling-repros/devenv-git-hooks-hang

---

## Cleanup checklist when issues are fixed

- **DEVENV-01 fixed:**
  - Remove `git-hooks.enable = false;` from affected repos:
    - `schickling-stiftung/devenv.nix`
    - `livestore/devenv.nix` (if applicable)
  - Run `devenv update` to get the fixed devenv version
  - Verify `devenv shell` works with git-hooks enabled
  - Delete this section from workarounds doc
