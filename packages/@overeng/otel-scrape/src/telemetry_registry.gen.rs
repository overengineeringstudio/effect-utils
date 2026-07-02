// Generated file - DO NOT EDIT
// Source: telemetry_registry.gen.rs.genie.ts
// Registry source: context/otel-scrape/telemetry-registry.json
// Input fingerprint: sha256:07eb53eff615f574ee09d9f66d1c702f9794d3dc8c5736b82b0fbafe2da910f6

pub const REGISTRY_SCHEMA_VERSION: u8 = 1;
pub const REGISTRY_NAMESPACE: &str = "otel_scrape";
pub const REGISTRY_INPUT_FINGERPRINT: &str =
    "sha256:07eb53eff615f574ee09d9f66d1c702f9794d3dc8c5736b82b0fbafe2da910f6";

pub mod span_naming {
    pub const COMMAND: &str = "program-basename";
    pub const PROCESS: &str = "descendant-basename";
}

pub mod metrics {
    pub const OXLINT_DIAGNOSTICS: &str = "oxlint.diagnostics";
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
