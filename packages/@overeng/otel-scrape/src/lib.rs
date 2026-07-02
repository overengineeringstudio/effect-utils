//! `otel-scrape` command-wrapper core.
//!
//! The library owns argument parsing, W3C trace context propagation, command
//! passthrough, and summary evidence. Adapter parsing and OTLP export will be
//! layered on this boundary once the generated telemetry registry exists.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::fs;
use std::io::{self, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::net::UnixStream;
#[cfg(unix)]
use std::os::unix::process::ExitStatusExt;

use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

mod content_address;
#[path = "telemetry_registry.gen.rs"]
pub mod telemetry_registry;

use content_address::{
    canonical_manifest_json, cas_uri_for_digest, descriptor_for_bytes, write_bytes_atomic,
    write_object, write_pin, ManifestEntry, CANONICAL_JSON_CODEC, MANIFEST_MEDIA_TYPE,
    PROFILE_MEDIA_TYPE,
};

const VERSION: &str = env!("CARGO_PKG_VERSION");
// OTel semantic-conventions schema this instrumentation targets (decision 0019).
// Emitted as schemaUrl on the OTLP resource and instrumentation scope so a
// consumer can resolve attribute semantics deterministically.
const SEMCONV_SCHEMA_URL: &str = "https://opentelemetry.io/schemas/1.37.0";
// Build stamp baked at compile time by Nix (decision 0019): a NixStamp JSON in
// the shared build-versioning contract. `None` for a plain `cargo build`; in a
// devenv shell `option_env!` instead captures the exported LocalStamp, which is
// deliberately NOT honored as the binary's own identity (see resolve_machine_version).
pub const BUILD_STAMP: Option<&str> = option_env!("CLI_BUILD_STAMP");
const EX_USAGE: u8 = 64;
const TRACE_FLAGS_SAMPLED: &str = "01";
const SUMMARY_ENV: &str = "OTEL_SCRAPE_SUMMARY_OUT";
const CAS_ROOT_ENV: &str = "OTEL_SCRAPE_CAS_ROOT";
const OTLP_ENDPOINT_ENV: &str = "OTEL_EXPORTER_OTLP_ENDPOINT";
const OTLP_TRACES_ENDPOINT_ENV: &str = "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT";
const OTLP_HEADERS_ENV: &str = "OTEL_EXPORTER_OTLP_HEADERS";
const OTLP_TRACES_HEADERS_ENV: &str = "OTEL_EXPORTER_OTLP_TRACES_HEADERS";
const OTLP_TIMEOUT_ENV: &str = "OTEL_EXPORTER_OTLP_TIMEOUT";
const OTLP_TRACES_TIMEOUT_ENV: &str = "OTEL_EXPORTER_OTLP_TRACES_TIMEOUT";
const OTLP_PROTOCOL_ENV: &str = "OTEL_EXPORTER_OTLP_PROTOCOL";
const OTLP_TRACES_PROTOCOL_ENV: &str = "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL";
const OTLP_COMPRESSION_ENV: &str = "OTEL_EXPORTER_OTLP_COMPRESSION";
const OTLP_TRACES_COMPRESSION_ENV: &str = "OTEL_EXPORTER_OTLP_TRACES_COMPRESSION";
const OTEL_TRACES_EXPORTER_ENV: &str = "OTEL_TRACES_EXPORTER";
const OTEL_SDK_DISABLED_ENV: &str = "OTEL_SDK_DISABLED";
const RESOURCE_ATTRIBUTES_ENV: &str = "OTEL_RESOURCE_ATTRIBUTES";
const SERVICE_NAME_ENV: &str = "OTEL_SERVICE_NAME";
// Per-named-sink trust assertion (decision 0015). The env alias is pinned by
// invariant to the single OTLP target only; it NEVER unlocks the summary sink.
const TRUSTED_SINK_ENV: &str = "OTEL_SCRAPE_TRUSTED_SINK";
const TRUSTED_SINK_OTLP: &str = "otlp";
const TRUSTED_SINK_SUMMARY: &str = "summary";
const PROCESS_BACKEND_ENV: &str = "OTEL_SCRAPE_PROCESS_BACKEND";
const PROCESS_HELPER_SOCKET_ENV: &str = "OTEL_SCRAPE_PROCESS_HELPER_SOCKET";
const RUN_ID_ENV: &str = "OTEL_SCRAPE_RUN_ID";
const HELPER_STREAM_PROTOCOL_VERSION: u8 = 1;
const TRACEPARENT_ENV: &str = "traceparent";
// Task-level traceparent (decision 0018 clause 4): otel-scrape exports its OWN
// command-span context under this variable so a task-parented sub-span emitter
// re-parents beneath the command span instead of the outer task span. A
// re-eval-safe reparenting fix (experiment 0009); overwrites any inherited value.
const OTEL_TASK_TRACEPARENT_ENV: &str = "OTEL_TASK_TRACEPARENT";
const OXLINT_ADAPTER: &str = "oxlint";
const VITEST_ADAPTER: &str = "vitest";
const OUTPUT_MEDIA_TYPE: &str = "application/octet-stream";
const RESOURCE_FACT_UNAVAILABLE: &str = "unavailable";
const OTLP_HTTP_DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);
const NODE_CPUPROFILE_ADAPTER: &str = "node-cpuprofile";
const DIRECT_CHILD_BACKEND: &str = "direct-child";
const PTRACE_EXPERIMENTAL_BACKEND: &str = "ptrace-experimental";
const HELPER_STREAM_BACKEND: &str = "helper-stream";
const PROCESS_FIDELITY_EXACT: &str = "exact";
const PROCESS_FIDELITY_DEGRADED: &str = "degraded";
// The degraded direct-child observation is folded into the command span rather
// than emitted as a distinct process span (decision 0014). The command span
// records this via otel_scrape.process.observation.fidelity = "merged".
const PROCESS_FIDELITY_MERGED: &str = "merged";
const PROCESS_RELATION_DIRECT_CHILD: &str = "direct-child";
const PROCESS_RELATION_DESCENDANT: &str = "descendant";
// otel-scrape ownership is carried in scope + attributes, never in the span
// name (decision 0014). The span name is the operation (program basename).
const OTEL_SCRAPE_SCOPE_NAME: &str = "otel-scrape";
const SPAN_ORIGIN_OTEL_SCRAPE: &str = "otel-scrape";
// Fallback program identity when the wrapped argv[0] has no usable basename.
const UNKNOWN_PROGRAM_BASENAME: &str = "unknown";
// Bounded-cardinality fallback for the command span name / process.executable.name
// when the wrapped basename looks pathological (uuid temp script, per-test
// compiled binary, hex nonce). Collapses all such names into one bucket
// (decision 0016, M25.1). span.cli permits a documented low-cardinality format.
const BOUNDED_PROGRAM_FALLBACK: &str = "<binary>";
// Maximum length of a basename kept verbatim as the span name (decision 0016).
const BOUNDED_PROGRAM_MAX_LEN: usize = 64;
// A hex run this long or longer in an otherwise all-hex basename is treated as a
// content hash / nonce, not a real program name (decision 0016). Kept high so
// genuine short all-hex tool names (`dd`, `cafe`, `deadbeef`) survive.
const HEX_NONCE_MIN_LEN: usize = 16;
// OTel semconv well-known LOW-cardinality fallback for error.type (decision
// 0016): otel-scrape cannot classify the wrapped tool's error domain.
const ERROR_TYPE_OTHER: &str = "_OTHER";
const PROCESS_OBSERVATION_DEGRADED_REASONS: &[ProcessObservationDegradedReason] = &[
    ProcessObservationDegradedReason::DirectChildOnly,
    ProcessObservationDegradedReason::UnsupportedPlatform,
    ProcessObservationDegradedReason::MissingPrivilege,
    ProcessObservationDegradedReason::PtraceDenied,
    ProcessObservationDegradedReason::EndpointSecurityUnavailable,
    ProcessObservationDegradedReason::EventLoss,
    ProcessObservationDegradedReason::NamespaceUnsupported,
    ProcessObservationDegradedReason::HelperDisconnect,
    ProcessObservationDegradedReason::VersionMismatch,
    ProcessObservationDegradedReason::RunIdMismatch,
    ProcessObservationDegradedReason::SequenceGap,
    ProcessObservationDegradedReason::LifecycleIncomplete,
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunConfig {
    pub summary_out: Option<PathBuf>,
    pub adapter: String,
    pub cas_root: Option<PathBuf>,
    pub cas_pin: Option<String>,
    pub otlp_endpoint: Option<String>,
    pub otlp_headers: Vec<(String, String)>,
    pub otlp_timeout: Duration,
    pub otlp_export_enabled: bool,
    pub service_name: String,
    pub resource_attributes: Vec<(String, String)>,
    pub process_backend: ProcessBackendSelection,
    pub process_helper_socket: Option<PathBuf>,
    pub profile_artifacts: Vec<ProfileArtifactInput>,
    /// Whether the operator asserted the OTLP sink private (decision 0015).
    /// Read ONLY at the OTLP emission site; the summary must never consult it.
    pub trusted_otlp: bool,
    /// Whether the operator asserted the local summary sink private
    /// (decision 0015). Read ONLY at the summary emission site. The summary is
    /// hard-public-safe by default: an OTLP assertion never sets this.
    pub trusted_summary: bool,
    pub argv: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileArtifactInput {
    pub profile_type: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandRequest {
    Help,
    Version,
    // Boxed: `RunConfig` is ~288 bytes while the other variants carry no data, so
    // an unboxed `Run` would bloat every `CommandRequest` (clippy large-enum-variant).
    Run(Box<RunConfig>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageError {
    message: String,
}

impl UsageError {
    pub fn message(&self) -> &str {
        &self.message
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct OtlpEnvConfig {
    endpoint: Option<String>,
    headers: Vec<(String, String)>,
    timeout: Duration,
    export_enabled: bool,
    service_name: String,
    resource_attributes: Vec<(String, String)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessBackendSelection {
    DirectChild,
    PtraceExperimental,
    HelperStream,
}

impl ProcessBackendSelection {
    fn parse(value: &str) -> Option<Self> {
        match value {
            DIRECT_CHILD_BACKEND => Some(Self::DirectChild),
            PTRACE_EXPERIMENTAL_BACKEND => Some(Self::PtraceExperimental),
            HELPER_STREAM_BACKEND => Some(Self::HelperStream),
            _ => None,
        }
    }

    fn supported_values() -> &'static str {
        "direct-child, ptrace-experimental, or helper-stream"
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TraceContext {
    pub trace_id: String,
    pub parent_span_id: Option<String>,
    pub span_id: String,
    pub flags: String,
}

#[derive(Debug, Serialize)]
pub struct Summary {
    schema: &'static str,
    version: &'static str,
    command: CommandSummary,
    output: OutputSummary,
    resources: ResourceSummary,
    adapter: AdapterSummary,
    artifacts: ArtifactSummary,
    processes: ProcessObservationSummary,
    trace: TraceSummary,
    child: ChildSummary,
    duration_ms: u128,
    degraded: DegradedSummary,
}

#[derive(Debug, Serialize)]
struct CommandSummary {
    /// Public-safe wrapped executable basename (decision 0014, R01); always present.
    program: String,
    argv_hash: String,
    cwd_hash: String,
    /// Raw argv — trust-gated (decision 0015). The summary is hard-public-safe
    /// by default: this is `Some` ONLY under an explicit `--trusted-sink summary`
    /// (never under an OTLP assertion). `skip_serializing_if` keeps the default
    /// summary byte-identical to the pre-M2 shape.
    #[serde(skip_serializing_if = "Option::is_none")]
    argv: Option<Vec<String>>,
    /// Raw cwd / local path — trust-gated (decision 0015); `Some` only under an
    /// explicit `--trusted-sink summary`.
    #[serde(skip_serializing_if = "Option::is_none")]
    cwd: Option<String>,
}

#[derive(Debug, Serialize)]
struct OutputSummary {
    stdout: Option<OutputDescriptor>,
    stderr: Option<OutputDescriptor>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputDescriptor {
    #[serde(rename = "_tag")]
    tag: &'static str,
    digest: String,
    byte_length: usize,
    media_type: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResourceSummary {
    wall_ms: u128,
    cpu_time_ms: Option<u64>,
    max_rss_bytes: Option<u64>,
    availability: ResourceAvailability,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResourceAvailability {
    cpu_time: &'static str,
    max_rss: &'static str,
}

#[derive(Debug, Serialize)]
struct AdapterSummary {
    name: String,
    ownership: AdapterOwnershipSummary,
    records: Vec<AdapterSummaryRecord>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdapterOwnershipSummary {
    stdout: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AdapterStdoutOwnership {
    ThisWrapper,
    ChildWrapper,
    /// The adapter consumes a side-channel (a file/fd) and leaves the child's
    /// stdout untouched (decision 0017: vitest). otel-scrape owns the structured
    /// records but NOT the terminal presentation — the child writes directly.
    Inherited,
}

impl AdapterStdoutOwnership {
    fn as_summary_value(self) -> &'static str {
        match self {
            Self::ThisWrapper => "this-wrapper",
            Self::ChildWrapper => "child-wrapper",
            Self::Inherited => "inherited",
        }
    }
}

/// How otel-scrape presents the wrapped child's stdout (decision 0017,
/// requirement R30). Presentation ownership lives here, per-adapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StdoutMode {
    /// stdout goes straight to the terminal; otel-scrape never captures it
    /// (adapter=none; vitest side-channel).
    Inherit,
    /// stdout is captured AND streamed live to the terminal (node-cpuprofile;
    /// an outer wrapper passing through a nested otel-scrape's rendered summary).
    TeeLive,
    /// stdout is captured but SUPPRESSED from the terminal; otel-scrape renders a
    /// human summary in its place after parsing (oxlint structured-in/pretty-out).
    /// On a parse failure the captured raw bytes are flushed instead, so output is
    /// never swallowed.
    CaptureSilent,
}

#[derive(Debug, Clone)]
enum AdapterOutput {
    Event(AdapterEvent),
    #[allow(dead_code)]
    Span(AdapterSpan),
    Metric(AdapterMetric),
    Profile(ProfileLink),
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "_tag")]
enum AdapterSummaryRecord {
    Event(AdapterEvent),
    Metric(AdapterMetric),
}

/// A sink-facing adapter event. Hard-public-safe by construction (decision 0015,
/// R27; decision 0017 clause 4): the raw diagnostic MESSAGE is never a field, and
/// the filename is only ever the hashed identity. The full message/path is shown
/// only in the terminal render (the operator's own machine, not a sink).
#[derive(Debug, Clone, Serialize)]
struct AdapterEvent {
    severity: String,
    filename_hash: Option<String>,
    /// The diagnostic rule / linter code, emitted verbatim (e.g.
    /// `eslint(no-debugger)`) (H5). Public-safe: a public lint-rule name, never
    /// source text or a path. `skip_serializing_if` keeps the summary shape
    /// minimal when a diagnostic carries no code.
    #[serde(skip_serializing_if = "Option::is_none")]
    rule: Option<String>,
    /// The 1-based source line of the diagnostic (H5). Public-safe: a plain
    /// integer, never a path or source text.
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<u32>,
}

#[derive(Debug, Clone)]
struct AdapterSpan {
    name: String,
    identity_hash: String,
    duration_ms: Option<u128>,
}

#[derive(Debug, Clone, Serialize)]
struct AdapterMetric {
    name: &'static str,
    value: u64,
}

#[derive(Debug, Clone, Serialize)]
struct ArtifactSummary {
    profiles: Vec<ProfileLink>,
    manifest: Option<ManifestLink>,
    errors: Vec<ArtifactError>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileLink {
    #[serde(rename = "type")]
    profile_type: String,
    digest: String,
    uri: String,
    byte_length: usize,
    media_type: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestLink {
    digest: String,
    uri: String,
    byte_length: usize,
    media_type: &'static str,
    codec: &'static str,
    schema_version: u64,
    pin: String,
    entry_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactError {
    profile_type: Option<String>,
    path_hash: Option<String>,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessObservationSummary {
    backend: String,
    fidelity: String,
    reason: Option<String>,
    observed: Vec<ObservedProcessSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ObservedProcessSummary {
    #[serde(rename = "_tag")]
    tag: &'static str,
    relation: String,
    span_id: String,
    parent_span_id: String,
    pid_hash: String,
    parent_pid_hash: Option<String>,
    argv_hash: String,
    exit_code: Option<i32>,
    termination: Option<ChildTermination>,
    start_unix_nano: u128,
    end_unix_nano: u128,
    wall_ms: u128,
}

#[derive(Debug, Clone)]
struct ProcessObservation {
    backend: ProcessObservationBackend,
    fidelity: ProcessObservationFidelity,
    degraded_reason: Option<ProcessObservationDegradedReason>,
    observed: Vec<ObservedProcess>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProcessObservationBackend {
    DirectChild,
    PtraceExperimental,
    HelperStream,
}

impl ProcessObservationBackend {
    fn as_str(self) -> &'static str {
        match self {
            Self::DirectChild => DIRECT_CHILD_BACKEND,
            Self::PtraceExperimental => PTRACE_EXPERIMENTAL_BACKEND,
            Self::HelperStream => HELPER_STREAM_BACKEND,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProcessObservationFidelity {
    Exact,
    Degraded,
}

impl ProcessObservationFidelity {
    fn as_str(self) -> &'static str {
        match self {
            Self::Exact => PROCESS_FIDELITY_EXACT,
            Self::Degraded => PROCESS_FIDELITY_DEGRADED,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProcessObservationDegradedReason {
    DirectChildOnly,
    UnsupportedPlatform,
    MissingPrivilege,
    PtraceDenied,
    EndpointSecurityUnavailable,
    EventLoss,
    NamespaceUnsupported,
    HelperDisconnect,
    VersionMismatch,
    RunIdMismatch,
    SequenceGap,
    LifecycleIncomplete,
}

impl ProcessObservationDegradedReason {
    fn parse(value: &str) -> Option<Self> {
        PROCESS_OBSERVATION_DEGRADED_REASONS
            .iter()
            .copied()
            .find(|reason| reason.as_str() == value)
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::DirectChildOnly => "direct-child-only",
            Self::UnsupportedPlatform => "unsupported-platform",
            Self::MissingPrivilege => "missing-privilege",
            Self::PtraceDenied => "ptrace-denied",
            Self::EndpointSecurityUnavailable => "endpoint-security-unavailable",
            Self::EventLoss => "event-loss",
            Self::NamespaceUnsupported => "namespace-unsupported",
            Self::HelperDisconnect => "helper-disconnect",
            Self::VersionMismatch => "version-mismatch",
            Self::RunIdMismatch => "run-id-mismatch",
            Self::SequenceGap => "sequence-gap",
            Self::LifecycleIncomplete => "lifecycle-incomplete",
        }
    }
}

#[derive(Debug, Clone)]
struct ObservedProcess {
    relation: ObservedProcessRelation,
    /// Public-safe descendant program basename (decision 0014). Used to name a
    /// distinct process span under an exact backend. `unknown` when the backend
    /// cannot prove a basename (e.g. hash-only helper-stream events).
    program: String,
    span_id: String,
    parent_span_id: Option<String>,
    pid_hash: String,
    parent_pid_hash: Option<String>,
    argv_hash: String,
    exit_code: Option<i32>,
    termination: Option<ChildTermination>,
    started_wall: SystemTime,
    wall_ms: u128,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ObservedProcessRelation {
    DirectChild,
    Descendant,
}

impl ObservedProcessRelation {
    fn as_str(self) -> &'static str {
        match self {
            Self::DirectChild => PROCESS_RELATION_DIRECT_CHILD,
            Self::Descendant => PROCESS_RELATION_DESCENDANT,
        }
    }
}

#[derive(Debug, Serialize)]
struct TraceSummary {
    trace_id: String,
    parent_span_id: Option<String>,
    span_id: String,
    child_traceparent: String,
}

#[derive(Debug, Serialize)]
struct ChildSummary {
    exit_code: Option<i32>,
    success: bool,
    termination: Option<ChildTermination>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "_tag")]
enum ChildTermination {
    Signal {
        signal: i32,
        synthetic_exit_code: i32,
    },
}

#[derive(Debug, Serialize)]
struct DegradedSummary {
    direct_child_only: bool,
    otlp_export: bool,
}

pub fn parse_args(args: &[String]) -> Result<CommandRequest, UsageError> {
    let mut summary_out: Option<PathBuf> = std::env::var_os(SUMMARY_ENV).map(PathBuf::from);
    let mut adapter = String::from("none");
    let mut cas_root: Option<PathBuf> = std::env::var_os(CAS_ROOT_ENV).map(PathBuf::from);
    let mut cas_pin: Option<String> = None;
    let otlp_env = otlp_env_config();
    let mut otlp_endpoint = otlp_env.endpoint;
    let otlp_headers = otlp_env.headers;
    let otlp_timeout = otlp_env.timeout;
    let otlp_export_enabled = otlp_env.export_enabled;
    let mut service_name = otlp_env.service_name;
    let mut resource_attributes = otlp_env.resource_attributes;
    let mut process_helper_socket = std::env::var_os(PROCESS_HELPER_SOCKET_ENV).map(PathBuf::from);
    let mut process_backend = match std::env::var(PROCESS_BACKEND_ENV) {
        Ok(value) => ProcessBackendSelection::parse(&value).ok_or_else(|| UsageError {
            message: format!(
                "{PROCESS_BACKEND_ENV} must be {}",
                ProcessBackendSelection::supported_values()
            ),
        })?,
        Err(_) => ProcessBackendSelection::DirectChild,
    };
    let mut profile_artifacts = Vec::new();
    // Per-named-sink trust (decision 0015): two independent gates. The env alias
    // OTEL_SCRAPE_TRUSTED_SINK is pinned to the single OTLP target only and can
    // never unlock the summary. Flags OR in on top; the summary is only ever
    // unlocked by its own explicit `--trusted-sink summary`.
    let mut trusted_otlp = env_bool(TRUSTED_SINK_ENV);
    let mut trusted_summary = false;
    let mut child_start: Option<usize> = None;

    if args.is_empty() {
        return Ok(CommandRequest::Help);
    }

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--help" | "-h" => return Ok(CommandRequest::Help),
            "--version" | "-V" => return Ok(CommandRequest::Version),
            "--summary-out" => {
                let Some(value) = args.get(i + 1) else {
                    return usage_error("--summary-out needs a file path");
                };
                summary_out = Some(PathBuf::from(value));
                i += 2;
            }
            "--adapter" => {
                let Some(value) = args.get(i + 1) else {
                    return usage_error("--adapter needs a value");
                };
                if value != "none"
                    && value != OXLINT_ADAPTER
                    && value != VITEST_ADAPTER
                    && value != NODE_CPUPROFILE_ADAPTER
                {
                    return usage_error(
                        "only --adapter none, --adapter oxlint, --adapter vitest, and --adapter node-cpuprofile are supported",
                    );
                }
                adapter = value.clone();
                i += 2;
            }
            "--cas-root" => {
                let Some(value) = args.get(i + 1) else {
                    return usage_error("--cas-root needs a directory path");
                };
                cas_root = Some(PathBuf::from(value));
                i += 2;
            }
            "--cas-pin" => {
                let Some(value) = args.get(i + 1) else {
                    return usage_error("--cas-pin needs a pin name");
                };
                validate_pin_name(value)?;
                cas_pin = Some(value.clone());
                i += 2;
            }
            "--otlp-endpoint" => {
                let Some(value) = args.get(i + 1) else {
                    return usage_error("--otlp-endpoint needs an http endpoint");
                };
                validate_http_endpoint(value)?;
                otlp_endpoint = Some(value.clone());
                i += 2;
            }
            "--service-name" => {
                let Some(value) = args.get(i + 1) else {
                    return usage_error("--service-name needs a value");
                };
                if value.trim().is_empty() {
                    return usage_error("--service-name must not be empty");
                }
                service_name = value.clone();
                set_resource_attribute(&mut resource_attributes, "service.name", value);
                i += 2;
            }
            "--process-backend" => {
                let Some(value) = args.get(i + 1) else {
                    return usage_error("--process-backend needs a value");
                };
                let Some(backend) = ProcessBackendSelection::parse(value) else {
                    return usage_error(&format!(
                        "only --process-backend {} are supported",
                        ProcessBackendSelection::supported_values()
                    ));
                };
                process_backend = backend;
                i += 2;
            }
            "--process-helper-socket" => {
                let Some(value) = args.get(i + 1) else {
                    return usage_error("--process-helper-socket needs a socket path");
                };
                if value.trim().is_empty() {
                    return usage_error("--process-helper-socket must not be empty");
                }
                process_helper_socket = Some(PathBuf::from(value));
                i += 2;
            }
            "--trusted-sink" => {
                let Some(value) = args.get(i + 1) else {
                    return usage_error("--trusted-sink needs a sink name (otlp or summary)");
                };
                match value.as_str() {
                    TRUSTED_SINK_OTLP => trusted_otlp = true,
                    TRUSTED_SINK_SUMMARY => trusted_summary = true,
                    _ => {
                        return usage_error(
                            "only --trusted-sink otlp and --trusted-sink summary are supported",
                        );
                    }
                }
                i += 2;
            }
            "--profile-artifact" => {
                let Some(value) = args.get(i + 1) else {
                    return usage_error("--profile-artifact needs <type>:<path>");
                };
                profile_artifacts.push(parse_profile_artifact(value)?);
                i += 2;
            }
            "--" => {
                child_start = Some(i + 1);
                break;
            }
            other if other.starts_with('-') => {
                return usage_error(&format!("unknown flag: {other}"));
            }
            _ => {
                child_start = Some(i);
                break;
            }
        }
    }

    let Some(start) = child_start else {
        return usage_error("missing command");
    };
    let argv = args[start..].to_vec();
    if argv.is_empty() {
        return usage_error("missing command");
    }
    if profile_artifacts.is_empty() && adapter != NODE_CPUPROFILE_ADAPTER {
        if cas_pin.is_some() {
            return usage_error("--cas-pin requires --profile-artifact");
        }
    } else if cas_root.is_none() {
        return usage_error(
            "--profile-artifact and --adapter node-cpuprofile require --cas-root or OTEL_SCRAPE_CAS_ROOT",
        );
    }

    Ok(CommandRequest::Run(Box::new(RunConfig {
        summary_out,
        adapter,
        cas_root,
        cas_pin,
        otlp_endpoint,
        otlp_headers,
        otlp_timeout,
        otlp_export_enabled,
        service_name,
        resource_attributes,
        process_backend,
        process_helper_socket,
        profile_artifacts,
        trusted_otlp,
        trusted_summary,
        argv,
    })))
}

pub fn print_help() {
    eprintln!("otel-scrape {VERSION} — process wrapper for command telemetry");
    eprintln!();
    eprintln!("usage:");
    eprintln!(
        "  otel-scrape [--summary-out <file>] [--adapter none|oxlint|vitest|node-cpuprofile] [--process-backend direct-child|ptrace-experimental|helper-stream] [--process-helper-socket <path>] [--otlp-endpoint <url>] [--service-name <name>] [--trusted-sink otlp|summary]... [--cas-root <dir>] [--cas-pin <name>] [--profile-artifact <type>:<path>] -- <cmd...>"
    );
    eprintln!("  otel-scrape --version | --help");
}

pub fn print_version() {
    println!("otel-scrape {VERSION}");
}

/// Resolve the machine-readable build version for telemetry (decision 0019),
/// mirroring the shared build-versioning contract
/// (`@overeng/utils/node/cli-version` `resolveCliMachineVersion`). Precedence:
///   1. a compile-time Nix build stamp (`option_env!`) — the binary's own build;
///   2. else a runtime `CLI_BUILD_STAMP` (a devenv-shell LocalStamp or a NixStamp);
///   3. else `<baseVersion>+dev`.
///
/// The step-3 `+dev` marker is a deliberate local divergence from the TS
/// `package` case (which returns the bare base): otel-scrape has no
/// package-registry distribution, so a stampless build is always a local dev
/// build, and a bare `0.0.0` discriminates no build — the exact gap H5 closes.
fn build_machine_version() -> String {
    resolve_machine_version(
        BUILD_STAMP,
        std::env::var("CLI_BUILD_STAMP").ok().as_deref(),
        VERSION,
    )
}

/// Whether this binary was compiled with a baked NixStamp (decision 0019) — the
/// case where a runtime `CLI_BUILD_STAMP` is overridden by the binary's own
/// build identity. Lets an integration test skip the runtime-stamp/fallback
/// assertions that only hold for a stampless (plain `cargo`/devenv) build.
pub fn compiled_with_nix_stamp() -> bool {
    matches!(
        BUILD_STAMP.and_then(parse_build_stamp),
        Some(BuildStamp::Nix { .. })
    )
}

/// Pure resolution of the machine version from the compile-time and runtime
/// stamps (decision 0019). Kept side-effect-free so every precedence branch is
/// unit-testable without touching the process environment.
fn resolve_machine_version(
    compile_stamp: Option<&str>,
    runtime_stamp: Option<&str>,
    base: &str,
) -> String {
    // A compile-time stamp is honored ONLY when it is a NixStamp: in a devenv
    // shell `option_env!` also captures the exported LocalStamp, which describes
    // the shell, not this binary, and must not masquerade as its build identity.
    // The Nix build path always bakes a NixStamp.
    if let Some(BuildStamp::Nix { version, rev, dirty }) =
        compile_stamp.and_then(parse_build_stamp)
    {
        return nix_machine_version(&version, &rev, dirty);
    }
    match runtime_stamp.and_then(parse_build_stamp) {
        Some(BuildStamp::Nix { version, rev, dirty }) => nix_machine_version(&version, &rev, dirty),
        Some(BuildStamp::Local { rev, dirty }) => local_machine_version(base, &rev, dirty),
        None => format!("{base}+dev"),
    }
}

/// machineVersion for a NixStamp — `<version>+<rev>[-dirty]` (mirrors the TS
/// `nixMachineVersion`). The rev already carries `-dirty` when the flake saw a
/// dirty tree (`dirtyShortRev`), so the suffix is not doubled.
fn nix_machine_version(version: &str, rev: &str, dirty: bool) -> String {
    let dirty_suffix = if dirty && !rev.ends_with("-dirty") {
        "-dirty"
    } else {
        ""
    };
    format!("{version}+{rev}{dirty_suffix}")
}

/// machineVersion for a LocalStamp — `<base>+local.<rev>[.dirty]` (mirrors the
/// TS `localMachineVersion`).
fn local_machine_version(base: &str, rev: &str, dirty: bool) -> String {
    let dirty_suffix = if dirty { ".dirty" } else { "" };
    format!("{base}+local.{rev}{dirty_suffix}")
}

/// Parsed build stamp in the shared build-versioning contract (decision 0019).
enum BuildStamp {
    Nix {
        version: String,
        rev: String,
        dirty: bool,
    },
    Local {
        rev: String,
        dirty: bool,
    },
}

/// Parse a `CLI_BUILD_STAMP` JSON string. Defensive: any missing/mistyped field
/// yields `None` so a malformed stamp degrades to the `+dev` fallback rather
/// than failing the run (decision 0019: never fail on version resolution).
fn parse_build_stamp(raw: &str) -> Option<BuildStamp> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let dirty = value.get("dirty").and_then(|v| v.as_bool()).unwrap_or(false);
    match value.get("type").and_then(|v| v.as_str())? {
        "nix" => Some(BuildStamp::Nix {
            version: value.get("version")?.as_str()?.to_owned(),
            rev: value.get("rev")?.as_str()?.to_owned(),
            dirty,
        }),
        "local" => Some(BuildStamp::Local {
            rev: value.get("rev")?.as_str()?.to_owned(),
            dirty,
        }),
        _ => None,
    }
}

pub fn run(config: RunConfig) -> io::Result<i32> {
    let trace = trace_context_from_env()?;
    let child_traceparent = trace.child_traceparent();
    let run_id = random_hex(16)?;
    let started_wall = SystemTime::now();
    let started = Instant::now();

    let child = run_child(&config, &child_traceparent, &run_id)?;
    // Monotonic delta at nanosecond resolution. The summary keeps its ms field
    // (local schema, decision 0016), but the OTLP span end time is derived from
    // the full-resolution delta so sub-ms commands are not zero-width and no two
    // durations collapse to the same whole-ms multiple (decision 0016, M25.1).
    let elapsed = started.elapsed();
    let duration_ms = elapsed.as_millis();
    let discovered_artifacts = discover_adapter_profile_artifacts(&config, &child);
    let artifacts = match artifact_summary(&config, &trace, &discovered_artifacts) {
        Ok(artifacts) => artifacts,
        Err(cause) => {
            eprintln!("otel-scrape: warning: failed to store profile artifacts: {cause}");
            ArtifactSummary {
                profiles: Vec::new(),
                manifest: None,
                errors: vec![ArtifactError {
                    profile_type: None,
                    path_hash: None,
                    message: cause.to_string(),
                }],
            }
        }
    };
    cleanup_adapter_profile_artifacts(&child);

    // Consume the declared structured source and build the adapter records ONCE
    // (decision 0017): stdout for oxlint, the side-channel file for vitest. The
    // same AdapterRun feeds both the summary and the OTLP export, so parsing and
    // presentation happen exactly once.
    let structured_source = adapter_structured_source(&config, &child);
    let adapter = adapter_outputs(&config, &structured_source, &artifacts);
    // Presentation ownership (decision 0017, R30): render the human summary in
    // place of the suppressed raw stdout (or flush the raw bytes on a parse
    // failure). UX-neutral: the operator still sees readable output.
    present_adapter_stdout(&config, &adapter, &child);
    cleanup_sidechannel_file(&child);

    if let Some(path) = config.summary_out.as_ref() {
        match summary_for_status(
            &config,
            &trace,
            &child_traceparent,
            &child,
            duration_ms,
            &artifacts,
            &adapter,
        )
        .and_then(|summary| write_summary(path, &summary))
        {
            Ok(()) => {}
            Err(cause) => {
                eprintln!(
                    "otel-scrape: warning: failed to write summary target {}: {cause}",
                    hash_path_identity(&path.to_string_lossy())
                );
            }
        }
    }

    if config.otlp_export_enabled {
        let Some(endpoint) = config.otlp_endpoint.as_ref() else {
            return Ok(exit_code(child.status));
        };
        let endpoint_for_warning = endpoint_for_warning(endpoint);
        if let Err(cause) =
            export_command_span(&config, &trace, &child, started_wall, elapsed, &adapter)
        {
            eprintln!(
                "otel-scrape: warning: failed to export OTLP trace to {endpoint_for_warning}: {cause}"
            );
        }
    }

    Ok(exit_code(child.status))
}

struct ChildRun {
    status: ExitStatus,
    stdout: Option<Vec<u8>>,
    stderr: Option<Vec<u8>>,
    node_profile_dir: Option<PathBuf>,
    process_observation: ProcessObservation,
    // Raw pid of the wrapped direct child (decision 0016, M25.1): emitted as the
    // semconv-REQUIRED process.pid on the command span. Ephemeral/local, so raw
    // (not hashed). Option so any fixture-only path without a real spawn is
    // honest rather than emitting a fabricated pid.
    child_pid: Option<u32>,
    // Side-channel structured-source file (decision 0017: vitest). otel-scrape
    // injects `--outputFile.json=<this>` so the child writes its JSON here while
    // its human stdout stays untouched. Read after the child exits.
    sidechannel_file: Option<PathBuf>,
    // Whether otel-scrape created `sidechannel_file` and must delete it. A
    // user-supplied `--outputFile.json` is read in place, never deleted (0017).
    sidechannel_owned: bool,
}

fn run_child(config: &RunConfig, child_traceparent: &str, run_id: &str) -> io::Result<ChildRun> {
    match config.process_backend {
        ProcessBackendSelection::DirectChild => run_child_direct(config, child_traceparent, run_id),
        ProcessBackendSelection::PtraceExperimental => {
            run_child_with_ptrace(config, child_traceparent, run_id)
        }
        ProcessBackendSelection::HelperStream => {
            run_child_with_helper_stream(config, child_traceparent, run_id)
        }
    }
}

fn run_child_with_helper_stream(
    config: &RunConfig,
    child_traceparent: &str,
    run_id: &str,
) -> io::Result<ChildRun> {
    let mut child = run_child_direct(config, child_traceparent, run_id)?;
    child.process_observation = helper_stream_process_observation(config, run_id)
        .unwrap_or_else(|reason| degraded_helper_stream_observation(&child, reason));
    Ok(child)
}

fn run_child_direct(
    config: &RunConfig,
    child_traceparent: &str,
    run_id: &str,
) -> io::Result<ChildRun> {
    let node_profile_dir = prepare_node_cpuprofile_dir(config)?;
    let process_span_id = random_hex(8)?;
    let mode = stdout_mode(config);
    let sidechannel = vitest_sidechannel(config)?;
    let mut command = Command::new(&config.argv[0]);
    command
        .args(&config.argv[1..])
        .env(TRACEPARENT_ENV, child_traceparent)
        .env("TRACEPARENT", child_traceparent)
        // decision 0018 clause 4: export the command-span context as the task
        // traceparent so a task-parented sub-span emitter re-parents beneath this
        // command span, not the outer task span (experiment 0009). Overwrites any
        // inherited value.
        .env(OTEL_TASK_TRACEPARENT_ENV, child_traceparent)
        .env(RUN_ID_ENV, run_id)
        .stdin(Stdio::inherit());
    if let Some(plan) = sidechannel.as_ref() {
        command.args(&plan.inject_args);
    }
    if let Some(profile_dir) = node_profile_dir.as_ref() {
        command.env(
            "NODE_OPTIONS",
            node_options_with_cpu_profile(
                std::env::var("NODE_OPTIONS").ok().as_deref(),
                profile_dir,
            ),
        );
    }

    let process_started_wall = SystemTime::now();
    let process_started = Instant::now();
    let (stdout, stderr, status, process_id) = match mode {
        StdoutMode::Inherit => {
            let mut child = command
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .spawn()?;
            let process_id = child.id();
            let status = child.wait()?;
            (None, None, status, process_id)
        }
        StdoutMode::TeeLive | StdoutMode::CaptureSilent => {
            let mut child = command
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()?;
            let process_id = child.id();
            let stdout_pipe = child.stdout.take().expect("stdout is piped");
            let stderr_pipe = child.stderr.take().expect("stderr is piped");
            // CaptureSilent suppresses the raw stdout tee (decision 0017): capture
            // it into a sink so it never reaches the terminal; the caller renders a
            // human summary in its place (or flushes it on a parse failure). stderr
            // always streams live — it carries the tool's own error text.
            let stdout_reader = if mode == StdoutMode::TeeLive {
                thread::spawn(move || tee_reader(stdout_pipe, io::stdout()))
            } else {
                thread::spawn(move || tee_reader(stdout_pipe, io::sink()))
            };
            let stderr_reader = thread::spawn(move || tee_reader(stderr_pipe, io::stderr()));
            let status = child.wait()?;
            let stdout = join_reader(stdout_reader)?;
            let stderr = join_reader(stderr_reader)?;
            (Some(stdout), Some(stderr), status, process_id)
        }
    };
    let process_duration_ms = process_started.elapsed().as_millis();

    Ok(ChildRun {
        status,
        stdout,
        stderr,
        node_profile_dir,
        child_pid: Some(process_id),
        sidechannel_file: sidechannel.as_ref().map(|plan| plan.read_path.clone()),
        sidechannel_owned: sidechannel.as_ref().is_some_and(|plan| plan.owned),
        process_observation: direct_child_process_observation(DirectChildProcessObservation {
            config,
            process_id,
            parent_process_id: std::process::id(),
            process_span_id,
            process_started_wall,
            process_duration_ms,
            status,
        }),
    })
}

/// The vitest side-channel plan (decision 0017): the JSON file otel-scrape reads
/// after the child exits, the flags it injects so a JSON reporter writes there,
/// and whether otel-scrape owns (must delete) the file.
struct VitestSidechannel {
    /// JSON file otel-scrape reads once the child exits.
    read_path: PathBuf,
    /// Flags injected into the child argv so a JSON report lands at a known path
    /// while the human reporter still writes to the terminal.
    inject_args: Vec<String>,
    /// Whether otel-scrape created `read_path` and must delete it. NEVER set for a
    /// user-supplied `--outputFile.json` — deleting the operator's file is data loss.
    owned: bool,
}

/// User-supplied vitest flags otel-scrape must respect before injecting its own
/// side-channel flags (decision 0017 clause 2): a pre-existing `--outputFile.json`
/// (any form) is read in place instead of clobbered, and a pre-existing
/// `--reporter` is preserved instead of overridden.
struct VitestUserFlags {
    output_file_json: Option<PathBuf>,
    has_any_reporter: bool,
    has_json_reporter: bool,
}

/// Scan the child argv for the vitest flags that otel-scrape's side-channel would
/// otherwise clobber. Handles both `--flag=value` and `--flag value` forms.
fn scan_vitest_user_flags(argv: &[String]) -> VitestUserFlags {
    let mut output_file_json = None;
    let mut has_any_reporter = false;
    let mut has_json_reporter = false;
    let mut iter = argv.iter().peekable();
    while let Some(arg) = iter.next() {
        if let Some(value) = arg.strip_prefix("--outputFile.json=") {
            output_file_json = Some(PathBuf::from(value));
        } else if arg == "--outputFile.json" {
            // Bare form: the next arg is the path. Peek (don't consume) so it is
            // still forwarded to vitest unchanged.
            if let Some(value) = iter.peek() {
                output_file_json = Some(PathBuf::from(value.as_str()));
            }
        } else if let Some(value) = arg.strip_prefix("--reporter=") {
            has_any_reporter = true;
            has_json_reporter |= value == "json";
        } else if arg == "--reporter" {
            has_any_reporter = true;
            has_json_reporter |= iter.peek().map(|v| v.as_str()) == Some("json");
        }
    }
    VitestUserFlags {
        output_file_json,
        has_any_reporter,
        has_json_reporter,
    }
}

/// Plan the vitest side-channel for this invocation (decision 0017), or `None` for
/// any other adapter. otel-scrape ensures a JSON reporter + a known output path so
/// it can read structured counts, WITHOUT clobbering user-supplied flags:
///   - a pre-existing `--outputFile.json` is read in place and never deleted;
///   - a pre-existing human `--reporter` is preserved (only `--reporter=json` is
///     added alongside — vitest supports multiple reporters);
///   - only when the user passed no `--reporter` at all does otel-scrape inject
///     `--reporter=default` (verified: `--reporter=json` alone blanks the terminal).
fn vitest_sidechannel(config: &RunConfig) -> io::Result<Option<VitestSidechannel>> {
    if config.adapter != VITEST_ADAPTER {
        return Ok(None);
    }
    let user = scan_vitest_user_flags(&config.argv);

    let mut inject_args = Vec::new();
    if !user.has_any_reporter {
        // No user reporter: keep vitest's human output AND add the JSON side-channel.
        inject_args.push("--reporter=default".to_owned());
        inject_args.push("--reporter=json".to_owned());
    } else if !user.has_json_reporter {
        // Preserve the user's human reporter(s); add only the JSON side-channel.
        inject_args.push("--reporter=json".to_owned());
    }
    // else: the user already asked for a JSON reporter — inject no reporter flag.

    match user.output_file_json {
        Some(read_path) => Ok(Some(VitestSidechannel {
            read_path,
            inject_args,
            owned: false,
        })),
        None => {
            let suffix = random_hex(8)?;
            let read_path = std::env::temp_dir().join(format!("otel-scrape-vitest-{suffix}.json"));
            inject_args.push(format!("--outputFile.json={}", read_path.display()));
            Ok(Some(VitestSidechannel {
                read_path,
                inject_args,
                owned: true,
            }))
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn run_child_with_ptrace(
    config: &RunConfig,
    child_traceparent: &str,
    run_id: &str,
) -> io::Result<ChildRun> {
    let mut child = run_child_direct(config, child_traceparent, run_id)?;
    child.process_observation.backend = ProcessObservationBackend::DirectChild;
    child.process_observation.fidelity = ProcessObservationFidelity::Degraded;
    child.process_observation.degraded_reason =
        Some(ProcessObservationDegradedReason::UnsupportedPlatform);
    Ok(child)
}

#[cfg(target_os = "linux")]
fn run_child_with_ptrace(
    config: &RunConfig,
    child_traceparent: &str,
    // The ptrace backend does not thread RUN_ID_ENV to the child (unlike the
    // direct backend); accepted for a uniform signature across cfg variants.
    _run_id: &str,
) -> io::Result<ChildRun> {
    use std::collections::{HashMap, HashSet};
    use std::os::unix::process::CommandExt;

    let node_profile_dir = prepare_node_cpuprofile_dir(config)?;
    let mode = stdout_mode(config);
    let sidechannel = vitest_sidechannel(config)?;
    let mut command = Command::new(&config.argv[0]);
    command
        .args(&config.argv[1..])
        .env(TRACEPARENT_ENV, child_traceparent)
        .env("TRACEPARENT", child_traceparent)
        // decision 0018 clause 4: export the command-span context as the task
        // traceparent (mirrors run_child_direct) so sub-span emitters re-parent
        // beneath this command span.
        .env(OTEL_TASK_TRACEPARENT_ENV, child_traceparent)
        .stdin(Stdio::inherit());
    if let Some(plan) = sidechannel.as_ref() {
        command.args(&plan.inject_args);
    }
    if let Some(profile_dir) = node_profile_dir.as_ref() {
        command.env(
            "NODE_OPTIONS",
            node_options_with_cpu_profile(
                std::env::var("NODE_OPTIONS").ok().as_deref(),
                profile_dir,
            ),
        );
    }
    unsafe {
        command.pre_exec(|| {
            if libc::ptrace(
                libc::PTRACE_TRACEME,
                0,
                std::ptr::null_mut::<libc::c_void>(),
                std::ptr::null_mut::<libc::c_void>(),
            ) == -1
            {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }

    let captures_output = mode != StdoutMode::Inherit;
    if captures_output {
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
    } else {
        command.stdout(Stdio::inherit()).stderr(Stdio::inherit());
    }

    let root_span_id = random_hex(8)?;
    let root_started_wall = SystemTime::now();
    let root_started = Instant::now();
    let mut child = command.spawn()?;
    let root_pid = child.id() as libc::pid_t;
    let mut stdout_reader = None;
    let mut stderr_reader = None;
    if captures_output {
        let stdout = child.stdout.take().expect("stdout is piped");
        let stderr = child.stderr.take().expect("stderr is piped");
        // CaptureSilent (oxlint leaf) suppresses the raw stdout tee — capture it
        // into a sink so the caller can render a summary in its place.
        stdout_reader = Some(if mode == StdoutMode::TeeLive {
            thread::spawn(move || tee_reader(stdout, io::stdout()))
        } else {
            thread::spawn(move || tee_reader(stdout, io::sink()))
        });
        stderr_reader = Some(thread::spawn(move || tee_reader(stderr, io::stderr())));
    }

    let mut traces = HashMap::new();
    traces.insert(
        root_pid,
        PtraceProcessTrace {
            pid: root_pid,
            parent_pid: Some(std::process::id()),
            relation: ObservedProcessRelation::DirectChild,
            program: program_basename(config.argv.first().map(String::as_str)),
            span_id: root_span_id,
            parent_span_id: None,
            argv_hash: stable_hash_lines(&config.argv),
            started_wall: root_started_wall,
            started: root_started,
            wall_ms: None,
            exit_code: None,
            termination: None,
            finished: false,
        },
    );
    let mut continued = HashSet::new();
    let mut root_status = None;

    loop {
        let mut status: libc::c_int = 0;
        let pid = unsafe { libc::waitpid(-1, &mut status, libc::__WALL | libc::WUNTRACED) };
        if pid == -1 {
            let err = io::Error::last_os_error();
            if err.raw_os_error() == Some(libc::ECHILD) {
                break;
            }
            return Err(err);
        }
        if libc::WIFEXITED(status) || libc::WIFSIGNALED(status) {
            if let Some(trace) = traces.get_mut(&pid) {
                trace.finished = true;
                trace.wall_ms = Some(trace.started.elapsed().as_millis());
                if libc::WIFEXITED(status) {
                    trace.exit_code = Some(libc::WEXITSTATUS(status));
                } else if libc::WIFSIGNALED(status) {
                    let signal = libc::WTERMSIG(status);
                    trace.termination = Some(ChildTermination::Signal {
                        signal,
                        synthetic_exit_code: 128 + signal,
                    });
                }
            }
            if pid == root_pid {
                root_status = Some(ExitStatus::from_raw(status));
            }
            continue;
        }
        if !libc::WIFSTOPPED(status) {
            continue;
        }

        if continued.insert(pid) {
            set_ptrace_options(pid)?;
        }

        let signal = libc::WSTOPSIG(status);
        let event = (status >> 16) as libc::c_int;
        match event {
            libc::PTRACE_EVENT_FORK | libc::PTRACE_EVENT_VFORK | libc::PTRACE_EVENT_CLONE => {
                let new_pid = ptrace_event_pid(pid)?;
                let parent_span_id = traces.get(&pid).map(|trace| trace.span_id.clone());
                if is_process_leader(new_pid) {
                    if let std::collections::hash_map::Entry::Vacant(entry) = traces.entry(new_pid)
                    {
                        let started_wall = SystemTime::now();
                        entry.insert(PtraceProcessTrace {
                            pid: new_pid,
                            parent_pid: Some(pid as u32),
                            relation: ObservedProcessRelation::Descendant,
                            program: process_program_basename(new_pid),
                            span_id: stable_process_span_id(new_pid, started_wall),
                            parent_span_id,
                            argv_hash: process_cmdline_hash(new_pid)
                                .unwrap_or_else(|| stable_hash(new_pid.to_string().as_bytes())),
                            started_wall,
                            started: Instant::now(),
                            wall_ms: None,
                            exit_code: None,
                            termination: None,
                            finished: false,
                        });
                    }
                }
                if continued.insert(new_pid) {
                    set_ptrace_options(new_pid)?;
                }
                ptrace_continue(new_pid, 0)?;
                ptrace_continue(pid, 0)?;
            }
            libc::PTRACE_EVENT_EXEC => {
                if let Some(trace) = traces.get_mut(&pid) {
                    trace.argv_hash = process_cmdline_hash(pid)
                        .unwrap_or_else(|| stable_hash(pid.to_string().as_bytes()));
                    // After exec the descendant's real identity is known; refresh
                    // the public-safe basename so its span is named correctly.
                    let program = process_program_basename(pid);
                    if program != UNKNOWN_PROGRAM_BASENAME {
                        trace.program = program;
                    }
                }
                ptrace_continue(pid, 0)?;
            }
            libc::PTRACE_EVENT_EXIT => {
                ptrace_continue(pid, 0)?;
            }
            _ if signal == libc::SIGSTOP || signal == libc::SIGTRAP => {
                ptrace_continue(pid, 0)?;
            }
            _ => {
                ptrace_continue(pid, signal)?;
            }
        }
    }

    let stdout = stdout_reader.map(join_reader).transpose()?;
    let stderr = stderr_reader.map(join_reader).transpose()?;
    let Some(status) = root_status else {
        return Err(io::Error::other(
            "ptrace backend did not observe root process exit",
        ));
    };

    Ok(ChildRun {
        status,
        stdout,
        stderr,
        node_profile_dir,
        child_pid: u32::try_from(root_pid).ok(),
        sidechannel_file: sidechannel.as_ref().map(|plan| plan.read_path.clone()),
        sidechannel_owned: sidechannel.as_ref().is_some_and(|plan| plan.owned),
        process_observation: ptrace_process_observation(traces),
    })
}

#[cfg(target_os = "linux")]
#[derive(Debug)]
struct PtraceProcessTrace {
    pid: libc::pid_t,
    parent_pid: Option<u32>,
    relation: ObservedProcessRelation,
    program: String,
    span_id: String,
    parent_span_id: Option<String>,
    argv_hash: String,
    started_wall: SystemTime,
    started: Instant,
    wall_ms: Option<u128>,
    exit_code: Option<i32>,
    termination: Option<ChildTermination>,
    finished: bool,
}

#[cfg(target_os = "linux")]
fn set_ptrace_options(pid: libc::pid_t) -> io::Result<()> {
    let options = libc::PTRACE_O_TRACEFORK
        | libc::PTRACE_O_TRACEVFORK
        | libc::PTRACE_O_TRACECLONE
        | libc::PTRACE_O_TRACEEXEC
        | libc::PTRACE_O_TRACEEXIT
        | libc::PTRACE_O_EXITKILL;
    let result = unsafe {
        libc::ptrace(
            libc::PTRACE_SETOPTIONS,
            pid,
            std::ptr::null_mut::<libc::c_void>(),
            options as usize as *mut libc::c_void,
        )
    };
    if result == -1 {
        let err = io::Error::last_os_error();
        if err.raw_os_error() == Some(libc::ESRCH) {
            Ok(())
        } else {
            Err(err)
        }
    } else {
        Ok(())
    }
}

#[cfg(target_os = "linux")]
fn ptrace_event_pid(pid: libc::pid_t) -> io::Result<libc::pid_t> {
    let mut event_pid: libc::c_ulong = 0;
    let result = unsafe {
        libc::ptrace(
            libc::PTRACE_GETEVENTMSG,
            pid,
            std::ptr::null_mut::<libc::c_void>(),
            &mut event_pid as *mut libc::c_ulong as *mut libc::c_void,
        )
    };
    if result == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(event_pid as libc::pid_t)
    }
}

#[cfg(target_os = "linux")]
fn ptrace_continue(pid: libc::pid_t, signal: libc::c_int) -> io::Result<()> {
    let result = unsafe {
        libc::ptrace(
            libc::PTRACE_CONT,
            pid,
            std::ptr::null_mut::<libc::c_void>(),
            signal as usize as *mut libc::c_void,
        )
    };
    if result == -1 {
        let err = io::Error::last_os_error();
        if err.raw_os_error() == Some(libc::ESRCH) {
            Ok(())
        } else {
            Err(err)
        }
    } else {
        Ok(())
    }
}

#[cfg(target_os = "linux")]
fn process_cmdline_hash(pid: libc::pid_t) -> Option<String> {
    let bytes = fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    if bytes.is_empty() {
        None
    } else {
        Some(stable_hash(&bytes))
    }
}

/// Public-safe descendant program basename from `/proc/{pid}/comm` (decision
/// 0014). `comm` is the executable name, not a path or arguments. Falls back to
/// the basename of argv[0] and finally `unknown`.
#[cfg(target_os = "linux")]
fn process_program_basename(pid: libc::pid_t) -> String {
    if let Ok(comm) = fs::read_to_string(format!("/proc/{pid}/comm")) {
        let comm = comm.trim();
        if !comm.is_empty() {
            return comm.to_owned();
        }
    }
    if let Ok(bytes) = fs::read(format!("/proc/{pid}/cmdline")) {
        if let Some(argv0) = bytes.split(|byte| *byte == 0).next() {
            if let Ok(argv0) = std::str::from_utf8(argv0) {
                let basename = program_basename(Some(argv0));
                if basename != UNKNOWN_PROGRAM_BASENAME {
                    return basename;
                }
            }
        }
    }
    UNKNOWN_PROGRAM_BASENAME.to_owned()
}

#[cfg(target_os = "linux")]
fn ptrace_process_observation(
    traces: std::collections::HashMap<libc::pid_t, PtraceProcessTrace>,
) -> ProcessObservation {
    let mut traces: Vec<_> = traces.into_values().collect();
    traces.sort_by_key(|trace| match trace.relation {
        ObservedProcessRelation::DirectChild => (0, trace.pid),
        ObservedProcessRelation::Descendant => (1, trace.pid),
    });
    ProcessObservation {
        backend: ProcessObservationBackend::PtraceExperimental,
        fidelity: ProcessObservationFidelity::Exact,
        degraded_reason: None,
        observed: traces
            .into_iter()
            .map(|trace| ObservedProcess {
                relation: trace.relation,
                program: trace.program,
                span_id: trace.span_id,
                parent_span_id: trace.parent_span_id,
                pid_hash: stable_hash(trace.pid.to_string().as_bytes()),
                parent_pid_hash: trace
                    .parent_pid
                    .map(|pid| stable_hash(pid.to_string().as_bytes())),
                argv_hash: trace.argv_hash,
                exit_code: trace.exit_code,
                termination: trace.termination,
                started_wall: trace.started_wall,
                wall_ms: trace
                    .wall_ms
                    .unwrap_or_else(|| trace.started.elapsed().as_millis()),
            })
            .collect(),
    }
}

struct DirectChildProcessObservation<'a> {
    config: &'a RunConfig,
    process_id: u32,
    parent_process_id: u32,
    process_span_id: String,
    process_started_wall: SystemTime,
    process_duration_ms: u128,
    status: ExitStatus,
}

fn direct_child_process_observation(
    input: DirectChildProcessObservation<'_>,
) -> ProcessObservation {
    debug_assert!(PROCESS_OBSERVATION_DEGRADED_REASONS
        .contains(&ProcessObservationDegradedReason::DirectChildOnly));
    ProcessObservation {
        backend: ProcessObservationBackend::DirectChild,
        fidelity: ProcessObservationFidelity::Degraded,
        degraded_reason: Some(ProcessObservationDegradedReason::DirectChildOnly),
        observed: vec![ObservedProcess {
            relation: ObservedProcessRelation::DirectChild,
            program: program_basename(input.config.argv.first().map(String::as_str)),
            span_id: input.process_span_id,
            parent_span_id: None,
            pid_hash: stable_hash(input.process_id.to_string().as_bytes()),
            parent_pid_hash: Some(stable_hash(input.parent_process_id.to_string().as_bytes())),
            argv_hash: stable_hash_lines(&input.config.argv),
            exit_code: input.status.code(),
            termination: child_termination(input.status),
            started_wall: input.process_started_wall,
            wall_ms: input.process_duration_ms,
        }],
    }
}

fn degraded_helper_stream_observation(
    child: &ChildRun,
    reason: ProcessObservationDegradedReason,
) -> ProcessObservation {
    let mut observation = child.process_observation.clone();
    observation.backend = ProcessObservationBackend::HelperStream;
    observation.fidelity = ProcessObservationFidelity::Degraded;
    observation.degraded_reason = Some(reason);
    observation
}

fn helper_stream_process_observation(
    config: &RunConfig,
    run_id: &str,
) -> Result<ProcessObservation, ProcessObservationDegradedReason> {
    let Some(socket) = config.process_helper_socket.as_ref() else {
        return Err(ProcessObservationDegradedReason::MissingPrivilege);
    };
    let events = read_helper_stream_events(socket).map_err(|cause| {
        let reason = helper_stream_read_error_reason(&cause);
        if std::env::var_os("OTEL_SCRAPE_DEBUG_HELPER_STREAM").is_some() {
            eprintln!("otel-scrape: helper-stream debug: {cause}");
        }
        reason
    })?;
    helper_events_to_process_observation(&events, run_id).inspect_err(|reason| {
        if std::env::var_os("OTEL_SCRAPE_DEBUG_HELPER_STREAM").is_some() {
            eprintln!("otel-scrape: helper-stream debug: {}", reason.as_str());
        }
    })
}

fn helper_stream_read_error_reason(cause: &io::Error) -> ProcessObservationDegradedReason {
    match cause.kind() {
        io::ErrorKind::NotFound
        | io::ErrorKind::PermissionDenied
        | io::ErrorKind::ConnectionRefused => ProcessObservationDegradedReason::MissingPrivilege,
        io::ErrorKind::ConnectionAborted
        | io::ErrorKind::ConnectionReset
        | io::ErrorKind::UnexpectedEof
        | io::ErrorKind::TimedOut
        | io::ErrorKind::WouldBlock => ProcessObservationDegradedReason::HelperDisconnect,
        io::ErrorKind::Unsupported => ProcessObservationDegradedReason::UnsupportedPlatform,
        _ => {
            if std::env::var_os("OTEL_SCRAPE_DEBUG_HELPER_STREAM").is_some() {
                eprintln!("otel-scrape: helper-stream debug: {cause}");
            }
            ProcessObservationDegradedReason::EventLoss
        }
    }
}

#[cfg(unix)]
fn read_helper_stream_events(path: &Path) -> io::Result<Vec<HelperStreamEvent>> {
    let mut stream = UnixStream::connect(path)?;
    stream.set_read_timeout(Some(OTLP_HTTP_DEFAULT_TIMEOUT))?;
    let mut body = String::new();
    stream.read_to_string(&mut body)?;
    if body.trim().is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "helper stream closed before sending events",
        ));
    }
    body.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            serde_json::from_str::<HelperStreamEvent>(line).map_err(|cause| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("invalid helper stream event: {cause}"),
                )
            })
        })
        .collect()
}

#[cfg(not(unix))]
fn read_helper_stream_events(_path: &Path) -> io::Result<Vec<HelperStreamEvent>> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "helper-stream sockets require Unix sockets",
    ))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "_tag", rename_all = "PascalCase")]
enum HelperStreamEvent {
    RunStarted(HelperRunStarted),
    Fork(HelperFork),
    Exec(HelperExec),
    Exit(HelperExit),
    Loss(HelperLoss),
    RunFinished(HelperRunFinished),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelperEventBase {
    protocol_version: u64,
    run_id: String,
    event_seq: u64,
    time_unix_nano: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelperRunStarted {
    #[serde(flatten)]
    base: HelperEventBase,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelperFork {
    #[serde(flatten)]
    base: HelperEventBase,
    pid_hash: String,
    parent_pid_hash: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelperExec {
    #[serde(flatten)]
    base: HelperEventBase,
    pid_hash: String,
    argv_hash: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelperExit {
    #[serde(flatten)]
    base: HelperEventBase,
    pid_hash: String,
    exit_code: Option<i32>,
    signal: Option<i32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelperLoss {
    #[serde(flatten)]
    base: HelperEventBase,
    reason: ProcessObservationDegradedReason,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelperRunFinished {
    #[serde(flatten)]
    base: HelperEventBase,
}

impl<'de> Deserialize<'de> for ProcessObservationDegradedReason {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        ProcessObservationDegradedReason::parse(&value)
            .ok_or_else(|| serde::de::Error::custom("unknown degraded reason"))
    }
}

#[derive(Debug, Clone)]
struct HelperProcessState {
    parent_pid_hash: String,
    started_unix_nano: u64,
    argv_hash: Option<String>,
    executed_unix_nano: Option<u64>,
    exit_code: Option<i32>,
    signal: Option<i32>,
    ended_unix_nano: Option<u64>,
}

fn helper_events_to_process_observation(
    events: &[HelperStreamEvent],
    run_id: &str,
) -> Result<ProcessObservation, ProcessObservationDegradedReason> {
    let mut expected_seq = 0_u64;
    let mut saw_start = false;
    let mut saw_finish = false;
    let mut last_event_unix_nano = None;
    let mut processes: BTreeMap<String, HelperProcessState> = BTreeMap::new();
    for event in events {
        if saw_finish {
            return Err(ProcessObservationDegradedReason::LifecycleIncomplete);
        }
        let base = helper_event_base(event);
        if base.protocol_version != u64::from(HELPER_STREAM_PROTOCOL_VERSION) {
            return Err(ProcessObservationDegradedReason::VersionMismatch);
        }
        if base.run_id != run_id {
            return Err(ProcessObservationDegradedReason::RunIdMismatch);
        }
        if base.event_seq != expected_seq {
            return Err(ProcessObservationDegradedReason::SequenceGap);
        }
        if last_event_unix_nano.is_some_and(|last| base.time_unix_nano < last) {
            return Err(ProcessObservationDegradedReason::LifecycleIncomplete);
        }
        last_event_unix_nano = Some(base.time_unix_nano);
        expected_seq = expected_seq.saturating_add(1);
        match event {
            HelperStreamEvent::RunStarted(_) => {
                if expected_seq != 1 {
                    return Err(ProcessObservationDegradedReason::LifecycleIncomplete);
                }
                saw_start = true;
            }
            HelperStreamEvent::Fork(event) => {
                if !helper_sha256_hash_is_valid(&event.pid_hash)
                    || !helper_sha256_hash_is_valid(&event.parent_pid_hash)
                {
                    return Err(ProcessObservationDegradedReason::EventLoss);
                }
                if processes
                    .insert(
                        event.pid_hash.clone(),
                        HelperProcessState {
                            parent_pid_hash: event.parent_pid_hash.clone(),
                            started_unix_nano: event.base.time_unix_nano,
                            argv_hash: None,
                            executed_unix_nano: None,
                            exit_code: None,
                            signal: None,
                            ended_unix_nano: None,
                        },
                    )
                    .is_some()
                {
                    return Err(ProcessObservationDegradedReason::LifecycleIncomplete);
                }
            }
            HelperStreamEvent::Exec(event) => {
                if !helper_sha256_hash_is_valid(&event.pid_hash)
                    || !helper_sha256_hash_is_valid(&event.argv_hash)
                {
                    return Err(ProcessObservationDegradedReason::EventLoss);
                }
                let Some(process) = processes.get_mut(&event.pid_hash) else {
                    return Err(ProcessObservationDegradedReason::LifecycleIncomplete);
                };
                if process.argv_hash.is_some() {
                    return Err(ProcessObservationDegradedReason::LifecycleIncomplete);
                }
                if process.ended_unix_nano.is_some() {
                    return Err(ProcessObservationDegradedReason::LifecycleIncomplete);
                }
                if event.base.time_unix_nano < process.started_unix_nano {
                    return Err(ProcessObservationDegradedReason::LifecycleIncomplete);
                }
                process.argv_hash = Some(event.argv_hash.clone());
                process.executed_unix_nano = Some(event.base.time_unix_nano);
            }
            HelperStreamEvent::Exit(event) => {
                if !helper_sha256_hash_is_valid(&event.pid_hash) {
                    return Err(ProcessObservationDegradedReason::EventLoss);
                }
                let Some(process) = processes.get_mut(&event.pid_hash) else {
                    return Err(ProcessObservationDegradedReason::LifecycleIncomplete);
                };
                if process.ended_unix_nano.is_some() {
                    return Err(ProcessObservationDegradedReason::LifecycleIncomplete);
                }
                let Some(executed_unix_nano) = process.executed_unix_nano else {
                    return Err(ProcessObservationDegradedReason::LifecycleIncomplete);
                };
                if event.base.time_unix_nano < process.started_unix_nano
                    || event.base.time_unix_nano < executed_unix_nano
                {
                    return Err(ProcessObservationDegradedReason::LifecycleIncomplete);
                }
                process.exit_code = event.exit_code;
                process.signal = event.signal;
                process.ended_unix_nano = Some(event.base.time_unix_nano);
            }
            HelperStreamEvent::Loss(event) => {
                return Err(event.reason);
            }
            HelperStreamEvent::RunFinished(_) => {
                saw_finish = true;
            }
        }
    }
    if !saw_start || !saw_finish || processes.is_empty() {
        return Err(ProcessObservationDegradedReason::LifecycleIncomplete);
    }

    let external_roots = processes
        .iter()
        .filter(|(_, process)| !processes.contains_key(&process.parent_pid_hash))
        .count();
    if external_roots != 1 {
        return Err(ProcessObservationDegradedReason::LifecycleIncomplete);
    }
    for process in processes.values() {
        if let Some(parent) = processes.get(&process.parent_pid_hash) {
            let Some(parent_ended_unix_nano) = parent.ended_unix_nano else {
                return Err(ProcessObservationDegradedReason::LifecycleIncomplete);
            };
            if process.started_unix_nano < parent.started_unix_nano {
                return Err(ProcessObservationDegradedReason::LifecycleIncomplete);
            }
            if process.started_unix_nano > parent_ended_unix_nano {
                return Err(ProcessObservationDegradedReason::LifecycleIncomplete);
            }
        }
    }

    let mut span_ids = BTreeMap::new();
    for pid_hash in processes.keys() {
        span_ids.insert(
            pid_hash.clone(),
            random_hex(8).map_err(|_| ProcessObservationDegradedReason::EventLoss)?,
        );
    }

    let mut process_entries: Vec<_> = processes.into_iter().collect();
    process_entries.sort_by_key(|(_, process)| process.started_unix_nano);
    let mut observed = Vec::new();
    for (pid_hash, process) in process_entries {
        let Some(argv_hash) = process.argv_hash else {
            return Err(ProcessObservationDegradedReason::LifecycleIncomplete);
        };
        let Some(ended_unix_nano) = process.ended_unix_nano else {
            return Err(ProcessObservationDegradedReason::LifecycleIncomplete);
        };
        let relation = if span_ids.contains_key(&process.parent_pid_hash) {
            ObservedProcessRelation::Descendant
        } else {
            ObservedProcessRelation::DirectChild
        };
        let parent_span_id = span_ids.get(&process.parent_pid_hash).cloned();
        observed.push(ObservedProcess {
            relation,
            // The helper-stream Exec event carries only argvHash, not a basename,
            // so no public-safe program identity is available (M1). A protocol
            // extension to carry the basename is future work.
            program: UNKNOWN_PROGRAM_BASENAME.to_owned(),
            span_id: span_ids
                .get(&pid_hash)
                .cloned()
                .ok_or(ProcessObservationDegradedReason::EventLoss)?,
            parent_span_id,
            pid_hash,
            parent_pid_hash: Some(process.parent_pid_hash),
            argv_hash,
            exit_code: process.exit_code,
            termination: process.signal.map(|signal| ChildTermination::Signal {
                signal,
                synthetic_exit_code: 128 + signal,
            }),
            started_wall: unix_nanos_to_system_time(process.started_unix_nano),
            wall_ms: u128::from(
                ended_unix_nano
                    .saturating_sub(process.started_unix_nano)
                    .saturating_div(1_000_000),
            ),
        });
    }

    Ok(ProcessObservation {
        backend: ProcessObservationBackend::HelperStream,
        fidelity: ProcessObservationFidelity::Exact,
        degraded_reason: None,
        observed,
    })
}

fn helper_sha256_hash_is_valid(value: &str) -> bool {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return false;
    };
    hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn helper_event_base(event: &HelperStreamEvent) -> &HelperEventBase {
    match event {
        HelperStreamEvent::RunStarted(event) => &event.base,
        HelperStreamEvent::Fork(event) => &event.base,
        HelperStreamEvent::Exec(event) => &event.base,
        HelperStreamEvent::Exit(event) => &event.base,
        HelperStreamEvent::Loss(event) => &event.base,
        HelperStreamEvent::RunFinished(event) => &event.base,
    }
}

fn unix_nanos_to_system_time(value: u64) -> SystemTime {
    UNIX_EPOCH + Duration::from_nanos(value)
}

#[cfg(target_os = "linux")]
fn is_process_leader(pid: libc::pid_t) -> bool {
    let Ok(status) = fs::read_to_string(format!("/proc/{pid}/status")) else {
        return true;
    };
    status
        .lines()
        .find_map(|line| line.strip_prefix("Tgid:"))
        .and_then(|value| value.trim().parse::<libc::pid_t>().ok())
        .is_none_or(|tgid| tgid == pid)
}

fn prepare_node_cpuprofile_dir(config: &RunConfig) -> io::Result<Option<PathBuf>> {
    if config.adapter != NODE_CPUPROFILE_ADAPTER {
        return Ok(None);
    }
    if !is_node_command(config.argv.first().map(String::as_str)) {
        return Ok(None);
    }
    let root = std::env::temp_dir().join(format!(
        "otel-scrape-node-cpuprofile-{}-{}",
        std::process::id(),
        random_hex(8)?
    ));
    fs::create_dir_all(&root)?;
    Ok(Some(root))
}

/// Public-safe program identity: the basename of the wrapped executable
/// (`tsc`, `vitest`, `cargo`, `sh`). Never a full path or arguments
/// (decision 0014, R01). Used both as the command span name and as the
/// `command.program` attribute.
fn program_basename(argv0: Option<&str>) -> String {
    argv0
        .and_then(|argv0| {
            Path::new(argv0)
                .file_name()
                .and_then(|name| name.to_str())
                .map(ToOwned::to_owned)
        })
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| UNKNOWN_PROGRAM_BASENAME.to_owned())
}

/// Bounded, low-cardinality program name for the command span name and the
/// `process.executable.name` attribute (decision 0016, M25.1). `span.cli`
/// explicitly permits a different low-cardinality span-name format provided it
/// is documented; this is that format.
///
/// The wrapped basename is kept verbatim when it looks like a normal program
/// name — length <= 64, a conservative safe charset (`[A-Za-z0-9._+-]`), and
/// not a content-hash / uuid / hex-nonce token. A `nix`-store `<hash>-name`
/// prefix is stripped first so `foo` survives a `/nix/store/<hash>-foo` exec.
/// Otherwise the name collapses to the bounded fallback token `<binary>`, so
/// pathological inputs (uuid temp scripts, per-test compiled binaries, hex
/// nonces) land in one bucket instead of an unbounded span name.
fn bounded_program_name(argv0: Option<&str>) -> String {
    let basename = program_basename(argv0);
    if basename == UNKNOWN_PROGRAM_BASENAME {
        return basename;
    }
    let candidate = strip_nix_store_hash_prefix(&basename);
    if is_bounded_program_name(candidate) {
        candidate.to_owned()
    } else {
        BOUNDED_PROGRAM_FALLBACK.to_owned()
    }
}

/// Strip a leading `nix`-store hash from a `<32-char-base32-hash>-name` basename
/// (decision 0016), so a direct-exec of `/nix/store/<hash>-foo` is identified as
/// `foo`. Returns the input unchanged when there is no such prefix.
fn strip_nix_store_hash_prefix(basename: &str) -> &str {
    let Some((prefix, rest)) = basename.split_once('-') else {
        return basename;
    };
    // Nix store hashes are exactly 32 lowercase base32 (nixbase32) characters.
    let is_nix_hash = prefix.len() == 32
        && prefix
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'z'));
    if is_nix_hash && !rest.is_empty() {
        rest
    } else {
        basename
    }
}

/// Whether a (nix-normalized) basename may be kept verbatim as the span name.
fn is_bounded_program_name(name: &str) -> bool {
    if name.is_empty() || name.len() > BOUNDED_PROGRAM_MAX_LEN {
        return false;
    }
    let safe_charset = name
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'+' | b'-'));
    if !safe_charset {
        return false;
    }
    !looks_like_hash_or_nonce(name)
}

/// Whether a name looks like a content hash, uuid, or hex nonce rather than a
/// real program name (decision 0016). Conservative: only long all-hex tokens and
/// uuid-shaped tokens collapse, so genuine short names (`dd`, `cafe`, `sh`) and
/// version-suffixed interpreters (`node20`, `python3.11`) survive.
fn looks_like_hash_or_nonce(name: &str) -> bool {
    if is_uuid_like(name) {
        return true;
    }
    // A long run that is entirely hexadecimal (with no separators) is a hash /
    // nonce, not a program name.
    name.len() >= HEX_NONCE_MIN_LEN && name.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Whether a name is a canonical `8-4-4-4-12` hyphenated hex uuid.
fn is_uuid_like(name: &str) -> bool {
    let groups: Vec<&str> = name.split('-').collect();
    let lengths = [8_usize, 4, 4, 4, 12];
    groups.len() == lengths.len()
        && groups
            .iter()
            .zip(lengths.iter())
            .all(|(group, &len)| group.len() == len && group.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn is_node_command(argv0: Option<&str>) -> bool {
    let Some(argv0) = argv0 else {
        return false;
    };
    matches!(
        Path::new(argv0).file_name().and_then(|name| name.to_str()),
        Some("node" | "node.exe")
    )
}

fn node_options_with_cpu_profile(existing: Option<&str>, profile_dir: &Path) -> String {
    let profile_dir = profile_dir.to_string_lossy();
    let profile_options = [
        String::from("--cpu-prof"),
        format!("--cpu-prof-dir={profile_dir}"),
        String::from("--cpu-prof-name=CPU.cpuprofile"),
    ];
    match existing.map(str::trim).filter(|value| !value.is_empty()) {
        Some(existing) => format!("{existing} {}", profile_options.join(" ")),
        None => profile_options.join(" "),
    }
}

fn join_reader(handle: thread::JoinHandle<io::Result<Vec<u8>>>) -> io::Result<Vec<u8>> {
    handle
        .join()
        .map_err(|_| io::Error::other("child output reader thread panicked"))?
}

fn tee_reader<R: Read, W: Write>(mut reader: R, mut writer: W) -> io::Result<Vec<u8>> {
    let mut captured = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        writer.write_all(&buffer[..read])?;
        writer.flush()?;
        captured.extend_from_slice(&buffer[..read]);
    }
    Ok(captured)
}

fn summary_for_status(
    config: &RunConfig,
    trace: &TraceContext,
    child_traceparent: &str,
    child: &ChildRun,
    duration_ms: u128,
    artifacts: &ArtifactSummary,
    adapter: &AdapterRun,
) -> io::Result<Summary> {
    let cwd = std::env::current_dir()?;
    Ok(Summary {
        schema: telemetry_registry::schemas::SUMMARY_V1,
        version: VERSION,
        command: CommandSummary {
            program: program_basename(config.argv.first().map(String::as_str)),
            argv_hash: stable_hash_lines(&config.argv),
            cwd_hash: stable_hash(cwd.to_string_lossy().as_bytes()),
            // Trust gate (decision 0015): the summary is hard-public-safe by
            // default. This site reads config.trusted_summary ONLY — never
            // config.trusted_otlp — so an OTLP assertion can never leak raw
            // argv/cwd into the (possibly public-tree) summary.
            argv: config.trusted_summary.then(|| config.argv.clone()),
            cwd: config
                .trusted_summary
                .then(|| cwd.to_string_lossy().into_owned()),
        },
        output: output_summary(child),
        resources: resource_summary(duration_ms),
        adapter: adapter_summary(adapter),
        artifacts: artifacts.clone(),
        processes: process_observation_summary(trace, child),
        trace: TraceSummary {
            trace_id: trace.trace_id.clone(),
            parent_span_id: trace.parent_span_id.clone(),
            span_id: trace.span_id.clone(),
            child_traceparent: child_traceparent.to_owned(),
        },
        child: ChildSummary {
            exit_code: child.status.code(),
            success: child.status.success(),
            termination: child_termination(child.status),
        },
        duration_ms,
        degraded: DegradedSummary {
            direct_child_only: child.process_observation.backend
                == ProcessObservationBackend::DirectChild,
            otlp_export: config.otlp_export_enabled && config.otlp_endpoint.is_some(),
        },
    })
}

fn process_observation_summary(
    trace: &TraceContext,
    child: &ChildRun,
) -> ProcessObservationSummary {
    let observation = &child.process_observation;
    ProcessObservationSummary {
        backend: observation.backend.as_str().to_owned(),
        fidelity: observation.fidelity.as_str().to_owned(),
        reason: observation
            .degraded_reason
            .map(|reason| reason.as_str().to_owned()),
        observed: observation
            .observed
            .iter()
            .map(|process| {
                let start_unix_nano = unix_nanos(process.started_wall);
                let end_unix_nano =
                    start_unix_nano.saturating_add(process.wall_ms.saturating_mul(1_000_000));
                ObservedProcessSummary {
                    tag: "Process",
                    relation: process.relation.as_str().to_owned(),
                    span_id: process.span_id.clone(),
                    parent_span_id: process
                        .parent_span_id
                        .clone()
                        .unwrap_or_else(|| trace.span_id.clone()),
                    pid_hash: process.pid_hash.clone(),
                    parent_pid_hash: process.parent_pid_hash.clone(),
                    argv_hash: process.argv_hash.clone(),
                    exit_code: process.exit_code,
                    termination: process.termination.clone(),
                    start_unix_nano,
                    end_unix_nano,
                    wall_ms: process.wall_ms,
                }
            })
            .collect(),
    }
}

fn output_summary(child: &ChildRun) -> OutputSummary {
    OutputSummary {
        stdout: child.stdout.as_deref().map(output_descriptor_for_bytes),
        stderr: child.stderr.as_deref().map(output_descriptor_for_bytes),
    }
}

fn output_descriptor_for_bytes(bytes: &[u8]) -> OutputDescriptor {
    OutputDescriptor {
        tag: "ContentDescriptor",
        digest: stable_hash(bytes),
        byte_length: bytes.len(),
        media_type: OUTPUT_MEDIA_TYPE,
    }
}

fn resource_summary(duration_ms: u128) -> ResourceSummary {
    ResourceSummary {
        wall_ms: duration_ms,
        cpu_time_ms: None,
        max_rss_bytes: None,
        availability: ResourceAvailability {
            cpu_time: RESOURCE_FACT_UNAVAILABLE,
            max_rss: RESOURCE_FACT_UNAVAILABLE,
        },
    }
}

fn export_command_span(
    config: &RunConfig,
    trace: &TraceContext,
    child: &ChildRun,
    started_wall: SystemTime,
    elapsed: Duration,
    adapter: &AdapterRun,
) -> io::Result<()> {
    let Some(endpoint) = config.otlp_endpoint.as_ref() else {
        return Ok(());
    };
    // Wall-clock anchor + monotonic delta (decision 0016, M25.1): the start is a
    // full-resolution unix-nanos wall clock and the end is the anchor plus the
    // monotonic elapsed delta in nanoseconds — not a whole-ms reconstruction.
    let start_unix_nano = unix_nanos(started_wall);
    let end_unix_nano = start_unix_nano.saturating_add(elapsed.as_nanos());
    let cwd = std::env::current_dir()?;
    let observation = &child.process_observation;
    // A distinct process span is emitted only under an exact backend that
    // proves a real descendant. The default degraded direct-child observation
    // is folded into the command span (decision 0014, spec Process-Tree
    // Fidelity), so the command span carries the observation attributes with
    // fidelity = "merged" and no separate process span is emitted.
    let merge_process_into_command = observation.fidelity != ProcessObservationFidelity::Exact;
    // The span name is the operation: the wrapped program's basename
    // (decision 0014), never a fixed instrumentation constant. The basename is
    // passed through the bounded low-cardinality derivation (decision 0016,
    // M25.1) so both the span name and process.executable.name are bounded.
    let program = bounded_program_name(config.argv.first().map(String::as_str));
    let mut attributes = vec![
        json!({
            "key": telemetry_registry::attributes::SCOPE_NAME,
            "value": { "stringValue": OTEL_SCRAPE_SCOPE_NAME },
        }),
        json!({
            "key": telemetry_registry::attributes::OTEL_SCRAPE_SPAN_ORIGIN,
            "value": { "stringValue": SPAN_ORIGIN_OTEL_SCRAPE },
        }),
        json!({
            "key": telemetry_registry::attributes::PROCESS_EXECUTABLE_NAME,
            "value": { "stringValue": program },
        }),
        json!({
            "key": telemetry_registry::attributes::OTEL_SCRAPE_COMMAND_ARGV_HASH,
            "value": { "stringValue": stable_hash_lines(&config.argv) },
        }),
        json!({
            "key": telemetry_registry::attributes::OTEL_SCRAPE_COMMAND_CWD_HASH,
            "value": { "stringValue": stable_hash(cwd.to_string_lossy().as_bytes()) },
        }),
        json!({
            "key": telemetry_registry::attributes::PROCESS_EXIT_CODE,
            "value": { "intValue": exit_code(child.status).to_string() },
        }),
        json!({
            "key": telemetry_registry::attributes::ADAPTER_NAME,
            "value": { "stringValue": config.adapter },
        }),
    ];
    // process.pid is REQUIRED by attributes.cli.common (decision 0016, M25.1):
    // the raw pid of the wrapped direct child. A pid is ephemeral/local (not a
    // path, argument, or credential), so it is emitted raw and is NOT trust-gated.
    if let Some(child_pid) = child.child_pid {
        attributes.push(json!({
            "key": telemetry_registry::attributes::PROCESS_PID,
            "value": { "intValue": child_pid.to_string() },
        }));
    }
    // error.type is conditionally required by attributes.cli.common iff the child
    // did not exit 0 (decision 0016, M25.1). Kept LOW cardinality: otel-scrape
    // cannot classify the wrapped tool's error domain, so it always uses the
    // semconv well-known fallback _OTHER (never the exit code or signal, which
    // would blow cardinality). Absent on success.
    if !child.status.success() {
        attributes.push(json!({
            "key": telemetry_registry::attributes::ERROR_TYPE,
            "value": { "stringValue": ERROR_TYPE_OTHER },
        }));
    }
    // Trust gate (decision 0015): raw argv/cwd enter the OTLP sink ONLY when the
    // operator asserted this sink private. This site reads config.trusted_otlp
    // and never config.trusted_summary. The hashed identity above is always
    // present regardless.
    if config.trusted_otlp {
        // process.command_args is an OTel semconv string[] (decision 0016): one
        // array element per argument, so argument boundaries survive losslessly
        // (the pre-semconv command.argv was a lossy newline-joined string). The
        // always-present correlation hash above (stable_hash_lines) is
        // unaffected; only this trust-gated raw value changes shape.
        let command_args: Vec<serde_json::Value> = config
            .argv
            .iter()
            .map(|arg| json!({ "stringValue": arg }))
            .collect();
        attributes.push(json!({
            "key": telemetry_registry::attributes::PROCESS_COMMAND_ARGS,
            "value": { "arrayValue": { "values": command_args } },
        }));
        attributes.push(json!({
            "key": telemetry_registry::attributes::PROCESS_WORKING_DIRECTORY,
            "value": { "stringValue": cwd.to_string_lossy() },
        }));
    }
    if merge_process_into_command {
        // Fold the degraded direct-child observation into the command span:
        // preserve backend + relation evidence and mark the fidelity "merged".
        let relation = observation
            .observed
            .first()
            .map(|process| process.relation.as_str())
            .unwrap_or(PROCESS_RELATION_DIRECT_CHILD);
        attributes.push(json!({
            "key": telemetry_registry::attributes::PROCESS_OBSERVATION_BACKEND,
            "value": { "stringValue": observation.backend.as_str() },
        }));
        attributes.push(json!({
            "key": telemetry_registry::attributes::PROCESS_OBSERVATION_FIDELITY,
            "value": { "stringValue": PROCESS_FIDELITY_MERGED },
        }));
        attributes.push(json!({
            "key": telemetry_registry::attributes::PROCESS_OBSERVATION_RELATION,
            "value": { "stringValue": relation },
        }));
    }
    // span.cli SHOULD set status Error when the child did not exit 0. The
    // Trace API reserves Status.description for the Error status only, so the
    // human message is attached exactly there (decision 0016, M25.1). The
    // message is bounded and non-sensitive: exit codes and signal names carry no
    // private data.
    let status = if child.status.success() {
        json!({ "code": 1 })
    } else {
        json!({ "code": 2, "message": status_error_message(child.status) })
    };
    let mut command_span = json!({
        "traceId": trace.trace_id,
        "spanId": trace.span_id,
        "name": program,
        "kind": 1,
        "startTimeUnixNano": start_unix_nano.to_string(),
        "endTimeUnixNano": end_unix_nano.to_string(),
        "attributes": attributes,
        "status": status,
    });
    if let Some(parent_span_id) = trace.parent_span_id.as_ref() {
        command_span["parentSpanId"] = json!(parent_span_id);
    }
    let events = otlp_span_events(adapter, end_unix_nano);
    if !events.is_empty() {
        command_span["events"] = json!(events);
    }
    let mut spans = vec![command_span];
    if !merge_process_into_command {
        spans.extend(process_otlp_spans(trace, observation));
    }
    let resource_attributes: Vec<serde_json::Value> = config
        .resource_attributes
        .iter()
        .map(|(key, value)| json!({ "key": key, "value": { "stringValue": value } }))
        .collect();
    // Instrumentation-scope version = otel-scrape's build machineVersion
    // (decision 0019): the git rev is baked in at build time, so a trace is
    // tied to a specific build/commit — not the bare crate `0.0.0`, which
    // discriminated no build. schemaUrl pins the semconv version on both the
    // resource and the scope so attribute semantics resolve deterministically.
    let scope_version = build_machine_version();
    let body = json!({
        "resourceSpans": [{
            "resource": {
                "attributes": resource_attributes,
            },
            "schemaUrl": SEMCONV_SCHEMA_URL,
            "scopeSpans": [{
                "scope": { "name": OTEL_SCRAPE_SCOPE_NAME, "version": scope_version },
                "schemaUrl": SEMCONV_SCHEMA_URL,
                "spans": spans,
            }],
        }],
    });
    let bytes = serde_json::to_vec(&body)?;
    post_otlp_http_json(endpoint, &config.otlp_headers, config.otlp_timeout, &bytes)
}

fn process_otlp_spans(
    trace: &TraceContext,
    observation: &ProcessObservation,
) -> Vec<serde_json::Value> {
    observation
        .observed
        .iter()
        .map(|process| {
            let process_start_unix_nano = unix_nanos(process.started_wall);
            let process_end_unix_nano =
                process_start_unix_nano.saturating_add(process.wall_ms.saturating_mul(1_000_000));
            let parent_span_id = process
                .parent_span_id
                .as_deref()
                .unwrap_or(trace.span_id.as_str());
            // The observed program name is the /proc/comm-vs-basename identity,
            // passed through the same best-effort cardinality normalization as the
            // command span (decision 0016, M25.1) so process.executable.name gets
            // consistent normalization at every emission site.
            let program = bounded_program_name(Some(process.program.as_str()));
            json!({
                "traceId": trace.trace_id,
                "spanId": process.span_id,
                "parentSpanId": parent_span_id,
                // Named by the observed descendant program basename (decision 0014).
                "name": program,
                "kind": 1,
                "startTimeUnixNano": process_start_unix_nano.to_string(),
                "endTimeUnixNano": process_end_unix_nano.to_string(),
                "attributes": [
                    {
                        "key": telemetry_registry::attributes::SCOPE_NAME,
                        "value": { "stringValue": OTEL_SCRAPE_SCOPE_NAME },
                    },
                    {
                        "key": telemetry_registry::attributes::OTEL_SCRAPE_SPAN_ORIGIN,
                        "value": { "stringValue": SPAN_ORIGIN_OTEL_SCRAPE },
                    },
                    {
                        "key": telemetry_registry::attributes::PROCESS_EXECUTABLE_NAME,
                        "value": { "stringValue": program },
                    },
                    {
                        "key": telemetry_registry::attributes::OTEL_SCRAPE_COMMAND_ARGV_HASH,
                        "value": { "stringValue": process.argv_hash },
                    },
                    {
                        "key": telemetry_registry::attributes::PROCESS_EXIT_CODE,
                        "value": { "intValue": process.exit_code.unwrap_or_else(|| synthetic_exit_code(process.termination.as_ref())).to_string() },
                    },
                    {
                        "key": telemetry_registry::attributes::PROCESS_OBSERVATION_BACKEND,
                        "value": { "stringValue": observation.backend.as_str() },
                    },
                    {
                        "key": telemetry_registry::attributes::PROCESS_OBSERVATION_FIDELITY,
                        "value": { "stringValue": observation.fidelity.as_str() },
                    },
                    {
                        "key": telemetry_registry::attributes::PROCESS_OBSERVATION_RELATION,
                        "value": { "stringValue": process.relation.as_str() },
                    },
                ],
                "status": { "code": if process.exit_code == Some(0) { 1 } else { 2 } },
            })
        })
        .collect()
}

fn synthetic_exit_code(termination: Option<&ChildTermination>) -> i32 {
    match termination {
        Some(ChildTermination::Signal {
            synthetic_exit_code,
            ..
        }) => *synthetic_exit_code,
        None => 0,
    }
}

fn otlp_span_events(adapter: &AdapterRun, time_unix_nano: u128) -> Vec<serde_json::Value> {
    let time_unix_nano = time_unix_nano.to_string();
    let mut events = Vec::new();
    for output in &adapter.outputs {
        match output {
            AdapterOutput::Event(event) => {
                let mut attrs = vec![json!({
                    "key": telemetry_registry::attributes::ADAPTER_EVENT_SEVERITY,
                    "value": { "stringValue": event.severity },
                })];
                if let Some(filename_hash) = event.filename_hash.as_ref() {
                    attrs.push(json!({
                        "key": telemetry_registry::attributes::ADAPTER_EVENT_SOURCE_FILENAME_HASH,
                        "value": { "stringValue": filename_hash },
                    }));
                }
                // rule + line are cheap, non-sensitive diagnostic locators (H5):
                // a public lint-rule code and a plain integer. The filename stays
                // hashed above; these add no path or source text.
                if let Some(rule) = event.rule.as_ref() {
                    attrs.push(json!({
                        "key": telemetry_registry::attributes::ADAPTER_EVENT_RULE,
                        "value": { "stringValue": rule },
                    }));
                }
                if let Some(line) = event.line {
                    attrs.push(json!({
                        "key": telemetry_registry::attributes::ADAPTER_EVENT_LINE,
                        "value": { "intValue": line.to_string() },
                    }));
                }
                events.push(json!({
                    "name": "otel_scrape.adapter.event",
                    "attributes": attrs,
                    "timeUnixNano": time_unix_nano,
                }));
            }
            AdapterOutput::Profile(profile) => events.push(json!({
                "name": "otel_scrape.profile.link",
                "attributes": [
                    {
                        "key": telemetry_registry::attributes::PROFILE_TYPE,
                        "value": { "stringValue": profile.profile_type },
                    },
                    {
                        "key": telemetry_registry::attributes::PROFILE_DIGEST,
                        "value": { "stringValue": profile.digest },
                    },
                    {
                        "key": telemetry_registry::attributes::PROFILE_URI,
                        "value": { "stringValue": profile.uri },
                    },
                    {
                        "key": telemetry_registry::profile_fields::BYTE_LENGTH,
                        "value": { "intValue": profile.byte_length.to_string() },
                    },
                    {
                        "key": telemetry_registry::profile_fields::MEDIA_TYPE,
                        "value": { "stringValue": profile.media_type },
                    },
                ],
                "timeUnixNano": time_unix_nano,
            })),
            AdapterOutput::Metric(_) | AdapterOutput::Span(_) => {}
        }
    }
    events
}

fn unix_nanos(time: SystemTime) -> u128 {
    time.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}

fn post_otlp_http_json(
    endpoint: &str,
    headers: &[(String, String)],
    timeout: Duration,
    body: &[u8],
) -> io::Result<()> {
    let endpoint = parse_http_endpoint(endpoint)?;
    let socket_addr = (endpoint.host.as_str(), endpoint.port)
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "endpoint did not resolve"))?;
    let timeout = if timeout.is_zero() {
        OTLP_HTTP_DEFAULT_TIMEOUT
    } else {
        timeout
    };
    let mut stream = TcpStream::connect_timeout(&socket_addr, timeout)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    let mut request = format!(
        "POST {} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nUser-Agent: otel-scrape/{VERSION}\r\n",
        endpoint.path,
        endpoint.host_header,
    );
    for (name, value) in headers {
        if !is_safe_http_header_name(name) || !is_safe_http_header_value(value) {
            continue;
        }
        write!(&mut request, "{name}: {value}\r\n")
            .map_err(|cause| io::Error::other(cause.to_string()))?;
    }
    write!(
        &mut request,
        "Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .map_err(|cause| io::Error::other(cause.to_string()))?;
    stream.write_all(request.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()?;

    let mut response = Vec::new();
    stream.read_to_end(&mut response)?;
    let status_line = response
        .split(|byte| *byte == b'\n')
        .next()
        .and_then(|line| std::str::from_utf8(line).ok())
        .unwrap_or_default()
        .trim_end_matches('\r');
    if status_line.starts_with("HTTP/1.1 2") || status_line.starts_with("HTTP/1.0 2") {
        return Ok(());
    }
    Err(io::Error::other(format!(
        "collector returned {status_line}"
    )))
}

fn is_safe_http_header_name(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| {
            matches!(
                byte,
                b'!' | b'#' | b'$' | b'%' | b'&' | b'\'' | b'*' | b'+' | b'-' | b'.'
                    | b'^' | b'_' | b'`' | b'|' | b'~' | b'0'..=b'9' | b'A'..=b'Z'
                    | b'a'..=b'z'
            )
        })
}

fn is_safe_http_header_value(value: &str) -> bool {
    !value.bytes().any(|byte| byte == b'\r' || byte == b'\n')
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HttpEndpoint {
    host: String,
    host_header: String,
    port: u16,
    path: String,
}

impl HttpEndpoint {
    fn warning_label(&self) -> String {
        format!("http://{}/...", self.host_header)
    }
}

fn endpoint_for_warning(value: &str) -> String {
    parse_http_endpoint(value)
        .map(|endpoint| endpoint.warning_label())
        .unwrap_or_else(|_| String::from("<invalid http endpoint>"))
}

fn otlp_env_config() -> OtlpEnvConfig {
    let sdk_disabled = env_bool(OTEL_SDK_DISABLED_ENV);
    let exporter_enabled = otlp_trace_exporter_enabled();
    let protocol = signal_env_string(OTLP_TRACES_PROTOCOL_ENV, OTLP_PROTOCOL_ENV)
        .map(|value| value.to_ascii_lowercase());
    let protocol_enabled = match protocol.as_deref() {
        None | Some("http/json") => true,
        Some("grpc" | "http/protobuf") => {
            eprintln!(
                "otel-scrape: warning: {OTLP_TRACES_PROTOCOL_ENV}/{OTLP_PROTOCOL_ENV} requested a protocol not supported by this HTTP/JSON exporter; trace export is disabled"
            );
            false
        }
        Some(other) => {
            eprintln!("otel-scrape: warning: ignoring unrecognized OTLP protocol {other}");
            true
        }
    };
    let compression = signal_env_string(OTLP_TRACES_COMPRESSION_ENV, OTLP_COMPRESSION_ENV)
        .map(|value| value.to_ascii_lowercase());
    let compression_enabled = match compression.as_deref() {
        None | Some("none") => true,
        Some("gzip") => {
            eprintln!(
                "otel-scrape: warning: {OTLP_TRACES_COMPRESSION_ENV}/{OTLP_COMPRESSION_ENV}=gzip is not supported by this first-party JSON exporter; trace export is disabled"
            );
            false
        }
        Some(other) => {
            eprintln!("otel-scrape: warning: ignoring unrecognized OTLP compression {other}");
            true
        }
    };
    let mut resource_attributes = parse_key_value_list_env(RESOURCE_ATTRIBUTES_ENV, "resource");
    set_resource_attribute(&mut resource_attributes, "telemetry.sdk.language", "rust");
    set_resource_attribute(
        &mut resource_attributes,
        "telemetry.sdk.name",
        "otel-scrape",
    );
    set_resource_attribute(&mut resource_attributes, "telemetry.sdk.version", VERSION);
    // Resolve service.name: OTEL_SERVICE_NAME wins, then a service.name supplied
    // via OTEL_RESOURCE_ATTRIBUTES, else otel-scrape's own default.
    let service_name_env = env_string(SERVICE_NAME_ENV);
    let service_name_from_resource = resource_attribute(&resource_attributes, "service.name");
    let service_name_supplied = service_name_env.is_some() || service_name_from_resource.is_some();
    let service_name = service_name_env
        .or(service_name_from_resource)
        .unwrap_or_else(|| String::from("otel-scrape"));
    // service.version defaults to otel-scrape's build machineVersion (decision
    // 0019) ONLY when service.name is also otel-scrape's own default — i.e.
    // neither OTEL_SERVICE_NAME nor a service.name in OTEL_RESOURCE_ATTRIBUTES was
    // supplied. When a user/harness supplies service.name, service.* names the
    // enclosing harness, so stamping otel-scrape's version onto it would be wrong.
    // A user-supplied service.version always wins. scope.version carries
    // otel-scrape's build unambiguously regardless.
    if !service_name_supplied
        && resource_attribute(&resource_attributes, "service.version").is_none()
    {
        set_resource_attribute(
            &mut resource_attributes,
            "service.version",
            &build_machine_version(),
        );
    }
    set_resource_attribute(&mut resource_attributes, "service.name", &service_name);

    OtlpEnvConfig {
        endpoint: otlp_env_endpoint(),
        headers: otlp_env_headers(),
        timeout: signal_env_string(OTLP_TRACES_TIMEOUT_ENV, OTLP_TIMEOUT_ENV)
            .and_then(|value| parse_timeout_ms(&value))
            .unwrap_or(OTLP_HTTP_DEFAULT_TIMEOUT),
        export_enabled: !sdk_disabled
            && exporter_enabled
            && protocol_enabled
            && compression_enabled,
        service_name,
        resource_attributes,
    }
}

fn otlp_trace_exporter_enabled() -> bool {
    let Some(value) = env_string(OTEL_TRACES_EXPORTER_ENV) else {
        return true;
    };
    let exporters = value
        .split(',')
        .map(|part| part.trim().to_ascii_lowercase())
        .filter(|part| !part.is_empty());
    let mut saw_supported = false;
    let mut saw_none = false;
    let mut saw_unsupported_known = false;
    for exporter in exporters {
        match exporter.as_str() {
            "otlp" => {
                saw_supported = true;
            }
            "none" => saw_none = true,
            "zipkin" | "console" | "logging" | "otlp/stdout" => {
                saw_unsupported_known = true;
                eprintln!(
                    "otel-scrape: warning: {OTEL_TRACES_EXPORTER_ENV}={exporter} is not supported by this first-party exporter"
                );
            }
            other => {
                eprintln!(
                    "otel-scrape: warning: ignoring unrecognized {OTEL_TRACES_EXPORTER_ENV} value {other}"
                );
            }
        }
    }
    saw_supported || (!saw_none && !saw_unsupported_known)
}

fn otlp_env_endpoint() -> Option<String> {
    if let Some(value) = env_string(OTLP_TRACES_ENDPOINT_ENV) {
        return Some(normalize_otlp_trace_endpoint(&value));
    }
    env_string(OTLP_ENDPOINT_ENV).map(|value| normalize_otlp_base_endpoint(&value))
}

fn otlp_env_headers() -> Vec<(String, String)> {
    if env_string(OTLP_TRACES_HEADERS_ENV).is_some() {
        parse_key_value_list_env(OTLP_TRACES_HEADERS_ENV, "header")
    } else {
        parse_key_value_list_env(OTLP_HEADERS_ENV, "header")
    }
}

fn normalize_otlp_trace_endpoint(value: &str) -> String {
    if endpoint_has_path(value) {
        value.to_owned()
    } else {
        format!("{}/", value.trim_end_matches('/'))
    }
}

fn normalize_otlp_base_endpoint(value: &str) -> String {
    let base = value.trim_end_matches('/');
    format!("{base}/v1/traces")
}

fn endpoint_has_path(value: &str) -> bool {
    value
        .strip_prefix("http://")
        .or_else(|| value.strip_prefix("https://"))
        .and_then(|rest| rest.split_once('/').map(|(_, path)| !path.is_empty()))
        .unwrap_or(false)
}

fn signal_env_string(signal_name: &str, generic_name: &str) -> Option<String> {
    env_string(signal_name).or_else(|| env_string(generic_name))
}

fn env_string(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .and_then(|value| if value.is_empty() { None } else { Some(value) })
}

fn env_bool(name: &str) -> bool {
    match env_string(name).map(|value| value.to_ascii_lowercase()) {
        Some(value) if value == "true" => true,
        Some(value) if value == "false" => false,
        Some(value) => {
            eprintln!("otel-scrape: warning: ignoring invalid boolean {name}={value}");
            false
        }
        None => false,
    }
}

fn parse_timeout_ms(value: &str) -> Option<Duration> {
    match value.parse::<u64>() {
        Ok(ms) => Some(Duration::from_millis(ms)),
        Err(cause) => {
            eprintln!("otel-scrape: warning: ignoring invalid OTLP timeout {value}: {cause}");
            None
        }
    }
}

fn parse_key_value_list_env(name: &str, value_kind: &str) -> Vec<(String, String)> {
    let Some(value) = env_string(name) else {
        return Vec::new();
    };
    value
        .split(',')
        .filter_map(|part| {
            let trimmed = part.trim();
            if trimmed.is_empty() {
                return None;
            }
            let Some((key, value)) = trimmed.split_once('=') else {
                eprintln!(
                    "otel-scrape: warning: ignoring malformed OTEL {value_kind} entry in {name}"
                );
                return None;
            };
            if key.is_empty() || value.contains('\r') || value.contains('\n') {
                eprintln!(
                    "otel-scrape: warning: ignoring unsafe OTEL {value_kind} entry in {name}"
                );
                return None;
            }
            Some((key.to_owned(), value.to_owned()))
        })
        .collect()
}

fn set_resource_attribute(attrs: &mut Vec<(String, String)>, key: &str, value: &str) {
    if let Some((_, existing)) = attrs.iter_mut().find(|(attr_key, _)| attr_key == key) {
        *existing = value.to_owned();
    } else {
        attrs.push((key.to_owned(), value.to_owned()));
    }
}

fn resource_attribute(attrs: &[(String, String)], key: &str) -> Option<String> {
    attrs
        .iter()
        .find_map(|(attr_key, value)| (attr_key == key).then(|| value.clone()))
}

fn validate_http_endpoint(value: &str) -> Result<(), UsageError> {
    parse_http_endpoint(value)
        .map(|_| ())
        .map_err(|cause| UsageError {
            message: format!("--otlp-endpoint must be an http URL: {cause}"),
        })
}

fn parse_http_endpoint(value: &str) -> io::Result<HttpEndpoint> {
    let Some(rest) = value.strip_prefix("http://") else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "only http:// endpoints are supported in this slice",
        ));
    };
    if rest.contains('?') || rest.contains('#') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "endpoint query and fragment are not accepted",
        ));
    }
    let (authority, path, has_explicit_path) = match rest.split_once('/') {
        Some((authority, path)) => (authority, path, true),
        None => (rest, "", false),
    };
    if authority.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "missing endpoint host",
        ));
    }
    if authority.contains('@') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "endpoint user info is not accepted",
        ));
    }
    let (host, port) = authority.rsplit_once(':').map_or_else(
        || Ok((authority.to_owned(), 80)),
        |(host, port)| {
            if host.is_empty() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "missing endpoint host",
                ));
            }
            let port = port.parse::<u16>().map_err(|cause| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("invalid port: {cause}"),
                )
            })?;
            Ok((host.to_owned(), port))
        },
    )?;
    let path = if !has_explicit_path {
        String::from("/v1/traces")
    } else if path.is_empty() {
        String::from("/")
    } else {
        format!("/{path}")
    };
    Ok(HttpEndpoint {
        host,
        host_header: authority.to_owned(),
        port,
        path,
    })
}

