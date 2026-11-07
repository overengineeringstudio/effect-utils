use std::{fs, process::Command, time::SystemTime};
use worktree_lease::{
    guard::{eligible, hostname, pid_namespace, process, reclaim, ProcessState},
    record::{Holder, PidNamespace, Record},
    Identity, Lease, Refusal,
};

#[test]
fn death_matrix_and_kernel_veto() {
    let mut record: Record = serde_json::from_str(r#"{"schema":1,"creatorSeat":"agent/test","purpose":"gate","createdAt":"2000-01-01T00:00:00Z","expiresAt":"2001-01-01T00:00:00Z","holder":{"agent":"agent/test","pid":123,"startTime":"123","host":"test-host"}}"#).unwrap();
    let namespace = pid_namespace();
    record.holder.pid_namespace = namespace;
    let eligible = |record: &Record, host: &str, now, state: &ProcessState| {
        eligible(record, host, now, state, namespace)
    };
    let previous = if cfg!(target_os = "linux") {
        "123"
    } else {
        "Mon Jan  1 00:00:00 2001"
    };
    let different = if cfg!(target_os = "linux") {
        "124"
    } else {
        "Tue Jan  2 00:00:00 2001"
    };
    record.holder.start_time = previous.into();
    let now = SystemTime::now();
    for (state, expected) in [
        (ProcessState::Dead, true),
        (ProcessState::Alive(different.into()), true),
        (ProcessState::Alive(previous.into()), false),
        (ProcessState::Unknown, false),
    ] {
        assert_eq!(eligible(&record, "test-host", now, &state), expected);
    }
    assert!(!eligible(&record, "remote-host", now, &ProcessState::Dead));
    let expired = record.expires_at.clone();
    for invalid in [
        "2099-01-01T00:00:00Z",
        "invalid",
        "2001-01-01T00:00:00+00:00",
    ] {
        record.expires_at = invalid.into();
        assert!(!eligible(&record, "test-host", now, &ProcessState::Dead));
    }
    record.expires_at = expired;
    for invalid in ["", "unknown", "+123", "0123"] {
        record.holder.start_time = invalid.into();
        assert!(!eligible(&record, "test-host", now, &ProcessState::Dead));
    }
    let root = tempfile::tempdir().unwrap();
    assert!(Command::new("git")
        .args(["init", "-q"])
        .arg(root.path())
        .status()
        .unwrap()
        .success());
    let identity = || Identity::resolve(root.path()).unwrap();
    assert!(reclaim(identity()).is_ok());
    for directory in [root.path().to_path_buf(), identity().admin] {
        let marker = directory.join("reclaim-keep");
        fs::write(&marker, b"").unwrap();
        assert_eq!(reclaim(identity()).err(), Some(Refusal::Protected));
        fs::remove_file(marker).unwrap();
    }
    let path = identity().admin.join("gate-lease.json");
    record.holder = Holder::capture("agent/test".into(), std::process::id()).unwrap();
    fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    assert_eq!(reclaim(identity()).err(), Some(Refusal::Protected));
    record.holder.start_time = previous.into();
    fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    assert!(reclaim(identity()).is_ok());
    let live = Lease::open(identity()).unwrap();
    live.acquire(false, false).unwrap();
    assert_eq!(reclaim(identity()).err(), Some(Refusal::Protected));
    drop(live);
    record.holder.host = hostname().unwrap();
    record.holder.pid = i32::MAX as u32;
    assert_eq!(process(record.holder.pid), ProcessState::Dead);
    fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    assert!(reclaim(identity()).is_ok());
    if cfg!(target_os = "linux") {
        for unavailable in [None, Some(PidNamespace { dev: 0, ino: 0 })] {
            record.holder.pid_namespace = unavailable;
            fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
            assert_eq!(reclaim(identity()).err(), Some(Refusal::Protected));
        }
        record.holder.pid_namespace = namespace;
        assert!(!worktree_lease::guard::eligible(
            &record,
            &record.holder.host,
            now,
            &ProcessState::Dead,
            None
        ));
    }
    for field in ["schema", "creatorSeat", "purpose", "createdAt"] {
        let mut bad = serde_json::to_value(&record).unwrap();
        bad[field] = if field == "schema" {
            serde_json::json!(2)
        } else {
            serde_json::json!("invalid")
        };
        fs::write(&path, serde_json::to_vec(&bad).unwrap()).unwrap();
        assert_eq!(reclaim(identity()).err(), Some(Refusal::UnsafeLock));
    }
    for bad in [b"{".as_slice(), b"{}", &[b' '; 65_537]] {
        fs::write(&path, bad).unwrap();
        assert_eq!(reclaim(identity()).err(), Some(Refusal::UnsafeLock));
    }
}
#[cfg(target_os = "linux")]
#[test]
fn unreaped_zombie_is_positively_dead() {
    // SAFETY: the fork child immediately calls the async-signal-safe _exit syscall.
    let pid = unsafe { libc::fork() };
    assert!(pid >= 0);
    if pid == 0 {
        unsafe { libc::_exit(0) }
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while process(pid as u32) != ProcessState::Dead {
        assert!(std::time::Instant::now() < deadline);
        std::thread::yield_now();
    }
    unsafe { libc::waitpid(pid, std::ptr::null_mut(), 0) };
}

#[test]
fn orphan_scope_revalidates_reattachment() {
    let root = tempfile::tempdir().unwrap();
    let canonical = fs::canonicalize(root.path()).unwrap();
    let repo = canonical.join("repo");
    let tree = canonical.join("tree");
    let git = |args: &[&str]| {
        assert!(Command::new("git").args(args).status().unwrap().success());
    };
    git(&["init", "-q", repo.to_str().unwrap()]);
    git(&[
        "-C",
        repo.to_str().unwrap(),
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.org",
        "commit",
        "--allow-empty",
        "-qm",
        "initial",
    ]);
    git(&[
        "-C",
        repo.to_str().unwrap(),
        "worktree",
        "add",
        "-q",
        tree.to_str().unwrap(),
    ]);
    let admin = repo.join(".git/worktrees/tree");
    fs::remove_dir_all(&tree).unwrap();
    let lease = worktree_lease::guard::reclaim_orphan(&admin).unwrap();
    assert_eq!(
        worktree_lease::guard::reclaim_orphan(&admin).err(),
        Some(Refusal::Busy)
    );
    fs::create_dir(&tree).unwrap();
    fs::write(tree.join(".git"), format!("gitdir: {}", admin.display())).unwrap();
    assert_eq!(lease.validate(), Err(Refusal::Protected));
}

#[test]
fn record_holder_capture_is_agent_only() {
    let pid = std::process::id();
    assert!(Holder::capture("agent/test".into(), pid).is_ok());
    for actor in [
        "unit/maintenance.service",
        "launchd/org.example.maintenance",
    ] {
        assert_eq!(
            Holder::capture(actor.into(), pid),
            Err(Refusal::InvalidInput)
        );
    }
}

#[test]
fn orphan_reattached_between_resolution_and_acquisition() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path().canonicalize().unwrap();
    assert!(Command::new("git")
        .args(["init", "-q"])
        .arg(&root)
        .status()
        .unwrap()
        .success());
    let admin = root.join(".git/worktrees/orphan");
    let tree = root.join("missing");
    fs::create_dir_all(&admin).unwrap();
    fs::create_dir(&tree).unwrap();
    fs::write(admin.join("commondir"), "../..").unwrap();
    fs::write(admin.join("gitdir"), tree.join(".git").to_str().unwrap()).unwrap();
    let identity = Identity::resolve_orphan_admin(&admin).unwrap();
    let lease = Lease::open(identity).unwrap();
    fs::write(tree.join(".git"), format!("gitdir: {}", admin.display())).unwrap();
    assert_eq!(lease.acquire(true, false), Err(Refusal::Protected));
    fs::remove_file(tree.join(".git")).unwrap();
    lease.acquire(true, false).unwrap();
    fs::write(tree.join(".git"), format!("gitdir: {}", admin.display())).unwrap();
    assert_eq!(lease.validate(), Err(Refusal::Protected));
}
