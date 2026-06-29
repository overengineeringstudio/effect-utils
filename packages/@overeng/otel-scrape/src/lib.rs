//! `otel-scrape` command-wrapper core.
//!
//! The library owns argument parsing, W3C trace context propagation, command
//! passthrough, and summary evidence. Adapter parsing and OTLP export will be
//! layered on this boundary once the generated telemetry registry exists.

use std::fmt::Write as _;
use std::fs;
use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

#[path = "telemetry_registry.gen.rs"]
pub mod telemetry_registry;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const EX_USAGE: u8 = 64;
const TRACE_FLAGS_SAMPLED: &str = "01";
const SUMMARY_ENV: &str = "OTEL_SCRAPE_SUMMARY_OUT";
const CAS_ROOT_ENV: &str = "OTEL_SCRAPE_CAS_ROOT";
const OTLP_ENDPOINT_ENV: &str = "OTEL_EXPORTER_OTLP_ENDPOINT";
const SERVICE_NAME_ENV: &str = "OTEL_SERVICE_NAME";
const TRACEPARENT_ENV: &str = "traceparent";
const PROFILE_MEDIA_TYPE: &str = "application/octet-stream";
const OUTPUT_MEDIA_TYPE: &str = "application/octet-stream";
const MANIFEST_MEDIA_TYPE: &str = "application/json";
const CANONICAL_JSON_CODEC: &str = "canonical-json";
const RESOURCE_FACT_UNAVAILABLE: &str = "unavailable";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunConfig {
    pub summary_out: Option<PathBuf>,
    pub adapter: String,
    pub cas_root: Option<PathBuf>,
    pub cas_pin: Option<String>,
    pub otlp_endpoint: Option<String>,
    pub service_name: String,
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
    records: Vec<AdapterRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "_tag")]
enum AdapterRecord {
    Event(AdapterEvent),
    Metric(AdapterMetric),
}

#[derive(Debug, Clone, Serialize)]
struct AdapterEvent {
    message: String,
    severity: String,
    filename_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct AdapterMetric {
    name: &'static str,
    value: u64,
}

#[derive(Debug, Serialize)]
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
                if value != "none" && value != "oxlint" {
                    return usage_error("only --adapter none and --adapter oxlint are supported");
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
    if profile_artifacts.is_empty() {
        if cas_pin.is_some() {
            return usage_error("--cas-pin requires --profile-artifact");
        }
    } else if cas_root.is_none() {
        return usage_error("--profile-artifact requires --cas-root or OTEL_SCRAPE_CAS_ROOT");
    }

    Ok(CommandRequest::Run(RunConfig {
        summary_out,
        adapter,
        cas_root,
        cas_pin,
        otlp_endpoint,
        service_name,
        profile_artifacts,
        argv,
    }))
}

pub fn print_help() {
    eprintln!("otel-scrape {VERSION} — process wrapper for command telemetry");
    eprintln!();
    eprintln!("usage:");
    eprintln!(
        "  otel-scrape [--summary-out <file>] [--adapter none|oxlint] [--otlp-endpoint <url>] [--service-name <name>] [--cas-root <dir>] [--cas-pin <name>] [--profile-artifact <type>:<path>] -- <cmd...>"
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
    let artifacts = match artifact_summary(&config, &trace) {
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

    if let Some(path) = config.summary_out.as_ref() {
        match summary_for_status(
            &config,
            &trace,
            &child_traceparent,
            &child,
            duration_ms,
            artifacts,
        )
        .and_then(|summary| write_summary(path, &summary))
        {
            Ok(()) => {}
            Err(cause) => {
                eprintln!(
                    "otel-scrape: warning: failed to write summary {}: {cause}",
                    path.display()
                );
            }
        }
    }

    if let Some(endpoint) = config.otlp_endpoint.as_ref() {
        if let Err(cause) = export_command_span(&config, &trace, &child, started_wall, duration_ms)
        {
            eprintln!("otel-scrape: warning: failed to export OTLP trace to {endpoint}: {cause}");
        }
    }

    Ok(exit_code(child.status))
}

struct ChildRun {
    status: ExitStatus,
    stdout: Option<Vec<u8>>,
    stderr: Option<Vec<u8>>,
}

fn run_child(config: &RunConfig, child_traceparent: &str) -> io::Result<ChildRun> {
    let mut command = Command::new(&config.argv[0]);
    command
        .args(&config.argv[1..])
        .env(TRACEPARENT_ENV, child_traceparent)
        .env("TRACEPARENT", child_traceparent)
        .stdin(Stdio::inherit());

    if config.adapter == "none" {
        let status = command
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status()?;
        return Ok(ChildRun {
            status,
            stdout: None,
            stderr: None,
        });
    }

    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    let stdout_reader = thread::spawn(move || tee_reader(stdout, io::stdout()));
    let stderr_reader = thread::spawn(move || tee_reader(stderr, io::stderr()));
    let status = child.wait()?;
    let stdout = join_reader(stdout_reader)?;
    let stderr = join_reader(stderr_reader)?;

    Ok(ChildRun {
        status,
        stdout: Some(stdout),
        stderr: Some(stderr),
    })
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
    artifacts: ArtifactSummary,
) -> io::Result<Summary> {
    let cwd = std::env::current_dir()?;
    let adapter = adapter_summary(config, child.stdout.as_deref().unwrap_or_default());
    Ok(Summary {
        schema: telemetry_registry::schemas::SUMMARY_V1,
        version: VERSION,
        command: CommandSummary {
            argv_hash: stable_hash_lines(&config.argv),
            cwd_hash: stable_hash(cwd.to_string_lossy().as_bytes()),
        },
        output: output_summary(child),
        resources: resource_summary(duration_ms),
        adapter,
        artifacts,
        trace: TraceSummary {
            trace_id: trace.trace_id.clone(),
            parent_span_id: trace.parent_span_id.clone(),
            span_id: trace.span_id.clone(),
            child_traceparent: child_traceparent.to_owned(),
        },
        child: ChildSummary {
            exit_code: child.status.code(),
            success: child.status.success(),
        },
        duration_ms,
        degraded: DegradedSummary {
            direct_child_only: true,
            otlp_export: false,
        },
    })
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
    started_wall: SystemTime,
    duration_ms: u128,
) -> io::Result<()> {
    let Some(endpoint) = config.otlp_endpoint.as_ref() else {
        return Ok(());
    };
    let start_unix_nano = unix_nanos(started_wall);
    let end_unix_nano = start_unix_nano.saturating_add(duration_ms.saturating_mul(1_000_000));
    let mut span = json!({
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
        span["parentSpanId"] = json!(parent_span_id);
    }
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
                "spans": [span],
            }],
        }],
    });
    let bytes = serde_json::to_vec(&body)?;
    post_otlp_http_json(endpoint, &bytes)
}