#[derive(Debug, Clone)]
struct AdapterRun {
    name: String,
    stdout_ownership: AdapterStdoutOwnership,
    outputs: Vec<AdapterOutput>,
    /// The human summary otel-scrape renders to the terminal for a needs-render
    /// adapter (decision 0017: oxlint pretty-out). `Some` only when the structured
    /// source parsed; `None` for side-channel/pass-through adapters and on a parse
    /// failure (the caller then flushes the captured raw bytes instead).
    render: Option<String>,
}

/// The stdout presentation mode for the wrapped child (decision 0017). Depends
/// only on `config`, so it is resolved BEFORE the child is spawned to decide the
/// capture strategy, and again at emission to decide presentation.
fn stdout_mode(config: &RunConfig) -> StdoutMode {
    match config.adapter.as_str() {
        "none" => StdoutMode::Inherit,
        // vitest is a side-channel adapter: its JSON goes to a file otel-scrape
        // injects; its human output stays on stdout untouched (decision 0017).
        VITEST_ADAPTER => StdoutMode::Inherit,
        OXLINT_ADAPTER => {
            if invokes_nested_otel_scrape(config) {
                // The nested otel-scrape renders; the outer only passes it through.
                StdoutMode::TeeLive
            } else {
                // Leaf: suppress the raw JSON tee and render a summary in its place.
                StdoutMode::CaptureSilent
            }
        }
        // node-cpuprofile emits a side-artifact (the profile) while its human
        // stdout stays readable, so it is captured AND streamed live.
        NODE_CPUPROFILE_ADAPTER => StdoutMode::TeeLive,
        // The adapter set is closed and validated in parse_args; any other value
        // reaching here is a bug, not a silent tee of raw structured output. A new
        // adapter MUST be classified deliberately by adding an arm above.
        other => unreachable!("unclassified adapter for stdout mode: {other}"),
    }
}

