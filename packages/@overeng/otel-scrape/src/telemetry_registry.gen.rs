// Generated file - DO NOT EDIT
// Source: telemetry_registry.gen.rs.genie.ts
// Registry source: context/otel-scrape/telemetry-registry.json
// Input fingerprint: sha256:b2ba4dec425b302da82d3ca662d4765ce5eb77fb0707189e96292a95cff5517b

pub const REGISTRY_SCHEMA_VERSION: u8 = 1;
pub const REGISTRY_NAMESPACE: &str = "otel_scrape";
pub const REGISTRY_INPUT_FINGERPRINT: &str =
    "sha256:b2ba4dec425b302da82d3ca662d4765ce5eb77fb0707189e96292a95cff5517b";

pub mod spans {
    pub const COMMAND: &str = "otel_scrape.command";
    pub const PROCESS: &str = "otel_scrape.process";
}

pub mod metrics {
    pub const OXLINT_DIAGNOSTICS: &str = "oxlint.diagnostics";
}

pub mod attributes {
    pub const ADAPTER_NAME: &str = "otel_scrape.adapter.name";
    pub const PROCESS_COMMAND_ARGS_HASH: &str = "process.command_args_hash";
    pub const PROCESS_EXIT_CODE: &str = "process.exit_code";
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
