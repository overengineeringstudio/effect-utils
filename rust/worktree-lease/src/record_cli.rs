use std::{io::Write, path::PathBuf};
use worktree_lease::{
    guard,
    record::{Holder, Record},
    Identity, Lease, Refusal, Result,
};

#[derive(clap::Subcommand)]
pub enum Command {
    Create {
        worktree: PathBuf,
        #[arg(long)]
        purpose: String,
        #[arg(long)]
        creator: String,
        #[arg(long)]
        holder_pid: Option<u32>,
        #[arg(long)]
        ttl: u64,
    },
    Renew {
        worktree: PathBuf,
        #[arg(long)]
        holder_pid: u32,
        #[arg(long, env = "WORKTREE_LEASE_AGENT")]
        agent: String,
        #[arg(long)]
        ttl: u64,
    },
    Inspect {
        worktree: PathBuf,
        #[arg(long, required = true)]
        json: bool,
    },
    Guard {
        #[arg(long)]
        git_dir: PathBuf,
    },
}
fn output(value: &impl serde::Serialize) -> Result<()> {
    let mut stdout = std::io::stdout().lock();
    serde_json::to_writer(&mut stdout, value).map_err(|_| Refusal::InvalidInput)?;
    stdout.write_all(b"\n").map_err(|_| Refusal::InvalidInput)
}
impl Command {
    pub fn execute(self) -> Result<()> {
        match self {
            Self::Create {
                worktree,
                purpose,
                creator,
                holder_pid,
                ttl,
            } => {
                // SAFETY: getppid has no memory preconditions; adapters can pass an explicit PID.
                let pid = holder_pid.unwrap_or_else(|| unsafe { libc::getppid() as u32 });
                let holder = Holder::capture(creator.clone(), pid)?;
                output(&Record::create(
                    &Identity::resolve(&worktree)?,
                    creator,
                    purpose,
                    holder,
                    ttl,
                )?)
            }
            Self::Renew {
                worktree,
                holder_pid,
                agent,
                ttl,
            } => {
                let lease = Lease::open(Identity::resolve(&worktree)?)?;
                lease.acquire(false, false)?;
                output(&lease.renew(Holder::capture(agent, holder_pid)?, ttl)?)
            }
            Self::Inspect { worktree, .. } => {
                output(&Record::inspect(&Identity::resolve(&worktree)?)?)
            }
            Self::Guard { git_dir } => {
                drop(guard::reclaim(Identity::resolve_admin(&git_dir)?)?);
                Ok(())
            }
        }
    }
}