fn adapter_ownership(config: &RunConfig) -> AdapterStdoutOwnership {
    match config.adapter.as_str() {
        VITEST_ADAPTER => AdapterStdoutOwnership::Inherited,
        _ if config.adapter != "none" && invokes_nested_otel_scrape(config) => {
            AdapterStdoutOwnership::ChildWrapper
        }
        _ => AdapterStdoutOwnership::ThisWrapper,
    }
}

fn adapter_outputs(
    config: &RunConfig,
    structured_source: &[u8],
    artifacts: &ArtifactSummary,
) -> AdapterRun {
    let stdout_ownership = adapter_ownership(config);
    let (mut outputs, render) = match (stdout_ownership, config.adapter.as_str()) {
        (AdapterStdoutOwnership::ThisWrapper, OXLINT_ADAPTER) => oxlint_adapter(structured_source),
        (AdapterStdoutOwnership::Inherited, VITEST_ADAPTER) => {
            match vitest_outputs(structured_source) {
                Ok(outputs) => (outputs, None),
                // Degrade non-silently (decision 0017 clause 2): warn once to stderr and
                // omit the vitest metrics rather than emitting a misleading 0/0. The
                // wrapped command's own output and exit code are unaffected.
                Err(reason) => {
                    eprintln!(
                    "otel-scrape: warning: vitest side-channel unavailable ({reason}); skipping vitest metrics"
                );
                    (Vec::new(), None)
                }
            }
        }
        _ => (Vec::new(), None),
    };
    outputs.extend(
        artifacts
            .profiles
            .iter()
            .cloned()
            .map(AdapterOutput::Profile),
    );

    AdapterRun {
        name: config.adapter.clone(),
        stdout_ownership,
        outputs,
        render,
    }
}

