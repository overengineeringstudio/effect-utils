use ci_storage::{
    transport::{read_url, PresignedHttp, Transport},
    ArtifactRef, Result, Retention,
};
use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(
    name = "ci-storage",
    about = "Canonical verified CI artifacts over presigned HTTPS"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    Pack {
        #[arg(required = true, num_args = 1..)]
        paths: Vec<String>,
        #[arg(long, value_enum)]
        retention: Retention,
        #[arg(long)]
        repo: String,
        #[arg(long)]
        out: PathBuf,
    },
    Verify {
        archive: PathBuf,
        #[arg(long = "ref")]
        reference: String,
    },
    Extract {
        archive: PathBuf,
        #[arg(long = "ref")]
        reference: String,
        #[arg(long)]
        dest: PathBuf,
    },
    Put {
        archive: PathBuf,
        #[arg(long, env = "CI_STORAGE_PUT_URL_FILE")]
        url_file: PathBuf,
    },
    Get {
        #[arg(long, env = "CI_STORAGE_GET_URL_FILE")]
        url_file: PathBuf,
        #[arg(long)]
        out: PathBuf,
    },
}
fn run(cli: Cli) -> Result<()> {
    match cli.command {
        Command::Pack {
            paths,
            retention,
            repo,
            out,
        } => {
            let reference =
                ci_storage::pack(&std::env::current_dir()?, &paths, retention, repo, &out)?;
            println!(
                "{}",
                serde_json::json!({"ref": reference, "sha256": reference.sha256, "key": reference.key()})
            );
        }
        Command::Verify { archive, reference } => {
            let reference: ArtifactRef =
                serde_json::from_str(&reference).map_err(|_| "invalid artifact reference JSON")?;
            ci_storage::verify(&archive, &reference)?;
        }
        Command::Extract {
            archive,
            reference,
            dest,
        } => {
            let reference: ArtifactRef =
                serde_json::from_str(&reference).map_err(|_| "invalid artifact reference JSON")?;
            ci_storage::extract(&archive, &reference, &dest)?;
        }
        Command::Put { archive, url_file } => {
            PresignedHttp::default().put(&archive, &read_url(&url_file)?)?
        }
        Command::Get { url_file, out } => {
            PresignedHttp::default().get(&read_url(&url_file)?, &out)?
        }
    }
    Ok(())
}
fn main() {
    if let Err(error) = run(Cli::parse()) {
        eprintln!("ci-storage: {error}");
        std::process::exit(1);
    }
}
