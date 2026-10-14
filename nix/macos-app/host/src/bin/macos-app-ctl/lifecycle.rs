//! Verify a consumer-held flock without acquiring an unlocked exclusion interval.
use super::*;

pub(super) struct Guard { _held: File }

pub(super) fn verify(ctl: &Ctl) -> Result<Option<Guard>> {
    let Some(number) = ctl.args.get("lifecycle-fd") else { return Ok(None) };
    let fd: i32 = number.parse().map_err(|_| fail(64, "invalid-input", "Invalid lifecycle descriptor"))?;
    if fd < 3 { return Err(fail(64, "invalid-input", "Lifecycle descriptor must not be stdio")); }
    let path = ctl.state()?.join("lifecycle.lock");
    verify_fd(fd, &path).map(Some)
}

fn verify_fd(fd: i32, path: &Path) -> Result<Guard> {
    use std::os::unix::fs::OpenOptionsExt;
    // SAFETY: fcntl duplicates a borrowed descriptor; File exclusively owns the duplicate.
    let duplicate = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 3) };
    if duplicate < 0 { return Err(fail(64, "invalid-input", "Lifecycle descriptor is not open")); }
    let held = unsafe { File::from_raw_fd(duplicate) };
    let metadata = held.metadata()?;
    let named = fs::symlink_metadata(path)?;
    let owner = unsafe { libc::geteuid() };
    if !metadata.is_file() || !named.is_file() || metadata.dev() != named.dev() || metadata.ino() != named.ino()
        || metadata.nlink() != 1 || metadata.uid() != owner || metadata.mode() & 0o077 != 0 {
        return Err(fail(64, "invalid-input", "Lifecycle descriptor must name the private owned state/lifecycle.lock inode"));
    }
    let probe = fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(path)?;
    let probe_metadata = probe.metadata()?;
    if probe_metadata.dev() != metadata.dev() || probe_metadata.ino() != metadata.ino() {
        return Err(fail(64, "invalid-input", "Lifecycle lock changed during verification"));
    }
    // A separately opened shared lock succeeds if the consumer holds no lock or only
    // shared exclusion. Refuse BEFORE touching the inherited open-file description.
    // SAFETY: descriptors are live owned Files; nonblocking flock never waits.
    if unsafe { libc::flock(probe.as_raw_fd(), libc::LOCK_SH | libc::LOCK_NB) } == 0 {
        return Err(fail(75, "restart-deferred", "Consumer does not hold exclusive lifecycle exclusion"));
    }
    if io::Error::last_os_error().raw_os_error() != Some(libc::EWOULDBLOCK) { return Err(io::Error::last_os_error().into()); }
    // This can succeed only on the same open-file description as the exclusive
    // owner; a contender's descriptor cannot claim another consumer's interval.
    if unsafe { libc::flock(held.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(fail(75, "restart-deferred", "Lifecycle exclusion belongs to another open-file description"));
    }
    Ok(Guard { _held: held })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::OpenOptionsExt;
    #[test]
    fn refuses_unlocked_shared_and_other_description() {
        let path = std::env::temp_dir().join(format!("macos-app-lifecycle-{}", std::process::id()));
        let held = fs::OpenOptions::new().create_new(true).read(true).write(true).mode(0o600).open(&path).unwrap();
        assert!(verify_fd(held.as_raw_fd(), &path).is_err());
        unsafe { assert_eq!(libc::flock(held.as_raw_fd(), libc::LOCK_SH), 0); }
        assert!(verify_fd(held.as_raw_fd(), &path).is_err());
        unsafe { assert_eq!(libc::flock(held.as_raw_fd(), libc::LOCK_EX), 0); }
        let other = File::open(&path).unwrap();
        assert!(verify_fd(other.as_raw_fd(), &path).is_err());
        assert!(verify_fd(held.as_raw_fd(), &path).is_ok());
        fs::remove_file(path).unwrap();
    }
}
