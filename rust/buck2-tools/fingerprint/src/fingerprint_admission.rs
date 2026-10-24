//! Host-wide admission shared by CLI invocations, worktrees and Buck daemons.
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{self, ErrorKind};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

// Fixed, not CPU-scaled: ~220 concurrent walks caused ZFS dnode lookup livelock
// on dev3 on 2026-10-15. More CPUs do not increase safe filesystem concurrency.
const FINGERPRINT_WALK_LIMIT: usize = 4;
// Deliberately independent of TMPDIR, user, worktree and executable store path.
const HOST_LOCK_DIRECTORY: &str = "/tmp/effect-utils-buck2-fingerprint-v1";

fn admission_directory(directory: Option<&Path>) -> &Path {
    directory.unwrap_or_else(|| Path::new(HOST_LOCK_DIRECTORY))
}

pub(crate) fn acquire(directory: Option<&Path>) -> io::Result<File> {
    acquire_at(admission_directory(directory))
        .map_err(|error| io::Error::new(error.kind(), format!("fingerprint admission: {error}")))
}

fn temporary_path(path: &Path) -> io::Result<PathBuf> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::other("coordination path needs a file name"))?;
    Ok(path.with_file_name(format!(
        ".{}.{}-{}",
        name.to_string_lossy(),
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed),
    )))
}

fn coordination_error(path: &Path, mode: &str, error: io::Error) -> io::Error {
    io::Error::new(
        error.kind(),
        format!(
            "fingerprint coordination {} requires usable mode {mode}: {error}",
            path.display(),
        ),
    )
}

fn publish_directory(directory: &Path) -> io::Result<()> {
    if directory.try_exists()? {
        return Ok(());
    }
    let temporary = loop {
        let path = temporary_path(directory)?;
        match fs::create_dir(&path) {
            Ok(()) => break path,
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    };
    let result = (|| {
        // Publish a nonempty directory so another cold initializer cannot replace
        // its inode while a caller starts opening the admission file.
        publish_file(&temporary.join("admission"))?;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o1777))?;
        fs::rename(&temporary, directory)
    })();
    let cleanup = match fs::remove_dir_all(&temporary) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    };
    // In sticky /tmp, another user's winner can make rename fail with
    // EPERM/EACCES rather than EEXIST. After cleanup, validate the winner by use.
    let result = match result {
        Err(_) if directory.is_dir() => Ok(()),
        other => other,
    };
    result.and(cleanup)
}

fn publish_file(path: &Path) -> io::Result<()> {
    if path.try_exists()? {
        return Ok(());
    }
    let (temporary, file) = loop {
        let temporary = temporary_path(path)?;
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)
        {
            Ok(file) => break (temporary, file),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    };
    let result = (|| {
        file.set_permissions(fs::Permissions::from_mode(0o666))?;
        match fs::hard_link(&temporary, path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => Ok(()),
            Err(error) => Err(error),
        }
    })();
    let cleanup = fs::remove_file(&temporary);
    // A concurrently published winner can also mask the expected EEXIST with
    // a permission error. Leave regular-file/open/lock validation to the caller.
    let result = match result {
        Err(_) if path.is_file() => Ok(()),
        other => other,
    };
    result.and(cleanup)
}

fn lock_file(directory: &Path, name: &str) -> io::Result<File> {
    let path = directory.join(name);
    let open = || {
        publish_file(&path)?;
        let before = fs::symlink_metadata(&path)?;
        if !before.is_file() {
            return Err(io::Error::other("coordination path must be a regular file"));
        }
        // flock supports read-only descriptors, including the action's read-only
        // bind mount. Existing modes need only permit actual open/lock use.
        let file = File::open(&path)?;
        let after = file.metadata()?;
        if before.dev() != after.dev() || before.ino() != after.ino() {
            return Err(io::Error::other("coordination file changed while opening"));
        }
        Ok(file)
    };
    open().map_err(|error| coordination_error(&path, "0666", error))
}

fn acquire_at(directory: &Path) -> io::Result<File> {
    acquire_at_for_pid(directory, std::process::id(), || {})
}

