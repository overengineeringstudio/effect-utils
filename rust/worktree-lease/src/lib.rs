//! Scoped per-worktree exclusion. Dropping a lease closes its non-inheritable descriptor.
pub mod actor;
pub mod compat;
pub mod guard;
pub mod reap;
mod reap_safety;
pub mod record;
mod schedule;
use std::{
    cell::Cell,
    fs::{self, File, OpenOptions},
    io,
    os::{
        fd::{AsRawFd, FromRawFd, RawFd},
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
    orphan: bool,
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
            orphan: false,
        };
        if paths.next().is_some() {
            return Err(Refusal::UnknownIdentity);
        }
        identity.validate()?;
        Ok(identity)
    }
    pub fn resolve_admin(path: &Path) -> Result<Self> {
        let admin = fs::canonicalize(path).map_err(|_| Refusal::UnknownIdentity)?;
        let worktree = match fs::read_to_string(admin.join("gitdir")) {
            Ok(backlink) => Path::new(backlink.trim_end())
                .parent()
                .map(Path::to_path_buf),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                admin.parent().map(Path::to_path_buf)
            }
            Err(_) => return Err(Refusal::UnknownIdentity),
        }
        .ok_or(Refusal::UnknownIdentity)?;
        let identity = Self::resolve(&worktree)?;
        if identity.admin != admin {
            return Err(Refusal::UnknownIdentity);
        }
        Ok(identity)
    }
    /// Resolve only a contained linked admin whose worktree no longer links back.
    pub fn resolve_orphan_admin(path: &Path) -> Result<Self> {
        let admin = fs::canonicalize(path).map_err(|_| Refusal::UnknownIdentity)?;
        let lexical = if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()
                .map_err(|_| Refusal::UnknownIdentity)?
                .join(path)
        };
        if lexical != admin {
            return Err(Refusal::UnknownIdentity);
        }
        let read = |name: &str| -> Result<String> {
            let path = admin.join(name);
            if !fs::symlink_metadata(&path)
                .map_err(|_| Refusal::UnknownIdentity)?
                .is_file()
            {
                return Err(Refusal::UnknownIdentity);
            }
            fs::read_to_string(path).map_err(|_| Refusal::UnknownIdentity)
        };
        let common = fs::canonicalize(admin.join(read("commondir")?.trim_end()))
            .map_err(|_| Refusal::UnknownIdentity)?;
        let registered = common.join("worktrees");
        if admin.parent() != Some(registered.as_path())
            || !fs::symlink_metadata(&registered)
                .map_err(|_| Refusal::UnknownIdentity)?
                .is_dir()
            || !common.join("objects").is_dir()
            || !common.join("HEAD").is_file()
        {
            return Err(Refusal::UnknownIdentity);
        }
        let backlink = PathBuf::from(read("gitdir")?.trim_end());
        if !backlink.is_absolute() || backlink.file_name() != Some(std::ffi::OsStr::new(".git")) {
            return Err(Refusal::UnknownIdentity);
        }
        let worktree = backlink
            .parent()
            .ok_or(Refusal::UnknownIdentity)?
            .to_path_buf();
        match fs::symlink_metadata(&backlink) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Ok(metadata) if metadata.is_file() => {
                let text = fs::read_to_string(&backlink).map_err(|_| Refusal::UnknownIdentity)?;
                let target = text
                    .strip_prefix("gitdir: ")
                    .map(str::trim)
                    .filter(|target| !target.is_empty())
                    .ok_or(Refusal::UnknownIdentity)?;
                match fs::canonicalize(worktree.join(target)) {
                    Ok(target) if target == admin => return Err(Refusal::Protected),
                    Ok(_) => (),
                    Err(error) if error.kind() == io::ErrorKind::NotFound => (),
                    Err(_) => return Err(Refusal::UnknownIdentity),
                }
            }
            _ => return Err(Refusal::UnknownIdentity),
        }
        Ok(Self {
            admin,
            common,
            worktree,
            orphan: true,
        })
    }
    fn validate(&self) -> Result<()> {
        if self.orphan {
            return if Self::resolve_orphan_admin(&self.admin)? == *self {
                Ok(())
            } else {
                Err(Refusal::Retired)
            };
        }
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
    pub fn raw_fd(&self) -> RawFd {
        self.file.as_raw_fd()
    }
    pub fn identity(&self) -> &Identity {
        &self.identity
    }
    /// Revoke this open description's authority, including inherited duplicates.
    pub fn release(&self) -> Result<()> {
        // SAFETY: the owned file remains open; LOCK_UN affects this description only.
        if unsafe { libc::flock(self.file.as_raw_fd(), libc::LOCK_UN) } != 0 {
            return Err(Refusal::UnsafeLock);
        }
        self.held.set(None);
        Ok(())
    }
    /// Duplicate and validate a caller-owned inherited exclusive flock without upgrading it.
    /// The original description must remain open; this scope never unlocks or downgrades it.
    pub fn validate_inherited_exclusive(identity: Identity, fd: RawFd) -> Result<Self> {
        // SAFETY: fcntl validates the untrusted descriptor and returns a new owned CLOEXEC fd.
        let duplicate = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 3) };
        if duplicate < 0 {
            return Err(Refusal::UnsafeLock);
        }
        // SAFETY: successful F_DUPFD_CLOEXEC transfers a fresh descriptor to File.
        let file = unsafe { File::from_raw_fd(duplicate) };
        let lease = Self {
            path: identity.admin.join("gate-lease.lock"),
            identity,
            file,
            held: Cell::new(None),
        };
        lease.validate().map_err(|_| Refusal::UnsafeLock)?;
        let probe = Self::open(lease.identity.clone()).map_err(|_| Refusal::UnsafeLock)?;
        // A separate open description must NOT obtain shared authority. This rejects unlocked
        // and shared descriptors before flock could accidentally upgrade them.
        if probe.acquire(false, false) != Err(Refusal::Busy) {
            return Err(Refusal::UnsafeLock);
        }
        lease
            .acquire(true, false)
            .map_err(|_| Refusal::UnsafeLock)?;
        Ok(lease)
    }
    pub fn open(identity: Identity) -> Result<Self> {
        Self::open_named(identity, "gate-lease.lock")
    }
    fn open_named(identity: Identity, name: &str) -> Result<Self> {
        identity.validate()?;
        let path = identity.admin.join(name);
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
