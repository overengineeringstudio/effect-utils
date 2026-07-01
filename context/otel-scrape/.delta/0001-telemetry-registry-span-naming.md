# Delta 0001 — Telemetry registry lags the 0014 span-naming scheme

**Divergence:** [.decisions/0014](./.decisions/0014-command-identity-and-span-naming.md)
and the spec now define span names as a *scheme* (span named by the operation:
program basename / adapter phase / descendant basename) with `otel-scrape`
carried in `span.origin` + `otel.scope.name`, and rename
`process.command_args_hash` to `command.argv_hash`. The generated
`telemetry-registry.json` still declares the old fixed constants
(`otel_scrape.command`, `otel_scrape.process`, `process.command_args_hash`) and
lacks the new keys (`command.program`, `command.argv`, `command.cwd`,
`command.cwd_hash`, `span.origin`, `otel.scope.name`, `merged` fidelity value).

**Also lagging:** any test that asserts the command span name equals the literal
`"otel_scrape.command"` (see 0014 consequences).

**Resolution (implementation follow-up):** update the registry source and
regenerate the Rust/TypeScript bindings so the naming scheme, renamed key, and
new `command.*` / `span.origin` / `otel.scope.name` attributes are the source of
truth; update the span-name assertion test to check the scheme
(basename + `span.origin = otel-scrape`) rather than a fixed string. Until then,
the spec/decision is the intended contract and the generated registry is stale.
