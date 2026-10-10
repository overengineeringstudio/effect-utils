//! Canonical editor-view tree fingerprints. Framing is `effect-utils/tree-digest/v1`.
//! Instability errors include changed-field names and full before/after metadata;
//! Read-only shared files tolerate link-count ctime churn, but still prove bytes,
//! inode identity, modification time, size, and unchanged permissions.
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::ffi::OsString;
use std::fs::{self, File, Metadata};
use std::io::{self, Read};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::{Path, PathBuf};

const SCHEMA: &[u8] = b"effect-utils/tree-digest/v1\0";
const LINKS_SCHEMA: &[u8] = b"effect-utils/editor-view-link-inventory/v1";

#[derive(Clone, Debug)]
pub struct LinkOwner {
    pub source: PathBuf,
    pub identity: String,
}

#[derive(Debug)]
pub struct Fingerprints {
    pub digest: String,
    pub resolved_links_digest: Option<String>,
    pub literal_links_digest: Option<String>,
}

fn fail(message: impl std::fmt::Display) -> io::Error {
    io::Error::other(format!("editor view: {message}"))
}

fn frame(hash: &mut Sha256, value: &[u8]) {
    hash.update((value.len() as u64).to_be_bytes());
    hash.update(value);
}

fn hex(hash: Sha256) -> String {
    hash.finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn relative(root: &Path, path: &Path) -> Vec<u8> {
    let root = root.components().collect::<Vec<_>>();
    let path = path.components().collect::<Vec<_>>();
    let shared = root.iter().zip(&path).take_while(|(a, b)| a == b).count();
    let mut parts = vec![b"..".to_vec(); root.len() - shared];
    parts.extend(
        path[shared..]
            .iter()
            .map(|part| part.as_os_str().as_bytes().to_vec()),
    );
    parts.join(&b"/"[..])
}

fn inside(root: &Path, path: &Path) -> bool {
    path.starts_with(root)
}

fn sorted_names(directory: &Path) -> io::Result<Vec<OsString>> {
    let mut names = fs::read_dir(directory)?
        .map(|entry| entry.map(|entry| entry.file_name()))
        .collect::<io::Result<Vec<_>>>()?;
    names.sort_unstable_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    Ok(names)
}

fn same(before: &Metadata, after: &Metadata, file: bool) -> bool {
    // Publishers can add/remove other snapshot hardlinks while this inode is
    // hashed. That changes ctime without modifying immutable shared bytes.
    let immutable_shared_file = file
        && before.mode() & 0o222 == 0
        && before.mode() == after.mode()
        && (before.nlink() > 1 || after.nlink() > 1);
    before.file_type() == after.file_type()
        && before.dev() == after.dev()
        && before.ino() == after.ino()
        && before.mtime() == after.mtime()
        && before.mtime_nsec() == after.mtime_nsec()
        && ((before.ctime() == after.ctime() && before.ctime_nsec() == after.ctime_nsec())
            || immutable_shared_file)
        && (!file || (before.size() == after.size() && before.mode() == after.mode()))
}

fn entry_type(metadata: &Metadata) -> &'static str {
    let kind = metadata.file_type();
    if kind.is_file() {
        "file"
    } else if kind.is_dir() {
        "directory"
    } else if kind.is_symlink() {
        "symlink"
    } else if kind.is_block_device() {
        "block-device"
    } else if kind.is_char_device() {
        "character-device"
    } else if kind.is_fifo() {
        "fifo"
    } else if kind.is_socket() {
        "socket"
    } else {
        "unknown"
    }
}

fn metadata_snapshot(metadata: &Metadata) -> String {
    format!(
        "{{type={}, dev={}, ino={}, mtime=({}, {}), ctime=({}, {}), size={}, mode={:#o}, nlink={}}}",
        entry_type(metadata),
        metadata.dev(),
        metadata.ino(),
        metadata.mtime(),
        metadata.mtime_nsec(),
        metadata.ctime(),
        metadata.ctime_nsec(),
        metadata.size(),
        metadata.mode(),
        metadata.nlink(),
    )
}

