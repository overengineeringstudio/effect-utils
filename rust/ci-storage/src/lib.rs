//! Deterministic, verified CI artifact archives. See context/ci-storage/spec.md.
use flate2::{read::GzDecoder, Compression, GzBuilder};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{
    collections::BTreeSet,
    fs::{self, File},
    io::{self, Read, Write},
    path::{Component, Path},
};

pub type Result<T, E = Box<dyn std::error::Error>> = std::result::Result<T, E>;
const MANIFEST: &str = ".ci-storage-manifest.json";

#[derive(Clone, Copy, Debug, Serialize, Deserialize, clap::ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum Retention {
    Diagnostic,
    Handoff,
    Release,
}
impl Retention {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Diagnostic => "diagnostic",
            Self::Handoff => "handoff",
            Self::Release => "release",
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactRef {
    pub repo: String,
    pub sha256: String,
    pub retention: Retention,
}
impl ArtifactRef {
    pub fn validate(&self) -> Result<()> {
        let (owner, repo) = self
            .repo
            .split_once('/')
            .ok_or("invalid owner/repository")?;
        if [owner, repo].into_iter().any(|part| {
            part.is_empty()
                || part == "."
                || part == ".."
                || !part
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
        }) {
            return Err("invalid owner/repository".into());
        }
        if self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        {
            return Err("invalid sha256".into());
        }
        Ok(())
    }
    pub fn key(&self) -> String {
        format!(
            "ci/v1/{}/{}/sha256/{}.tar.gz",
            self.repo,
            self.retention.as_str(),
            self.sha256
        )
    }
}
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Entry {
    path: String,
    sha256: String,
    size: u64,
}

fn clean_path(value: &str) -> Result<()> {
    if value.is_empty()
        || value.contains('\\')
        || value.contains(':')
        || value.contains('\0')
        || value
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
        || Path::new(value)
            .components()
            .any(|p| !matches!(p, Component::Normal(_)))
        || value == MANIFEST
    {
        return Err("unsafe or reserved archive path".into());
    }
    Ok(())
}
fn open_payload(root: &Path, path: &str) -> Result<File> {
    use rustix::fs::{openat, Mode, OFlags};
    clean_path(path)?;
    let mut directory = File::open(root)?;
    let mut components = Path::new(path).components().peekable();
    while let Some(component) = components.next() {
        let mut flags = OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK;
        if components.peek().is_some() {
            flags |= OFlags::DIRECTORY;
        }
        let file = File::from(openat(
            &directory,
            component.as_os_str(),
            flags,
            Mode::empty(),
        )?);
        if components.peek().is_none() {
            if !file.metadata()?.is_file() {
                return Err("payload is not a regular file".into());
            }
            return Ok(file);
        }
        directory = file;
    }
    Err("empty payload path".into())
}

fn digest_reader(mut reader: impl Read) -> Result<(String, u64)> {
    let mut hash = Sha256::new();
    let mut size = 0;
    let mut buffer = [0; 65536];
    loop {
        let n = reader.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
        size += n as u64;
    }
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut digest = String::with_capacity(64);
    for byte in hash.finalize() {
        digest.push(char::from(HEX[usize::from(byte >> 4)]));
        digest.push(char::from(HEX[usize::from(byte & 15)]));
    }
    Ok((digest, size))
}
pub fn digest(path: &Path) -> Result<String> {
    Ok(digest_reader(File::open(path)?)?.0)
}
fn collect(root: &Path, path: &str, paths: &mut BTreeSet<String>) -> Result<()> {
    clean_path(path)?;
    // Inspect every ancestor: allowlisting a path must not traverse a symlink.
    let mut current = root.to_path_buf();
    for part in Path::new(path).components() {
        current.push(part);
        if fs::symlink_metadata(&current)?.file_type().is_symlink() {
            return Err("symlink inputs are forbidden".into());
        }
    }
    let metadata = fs::symlink_metadata(&current)?;
    if metadata.is_file() {
        paths.insert(path.to_owned());
    } else if metadata.is_dir() {
        for child in fs::read_dir(current)? {
            let child = child?;
            let name = child
                .file_name()
                .into_string()
                .map_err(|_| "non-UTF-8 input path")?;
            collect(root, &format!("{path}/{name}"), paths)?;
        }
    } else {
        return Err("only regular files and directories are allowed".into());
    }
    Ok(())
}
fn append(
    builder: &mut tar::Builder<impl Write>,
    name: &str,
    size: u64,
    reader: impl Read,
) -> Result<()> {
    let mut header = tar::Header::new_gnu();
    header.set_size(size);
    header.set_mode(0o644);
    header.set_uid(0);
    header.set_gid(0);
    header.set_mtime(0);
    header.set_entry_type(tar::EntryType::Regular);
    header.set_cksum();
    builder.append_data(&mut header, name, reader)?;
    Ok(())
}
fn encode(root: &Path, entries: &[Entry], writer: impl Write) -> Result<()> {
    let gzip = GzBuilder::new()
        .mtime(0)
        .operating_system(255)
        .write(writer, Compression::default());
    let mut builder = tar::Builder::new(gzip);
    let manifest = serde_json::to_vec(entries)?;
    append(
        &mut builder,
        MANIFEST,
        manifest.len() as u64,
        manifest.as_slice(),
    )?;
    for entry in entries {
        append(
            &mut builder,
            &entry.path,
            entry.size,
            open_payload(root, &entry.path)?,
        )?;
    }
    builder.into_inner()?.finish()?;
    Ok(())
}
pub fn pack(
    root: &Path,
    paths: &[String],
    retention: Retention,
    repo: String,
    out: &Path,
) -> Result<ArtifactRef> {
    let mut reference = ArtifactRef {
        repo,
        sha256: "0".repeat(64),
        retention,
    };
    reference.validate()?;
    let mut files = BTreeSet::new();
    for path in paths {
        collect(root, path, &mut files)?;
    }
    let entries: Vec<_> = files
        .into_iter()
        .map(|path| {
            let (sha256, size) = digest_reader(open_payload(root, &path)?)?;
            Ok(Entry { path, sha256, size })
        })
        .collect::<Result<_>>()?;
    let parent = out
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    encode(root, &entries, &mut temporary)?;
    reference.sha256 = digest(temporary.path())?;
    verify(temporary.path(), &reference)?;
    temporary.persist_noclobber(out).map_err(|e| e.error)?;
    Ok(reference)
}
fn stage(
    archive: &Path,
    reference: &ArtifactRef,
    parent: Option<&Path>,
) -> Result<tempfile::TempDir> {
    reference.validate()?;
    if digest(archive)? != reference.sha256 {
        return Err("archive digest mismatch".into());
    }
    let temporary = match parent {
        Some(parent) => tempfile::tempdir_in(parent)?,
        None => tempfile::tempdir()?,
    };
    let mut tar = tar::Archive::new(GzDecoder::new(File::open(archive)?));
    let mut entries = tar.entries()?;
    let mut first = entries.next().ok_or("missing manifest")??;
    if first.path_bytes().as_ref() != MANIFEST.as_bytes()
        || !first.header().entry_type().is_file()
        || first.size() > 16 * 1024 * 1024
    {
        return Err("invalid manifest entry".into());
    }
    let mut manifest = Vec::new();
    first.read_to_end(&mut manifest)?;
    let expected: Vec<Entry> = serde_json::from_slice(&manifest)?;
    let mut previous: Option<&str> = None;
    for item in &expected {
        clean_path(&item.path)?;
        if previous.is_some_and(|p| p >= item.path.as_str()) {
            return Err("manifest is not strictly sorted".into());
        }
        previous = Some(&item.path);
        let mut entry = entries.next().ok_or("missing archive entry")??;
        if entry.path_bytes().as_ref() != item.path.as_bytes()
            || !entry.header().entry_type().is_file()
            || entry.size() != item.size
        {
            return Err("archive entry does not match manifest".into());
        }
        let output = temporary.path().join(&item.path);
        fs::create_dir_all(output.parent().ok_or("missing entry parent")?)?;
        let mut file = File::options().write(true).create_new(true).open(&output)?;
        #[cfg(unix)]
        {
            file.set_permissions(fs::Permissions::from_mode(0o644))?;
            let mut directory = output.parent();
            while let Some(path) = directory {
                if path == temporary.path() {
                    break;
                }
                fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
                directory = path.parent();
            }
        }
        io::copy(&mut entry, &mut file)?;
        if digest(&output)? != item.sha256 {
            return Err("file checksum mismatch".into());
        }
    }
    if entries.next().is_some() {
        return Err("unexpected archive entry".into());
    }
    // Canonical re-encoding rejects alternate headers, extension entries and trailing data.
    let mut canonical = tempfile::NamedTempFile::new()?;
    encode(temporary.path(), &expected, &mut canonical)?;
    if digest(canonical.path())? != reference.sha256 {
        return Err("noncanonical archive".into());
    }
    Ok(temporary)
}
pub fn verify(archive: &Path, reference: &ArtifactRef) -> Result<()> {
    stage(archive, reference, None).map(|_| ())
}
pub fn extract(archive: &Path, reference: &ArtifactRef, destination: &Path) -> Result<()> {
    if fs::symlink_metadata(destination).is_ok() {
        return Err("destination already exists".into());
    }
    let parent = destination
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let temporary = stage(archive, reference, Some(parent))?;
    #[cfg(unix)]
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o755))?;
    publish_tree(&temporary, parent, destination)
}

