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
        #[arg(
            long,
            required_unless_present = "orphan_admin",
            conflicts_with = "orphan_admin"
        )]
        git_dir: Option<PathBuf>,
        #[arg(long)]
        orphan_admin: Option<PathBuf>,
        #[arg(long, env = "WORKTREE_LEASE_AGENT")]
        agent: Option<String>,
    },
}
fn output(tag: &str, value: &impl serde::Serialize) -> Result<()> {
    #[derive(serde::Serialize)]
    struct Success<'a, T> {
        _tag: &'a str,
        reason: &'a str,
        record: &'a T,
    }
    let mut stdout = std::io::stdout().lock();
    serde_json::to_writer(
        &mut stdout,
        &Success {
            _tag: tag,
            reason: tag,
            record: value,
        },
    )
    .map_err(|_| Refusal::InvalidInput)?;
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
                output(
                    "Created",
                    &Record::create(
                        &Identity::resolve(&worktree)?,
                        creator,
                        purpose,
                        holder,
                        ttl,
                    )?,
                )
            }
            Self::Renew {
                worktree,
                holder_pid,
                agent,
                ttl,
            } => {
                let lease = Lease::open(Identity::resolve(&worktree)?)?;
                lease.acquire(false, false)?;
                output(
                    "Renewed",
                    &lease.renew(Holder::capture(agent, holder_pid)?, ttl)?,
                )
            }
            Self::Inspect { worktree, .. } => output(
                "Inspected",
                &Record::inspect(&Identity::resolve(&worktree)?)?,
            ),
            Self::Guard {
                git_dir,
                orphan_admin,
                agent,
            } => {
                if agent
                    .as_deref()
                    .is_some_and(|actor| !worktree_lease::actor::lock_scope(actor))
                {
                    return Err(Refusal::AttributionFailure);
                }
                let lease = if let Some(admin) = orphan_admin {
                    guard::reclaim_orphan(&admin)?
                } else {
                    guard::reclaim(Identity::resolve_admin(
                        &git_dir.ok_or(Refusal::InvalidInput)?,
                    )?)?
                };
                drop(lease);
                output("Eligible", &Option::<Record>::None)
            }
        }
    }
}