fn unix_nanos(time: SystemTime) -> u128 {
    time.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}

fn post_otlp_http_json(endpoint: &str, body: &[u8]) -> io::Result<()> {
    let endpoint = parse_http_endpoint(endpoint)?;
    let mut stream = TcpStream::connect((endpoint.host.as_str(), endpoint.port))?;
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
    let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
    if authority.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "missing endpoint host",
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

fn adapter_summary(config: &RunConfig, stdout: &[u8]) -> AdapterSummary {
    let records = match config.adapter.as_str() {
        "oxlint" => oxlint_records(stdout),
        _ => Vec::new(),
    };

    AdapterSummary {
        name: config.adapter.clone(),
        records,
    }
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

fn artifact_summary(config: &RunConfig, trace: &TraceContext) -> io::Result<ArtifactSummary> {
    if config.profile_artifacts.is_empty() {
        return Ok(ArtifactSummary {
            profiles: Vec::new(),
            manifest: None,
            errors: Vec::new(),
        });
    }

    let root = config
        .cas_root
        .as_ref()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing CAS root"))?;
    let mut profiles = Vec::with_capacity(config.profile_artifacts.len());
    let mut manifest_entries = Vec::with_capacity(config.profile_artifacts.len());
    let mut errors = Vec::new();
    for artifact in &config.profile_artifacts {
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
        if let Err(cause) = write_object(root, &descriptor.digest, &bytes) {
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
    if let Err(cause) = write_object(root, &manifest_descriptor.digest, manifest_json.as_bytes()) {
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

fn oxlint_records(stdout: &[u8]) -> Vec<AdapterRecord> {
    let Ok(report) = serde_json::from_slice::<OxlintJson>(stdout) else {
        return Vec::new();
    };

    let mut records = Vec::with_capacity(report.diagnostics.len() + 1);
    records.push(AdapterRecord::Metric(AdapterMetric {
        name: telemetry_registry::metrics::OXLINT_DIAGNOSTICS,
        value: report.diagnostics.len() as u64,
    }));

    for diagnostic in report.diagnostics {
        records.push(AdapterRecord::Event(AdapterEvent {
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

#[derive(Debug, Clone)]
struct ContentDescriptor {
    digest: String,
    byte_length: usize,
    media_type: &'static str,
    codec: Option<&'static str>,
    schema_version: Option<u64>,
}

#[derive(Debug)]
struct ManifestEntry {
    descriptor: ContentDescriptor,
    logical_path: String,
    role: String,
}

fn descriptor_for_bytes(
    bytes: &[u8],
    media_type: &'static str,
    codec: Option<&'static str>,
    schema_version: Option<u64>,
) -> ContentDescriptor {
    ContentDescriptor {
        digest: stable_hash(bytes),
        byte_length: bytes.len(),
        media_type,
        codec,
        schema_version,
    }
}

fn cas_uri_for_digest(digest: &str) -> String {
    format!("cas:{}", object_path_for_digest(digest))
}

fn object_path_for_digest(digest: &str) -> String {
    let hex = digest
        .strip_prefix("sha256:")
        .expect("stable_hash returns sha256 digest");
    format!("sha256/{}/{}", &hex[..2], &hex[2..])
}

fn write_object(root: &Path, digest: &str, bytes: &[u8]) -> io::Result<()> {
    write_bytes_atomic(&root.join(object_path_for_digest(digest)), bytes)
}

fn write_pin(root: &Path, name: &str, manifest: &ContentDescriptor) -> io::Result<()> {
    let pin_path = pin_path(root, name)?;
    let pin_json = format!(
        "{{\"_tag\":\"ContentPin\",\"schemaVersion\":1,\"target\":{}}}\n",
        descriptor_json(manifest)
    );
    write_bytes_atomic(&pin_path, pin_json.as_bytes())
}

fn pin_path(root: &Path, name: &str) -> io::Result<PathBuf> {
    validate_pin_name(name)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidInput, err.message))?;
    Ok(root.join("pins").join(name.replace('\\', "/")))
}

fn validate_pin_name(name: &str) -> Result<(), UsageError> {
    if name.trim().is_empty()
        || name.contains('\0')
        || Path::new(name).is_absolute()
        || name
            .split(['/', '\\'])
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return usage_error(
            "pin names must be non-empty relative paths without empty or parent segments",
        );
    }
    Ok(())
}

fn canonical_manifest_json(entries: &[ManifestEntry]) -> String {
    let entries = entries
        .iter()
        .map(manifest_entry_json)
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "{{\"_tag\":\"ContentManifest\",\"entries\":[{entries}],\"role\":\"otel-scrape-run\",\"schemaVersion\":1}}"
    )
}

fn manifest_entry_json(entry: &ManifestEntry) -> String {
    format!(
        "{{\"descriptor\":{},\"logicalPath\":{},\"role\":{}}}",
        descriptor_json(&entry.descriptor),
        json_string(&entry.logical_path),
        json_string(&entry.role)
    )
}

fn descriptor_json(descriptor: &ContentDescriptor) -> String {
    let mut out = format!(
        "{{\"_tag\":\"ContentDescriptor\",\"byteLength\":{},",
        descriptor.byte_length
    );
    if let Some(codec) = descriptor.codec {
        write!(&mut out, "\"codec\":{},", json_string(codec)).expect("write to string");
    }
    write!(
        &mut out,
        "\"digest\":{},\"mediaType\":{}",
        json_string(&descriptor.digest),
        json_string(descriptor.media_type)
    )
    .expect("write to string");
    if let Some(schema_version) = descriptor.schema_version {
        write!(&mut out, ",\"schemaVersion\":{schema_version}").expect("write to string");
    }
    out.push('}');
    out
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).expect("string serialization cannot fail")
}

fn write_summary(path: &Path, summary: &Summary) -> io::Result<()> {
    let mut bytes = serde_json::to_vec(summary)?;
    bytes.push(b'\n');
    write_bytes_atomic(path, &bytes)
}

fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    let temp = temp_path_for(path)?;
    if let Err(cause) = fs::write(&temp, bytes).and_then(|()| fs::rename(&temp, path)) {
        let _ = fs::remove_file(&temp);
        return Err(cause);
    }
    Ok(())
}

fn temp_path_for(path: &Path) -> io::Result<PathBuf> {
    let suffix = random_hex(8)?;
    Ok(path.with_extension(format!(
        "{}tmp-{}-{suffix}",
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| format!("{ext}."))
            .unwrap_or_default(),
        std::process::id()
    )))
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
            "--profile-artifact requires --cas-root or OTEL_SCRAPE_CAS_ROOT"
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
        let args = vec![
            "--adapter".to_owned(),
            "cargo".to_owned(),
            "--".to_owned(),
            "true".to_owned(),
        ];

        let err = parse_args(&args).unwrap_err();

        assert_eq!(
            err.message(),
            "only --adapter none and --adapter oxlint are supported"
        );
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