fn changed_metadata_fields(before: &Metadata, after: &Metadata) -> String {
    let mut changed = String::new();
    for (field, differs) in [
        ("type", before.file_type() != after.file_type()),
        ("dev", before.dev() != after.dev()),
        ("ino", before.ino() != after.ino()),
        (
            "mtime",
            (before.mtime(), before.mtime_nsec()) != (after.mtime(), after.mtime_nsec()),
        ),
        (
            "ctime",
            (before.ctime(), before.ctime_nsec()) != (after.ctime(), after.ctime_nsec()),
        ),
        ("size", before.size() != after.size()),
        ("mode", before.mode() != after.mode()),
        ("nlink", before.nlink() != after.nlink()),
    ] {
        if differs {
            if !changed.is_empty() {
                changed.push_str(", ");
            }
            changed.push_str(field);
        }
    }
    changed
}

// Only called after the existing stability checks fail. Include observational
// fields such as mode/nlink without adding them to the acceptance predicate.
fn tree_changed(
    path: &Path,
    before: &Metadata,
    after: Result<&Metadata, &io::Error>,
    targets: Option<(&Path, &Path)>,
) -> io::Error {
    let (mut changed, after) = match after {
        Ok(after) => (
            changed_metadata_fields(before, after),
            metadata_snapshot(after),
        ),
        Err(error) => ("unknown".to_owned(), format!("unavailable ({error})")),
    };
    if targets.is_some_and(|(before, after)| before != after) {
        if !changed.is_empty() {
            changed.push_str(", ");
        }
        changed.push_str("target");
    }
    let mut message = format!(
        "tree changed while hashing: {}; changed=[{changed}]; before={}; after={}",
        path.display(),
        metadata_snapshot(before),
        after,
    );
    if let Some((before, after)) = targets {
        message.push_str(&format!("; target before={before:?}, after={after:?}"));
    }
    fail(message)
}

struct Walker {
    root: PathBuf,
    backing: Vec<PathBuf>,
    owners: Vec<LinkOwner>,
    dereference: bool,
    hash: Sha256,
    resolved: Option<Sha256>,
    links: Vec<(Vec<u8>, Vec<u8>)>,
    ancestors: HashSet<(u64, u64)>,
    buffer: Box<[u8; 131072]>,
}