/// The bytes of the declared structured source (decision 0017): the child's
/// captured stdout for oxlint, the injected side-channel file for vitest, empty
/// otherwise. Read once after the child exits.
fn adapter_structured_source(config: &RunConfig, child: &ChildRun) -> Vec<u8> {
    match config.adapter.as_str() {
        OXLINT_ADAPTER => child.stdout.clone().unwrap_or_default(),
        VITEST_ADAPTER => child
            .sidechannel_file
            .as_ref()
            .and_then(|path| std::fs::read(path).ok())
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// Present the wrapped child's stdout for a CaptureSilent adapter (decision 0017,
/// R30). Only oxlint-leaf suppresses its raw stdout; every other mode already
/// wrote to the terminal (TeeLive) or inherited it (Inherit). On a successful
/// parse the human summary is rendered; on a parse failure the captured raw bytes
/// are flushed so output is never swallowed.
fn present_adapter_stdout(config: &RunConfig, adapter: &AdapterRun, child: &ChildRun) {
    if stdout_mode(config) != StdoutMode::CaptureSilent {
        return;
    }
    let mut stdout = io::stdout();
    match adapter.render.as_deref() {
        Some(render) => {
            let _ = stdout.write_all(render.as_bytes());
        }
        None => {
            if let Some(raw) = child.stdout.as_deref() {
                let _ = stdout.write_all(raw);
            }
        }
    }
    let _ = stdout.flush();
}

/// Remove the vitest side-channel file after its structured source is consumed
/// (decision 0017). Only removes a file otel-scrape created — a user-supplied
/// `--outputFile.json` is left untouched (data-loss guard, clause 2). Best-effort:
/// a failure here never affects the child's exit.
fn cleanup_sidechannel_file(child: &ChildRun) {
    if !child.sidechannel_owned {
        return;
    }
    if let Some(path) = child.sidechannel_file.as_ref() {
        let _ = std::fs::remove_file(path);
    }
}

fn adapter_summary(adapter: &AdapterRun) -> AdapterSummary {
    AdapterSummary {
        name: adapter.name.clone(),
        ownership: AdapterOwnershipSummary {
            stdout: adapter.stdout_ownership.as_summary_value(),
        },
        records: adapter
            .outputs
            .iter()
            .filter_map(adapter_summary_record)
            .collect(),
    }
}

fn adapter_summary_record(output: &AdapterOutput) -> Option<AdapterSummaryRecord> {
    match output {
        AdapterOutput::Event(event) => Some(AdapterSummaryRecord::Event(event.clone())),
        AdapterOutput::Metric(metric) => Some(AdapterSummaryRecord::Metric(metric.clone())),
        AdapterOutput::Span(span) => {
            let _ = (&span.name, &span.identity_hash, span.duration_ms);
            None
        }
        AdapterOutput::Profile(_) => None,
    }
}

fn invokes_nested_otel_scrape(config: &RunConfig) -> bool {
    let Some(child_argv0) = config.argv.first() else {
        return false;
    };

    let child_path = Path::new(child_argv0);
    if let (Ok(current), Ok(child)) = (std::env::current_exe(), child_path.canonicalize()) {
        if current == child {
            return true;
        }
    }

    matches!(
        child_path.file_name().and_then(|name| name.to_str()),
        Some("otel-scrape" | ".otel-scrape-wrapped")
    )
}

fn parse_profile_artifact(value: &str) -> Result<ProfileArtifactInput, UsageError> {
    let Some((profile_type, path)) = value.split_once(':') else {
        return usage_error("--profile-artifact must be <type>:<path>");
    };
    if profile_type.is_empty()
        || !profile_type
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return usage_error(
            "--profile-artifact type must use only ASCII letters, digits, '.', '_' or '-'",
        );
    }
    if path.is_empty() {
        return usage_error("--profile-artifact path must not be empty");
    }
    Ok(ProfileArtifactInput {
        profile_type: profile_type.to_owned(),
        path: PathBuf::from(path),
    })
}

fn artifact_summary(
    config: &RunConfig,
    trace: &TraceContext,
    discovered_artifacts: &DiscoveredProfileArtifacts,
) -> io::Result<ArtifactSummary> {
    if config.profile_artifacts.is_empty() && discovered_artifacts.artifacts.is_empty() {
        return Ok(ArtifactSummary {
            profiles: Vec::new(),
            manifest: None,
            errors: discovered_artifacts.errors.clone(),
        });
    }

    let root = config
        .cas_root
        .as_ref()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing CAS root"))?;
    let mut artifact_inputs =
        Vec::with_capacity(config.profile_artifacts.len() + discovered_artifacts.artifacts.len());
    artifact_inputs.extend(config.profile_artifacts.iter().cloned());
    artifact_inputs.extend(discovered_artifacts.artifacts.iter().cloned());

    let mut profiles = Vec::with_capacity(artifact_inputs.len());
    let mut manifest_entries = Vec::with_capacity(artifact_inputs.len());
    let mut errors = discovered_artifacts.errors.clone();
    for artifact in &artifact_inputs {
        let bytes = match fs::read(&artifact.path) {
            Ok(bytes) => bytes,
            Err(cause) => {
                errors.push(artifact_error(
                    artifact,
                    format!("failed to read profile artifact: {cause}"),
                ));
                continue;
            }
        };
        let descriptor = descriptor_for_bytes(&bytes, PROFILE_MEDIA_TYPE, None, None);
        if let Err(cause) = write_object(root, &descriptor, &bytes) {
            errors.push(artifact_error(
                artifact,
                format!("failed to write profile artifact object: {cause}"),
            ));
            continue;
        }
        let link = ProfileLink {
            profile_type: artifact.profile_type.clone(),
            digest: descriptor.digest.clone(),
            uri: cas_uri_for_digest(&descriptor.digest),
            byte_length: descriptor.byte_length,
            media_type: descriptor.media_type,
        };
        manifest_entries.push(ManifestEntry {
            descriptor,
            logical_path: format!("profiles/{}-{}", profiles.len(), artifact.profile_type),
            role: String::from("profile"),
        });
        profiles.push(link);
    }

    if manifest_entries.is_empty() {
        return Ok(ArtifactSummary {
            profiles,
            manifest: None,
            errors,
        });
    }

    let manifest_json = canonical_manifest_json(&manifest_entries);
    let manifest_descriptor = descriptor_for_bytes(
        manifest_json.as_bytes(),
        MANIFEST_MEDIA_TYPE,
        Some(CANONICAL_JSON_CODEC),
        Some(1),
    );
    if let Err(cause) = write_object(root, &manifest_descriptor, manifest_json.as_bytes()) {
        errors.push(ArtifactError {
            profile_type: None,
            path_hash: None,
            message: format!("failed to write profile artifact manifest: {cause}"),
        });
        return Ok(ArtifactSummary {
            profiles,
            manifest: None,
            errors,
        });
    }
    let pin = config
        .cas_pin
        .clone()
        .unwrap_or_else(|| format!("runs/{}/{}", trace.trace_id, trace.span_id));
    if let Err(cause) = write_pin(root, &pin, &manifest_descriptor) {
        errors.push(ArtifactError {
            profile_type: None,
            path_hash: None,
            message: format!("failed to write profile artifact pin: {cause}"),
        });
        return Ok(ArtifactSummary {
            profiles,
            manifest: None,
            errors,
        });
    }

    Ok(ArtifactSummary {
        profiles,
        manifest: Some(ManifestLink {
            digest: manifest_descriptor.digest.clone(),
            uri: cas_uri_for_digest(&manifest_descriptor.digest),
            byte_length: manifest_descriptor.byte_length,
            media_type: manifest_descriptor.media_type,
            codec: manifest_descriptor
                .codec
                .expect("manifest descriptors are canonical-json"),
            schema_version: manifest_descriptor
                .schema_version
                .expect("manifest descriptors are versioned"),
            pin,
            entry_count: manifest_entries.len(),
        }),
        errors,
    })
}

fn artifact_error(artifact: &ProfileArtifactInput, message: String) -> ArtifactError {
    ArtifactError {
        profile_type: Some(artifact.profile_type.clone()),
        path_hash: Some(hash_path_identity(&artifact.path.to_string_lossy())),
        message,
    }
}

#[derive(Debug, Default)]
struct DiscoveredProfileArtifacts {
    artifacts: Vec<ProfileArtifactInput>,
    errors: Vec<ArtifactError>,
}

fn discover_adapter_profile_artifacts(
    config: &RunConfig,
    child: &ChildRun,
) -> DiscoveredProfileArtifacts {
    if config.adapter != NODE_CPUPROFILE_ADAPTER {
        return DiscoveredProfileArtifacts::default();
    }
    let Some(profile_dir) = child.node_profile_dir.as_ref() else {
        return DiscoveredProfileArtifacts {
            artifacts: Vec::new(),
            errors: vec![ArtifactError {
                profile_type: Some(String::from("cpuprofile")),
                path_hash: None,
                message: String::from(
                    "node-cpuprofile adapter degraded: child command is not node",
                ),
            }],
        };
    };

    let mut profile_paths = match fs::read_dir(profile_dir) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("cpuprofile"))
            .collect::<Vec<_>>(),
        Err(cause) => {
            return DiscoveredProfileArtifacts {
                artifacts: Vec::new(),
                errors: vec![ArtifactError {
                    profile_type: Some(String::from("cpuprofile")),
                    path_hash: Some(hash_path_identity(&profile_dir.to_string_lossy())),
                    message: format!("node-cpuprofile adapter degraded: failed to read profile directory: {cause}"),
                }],
            };
        }
    };
    profile_paths.sort();

    if profile_paths.is_empty() {
        return DiscoveredProfileArtifacts {
            artifacts: Vec::new(),
            errors: vec![ArtifactError {
                profile_type: Some(String::from("cpuprofile")),
                path_hash: Some(hash_path_identity(&profile_dir.to_string_lossy())),
                message: String::from(
                    "node-cpuprofile adapter degraded: no .cpuprofile file produced",
                ),
            }],
        };
    }

    let mut artifacts = Vec::new();
    let mut errors = Vec::new();
    if profile_paths.len() > 1 {
        errors.push(ArtifactError {
            profile_type: Some(String::from("cpuprofile")),
            path_hash: Some(hash_path_identity(&profile_dir.to_string_lossy())),
            message: format!(
                "node-cpuprofile adapter degraded: expected one .cpuprofile file, found {}",
                profile_paths.len()
            ),
        });
    }

    for path in profile_paths {
        match validate_cpuprofile_file(&path) {
            Ok(()) => artifacts.push(ProfileArtifactInput {
                profile_type: String::from("cpuprofile"),
                path,
            }),
            Err(cause) => errors.push(ArtifactError {
                profile_type: Some(String::from("cpuprofile")),
                path_hash: Some(hash_path_identity(&path.to_string_lossy())),
                message: format!(
                    "node-cpuprofile adapter degraded: malformed profile JSON: {cause}"
                ),
            }),
        }
    }

    DiscoveredProfileArtifacts { artifacts, errors }
}

