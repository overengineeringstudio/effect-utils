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

## Platform Compatibility Issues

### COMPAT-01: Web coding agents have limited Nix/devenv support

**Note:** Not a devenv issue per se, but a platform limitation affecting devenv usage.

**Upstream issues:**

- https://github.com/openai/codex/issues/7636 (toolchains disappearing after setup)
- https://github.com/openai/codex/issues/4843 (direnv/devenv env dropped with `bash --login`)

**Affected platforms:**

| Platform              | Status       | Primary Blocker                                      |
| --------------------- | ------------ | ---------------------------------------------------- |
| Codex Web (OpenAI)    | ⚠️ Partial   | PATH/env not persisted across command invocations    |
| Claude Code Web       | ⚠️ Partial   | Network allowlist excludes Nix caches by default     |
| Codex CLI (local)     | ⚠️ Partial   | `bash --login` drops `.devenv/profile/bin` from PATH |

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

## Cleanup checklist when issues are fixed

- **DEVENV-02 fixed (native OTLP support added via #2415):**
  - When #2415 is fixed: can use native OTLP export to observability platforms
  - Remove manual JSON trace post-processing from CI pipelines
  - Update R10 status in this document to reflect full compliance

- **COMPAT-01 improved (web coding agent support):**
  - When Claude Code Web adds Nix domains to allowlist: update status, remove "Full internet" workaround
  - When Codex fixes PATH persistence: update status, simplify setup scripts
  - When either platform has first-class devenv support: document recommended setup
