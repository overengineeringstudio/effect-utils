// Generated file - DO NOT EDIT
// Source: registry.gen.ts.genie.ts
// Registry source: context/otel-scrape/telemetry-registry.json
// Input fingerprint: sha256:cbfd82826debc526332e4994825eab930a9219a91c4991398bf4d52b115c10eb

export const otelScrapeTelemetryRegistry = {
  "schemaVersion": 1,
  "namespace": "otel_scrape",
  "spans": [
    {
      "id": "command",
      "name": "otel_scrape.command",
      "description": "One otel-scrape wrapper invocation."
    },
    {
      "id": "process",
      "name": "otel_scrape.process",
      "description": "One observed child or descendant process."
    }
  ],
  "metrics": [],
  "attributes": [
    {
      "id": "adapter_name",
      "key": "otel_scrape.adapter.name",
      "valueType": "string",
      "cardinality": "low",
      "description": "Selected adapter name."
    },
    {
      "id": "process_command_args_hash",
      "key": "process.command_args_hash",
      "valueType": "string",
      "cardinality": "bounded",
      "description": "Stable hash of command argv, never raw arguments."
    },
    {
      "id": "process_exit_code",
      "key": "process.exit_code",
      "valueType": "int",
      "cardinality": "low",
      "description": "Process exit code when available."
    },
    {
      "id": "tool_name",
      "key": "tool.name",
      "valueType": "string",
      "cardinality": "low",
      "description": "Detected tool identity."
    },
    {
      "id": "tool_version",
      "key": "tool.version",
      "valueType": "string",
      "cardinality": "bounded",
      "description": "Detected tool version when cheap and safe."
    },
    {
      "id": "profile_type",
      "key": "profile.type",
      "valueType": "string",
      "cardinality": "low",
      "description": "Native profile artifact kind."
    },
    {
      "id": "profile_digest",
      "key": "profile.digest",
      "valueType": "string",
      "cardinality": "high",
      "description": "Profile artifact sha256 digest."
    },
    {
      "id": "profile_uri",
      "key": "profile.uri",
      "valueType": "string",
      "cardinality": "high",
      "description": "Location-independent CAS retrieval URI."
    },
    {
      "id": "profile_ui",
      "key": "profile.ui",
      "valueType": "string",
      "cardinality": "high",
      "description": "Optional profile viewer URI."
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

export const otelScrapeSpanNames = {
  "command": "otel_scrape.command",
  "process": "otel_scrape.process"
} as const

export const otelScrapeMetricNames = {} as const

export const otelScrapeAttributeKeys = {
  "adapterName": "otel_scrape.adapter.name",
  "processCommandArgsHash": "process.command_args_hash",
  "processExitCode": "process.exit_code",
  "toolName": "tool.name",
  "toolVersion": "tool.version",
  "profileType": "profile.type",
  "profileDigest": "profile.digest",
  "profileUri": "profile.uri",
  "profileUi": "profile.ui"
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

export type OtelScrapeSpanName =
  (typeof otelScrapeSpanNames)[keyof typeof otelScrapeSpanNames]

export type OtelScrapeMetricName =
  (typeof otelScrapeMetricNames)[keyof typeof otelScrapeMetricNames]

export type OtelScrapeAttributeKey =
  (typeof otelScrapeAttributeKeys)[keyof typeof otelScrapeAttributeKeys]
