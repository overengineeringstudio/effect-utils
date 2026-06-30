# otel-scrape

`otel-scrape` wraps a command, preserves passthrough stdout/stderr/exit status,
and provides the Rust package boundary for command-wrapper telemetry.

The wrapper is deliberately transparent by default: without `--summary-out`,
`OTEL_SCRAPE_SUMMARY_OUT`, `--otlp-endpoint`,
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, or `OTEL_EXPORTER_OTLP_ENDPOINT`, it runs
the child without writing local evidence or exporting telemetry.

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
  [--process-backend direct-child|ptrace-experimental|helper-stream]
  [--process-helper-socket <path>]
  [--otlp-endpoint <url>]
  [--service-name <name>]
  [--cas-root <dir>]
  [--cas-pin <name>]
  [--profile-artifact <type>:<path>]
  -- <cmd...>
```

Environment fallbacks:

| CLI flag                  | Environment fallback                | Purpose                                                    |
| ------------------------- | ----------------------------------- | ---------------------------------------------------------- |
| `--summary-out`           | `OTEL_SCRAPE_SUMMARY_OUT`           | Write local JSON summary evidence.                         |
| `--cas-root`              | `OTEL_SCRAPE_CAS_ROOT`              | Store profile artifacts and manifests in a local CAS root. |
| `--otlp-endpoint`         | `OTEL_EXPORTER_OTLP_ENDPOINT`       | Export the wrapper command span over OTLP/HTTP JSON.       |
| `--service-name`          | `OTEL_SERVICE_NAME`                 | Set the emitted OTLP resource `service.name`.              |
| `--process-backend`       | `OTEL_SCRAPE_PROCESS_BACKEND`       | Select process observation backend.                        |
| `--process-helper-socket` | `OTEL_SCRAPE_PROCESS_HELPER_SOCKET` | Select the helper-stream socket path.                      |

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
direct-child-only process capture unless an exact backend is explicitly
selected. Summary evidence is a local debug and test surface; it is not the
OTLP transport.

When `--otlp-endpoint <url>`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, or
`OTEL_EXPORTER_OTLP_ENDPOINT` is set, the wrapper exports one
`otel_scrape.command` span and process spans from the active process backend
through the first-party OTLP/HTTP JSON boundary after the child exits.
`OTEL_EXPORTER_OTLP_ENDPOINT` is treated as an OTLP/HTTP base URL and appends
`/v1/traces`; `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is signal-specific and used
as-is. `--service-name <name>` or `OTEL_SERVICE_NAME` sets the emitted resource
`service.name` and takes precedence over `service.name` from
`OTEL_RESOURCE_ATTRIBUTES`. Export failures are warnings and do not change
stdout, stderr, stdin, or the child exit code.
Adapter-derived OTLP events and profile-link events are attached to the command
span. Adapter metrics remain local summary records.

Supported OpenTelemetry SDK/exporter environment variables:

| Env var                                                              | Behavior                                                                                                    |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `OTEL_SDK_DISABLED=true`                                             | Disables trace export without affecting the child command.                                                  |
| `OTEL_TRACES_EXPORTER=none` / `otlp`                                 | Disables export or enables the OTLP path. Unrecognized enum values warn and are ignored.                    |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                                        | Generic OTLP/HTTP base URL; traces are sent below `/v1/traces`.                                             |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`                                 | Trace endpoint override; used as-is, with `/` for an empty path.                                            |
| `OTEL_EXPORTER_OTLP_HEADERS`                                         | Generic OTLP headers.                                                                                       |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS`                                  | Trace headers override the generic header config for trace export.                                          |
| `OTEL_EXPORTER_OTLP_TIMEOUT` / `OTEL_EXPORTER_OTLP_TRACES_TIMEOUT`   | Export timeout in milliseconds; trace-specific wins.                                                        |
| `OTEL_EXPORTER_OTLP_PROTOCOL` / `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` | `http/json` is supported. `grpc` and `http/protobuf` disable this first-party JSON exporter with a warning. |
| `OTEL_RESOURCE_ATTRIBUTES`                                           | Comma-separated resource attributes added to OTLP resources.                                                |
| `OTEL_SERVICE_NAME`                                                  | Resource `service.name`; overrides `service.name` from resource attrs.                                      |

Empty OTEL env vars are treated as unset. Boolean parsing follows the official
OpenTelemetry SDK convention: only case-insensitive `true` is true.
Known trace exporters not implemented by this first-party exporter, such as
`zipkin`, warn and disable the JSON exporter rather than silently sending OTLP
after a non-OTLP exporter was requested.
This first-party exporter supports plain `http://` OTLP endpoints. Use a
collector-local HTTP endpoint for dogfooding today; `https://`, gRPC, and
protobuf belong behind a future full SDK/protobuf transport instead of a partial
TLS implementation in this wrapper.