impl Walker {
    fn visit(&mut self, path: &Path, name: &[u8]) -> io::Result<()> {
        let before = fs::symlink_metadata(path)?;
        if before.file_type().is_symlink() && self.dereference {
            let target = fs::read_link(path)?;
            let resolved = fs::canonicalize(path).map_err(|error| {
                fail(format!(
                    "tree contains an unresolvable symbolic link: {} ({error})",
                    path.display()
                ))
            })?;
            if !inside(&self.root, &resolved)
                && !self.backing.iter().any(|root| inside(root, &resolved))
            {
                return Err(fail(format!(
                    "tree symbolic link resolves outside declared backing roots: {} -> {}",
                    path.display(),
                    resolved.display()
                )));
            }
            self.visit(&resolved, name)?;
            let after = fs::symlink_metadata(path)?;
            if !same(&before, &after, false) {
                let target_after = fs::read_link(path).ok();
                return Err(tree_changed(
                    path,
                    &before,
                    Ok(&after),
                    target_after
                        .as_deref()
                        .map(|after| (target.as_path(), after)),
                ));
            }
            let target_after = fs::read_link(path)?;
            if target_after != target {
                return Err(tree_changed(
                    path,
                    &before,
                    Ok(&after),
                    Some((&target, &target_after)),
                ));
            }
            return Ok(());
        }
        if before.is_dir() {
            let id = (before.dev(), before.ino());
            if !self.ancestors.insert(id) {
                return Err(fail(format!(
                    "tree contains a dereference cycle: {}",
                    path.display()
                )));
            }
            self.hash.update(b"D");
            frame(&mut self.hash, name);
            if let Some(hash) = &mut self.resolved {
                hash.update(b"D");
                frame(hash, name);
            }
            for child in sorted_names(path)? {
                let child_name = if name.is_empty() {
                    child.as_bytes().to_vec()
                } else {
                    let mut value = Vec::with_capacity(name.len() + 1 + child.len());
                    value.extend_from_slice(name);
                    value.push(b'/');
                    value.extend_from_slice(child.as_bytes());
                    value
                };
                self.visit(&path.join(&child), &child_name)?;
            }
            self.ancestors.remove(&id);
        } else if before.file_type().is_symlink() {
            let target = fs::read_link(path)?;
            let target_bytes = target.as_os_str().as_bytes();
            self.hash.update(b"L");
            frame(&mut self.hash, name);
            frame(&mut self.hash, target_bytes);
            if let Some(hash) = &mut self.resolved {
                self.links.push((name.to_vec(), target_bytes.to_vec()));
                let resolved = fs::canonicalize(path)?;
                let owner = self
                    .owners
                    .iter()
                    .find(|owner| inside(&owner.source, &resolved))
                    .ok_or_else(|| {
                        fail(format!(
                            "tree symbolic link resolves outside declared roots: {} -> {}",
                            path.display(),
                            resolved.display()
                        ))
                    })?;
                hash.update(b"L");
                frame(hash, name);
                frame(hash, owner.identity.as_bytes());
                frame(hash, &relative(&owner.source, &resolved));
            }
            let target_after = fs::read_link(path)?;
            if target_after != target {
                let after = fs::symlink_metadata(path);
                return Err(tree_changed(
                    path,
                    &before,
                    after.as_ref(),
                    Some((&target, &target_after)),
                ));
            }
        } else if before.is_file() {
            self.hash.update(b"F");
            frame(&mut self.hash, name);
            self.hash.update(before.size().to_be_bytes());
            if let Some(hash) = &mut self.resolved {
                hash.update(b"F");
                frame(hash, name);
                hash.update(before.size().to_be_bytes());
            }
            let mut file = File::open(path)?;
            loop {
                let size = file.read(&mut *self.buffer)?;
                if size == 0 {
                    break;
                }
                self.hash.update(&self.buffer[..size]);
                if let Some(hash) = &mut self.resolved {
                    hash.update(&self.buffer[..size]);
                }
            }
        } else {
            return Err(fail(format!(
                "tree contains unsupported special file: {}",
                path.display()
            )));
        }
        let after = fs::symlink_metadata(path)?;
        if !same(&before, &after, before.is_file()) {
            return Err(tree_changed(path, &before, Ok(&after), None));
        }
        Ok(())
    }
}

fn real_directory(path: &Path, label: &str) -> io::Result<PathBuf> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(fail(format!(
            "{label} must be a real directory: {}",
            path.display()
        )));
    }
    fs::canonicalize(path)
}

pub fn fingerprint(
    tree: &Path,
    dereference: bool,
    backing_roots: &[PathBuf],
    link_owners: &[LinkOwner],
) -> io::Result<Fingerprints> {
    let root = real_directory(tree, "tree input")?;
    let backing = backing_roots
        .iter()
        .map(|root| real_directory(root, "declared backing root"))
        .collect::<io::Result<Vec<_>>>()?;
    let owners = link_owners
        .iter()
        .map(|owner| {
            Ok(LinkOwner {
                source: fs::canonicalize(&owner.source)?,
                identity: owner.identity.clone(),
            })
        })
        .collect::<io::Result<Vec<_>>>()?;
    let mut hash = Sha256::new();
    hash.update(SCHEMA);
    let resolved = if owners.is_empty() || dereference {
        None
    } else {
        let mut hash = Sha256::new();
        hash.update(SCHEMA);
        Some(hash)
    };
    let before = fs::symlink_metadata(tree)?;
    let mut walker = Walker {
        root,
        backing,
        owners,
        dereference,
        hash,
        resolved,
        links: Vec::new(),
        ancestors: HashSet::from([(before.dev(), before.ino())]),
        buffer: Box::new([0; 131072]),
    };
    for name in sorted_names(tree)? {
        walker.visit(&tree.join(&name), name.as_bytes())?;
    }
    let after = fs::symlink_metadata(tree)?;
    if !same(&before, &after, false) {
        return Err(tree_changed(tree, &before, Ok(&after), None));
    }
    let literal_links_digest = walker.resolved.as_ref().map(|_| {
        walker.links.sort_unstable_by(|a, b| a.0.cmp(&b.0));
        let mut hash = Sha256::new();
        hash.update(LINKS_SCHEMA);
        for (path, target) in &walker.links {
            frame(&mut hash, path);
            frame(&mut hash, target);
        }
        hex(hash)
    });
    Ok(Fingerprints {
        digest: hex(walker.hash),
        resolved_links_digest: walker.resolved.map(hex),
        literal_links_digest,
    })
}

