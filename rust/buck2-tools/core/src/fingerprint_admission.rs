//! Host-wide admission shared by CLI invocations, worktrees and Buck daemons.
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{self, ErrorKind};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;

// Fixed, not CPU-scaled: ~220 concurrent walks caused ZFS dnode lookup livelock
// on dev3 on 2026-10-15. More CPUs do not increase safe filesystem concurrency.
const FINGERPRINT_WALK_LIMIT: usize = 4;
// Deliberately independent of TMPDIR, user, worktree and executable store path.
const HOST_LOCK_DIRECTORY: &str = "/tmp/effect-utils-buck2-fingerprint-v1";

pub(crate) fn acquire() -> io::Result<File> {
    acquire_at(Path::new(HOST_LOCK_DIRECTORY))
        .map_err(|error| io::Error::new(error.kind(), format!("fingerprint admission: {error}")))
}

fn lock_file(directory: &Path, name: &str) -> io::Result<File> {
    let path = directory.join(name);
    let before = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o644)
                .open(&path)
            {
                Ok(_) => {}
                Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
            fs::symlink_metadata(&path)?
        }
        Err(error) => return Err(error),
    };
    if !before.is_file() || before.nlink() != 1 || before.mode() & 0o022 != 0 {
        return Err(io::Error::other(
            "coordination file must be a non-shared-writable regular file",
        ));
    }
    // flock works on read-only descriptors on supported Unix hosts, allowing
    // different users to share the same persistent inode without write access.
    let file = File::open(path)?;
    let after = file.metadata()?;
    if before.dev() != after.dev() || before.ino() != after.ino() {
        return Err(io::Error::other("coordination file changed while opening"));
    }
    Ok(file)
}

fn acquire_at(directory: &Path) -> io::Result<File> {
    let metadata = match fs::symlink_metadata(directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            match fs::create_dir(directory) {
                Ok(()) => {}
                Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
            fs::symlink_metadata(directory)?
        }
        Err(error) => return Err(error),
    };
    if !metadata.is_dir() || metadata.mode() & 0o022 != 0 {
        return Err(io::Error::other(
            "coordination directory must be a non-shared-writable directory",
        ));
    }
    // Serialize admission, not walks. Once all slots are busy, one waiter
    // sleeps in the kernel on slot zero; other waiters sleep on admission.
    // After it enters, the next waiter rescans every slot. No polling/spinning.
    let admission = lock_file(directory, "admission")?;
    admission.lock()?;
    // Initialize the entire set before admitting a walk, so subsequent users
    // only need read access to the first user's coordination directory.
    let slots: [File; FINGERPRINT_WALK_LIMIT] = [
        lock_file(directory, "slot-0")?,
        lock_file(directory, "slot-1")?,
        lock_file(directory, "slot-2")?,
        lock_file(directory, "slot-3")?,
    ];
    for slot in slots {
        match slot.try_lock() {
            Ok(()) => return Ok(slot),
            Err(TryLockError::WouldBlock) => {}
            Err(TryLockError::Error(error)) => return Err(error),
        }
    }
    let slot = lock_file(directory, "slot-0")?;
    slot.lock()?;
    Ok(slot)
    // Dropping admission opens the queue; dropping the returned descriptor
    // releases the slot, including on errors, panic or process termination.
    // Never unlink these files: that would split the semaphore's inode set.
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc, Barrier};
    use std::thread;

    #[test]
    fn concurrent_independent_acquisitions_never_exceed_fixed_cap() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("locks");
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
    fn full_semaphore_blocks_and_drop_releases_capacity() {
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
        thread::scope(|scope| {
            scope.spawn(|| {
                let permit = acquire_at(&directory).unwrap();
                tx.send(()).unwrap();
                drop(permit);
            });
            assert!(matches!(rx.try_recv(), Err(mpsc::TryRecvError::Empty)));
            drop(permits.remove(0));
            rx.recv().unwrap();
        });
    }

    #[test]
    #[ignore = "subprocess helper for process_exit_releases_shared_slot"]
    fn hold_slot_in_child() {
        use std::io::{Read, Write};
        let directory = std::env::var_os("FINGERPRINT_ADMISSION_TEST_DIRECTORY").unwrap();
        let _permit = acquire_at(Path::new(&directory)).unwrap();
        println!("SLOT_ACQUIRED");
        io::stdout().flush().unwrap();
        io::stdin().read_exact(&mut [0]).unwrap();
    }

    #[test]
    fn process_exit_releases_shared_slot() {
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
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "fingerprint_admission::tests::hold_slot_in_child",
                    "--ignored",
                    "--nocapture",
                ])
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
    fn rejects_symlinked_coordination_files() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("target"), "").unwrap();
        std::os::unix::fs::symlink("target", root.path().join("admission")).unwrap();
        assert!(acquire_at(root.path()).is_err());
    }
}
