//! otelite — a local OTLP capture tool for E2E and instrumentation tests.
//!
//! M1a skeleton: only `--version` / `--help` are wired so the Nix build lane can
//! be proven before any capture logic lands. The `run` / `inspect` / `capture`
//! verbs arrive in later milestones (see the epic in PR #772).

use std::process::ExitCode;

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() -> ExitCode {
    let arg = std::env::args().nth(1);
    match arg.as_deref() {
        Some("--version") | Some("-V") => {
            println!("otelite {VERSION}");
            ExitCode::SUCCESS
        }
        Some("--help") | Some("-h") | None => {
            // Human-facing text goes to stderr; stdout is reserved for machine output.
            eprintln!("otelite {VERSION} — local OTLP capture tool for tests");
            eprintln!();
            eprintln!("usage: otelite <run|inspect|capture> ...   (not yet implemented)");
            ExitCode::SUCCESS
        }
        Some(other) => {
            eprintln!("otelite: unknown argument: {other}");
            // sysexits.h EX_USAGE — the CLI's own failures use sysexits codes.
            ExitCode::from(64)
        }
    }
}
