//! otelite CLI — `run` / `inspect` / `capture` over the capture engine.
//!
//! stdout is machine-readable JSON only; all human text goes to stderr. Own
//! failures use sysexits.h codes (`run` otherwise preserves the child's code).

use std::path::PathBuf;
use std::process::ExitCode;

use otelite::run::{run, RunOpts};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const EX_USAGE: u8 = 64;
/// sysexits EX_UNAVAILABLE — a real verb that isn't wired yet (distinct from a
/// usage error, so a harness can tell "not implemented" from "you used me wrong").
const EX_UNAVAILABLE: u8 = 69;

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
        Some("inspect") => {
            eprintln!("otelite: `inspect` is not yet implemented (epic #772, M4)");
            ExitCode::from(EX_UNAVAILABLE)
        }
        Some("capture") => {
            eprintln!("otelite: `capture` is not yet implemented (epic #772, M7)");
            ExitCode::from(EX_UNAVAILABLE)
        }
        Some("--print-schema") => {
            eprintln!("otelite: `--print-schema` is not yet implemented (epic #772, M4)");
            ExitCode::from(EX_UNAVAILABLE)
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