fn validate_cpuprofile_file(path: &Path) -> io::Result<()> {
    let bytes = fs::read(path)?;
    validate_cpuprofile_bytes(&bytes)
}

fn validate_cpuprofile_bytes(bytes: &[u8]) -> io::Result<()> {
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|cause| {
        io::Error::new(io::ErrorKind::InvalidData, format!("invalid JSON: {cause}"))
    })?;
    let is_valid = value.as_object().is_some_and(|object| {
        object
            .get("nodes")
            .and_then(|value| value.as_array())
            .is_some()
            && object
                .get("samples")
                .and_then(|value| value.as_array())
                .is_some()
    });
    if is_valid {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "expected V8 cpuprofile object with nodes and samples",
        ))
    }
}

fn cleanup_adapter_profile_artifacts(child: &ChildRun) {
    if let Some(profile_dir) = child.node_profile_dir.as_ref() {
        let _ = fs::remove_dir_all(profile_dir);
    }
}

#[derive(Debug, Deserialize)]
struct OxlintJson {
    #[serde(default)]
    diagnostics: Vec<OxlintDiagnostic>,
}

#[derive(Debug, Deserialize)]
struct OxlintDiagnostic {
    message: String,
    severity: String,
    filename: Option<String>,
    /// The oxlint rule code (e.g. `eslint(no-unused-vars)`). Public-safe (H5):
    /// emitted verbatim as the sink-facing `rule`. Parsed defensively and
    /// omitted when absent.
    #[serde(default)]
    code: Option<String>,
    /// Diagnostic source labels (oxlint miette JSON): each carries a `span`
    /// whose `line` is the public-safe 1-based location (H5). Parsed defensively;
    /// the first label with a line supplies the event `line`.
    #[serde(default)]
    labels: Vec<OxlintLabel>,
}

