//! Descriptor-relative, bounded Documents reads and all-or-nothing staging.
//! No pathname received from a client is ever interpreted as a directory.
use crate::{CopiedFile, CopyInput, CopyResult, DocumentsPolicy, HostError};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    ffi::{CString, OsStr},
    fs::{File, Metadata},
    io::{self, Read, Write},
    os::{fd::{AsRawFd, FromRawFd}, unix::{ffi::OsStrExt, fs::MetadataExt}},
    path::{Component, Path},
    time::{Duration, Instant},
};

fn invalid(message: &'static str) -> HostError {
    HostError::new("invalid-request", message)
}
fn denied(message: &'static str) -> HostError {
    HostError::new("policy-denied", message)
}
fn failed(message: &'static str) -> HostError {
    HostError::new("operation-failed", message)
}
fn source_error(error: io::Error) -> HostError {
    if matches!(error.raw_os_error(), Some(libc::EPERM) | Some(libc::EACCES)) {
        HostError::permission("full-disk-access", "Allowlisted source access was denied")
    } else {
        failed("Allowlisted source is unavailable or unsafe")
    }
}
fn staging_error(_: io::Error) -> HostError {
    failed("Private staging is unavailable or unsafe")
}

fn basename(name: &str) -> bool {
    !name.is_empty() && name.len() <= 255 && name != "." && name != ".."
        && !name.contains('/') && !name.contains('\0')
}

fn validate_limits(policy: &DocumentsPolicy) -> Result<(), HostError> {
    if !(1..=4096).contains(&policy.max_items) || policy.max_bytes == 0
        || !(1..=300_000).contains(&policy.timeout_ms)
    {
        return Err(denied("Documents limits must be positive; maxItems <= 4096 and timeoutMs <= 300000"));
    }
    Ok(())
}

fn allowed_names(
    names: &[String],
    check: impl Fn() -> Result<(), HostError>,
) -> Result<HashSet<&str>, HostError> {
    if names.is_empty() {
        return Err(denied("Documents source must allow explicit filenames"));
    }
    let mut allowed = HashSet::with_capacity(names.len());
    for name in names {
        check()?;
        if !basename(name) || !allowed.insert(name.as_str()) {
            return Err(denied("Documents filename allowlist is invalid"));
        }
    }
    Ok(allowed)
}

/// Pure startup validation: never opens a protected source or invokes consent APIs.
pub fn validate_policy(policy: &DocumentsPolicy) -> Result<(), HostError> {
    validate_limits(policy)?;
    for (id, source) in &policy.sources {
        if id.is_empty() || id.len() > 128
            || !id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        {
            return Err(denied("Documents source IDs must be 1..128 ASCII letters, digits, underscores or hyphens"));
        }
        let root = source.root.as_os_str().as_bytes();
        if !source.root.is_absolute() || root.contains(&0)
            || root.split(|byte| *byte == b'/').any(|part| part == b"." || part == b"..")
        {
            return Err(denied("Documents roots must be absolute without dot components"));
        }
        if !basename(&source.sentinel) {
            return Err(denied("Configured sentinel must be a basename"));
        }
        allowed_names(&source.allowed_basenames, || Ok(()))?;
    }
    Ok(())
}

struct Budget<'a> {
    deadline: Instant,
    remaining: u64,
    cancelled: &'a dyn Fn() -> bool,
}
impl Budget<'_> {
    fn new(policy: &DocumentsPolicy) -> Result<Self, HostError> {
        validate_limits(policy)?;
        let deadline = Instant::now().checked_add(Duration::from_millis(policy.timeout_ms))
            .ok_or_else(|| denied("Documents deadline is out of range"))?;
        Ok(Self { deadline, remaining: policy.max_bytes, cancelled: &|| false })
    }
    fn check(&self) -> Result<(), HostError> {
        if (self.cancelled)() {
            return Err(failed("Documents operation cancelled before publication"));
        }
        if Instant::now() >= self.deadline {
            Err(HostError::new("deadline-exceeded", "Documents operation deadline exceeded"))
        } else {
            Ok(())
        }
    }
    fn consume(&mut self, bytes: u64) -> Result<(), HostError> {
        self.check()?;
        self.remaining = self.remaining.checked_sub(bytes)
            .ok_or_else(|| denied("Documents byte limit exceeded"))?;
        Ok(())
    }
}

