//! Acquire present exclusive exclusion on the consumer's inherited open-file description.
use super::*;

pub(super) struct Guard { _held: File }

pub(super) fn verify(ctl: &Ctl) -> Result<Option<Guard>> {
    let Some(number) = ctl.args.get("lifecycle-fd") else {
        if !ctl.config["lifecycleLockPath"].is_null() {
            return Err(fail(64, "invalid-input", "Configured lifecycle exclusion requires --lifecycle-fd"));
        }
        return Ok(None);
    };
    let fd: i32 = number.parse().map_err(|_| fail(64, "invalid-input", "Invalid lifecycle descriptor"))?;
    if fd < 3 { return Err(fail(64, "invalid-input", "Lifecycle descriptor must not be stdio")); }
    let path = PathBuf::from(ctl.field("lifecycleLockPath")?);
    verify_fd(fd, &path).map(Some)
}

fn verify_fd(fd: i32, path: &Path) -> Result<Guard> {
    use std::os::unix::fs::OpenOptionsExt;
    let owner = unsafe { libc::geteuid() };
    let parent = path.parent().ok_or_else(|| fail(64, "invalid-input", "Lifecycle lock requires a parent"))?;
    macos_app_host::endpoint::validate_directory(parent, owner).map_err(|e| fail(64, "invalid-input", e.to_string()))?;
    // SAFETY: fcntl duplicates a borrowed descriptor; File exclusively owns the duplicate.
    let duplicate = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 3) };
    if duplicate < 0 { return Err(fail(64, "invalid-input", "Lifecycle descriptor is not open")); }
    let held = unsafe { File::from_raw_fd(duplicate) };
    let metadata = held.metadata()?;
    let named = fs::symlink_metadata(path)?;
    macos_app_host::endpoint::verify_acl_no_grants(&held).map_err(|e| fail(64, "invalid-input", e.to_string()))?;
    if !metadata.is_file() || !named.is_file() || metadata.dev() != named.dev() || metadata.ino() != named.ino()
        || metadata.nlink() != 1 || metadata.uid() != owner || metadata.mode() & 0o7177 != 0 {
        return Err(fail(64, "invalid-input", "Lifecycle descriptor must name the configured private owned regular lock inode"));
    }
    let probe = fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(path)?;
    let probe_metadata = probe.metadata()?;
    if probe_metadata.dev() != metadata.dev() || probe_metadata.ino() != metadata.ino() {
        return Err(fail(64, "invalid-input", "Lifecycle lock changed during verification"));
    }
    // Darwin flock cannot attest a previously held interval. This acquires
    // PRESENT exclusive exclusion; the consumer covers all preceding pre-checks.
    // SAFETY: inherited OFD is live; nonblocking flock never waits or unlocks it.
    if unsafe { libc::flock(held.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(fail(75, "restart-deferred", "Lifecycle exclusion belongs to another open-file description"));
    }
    // Descriptor flags are process-local: do not let a spawned command retain
    // the consumer's exclusion after ctl returns. Never unlock the shared OFD.
    // SAFETY: fd is live and verified; both fcntl operations concern this descriptor.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } != 0 {
        return Err(io::Error::last_os_error().into());
    }
    Ok(Guard { _held: held })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::OpenOptionsExt;
    #[test]
    fn refuses_foreign_description_and_acquires_present_exclusion() {
        let parent = fs::canonicalize(std::env::temp_dir()).unwrap();
        let path = parent.join(format!("macos-app-lifecycle-{}", std::process::id()));
        let held = fs::OpenOptions::new().create_new(true).read(true).write(true).mode(0o600).open(&path).unwrap();
        assert!(verify_fd(held.as_raw_fd(), &path).is_ok());
        let other = File::open(&path).unwrap();
        assert!(verify_fd(other.as_raw_fd(), &path).is_err());
        assert!(verify_fd(held.as_raw_fd(), &path).is_ok());
        let wrong = parent.join(format!("macos-app-lifecycle-wrong-{}", std::process::id()));
        let wrong_file = fs::OpenOptions::new().create_new(true).read(true).write(true).mode(0o600).open(&wrong).unwrap();
        assert!(verify_fd(wrong_file.as_raw_fd(), &path).is_err());
        fs::remove_file(wrong).unwrap();
        fs::remove_file(path).unwrap();
    }
}
