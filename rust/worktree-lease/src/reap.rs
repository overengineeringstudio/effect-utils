//! Conservative recovery; the archive command retains its own consent and reference gates.
use crate::{guard, record::Record, Identity, Lease, Refusal, Result};
use std::{
    ffi::OsString,
    fs,
    io::{Read, Seek},
    os::{
        fd::AsRawFd,
        unix::{
            ffi::OsStrExt,
            fs::{MetadataExt, OpenOptionsExt},
            process::CommandExt,
        },
    },
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[derive(serde::Serialize)]
#[serde(tag = "_tag")]
pub enum Decision {
    Eligible {
        worktree: std::path::PathBuf,
        archive_status: i32,
    },
    Retained {
        worktree: std::path::PathBuf,
        reason: &'static str,
    },
}
fn git(identity: &Identity, args: &[&str]) -> std::result::Result<String, &'static str> {
    let mut command = Command::new("git");
    for (key, _) in std::env::vars_os() {
        if key.as_bytes().starts_with(b"GIT_") {
            command.env_remove(key);
        }
    }
    let mut output = tempfile::tempfile().map_err(|_| "GitUnknown")?;
    let mut child = command
        .current_dir(&identity.worktree)
        .args(args)
        .stdout(output.try_clone().map_err(|_| "GitUnknown")?)
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "GitUnknown")?;
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("GitUnknown");
            }
        }
    }
    output.rewind().map_err(|_| "GitUnknown")?;
    let mut text = String::new();
    output.read_to_string(&mut text).map_err(|_| "GitUnknown")?;
    Ok(text)
}
#[cfg(target_os = "linux")]
fn no_cwd(worktree: &Path) -> bool {
    if guard::pid_namespace().is_none() {
        return false;
    }
    let Ok(entries) = fs::read_dir("/proc") else {
        return false;
    };
    for entry in entries {
        let Ok(entry) = entry else { return false };
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            continue;
        };
        match fs::read_link(entry.path().join("cwd")) {
            Ok(cwd) if cwd.starts_with(worktree) => return false,
            Ok(_) => (),
            Err(_) if guard::process(pid) == guard::ProcessState::Dead => (),
            Err(_) => return false,
        }
    }
    true
}
#[cfg(not(target_os = "linux"))]
fn no_cwd(_: &Path) -> bool {
    false
}

/// Returns an exclusive scope plus the exact HEAD/branch that the archive command must recheck.
/// No attribution record is not sufficient for reaper eligibility (unlike the general guard).
pub fn candidate(
    common: &Path,
    path: &Path,
) -> std::result::Result<(Lease, String, String), &'static str> {
    if !fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir()) {
        return Err("NotManagedChild");
    }
    let identity = Identity::resolve(path).map_err(|_| "Unregistered")?;
    if identity.common != common
        || identity.worktree != path
        || path.parent() != Some(common.join("gate-worktrees").as_path())
    {
        return Err("NotManagedChild");
    }
    let lease = guard::reclaim(identity.clone()).map_err(|_| "Protected")?;
    let record = Record::inspect(&identity)
        .map_err(|_| "InvalidRecord")?
        .ok_or("MissingRecord")?;
    if !guard::eligible(
        &record,
        &guard::hostname().map_err(|_| "UnknownHost")?,
        std::time::SystemTime::now(),
        &guard::process(record.holder.pid),
        guard::pid_namespace(),
    ) {
        return Err("Protected");
    }
    if !git(
        &identity,
        &[
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
            "--ignore-submodules=none",
        ],
    )?
    .is_empty()
    {
        return Err("Dirty");
    }
    let head = git(&identity, &["rev-parse", "--verify", "HEAD"])?;
    let branch = git(&identity, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let branch = if branch.trim() == "HEAD" {
        ""
    } else {
        branch.trim()
    };
    if git(
        &identity,
        &[
            "for-each-ref",
            "--format=%(refname)",
            "--contains",
            head.trim(),
            "refs/remotes/",
        ],
    )?
    .trim()
    .is_empty()
    {
        return Err("HeadNotOnRemote");
    }
    if !no_cwd(path) {
        return Err("CwdLiveOrUnknown");
    }
    lease.validate().map_err(|_| "Retired")?;
    Ok((lease, head.trim().into(), branch.into()))
}

fn singleton(common: &Path) -> Result<fs::File> {
    let path = common.join("gate-worktrees.reap.lock");
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(&path)
        .map_err(|_| Refusal::UnsafeLock)?;
    let before = file.metadata().map_err(|_| Refusal::UnsafeLock)?;
    if !before.is_file() {
        return Err(Refusal::UnsafeLock);
    }
    // SAFETY: the owned regular descriptor stays open through this nonblocking flock.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(Refusal::Busy);
    }
    let named = fs::symlink_metadata(path).map_err(|_| Refusal::UnsafeLock)?;
    if !named.is_file() || (before.dev(), before.ino()) != (named.dev(), named.ino()) {
        return Err(Refusal::UnsafeLock);
    }
    Ok(file)
}
/// Runs a caller-selected archive command while holding the exclusive fence through child exit.
/// Only that child inherits WORKTREE_LEASE_LOCK_FD. Other safety gates remain the command's responsibility.
pub fn reap(common: &Path, command: &[OsString], mut emit: impl FnMut(Decision)) -> Result<()> {
    if command.is_empty() {
        return Err(Refusal::InvalidInput);
    }
    let common = fs::canonicalize(common).map_err(|_| Refusal::UnknownIdentity)?;
    let _singleton = singleton(&common)?;
    let managed = common.join("gate-worktrees");
    if !fs::symlink_metadata(&managed).is_ok_and(|metadata| metadata.is_dir()) {
        return Err(Refusal::UnknownIdentity);
    }
    let mut paths = fs::read_dir(managed)
        .map_err(|_| Refusal::UnsafeLock)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(|_| Refusal::UnsafeLock)?;
    paths.sort();
    let mut attempts = 0;
    for path in paths.into_iter().take(64) {
        match candidate(&common, &path) {
            Ok((lease, head, branch)) if attempts < 4 => {
                attempts += 1;
                let fd = lease.file.as_raw_fd();
                let mut archive = Command::new(&command[0]);
                archive
                    .args(&command[1..])
                    .stdout(std::io::stderr())
                    .env("WORKTREE_LEASE_WORKTREE", &path)
                    .env("WORKTREE_LEASE_EXPECT_HEAD", head)
                    .env("WORKTREE_LEASE_EXPECT_BRANCH", branch)
                    .env("WORKTREE_LEASE_LOCK_FD", fd.to_string());
                // SAFETY: post-fork, only fcntl and allocation-free error construction; parent remains CLOEXEC.
                unsafe {
                    archive.pre_exec(move || {
                        if libc::fcntl(fd, libc::F_SETFD, 0) < 0 {
                            return Err(std::io::Error::last_os_error());
                        }
                        Ok(())
                    });
                }
                let archive_status = archive.status().map_or(127, crate::exit_code);
                emit(Decision::Eligible {
                    worktree: path,
                    archive_status,
                });
            }
            Ok(_) => emit(Decision::Retained {
                worktree: path,
                reason: "AttemptLimit",
            }),
            Err(reason) => emit(Decision::Retained {
                worktree: path,
                reason,
            }),
        }
    }
    Ok(())
}
