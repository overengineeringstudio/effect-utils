//! `otel-scrape` CLI entrypoint.
//!
//! Child stdout/stderr are inherited verbatim. Wrapper diagnostics go to stderr;
//! local summary evidence is file-only so replacing `<cmd>` with
//! `otel-scrape -- <cmd>` does not corrupt stdout protocols.

use std::process::ExitCode;

use cli_build_identity::build_identity_from_env;
use otel_scrape::{parse_args, print_help, run, usage_exit_code, CommandRequest};

fn main() -> ExitCode {
    // Capture the product stamp here: Buck compiles the library independently.
    let identity =
        build_identity_from_env(env!("CARGO_PKG_VERSION"), option_env!("CLI_BUILD_STAMP"));
    let args: Vec<String> = std::env::args().skip(1).collect();
    match parse_args(&args, &identity.machine_version) {
        Ok(CommandRequest::Help) => {
            print_help(&identity.display_version);
            ExitCode::SUCCESS
        }
        Ok(CommandRequest::Version) => {
            println!("otel-scrape {}", identity.display_version);
            ExitCode::SUCCESS
        }
        Ok(CommandRequest::Run(config)) => match run(*config) {
            Ok(code) => ExitCode::from(code.clamp(0, 255) as u8),
            Err(cause) => {
                eprintln!(
                    "otel-scrape: {cause} {}",
                    identity.error_suffix("otel-scrape")
                );
                ExitCode::from(1)
            }
        },
        Err(cause) => {
            eprintln!(
                "otel-scrape: {} {}",
                cause.message(),
                identity.error_suffix("otel-scrape")
            );
            eprintln!("try: otel-scrape --help");
            ExitCode::from(usage_exit_code())
        }
    }
}
