use agent_trace::{decode_commit, summary, Audience};
use clap::{Parser, Subcommand};
use serde_json::Value;
use std::{
    path::PathBuf,
    process::{Command, ExitCode},
};

#[derive(Parser)]
#[command(
    name = "agent-trace",
    version,
    about = "Read authoritative Agent Trace annotations"
)]
struct Cli {
    #[command(subcommand)]
    command: CommandKind,
    /// Emit structured JSON rather than human text.
    #[arg(long, global = true)]
    json: bool,
    /// Decode using the publication-safe public binding.
    #[arg(long, global = true)]
    public: bool,
    /// Repository directory for git-backed reads.
    #[arg(short = 'C', long, global = true, default_value = ".")]
    repo: PathBuf,
}
#[derive(Subcommand)]
enum CommandKind {
    /// Show annotations for a commit, a followed file history, or a span.
    Show {
        #[command(subcommand)]
        source: Source,
    },
}
#[derive(Subcommand)]
enum Source {
    Commit { revision: String },
    File { path: PathBuf },
    Span { path: PathBuf },
}

fn git(repo: &PathBuf, args: &[&str]) -> Result<String, Box<dyn std::error::Error>> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()?;
    if !output.status.success() {
        return Err(format!(
            "git failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into());
    }
    Ok(String::from_utf8(output.stdout)?)
}
fn human_fields(value: &Value, path: &str, lines: &mut Vec<String>) {
    if let Some(object) = value.as_object() {
        for (key, child) in object {
            if key != "type" {
                human_fields(
                    child,
                    &if path.is_empty() {
                        key.clone()
                    } else {
                        format!("{path}.{key}")
                    },
                    lines,
                );
            }
        }
    } else if let Some(text) = value.as_str() {
        lines.push(format!("  {path}: {text}"));
    }
}
#[derive(serde::Serialize)]
struct CommitRecord {
    commit: String,
    trace: Option<Value>,
    #[serde(skip)]
    legacy: bool,
}

fn run(cli: Cli) -> Result<(), Box<dyn std::error::Error>> {
    let audience = if cli.public {
        Audience::Public
    } else {
        Audience::Private
    };
    let CommandKind::Show { source } = cli.command;
    let messages = match source {
        Source::Commit { revision } => {
            let message = git(
                &cli.repo,
                &[
                    "show",
                    "--no-patch",
                    "--format=%B",
                    "--end-of-options",
                    &revision,
                    "--",
                ],
            )?;
            vec![(revision, message)]
        }
        Source::File { path } => {
            let path = path.to_str().ok_or("File path is not UTF-8")?;
            let history = git(
                &cli.repo,
                &["log", "--follow", "--format=%H%x00%B%x00", "--", path],
            )?;
            let mut parts = history.split('\0');
            let mut messages = Vec::new();
            while let Some(commit) = parts.next() {
                if commit.trim().is_empty() {
                    break;
                }
                let body = parts.next().ok_or("Invalid git log record")?;
                messages.push((commit.trim().to_owned(), body.to_owned()));
            }
            messages
        }
        Source::Span { .. } => return Err(
            "Span decoding is not supported yet: no Agent Trace OTel attribute binding is defined"
                .into(),
        ),
    };
    let mut records = Vec::with_capacity(messages.len());
    for (commit, body) in messages {
        let trace = decode_commit(&body, audience)?
            .map(|view| view.value())
            .transpose()?;
        let legacy = !body
            .split('\n')
            .any(|line| line.starts_with("Agent-Trace:"));
        records.push(CommitRecord {
            commit,
            trace,
            legacy,
        });
    }
    if cli.json {
        println!("{}", serde_json::to_string_pretty(&records)?);
    } else {
        for record in records {
            println!("{}", record.commit);
            let Some(trace) = record.trace else {
                println!("no Agent Trace recorded");
                continue;
            };
            if record.legacy {
                let summary = summary(&trace);
                println!(
                    "Agent: {} (legacy trailer/v1)",
                    if summary.is_empty() {
                        "Agent Trace"
                    } else {
                        &summary
                    }
                );
            } else {
                println!("On-Behalf-Of: {}", summary(&trace));
            }
            let mut lines = Vec::new();
            human_fields(&trace, "", &mut lines);
            if !lines.is_empty() {
                println!("{}", lines.join("\n"));
            }
        }
    }
    Ok(())
}
fn main() -> ExitCode {
    match run(Cli::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("agent-trace: {error}");
            ExitCode::FAILURE
        }
    }
}
