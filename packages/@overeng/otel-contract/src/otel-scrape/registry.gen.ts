// Generated file - DO NOT EDIT
// Source: registry.gen.ts.genie.ts
// Registry source: context/otel-scrape/telemetry-registry.json
// Input fingerprint: sha256:62f0e35225c3fdd4b14571f48de8515dd8c22531297a2dee6094e2d29ddb53f7

export const otelScrapeTelemetryRegistry = {
  "schemaVersion": 1,
  "namespace": "otel_scrape",
  "spans": [
    {
      "id": "command",
      "naming": "program-basename",
      "description": "One otel-scrape wrapper invocation. Named by the wrapped program's basename (decision 0014) and conforms to the OTel span.cli.internal convention (decision 0016): span_kind INTERNAL, name = process.executable.name. Ownership is carried by otel_scrape.span.origin=otel-scrape and otel.scope.name=otel-scrape."
    },
    {
      "id": "process",
      "naming": "descendant-basename",
      "description": "One observed descendant process. Named by the observed descendant program's basename (decision 0014). Emitted as a distinct span only under an exact backend that proves a real descendant; the default degraded direct-child observation is merged into the command span (fidelity=merged)."
    }
  ],
  "metrics": [
    {
      "id": "oxlint_diagnostics",
      "name": "oxlint.diagnostics",
      "description": "Number of oxlint diagnostics parsed from one JSON report."
    }
  ],
  "attributes": [
    {
      "id": "scope_name",
      "key": "otel.scope.name",
      "valueType": "string",
      "cardinality": "low",
      "stability": "stable",
      "examples": [
        "otel-scrape"
      ],
      "description": "Instrumentation scope name; otel-scrape for wrapper-owned spans."
    },
    {
      "id": "otel_scrape_span_origin",
      "key": "otel_scrape.span.origin",
      "valueType": "string",
      "cardinality": "low",
      "stability": "development",
      "examples": [
        "otel-scrape",
        "otel-scrape-adapter"
      ],
      "description": "Vendor attribute (decision 0016): origin of the span. otel-scrape for wrapper-owned spans, otel-scrape-adapter for adapter-derived phase spans. No upstream semconv equivalent, so it stays namespaced under otel_scrape."
    },
    {
      "id": "process_executable_name",
      "key": "process.executable.name",
      "valueType": "string",
      "cardinality": "bounded",
      "stability": "development",
      "examples": [
        "tsc",
        "cargo",
        "node"
      ],
      "description": "OTel semconv (decision 0016): base name of the wrapped executable; the span-name source. A public-safe identity, always present. Never a full path or arguments."
    },
    {
      "id": "otel_scrape_command_argv_hash",
      "key": "otel_scrape.command.argv_hash",
      "valueType": "string",
      "cardinality": "bounded",
      "stability": "development",
      "examples": [
        "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
      ],
      "description": "Vendor attribute (decision 0016): stable hash of command argv, never raw arguments. Always present; the correlation/dedup key. No upstream semconv equivalent, so it stays namespaced under otel_scrape."
    },
    {
      "id": "otel_scrape_command_cwd_hash",
      "key": "otel_scrape.command.cwd_hash",
      "valueType": "string",
      "cardinality": "bounded",
      "stability": "development",
      "examples": [
        "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
      ],
      "description": "Vendor attribute (decision 0016): stable hash of the current working directory identity, never a raw path. Always present. No upstream semconv equivalent, so it stays namespaced under otel_scrape."
    },
    {
      "id": "process_command_args",
      "key": "process.command_args",
      "valueType": "string[]",
      "cardinality": "high",
      "stability": "development",
      "encode": "drop",
      "examples": [
        [
          "node",
          "--version"
        ]
      ],
      "note": "Raw command argv as an array (one element per argument), aligned to OTel semconv (decision 0016). Privacy travels with the rename (decision 0015): trust-gated and dropped by default (encode=drop). Emitted only into a sink an operator explicitly asserted private by name (--trusted-sink). Never present by default.",
      "description": "OTel semconv (decision 0016): raw command argv as a string array. Trust-gated (decision 0015): emitted only into a sink an operator explicitly asserted private by name (--trusted-sink). Never present by default."
    },
    {
      "id": "process_working_directory",
      "key": "process.working_directory",
      "valueType": "string",
      "cardinality": "high",
      "stability": "development",
      "encode": "drop",
      "examples": [
        "/home/user/project"
      ],
      "note": "Raw current working directory, aligned to OTel semconv (decision 0016). Privacy travels with the rename (decision 0015): trust-gated and dropped by default (encode=drop).",
      "description": "OTel semconv (decision 0016): raw current working directory / local path. Trust-gated (decision 0015): emitted only into a sink an operator explicitly asserted private by name (--trusted-sink). Never present by default."
    },
    {
      "id": "adapter_name",
      "key": "otel_scrape.adapter.name",
      "valueType": "string",
      "cardinality": "low",
      "stability": "development",
      "examples": [
        "oxlint",
        "node-cpuprofile",
        "none"
      ],
      "description": "Selected adapter name."
    },
    {
      "id": "process_exit_code",
      "key": "process.exit.code",
      "valueType": "int",
      "cardinality": "low",
      "stability": "development",
      "examples": [
        0,
        7
      ],
      "description": "OTel semconv (decision 0016): process exit code when available."
    },
    {
      "id": "process_observation_backend",
      "key": "otel_scrape.process.observation.backend",
      "valueType": "string",
      "cardinality": "low",
      "stability": "development",
      "examples": [
        "direct-child",
        "ptrace-experimental",
        "helper-stream"
      ],
      "description": "Process observation backend that produced this process evidence."
    },
    {
      "id": "process_observation_fidelity",
      "key": "otel_scrape.process.observation.fidelity",
      "valueType": "string",
      "cardinality": "low",
      "stability": "development",
      "examples": [
        "exact",
        "merged",
        "degraded"
      ],
      "description": "Process observation fidelity: exact, merged (degraded direct-child folded into the command span), or a degraded evidence value."
    },
    {
      "id": "process_observation_relation",
      "key": "otel_scrape.process.observation.relation",
      "valueType": "string",
      "cardinality": "low",
      "stability": "development",
      "examples": [
        "direct-child",
        "descendant"
      ],
      "description": "Relationship between the observed process and the wrapper command span."
    },
    {
      "id": "tool_name",
      "key": "tool.name",
      "valueType": "string",
      "cardinality": "low",
      "stability": "development",
      "examples": [
        "oxlint",
        "tsc"
      ],
      "description": "Detected tool identity."
    },
    {
      "id": "tool_version",
      "key": "tool.version",
      "valueType": "string",
      "cardinality": "bounded",
      "stability": "development",
      "examples": [
        "1.2.3"
      ],
      "description": "Detected tool version when cheap and safe."
    },
    {
      "id": "profile_type",
      "key": "profile.type",
      "valueType": "string",
      "cardinality": "low",
      "stability": "development",
      "examples": [
        "cpu"
      ],
      "description": "Native profile artifact kind."
    },
    {
      "id": "profile_digest",
      "key": "profile.digest",
      "valueType": "string",
      "cardinality": "high",
      "stability": "development",
      "examples": [
        "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
      ],
      "description": "Profile artifact sha256 digest."
    },
    {
      "id": "profile_uri",
      "key": "profile.uri",
      "valueType": "string",
      "cardinality": "high",
      "stability": "development",
      "examples": [
        "cas:sha256/9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
      ],
      "description": "Location-independent CAS retrieval URI."
    },
    {
      "id": "profile_ui",
      "key": "profile.ui",
      "valueType": "string",
      "cardinality": "high",
      "stability": "development",
      "examples": [
        "https://profiler.example/view/abc"
      ],
      "description": "Optional profile viewer URI."
    },
    {
      "id": "command_program",
      "key": "command.program",
      "valueType": "string",
      "cardinality": "bounded",
      "stability": "development",
      "deprecated": {
        "reason": "renamed",
        "renamed_to": "process.executable.name"
      },
      "description": "Deprecated (decision 0016): renamed to the OTel semconv key process.executable.name. Retained for the evolution trail; not emitted."
    },
    {
      "id": "command_argv_hash",
      "key": "command.argv_hash",
      "valueType": "string",
      "cardinality": "bounded",
      "stability": "development",
      "deprecated": {
        "reason": "renamed",
        "renamed_to": "otel_scrape.command.argv_hash"
      },
      "description": "Deprecated (decision 0016): moved under the otel_scrape vendor namespace as otel_scrape.command.argv_hash. Retained for the evolution trail; not emitted."
    },
    {
      "id": "command_cwd_hash",
      "key": "command.cwd_hash",
      "valueType": "string",
      "cardinality": "bounded",
      "stability": "development",
      "deprecated": {
        "reason": "renamed",
        "renamed_to": "otel_scrape.command.cwd_hash"
      },
      "description": "Deprecated (decision 0016): moved under the otel_scrape vendor namespace as otel_scrape.command.cwd_hash. Retained for the evolution trail; not emitted."
    },
    {
      "id": "command_argv",
      "key": "command.argv",
      "valueType": "string",
      "cardinality": "high",
      "stability": "development",
      "encode": "drop",
      "deprecated": {
        "reason": "renamed",
        "renamed_to": "process.command_args"
      },
      "description": "Deprecated (decision 0016): renamed to the OTel semconv key process.command_args and retyped from a newline-joined string to a string array. Retained for the evolution trail; not emitted."
    },
    {
      "id": "command_cwd",
      "key": "command.cwd",
      "valueType": "string",
      "cardinality": "high",
      "stability": "development",
      "encode": "drop",
      "deprecated": {
        "reason": "renamed",
        "renamed_to": "process.working_directory"
      },
      "description": "Deprecated (decision 0016): renamed to the OTel semconv key process.working_directory. Retained for the evolution trail; not emitted."
    },
    {
      "id": "process_exit_code_deprecated",
      "key": "process.exit_code",
      "valueType": "int",
      "cardinality": "low",
      "stability": "development",
      "deprecated": {
        "reason": "renamed",
        "renamed_to": "process.exit.code"
      },
      "description": "Deprecated (decision 0016): the underscore form is renamed to the OTel semconv key process.exit.code. Retained for the evolution trail; not emitted."
    },
    {
      "id": "span_origin",
      "key": "span.origin",
      "valueType": "string",
      "cardinality": "low",
      "stability": "development",
      "deprecated": {
        "reason": "renamed",
        "renamed_to": "otel_scrape.span.origin"
      },
      "description": "Deprecated (decision 0016): moved under the otel_scrape vendor namespace as otel_scrape.span.origin. Retained for the evolution trail; not emitted."
    }
  ],
  "profileFields": [
    {
      "id": "type",
      "field": "type"
    },
    {
      "id": "digest",
      "field": "digest"
    },
    {
      "id": "uri",
      "field": "uri"
    },
    {
      "id": "ui",
      "field": "ui"
    },
    {
      "id": "byte_length",
      "field": "byteLength"
    },
    {
      "id": "media_type",
      "field": "mediaType"
    },
    {
      "id": "codec",
      "field": "codec"
    },
    {
      "id": "schema_version",
      "field": "schemaVersion"
    }
  ],
  "schemas": [
    {
      "id": "summary_v1",
      "value": "otel-scrape.summary/v1"
    }
  ]
} as const