// TypeScript action runners use a distinct, mode-sensitive root identity.
// Preserve their original u32-framed hashTree contract while moving the walk
// and byte streaming into this one native executable.
fn frame_input_text(hash: &mut Sha256, value: &str) {
    hash.update((value.len() as u32).to_be_bytes());
    hash.update(value.as_bytes());
}

fn sorted_input_names(directory: &Path) -> io::Result<Vec<OsString>> {
    let mut names = fs::read_dir(directory)?
        .map(|entry| entry.map(|entry| entry.file_name()))
        .collect::<io::Result<Vec<_>>>()?;
    // `readdir(path).toSorted()` uses JavaScript's UTF-16 code-unit order,
    // unlike the editor-view protocol's UTF-8 byte order.
    names.sort_unstable_by(|a, b| {
        a.to_string_lossy()
            .encode_utf16()
            .cmp(b.to_string_lossy().encode_utf16())
    });
    Ok(names)
}

fn visit_input(root: &Path, path: &Path, hash: &mut Sha256, buffer: &mut [u8]) -> io::Result<()> {
    let before = fs::symlink_metadata(path)?;
    let relative = path.strip_prefix(root).map_err(fail)?;
    let entry = if relative.as_os_str().is_empty() {
        "."
    } else {
        relative
            .to_str()
            .ok_or_else(|| fail("input path must be UTF-8"))?
    };
    frame_input_text(hash, entry);
    frame_input_text(hash, &(before.mode() & 0o7777).to_string());
    if before.is_dir() {
        frame_input_text(hash, "directory");
        for child in sorted_input_names(path)? {
            visit_input(root, &path.join(child), hash, buffer)?;
        }
    } else if before.file_type().is_symlink() {
        frame_input_text(hash, "symlink");
        let target = fs::read_link(path)?;
        frame_input_text(
            hash,
            target
                .to_str()
                .ok_or_else(|| fail("link target must be UTF-8"))?,
        );
    } else if before.is_file() {
        frame_input_text(hash, "file");
        let mut file = File::open(path)?;
        loop {
            let size = file.read(buffer)?;
            if size == 0 {
                break;
            }
            hash.update(&buffer[..size]);
        }
    } else {
        return Err(fail(format!(
            "unsupported filesystem entry while hashing: {}",
            path.display()
        )));
    }
    Ok(())
}

pub fn fingerprint_input_root(root: &Path) -> io::Result<String> {
    let mut hash = Sha256::new();
    let mut buffer = Box::new([0u8; 131072]);
    visit_input(root, root, &mut hash, &mut *buffer)?;
    Ok(hex(hash))
}

#[cfg(test)]
mod tests {
    use super::{same, tree_changed};
    use std::fs::{self, File, FileTimes, Metadata, Permissions};
    use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
    use std::path::Path;
    use std::time::{Duration, SystemTime};

    fn diagnostic(path: &Path, before: &Metadata, after: &Metadata) -> String {
        let error = tree_changed(path, before, Ok(after), None);
        assert_eq!(error.kind(), std::io::ErrorKind::Other);
        let message = error.to_string();
        assert!(
            message.starts_with(&format!(
                "editor view: tree changed while hashing: {};",
                path.display()
            )),
            "{message}"
        );
        for (label, metadata) in [("before", before), ("after", after)] {
            // Assert every snapshot value independently of the formatter.
            let snapshot = message
                .split(&format!("; {label}="))
                .nth(1)
                .unwrap()
                .split('}')
                .next()
                .unwrap();
            for expected in [
                format!("dev={}", metadata.dev()),
                format!("ino={}", metadata.ino()),
                format!("mtime=({}, {})", metadata.mtime(), metadata.mtime_nsec()),
                format!("ctime=({}, {})", metadata.ctime(), metadata.ctime_nsec()),
                format!("size={}", metadata.size()),
                format!("mode={:#o}", metadata.mode()),
                format!("nlink={}", metadata.nlink()),
            ] {
                assert!(
                    snapshot.contains(&expected),
                    "{message}: missing {expected}"
                );
            }
        }
        message
    }

