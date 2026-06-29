# otel-scrape

`otel-scrape` wraps a command, preserves passthrough stdout/stderr/exit status,
and provides the Rust package boundary for the future telemetry wrapper.

This first crate slice is deliberately transparent: it does not export OTLP,
derive adapter telemetry, or claim release-grade descendant process-tree
fidelity yet.

```bash
otel-scrape -- cargo test
otel-scrape cargo test
```

The script-visible contract is the important part of this milestone: stdout,
stderr, stdin, and child exit status are preserved. The wrapper also creates or
joins a W3C `traceparent` and exports the child context through both
`traceparent` and `TRACEPARENT`.

When `--summary-out <file>` or `OTEL_SCRAPE_SUMMARY_OUT` is set, the wrapper
writes local JSON evidence with hashed argv/cwd identity, child exit status,
duration, trace join/root facts, and explicit degraded flags for direct-child-only
process capture and absent OTLP export. Later milestones can add command spans,
adapter parsing, and CAS profile links without changing the pass-through
boundary.

Telemetry semantic names are generated from
`context/otel-scrape/telemetry-registry.json` into Rust and TypeScript bindings;
update the registry source and run `devenv tasks run genie:run` instead of
editing generated constants by hand.
