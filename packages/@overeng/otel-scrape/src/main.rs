//! `otel-scrape` CLI entrypoint.
//!
//! Child stdout/stderr are inherited verbatim. Wrapper diagnostics go to stderr;
//! local summary evidence is file-only so replacing `<cmd>` with
//! `otel-scrape -- <cmd>` does not corrupt stdout protocols.

use std::process::ExitCode;

use otel_scrape::{parse_args, print_help, print_version, run, usage_exit_code, CommandRequest};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match parse_args(&args) {
        Ok(CommandRequest::Help) => {
            print_help();
            ExitCode::SUCCESS
        }
        Ok(CommandRequest::Version) => {
            print_version();
            ExitCode::SUCCESS
        }
        Ok(CommandRequest::Run(config)) => match run(*config) {
            Ok(code) => ExitCode::from(code.clamp(0, 255) as u8),
            Err(cause) => {
                eprintln!("otel-scrape: {cause}");
                ExitCode::from(1)
            }
        },
        Err(cause) => {
            eprintln!("otel-scrape: {}", cause.message());
            eprintln!("try: otel-scrape --help");
            ExitCode::from(usage_exit_code())
        }
    }
}
