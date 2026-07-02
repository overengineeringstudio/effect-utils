// Generated file - DO NOT EDIT
// Source: constants.rs.genie.ts
// registry-source: weaver-registry/registry.ts
// fingerprint: sha256:24104b3975f1c45a19105c3b122e839ddfe53917c75970c1bae598cd5530324f
// regen: devenv tasks run genie:run

//! Generated OpenTelemetry semantic-convention name constants.

/// Attribute keys.
pub mod attribute {
    pub const ACME_ATTEMPT: &str = "acme.attempt";
    pub const ACME_PROBE_LABEL: &str = "acme.probe.label";
    pub const ACME_PROBE_NAME: &str = "acme.probe.name";
    pub const ACME_REGION: &str = "acme.region";
    pub const ACME_REQUEST_HEADER: &str = "acme.request.header";
    pub const GENIE_CONCURRENCY: &str = "genie.concurrency";
    pub const GENIE_CWD: &str = "genie.cwd";
    pub const GENIE_DRY_RUN: &str = "genie.dry_run";
    pub const GENIE_FILE_MODE: &str = "genie.file.mode";
    pub const GENIE_FILE_SOURCE_PATH: &str = "genie.file.source_path";
    pub const GENIE_FILE_TARGET_PATH: &str = "genie.file.target_path";
    pub const GENIE_OXFMT_HAS_CONFIG: &str = "genie.oxfmt.has_config";
    pub const GENIE_PATH: &str = "genie.path";
    pub const GENIE_READ_ONLY: &str = "genie.read_only";
    pub const GENIE_VALIDATION_FILE_COUNT: &str = "genie.validation.file_count";
    pub const GENIE_VALIDATION_PRELOADED_FILE_COUNT: &str = "genie.validation.preloaded_file_count";
    pub const GENIE_VALIDATION_REQUIRE_PACKAGE_JSON_VALIDATE: &str = "genie.validation.require_package_json_validate";

    pub const ALL: &[&str] = &[
        "acme.attempt",
        "acme.probe.label",
        "acme.probe.name",
        "acme.region",
        "acme.request.header",
        "genie.concurrency",
        "genie.cwd",
        "genie.dry_run",
        "genie.file.mode",
        "genie.file.source_path",
        "genie.file.target_path",
        "genie.oxfmt.has_config",
        "genie.path",
        "genie.read_only",
        "genie.validation.file_count",
        "genie.validation.preloaded_file_count",
        "genie.validation.require_package_json_validate",
    ];
}

/// Span names.
pub mod span {
    pub const SPAN_ACME_OPERATION: &str = "span.acme.operation";
    pub const SPAN_ACME_PROBE: &str = "span.acme.probe";
    pub const SPAN_GENIE_ATOMIC_WRITE: &str = "span.genie.atomic_write";
    pub const SPAN_GENIE_COMMAND: &str = "span.genie.command";
    pub const SPAN_GENIE_FILE: &str = "span.genie.file";
    pub const SPAN_GENIE_OXFMT: &str = "span.genie.oxfmt";
    pub const SPAN_GENIE_PATH: &str = "span.genie.path";
    pub const SPAN_GENIE_RUN_VALIDATION: &str = "span.genie.run_validation";
    pub const SPAN_GENIE_TARGET_LOCK: &str = "span.genie.target_lock";

    pub const ALL: &[&str] = &[
        "span.acme.operation",
        "span.acme.probe",
        "span.genie.atomic_write",
        "span.genie.command",
        "span.genie.file",
        "span.genie.oxfmt",
        "span.genie.path",
        "span.genie.run_validation",
        "span.genie.target_lock",
    ];
}

/// Metric names.
pub mod metric {
    pub const ACME_PROBE_DURATION: &str = "acme.probe.duration";
    pub const ACME_PROBES: &str = "acme.probes";

    pub const ALL: &[&str] = &["acme.probe.duration", "acme.probes"];
}
