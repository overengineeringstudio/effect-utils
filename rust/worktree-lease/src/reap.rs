//! Conservative recovery; the archive command retains its own consent and reference gates.
use crate::{guard, reap_safety as safety, record::Record, Identity, Lease, Refusal, Result};
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
        ignored_content: &'static str,
    },
    Retained {
        worktree: std::path::PathBuf,
        reason: &'static str,
    },
}
pub struct Candidate {
    pub lease: Lease,
    pub head: String,
    pub branch: String,
    pub directory: (u64, u64),
}
impl Candidate {
    /// Recheck the directory fence and both keep markers immediately before mutation.
    pub fn validate(&self) -> std::result::Result<(), &'static str> {
        safety::handoff(&self.lease.identity, self.directory)?;
        self.lease.validate().map_err(|_| "Retired")
    }
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
    let Ok(mountinfo) = fs::read_to_string("/proc/self/mountinfo") else {
        return false;
    };
    if !safety::proc_visible(&mountinfo) {
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
pub fn candidate(common: &Path, path: &Path) -> std::result::Result<Candidate, &'static str> {
    candidate_with_cwd(common, path, no_cwd)
}
fn candidate_with_cwd(
    common: &Path,
    path: &Path,
    cwd_absent: impl FnOnce(&Path) -> bool,
) -> std::result::Result<Candidate, &'static str> {
    let directory = safety::pin(path)?;
    let identity = Identity::resolve(path).map_err(|_| "Unregistered")?;
    if identity.common != common
        || identity.worktree != path
        || path.parent() != Some(common.join("gate-worktrees").as_path())
    {
        return Err("NotManagedChild");
    }
    let lease = guard::reclaim(identity.clone()).map_err(|_| "Protected")?;
    if git(
        &identity,
        &[
            "status",
            "--porcelain=v1",
            "--ignored=matching",
            "--untracked-files=normal",
            "-z",
        ],
    )?
    .split('\0')
    .filter_map(|entry| entry.strip_prefix("!! "))
    .filter_map(|path| Path::new(path.trim_end_matches('/')).file_name())
    .any(|name| {
        let name = name.as_bytes();
        name == b".env" || name.starts_with(b".env.") || name.ends_with(b".local")
    }) {
        return Err("SensitiveIgnoredContent");
    }
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
    if !cwd_absent(path) {
        return Err("CwdLiveOrUnknown");
    }
    let candidate = Candidate {
        lease,
        head: head.trim().into(),
        branch: branch.into(),
        directory,
    };
    candidate.validate()?;
    Ok(candidate)
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
pub fn reap(
    common: &Path,
    scheduled: bool,
    command: &[OsString],
    mut emit: impl FnMut(Decision),
) -> Result<()> {
    reap_with_cwd(common, scheduled, command, &mut emit, no_cwd)
}
fn reap_with_cwd(
    common: &Path,
    scheduled: bool,
    command: &[OsString],
    mut emit: impl FnMut(Decision),
    cwd_absent: impl Fn(&Path) -> bool,
) -> Result<()> {
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
    if !crate::schedule::prepare(&common, &mut paths, scheduled)? {
        return Ok(());
    }
    let mut attempts = 0;
    for path in paths.into_iter().take(64) {
        crate::schedule::examined(&common, &path)?;
        match candidate_with_cwd(&common, &path, &cwd_absent) {
            Ok(candidate) => {
                let fd = candidate.lease.file.as_raw_fd();
                let mut archive = Command::new(&command[0]);
                archive
                    .args(&command[1..])
                    .stdout(std::io::stderr())
                    .env("WORKTREE_LEASE_WORKTREE", &path)
                    .env("WORKTREE_LEASE_EXPECT_HEAD", &candidate.head)
                    .env("WORKTREE_LEASE_EXPECT_BRANCH", &candidate.branch)
                    .env(
                        "WORKTREE_LEASE_WORKTREE_DEV",
                        candidate.directory.0.to_string(),
                    )
                    .env(
                        "WORKTREE_LEASE_WORKTREE_INO",
                        candidate.directory.1.to_string(),
                    )
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
                if let Err(reason) = candidate.validate() {
                    emit(Decision::Retained {
                        worktree: path,
                        reason,
                    });
                    continue;
                }
                attempts += 1;
                let archive_status = archive.status().map_or(127, crate::exit_code);
                emit(Decision::Eligible {
                    worktree: path,
                    archive_status,
                    ignored_content: "disposable",
                });
            }
            Err(reason) => emit(Decision::Retained {
                worktree: path,
                reason,
            }),
        }
        if attempts == 4 {
            break;
        }
    }
    Ok(())
}
#[cfg(all(test, target_os = "linux"))]
#[test]
fn recovery_safety_and_failed_archive_rotation() {
    let root = tempfile::tempdir().unwrap();
    let status = Command::new("bash").arg("-c").arg(r#"
set -eu
git init -q
git -c commit.gpgsign=false -c core.hooksPath=/dev/null -c user.name=Test -c user.email=test@example.com commit -qm initial --allow-empty
git update-ref refs/remotes/test/main HEAD
git worktree add --detach .git/gate-worktrees/candidate >/dev/null
"#).current_dir(root.path()).status().unwrap();
    assert!(status.success());
    let common = root.path().join(".git");
    let tree = common.join("gate-worktrees/candidate");
    let identity = Identity::resolve(&tree).unwrap();
    let mut record: Record = serde_json::from_str(r#"{"schema":1,"creatorSeat":"agent/test","purpose":"gate","createdAt":"2000-01-01T00:00:00Z","expiresAt":"2001-01-01T00:00:00Z","holder":{"agent":"agent/test","pid":2147483647,"startTime":"1","host":"test"}}"#).unwrap();
    record.holder.host = guard::hostname().unwrap();
    record.holder.pid_namespace = guard::pid_namespace();
    fs::write(
        identity.admin.join("gate-lease.json"),
        serde_json::to_vec(&record).unwrap(),
    )
    .unwrap();
    // Shared CI hosts cannot establish global cwd absence. Inject only that oracle;
    // every Git, record, identity and kernel-lock check still uses the real implementation.
    let candidate = candidate_with_cwd(&common, &tree, |_| true).unwrap();
    assert!(!candidate.head.is_empty());
    assert!(candidate.branch.is_empty());
    assert_eq!(
        Lease::open(identity.clone()).unwrap().acquire(false, false),
        Err(Refusal::Busy)
    );
    drop(candidate);
    fs::write(
        common.join("info/exclude"),
        "node_modules/\n.env\n.env.*\n*.local\n",
    )
    .unwrap();
    fs::create_dir(tree.join("node_modules")).unwrap();
    fs::write(tree.join("node_modules/generated"), "disposable").unwrap();
    assert!(candidate_with_cwd(&common, &tree, |_| true).is_ok());
    for secret in [".env", ".env.secret", "settings.local", ".envrc.local"] {
        fs::write(tree.join(secret), "sensitive").unwrap();
        assert_eq!(
            candidate_with_cwd(&common, &tree, |_| true).err(),
            Some("SensitiveIgnoredContent")
        );
        fs::remove_file(tree.join(secret)).unwrap();
    }
    for marker in [
        tree.join("reclaim-keep"),
        identity.admin.join("reclaim-keep"),
    ] {
        let result = candidate_with_cwd(&common, &tree, |_| {
            fs::write(&marker, "").unwrap();
            true
        });
        assert_eq!(result.err(), Some("Protected"));
        fs::remove_file(marker).unwrap();
    }
    let moved = common.join("relocated");
    let result = candidate_with_cwd(&common, &tree, |_| {
        fs::rename(&tree, &moved).unwrap();
        std::os::unix::fs::symlink(&moved, &tree).unwrap();
        true
    });
    assert_eq!(result.err(), Some("WorktreeChanged"));
    fs::remove_file(&tree).unwrap();
    fs::rename(moved, &tree).unwrap();
    for index in 0..5 {
        let path = common.join("gate-worktrees").join(format!("next-{index}"));
        git(
            &identity,
            &["worktree", "add", "--detach", path.to_str().unwrap()],
        )
        .unwrap();
        let admin = Identity::resolve(&path).unwrap().admin;
        fs::write(
            admin.join("gate-lease.json"),
            serde_json::to_vec(&record).unwrap(),
        )
        .unwrap();
    }
    let log = root.path().join("attempts");
    let command = [
        "sh",
        "-c",
        r#"set -eu
test -e "/proc/self/fd/$WORKTREE_LEASE_LOCK_FD"
test "$(stat -c '%d:%i' "$WORKTREE_LEASE_WORKTREE")" = "$WORKTREE_LEASE_WORKTREE_DEV:$WORKTREE_LEASE_WORKTREE_INO"
printf '%s\n' "$WORKTREE_LEASE_WORKTREE" >> "$1"
case "${WORKTREE_LEASE_WORKTREE##*/}" in candidate|next-1) exit 7;; *) exit 0;; esac"#,
        "archive",
    ]
    .map(OsString::from)
    .into_iter()
    .chain([log.clone().into_os_string()])
    .collect::<Vec<_>>();
    let mut statuses = Vec::new();
    for _ in 0..2 {
        reap_with_cwd(
            &common,
            false,
            &command,
            |decision| {
                if let Decision::Eligible { archive_status, .. } = decision {
                    assert!(matches!(archive_status, 0 | 7));
                    statuses.push(archive_status);
                }
            },
            |_| true,
        )
        .unwrap();
    }
    assert_eq!(statuses.len(), 8);
    assert_eq!(&statuses[..2], &[7, 0]);
    let log = fs::read_to_string(log).unwrap();
    assert_eq!(
        log.lines().collect::<std::collections::BTreeSet<_>>().len(),
        6
    );
}
