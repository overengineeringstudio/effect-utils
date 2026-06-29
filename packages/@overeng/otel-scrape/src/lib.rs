//! `otel-scrape` command-wrapper core.
//!
//! The library owns argument parsing, W3C trace context propagation, command
//! passthrough, and summary evidence. Adapter parsing and OTLP export will be
//! layered on this boundary once the generated telemetry registry exists.

use std::fmt::Write as _;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[path = "telemetry_registry.gen.rs"]
pub mod telemetry_registry;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const EX_USAGE: u8 = 64;
const TRACE_FLAGS_SAMPLED: &str = "01";
const SUMMARY_ENV: &str = "OTEL_SCRAPE_SUMMARY_OUT";
const TRACEPARENT_ENV: &str = "traceparent";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunConfig {
    pub summary_out: Option<PathBuf>,
    pub adapter: String,
    pub argv: Vec<String>,
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
    adapter: AdapterSummary,
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
struct AdapterSummary {
    name: String,
    records: Vec<AdapterRecord>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "_tag")]
enum AdapterRecord {
    Event(AdapterEvent),
    Metric(AdapterMetric),
}

#[derive(Debug, Serialize)]
struct AdapterEvent {
    message: String,
    severity: String,
    filename_hash: Option<String>,
}

#[derive(Debug, Serialize)]
struct AdapterMetric {
    name: &'static str,
    value: u64,
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

    Ok(CommandRequest::Run(RunConfig {
        summary_out,
        adapter,
        argv,
    }))
}

pub fn print_help() {
    eprintln!("otel-scrape {VERSION} — process wrapper for command telemetry");
    eprintln!();
    eprintln!("usage:");
    eprintln!("  otel-scrape [--summary-out <file>] [--adapter none|oxlint] -- <cmd...>");
    eprintln!("  otel-scrape --version | --help");
}

pub fn print_version() {
    println!("otel-scrape {VERSION}");
}

pub fn run(config: RunConfig) -> io::Result<i32> {
    let trace = trace_context_from_env()?;
    let child_traceparent = trace.child_traceparent();
    let started = Instant::now();

    let child = run_child(&config, &child_traceparent)?;

    let duration_ms = started.elapsed().as_millis();
    if let Some(path) = config.summary_out.as_ref() {
        match summary_for_status(&config, &trace, &child_traceparent, &child, duration_ms)
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

    Ok(exit_code(child.status))
}

struct ChildRun {
    status: ExitStatus,
    stdout: Vec<u8>,
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
            stdout: Vec::new(),
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
    let _stderr = join_reader(stderr_reader)?;

    Ok(ChildRun { status, stdout })
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
) -> io::Result<Summary> {
    let cwd = std::env::current_dir()?;
    let adapter = adapter_summary(config, &child.stdout);
    Ok(Summary {
        schema: telemetry_registry::schemas::SUMMARY_V1,
        version: VERSION,
        command: CommandSummary {
            argv_hash: stable_hash_lines(&config.argv),
            cwd_hash: stable_hash(cwd.to_string_lossy().as_bytes()),
        },
        adapter,
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

fn write_summary(path: &PathBuf, summary: &Summary) -> io::Result<()> {
    let mut bytes = serde_json::to_vec(summary)?;
    bytes.push(b'\n');
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    let temp = path.with_extension(format!(
        "{}tmp",
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| format!("{ext}."))
            .unwrap_or_default()
    ));
    fs::write(&temp, bytes)?;
    fs::rename(temp, path)?;
    Ok(())
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
                argv: vec!["echo".to_owned(), "hi".to_owned()],
            })
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
