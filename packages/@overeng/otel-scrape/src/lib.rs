//! `otel-scrape` command-wrapper core.
//!
//! The library owns argument parsing, W3C trace context propagation, command
//! passthrough, and summary evidence. Adapter parsing and OTLP export will be
//! layered on this boundary once the generated telemetry registry exists.

use std::fmt::Write as _;
use std::fs;
use std::io;
use std::path::PathBuf;
use std::process::{Command, ExitStatus, Stdio};
use std::time::Instant;

use serde::Serialize;
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
    trace: TraceSummary,
    child: ChildSummary,
    duration_ms: u128,
    degraded: DegradedSummary,
}

#[derive(Debug, Serialize)]
struct CommandSummary {
    argv_hash: String,
    cwd_hash: String,
    adapter: String,
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
                if value != "none" {
                    return usage_error("only --adapter none is supported in this slice");
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
    eprintln!("  otel-scrape [--summary-out <file>] [--adapter none] -- <cmd...>");
    eprintln!("  otel-scrape --version | --help");
}

pub fn print_version() {
    println!("otel-scrape {VERSION}");
}

pub fn run(config: RunConfig) -> io::Result<i32> {
    let trace = trace_context_from_env()?;
    let child_traceparent = trace.child_traceparent();
    let started = Instant::now();

    let status = Command::new(&config.argv[0])
        .args(&config.argv[1..])
        .env(TRACEPARENT_ENV, &child_traceparent)
        .env("TRACEPARENT", &child_traceparent)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()?;

    let duration_ms = started.elapsed().as_millis();
    if let Some(path) = config.summary_out.as_ref() {
        match summary_for_status(&config, &trace, &child_traceparent, &status, duration_ms)
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

    Ok(exit_code(status))
}

fn summary_for_status(
    config: &RunConfig,
    trace: &TraceContext,
    child_traceparent: &str,
    status: &ExitStatus,
    duration_ms: u128,
) -> io::Result<Summary> {
    let cwd = std::env::current_dir()?;
    Ok(Summary {
        schema: telemetry_registry::schemas::SUMMARY_V1,
        version: VERSION,
        command: CommandSummary {
            argv_hash: stable_hash_lines(&config.argv),
            cwd_hash: stable_hash(cwd.to_string_lossy().as_bytes()),
            adapter: config.adapter.clone(),
        },
        trace: TraceSummary {
            trace_id: trace.trace_id.clone(),
            parent_span_id: trace.parent_span_id.clone(),
            span_id: trace.span_id.clone(),
            child_traceparent: child_traceparent.to_owned(),
        },
        child: ChildSummary {
            exit_code: status.code(),
            success: status.success(),
        },
        duration_ms,
        degraded: DegradedSummary {
            direct_child_only: true,
            otlp_export: false,
        },
    })
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
            "oxlint".to_owned(),
            "--".to_owned(),
            "true".to_owned(),
        ];

        let err = parse_args(&args).unwrap_err();

        assert_eq!(
            err.message(),
            "only --adapter none is supported in this slice"
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
            telemetry_registry::attributes::PROCESS_COMMAND_ARGS_HASH,
            "process.command_args_hash"
        );
    }
}