fn acquire_at_for_pid(directory: &Path, pid: u32, before_wait: impl FnOnce()) -> io::Result<File> {
    publish_directory(directory).map_err(|error| coordination_error(directory, "1777", error))?;
    let metadata = fs::symlink_metadata(directory)
        .map_err(|error| coordination_error(directory, "1777", error))?;
    if !metadata.is_dir() {
        return Err(coordination_error(
            directory,
            "1777",
            io::Error::other("not a directory"),
        ));
    }
    // Serialize only the scan. Waiters release admission before blocking on
    // PID-distributed slots, so one slow slot does not block the entire queue.
    let admission = lock_file(directory, "admission")?;
    admission
        .lock()
        .map_err(|error| coordination_error(&directory.join("admission"), "0666", error))?;
    // Initialize the entire set before admitting a walk, so subsequent users
    // only need read access to the first user's coordination directory.
    let slots: [File; FINGERPRINT_WALK_LIMIT] = [
        lock_file(directory, "slot-0")?,
        lock_file(directory, "slot-1")?,
        lock_file(directory, "slot-2")?,
        lock_file(directory, "slot-3")?,
    ];
    for (index, slot) in slots.into_iter().enumerate() {
        match slot.try_lock() {
            Ok(()) => return Ok(slot),
            Err(TryLockError::WouldBlock) => {}
            Err(TryLockError::Error(error)) => {
                return Err(coordination_error(
                    &directory.join(format!("slot-{index}")),
                    "0666",
                    error,
                ))
            }
        }
    }
    drop(admission);
    // Tests synchronize here to prove the full scan completed before releasing
    // a nonzero slot; the production caller supplies an inlined no-op.
    before_wait();
    wait_for_slot(directory, pid)
    // Dropping the returned descriptor releases the slot, including on errors,
    // panic or process termination. Never unlink live coordination files.
}

