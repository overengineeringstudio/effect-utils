//! `otel-scrape` command-wrapper core.
//!
//! The library owns argument parsing, W3C trace context propagation, command
//! passthrough, and summary evidence. Adapter parsing and OTLP export will be
//! layered on this boundary once the generated telemetry registry exists.

use std::fmt::Write as _;
use std::fs;
use std::io::{self, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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
const EX_USAGE: u8 = 64;
const TRACE_FLAGS_SAMPLED: &str = "01";
const SUMMARY_ENV: &str = "OTEL_SCRAPE_SUMMARY_OUT";
const CAS_ROOT_ENV: &str = "OTEL_SCRAPE_CAS_ROOT";
const OTLP_ENDPOINT_ENV: &str = "OTEL_EXPORTER_OTLP_ENDPOINT";
const SERVICE_NAME_ENV: &str = "OTEL_SERVICE_NAME";
const PROCESS_BACKEND_ENV: &str = "OTEL_SCRAPE_PROCESS_BACKEND";
const TRACEPARENT_ENV: &str = "traceparent";
const OUTPUT_MEDIA_TYPE: &str = "application/octet-stream";
const RESOURCE_FACT_UNAVAILABLE: &str = "unavailable";
const OTLP_HTTP_TIMEOUT: Duration = Duration::from_millis(500);
const NODE_CPUPROFILE_ADAPTER: &str = "node-cpuprofile";
const DIRECT_CHILD_BACKEND: &str = "direct-child";
const PTRACE_EXPERIMENTAL_BACKEND: &str = "ptrace-experimental";
const PROCESS_FIDELITY_EXACT: &str = "exact";
const PROCESS_FIDELITY_DEGRADED: &str = "degraded";
const PROCESS_RELATION_DIRECT_CHILD: &str = "direct-child";
const PROCESS_RELATION_DESCENDANT: &str = "descendant";
const PROCESS_OBSERVATION_DEGRADED_REASONS: &[ProcessObservationDegradedReason] = &[
    ProcessObservationDegradedReason::DirectChildOnly,
    ProcessObservationDegradedReason::UnsupportedPlatform,
    ProcessObservationDegradedReason::MissingPrivilege,
    ProcessObservationDegradedReason::PtraceDenied,
    ProcessObservationDegradedReason::EndpointSecurityUnavailable,
    ProcessObservationDegradedReason::EventLoss,
    ProcessObservationDegradedReason::NamespaceUnsupported,
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunConfig {
    pub summary_out: Option<PathBuf>,
    pub adapter: String,
    pub cas_root: Option<PathBuf>,
    pub cas_pin: Option<String>,
    pub otlp_endpoint: Option<String>,
    pub service_name: String,
    pub process_backend: ProcessBackendSelection,
    pub profile_artifacts: Vec<ProfileArtifactInput>,
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
    Run(RunConfig),
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessBackendSelection {
    DirectChild,
    PtraceExperimental,
}

impl ProcessBackendSelection {
    fn parse(value: &str) -> Option<Self> {
        match value {
            DIRECT_CHILD_BACKEND => Some(Self::DirectChild),
            PTRACE_EXPERIMENTAL_BACKEND => Some(Self::PtraceExperimental),
            _ => None,
        }
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
    argv_hash: String,
    cwd_hash: String,
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
}

impl AdapterStdoutOwnership {
    fn as_summary_value(self) -> &'static str {
        match self {
            Self::ThisWrapper => "this-wrapper",
            Self::ChildWrapper => "child-wrapper",
        }
    }
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

#[derive(Debug, Clone, Serialize)]
struct AdapterEvent {
    message: String,
    severity: String,
    filename_hash: Option<String>,
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
}

impl ProcessObservationBackend {
    fn as_str(self) -> &'static str {
        match self {
            Self::DirectChild => DIRECT_CHILD_BACKEND,
            Self::PtraceExperimental => PTRACE_EXPERIMENTAL_BACKEND,
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
}

impl ProcessObservationDegradedReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::DirectChildOnly => "direct-child-only",
            Self::UnsupportedPlatform => "unsupported-platform",
            Self::MissingPrivilege => "missing-privilege",
            Self::PtraceDenied => "ptrace-denied",
            Self::EndpointSecurityUnavailable => "endpoint-security-unavailable",
            Self::EventLoss => "event-loss",
            Self::NamespaceUnsupported => "namespace-unsupported",
        }
    }
}

#[derive(Debug, Clone)]
struct ObservedProcess {
    relation: ObservedProcessRelation,
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
    let mut otlp_endpoint = std::env::var(OTLP_ENDPOINT_ENV).ok();
    let mut service_name =
        std::env::var(SERVICE_NAME_ENV).unwrap_or_else(|_| String::from("otel-scrape"));
    let mut process_backend = match std::env::var(PROCESS_BACKEND_ENV) {
        Ok(value) => ProcessBackendSelection::parse(&value).ok_or_else(|| UsageError {
            message: format!(
                "{PROCESS_BACKEND_ENV} must be {DIRECT_CHILD_BACKEND} or {PTRACE_EXPERIMENTAL_BACKEND}"
            ),
        })?,
        Err(_) => ProcessBackendSelection::DirectChild,
    };
    let mut profile_artifacts = Vec::new();
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
                if value != "none" && value != "oxlint" && value != NODE_CPUPROFILE_ADAPTER {
                    return usage_error(
                        "only --adapter none, --adapter oxlint, and --adapter node-cpuprofile are supported",
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
                i += 2;
            }
            "--process-backend" => {
                let Some(value) = args.get(i + 1) else {
                    return usage_error("--process-backend needs a value");
                };
                let Some(backend) = ProcessBackendSelection::parse(value) else {
                    return usage_error(
                        "only --process-backend direct-child and --process-backend ptrace-experimental are supported",
                    );
                };
                process_backend = backend;
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

    Ok(CommandRequest::Run(RunConfig {
        summary_out,
        adapter,
        cas_root,
        cas_pin,
        otlp_endpoint,
        service_name,
        process_backend,
        profile_artifacts,
        argv,
    }))
}

pub fn print_help() {
    eprintln!("otel-scrape {VERSION} — process wrapper for command telemetry");
    eprintln!();
    eprintln!("usage:");
    eprintln!(
        "  otel-scrape [--summary-out <file>] [--adapter none|oxlint|node-cpuprofile] [--process-backend direct-child|ptrace-experimental] [--otlp-endpoint <url>] [--service-name <name>] [--cas-root <dir>] [--cas-pin <name>] [--profile-artifact <type>:<path>] -- <cmd...>"
    );
    eprintln!("  otel-scrape --version | --help");
}

pub fn print_version() {
    println!("otel-scrape {VERSION}");
}

pub fn run(config: RunConfig) -> io::Result<i32> {
    let trace = trace_context_from_env()?;
    let child_traceparent = trace.child_traceparent();
    let started_wall = SystemTime::now();
    let started = Instant::now();

    let child = run_child(&config, &child_traceparent)?;
    let duration_ms = started.elapsed().as_millis();
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

    if let Some(path) = config.summary_out.as_ref() {
        match summary_for_status(
            &config,
            &trace,
            &child_traceparent,
            &child,
            duration_ms,
            &artifacts,
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

    if let Some(endpoint) = config.otlp_endpoint.as_ref() {
        let endpoint_for_warning = endpoint_for_warning(endpoint);
        if let Err(cause) = export_command_span(
            &config,
            &trace,
            &child,
            &artifacts,
            started_wall,
            duration_ms,
        ) {
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
}

fn run_child(config: &RunConfig, child_traceparent: &str) -> io::Result<ChildRun> {
    if config.process_backend == ProcessBackendSelection::PtraceExperimental {
        return run_child_with_ptrace(config, child_traceparent);
    }
    run_child_direct(config, child_traceparent)
}

fn run_child_direct(config: &RunConfig, child_traceparent: &str) -> io::Result<ChildRun> {
    let node_profile_dir = prepare_node_cpuprofile_dir(config)?;
    let process_span_id = random_hex(8)?;
    let mut command = Command::new(&config.argv[0]);
    command
        .args(&config.argv[1..])
        .env(TRACEPARENT_ENV, child_traceparent)
        .env("TRACEPARENT", child_traceparent)
        .stdin(Stdio::inherit());
    if let Some(profile_dir) = node_profile_dir.as_ref() {
        command.env(
            "NODE_OPTIONS",
            node_options_with_cpu_profile(
                std::env::var("NODE_OPTIONS").ok().as_deref(),
                profile_dir,
            ),
        );
    }

    if config.adapter == "none" {
        let process_started_wall = SystemTime::now();
        let process_started = Instant::now();
        let mut child = command
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()?;
        let process_id = child.id();
        let status = child.wait()?;
        let process_duration_ms = process_started.elapsed().as_millis();
        return Ok(ChildRun {
            status,
            stdout: None,
            stderr: None,
            node_profile_dir,
            process_observation: direct_child_process_observation(DirectChildProcessObservation {
                config,
                process_id,
                parent_process_id: std::process::id(),
                process_span_id,
                process_started_wall,
                process_duration_ms,
                status,
            }),
        });
    }

    let process_started_wall = SystemTime::now();
    let process_started = Instant::now();
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let process_id = child.id();
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    let stdout_reader = thread::spawn(move || tee_reader(stdout, io::stdout()));
    let stderr_reader = thread::spawn(move || tee_reader(stderr, io::stderr()));
    let status = child.wait()?;
    let process_duration_ms = process_started.elapsed().as_millis();
    let stdout = join_reader(stdout_reader)?;
    let stderr = join_reader(stderr_reader)?;

    Ok(ChildRun {
        status,
        stdout: Some(stdout),
        stderr: Some(stderr),
        node_profile_dir,
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

#[cfg(not(target_os = "linux"))]
fn run_child_with_ptrace(config: &RunConfig, child_traceparent: &str) -> io::Result<ChildRun> {
    let mut child = run_child_direct(config, child_traceparent)?;
    child.process_observation.backend = ProcessObservationBackend::DirectChild;
    child.process_observation.fidelity = ProcessObservationFidelity::Degraded;
    child.process_observation.degraded_reason =
        Some(ProcessObservationDegradedReason::UnsupportedPlatform);
    Ok(child)
}

#[cfg(target_os = "linux")]
fn run_child_with_ptrace(config: &RunConfig, child_traceparent: &str) -> io::Result<ChildRun> {
    use std::collections::{HashMap, HashSet};
    use std::os::unix::process::CommandExt;

    let node_profile_dir = prepare_node_cpuprofile_dir(config)?;
    let mut command = Command::new(&config.argv[0]);
    command
        .args(&config.argv[1..])
        .env(TRACEPARENT_ENV, child_traceparent)
        .env("TRACEPARENT", child_traceparent)
        .stdin(Stdio::inherit());
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

    let captures_output = config.adapter != "none";
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
        stdout_reader = Some(thread::spawn(move || tee_reader(stdout, io::stdout())));
        stderr_reader = Some(thread::spawn(move || tee_reader(stderr, io::stderr())));
    }

    let mut traces = HashMap::new();
    traces.insert(
        root_pid,
        PtraceProcessTrace {
            pid: root_pid,
            parent_pid: Some(std::process::id()),
            relation: ObservedProcessRelation::DirectChild,
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
        return Err(io::Error::new(
            io::ErrorKind::Other,
            "ptrace backend did not observe root process exit",
        ));
    };

    Ok(ChildRun {
        status,
        stdout,
        stderr,
        node_profile_dir,
        process_observation: ptrace_process_observation(traces),
    })
}

#[cfg(target_os = "linux")]
#[derive(Debug)]
struct PtraceProcessTrace {
    pid: libc::pid_t,
    parent_pid: Option<u32>,
    relation: ObservedProcessRelation,
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
) -> io::Result<Summary> {
    let cwd = std::env::current_dir()?;
    let adapter = adapter_outputs(
        config,
        child.stdout.as_deref().unwrap_or_default(),
        artifacts,
    );
    Ok(Summary {
        schema: telemetry_registry::schemas::SUMMARY_V1,
        version: VERSION,
        command: CommandSummary {
            argv_hash: stable_hash_lines(&config.argv),
            cwd_hash: stable_hash(cwd.to_string_lossy().as_bytes()),
        },
        output: output_summary(child),
        resources: resource_summary(duration_ms),
        adapter: adapter_summary(&adapter),
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
            otlp_export: false,
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
        stdout: child
            .stdout
            .as_deref()
            .map(|bytes| output_descriptor_for_bytes(bytes)),
        stderr: child
            .stderr
            .as_deref()
            .map(|bytes| output_descriptor_for_bytes(bytes)),
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
    artifacts: &ArtifactSummary,
    started_wall: SystemTime,
    duration_ms: u128,
) -> io::Result<()> {
    let Some(endpoint) = config.otlp_endpoint.as_ref() else {
        return Ok(());
    };
    let start_unix_nano = unix_nanos(started_wall);
    let end_unix_nano = start_unix_nano.saturating_add(duration_ms.saturating_mul(1_000_000));
    let adapter = adapter_outputs(
        config,
        child.stdout.as_deref().unwrap_or_default(),
        artifacts,
    );
    let mut command_span = json!({
        "traceId": trace.trace_id,
        "spanId": trace.span_id,
        "name": telemetry_registry::spans::COMMAND,
        "kind": 1,
        "startTimeUnixNano": start_unix_nano.to_string(),
        "endTimeUnixNano": end_unix_nano.to_string(),
        "attributes": [
            {
                "key": telemetry_registry::attributes::PROCESS_COMMAND_ARGS_HASH,
                "value": { "stringValue": stable_hash_lines(&config.argv) },
            },
            {
                "key": telemetry_registry::attributes::PROCESS_EXIT_CODE,
                "value": { "intValue": exit_code(child.status).to_string() },
            },
            {
                "key": telemetry_registry::attributes::ADAPTER_NAME,
                "value": { "stringValue": config.adapter },
            },
        ],
        "status": { "code": if child.status.success() { 1 } else { 2 } },
    });
    if let Some(parent_span_id) = trace.parent_span_id.as_ref() {
        command_span["parentSpanId"] = json!(parent_span_id);
    }
    let events = otlp_span_events(&adapter, end_unix_nano);
    if !events.is_empty() {
        command_span["events"] = json!(events);
    }
    let mut spans = vec![command_span];
    spans.extend(process_otlp_spans(trace, &child.process_observation));
    let body = json!({
        "resourceSpans": [{
            "resource": {
                "attributes": [
                    { "key": "service.name", "value": { "stringValue": config.service_name } },
                    { "key": "telemetry.sdk.language", "value": { "stringValue": "rust" } },
                ],
            },
            "scopeSpans": [{
                "scope": { "name": "otel-scrape" },
                "spans": spans,
            }],
        }],
    });
    let bytes = serde_json::to_vec(&body)?;
    post_otlp_http_json(endpoint, &bytes)
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
            json!({
                "traceId": trace.trace_id,
                "spanId": process.span_id,
                "parentSpanId": parent_span_id,
                "name": telemetry_registry::spans::PROCESS,
                "kind": 1,
                "startTimeUnixNano": process_start_unix_nano.to_string(),
                "endTimeUnixNano": process_end_unix_nano.to_string(),
                "attributes": [
                    {
                        "key": telemetry_registry::attributes::PROCESS_COMMAND_ARGS_HASH,
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
                    "key": "severity",
                    "value": { "stringValue": event.severity },
                })];
                if let Some(filename_hash) = event.filename_hash.as_ref() {
                    attrs.push(json!({
                        "key": "source.filename_hash",
                        "value": { "stringValue": filename_hash },
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

fn post_otlp_http_json(endpoint: &str, body: &[u8]) -> io::Result<()> {
    let endpoint = parse_http_endpoint(endpoint)?;
    let socket_addr = (endpoint.host.as_str(), endpoint.port)
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "endpoint did not resolve"))?;
    let mut stream = TcpStream::connect_timeout(&socket_addr, OTLP_HTTP_TIMEOUT)?;
    stream.set_read_timeout(Some(OTLP_HTTP_TIMEOUT))?;
    stream.set_write_timeout(Some(OTLP_HTTP_TIMEOUT))?;
    let request = format!(
        "POST {} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        endpoint.path,
        endpoint.host_header,
        body.len(),
    );
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
    let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
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
    let path = if path.is_empty() {
        String::from("/v1/traces")
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
}

fn adapter_outputs(config: &RunConfig, stdout: &[u8], artifacts: &ArtifactSummary) -> AdapterRun {
    let stdout_ownership = if config.adapter != "none" && invokes_nested_otel_scrape(config) {
        AdapterStdoutOwnership::ChildWrapper
    } else {
        AdapterStdoutOwnership::ThisWrapper
    };
    let mut outputs = match (stdout_ownership, config.adapter.as_str()) {
        (AdapterStdoutOwnership::ThisWrapper, "oxlint") => oxlint_outputs(stdout),
        _ => Vec::new(),
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
}

fn oxlint_outputs(stdout: &[u8]) -> Vec<AdapterOutput> {
    let Ok(report) = serde_json::from_slice::<OxlintJson>(stdout) else {
        return Vec::new();
    };

    let mut records = Vec::with_capacity(report.diagnostics.len() + 1);
    records.push(AdapterOutput::Metric(AdapterMetric {
        name: telemetry_registry::metrics::OXLINT_DIAGNOSTICS,
        value: report.diagnostics.len() as u64,
    }));

    for diagnostic in report.diagnostics {
        records.push(AdapterOutput::Event(AdapterEvent {
            message: diagnostic.message,
            severity: diagnostic.severity,
            filename_hash: diagnostic.filename.as_deref().map(hash_path_identity),
        }));
    }

    records
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

fn child_termination(status: ExitStatus) -> Option<ChildTermination> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        return status.signal().map(|signal| ChildTermination::Signal {
            signal,
            synthetic_exit_code: 128 + signal,
        });
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
            CommandRequest::Run(RunConfig {
                summary_out: Some(PathBuf::from("summary.json")),
                adapter: "none".to_owned(),
                cas_root: None,
                cas_pin: None,
                otlp_endpoint: std::env::var(OTLP_ENDPOINT_ENV).ok(),
                service_name: std::env::var(SERVICE_NAME_ENV)
                    .unwrap_or_else(|_| "otel-scrape".to_owned()),
                process_backend: ProcessBackendSelection::DirectChild,
                profile_artifacts: Vec::new(),
                argv: vec!["echo".to_owned(), "hi".to_owned()],
            })
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
            CommandRequest::Run(RunConfig {
                summary_out: None,
                adapter: "none".to_owned(),
                cas_root: Some(PathBuf::from("cas")),
                cas_pin: Some("runs/run-1".to_owned()),
                otlp_endpoint: std::env::var(OTLP_ENDPOINT_ENV).ok(),
                service_name: std::env::var(SERVICE_NAME_ENV)
                    .unwrap_or_else(|_| "otel-scrape".to_owned()),
                process_backend: ProcessBackendSelection::DirectChild,
                profile_artifacts: vec![ProfileArtifactInput {
                    profile_type: "cpuprofile".to_owned(),
                    path: PathBuf::from("profile.cpuprofile"),
                }],
                argv: vec!["true".to_owned()],
            })
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
            "only --process-backend direct-child and --process-backend ptrace-experimental are supported"
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
        for adapter in ["cargo", "tsc", "vite", "vitest"] {
            let args = vec![
                "--adapter".to_owned(),
                adapter.to_owned(),
                "--".to_owned(),
                "true".to_owned(),
            ];

            let err = parse_args(&args).unwrap_err();

            assert_eq!(
                err.message(),
                "only --adapter none, --adapter oxlint, and --adapter node-cpuprofile are supported"
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

    fn node_cpuprofile_config(cas_root: PathBuf) -> RunConfig {
        RunConfig {
            summary_out: None,
            adapter: NODE_CPUPROFILE_ADAPTER.to_owned(),
            cas_root: Some(cas_root),
            cas_pin: None,
            otlp_endpoint: None,
            service_name: "otel-scrape".to_owned(),
            process_backend: ProcessBackendSelection::DirectChild,
            profile_artifacts: Vec::new(),
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
        assert_eq!(telemetry_registry::spans::COMMAND, "otel_scrape.command");
        assert_eq!(
            telemetry_registry::metrics::OXLINT_DIAGNOSTICS,
            "oxlint.diagnostics"
        );
        assert_eq!(
            telemetry_registry::attributes::PROCESS_COMMAND_ARGS_HASH,
            "process.command_args_hash"
        );
    }
}
