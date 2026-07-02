// Generated file - DO NOT EDIT
// Source: telemetry_registry.gen.rs.genie.ts
// Registry source: context/otel-scrape/telemetry-registry.json
// Input fingerprint: sha256:0a20a264a614244322ff4af277cf8293dbdf97edd3b2cb35692f2dc44ba1f4d3

pub const REGISTRY_SCHEMA_VERSION: u8 = 1;
pub const REGISTRY_NAMESPACE: &str = "otel_scrape";
pub const REGISTRY_INPUT_FINGERPRINT: &str =
    "sha256:0a20a264a614244322ff4af277cf8293dbdf97edd3b2cb35692f2dc44ba1f4d3";

pub mod span_naming {
    pub const COMMAND: &str = "program-basename";
    pub const PROCESS: &str = "descendant-basename";
}

pub mod metrics {
    pub const OXLINT_DIAGNOSTICS: &str = "oxlint.diagnostics";
    pub const VITEST_TESTS: &str = "vitest.tests";
    pub const VITEST_FAILURES: &str = "vitest.failures";
}

pub mod attributes {
    pub const SCOPE_NAME: &str = "otel.scope.name";
    pub const OTEL_SCRAPE_SPAN_ORIGIN: &str = "otel_scrape.span.origin";
    pub const PROCESS_EXECUTABLE_NAME: &str = "process.executable.name";
    pub const OTEL_SCRAPE_COMMAND_ARGV_HASH: &str = "otel_scrape.command.argv_hash";
    pub const OTEL_SCRAPE_COMMAND_CWD_HASH: &str = "otel_scrape.command.cwd_hash";
    pub const PROCESS_COMMAND_ARGS: &str = "process.command_args";
    pub const PROCESS_WORKING_DIRECTORY: &str = "process.working_directory";
    pub const ADAPTER_NAME: &str = "otel_scrape.adapter.name";
    pub const ADAPTER_EVENT_SEVERITY: &str = "severity";
    pub const ADAPTER_EVENT_SOURCE_FILENAME_HASH: &str = "source.filename_hash";
    pub const ADAPTER_EVENT_RULE: &str = "otel_scrape.adapter.rule";
    pub const ADAPTER_EVENT_LINE: &str = "otel_scrape.adapter.line";
    pub const PROCESS_EXIT_CODE: &str = "process.exit.code";
    pub const PROCESS_PID: &str = "process.pid";
    pub const ERROR_TYPE: &str = "error.type";
    pub const PROCESS_OBSERVATION_BACKEND: &str = "otel_scrape.process.observation.backend";
    pub const PROCESS_OBSERVATION_FIDELITY: &str = "otel_scrape.process.observation.fidelity";
    pub const PROCESS_OBSERVATION_RELATION: &str = "otel_scrape.process.observation.relation";
    pub const TOOL_NAME: &str = "tool.name";
    pub const TOOL_VERSION: &str = "tool.version";
    pub const PROFILE_TYPE: &str = "profile.type";
    pub const PROFILE_DIGEST: &str = "profile.digest";
    pub const PROFILE_URI: &str = "profile.uri";
    pub const PROFILE_UI: &str = "profile.ui";
    pub const COMMAND_PROGRAM: &str = "command.program";
    pub const COMMAND_ARGV_HASH: &str = "command.argv_hash";
    pub const COMMAND_CWD_HASH: &str = "command.cwd_hash";
    pub const COMMAND_ARGV: &str = "command.argv";
    pub const COMMAND_CWD: &str = "command.cwd";
    pub const PROCESS_EXIT_CODE_DEPRECATED: &str = "process.exit_code";
    pub const SPAN_ORIGIN: &str = "span.origin";
}

pub mod profile_fields {
    pub const TYPE: &str = "type";
    pub const DIGEST: &str = "digest";
    pub const URI: &str = "uri";
    pub const UI: &str = "ui";
    pub const BYTE_LENGTH: &str = "byteLength";
    pub const MEDIA_TYPE: &str = "mediaType";
    pub const CODEC: &str = "codec";
    pub const SCHEMA_VERSION: &str = "schemaVersion";
}

pub mod schemas {
    pub const SUMMARY_V1: &str = "otel-scrape.summary/v1";
}
