// Generated file - DO NOT EDIT
// Source: constants.rs.genie.ts
// registry-source: weaver-registry/registry.ts
// fingerprint: sha256:297a2bddab8b3ab2f8c6725d2d121cca17c2fa6b221d4944bcedd6c6839de44b
// regen: devenv tasks run genie:run

//! Generated OpenTelemetry semantic-convention name constants.

/// Attribute keys.
pub mod attribute {
    pub const ACME_ATTEMPT: &str = "acme.attempt";
    pub const ACME_PROBE_LABEL: &str = "acme.probe.label";
    pub const ACME_PROBE_NAME: &str = "acme.probe.name";
    pub const ACME_REGION: &str = "acme.region";
    pub const ACME_REQUEST_HEADER: &str = "acme.request.header";

    pub const ALL: &[&str] = &[
        "acme.attempt",
        "acme.probe.label",
        "acme.probe.name",
        "acme.region",
        "acme.request.header",
    ];
}

/// Span names.
pub mod span {
    pub const SPAN_ACME_OPERATION: &str = "span.acme.operation";
    pub const SPAN_ACME_PROBE: &str = "span.acme.probe";

    pub const ALL: &[&str] = &["span.acme.operation", "span.acme.probe"];
}

/// Metric names.
pub mod metric {
    pub const ACME_PROBE_DURATION: &str = "acme.probe.duration";
    pub const ACME_PROBES: &str = "acme.probes";

    pub const ALL: &[&str] = &["acme.probe.duration", "acme.probes"];
}