fn publish_tree(temporary: &tempfile::TempDir, parent: &Path, destination: &Path) -> Result<()> {
    // Atomic no-replace publication also rejects a destination created during verification.
    let directory = File::open(parent)?;
    rustix::fs::renameat_with(
        &directory,
        temporary
            .path()
            .file_name()
            .ok_or("missing temporary directory name")?,
        &directory,
        destination.file_name().ok_or("missing destination name")?,
        rustix::fs::RenameFlags::NOREPLACE,
    )?;
    Ok(())
}

pub mod transport;

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn publication_rejects_destination_created_after_staging() {
        let root = tempfile::tempdir().unwrap();
        let staged = tempfile::tempdir_in(root.path()).unwrap();
        fs::write(staged.path().join("payload"), b"verified").unwrap();
        let destination = root.path().join("destination");
        fs::create_dir(&destination).unwrap();
        assert!(publish_tree(&staged, root.path(), &destination).is_err());
        assert!(!destination.join("payload").exists());
        assert!(staged.path().join("payload").exists());
    }

    #[cfg(unix)]
    #[test]
    fn payload_open_rejects_links_replacing_validated_paths() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("data")).unwrap();
        fs::write(root.path().join("data/file"), b"allowed").unwrap();
        let mut selected = BTreeSet::new();
        collect(root.path(), "data", &mut selected).unwrap();
        fs::rename(root.path().join("data"), root.path().join("original")).unwrap();
        std::os::unix::fs::symlink("original", root.path().join("data")).unwrap();
        assert!(open_payload(root.path(), "data/file").is_err());
        fs::remove_file(root.path().join("data")).unwrap();
        fs::rename(root.path().join("original"), root.path().join("data")).unwrap();
        fs::remove_file(root.path().join("data/file")).unwrap();
        std::os::unix::fs::symlink("../outside", root.path().join("data/file")).unwrap();
        assert!(open_payload(root.path(), "data/file").is_err());
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(24))]
        #[test]
        fn deterministic_across_input_order_and_metadata(bytes in prop::collection::vec(any::<u8>(), 0..4096)) {
            let root = tempfile::tempdir().unwrap();
            fs::create_dir(root.path().join("data")).unwrap();
            fs::write(root.path().join("data/a"), &bytes).unwrap();
            fs::write(root.path().join("data/b"), b"second").unwrap();
            let first = root.path().join("first.tar.gz");
            let second = root.path().join("second.tar.gz");
            let reference = pack(root.path(), &["data".into()], Retention::Handoff, "owner/repo".into(), &first).unwrap();
            File::options().write(true).open(root.path().join("data/a")).unwrap().set_modified(std::time::SystemTime::UNIX_EPOCH).unwrap();
            let repeated = pack(root.path(), &["data/b".into(), "data/a".into()], Retention::Handoff, "owner/repo".into(), &second).unwrap();
            prop_assert_eq!(&reference.sha256, &repeated.sha256);
            prop_assert_eq!(fs::read(&first).unwrap(), fs::read(&second).unwrap());
            let destination = root.path().join("extracted");
            extract(&first, &reference, &destination).unwrap();
            prop_assert_eq!(fs::read(destination.join("data/a")).unwrap(), bytes);
        }

        #[test]
        fn traversal_is_rejected(component in "[a-zA-Z0-9_-]{1,30}") {
            for path in [format!("../{component}"), format!("/{component}"), format!("{component}/../x"), format!("{component}//x"), format!("{component}/./x"), format!("C:/{component}"), format!("{component}\\x")] {
                prop_assert!(clean_path(&path).is_err(), "accepted {}", path);
            }
        }
    }

    #[test]
    fn corrupted_archives_do_not_publish_destination() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("file"), b"original").unwrap();
        let archive = root.path().join("artifact.tar.gz");
        let reference = pack(
            root.path(),
            &["file".into()],
            Retention::Diagnostic,
            "owner/repo".into(),
            &archive,
        )
        .unwrap();
        let mut bytes = fs::read(&archive).unwrap();
        bytes[15] ^= 1;
        fs::write(&archive, bytes).unwrap();
        let destination = root.path().join("dest");
        assert!(extract(&archive, &reference, &destination).is_err());
        assert!(!destination.exists());
    }

    #[test]
    fn manifest_traversal_and_special_entries_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        for (path, kind) in [
            ("../escape", tar::EntryType::Regular),
            ("file", tar::EntryType::Symlink),
            ("file", tar::EntryType::Link),
            ("file", tar::EntryType::Char),
            ("/absolute", tar::EntryType::Regular),
        ] {
            let archive = root.path().join("malicious.tar.gz");
            let gzip =
                GzBuilder::new().write(File::create(&archive).unwrap(), Compression::default());
            let mut tar = tar::Builder::new(gzip);
            let entries = vec![Entry {
                path: path.into(),
                sha256: digest_reader(io::empty()).unwrap().0,
                size: 0,
            }];
            let manifest = serde_json::to_vec(&entries).unwrap();
            append(
                &mut tar,
                MANIFEST,
                manifest.len() as u64,
                manifest.as_slice(),
            )
            .unwrap();
            // Raw path bytes deliberately bypass tar's safe builder path checks.
            let mut header = tar::Header::new_gnu();
            header.as_mut_bytes()[..path.len()].copy_from_slice(path.as_bytes());
            header.set_size(0);
            header.set_mode(0o644);
            header.set_entry_type(kind);
            header.set_cksum();
            tar.append(&header, io::empty()).unwrap();
            tar.into_inner().unwrap().finish().unwrap();
            let reference = ArtifactRef {
                repo: "owner/repo".into(),
                sha256: digest(&archive).unwrap(),
                retention: Retention::Handoff,
            };
            let destination = root.path().join("dest");
            assert!(extract(&archive, &reference, &destination).is_err());
            assert!(!destination.exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlink_inputs_and_existing_destination_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("file"), b"value").unwrap();
        std::os::unix::fs::symlink("file", root.path().join("link")).unwrap();
        let archive = root.path().join("artifact.tar.gz");
        assert!(pack(
            root.path(),
            &["link".into()],
            Retention::Release,
            "owner/repo".into(),
            &archive
        )
        .is_err());
        let reference = pack(
            root.path(),
            &["file".into()],
            Retention::Release,
            "owner/repo".into(),
            &archive,
        )
        .unwrap();
        let destination = root.path().join("dest");
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("keep"), b"existing").unwrap();
        assert!(extract(&archive, &reference, &destination).is_err());
        assert_eq!(fs::read(destination.join("keep")).unwrap(), b"existing");
    }
}
