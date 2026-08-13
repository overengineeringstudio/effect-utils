use buck2_portable_toolchain::{stage, StageArgs};
use clap::{Parser, Subcommand};

#[derive(Parser)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Stage(StageArgs),
}

fn main() {
    let result = match Cli::parse().command {
        Command::Stage(args) => stage(args),
    };
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