fn wait_for_slot(directory: &Path, pid: u32) -> io::Result<File> {
    let index = pid as usize % FINGERPRINT_WALK_LIMIT;
    let slot = lock_file(directory, &format!("slot-{index}"))?;
    slot.lock().map_err(|error| {
        coordination_error(&directory.join(format!("slot-{index}")), "0666", error)
    })?;
    Ok(slot)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc, Barrier};
    use std::thread;

    #[test]
    fn published_directory_already_contains_admission() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("locks");
        publish_directory(&directory).unwrap();
        let admission = fs::symlink_metadata(directory.join("admission")).unwrap();
        File::open(directory.join("admission"))
            .unwrap()
            .try_lock()
            .unwrap();
        assert!(admission.is_file());
        assert_eq!(admission.mode() & 0o7777, 0o666);
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
    }

    #[test]
    fn concurrent_cold_start_initialization_all_succeeds() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("locks");
        let count = FINGERPRINT_WALK_LIMIT + 8;
        let start = Barrier::new(count + 1);
        thread::scope(|scope| {
            let mut workers = Vec::new();
            for _ in 0..count {
                workers.push(scope.spawn(|| {
                    start.wait();
                    acquire_at(&directory).map(drop)
                }));
            }
            start.wait();
            for worker in workers {
                worker.join().unwrap().unwrap();
            }
        });
        assert_eq!(
            fs::read_dir(&directory).unwrap().count(),
            FINGERPRINT_WALK_LIMIT + 1
        );
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[test]
    fn concurrent_acquisitions_never_exceed_fixed_cap() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("locks");
        drop(acquire_at(&directory).unwrap());
        let start = Arc::new(Barrier::new(FINGERPRINT_WALK_LIMIT + 4));
        let first_wave = Arc::new(Barrier::new(FINGERPRINT_WALK_LIMIT + 1));
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let entered = Arc::new(AtomicUsize::new(0));
        thread::scope(|scope| {
            for _ in 0..FINGERPRINT_WALK_LIMIT + 3 {
                let (start, first_wave, active, maximum, entered, directory) = (
                    start.clone(),
                    first_wave.clone(),
                    active.clone(),
                    maximum.clone(),
                    entered.clone(),
                    directory.clone(),
                );
                scope.spawn(move || {
                    start.wait();
                    let permit = acquire_at(&directory).unwrap();
                    let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                    maximum.fetch_max(count, Ordering::SeqCst);
                    assert!(count <= FINGERPRINT_WALK_LIMIT);
                    if entered.fetch_add(1, Ordering::SeqCst) < FINGERPRINT_WALK_LIMIT {
                        first_wave.wait();
                    }
                    active.fetch_sub(1, Ordering::SeqCst);
                    drop(permit);
                });
            }
            start.wait();
            first_wave.wait();
        });
        assert_eq!(maximum.load(Ordering::SeqCst), FINGERPRINT_WALK_LIMIT);
        assert_eq!(entered.load(Ordering::SeqCst), FINGERPRINT_WALK_LIMIT + 3);
        assert_eq!(active.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn releasing_nonzero_slot_admits_its_waiter_without_releasing_slot_zero() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("locks");
        let mut permits = (0..FINGERPRINT_WALK_LIMIT)
            .map(|_| acquire_at(&directory).unwrap())
            .collect::<Vec<_>>();
        for index in 0..FINGERPRINT_WALK_LIMIT {
            assert!(matches!(
                lock_file(&directory, &format!("slot-{index}"))
                    .unwrap()
                    .try_lock(),
                Err(TryLockError::WouldBlock)
            ));
        }
        let (tx, rx) = mpsc::channel();
        let (scanned_tx, scanned_rx) = mpsc::channel();
        thread::scope(|scope| {
            scope.spawn(|| {
                let permit =
                    acquire_at_for_pid(&directory, 1, || scanned_tx.send(()).unwrap()).unwrap();
                tx.send(()).unwrap();
                drop(permit);
            });
            scanned_rx.recv().unwrap();
            assert!(matches!(rx.try_recv(), Err(mpsc::TryRecvError::Empty)));
            drop(permits.remove(1));
            rx.recv().unwrap();
        });
        assert!(matches!(
            lock_file(&directory, "slot-0").unwrap().try_lock(),
            Err(TryLockError::WouldBlock)
        ));
    }

    #[test]
    fn default_admission_remains_host_wide() {
        assert_eq!(admission_directory(None), Path::new(HOST_LOCK_DIRECTORY));
        let isolated = Path::new("/isolated-fixture/fingerprint-admission");
        assert_eq!(admission_directory(Some(isolated)), isolated);
    }

    #[test]
    fn isolated_admission_domains_do_not_share_capacity() {
        let root = tempfile::tempdir().unwrap();
        let first = root.path().join("first");
        let second = root.path().join("second");
        let _permits = (0..FINGERPRINT_WALK_LIMIT)
            .map(|_| acquire(Some(&first)).unwrap())
            .collect::<Vec<_>>();
        let _isolated = acquire(Some(&second)).unwrap();
    }

    #[test]
    #[ignore = "subprocess helper for restrictive_umask_initialization_and_process_exit_share_slots"]
    fn hold_slot_in_child() {
        use std::io::{Read, Write};
        let directory = std::env::var_os("FINGERPRINT_ADMISSION_TEST_DIRECTORY").unwrap();
        let _permit = acquire_at(Path::new(&directory)).unwrap();
        println!("SLOT_ACQUIRED");
        io::stdout().flush().unwrap();
        io::stdin().read_exact(&mut [0]).unwrap();
    }

    #[test]
    fn restrictive_umask_initialization_and_process_exit_share_slots() {
        use std::io::BufRead;
        use std::process::{Child, Command, Stdio};
        struct ChildGuard(Child);
        impl Drop for ChildGuard {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("locks");
        let mut child = ChildGuard(
            Command::new("/bin/sh")
                .args([
                    "-c",
                    "umask 077; exec \"$1\" --exact fingerprint_admission::tests::hold_slot_in_child --ignored --nocapture",
                    "fingerprint-admission-test",
                ])
                .arg(std::env::current_exe().unwrap())
                .env("FINGERPRINT_ADMISSION_TEST_DIRECTORY", &directory)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let output = io::BufReader::new(child.0.stdout.take().unwrap());
        assert!(output
            .lines()
            .any(|line| line.unwrap().ends_with("SLOT_ACQUIRED")));
        assert_eq!(fs::metadata(&directory).unwrap().mode() & 0o7777, 0o1777);
        for name in ["admission", "slot-0", "slot-1", "slot-2", "slot-3"] {
            assert_eq!(
                fs::metadata(directory.join(name)).unwrap().mode() & 0o7777,
                0o666
            );
        }
        let _permits = (1..FINGERPRINT_WALK_LIMIT)
            .map(|_| acquire_at(&directory).unwrap())
            .collect::<Vec<_>>();
        for index in 0..FINGERPRINT_WALK_LIMIT {
            assert!(matches!(
                lock_file(&directory, &format!("slot-{index}"))
                    .unwrap()
                    .try_lock(),
                Err(TryLockError::WouldBlock)
            ));
        }
        drop(child);
        let _replacement = acquire_at(&directory).unwrap();
    }

    #[test]
    fn existing_usable_modes_do_not_require_exact_permission_bits() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("locks");
        drop(acquire_at(&directory).unwrap());
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        for name in ["admission", "slot-0", "slot-1", "slot-2", "slot-3"] {
            fs::set_permissions(directory.join(name), fs::Permissions::from_mode(0o600)).unwrap();
        }
        drop(acquire_at(&directory).unwrap());
    }

    #[test]
    fn rejects_symlinked_coordination_files() {
        let root = tempfile::tempdir().unwrap();
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o1777)).unwrap();
        fs::write(root.path().join("target"), "").unwrap();
        std::os::unix::fs::symlink("target", root.path().join("admission")).unwrap();
        assert!(acquire_at(root.path()).is_err());
    }
}