    fn changed_fields(message: &str) -> Vec<&str> {
        message
            .split("; changed=[")
            .nth(1)
            .unwrap()
            .split(']')
            .next()
            .unwrap()
            .split(", ")
            .collect()
    }

    #[test]
    fn immutable_shared_files_allow_hardlink_lifetime_changes() {
        let scratch = tempfile::tempdir().unwrap();
        let path = scratch.path().join("blob");
        let first = scratch.path().join("first-snapshot");
        let second = scratch.path().join("second-snapshot");
        fs::write(&path, b"immutable shared content").unwrap();
        fs::set_permissions(&path, Permissions::from_mode(0o444)).unwrap();
        fs::hard_link(&path, &first).unwrap();
        let before = fs::symlink_metadata(&first).unwrap();
        fs::hard_link(&path, &second).unwrap();
        let linked = fs::symlink_metadata(&first).unwrap();
        assert_ne!(before.nlink(), linked.nlink());
        assert!(same(&before, &linked, true));
        fs::remove_file(&second).unwrap();
        let unlinked = fs::symlink_metadata(&first).unwrap();
        assert!(same(&before, &unlinked, true));
        fs::set_permissions(&path, Permissions::from_mode(0o644)).unwrap();
        assert!(!same(&before, &fs::symlink_metadata(&first).unwrap(), true));
    }

    #[test]
    fn instability_diagnostic_reports_chmod_without_replacement() {
        let scratch = tempfile::tempdir().unwrap();
        let path = scratch.path().join("chmod");
        fs::write(&path, b"same content").unwrap();
        fs::set_permissions(&path, Permissions::from_mode(0o640)).unwrap();
        let before = fs::symlink_metadata(&path).unwrap();
        fs::set_permissions(&path, Permissions::from_mode(0o600)).unwrap();
        let after = fs::symlink_metadata(&path).unwrap();

        let message = diagnostic(&path, &before, &after);
        let fields = changed_fields(&message);
        assert!(fields.contains(&"mode"), "{message}");
        for unchanged in ["type", "dev", "ino", "size", "nlink", "mtime"] {
            assert!(!fields.contains(&unchanged), "{message}");
        }
        assert!(message.contains("before={type=file"), "{message}");
        assert!(message.contains("after={type=file"), "{message}");
        assert!(message.contains("mode=0o100640"), "{message}");
        assert!(message.contains("mode=0o100600"), "{message}");
    }

    #[test]
    fn instability_diagnostic_reports_resize_and_timestamp_values() {
        let scratch = tempfile::tempdir().unwrap();
        let path = scratch.path().join("resize");
        let file = File::create(&path).unwrap();
        file.set_len(3).unwrap();
        file.set_times(
            FileTimes::new().set_modified(SystemTime::UNIX_EPOCH + Duration::new(10, 111)),
        )
        .unwrap();
        let before = fs::symlink_metadata(&path).unwrap();
        file.set_len(17).unwrap();
        file.set_times(
            FileTimes::new().set_modified(SystemTime::UNIX_EPOCH + Duration::new(20, 222)),
        )
        .unwrap();
        let after = fs::symlink_metadata(&path).unwrap();

        assert!(!same(&before, &after, true));
        let message = diagnostic(&path, &before, &after);
        let fields = changed_fields(&message);
        assert!(fields.contains(&"size"), "{message}");
        assert!(fields.contains(&"mtime"), "{message}");
        assert!(!fields.contains(&"ino"), "{message}");
        assert!(message.contains("size=3"), "{message}");
        assert!(message.contains("size=17"), "{message}");
    }

