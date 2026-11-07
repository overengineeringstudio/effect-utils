//! Temporary transport for legacy imports; all authority remains in the native core.
use crate::{
    guard,
    record::{Holder, Record},
    Identity, Lease, Refusal, Result,
};
use std::{
    io::Read,
    os::fd::AsRawFd,
    path::PathBuf,
    time::{Duration, UNIX_EPOCH},
};

#[derive(clap::Subcommand)]
pub enum Command {
    Write {
        worktree: PathBuf,
        purpose: String,
        creator: String,
        pid: u32,
        ttl: u64,
    },
    Lock {
        git_dir: PathBuf,
        socket_fd: i32,
        inherited_fd: Option<i32>,
    },
    Check {
        git_dir: PathBuf,
        epoch: Option<f64>,
    },
    Dead {
        epoch: f64,
    },
    Publish {
        git_dir: PathBuf,
        purpose: String,
        creator: String,
        pid: u32,
        ttl: u64,
        #[arg(long)]
        renew: bool,
    },
}
impl Command {
    pub fn execute(self) -> Result<()> {
        match self {
            Self::Write {
                worktree,
                purpose,
                creator,
                pid,
                ttl,
            } => Self::Publish {
                git_dir: Identity::resolve(&worktree)?.admin,
                purpose,
                creator,
                pid,
                ttl,
                renew: false,
            }
            .execute(),
            Self::Check { git_dir, epoch } => {
                let identity = Identity::resolve_admin(&git_dir)?;
                if let Some(epoch) = epoch {
                    guard::check_at(
                        &identity,
                        UNIX_EPOCH
                            .checked_add(
                                Duration::try_from_secs_f64(epoch)
                                    .map_err(|_| Refusal::InvalidInput)?,
                            )
                            .ok_or(Refusal::InvalidInput)?,
                    )
                } else {
                    guard::check(&identity)
                }
            }
            Self::Dead { epoch } => {
                let mut bytes = Vec::new();
                std::io::stdin()
                    .take(65_537)
                    .read_to_end(&mut bytes)
                    .map_err(|_| Refusal::InvalidInput)?;
                let record: Record =
                    serde_json::from_slice(&bytes).map_err(|_| Refusal::Protected)?;
                let duration =
                    Duration::try_from_secs_f64(epoch).map_err(|_| Refusal::InvalidInput)?;
                let now = UNIX_EPOCH
                    .checked_add(duration)
                    .ok_or(Refusal::InvalidInput)?;
                if guard::eligible(
                    &record,
                    &guard::hostname()?,
                    now,
                    &guard::process(record.holder.pid),
                    guard::pid_namespace(),
                ) {
                    Ok(())
                } else {
                    Err(Refusal::Protected)
                }
            }
            Self::Publish {
                git_dir,
                purpose,
                creator,
                pid,
                ttl,
                renew,
            } => {
                let identity = Identity::resolve_admin(&git_dir)?;
                let agent = std::env::var("FRACTAL_AGENT")
                    .ok()
                    .filter(|s| !s.is_empty())
                    .or_else(|| std::env::var("ST_AGENT").ok().filter(|s| !s.is_empty()))
                    .unwrap_or_else(|| creator.clone());
                let holder = Holder::capture(agent, pid)?;
                if renew {
                    let lease = Lease::open(identity)?;
                    lease.acquire(false, false)?;
                    if Record::inspect(&lease.identity)?.is_some() {
                        lease.renew(holder, ttl)?;
                    } else {
                        Record::create(&lease.identity, creator, purpose, holder, ttl)?;
                    }
                } else {
                    Record::create(&identity, creator, purpose, holder, ttl)?;
                }
                Ok(())
            }
            Self::Lock {
                git_dir,
                socket_fd,
                inherited_fd,
            } => {
                let identity = Identity::resolve_admin(&git_dir)?;
                let lease = if let Some(fd) = inherited_fd {
                    Lease::validate_inherited_exclusive(identity, fd)?
                } else {
                    let lease = Lease::open(identity)?;
                    lease.acquire(true, false)?;
                    lease
                };
                // SAFETY: aligned control storage, valid owned lease fd, and initialized
                // msghdr/iovec remain live until sendmsg returns. Kernel validates socket_fd.
                unsafe {
                    let mut control = [0usize; 8];
                    let mut byte = 0u8;
                    let mut iov = libc::iovec {
                        iov_base: std::ptr::addr_of_mut!(byte).cast(),
                        iov_len: 1,
                    };
                    let mut message: libc::msghdr = std::mem::zeroed();
                    message.msg_iov = &mut iov;
                    message.msg_iovlen = 1;
                    message.msg_control = control.as_mut_ptr().cast();
                    message.msg_controllen =
                        libc::CMSG_SPACE(std::mem::size_of::<i32>() as u32) as _;
                    let header = libc::CMSG_FIRSTHDR(&message);
                    (*header).cmsg_level = libc::SOL_SOCKET;
                    (*header).cmsg_type = libc::SCM_RIGHTS;
                    (*header).cmsg_len = libc::CMSG_LEN(std::mem::size_of::<i32>() as u32) as _;
                    std::ptr::write_unaligned(
                        libc::CMSG_DATA(header).cast::<i32>(),
                        lease.file.as_raw_fd(),
                    );
                    if libc::sendmsg(socket_fd, &message, 0) != 1 {
                        return Err(Refusal::UnsafeLock);
                    }
                }
                Ok(())
            }
        }
    }
}
