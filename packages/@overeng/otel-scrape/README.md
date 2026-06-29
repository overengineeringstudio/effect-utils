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
otel-scrape --adapter node-cpuprofile --summary-out ./summary.json \
  --cas-root ./otel-scrape-cas --cas-pin runs/local -- node ./script.js
otel-scrape --otlp-endpoint http://127.0.0.1:4318 --service-name build-wrapper \
  -- cargo test
```

The script-visible contract is the important part of this milestone: stdout,
stderr, stdin, and child exit status are preserved. The wrapper also creates or
joins a W3C `traceparent` and exports the child context through both
`traceparent` and `TRACEPARENT`.

## CLI

```text
otel-scrape [--summary-out <file>]
  [--adapter none|oxlint|node-cpuprofile]
  [--otlp-endpoint <url>]
  [--service-name <name>]
  [--cas-root <dir>]
  [--cas-pin <name>]
  [--profile-artifact <type>:<path>]
  -- <cmd...>
```

Environment fallbacks:

| CLI flag          | Environment fallback          | Purpose                                                    |
| ----------------- | ----------------------------- | ---------------------------------------------------------- |
| `--summary-out`   | `OTEL_SCRAPE_SUMMARY_OUT`     | Write local JSON summary evidence.                         |
| `--cas-root`      | `OTEL_SCRAPE_CAS_ROOT`        | Store profile artifacts and manifests in a local CAS root. |
| `--otlp-endpoint` | `OTEL_EXPORTER_OTLP_ENDPOINT` | Export the wrapper command span over OTLP/HTTP JSON.       |
| `--service-name`  | `OTEL_SERVICE_NAME`           | Set the emitted OTLP resource `service.name`.              |

`--cas-pin` writes a manifest pin under the CAS root and requires at least one
profile artifact source. `--profile-artifact <type>:<path>` is the explicit
artifact ingestion path for tests and tools that already produced a profile.
`--adapter node-cpuprofile` discovers the Node/V8 `.cpuprofile` artifact itself
and therefore also requires `--cas-root` or `OTEL_SCRAPE_CAS_ROOT`.

## Summary And Export Modes

When `--summary-out <file>` or `OTEL_SCRAPE_SUMMARY_OUT` is set, the wrapper
writes local JSON evidence with hashed argv/cwd identity, child exit status,
duration, trace join/root facts, artifact links, adapter records, output
descriptors for captured streams, and explicit degraded flags for
direct-child-only process capture. Summary evidence is a local debug and test
surface; it is not the OTLP transport.

When `--otlp-endpoint <url>` or `OTEL_EXPORTER_OTLP_ENDPOINT` is set, the
wrapper exports one `otel_scrape.command` span and one degraded direct-child
`otel_scrape.process` span through the first-party OTLP/HTTP JSON boundary after
the child exits. `--service-name <name>` or `OTEL_SERVICE_NAME` sets the emitted
resource `service.name`. Export failures are warnings and do not change stdout,
stderr, stdin, or the child exit code.
Adapter-derived OTLP events and profile-link events are attached to the command
span. Adapter metrics and release-grade descendant process-tree spans are
follow-up milestones.

## Adapters

`--adapter oxlint` parses oxlint JSON from stdout after preserving the child
stdout bytes, recording a diagnostics metric and diagnostic events in the
summary. Diagnostic filenames are hashed instead of copied into telemetry
evidence.

`--adapter node-cpuprofile` supports direct Node child commands. The wrapper
adds Node's documented CPU-profile flags, stores the produced `.cpuprofile`
through the CAS lane, records a manifest pin when configured, and emits a
profile-link event on the OTLP command span. If the child is not Node, no profile
is produced, multiple profiles are produced, or the profile is malformed, the
adapter records degraded evidence without changing the child exit status.

Additional build-tool adapters are intentionally not release scope until each
one lands as a vertical slice with structured input, privacy tests, degradation
tests, and consumer evidence.

## Artifact Retention

Profile links use `cas:sha256/...` URIs. The URI is location-independent; the run
must retain or upload the CAS root as the artifact tree that resolves it.
Consumers verify the digest and byte length before using the artifact bytes.

For CI, publish the entire CAS root for the run and keep the selected
`--cas-pin` manifest as the handoff root. The pin names the set of profile
artifacts that should survive cleanup.

## Support Matrix

| Capability                                      | Current release claim           | Notes                                                                                                                                                    |
| ----------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Passthrough stdout/stderr/stdin and exit status | Supported                       | Wrapper diagnostics go to stderr. Optional summary/export failures do not replace the child exit code.                                                   |
| W3C trace context root-or-join propagation      | Supported                       | The child receives `traceparent` and `TRACEPARENT`.                                                                                                      |
| Local summary evidence                          | Supported                       | Raw argv, cwd, paths, output payloads, source text, and credentials are not embedded.                                                                    |
| OTLP command span export                        | Supported                       | Emits command span, one degraded direct-child process span, adapter events, and profile-link events over OTLP/HTTP JSON.                                 |
| CAS profile links                               | Supported                       | Profile bytes are stored under `--cas-root`; summaries and OTLP events carry `cas:` URIs plus descriptors, not raw bytes or local paths.                 |
| Adapter metrics as OTLP metrics                 | Not a release claim             | Adapter metrics remain local summary records until trace-correlated metric semantics are explicit.                                                       |
| Descendant process-tree spans                   | Not a release claim             | Current evidence is explicitly degraded/direct-child-only. Exact descendant spans need platform backend validation before being documented as supported. |
| `oxlint` adapter                                | Supported                       | Parses structured JSON diagnostics while preserving stdout.                                                                                              |
| `node-cpuprofile` adapter                       | Supported first profile adapter | Direct Node child commands only; degraded evidence is recorded for unsupported or malformed profile cases.                                               |

Telemetry semantic names are generated from
`context/otel-scrape/telemetry-registry.json` into Rust and TypeScript bindings;
update the registry source and run `devenv tasks run genie:run` instead of
editing generated constants by hand.
