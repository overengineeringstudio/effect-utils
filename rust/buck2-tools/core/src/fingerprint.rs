//! Canonical editor-view tree fingerprints. Framing is `effect-utils/tree-digest/v1`.
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::ffi::OsString;
use std::fs::{self, File, Metadata};
use std::io::{self, Read};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
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
    hash.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}

fn relative(root: &Path, path: &Path) -> Vec<u8> {
    let root = root.components().collect::<Vec<_>>();
    let path = path.components().collect::<Vec<_>>();
    let shared = root.iter().zip(&path).take_while(|(a, b)| a == b).count();
    let mut parts = vec![b"..".to_vec(); root.len() - shared];
    parts.extend(path[shared..].iter().map(|part| part.as_os_str().as_bytes().to_vec()));
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
    before.file_type() == after.file_type()
        && before.dev() == after.dev()
        && before.ino() == after.ino()
        && before.mtime() == after.mtime()
        && before.mtime_nsec() == after.mtime_nsec()
        && before.ctime() == after.ctime()
        && before.ctime_nsec() == after.ctime_nsec()
        && (!file || before.size() == after.size())
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
            let resolved = fs::canonicalize(path).map_err(|error| fail(format!(
                "tree contains an unresolvable symbolic link: {} ({error})", path.display()
            )))?;
            if !inside(&self.root, &resolved) && !self.backing.iter().any(|root| inside(root, &resolved)) {
                return Err(fail(format!("tree symbolic link resolves outside declared backing roots: {} -> {}", path.display(), resolved.display())));
            }
            self.visit(&resolved, name)?;
            if !same(&before, &fs::symlink_metadata(path)?, false) || fs::read_link(path)? != target {
                return Err(fail(format!("tree changed while hashing: {}", path.display())));
            }
            return Ok(());
        }
        if before.is_dir() {
            let id = (before.dev(), before.ino());
            if !self.ancestors.insert(id) {
                return Err(fail(format!("tree contains a dereference cycle: {}", path.display())));
            }
            self.hash.update(b"D");
            frame(&mut self.hash, name);
            if let Some(hash) = &mut self.resolved {
                hash.update(b"D");
                frame(hash, name);
            }
            for child in sorted_names(path)? {
                let child_name = if name.is_empty() { child.as_bytes().to_vec() } else {
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
                let owner = self.owners.iter().find(|owner| inside(&owner.source, &resolved))
                    .ok_or_else(|| fail(format!("tree symbolic link resolves outside declared roots: {} -> {}", path.display(), resolved.display())))?;
                hash.update(b"L");
                frame(hash, name);
                frame(hash, owner.identity.as_bytes());
                frame(hash, &relative(&owner.source, &resolved));
            }
            if fs::read_link(path)? != target {
                return Err(fail(format!("tree changed while hashing: {}", path.display())));
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
                if size == 0 { break; }
                self.hash.update(&self.buffer[..size]);
                if let Some(hash) = &mut self.resolved { hash.update(&self.buffer[..size]); }
            }
        } else {
            return Err(fail(format!("tree contains unsupported special file: {}", path.display())));
        }
        if !same(&before, &fs::symlink_metadata(path)?, before.is_file()) {
            return Err(fail(format!("tree changed while hashing: {}", path.display())));
        }
        Ok(())
    }
}

fn real_directory(path: &Path, label: &str) -> io::Result<PathBuf> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(fail(format!("{label} must be a real directory: {}", path.display())));
    }
    fs::canonicalize(path)
}

pub fn fingerprint(tree: &Path, dereference: bool, backing_roots: &[PathBuf], link_owners: &[LinkOwner]) -> io::Result<Fingerprints> {
    let root = real_directory(tree, "tree input")?;
    let backing = backing_roots.iter().map(|root| real_directory(root, "declared backing root"))
        .collect::<io::Result<Vec<_>>>()?;
    let owners = link_owners.iter().map(|owner| Ok(LinkOwner {
        source: fs::canonicalize(&owner.source)?, identity: owner.identity.clone(),
    })).collect::<io::Result<Vec<_>>>()?;
    let mut hash = Sha256::new();
    hash.update(SCHEMA);
    let resolved = if owners.is_empty() || dereference { None } else {
        let mut hash = Sha256::new(); hash.update(SCHEMA); Some(hash)
    };
    let before = fs::symlink_metadata(tree)?;
    let mut walker = Walker {
        root, backing, owners, dereference, hash, resolved, links: Vec::new(),
        ancestors: HashSet::from([(before.dev(), before.ino())]), buffer: Box::new([0; 131072]),
    };
    for name in sorted_names(tree)? {
        walker.visit(&tree.join(&name), name.as_bytes())?;
    }
    if !same(&before, &fs::symlink_metadata(tree)?, false) {
        return Err(fail(format!("tree changed while hashing: {}", tree.display())));
    }
    let literal_links_digest = walker.resolved.as_ref().map(|_| {
        walker.links.sort_unstable_by(|a, b| a.0.cmp(&b.0));
        let mut hash = Sha256::new(); hash.update(LINKS_SCHEMA);
        for (path, target) in &walker.links { frame(&mut hash, path); frame(&mut hash, target); }
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
    names.sort_unstable_by(|a, b| a.to_string_lossy().encode_utf16().cmp(b.to_string_lossy().encode_utf16()));
    Ok(names)
}

fn visit_input(root: &Path, path: &Path, hash: &mut Sha256, buffer: &mut [u8]) -> io::Result<()> {
    let before = fs::symlink_metadata(path)?;
    let relative = path.strip_prefix(root).map_err(fail)?;
    let entry = if relative.as_os_str().is_empty() { "." } else {
        relative.to_str().ok_or_else(|| fail("input path must be UTF-8"))?
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
        frame_input_text(hash, target.to_str().ok_or_else(|| fail("link target must be UTF-8"))?);
    } else if before.is_file() {
        frame_input_text(hash, "file");
        let mut file = File::open(path)?;
        loop {
            let size = file.read(buffer)?;
            if size == 0 { break; }
            hash.update(&buffer[..size]);
        }
    } else {
        return Err(fail(format!("unsupported filesystem entry while hashing: {}", path.display())));
    }
    Ok(())
}

pub fn fingerprint_input_root(root: &Path) -> io::Result<String> {
    let mut hash = Sha256::new();
    let mut buffer = Box::new([0u8; 131072]);
    visit_input(root, root, &mut hash, &mut *buffer)?;
    Ok(hex(hash))
}