    #[test]
    fn instability_diagnostic_reports_same_size_inode_replacement() {
        let scratch = tempfile::tempdir().unwrap();
        let path = scratch.path().join("original");
        let replacement = scratch.path().join("replacement");
        fs::write(&path, b"first").unwrap();
        fs::write(&replacement, b"other").unwrap();
        let before = fs::symlink_metadata(&path).unwrap();
        fs::rename(&replacement, &path).unwrap();
        let after = fs::symlink_metadata(&path).unwrap();

        assert!(!same(&before, &after, true));
        let message = diagnostic(&path, &before, &after);
        let fields = changed_fields(&message);
        assert!(fields.contains(&"ino"), "{message}");
        assert!(!fields.contains(&"size"), "{message}");
        assert!(!fields.contains(&"type"), "{message}");
        assert!(message.contains("before={type=file"), "{message}");
        assert!(message.contains("after={type=file"), "{message}");
    }

    #[test]
    fn instability_diagnostic_reports_directory_replaced_by_symlink() {
        let scratch = tempfile::tempdir().unwrap();
        let path = scratch.path().join("entry");
        fs::create_dir(&path).unwrap();
        let before = fs::symlink_metadata(&path).unwrap();
        fs::rename(&path, scratch.path().join("retained-directory")).unwrap();
        symlink("target", &path).unwrap();
        let after = fs::symlink_metadata(&path).unwrap();

        assert!(!same(&before, &after, false));
        let message = diagnostic(&path, &before, &after);
        let fields = changed_fields(&message);
        for changed in ["type", "ino", "mode"] {
            assert!(fields.contains(&changed), "{message}");
        }
        assert!(message.contains("before={type=directory"), "{message}");
        assert!(message.contains("after={type=symlink"), "{message}");
    }

    #[test]
    fn instability_diagnostic_reports_link_count_context() {
        let scratch = tempfile::tempdir().unwrap();
        let path = scratch.path().join("original");
        fs::write(&path, b"content").unwrap();
        let before = fs::symlink_metadata(&path).unwrap();
        fs::hard_link(&path, scratch.path().join("hard-link")).unwrap();
        let after = fs::symlink_metadata(&path).unwrap();

        let message = diagnostic(&path, &before, &after);
        let fields = changed_fields(&message);
        assert!(fields.contains(&"nlink"), "{message}");
        assert!(!fields.contains(&"ino"), "{message}");
        assert_eq!(after.nlink(), before.nlink() + 1);
    }

    #[test]
    fn instability_diagnostic_reports_target_only_change() {
        let scratch = tempfile::tempdir().unwrap();
        let path = scratch.path().join("link");
        symlink("old-target", &path).unwrap();
        let metadata = fs::symlink_metadata(&path).unwrap();
        assert!(same(&metadata, &metadata, false));

        // Reuse one real metadata snapshot to deterministically exercise the
        // target-only branch without relying on racing a filesystem walk.
        let message = tree_changed(
            &path,
            &metadata,
            Ok(&metadata),
            Some((Path::new("old-target"), Path::new("new-target"))),
        )
        .to_string();
        assert!(message.contains("changed=[target]"), "{message}");
        assert!(message.contains("before={type=symlink"), "{message}");
        assert!(message.contains("after={type=symlink"), "{message}");
        assert!(
            message.contains("target before=\"old-target\", after=\"new-target\""),
            "{message}"
        );
    }

    #[test]
    fn instability_diagnostic_preserves_target_change_when_entry_disappears() {
        let scratch = tempfile::tempdir().unwrap();
        let path = scratch.path().join("link");
        symlink("old-target", &path).unwrap();
        let before = fs::symlink_metadata(&path).unwrap();
        fs::remove_file(&path).unwrap();
        let after = fs::symlink_metadata(&path);

        let message = tree_changed(
            &path,
            &before,
            after.as_ref(),
            Some((Path::new("old-target"), Path::new("new-target"))),
        )
        .to_string();
        assert!(message.contains("tree changed while hashing:"), "{message}");
        assert!(message.contains("changed=[unknown, target]"), "{message}");
        assert!(message.contains("before={type=symlink"), "{message}");
        assert!(message.contains("after=unavailable ("), "{message}");
        assert!(
            message.contains("target before=\"old-target\", after=\"new-target\""),
            "{message}"
        );
    }
}