// Spans are named by the operation they represent (decision 0014), not by a
// fixed instrumentation constant. The registry owns the naming *scheme* per
// span id; the emitted name is the program / descendant / adapter-phase
// basename resolved at runtime.
export const otelScrapeSpanNaming = {
  "command": "program-basename",
  "process": "descendant-basename"
} as const

export const otelScrapeMetricNames = {
  "oxlintDiagnostics": "oxlint.diagnostics"
} as const

export const otelScrapeAttributeKeys = {
  "scopeName": "otel.scope.name",
  "otelScrapeSpanOrigin": "otel_scrape.span.origin",
  "processExecutableName": "process.executable.name",
  "otelScrapeCommandArgvHash": "otel_scrape.command.argv_hash",
  "otelScrapeCommandCwdHash": "otel_scrape.command.cwd_hash",
  "processCommandArgs": "process.command_args",
  "processWorkingDirectory": "process.working_directory",
  "adapterName": "otel_scrape.adapter.name",
  "processExitCode": "process.exit.code",
  "processObservationBackend": "otel_scrape.process.observation.backend",
  "processObservationFidelity": "otel_scrape.process.observation.fidelity",
  "processObservationRelation": "otel_scrape.process.observation.relation",
  "toolName": "tool.name",
  "toolVersion": "tool.version",
  "profileType": "profile.type",
  "profileDigest": "profile.digest",
  "profileUri": "profile.uri",
  "profileUi": "profile.ui",
  "commandProgram": "command.program",
  "commandArgvHash": "command.argv_hash",
  "commandCwdHash": "command.cwd_hash",
  "commandArgv": "command.argv",
  "commandCwd": "command.cwd",
  "processExitCodeDeprecated": "process.exit_code",
  "spanOrigin": "span.origin"
} as const

export const otelScrapeProfileFields = {
  "type": "type",
  "digest": "digest",
  "uri": "uri",
  "ui": "ui",
  "byteLength": "byteLength",
  "mediaType": "mediaType",
  "codec": "codec",
  "schemaVersion": "schemaVersion"
} as const

export const otelScrapeSchemas = {
  "summaryV1": "otel-scrape.summary/v1"
} as const

export type OtelScrapeSpanNaming =
  (typeof otelScrapeSpanNaming)[keyof typeof otelScrapeSpanNaming]

export type OtelScrapeMetricName =
  (typeof otelScrapeMetricNames)[keyof typeof otelScrapeMetricNames]

export type OtelScrapeAttributeKey =
  (typeof otelScrapeAttributeKeys)[keyof typeof otelScrapeAttributeKeys]
