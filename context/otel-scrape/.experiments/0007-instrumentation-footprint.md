# Experiment 0007 — devenv instrumentation footprint (task cooperation)

Evidence for [decision 0018](../.decisions/0018-devenv-task-cooperation.md).
Question: on the real devenv path, what does the blanket task wrapper actually
emit, and what is the call-site footprint of wrapping the concrete command
instead?

## Method

`nix build .#otel-scrape` (tip `bbda36a5a`); store `otel-span` for the parent
`devenv.task.exec` span; export to an internal Tempo backend (`http://127.0.0.1:4318`),
TRACEPARENT + protocol vars cleared. Four real trees captured, each rooted at a
genuine `otel-span devenv.task.exec` span, fetched back from the Tempo backend
by trace id. Call-site footprint read from the real task modules
(`lint-oxc.nix` `mkOxlintCmd`, `ts.nix` `tscWithDiagnostics`, `test.nix`
`vitestExec`).

## Findings

1. **Blanket wrap = 100% noise, 0% signal.** `otel-scrape -- bash -c '<otel-span
… -- bash -c body>'` always produces a `program=bash, adapter=none` command
   span ABOVE `devenv.task.exec` (trace `d6887239…`). The concrete command runs
   as a plain `bash -c '<cmd>'` inside otel-span, so no adapter ever fires on the
   devenv path.
2. **adapter=none already fixes it.** Wrapping the concrete command gives
   `devenv.task.exec → tsgo` / `→ node` (traces `b75541b3…`, `0aae67f0…`): a
   named command span with `command.program`, argv/cwd hashes, exit, and merged
   process — for a ~1-line call-site change.
3. **Footprint per family.** oxlint: one prefix at the `command =` binding, low
   friction (execs cleanly through `xargs -0`). tsc: one prefix in
   `tscWithDiagnostics`, medium (phase-span re-parenting — see experiment 0009).
   vitest: `run_package_bin` is a shell _function_, so it needs a small
   restructure (`"$(resolve_package_bin vitest vitest)"`), not a pure prefix.
4. **Token count is not the cost.** The real costs are the `run_package_bin`
   indirection and (for a real adapter) the tool's format flag — not the prefix.

## Verdict

The blanket wrap is pure duplication; wrapping the concrete command is a ~1-line
change that yields a named, correctly-nested command span. The task span (otel-
span) owns the task level; otel-scrape owns the command level (decision 0018).

Findings detail: `tmp/vista-issue866/m4-instrumentation-preview.md` (gitignored).
Trace ids: current `d6887239…`, oxlint `9b9c41ab…`, tsc `b75541b3…`, vitest
`0aae67f0…`.
