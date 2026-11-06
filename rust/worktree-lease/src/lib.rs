//! Scoped per-worktree exclusion. Dropping a lease closes its non-inheritable descriptor.
pub mod guard;
pub mod record;
use std::{
    cell::Cell,
    fs::{self, File, OpenOptions},
    io,
    os::{
        fd::AsRawFd,
        unix::{
            ffi::OsStrExt,
            fs::{MetadataExt, OpenOptionsExt},
            process::ExitStatusExt,
        },
    },
    path::{Path, PathBuf},
    process::{Command, ExitStatus},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    Busy,
    Deadline,
    UnknownIdentity,
    UnsafeLock,
    Retired,
    AttributionFailure,
    InvalidInput,
    Protected,
}
impl Refusal {
    pub fn code(self) -> i32 {
        match self {
            Self::Busy | Self::Deadline => 75,
            Self::InvalidInput => 2,
            _ => 1,
        }
    }
    pub fn tag(self) -> &'static str {
        match self {
            Self::Busy => "Busy",
            Self::Deadline => "Deadline",
            Self::UnknownIdentity => "UnknownIdentity",
            Self::UnsafeLock => "UnsafeLock",
            Self::Retired => "Retired",
            Self::AttributionFailure => "AttributionFailure",
            Self::InvalidInput => "InvalidInput",
            Self::Protected => "Protected",
        }
    }
}
pub type Result<T, E = Refusal> = std::result::Result<T, E>;
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Identity {
    pub worktree: PathBuf,
    pub admin: PathBuf,
    pub common: PathBuf,
}
impl Identity {
    pub fn resolve(path: &Path) -> Result<Self> {
        let mut git = Command::new("git");
        for (key, _) in std::env::vars_os() {
            if key.as_bytes().starts_with(b"GIT_") {
                git.env_remove(key);
            }
        }
        let output = git
            .current_dir(path)
            .args([
                "rev-parse",
                "--path-format=absolute",
                "--absolute-git-dir",
                "--git-common-dir",
                "--show-toplevel",
            ])
            .output()
            .map_err(|_| Refusal::UnknownIdentity)?;
        if !output.status.success() {
            return Err(Refusal::UnknownIdentity);
        }
        let text = std::str::from_utf8(&output.stdout).map_err(|_| Refusal::UnknownIdentity)?;
        let mut paths = text.lines().map(fs::canonicalize);
        let mut next = || {
            paths
                .next()
                .ok_or(Refusal::UnknownIdentity)?
                .map_err(|_| Refusal::UnknownIdentity)
        };
        let identity = Self {
            admin: next()?,
            common: next()?,
            worktree: next()?,
        };
        if paths.next().is_some() {
            return Err(Refusal::UnknownIdentity);
        }
        identity.validate()?;
        Ok(identity)
    }
    fn validate(&self) -> Result<()> {
        let registered = if self.admin == self.common {
            fs::canonicalize(self.worktree.join(".git")).ok().as_deref()
                == Some(self.admin.as_path())
        } else {
            let gitfile = self.worktree.join(".git");
            let backlink = fs::read_to_string(self.admin.join("gitdir"))
                .ok()
                .and_then(|p| fs::canonicalize(p.trim_end()).ok());
            let forward = fs::read_to_string(&gitfile)
                .ok()
                .and_then(|p| p.strip_prefix("gitdir: ").map(str::trim).map(PathBuf::from))
                .and_then(|p| fs::canonicalize(self.worktree.join(p)).ok());
            backlink.is_some()
                && backlink == fs::canonicalize(gitfile).ok()
                && forward.as_deref() == Some(self.admin.as_path())
                && self.admin.parent() == Some(self.common.join("worktrees").as_path())
        };
        if !registered || !self.admin.is_dir() {
            return Err(Refusal::Retired);
        }
        Ok(())
    }
}
pub struct Lease {
    file: File,
    identity: Identity,
    path: PathBuf,
    held: Cell<Option<bool>>,
}
impl Lease {
    pub fn open(identity: Identity) -> Result<Self> {
        identity.validate()?;
        let path = identity.admin.join("gate-lease.lock");
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
            .open(&path)
            .map_err(|_| Refusal::UnsafeLock)?;
        let lease = Self {
            file,
            identity,
            path,
            held: Cell::new(None),
        };
        lease.validate()?;
        Ok(lease)
    }
    pub fn validate(&self) -> Result<()> {
        self.identity.validate()?;
        let fd = self.file.metadata().map_err(|_| Refusal::UnsafeLock)?;
        let named = fs::symlink_metadata(&self.path).map_err(|_| Refusal::Retired)?;
        if !fd.is_file() || !named.is_file() {
            return Err(Refusal::UnsafeLock);
        }
        if (fd.dev(), fd.ino()) != (named.dev(), named.ino()) {
            return Err(Refusal::Retired);
        }
        Ok(())
    }
    /// Blocking acquisition is interruptible; callers must arrange cancellation/deadlines.
    pub fn acquire(&self, exclusive: bool, blocking: bool) -> Result<()> {
        if self.held.get().is_some() {
            return Err(Refusal::InvalidInput);
        }
        self.validate()?;
        let op = if exclusive {
            libc::LOCK_EX
        } else {
            libc::LOCK_SH
        } | if blocking { 0 } else { libc::LOCK_NB };
        // SAFETY: the owned file remains open throughout flock; no pointer arguments.
        if unsafe { libc::flock(self.file.as_raw_fd(), op) } != 0 {
            return Err(
                if io::Error::last_os_error().kind() == io::ErrorKind::WouldBlock {
                    Refusal::Busy
                } else {
                    Refusal::UnsafeLock
                },
            );
        }
        self.validate()?;
        self.held.set(Some(exclusive));
        Ok(())
    }
}
pub fn exit_code(status: ExitStatus) -> i32 {
    status
        .code()
        .unwrap_or_else(|| 128 + status.signal().unwrap_or(1))
}