## Process Backends

`direct-child` is the default process backend. It records only the spawned child
process and marks process evidence as degraded with `reason =
"direct-child-only"`.

On Linux, `ptrace-experimental` observes fork/vfork/clone, exec, and exit events
for the traced child tree. It can emit exact descendant process spans for the
validated fixture, including immediate-exit and nested descendants. The backend
is opt-in because ptrace can perturb command execution and has platform,
privilege, and namespace caveats.

The future Linux default exact backend is expected to be helper-backed rather
than ptrace-backed. eBPF process lifecycle tracepoints are the primary candidate;
process connector style feeds are fallback candidates only if they can prove
scoped completeness and event-loss handling. `/proc` snapshots and filesystem
notification APIs remain degraded enrichment sources, not exact process-tree
sources. macOS remains degraded/direct-child unless an Endpoint Security-backed
exact backend is implemented and validated.

`helper-stream` is the public wrapper-side contract for that future helper. In
this slice it is fail-closed: selecting it records `backend = "helper-stream"`
but keeps process evidence degraded until a validated helper stream proves
loss-free lifecycle coverage. A missing helper socket degrades with
`missing-privilege`; a configured socket without an exact event stream degrades
with `event-loss`.

## Adapters

Supported release adapters are first-party and intentionally narrow. New
adapters must consume stable structured sources, preserve stdout/stderr/stdin
and child exit status, keep nested-wrapper ownership, update the generated
telemetry registry for new semantic names, and prove privacy/degraded behavior
with focused tests. English logs, progress bars, unstable human output, raw
paths, source text, private payloads, and raw profile bytes are not accepted as
release adapter inputs.

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
one lands as a vertical slice with structured input, explicit
event/span/metric/profile classification, generated registry updates for stable
names, privacy tests, degraded-mode tests, and E2E evidence. Human-readable logs
are not a supported first-class source.

Deferred adapter work has two ordered lanes. General adapter fleet expansion
starts with Cargo structured compiler/timing output, then `tsc
--generateTrace`, then Vitest JSON/native OTEL evidence. Profile-producing
build-tool artifact work starts with `tsc --generateTrace`, but only after trace
artifact grouping is specified. Package-manager phases and Vite stay behind the
same structured-source audit. Candidates remain rejected by the CLI until their
vertical slice lands; the wrapper does not accept adapter names as placeholders.

## Artifact Retention

Profile links use `cas:sha256/...` URIs. The URI is location-independent; the run
must retain or upload the CAS root as the artifact tree that resolves it.
Consumers verify the digest and byte length before using the artifact bytes.

For CI, publish the entire CAS root for the run and keep the selected
`--cas-pin` manifest as the handoff root. The pin names the set of profile
artifacts that should survive cleanup.

## Support Matrix

| Capability                                       | Current release claim           | Notes                                                                                                                                                  |
| ------------------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Passthrough stdout/stderr/stdin and exit status  | Supported                       | Wrapper diagnostics go to stderr. Optional summary/export failures do not replace the child exit code.                                                 |
| W3C trace context root-or-join propagation       | Supported                       | The child receives `traceparent` and `TRACEPARENT`.                                                                                                    |
| Local summary evidence                           | Supported                       | Raw argv, cwd, paths, output payloads, source text, and credentials are not embedded.                                                                  |
| OTLP command span export                         | Supported                       | Emits command span, process spans from the active backend, adapter events, and profile-link events over OTLP/HTTP JSON.                                |
| CAS profile links                                | Supported                       | Profile bytes are stored under `--cas-root`; summaries and OTLP events carry `cas:` URIs plus descriptors, not raw bytes or local paths.               |
| Adapter metrics as OTLP metrics                  | Not a release claim             | Adapter metrics remain local summary records until trace-correlated metric semantics are explicit.                                                     |
| Descendant process-tree spans                    | Linux opt-in exact backend      | `--process-backend ptrace-experimental` is validated on Linux by the compiled DAG fixture. Default and macOS output remain degraded/direct-child-only. |
| `oxlint` adapter                                 | Supported                       | Parses structured JSON diagnostics while preserving stdout.                                                                                            |
| `node-cpuprofile` adapter                        | Supported first profile adapter | Direct Node child commands only; degraded evidence is recorded for unsupported or malformed profile cases.                                             |
| `tsc`/Cargo/Vitest/package-manager/Vite adapters | Deferred                        | Candidate adapters are rejected until they land with the structured-source, privacy, degradation, registry, and consumer-evidence gate.                |

Telemetry semantic names are generated from
`context/otel-scrape/telemetry-registry.json` into Rust and TypeScript bindings;
update the registry source and run `devenv tasks run genie:run` instead of
editing generated constants by hand.
