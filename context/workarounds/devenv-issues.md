# Devenv Issues

## Active Workarounds

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

### DEVENV-03: Automatic port allocation (`ports.<name>.allocate`) does not pick a free port

**Issue:** https://github.com/cachix/devenv/issues/2484

**Repro:** https://github.com/schickling-repros/2026-02-devenv-port-allocation-ignored

**Affected repos:** Any repo that runs multiple concurrent dev servers across multiple devenv instances

**Symptoms:**

- `config.processes.<name>.ports.<port>.value` stays equal to the base port even when that port is already in use
- Downstream servers fail with `EADDRINUSE`, or (worse) tools like Storybook auto-select a different port and collide with other servers

**Impact on Storybook:**

- Storybook with `--ci` will silently choose another port when the requested port is taken, which can drift into other storybook ports (e.g. base `6009` drifts into `6014`) and cause cascading failures

**Workaround (recommended):**

- Force deterministic failure instead of port drifting by using Storybook `--exact-port` for all Storybook dev processes.

**Additional mitigation:**

- If base ports are contiguous (e.g. `6006..6013`), consider spacing them out to reduce the blast radius when any tool auto-selects ports.

---

### DEVENV-04: Optional task failures can make direnv activation exit non-zero

**Issue:** https://github.com/cachix/devenv/issues/2480

**Affected repos:** Repos that run devenv tasks during shell entry (via `devenv:enterShell`)

**Symptoms:**

- `direnv` activation fails (non-zero exit) when an optional setup task fails
- Shell entry becomes brittle even though failures should be best-effort (R15)

**Workaround (effect-utils):**

- Use shell-entry wrapper tasks (`setup:opt:*`) that run the real task via a nested
  `devenv tasks run ...` and always exit 0 while logging a warning

**Cleanup checklist once upstream is fixed:**

- Remove wrapper tasks (`setup:opt:*`)
- Switch shell-entry optional deps back to native `@complete`
- Remove nested `devenv tasks run ...` calls

---

## Platform Compatibility Issues

### COMPAT-01: Web coding agents have limited Nix/devenv support

**Note:** Not a devenv issue per se, but a platform limitation affecting devenv usage.

**Upstream issues:**

- https://github.com/openai/codex/issues/7636 (toolchains disappearing after setup)
- https://github.com/openai/codex/issues/4843 (direnv/devenv env dropped with `bash --login`)

**Affected platforms:**

| Platform           | Status     | Primary Blocker                                      |
| ------------------ | ---------- | ---------------------------------------------------- |
| Codex Web (OpenAI) | ⚠️ Partial | PATH/env not persisted across command invocations    |
| Claude Code Web    | ⚠️ Partial | Network allowlist excludes Nix caches by default     |
| Codex CLI (local)  | ⚠️ Partial | `bash --login` drops `.devenv/profile/bin` from PATH |

**Codex Web issues:**

- Commands may run in fresh shells, losing PATH/env set during setup
- Secrets are short-lived (injected during setup, then wiped)
- Toolchains (e.g., node/npm) present during setup can be missing in later agent commands

**Claude Code Web issues:**

- "Limited" network mode allowlist does not include `cache.nixos.org` or other Nix domains
- Nix installations fail unless using "Full internet" mode or org-level allowlist customization
- SessionStart hooks can install devenv, but network policy blocks cache fetches

**Workarounds:**

- **Codex Web:** Wrap all commands to run through devenv shell; don't rely on ambient PATH
- **Claude Code Web:** Use "Full internet" mode if available, or request Nix domains be allowlisted
- **Both:** Prefer binary caches (Cachix) to avoid compiling in sandboxes
- **Both:** Make setup scripts defensively re-assert prerequisites

**Research needed:**

- Monitor upstream for network allowlist updates (Claude Code Web)
- Track Codex container environment improvements
- Evaluate alternative approaches (pre-built containers, devcontainers)

---

### COMPAT-02: Devenv git hooks fail in Claude Code (conductor) — `dt` not in PATH

**Affected platforms:** Claude Code (local, via conductor)

**Symptoms:**

The `check-quick` pre-commit hook fails with `No such file or directory (os error 2)` when
Claude Code runs `git commit`. The hook entry is `dt check:quick`, but `dt` is a
Nix-provided binary only available inside the direnv-activated shell. Claude Code's bash
environment doesn't have direnv loaded when git invokes the pre-commit hook subprocess.

```
error: Failed to run hook `check-quick`
  caused by: Run command `run system command` failed
  caused by: No such file or directory (os error 2)
```

**Root cause:**

The `.pre-commit-config.yaml` (generated by `git-hooks.nix`) uses a bare `dt` command:

```yaml
entry: 'dt check:quick'
```

Unlike the `beads-commit-correlation` hook which uses an absolute Nix store path
(`/nix/store/...-beads-post-commit`), the `check-quick` hook relies on `dt` being in PATH.
Git hooks run in a subprocess that doesn't inherit the direnv environment.

**Investigation:**

- `${pkgs.bash}/bin/bash -c 'dt check:quick'` fixes the exec error (bash found via absolute
  path) but `dt` still isn't in PATH inside that bash invocation
- Works when committing from a direnv-activated terminal
- The hook needs either an absolute path to `dt` or needs to source the direnv environment

**Potential fixes:**

- Use an absolute Nix store path for `dt` in the hook entry (like beads does)
- Wrap the hook entry to source direnv: `direnv exec . dt check:quick`
- Use a wrapper script that resolves `dt` from the devenv profile

**Current workaround:** Use `--no-verify` when committing from Claude Code

---

## Cleanup checklist when issues are fixed

- **DEVENV-02 fixed (native OTLP support added via #2415):**
  - When #2415 is fixed: can use native OTLP export to observability platforms
  - Remove manual JSON trace post-processing from CI pipelines
  - Update R10 status in this document to reflect full compliance

- **COMPAT-01 improved (web coding agent support):**
  - When Claude Code Web adds Nix domains to allowlist: update status, remove "Full internet" workaround
  - When Codex fixes PATH persistence: update status, simplify setup scripts
  - When either platform has first-class devenv support: document recommended setup

- **COMPAT-02 fixed (devenv git hooks work in Claude Code):**
  - When hook entry uses absolute path or direnv wrapper: remove `--no-verify` workaround
  - Update this document to mark COMPAT-02 as resolved
