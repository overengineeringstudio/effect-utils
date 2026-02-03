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

### DEVENV-02: Task tracing lacks OTLP export and observability features

**Issue:** https://github.com/cachix/devenv/issues/2415 (OTEL support feature request)

**Related issues:**
- https://github.com/cachix/devenv/issues/1457 (Task Server Protocol - proposes JSON-RPC with timestamps)
- https://github.com/cachix/devenv/pull/2239 (Added `--trace-format` option)

**Note:** The `--trace-format json` option (added in PR #2239) currently outputs empty `{}` in devenv 2.0.0. All three formats (json, full, pretty) produce identical TUI-style output. This appears to be a bug or incomplete implementation.

**Affected repos:** All repos using devenv tasks that need CI observability

**Symptoms:**

- Cannot export task traces to external observability systems (Datadog, Honeycomb, etc.)
- No summary statistics (total wall time, parallelism efficiency, cache hit rates)
- No historical metrics tracking across CI runs
- Dependency graphs not visualizable beyond what's declared in nix

**Current capabilities (devenv 2.0.0):**

```bash
# Verbose mode provides useful trace info
devenv tasks run <task> --verbose --no-tui

# Output includes:
# - Flake input fingerprints
# - Eval/build cache hit status
# - Per-task: "Running task 'X' with exec_if_modified: [], status: false"
# - Per-task timing: "Succeeded X (1.79s)"
# - File state tracking paths

# Note: --trace-format {json,full,pretty} all output empty "{}" - appears broken
```

The `--verbose` flag provides per-task timing visible in TUI output, but lacks:
- OTLP/OpenTelemetry export
- Critical path analysis
- Summary statistics
- Metrics aggregation over time

**R10 requirements gap analysis:**

| Requirement | Status | Notes |
|-------------|--------|-------|
| (a) Per-task timing | ⚠️ Partial | Visible in `--verbose` text output only |
| (b) Dependency visualization | ⚠️ Partial | Declared in nix, no graph analysis tool |
| (c) Stdout/stderr capture | ⚠️ Partial | Available with `--show-output`, not structured |
| (d) Structured export (JSON/OTLP) | ❌ Broken | `--trace-format json` outputs empty `{}` |
| (e) Summary statistics | ❌ Missing | No parallelism efficiency, cache hit rates |
| (f) Metrics over time | ❌ Missing | No cross-run tracking |

**Workaround:** For CI observability, parse the `--verbose --no-tui` text output and forward to your observability platform manually. The `--trace-format json` option is currently broken.

**Potential upstream contribution:** Issue #2415 proposes adding OTLP export using `tracing-opentelemetry` crate. The implementation would convert activity events into OTEL spans with attributes like activity kind, derivation path, build phase, and outcome.

---

## Cleanup checklist when issues are fixed

- **DEVENV-01 fixed:**
  - Remove `inputs.effect-utils.devenvModules.tasks.git-hooks-fix` import from all repos
  - Remove `./nix/devenv-modules/tasks/shared/git-hooks-fix.nix` import from effect-utils devenv.nix
  - Optionally remove `git-hooks-fix.nix` module and flake export (or keep for backwards compat)
  - Verify hooks are installed on fresh clone without the workaround

- **DEVENV-02 fixed (native OTLP support added):**
  - Remove manual JSON parsing workarounds from CI pipelines
  - Update CI to use native OTLP export
  - Update R10 status in this document to reflect full compliance
