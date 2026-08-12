//! `otel-scrape` CLI entrypoint.
//!
//! Child stdout/stderr are inherited verbatim. Wrapper diagnostics go to stderr;
//! local summary evidence is file-only so replacing `<cmd>` with
//! `otel-scrape -- <cmd>` does not corrupt stdout protocols.

use std::{fs, path::PathBuf, process::ExitCode};

use otel_scrape::{
    install_product_build_info, parse_args, print_help, print_version, run, usage_exit_code,
    CommandRequest,
};

const BUILD_INFO_FILE: &str = "otel-scrape.build-info.json";

fn adjacent_build_info_path() -> Option<PathBuf> {
    Some(
        std::env::current_exe()
            .ok()?
            .with_file_name(BUILD_INFO_FILE),
    )
}

fn load_product_build_info() -> Option<String> {
    fs::read_to_string(adjacent_build_info_path()?).ok()
}

fn main() -> ExitCode {
    if let Some(build_info) = load_product_build_info() {
        install_product_build_info(build_info);
    }
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