#[derive(Debug, Deserialize)]
struct OxlintLabel {
    #[serde(default)]
    span: Option<OxlintSpan>,
}

#[derive(Debug, Deserialize)]
struct OxlintSpan {
    #[serde(default)]
    line: Option<u32>,
}

/// The subset of vitest's `--reporter=json` summary otel-scrape consumes from the
/// side-channel file. Counts only (decision 0017): no per-test names/files/errors.
#[derive(Debug, Deserialize)]
struct VitestJson {
    #[serde(rename = "numTotalTests", default)]
    num_total_tests: u64,
    #[serde(rename = "numFailedTests", default)]
    num_failed_tests: u64,
}

/// oxlint structured-in / pretty-out (decision 0017): parse the `--format=json`
/// report into public-safe adapter records (severity + hashed filename + count),
/// and produce a human summary otel-scrape renders to the terminal in place of the
/// suppressed raw JSON.
///
/// PRECONDITION: the caller must pass `--format=json` to oxlint (0017 clause 2 —
/// the usage site adopts the format flag). oxlint has no side-channel, so its
/// human output on stdout IS its default format; otel-scrape captures stdout and
/// re-renders. On non-JSON stdout the parse fails and this returns `(outputs,
/// None)`, so `present_adapter_stdout` flushes the captured raw bytes instead of
/// swallowing output — the human render is simply unavailable.
fn oxlint_adapter(structured_source: &[u8]) -> (Vec<AdapterOutput>, Option<String>) {
    let Ok(report) = serde_json::from_slice::<OxlintJson>(structured_source) else {
        return (Vec::new(), None);
    };

    let mut records = Vec::with_capacity(report.diagnostics.len() + 1);
    records.push(AdapterOutput::Metric(AdapterMetric {
        name: telemetry_registry::metrics::OXLINT_DIAGNOSTICS,
        value: report.diagnostics.len() as u64,
    }));

    for diagnostic in &report.diagnostics {
        records.push(AdapterOutput::Event(AdapterEvent {
            severity: diagnostic.severity.clone(),
            filename_hash: diagnostic.filename.as_deref().map(hash_path_identity),
            // rule = the linter code verbatim; line = the first labelled source
            // line (H5). Both public-safe (a rule name + an integer); the path
            // stays hashed above.
            rule: diagnostic.code.clone(),
            line: diagnostic
                .labels
                .iter()
                .find_map(|label| label.span.as_ref().and_then(|span| span.line)),
        }));
    }

    let render = oxlint_render(&report.diagnostics);
    (records, Some(render))
}

