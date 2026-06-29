# otel-scrape

`otel-scrape` wraps a command, preserves passthrough stdout/stderr/exit status,
and provides the Rust package boundary for command-wrapper telemetry.

The wrapper is deliberately transparent by default: without `--summary-out`,
`OTEL_SCRAPE_SUMMARY_OUT`, `--otlp-endpoint`, or
`OTEL_EXPORTER_OTLP_ENDPOINT`, it runs the child without writing local evidence
or exporting telemetry.

```bash
otel-scrape -- cargo test
otel-scrape cargo test
otel-scrape --adapter oxlint --summary-out ./summary.json -- oxlint --format=json src
otel-scrape --otlp-endpoint http://127.0.0.1:4318 -- cargo test
```

The script-visible contract is the important part of this milestone: stdout,
stderr, stdin, and child exit status are preserved. The wrapper also creates or
joins a W3C `traceparent` and exports the child context through both
`traceparent` and `TRACEPARENT`.

When `--summary-out <file>` or `OTEL_SCRAPE_SUMMARY_OUT` is set, the wrapper
writes local JSON evidence with hashed argv/cwd identity, child exit status,
duration, trace join/root facts, and explicit degraded flags for direct-child-only
process capture.

When `--otlp-endpoint <url>` or `OTEL_EXPORTER_OTLP_ENDPOINT` is set, the
wrapper exports one `otel_scrape.command` span through the first-party
OTLP/HTTP JSON boundary after the child exits. `--service-name <name>` or
`OTEL_SERVICE_NAME` sets the emitted resource `service.name`. Export failures
are warnings and do not change stdout, stderr, stdin, or the child exit code.
Adapter-derived OTLP events and profile-link events are attached to the command
span. Adapter metrics and release-grade descendant process-tree spans are
follow-up milestones.

`--adapter oxlint` parses oxlint JSON from stdout after preserving the child
stdout bytes, recording a diagnostics metric and diagnostic events in the
summary. Diagnostic filenames are hashed instead of copied into telemetry
evidence.

Telemetry semantic names are generated from
`context/otel-scrape/telemetry-registry.json` into Rust and TypeScript bindings;
update the registry source and run `devenv tasks run genie:run` instead of
editing generated constants by hand.