fn validate_files(names: &[String], max_items: usize) -> Result<(), HostError> {
    if names.is_empty() || names.len() > max_items {
        return Err(denied("Documents item limit exceeded"));
    }
    let mut seen = HashSet::with_capacity(names.len());
    for name in names {
        if !basename(name) {
            return Err(invalid("Files must be single nonempty basenames of at most 255 bytes"));
        }
        if !seen.insert(name) {
            return Err(invalid("Duplicate file names are not allowed"));
        }
    }
    Ok(())
}

// This module's small FFI boundary always borrows live descriptors, never follows
// links, and immediately assigns each newly acquired descriptor one File owner.
fn cstr(name: &OsStr) -> io::Result<CString> {
    CString::new(name.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "NUL in path"))
}
fn open_at(parent: &File, name: &OsStr, flags: i32, mode: libc::mode_t) -> io::Result<File> {
    let name = cstr(name)?;
    // SAFETY: live borrowed descriptor and valid NUL-terminated name.
    let fd = unsafe {
        libc::openat(parent.as_raw_fd(), name.as_ptr(),
            flags | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK, libc::c_uint::from(mode))
    };
    if fd < 0 {
        Err(io::Error::last_os_error())
    } else {
        // SAFETY: successful openat returns a new descriptor owned only here.
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}
fn directory(path: &Path, budget: &Budget<'_>) -> Result<File, HostError> {
    if !path.is_absolute() {
        return Err(denied("Configured directory must be absolute"));
    }
    budget.check()?;
    let mut dir = File::open("/").map_err(source_error)?;
    for component in path.components() {
        budget.check()?;
        match component {
            Component::RootDir => {},
            Component::Normal(name) => {
                dir = open_at(&dir, name, libc::O_RDONLY | libc::O_DIRECTORY, 0)
                    .map_err(source_error)?;
            },
            _ => return Err(denied("Configured directory must have normal components")),
        }
    }
    budget.check()?;
    Ok(dir)
}
fn same_identity(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev() && a.ino() == b.ino()
}
fn same_file(a: &Metadata, b: &Metadata) -> bool {
    same_identity(a, b) && a.is_file() && b.is_file()
        && a.len() == b.len() && a.nlink() == b.nlink()
        && a.mtime() == b.mtime() && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime() && a.ctime_nsec() == b.ctime_nsec()
}
fn private_directory(dir: &File) -> io::Result<()> {
    let metadata = dir.metadata()?;
    // SAFETY: geteuid has no preconditions.
    if !metadata.is_dir() || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "unsafe staging directory"));
    }
    Ok(())
}
fn mkdir_at(parent: &File, name: &str) -> io::Result<()> {
    let name = cstr(OsStr::new(name))?;
    // SAFETY: live directory descriptor and valid C string.
    if unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
fn unlink_at(parent: &File, name: &str, directory: bool) -> io::Result<()> {
    let name = cstr(OsStr::new(name))?;
    let flags = if directory { libc::AT_REMOVEDIR } else { 0 };
    // SAFETY: live directory descriptor, valid C string and unlinkat flags.
    if unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), flags) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

fn publish(parent: &File, pending: &str, final_name: &str) -> io::Result<()> {
    let pending = cstr(OsStr::new(pending))?;
    let final_name = cstr(OsStr::new(final_name))?;
    // SAFETY: live parent fd and valid C strings; RENAME_EXCL atomically refuses
    // every existing destination (including empty directories and symlinks).
    #[cfg(target_os = "macos")]
    let result = unsafe {
        libc::renameatx_np(parent.as_raw_fd(), pending.as_ptr(),
            parent.as_raw_fd(), final_name.as_ptr(), libc::RENAME_EXCL)
    };
    #[cfg(target_os = "linux")]
    // SAFETY: same invariants as the macOS syscall above.
    let result = unsafe {
        libc::renameat2(parent.as_raw_fd(), pending.as_ptr(),
            parent.as_raw_fd(), final_name.as_ptr(), libc::RENAME_NOREPLACE)
    };
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    return Err(io::Error::new(io::ErrorKind::Unsupported, "exclusive rename unavailable"));
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    if result == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
}

