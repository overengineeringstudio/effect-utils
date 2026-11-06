use clap::{Parser, ValueEnum};
use std::{path::PathBuf, process::Command};
use worktree_lease::{exit_code, Identity, Lease, Refusal, Result};

#[derive(Clone, ValueEnum)]
enum Mode {
    Shared,
    Exclusive,
}
#[derive(Parser)]
struct Args {
    #[arg(value_parser = ["run"])]
    action: String,
    worktree: PathBuf,
    #[arg(long, value_enum)]
    mode: Mode,
    #[arg(long = "try", required = true)]
    attempt: bool,
    #[arg(long, env = "WORKTREE_LEASE_AGENT")]
    agent: Option<String>,
    #[arg(long)]
    job: Option<String>,
    #[arg(last = true, required = true)]
    command: Vec<std::ffi::OsString>,
}
fn run(args: Args) -> Result<i32> {
    let exclusive = matches!(args.mode, Mode::Exclusive);
    if !args
        .agent
        .as_deref()
        .is_some_and(|a| a.starts_with("agent/") && a.len() > 6)
    {
        if exclusive {
            return Err(Refusal::AttributionFailure);
        }
        eprintln!(
            "warning: missing or invalid agent attribution; continuing with shared protection"
        );
    }
    let lease = Lease::open(Identity::resolve(&args.worktree)?)?;
    lease.acquire(exclusive, false)?;
    let status = Command::new(&args.command[0])
        .args(&args.command[1..])
        .status()
        .map_err(|_| Refusal::InvalidInput)?;
    drop(lease);
    Ok(exit_code(status))
}
fn main() {
    let code = run(Args::parse()).unwrap_or_else(|error| {
        eprintln!("worktree-lease: {error:?}");
        error.code()
    });
    std::process::exit(code);
}