/// The terminal render for oxlint (decision 0017 clause 3, R30). This is the
/// operator's own machine, not a telemetry sink, so it MAY show full messages and
/// paths (clause 4). The sink-facing records never carry them.
fn oxlint_render(diagnostics: &[OxlintDiagnostic]) -> String {
    let file_count = diagnostics
        .iter()
        .filter_map(|diagnostic| diagnostic.filename.as_deref())
        .collect::<std::collections::BTreeSet<_>>()
        .len();
    let mut out = format!(
        "oxlint: {} diagnostic(s) over {} file(s)\n",
        diagnostics.len(),
        file_count,
    );
    for diagnostic in diagnostics {
        let file = diagnostic.filename.as_deref().unwrap_or("<unknown>");
        out.push_str("  ");
        out.push_str(&diagnostic.severity);
        out.push_str("  ");
        out.push_str(file);
        if let Some(code) = diagnostic.code.as_deref() {
            out.push_str("  ");
            out.push_str(code);
        }
        out.push_str("  ");
        out.push_str(&diagnostic.message);
        out.push('\n');
    }
    out
}

/// vitest side-channel adapter (decision 0017): parse the `--reporter=json`
/// report written to `--outputFile.json`. Public-safe count metrics only — no test
/// names, files, or failure messages cross a sink. Presentation is left to vitest's
/// own stdout (side-channel), so there is no render.
///
/// Returns `Err(reason)` when the side-channel is unavailable — a missing/empty
/// file (collapsed to empty bytes upstream) or unparseable JSON. `VitestJson` uses
/// `#[serde(default)]`, so without this guard an absent side-channel would silently
/// parse to `tests=0 / failures=0`; instead the caller WARNS and omits the metrics
/// rather than reporting misleading zeroes. A validly-parsed report with genuine
/// zero counts is `Ok` and IS emitted.
fn vitest_outputs(structured_source: &[u8]) -> Result<Vec<AdapterOutput>, &'static str> {
    if structured_source.is_empty() {
        return Err("no side-channel output (missing or empty file)");
    }
    let Ok(report) = serde_json::from_slice::<VitestJson>(structured_source) else {
        return Err("unparseable side-channel JSON");
    };
    Ok(vec![
        AdapterOutput::Metric(AdapterMetric {
            name: telemetry_registry::metrics::VITEST_TESTS,
            value: report.num_total_tests,
        }),
        AdapterOutput::Metric(AdapterMetric {
            name: telemetry_registry::metrics::VITEST_FAILURES,
            value: report.num_failed_tests,
        }),
    ])
}

fn hash_path_identity(path: &str) -> String {
    stable_hash(Path::new(path).to_string_lossy().as_bytes())
}

fn validate_pin_name(name: &str) -> Result<(), UsageError> {
    content_address::validate_pin_name(name).map_err(|message| UsageError {
        message: message.to_owned(),
    })
}

fn write_summary(path: &Path, summary: &Summary) -> io::Result<()> {
    let mut bytes = serde_json::to_vec(summary)?;
    bytes.push(b'\n');
    write_bytes_atomic(path, &bytes)
}

fn trace_context_from_env() -> io::Result<TraceContext> {
    let parent = std::env::var(TRACEPARENT_ENV)
        .ok()
        .or_else(|| std::env::var("TRACEPARENT").ok())
        .and_then(|value| parse_traceparent(&value));

    let span_id = random_hex(8)?;
    match parent {
        Some(parent) => Ok(TraceContext {
            trace_id: parent.trace_id,
            parent_span_id: Some(parent.span_id),
            span_id,
            flags: parent.flags,
        }),
        None => Ok(TraceContext {
            trace_id: random_hex(16)?,
            parent_span_id: None,
            span_id,
            flags: String::from(TRACE_FLAGS_SAMPLED),
        }),
    }
}

#[derive(Debug, Clone)]
struct ParsedTraceparent {
    trace_id: String,
    span_id: String,
    flags: String,
}

fn parse_traceparent(value: &str) -> Option<ParsedTraceparent> {
    let mut parts = value.split('-');
    let version = parts.next()?;
    let trace_id = parts.next()?;
    let span_id = parts.next()?;
    let flags = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    if version != "00" || !is_lower_hex(trace_id, 32) || !is_lower_hex(span_id, 16) {
        return None;
    }
    if !is_lower_hex(flags, 2)
        || trace_id.chars().all(|c| c == '0')
        || span_id.chars().all(|c| c == '0')
    {
        return None;
    }
    Some(ParsedTraceparent {
        trace_id: trace_id.to_owned(),
        span_id: span_id.to_owned(),
        flags: flags.to_owned(),
    })
}

impl TraceContext {
    fn child_traceparent(&self) -> String {
        format!("00-{}-{}-{}", self.trace_id, self.span_id, self.flags)
    }
}

fn random_hex(byte_len: usize) -> io::Result<String> {
    let mut bytes = vec![0_u8; byte_len];
    getrandom::fill(&mut bytes).map_err(|cause| io::Error::other(cause.to_string()))?;
    if bytes.iter().all(|byte| *byte == 0) {
        bytes[0] = 1;
    }
    Ok(hex(&bytes))
}

fn is_lower_hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn stable_hash_lines(values: &[String]) -> String {
    let mut hasher = Sha256::new();
    for value in values {
        hasher.update(value.len().to_string().as_bytes());
        hasher.update(b"\0");
        hasher.update(value.as_bytes());
        hasher.update(b"\0");
    }
    format!("sha256:{}", hex(&hasher.finalize()))
}

fn stable_hash(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{}", hex(&hasher.finalize()))
}

#[cfg(target_os = "linux")]
fn stable_process_span_id(pid: libc::pid_t, observed_wall: SystemTime) -> String {
    let mut hasher = Sha256::new();
    hasher.update(pid.to_string().as_bytes());
    hasher.update(b"\0");
    hasher.update(unix_nanos(observed_wall).to_string().as_bytes());
    let digest = hex(&hasher.finalize());
    let span_id = &digest[..16];
    if span_id.chars().all(|char| char == '0') {
        "0000000000000001".to_owned()
    } else {
        span_id.to_owned()
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut out, "{byte:02x}").expect("write to string");
    }
    out
}

fn exit_code(status: ExitStatus) -> i32 {
    if let Some(code) = status.code() {
        return code;
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return 128 + signal;
        }
    }

    1
}

/// Bounded, non-sensitive Error-status message for the command span (decision
/// 0016, M25.1). A signal kill and a clean non-zero exit are operationally very
/// different, so the message distinguishes them. Exit codes and signal names
/// carry no private data, and the signal-name set is finite (low cardinality).
fn status_error_message(status: ExitStatus) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return match signal_name(signal) {
                Some(name) => format!("process terminated by signal {name}"),
                None => format!("process terminated by signal {signal}"),
            };
        }
    }
    match status.code() {
        Some(code) => format!("process exited with code {code}"),
        None => String::from("process exited abnormally"),
    }
}

/// Well-known POSIX signal names for the Error-status message. Bounded set; any
/// signal outside it falls back to the raw number in `status_error_message`.
#[cfg(unix)]
fn signal_name(signal: i32) -> Option<&'static str> {
    let name = match signal {
        libc::SIGHUP => "SIGHUP",
        libc::SIGINT => "SIGINT",
        libc::SIGQUIT => "SIGQUIT",
        libc::SIGILL => "SIGILL",
        libc::SIGABRT => "SIGABRT",
        libc::SIGFPE => "SIGFPE",
        libc::SIGKILL => "SIGKILL",
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGPIPE => "SIGPIPE",
        libc::SIGALRM => "SIGALRM",
        libc::SIGTERM => "SIGTERM",
        libc::SIGBUS => "SIGBUS",
        _ => return None,
    };
    Some(name)
}

fn child_termination(status: ExitStatus) -> Option<ChildTermination> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        status.signal().map(|signal| ChildTermination::Signal {
            signal,
            synthetic_exit_code: 128 + signal,
        })
    }

    #[cfg(not(unix))]
    {
        let _ = status;
        None
    }
}

fn usage_error<T>(message: &str) -> Result<T, UsageError> {
    Err(UsageError {
        message: message.to_owned(),
    })
}

pub fn usage_exit_code() -> u8 {
    EX_USAGE
}

#[cfg(test)]
mod tests {
    use super::*;