/// Removes only this transaction's flat directory through held descriptors.
/// An attacker replacing its pathname cannot redirect cleanup into another tree.
struct Transaction<'a> {
    parent: &'a File,
    dir: File,
    name: String,
    files: Vec<String>,
    committed: bool,
}
impl Drop for Transaction<'_> {
    fn drop(&mut self) {
        if self.committed { return; }
        for name in &self.files {
            let _ = unlink_at(&self.dir, name, false);
        }
        let _ = self.dir.sync_all();
        if let Ok(current) = open_at(self.parent, OsStr::new(&self.name),
            libc::O_RDONLY | libc::O_DIRECTORY, 0)
        {
            if let (Ok(a), Ok(b)) = (current.metadata(), self.dir.metadata()) {
                if same_identity(&a, &b) {
                    let _ = unlink_at(self.parent, &self.name, true);
                    let _ = self.parent.sync_all();
                }
            }
        }
    }
}

fn check_root(path: &Path, original: &File, budget: &Budget<'_>) -> Result<(), HostError> {
    let current = directory(path, budget)?;
    if !same_identity(&original.metadata().map_err(source_error)?,
        &current.metadata().map_err(source_error)?)
    {
        return Err(failed("Source or staging directory changed during the operation"));
    }
    budget.check()
}
fn check_source(root: &File, name: &str, snapshot: &Metadata, budget: &Budget<'_>)
    -> Result<(), HostError>
{
    budget.check()?;
    let file = open_at(root, OsStr::new(name), libc::O_RDONLY, 0).map_err(source_error)?;
    if !same_file(snapshot, &file.metadata().map_err(source_error)?) {
        return Err(failed("Source file changed during the operation"));
    }
    budget.check()
}

/// Read a single byte from every configured sentinel; never writes source data.
/// The caller owns the human-present consent gate and grant-observation state.
pub fn probe(policy: &DocumentsPolicy) -> Result<(), HostError> {
    let mut budget = Budget::new(policy)?;
    if policy.sources.is_empty() || policy.sources.len() > policy.max_items {
        return Err(denied("Sentinel count exceeds Documents policy"));
    }
    for source in policy.sources.values() {
        budget.check()?;
        if !basename(&source.sentinel) {
            return Err(denied("Configured sentinel must be a basename"));
        }
        let root = directory(&source.root, &budget)?;
        let mut file = open_at(&root, OsStr::new(&source.sentinel), libc::O_RDONLY, 0)
            .map_err(source_error)?;
        let snapshot = file.metadata().map_err(source_error)?;
        if !snapshot.is_file() {
            return Err(failed("Configured sentinel is not a regular file"));
        }
        let count = file.read(&mut [0u8; 1]).map_err(source_error)?;
        budget.consume(count as u64)?;
        if !same_file(&snapshot, &file.metadata().map_err(source_error)?) {
            return Err(failed("Sentinel changed during the operation"));
        }
        check_source(&root, &source.sentinel, &snapshot, &budget)?;
        check_root(&source.root, &root, &budget)?;
    }
    budget.check()
}

/// Copy an allowlisted flat set into an unpredictable private transaction, then
/// atomically publish the complete directory without replacing any destination.
/// Regular filesystem syscalls are synchronous; deadlines are checked on both
/// sides of each bounded work step, not implemented with detached worker threads.
pub fn copy(policy: &DocumentsPolicy, staging: &Path, input: &CopyInput,
    cancelled: &dyn Fn() -> bool)
    -> Result<CopyResult, HostError>
{
    let mut budget = Budget::new(policy)?;
    budget.cancelled = cancelled;
    validate_files(&input.files, policy.max_items)?;
    budget.check()?;
    let source = policy.sources.get(&input.source_id)
        .ok_or_else(|| denied("Unknown Documents source"))?;
    let allowed = allowed_names(&source.allowed_basenames, || budget.check())?;
    for name in &input.files {
        budget.check()?;
        if !allowed.contains(name.as_str()) {
            return Err(denied("Requested filename is not allowlisted for this source"));
        }
    }
    let root = directory(&source.root, &budget)?;
    let parent = directory(staging, &budget)?;
    private_directory(&parent).map_err(staging_error)?;
    // Neither the final ID nor the working directory name comes from a request.
    let staging_id = crate::opaque_id().map_err(staging_error)?;
    let pending = format!(".pending-{}", crate::opaque_id().map_err(staging_error)?);
    if !basename(&staging_id) || !basename(&pending) {
        return Err(failed("Unable to allocate a staging identity"));
    }
    budget.check()?;
    mkdir_at(&parent, &pending).map_err(staging_error)?;
    let destination = match open_at(&parent, OsStr::new(&pending),
        libc::O_RDONLY | libc::O_DIRECTORY, 0)
    {
        Ok(dir) => dir,
        Err(error) => {
            let _ = unlink_at(&parent, &pending, true);
            let _ = parent.sync_all();
            return Err(staging_error(error));
        },
    };
    let mut transaction = Transaction {
        parent: &parent, dir: destination, name: pending, files: Vec::new(), committed: false,
    };
    private_directory(&transaction.dir).map_err(staging_error)?;
    let mut result = Vec::with_capacity(input.files.len());
    let mut snapshots = Vec::with_capacity(input.files.len());
    let mut buffer = [0u8; 64 * 1024];
    for name in &input.files {
        budget.check()?;
        let mut file = open_at(&root, OsStr::new(name), libc::O_RDONLY, 0)
            .map_err(source_error)?;
        let snapshot = file.metadata().map_err(source_error)?;
        if !snapshot.is_file() {
            return Err(denied("Only regular source files can be copied"));
        }
        if snapshot.len() > budget.remaining {
            return Err(denied("Documents byte limit exceeded"));
        }
        let mut output = open_at(&transaction.dir, OsStr::new(name),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL, 0o600).map_err(staging_error)?;
        transaction.files.push(name.clone());
        let mut hash = Sha256::new();
        let mut bytes = 0u64;
        loop {
            budget.check()?;
            // At most one extra byte is read to detect growth, even at the cap.
            let read_limit = usize::try_from(snapshot.len().saturating_sub(bytes).saturating_add(1))
                .unwrap_or(usize::MAX).min(buffer.len());
            let count = match file.read(&mut buffer[..read_limit]) {
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                result => result.map_err(source_error)?,
            };
            budget.check()?;
            if count == 0 { break; }
            budget.consume(count as u64)?;
            bytes = bytes.checked_add(count as u64)
                .ok_or_else(|| denied("Documents byte limit exceeded"))?;
            if bytes > snapshot.len() {
                return Err(failed("Source file grew during the operation"));
            }
            // write_all can retry internally; explicitly bound every write step.
            let mut written = 0;
            while written < count {
                budget.check()?;
                match output.write(&buffer[written..count]) {
                    Ok(0) => return Err(failed("Unable to write staging data")),
                    Ok(n) => written += n,
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) => return Err(staging_error(error)),
                }
                budget.check()?;
            }
            hash.update(&buffer[..count]);
        }
        if bytes != snapshot.len() || !same_file(&snapshot, &file.metadata().map_err(source_error)?) {
            return Err(failed("Source file changed during the operation"));
        }
        check_source(&root, name, &snapshot, &budget)?;
        output.sync_all().map_err(staging_error)?;
        budget.check()?;
        result.push(CopiedFile { name: name.clone(), bytes, sha256: hex::encode(hash.finalize()) });
        snapshots.push(snapshot);
    }
    // Recheck earlier files too: a later copy must not hide an earlier mutation.
    for (name, snapshot) in input.files.iter().zip(&snapshots) {
        check_source(&root, name, snapshot, &budget)?;
    }
    check_root(&source.root, &root, &budget)?;
    check_root(staging, &parent, &budget)?;
    transaction.dir.sync_all().map_err(staging_error)?;
    budget.check()?;
    // Ensure the directory to be renamed is still the one we populated.
    let current = open_at(&parent, OsStr::new(&transaction.name),
        libc::O_RDONLY | libc::O_DIRECTORY, 0).map_err(staging_error)?;
    if !same_identity(&current.metadata().map_err(staging_error)?,
        &transaction.dir.metadata().map_err(staging_error)?)
    {
        return Err(failed("Staging directory changed during the operation"));
    }
    budget.check()?;
    publish(&parent, &transaction.name, &staging_id).map_err(staging_error)?;
    transaction.name.clone_from(&staging_id);
    // Publication is the commit point. Keep ownership/exclusion until durability
    // completes; a failed sync removes this transaction rather than returning OK.
    parent.sync_all().map_err(staging_error)?;
    transaction.committed = true;
    Ok(CopyResult { staging_id, files: result })
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn rejects_traversal_nul_and_oversized_names() {
        for name in ["", ".", "..", "../file", "a/b", "/file", "a\0b"] {
            assert!(!basename(name));
        }
        assert!(basename(&"a".repeat(255)));
        assert!(!basename(&"a".repeat(256)));
        assert!(!basename(&"é".repeat(128)));
        assert!(basename(".hidden"));
    }

    #[test]
    fn rejects_duplicate_empty_and_over_limit_sets() {
        assert!(validate_files(&[], 1).is_err());
        assert!(validate_files(&["a".into()], 0).is_err());
        assert!(validate_files(&["a".into(), "a".into()], 2).is_err());
        assert!(validate_files(&["a".into(), "b".into()], 1).is_err());
        assert!(validate_files(&["a".into(), "b".into()], 2).is_ok());
    }

    #[test]
    fn deadline_and_exact_byte_boundary() {
        let mut budget = Budget {
            deadline: Instant::now() + Duration::from_secs(1), remaining: 3, cancelled: &|| false,
        };
        assert!(budget.consume(3).is_ok());
        assert_eq!(budget.remaining, 0);
        assert!(budget.consume(1).is_err());
        let expired = Budget {
            deadline: Instant::now(), remaining: u64::MAX, cancelled: &|| false,
        };
        assert!(expired.check().is_err());
        let cancelled = Budget {
            deadline: Instant::now() + Duration::from_secs(1),
            remaining: u64::MAX, cancelled: &|| true,
        };
        assert!(cancelled.check().is_err());
    }

    fn validation_policy() -> DocumentsPolicy {
        serde_json::from_value(serde_json::json!({
            "sources": {"test": {
                "root": "/unopened/source", "sentinel": "sentinel", "allowedBasenames": ["file"]
            }},
            "maxItems": 1, "maxBytes": 1, "timeoutMs": 1
        })).unwrap()
    }

    #[test]
    fn policy_validation_is_pure_and_checks_roots_sentinels_and_allowlists() {
        let mut policy = validation_policy();
        assert!(validate_policy(&policy).is_ok());
        for root in ["relative", "/source/./child", "/source/../child", "/source\0child"] {
            policy.sources.get_mut("test").unwrap().root = root.into();
            assert!(validate_policy(&policy).is_err());
        }
        policy.sources.get_mut("test").unwrap().root = "/unopened/source".into();
        for sentinel in ["", ".", "..", "../sentinel"] {
            policy.sources.get_mut("test").unwrap().sentinel = sentinel.into();
            assert!(validate_policy(&policy).is_err());
        }
        policy.sources.get_mut("test").unwrap().sentinel = "sentinel".into();
        for names in [vec![], vec!["file", "file"], vec!["../file"]] {
            policy.sources.get_mut("test").unwrap().allowed_basenames =
                names.into_iter().map(str::to_owned).collect();
            assert!(validate_policy(&policy).is_err());
        }
    }

    #[test]
    fn policy_limits_have_exact_finite_boundaries() {
        let mut policy = validation_policy();
        for max_items in [0, 4097, usize::MAX] {
            policy.max_items = max_items;
            assert!(validate_policy(&policy).is_err());
        }
        policy.max_items = 4096;
        for timeout_ms in [0, 300_001, u64::MAX] {
            policy.timeout_ms = timeout_ms;
            assert!(validate_policy(&policy).is_err());
        }
        policy.timeout_ms = 300_000;
        assert!(validate_policy(&policy).is_ok());
        policy.max_bytes = 0;
        assert!(validate_policy(&policy).is_err());
    }

    struct Fixture {
        root: std::path::PathBuf,
        policy: DocumentsPolicy,
    }
    impl Fixture {
        fn new(max_bytes: u64) -> Self {
            use std::os::unix::fs::PermissionsExt;
            let root = std::env::temp_dir().canonicalize().unwrap()
                .join(format!("permissions-documents-{}", crate::opaque_id().unwrap()));
            std::fs::create_dir(&root).unwrap();
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
            for name in ["source", "staging"] {
                std::fs::create_dir(root.join(name)).unwrap();
                std::fs::set_permissions(root.join(name),
                    std::fs::Permissions::from_mode(0o700)).unwrap();
            }
            std::fs::write(root.join("source/sentinel"), b"probe").unwrap();
            let policy = serde_json::from_value(serde_json::json!({
                "sources": {"test": {
                    "root": root.join("source"), "sentinel": "sentinel",
                    "allowedBasenames": ["file", "a", "b", "missing", "link", "directory", "fifo", "sentinel"]
                }},
                "maxItems": 4, "maxBytes": max_bytes, "timeoutMs": 5000
            })).unwrap();
            Self { root, policy }
        }
        fn copy(&self, names: &[&str]) -> Result<CopyResult, HostError> {
            copy(&self.policy, &self.root.join("staging"), &CopyInput {
                source_id: "test".into(),
                files: names.iter().map(|name| (*name).into()).collect(),
            }, &|| false)
        }
        fn staging_empty(&self) -> bool {
            std::fs::read_dir(self.root.join("staging")).unwrap().next().is_none()
        }
    }

    #[test]
    fn cancellation_after_transaction_creation_cleans_unpublished_work() {
        let fixture = Fixture::new(100);
        std::fs::write(fixture.root.join("source/file"), b"abc").unwrap();
        let input = CopyInput { source_id: "test".into(), files: vec!["file".into()] };
        let cancelled = || !fixture.staging_empty();
        assert!(copy(&fixture.policy, &fixture.root.join("staging"), &input, &cancelled).is_err());
        assert!(fixture.staging_empty());
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn complete_copy_has_hash_and_private_files() {
        let fixture = Fixture::new(3);
        std::fs::write(fixture.root.join("source/file"), b"abc").unwrap();
        let result = fixture.copy(&["file"]).unwrap();
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].bytes, 3);
        assert_eq!(result.files[0].sha256,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        let staged = fixture.root.join("staging").join(result.staging_id).join("file");
        assert_eq!(std::fs::read(&staged).unwrap(), b"abc");
        assert_eq!(std::fs::metadata(staged).unwrap().mode() & 0o077, 0);
    }

    #[test]
    fn later_failure_and_aggregate_limit_leave_no_transaction() {
        let fixture = Fixture::new(5);
        std::fs::write(fixture.root.join("source/a"), b"abc").unwrap();
        std::fs::write(fixture.root.join("source/b"), b"def").unwrap();
        assert!(fixture.copy(&["a", "missing"]).is_err());
        assert!(fixture.staging_empty());
        assert!(fixture.copy(&["a", "b"]).is_err());
        assert!(fixture.staging_empty());
        assert!(fixture.copy(&["a", "a"]).is_err());
        assert!(fixture.staging_empty());
    }

    #[test]
    fn unallowlisted_existing_file_is_denied_before_staging() {
        let fixture = Fixture::new(100);
        std::fs::write(fixture.root.join("source/not-allowed"), b"private").unwrap();
        assert!(fixture.copy(&["not-allowed"]).is_err());
        assert!(fixture.staging_empty());
    }

    #[test]
    fn empty_duplicate_and_invalid_filename_policies_are_denied() {
        let mut fixture = Fixture::new(100);
        for names in [vec![], vec!["file", "file"], vec!["../file"], vec![""]] {
            fixture.policy.sources.get_mut("test").unwrap().allowed_basenames =
                names.into_iter().map(str::to_owned).collect();
            assert!(fixture.copy(&["file"]).is_err());
            assert!(fixture.staging_empty());
        }
    }

    #[test]
    fn symlinks_and_nonregular_sources_are_refused() {
        use std::os::unix::fs::symlink;
        let mut fixture = Fixture::new(100);
        symlink("sentinel", fixture.root.join("source/link")).unwrap();
        std::fs::create_dir(fixture.root.join("source/directory")).unwrap();
        let fifo = cstr(fixture.root.join("source/fifo").as_os_str()).unwrap();
        // SAFETY: valid C string in this test's exclusively owned directory.
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        for name in ["link", "directory", "fifo"] {
            assert!(fixture.copy(&[name]).is_err());
            assert!(fixture.staging_empty());
        }
        symlink("source", fixture.root.join("linked-root")).unwrap();
        fixture.policy.sources.get_mut("test").unwrap().root = fixture.root.join("linked-root");
        assert!(fixture.copy(&["sentinel"]).is_err());
        assert!(fixture.staging_empty());
        assert!(probe(&fixture.policy).is_err());
    }

    #[test]
    fn publication_never_overwrites_existing_directory() {
        let fixture = Fixture::new(100);
        let budget = Budget::new(&fixture.policy).unwrap();
        let staging = directory(&fixture.root.join("staging"), &budget).unwrap();
        mkdir_at(&staging, ".pending-test").unwrap();
        mkdir_at(&staging, "existing").unwrap();
        std::fs::write(fixture.root.join("staging/existing/retained"), b"original").unwrap();
        assert!(publish(&staging, ".pending-test", "existing").is_err());
        assert_eq!(std::fs::read(fixture.root.join("staging/existing/retained")).unwrap(),
            b"original");
        assert!(fixture.root.join("staging/.pending-test").is_dir());
    }

    #[test]
    fn probe_only_reads_and_source_mutation_is_detected() {
        let fixture = Fixture::new(100);
        assert!(probe(&fixture.policy).is_ok());
        assert!(fixture.staging_empty());
        assert_eq!(std::fs::read(fixture.root.join("source/sentinel")).unwrap(), b"probe");
        let budget = Budget::new(&fixture.policy).unwrap();
        let root = directory(&fixture.root.join("source"), &budget).unwrap();
        let original = open_at(&root, OsStr::new("sentinel"), libc::O_RDONLY, 0).unwrap();
        let snapshot = original.metadata().unwrap();
        std::fs::write(fixture.root.join("source/sentinel"), b"changed length").unwrap();
        assert!(check_source(&root, "sentinel", &snapshot, &budget).is_err());
    }

    proptest! {
        #[test]
        fn policy_source_id_contract_is_exact(id in any::<String>()) {
            let expected = !id.is_empty() && id.len() <= 128
                && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'));
            let mut policy = validation_policy();
            let source = policy.sources.remove("test").unwrap();
            policy.sources.insert(id, source);
            prop_assert_eq!(validate_policy(&policy).is_ok(), expected);
        }

        #[test]
        fn accepted_names_are_exactly_one_normal_component(name in any::<String>()) {
            if basename(&name) {
                let mut parts = Path::new(&name).components();
                prop_assert!(matches!(parts.next(), Some(Component::Normal(_))));
                prop_assert!(parts.next().is_none());
                prop_assert!(name.len() <= 255);
                prop_assert!(!name.as_bytes().contains(&0));
            }
        }

        #[test]
        fn byte_accounting_never_wraps(limit in any::<u64>(), bytes in any::<u64>()) {
            let mut budget = Budget {
                deadline: Instant::now() + Duration::from_secs(60), remaining: limit,
                cancelled: &|| false,
            };
            let result = budget.consume(bytes);
            prop_assert_eq!(result.is_ok(), bytes <= limit);
            if result.is_ok() {
                prop_assert_eq!(budget.remaining, limit - bytes);
            } else {
                prop_assert_eq!(budget.remaining, limit);
            }
        }

        #[test]
        fn request_item_cap_is_exact(count in 1usize..100, cap in 0usize..100) {
            let names: Vec<_> = (0..count).map(|n| format!("file-{n}")).collect();
            prop_assert_eq!(validate_files(&names, cap).is_ok(), count <= cap);
        }
    }
}
