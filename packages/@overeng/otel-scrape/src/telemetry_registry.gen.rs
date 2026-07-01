// Generated file - DO NOT EDIT
// Source: telemetry_registry.gen.rs.genie.ts
// Registry source: context/otel-scrape/telemetry-registry.json
// Input fingerprint: sha256:ed87a66dddc6e7d0047dd838b1638fbdbc1adca1f9ac56172068676cb866aab7

pub const REGISTRY_SCHEMA_VERSION: u8 = 1;
pub const REGISTRY_NAMESPACE: &str = "otel_scrape";
pub const REGISTRY_INPUT_FINGERPRINT: &str =
    "sha256:ed87a66dddc6e7d0047dd838b1638fbdbc1adca1f9ac56172068676cb866aab7";

pub mod span_naming {
    pub const COMMAND: &str = "program-basename";
    pub const PROCESS: &str = "descendant-basename";
}

pub mod metrics {
    pub const OXLINT_DIAGNOSTICS: &str = "oxlint.diagnostics";
}

pub mod attributes {
    pub const SCOPE_NAME: &str = "otel.scope.name";
    pub const SPAN_ORIGIN: &str = "span.origin";
    pub const COMMAND_PROGRAM: &str = "command.program";
    pub const COMMAND_ARGV_HASH: &str = "command.argv_hash";
    pub const COMMAND_CWD_HASH: &str = "command.cwd_hash";
    pub const COMMAND_ARGV: &str = "command.argv";
    pub const COMMAND_CWD: &str = "command.cwd";
    pub const ADAPTER_NAME: &str = "otel_scrape.adapter.name";
    pub const PROCESS_EXIT_CODE: &str = "process.exit_code";
    pub const PROCESS_OBSERVATION_BACKEND: &str = "otel_scrape.process.observation.backend";
    pub const PROCESS_OBSERVATION_FIDELITY: &str = "otel_scrape.process.observation.fidelity";
    pub const PROCESS_OBSERVATION_RELATION: &str = "otel_scrape.process.observation.relation";
    pub const TOOL_NAME: &str = "tool.name";
    pub const TOOL_VERSION: &str = "tool.version";
    pub const PROFILE_TYPE: &str = "profile.type";
    pub const PROFILE_DIGEST: &str = "profile.digest";
    pub const PROFILE_URI: &str = "profile.uri";
    pub const PROFILE_UI: &str = "profile.ui";
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