    // Build-id correlation (H5, decision 0019): the pure precedence resolver is
    // exercised branch-by-branch so it is independent of the process environment
    // and of whether the crate was compiled with a baked NixStamp.
    #[test]
    fn machine_version_prefers_compile_time_nix_stamp() {
        // A compile-time NixStamp is the binary's own build and wins over any
        // runtime stamp.
        let compile = r#"{"type":"nix","version":"0.0.0","rev":"abc1234","commitTs":42,"dirty":false}"#;
        let runtime = r#"{"type":"local","rev":"ffff","ts":1,"dirty":true}"#;
        assert_eq!(
            resolve_machine_version(Some(compile), Some(runtime), "0.0.0"),
            "0.0.0+abc1234"
        );
    }

    #[test]
    fn machine_version_nix_stamp_marks_dirty_without_doubling() {
        let clean = r#"{"type":"nix","version":"0.0.0","rev":"abc1234","commitTs":1,"dirty":true}"#;
        assert_eq!(
            resolve_machine_version(Some(clean), None, "0.0.0"),
            "0.0.0+abc1234-dirty"
        );
        // The flake supplies dirtyShortRev already carrying `-dirty`; the suffix
        // must not be doubled.
        let already = r#"{"type":"nix","version":"0.0.0","rev":"abc1234-dirty","commitTs":1,"dirty":true}"#;
        assert_eq!(
            resolve_machine_version(Some(already), None, "0.0.0"),
            "0.0.0+abc1234-dirty"
        );
    }

    #[test]
    fn machine_version_uses_runtime_local_stamp_when_no_compile_stamp() {
        // In a devenv shell option_env! captures a LocalStamp — it describes the
        // shell, not the binary, so a compile-time LocalStamp is NOT honored and
        // resolution falls through to the runtime path.
        let local = r#"{"type":"local","rev":"deadbee","ts":1,"dirty":false}"#;
        assert_eq!(
            resolve_machine_version(Some(local), Some(local), "0.0.0"),
            "0.0.0+local.deadbee"
        );
        let dirty = r#"{"type":"local","rev":"deadbee","ts":1,"dirty":true}"#;
        assert_eq!(
            resolve_machine_version(None, Some(dirty), "0.0.0"),
            "0.0.0+local.deadbee.dirty"
        );
    }

    #[test]
    fn machine_version_falls_back_to_dev_marker_when_unstamped() {
        // Plain `cargo build` with no stamp anywhere: never bare `0.0.0` (which
        // discriminates no build), always the honest `+dev` marker.
        assert_eq!(resolve_machine_version(None, None, "0.0.0"), "0.0.0+dev");
        // A malformed stamp degrades to the same fallback rather than failing.
        assert_eq!(
            resolve_machine_version(Some("not json"), Some("{}"), "0.0.0"),
            "0.0.0+dev"
        );
    }

    #[test]
    fn parses_command_after_separator() {
        let args = vec![
            "--summary-out".to_owned(),
            "summary.json".to_owned(),
            "--".to_owned(),
            "echo".to_owned(),
            "hi".to_owned(),
        ];

        let request = parse_args(&args).unwrap();

        assert_eq!(
            request,
            CommandRequest::Run(Box::new(RunConfig {
                summary_out: Some(PathBuf::from("summary.json")),
                adapter: "none".to_owned(),
                cas_root: None,
                cas_pin: None,
                otlp_endpoint: otlp_env_config().endpoint,
                otlp_headers: otlp_env_config().headers,
                otlp_timeout: otlp_env_config().timeout,
                otlp_export_enabled: otlp_env_config().export_enabled,
                service_name: otlp_env_config().service_name,
                resource_attributes: otlp_env_config().resource_attributes,
                process_backend: ProcessBackendSelection::DirectChild,
                process_helper_socket: None,
                profile_artifacts: Vec::new(),
                trusted_otlp: false,
                trusted_summary: false,
                argv: vec!["echo".to_owned(), "hi".to_owned()],
            }))
        );
    }

    #[test]
    fn parses_profile_artifact_options() {
        let args = vec![
            "--cas-root".to_owned(),
            "cas".to_owned(),
            "--cas-pin".to_owned(),
            "runs/run-1".to_owned(),
            "--profile-artifact".to_owned(),
            "cpuprofile:profile.cpuprofile".to_owned(),
            "--".to_owned(),
            "true".to_owned(),
        ];

        let request = parse_args(&args).unwrap();

        assert_eq!(
            request,
            CommandRequest::Run(Box::new(RunConfig {
                summary_out: None,
                adapter: "none".to_owned(),
                cas_root: Some(PathBuf::from("cas")),
                cas_pin: Some("runs/run-1".to_owned()),
                otlp_endpoint: otlp_env_config().endpoint,
                otlp_headers: otlp_env_config().headers,
                otlp_timeout: otlp_env_config().timeout,
                otlp_export_enabled: otlp_env_config().export_enabled,
                service_name: otlp_env_config().service_name,
                resource_attributes: otlp_env_config().resource_attributes,
                process_backend: ProcessBackendSelection::DirectChild,
                process_helper_socket: None,
                profile_artifacts: vec![ProfileArtifactInput {
                    profile_type: "cpuprofile".to_owned(),
                    path: PathBuf::from("profile.cpuprofile"),
                }],
                trusted_otlp: false,
                trusted_summary: false,
                argv: vec!["true".to_owned()],
            }))
        );
    }

    #[test]
    fn parses_otlp_endpoint_and_service_name_options() {
        let args = vec![
            "--otlp-endpoint".to_owned(),
            "http://127.0.0.1:4318".to_owned(),
            "--service-name".to_owned(),
            "custom-service".to_owned(),
            "--".to_owned(),
            "true".to_owned(),
        ];

        let request = parse_args(&args).unwrap();

        let CommandRequest::Run(config) = request else {
            panic!("expected run request");
        };
        assert_eq!(
            config.otlp_endpoint,
            Some("http://127.0.0.1:4318".to_owned())
        );
        assert_eq!(config.service_name, "custom-service");
    }

    #[test]
    fn parses_process_backend_option() {
        let args = vec![
            "--process-backend".to_owned(),
            "ptrace-experimental".to_owned(),
            "--".to_owned(),
            "true".to_owned(),
        ];

        let CommandRequest::Run(config) = parse_args(&args).unwrap() else {
            panic!("expected run request");
        };

        assert_eq!(
            config.process_backend,
            ProcessBackendSelection::PtraceExperimental
        );
    }

    #[test]
    fn parses_helper_stream_backend_and_socket_option() {
        let args = vec![
            "--process-backend".to_owned(),
            "helper-stream".to_owned(),
            "--process-helper-socket".to_owned(),
            "/tmp/otel-scrape-helper.sock".to_owned(),
            "--".to_owned(),
            "true".to_owned(),
        ];

        let CommandRequest::Run(config) = parse_args(&args).unwrap() else {
            panic!("expected run request");
        };

        assert_eq!(
            config.process_backend,
            ProcessBackendSelection::HelperStream
        );
        assert_eq!(
            config.process_helper_socket,
            Some(PathBuf::from("/tmp/otel-scrape-helper.sock"))
        );
    }

    #[test]
    fn rejects_unknown_process_backend() {
        let args = vec![
            "--process-backend".to_owned(),
            "snapshot".to_owned(),
            "--".to_owned(),
            "true".to_owned(),
        ];

        let err = parse_args(&args).unwrap_err();

        assert_eq!(
            err.message(),
            "only --process-backend direct-child, ptrace-experimental, or helper-stream are supported"
        );
    }

    #[test]
    fn rejects_profile_artifact_without_cas_root() {
        let args = vec![
            "--profile-artifact".to_owned(),
            "cpuprofile:profile.cpuprofile".to_owned(),
            "--".to_owned(),
            "true".to_owned(),
        ];

        let err = parse_args(&args).unwrap_err();

        assert_eq!(
            err.message(),
            "--profile-artifact and --adapter node-cpuprofile require --cas-root or OTEL_SCRAPE_CAS_ROOT"
        );
    }

    #[test]
    fn rejects_node_cpuprofile_adapter_without_cas_root() {
        let args = vec![
            "--adapter".to_owned(),
            "node-cpuprofile".to_owned(),
            "--".to_owned(),
            "node".to_owned(),
            "-e".to_owned(),
            "console.log('hi')".to_owned(),
        ];

        let err = parse_args(&args).unwrap_err();

        assert_eq!(
            err.message(),
            "--profile-artifact and --adapter node-cpuprofile require --cas-root or OTEL_SCRAPE_CAS_ROOT"
        );
    }

    #[test]
    fn rejects_unsafe_cas_pin_names() {
        let args = vec![
            "--cas-root".to_owned(),
            "cas".to_owned(),
            "--cas-pin".to_owned(),
            "../escape".to_owned(),
            "--profile-artifact".to_owned(),
            "cpuprofile:profile.cpuprofile".to_owned(),
            "--".to_owned(),
            "true".to_owned(),
        ];

        let err = parse_args(&args).unwrap_err();

        assert_eq!(
            err.message(),
            "pin names must be non-empty relative paths without empty or parent segments"
        );
    }

    #[test]
    fn rejects_unknown_adapter() {
        // vitest is now an accepted adapter (decision 0017); cargo/tsc/vite remain
        // unsupported (cargo is an explicit fast-follow, tsc/vite have no
        // structured diagnostics source).
        for adapter in ["cargo", "tsc", "vite"] {
            let args = vec![
                "--adapter".to_owned(),
                adapter.to_owned(),
                "--".to_owned(),
                "true".to_owned(),
            ];

            let err = parse_args(&args).unwrap_err();

            assert_eq!(
                err.message(),
                "only --adapter none, --adapter oxlint, --adapter vitest, and --adapter node-cpuprofile are supported"
            );
        }
    }

    #[test]
    fn node_cpuprofile_options_prepare_documented_node_flags() {
        let dir = PathBuf::from("/tmp/otel-scrape-profile-test");

        assert_eq!(
            node_options_with_cpu_profile(None, &dir),
            "--cpu-prof --cpu-prof-dir=/tmp/otel-scrape-profile-test --cpu-prof-name=CPU.cpuprofile"
        );
        assert_eq!(
            node_options_with_cpu_profile(Some("--max-old-space-size=1024"), &dir),
            "--max-old-space-size=1024 --cpu-prof --cpu-prof-dir=/tmp/otel-scrape-profile-test --cpu-prof-name=CPU.cpuprofile"
        );
    }

    #[test]
    fn node_cpuprofile_discovery_degrades_for_empty_profile_dir() {
        let dir = tempfile::tempdir().unwrap();
        let config = node_cpuprofile_config(dir.path().join("cas"));
        let child = child_run_with_profile_dir(dir.path().join("profiles"));
        fs::create_dir_all(child.node_profile_dir.as_ref().unwrap()).unwrap();

        let discovered = discover_adapter_profile_artifacts(&config, &child);

        assert!(discovered.artifacts.is_empty());
        assert_eq!(discovered.errors.len(), 1);
        assert_eq!(
            discovered.errors[0].message,
            "node-cpuprofile adapter degraded: no .cpuprofile file produced"
        );
        assert!(discovered.errors[0]
            .path_hash
            .as_ref()
            .unwrap()
            .starts_with("sha256:"));
    }

    #[test]
    fn node_cpuprofile_discovery_records_multiple_profile_degradation() {
        let dir = tempfile::tempdir().unwrap();
        let profile_dir = dir.path().join("profiles");
        fs::create_dir_all(&profile_dir).unwrap();
        fs::write(profile_dir.join("a.cpuprofile"), valid_cpuprofile_bytes()).unwrap();
        fs::write(profile_dir.join("b.cpuprofile"), valid_cpuprofile_bytes()).unwrap();
        let config = node_cpuprofile_config(dir.path().join("cas"));
        let child = child_run_with_profile_dir(profile_dir);

        let discovered = discover_adapter_profile_artifacts(&config, &child);

        assert_eq!(discovered.artifacts.len(), 2);
        assert_eq!(discovered.errors.len(), 1);
        assert_eq!(
            discovered.errors[0].message,
            "node-cpuprofile adapter degraded: expected one .cpuprofile file, found 2"
        );
    }

    #[test]
    fn node_cpuprofile_discovery_rejects_malformed_profile_json() {
        let dir = tempfile::tempdir().unwrap();
        let profile_dir = dir.path().join("profiles");
        fs::create_dir_all(&profile_dir).unwrap();
        fs::write(profile_dir.join("bad.cpuprofile"), br#"{"nodes":[]}"#).unwrap();
        let config = node_cpuprofile_config(dir.path().join("cas"));
        let child = child_run_with_profile_dir(profile_dir.clone());

        let discovered = discover_adapter_profile_artifacts(&config, &child);

        assert!(discovered.artifacts.is_empty());
        assert_eq!(discovered.errors.len(), 1);
        assert!(discovered.errors[0]
            .message
            .starts_with("node-cpuprofile adapter degraded: malformed profile JSON:"));
        assert!(discovered.errors[0]
            .path_hash
            .as_ref()
            .unwrap()
            .starts_with("sha256:"));
        assert!(!discovered.errors[0]
            .message
            .contains(profile_dir.to_string_lossy().as_ref()));
    }

    #[test]
    fn bounded_program_name_keeps_normal_tool_basenames_verbatim() {
        // Ordinary program names — including version-suffixed interpreters and
        // short all-hex names — survive the derivation unchanged (decision 0016).
        for (argv0, expected) in [
            ("echo", "echo"),
            ("/usr/bin/node", "node"),
            ("/nix/store/whatever/bin/oxlint", "oxlint"),
            ("tsc", "tsc"),
            ("bash", "bash"),
            ("node20", "node20"),
            ("python3.11", "python3.11"),
            ("clang++", "clang++"),
            ("dd", "dd"),
            ("deadbeef", "deadbeef"),
        ] {
            assert_eq!(
                bounded_program_name(Some(argv0)),
                expected,
                "basename `{argv0}` should be kept verbatim"
            );
        }
    }

    #[test]
    fn bounded_program_name_collapses_pathological_basenames_to_fallback() {
        // uuid temp scripts, per-test compiled binaries, and long hex nonces
        // collapse into one bounded bucket instead of an unbounded span name.
        for argv0 in [
            "/tmp/build/550e8400-e29b-41d4-a716-446655440000",
            "0123456789abcdef0123456789abcdef", // 32-char hex nonce
            "/tmp/cargo-testXXXX/a1b2c3d4e5f60718293a4b5c6d7e8f90", // 40-char hex
            "weird name with spaces",
            "contains/slash-after-basename-is-fine-but-this-one-is-way-too-long-to-be-a-real-program-name-xxxxxxxx",
        ] {
            assert_eq!(
                bounded_program_name(Some(argv0)),
                BOUNDED_PROGRAM_FALLBACK,
                "basename `{argv0}` should collapse to the bounded fallback"
            );
        }
    }

    #[test]
    fn bounded_program_name_strips_nix_store_hash_prefix_so_real_name_survives() {
        // A direct-exec of /nix/store/<hash>-foo has basename "<hash>-foo"; the
        // 32-char nixbase32 hash prefix is stripped so `foo` survives rather than
        // collapsing (decision 0016).
        assert_eq!(
            bounded_program_name(Some(
                "/nix/store/ignored/1z9y8x7w6v5u4t3s2r1q0p9o8n7m6l5k-foo"
            )),
            "foo"
        );
        // The bare basename form (no directory) is handled identically.
        assert_eq!(
            bounded_program_name(Some("1z9y8x7w6v5u4t3s2r1q0p9o8n7m6l5k-hello-world")),
            "hello-world"
        );
    }

    #[test]
    fn bounded_program_name_falls_back_when_argv0_has_no_usable_basename() {
        assert_eq!(bounded_program_name(None), UNKNOWN_PROGRAM_BASENAME);
        assert_eq!(bounded_program_name(Some("")), UNKNOWN_PROGRAM_BASENAME);
    }

    fn node_cpuprofile_config(cas_root: PathBuf) -> RunConfig {
        RunConfig {
            summary_out: None,
            adapter: NODE_CPUPROFILE_ADAPTER.to_owned(),
            cas_root: Some(cas_root),
            cas_pin: None,
            otlp_endpoint: None,
            otlp_headers: Vec::new(),
            otlp_timeout: OTLP_HTTP_DEFAULT_TIMEOUT,
            otlp_export_enabled: true,
            service_name: "otel-scrape".to_owned(),
            resource_attributes: vec![
                ("telemetry.sdk.language".to_owned(), "rust".to_owned()),
                ("telemetry.sdk.name".to_owned(), "otel-scrape".to_owned()),
                ("telemetry.sdk.version".to_owned(), VERSION.to_owned()),
                ("service.name".to_owned(), "otel-scrape".to_owned()),
            ],
            process_backend: ProcessBackendSelection::DirectChild,
            process_helper_socket: None,
            profile_artifacts: Vec::new(),
            trusted_otlp: false,
            trusted_summary: false,
            argv: vec!["node".to_owned(), "-e".to_owned(), String::new()],
        }
    }

    fn child_run_with_profile_dir(profile_dir: PathBuf) -> ChildRun {
        let status = std::process::Command::new("true").status().unwrap();
        ChildRun {
            status,
            stdout: Some(Vec::new()),
            stderr: Some(Vec::new()),
            node_profile_dir: Some(profile_dir),
            child_pid: Some(std::process::id()),
            sidechannel_file: None,
            sidechannel_owned: false,
            process_observation: direct_child_process_observation(DirectChildProcessObservation {
                config: &node_cpuprofile_config(PathBuf::from("cas")),
                process_id: std::process::id(),
                parent_process_id: std::process::id(),
                process_span_id: "1111111111111111".to_owned(),
                process_started_wall: SystemTime::now(),
                process_duration_ms: 0,
                status,
            }),
        }
    }

    fn valid_cpuprofile_bytes() -> &'static [u8] {
        br#"{"nodes":[{"id":1,"callFrame":{"functionName":"(root)","scriptId":"0","url":"","lineNumber":-1,"columnNumber":-1},"hitCount":0,"children":[]}],"samples":[1],"timeDeltas":[1],"startTime":1,"endTime":2}"#
    }

    #[test]
    fn generated_registry_owns_summary_schema() {
        assert_eq!(
            telemetry_registry::schemas::SUMMARY_V1,
            "otel-scrape.summary/v1"
        );
        // The registry owns the naming *scheme*, not a fixed span-name string
        // (decision 0014): the command span is named by the program basename.
        assert_eq!(telemetry_registry::span_naming::COMMAND, "program-basename");
        assert_eq!(
            telemetry_registry::span_naming::PROCESS,
            "descendant-basename"
        );
        assert_eq!(
            telemetry_registry::metrics::OXLINT_DIAGNOSTICS,
            "oxlint.diagnostics"
        );
        // The active public contract speaks the OTel process.* semconv keys and
        // the otel_scrape.* vendor namespace (decision 0016).
        assert_eq!(
            telemetry_registry::attributes::OTEL_SCRAPE_COMMAND_ARGV_HASH,
            "otel_scrape.command.argv_hash"
        );
        assert_eq!(
            telemetry_registry::attributes::PROCESS_EXECUTABLE_NAME,
            "process.executable.name"
        );
        assert_eq!(
            telemetry_registry::attributes::PROCESS_EXIT_CODE,
            "process.exit.code"
        );
        // The pre-semconv keys are retained as a deprecated evolution trail
        // (decision 0016); their constants still resolve but are never emitted.
        assert_eq!(
            telemetry_registry::attributes::COMMAND_PROGRAM,
            "command.program"
        );
    }
}
