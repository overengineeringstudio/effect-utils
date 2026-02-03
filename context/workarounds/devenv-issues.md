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

**Related:**

- https://github.com/cachix/devenv/issues/2456 (docs: clarify `--trace-output` requirement)
- https://github.com/cachix/devenv/issues/1457 (Task Server Protocol - proposes JSON-RPC with timestamps)

**Affected repos:** All repos using devenv tasks that need CI observability

**Symptoms:**

- No native OTLP export to observability systems (Datadog, Honeycomb, etc.)
- No summary statistics (total wall time, parallelism efficiency, cache hit rates)
- No historical metrics tracking across CI runs

**Current capabilities (devenv 2.0.0):**

JSON traces are available but require `--trace-output` (traces are disabled by default):

```bash
# Enable JSON traces to a file
devenv tasks run <task> --no-tui --trace-output file:/tmp/trace.json --trace-format json

# Or output to stdout/stderr
devenv tasks run <task> --no-tui --trace-output stdout --trace-format json
```

JSON trace output includes:

- Per-task start/complete events with timestamps
- Span context with parent/child relationships (span_id, parent_id)
- Activity kinds: task, command, evaluate, operation
- Outcomes: success, cached, failure
- Command paths executed

Example trace event:

```json
{
  "fields": {
    "event": {
      "activity_kind": "task",
      "event": "complete",
      "id": 9223372036854775817,
      "name": "ts:check",
      "outcome": "success",
      "timestamp": "2026-02-03T14:08:00.556348000Z"
    }
  },
  "span_context": { "span_id": 274877906946, "parent_id": 274877906945 }
}
```

**R10 requirements gap analysis:**

| Requirement                       | Status       | Notes                                             |
| --------------------------------- | ------------ | ------------------------------------------------- |
| (a) Per-task timing               | ✅ Available | Via `--trace-output` JSON with timestamps         |
| (b) Dependency visualization      | ✅ Available | Via span parent/child relationships in JSON       |
| (c) Stdout/stderr capture         | ⚠️ Partial   | Available with `--show-output`, not in trace JSON |
| (d) Structured export (JSON/OTLP) | ⚠️ Partial   | JSON available, OTLP not yet implemented          |
| (e) Summary statistics            | ❌ Missing   | Must be computed from raw trace events            |
| (f) Metrics over time             | ❌ Missing   | No built-in cross-run tracking                    |

**Workaround:** Use `--trace-output file:<path> --trace-format json` to get structured traces, then post-process for observability platforms.

**Potential upstream contribution:** Issue #2415 proposes adding native OTLP export using `tracing-opentelemetry` crate.

---

## Cleanup checklist when issues are fixed

- **DEVENV-01 fixed:**
  - Remove `inputs.effect-utils.devenvModules.tasks.git-hooks-fix` import from all repos
  - Remove `./nix/devenv-modules/tasks/shared/git-hooks-fix.nix` import from effect-utils devenv.nix
  - Optionally remove `git-hooks-fix.nix` module and flake export (or keep for backwards compat)
  - Verify hooks are installed on fresh clone without the workaround

- **DEVENV-02 fixed (native OTLP support added via #2415):**
  - When #2415 is fixed: can use native OTLP export to observability platforms
  - Remove manual JSON trace post-processing from CI pipelines
  - Update R10 status in this document to reflect full compliance
