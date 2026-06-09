//! otelite CLI — `run` / `inspect` / `capture` over the capture engine.
//!
//! stdout is machine-readable JSON only; all human text goes to stderr. Own
//! failures use sysexits.h codes (`run` otherwise preserves the child's code).

use std::path::PathBuf;
use std::process::ExitCode;

use otelite::inspect_cmd::{inspect, parse_attr, InspectOpts};
use otelite::run::{capture, run, CaptureOpts, RunOpts};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const EX_USAGE: u8 = 64;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("--version") | Some("-V") => {
            println!("otelite {VERSION}");
            ExitCode::SUCCESS
        }
        Some("--help") | Some("-h") | None => {
            print_help();
            ExitCode::SUCCESS
        }
        Some("run") => dispatch_run(&args[2..]),
        Some("inspect") => dispatch_inspect(&args[2..]),
        Some("capture") => dispatch_capture(&args[2..]),
        Some("--print-schema") => {
            // The stable output schema tags (locked by the conformance goldens).
            println!(
                r#"{{"schemas":["otelite.summary/v1","otelite.span/v1","otelite.trace-summary/v1","otelite.metric/v1","otelite.metric-summary/v1","otelite.log/v1","otelite.log-summary/v1"]}}"#
            );
            ExitCode::SUCCESS
        }
        Some(other) => {
            eprintln!("otelite: unknown argument: {other}");
            ExitCode::from(EX_USAGE)
        }
    }
}

fn print_help() {
    eprintln!("otelite {VERSION} — local OTLP capture tool for tests");
    eprintln!();
    eprintln!("usage:");
    eprintln!("  otelite run [--out <dir>] [--service N] [--http-port N] [--grpc-port N] \\");
    eprintln!("              [--drain-idle MS] [--pretty] -- <cmd...>");
    eprintln!("  otelite inspect <dir|file|-> ...        (M4)");
    eprintln!("  otelite capture [--out <dir>] ...       (M7)");
    eprintln!("  otelite --version | --help");
}

/// Parse `run` flags up to `--`, then everything after is the child command.
fn dispatch_run(args: &[String]) -> ExitCode {
    let mut out: Option<PathBuf> = None;
    let mut service: Option<String> = None;
    let mut http_port: Option<u16> = None;
    let mut grpc_port: Option<u16> = None;
    let mut drain_idle_ms: Option<u64> = None;
    let mut pretty = false;
    let mut argv: Vec<String> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--out" => {
                let Some(v) = args.get(i + 1) else {
                    return usage("--out needs a value");
                };
                out = Some(PathBuf::from(v));
                i += 2;
            }
            "--service" => {
                let Some(v) = args.get(i + 1) else {
                    return usage("--service needs a value");
                };
                service = Some(v.clone());
                i += 2;
            }
            "--http-port" => match args.get(i + 1).and_then(|v| v.parse().ok()) {
                Some(p) => {
                    http_port = Some(p);
                    i += 2;
                }
                None => return usage("--http-port needs a port number"),
            },
            "--grpc-port" => match args.get(i + 1).and_then(|v| v.parse().ok()) {
                Some(p) => {
                    grpc_port = Some(p);
                    i += 2;
                }
                None => return usage("--grpc-port needs a port number"),
            },
            "--drain-idle" => match args.get(i + 1).and_then(|v| v.parse().ok()) {
                Some(ms) => {
                    drain_idle_ms = Some(ms);
                    i += 2;
                }
                None => return usage("--drain-idle needs a millisecond value"),
            },
            "--pretty" => {
                pretty = true;
                i += 1;
            }
            "--" => {
                argv = args[i + 1..].to_vec();
                break;
            }
            other => return usage(&format!("unknown run flag: {other}")),
        }
    }

    if argv.is_empty() {
        return usage("run needs a child command after `--`");
    }

    let opts = RunOpts {
        out,
        service,
        http_port,
        grpc_port,
        drain_idle_ms,
        pretty,
        argv,
    };
    let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
    ExitCode::from(rt.block_on(run(opts)))
}

fn usage(msg: &str) -> ExitCode {
    eprintln!("otelite: {msg}");
    eprintln!("try: otelite run [opts] -- <cmd...>");
    ExitCode::from(EX_USAGE)
}

/// Parse `capture [--out <dir>] [--http-port N] [--grpc-port N] [--pretty]`.
fn dispatch_capture(args: &[String]) -> ExitCode {
    let mut out: Option<PathBuf> = None;
    let mut http_port: Option<u16> = None;
    let mut grpc_port: Option<u16> = None;
    let mut pretty = false;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--out" => {
                let Some(v) = args.get(i + 1) else {
                    return usage("--out needs a value");
                };
                out = Some(PathBuf::from(v));
                i += 2;
            }
            "--http-port" => match args.get(i + 1).and_then(|v| v.parse().ok()) {
                Some(p) => {
                    http_port = Some(p);
                    i += 2;
                }
                None => return usage("--http-port needs a port number"),
            },
            "--grpc-port" => match args.get(i + 1).and_then(|v| v.parse().ok()) {
                Some(p) => {
                    grpc_port = Some(p);
                    i += 2;
                }
                None => return usage("--grpc-port needs a port number"),
            },
            "--pretty" => {
                pretty = true;
                i += 1;
            }
            other => return usage(&format!("unknown capture flag: {other}")),
        }
    }

    let opts = CaptureOpts {
        out,
        http_port,
        grpc_port,
        pretty,
    };
    let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
    ExitCode::from(rt.block_on(capture(opts)))
}

/// Parse `inspect <src> [filters]`. `<src>` is a dir, a file, or `-` (stdin).
fn dispatch_inspect(args: &[String]) -> ExitCode {
    let mut src: Option<String> = None;
    let mut signal = String::from("traces");
    let mut service: Option<String> = None;
    let mut name: Option<String> = None;
    let mut attrs: Vec<(String, String)> = Vec::new();
    let mut summary = false;
    let mut top = 20usize;
    let mut pretty = false;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--signal" => match args.get(i + 1) {
                Some(v) => {
                    signal = v.clone();
                    i += 2;
                }
                None => return usage("--signal needs a value"),
            },
            "--service" => match args.get(i + 1) {
                Some(v) => {
                    service = Some(v.clone());
                    i += 2;
                }
                None => return usage("--service needs a value"),
            },
            "--name" => match args.get(i + 1) {
                Some(v) => {
                    name = Some(v.clone());
                    i += 2;
                }
                None => return usage("--name needs a value"),
            },
            "--attr" => match args.get(i + 1) {
                Some(v) => match parse_attr(v) {
                    Ok(kv) => {
                        attrs.push(kv);
                        i += 2;
                    }
                    Err(code) => return ExitCode::from(code),
                },
                None => return usage("--attr needs key=value"),
            },
            "--top" => match args.get(i + 1).and_then(|v| v.parse().ok()) {
                Some(t) => {
                    top = t;
                    i += 2;
                }
                None => return usage("--top needs a number"),
            },
            "--summary" => {
                summary = true;
                i += 1;
            }
            "--pretty" => {
                pretty = true;
                i += 1;
            }
            other if !other.starts_with("--") && src.is_none() => {
                src = Some(other.to_string());
                i += 1;
            }
            other => return usage(&format!("unknown inspect arg: {other}")),
        }
    }

    let Some(src) = src else {
        return usage("inspect needs a source (a dir, a file, or `-`)");
    };
    let opts = InspectOpts {
        src,
        signal,
        service,
        name,
        attrs,
        summary,
        top,
        pretty,
    };
    ExitCode::from(inspect(opts))
}
