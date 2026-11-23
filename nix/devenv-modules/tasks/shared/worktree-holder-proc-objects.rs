use std::ffi::CString;
use std::fs::File;
use std::io::{self, Read};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::time::Instant;

use super::linux;

pub type Identity = (u64, u64);

pub fn identity(file: &File) -> io::Result<Identity> {
    let stat = file.metadata()?;
    Ok((stat.dev(), stat.ino()))
}

pub fn bounded_text(path: impl AsRef<Path>, limit: usize) -> io::Result<String> {
    let mut bytes = Vec::new();
    File::open(path)?.take((limit + 1) as u64).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(io::Error::other("evidence input limit"));
    }
    String::from_utf8(bytes).map_err(|_| io::Error::other("non-UTF-8 evidence metadata"))
}

pub fn mount_id(file: &impl AsRawFd) -> io::Result<u64> {
    let text = bounded_text(format!("/proc/self/fdinfo/{}", file.as_raw_fd()), 64 * 1024)?;
    let mut records = text.lines().filter_map(|line| line.strip_prefix("mnt_id:"));
    let value = records.next().ok_or_else(|| io::Error::other("missing held mount identity"))?.trim();
    if records.next().is_some() || value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(io::Error::other("ambiguous held mount identity"));
    }
    value.parse().map_err(|_| io::Error::other("held mount identity overflow"))
}

pub fn pin_magic(path: impl AsRef<Path>) -> io::Result<File> {
    let name = CString::new(path.as_ref().as_os_str().as_bytes())
        .map_err(|_| io::Error::other("NUL in proc reference"))?;
    // Only the caller's independently derived fixed proc paths reach this API.
    // O_PATH does not open device contents or invoke a FIFO/socket protocol.
    linux::open_path(-100, &name, 0, 0).map(File::from)
}

pub fn pin_beneath(directory: &impl AsRawFd, name: &std::ffi::OsStr) -> io::Result<File> {
    let name = CString::new(name.as_bytes()).map_err(|_| io::Error::other("NUL in confined name"))?;
    linux::open_path(directory.as_raw_fd(), &name, 0,
        linux::RESOLVE_BENEATH | linux::RESOLVE_NO_MAGICLINKS | linux::RESOLVE_NO_SYMLINKS)
        .map(File::from)
}

pub fn native_filesystem(file: &impl AsRawFd) -> io::Result<bool> {
    Ok(matches!(linux::filesystem_type(file)?,
        0xef53 | 0x2fc12fc1 | 0x9123683e | 0x58465342 | 0x01021994 | 0x858458f6))
}


/// Resolve ancestry from actual held directories, not readlink spellings or
/// a different device number. The root and every parent remain pinned during
/// each step. Escaped/detached/cyclic/too-deep ancestry cannot authorize absence.
pub fn contained_directory(directory: &File, root: &File, deadline: Instant) -> io::Result<bool> {
    let expected = (identity(root)?, mount_id(root)?);
    let mut current = directory.try_clone()?;
    let parent_name = CString::new("..").expect("literal");
    for _ in 0..256 {
        if Instant::now() >= deadline {
            return Err(io::Error::other("directory ancestry deadline"));
        }
        let before = (identity(&current)?, mount_id(&current)?);
        if before == expected {
            return Ok(true);
        }
        // '..' is intentionally allowed for ancestry evidence, not candidate
        // authorization. This call accepts only our own held directory FD.
        let parent = File::from(linux::open_path(current.as_raw_fd(), &parent_name,
            linux::O_DIRECTORY, linux::RESOLVE_NO_MAGICLINKS)?);
        let after = (identity(&parent)?, mount_id(&parent)?);
        if before == after {
            return Ok(false);
        }
        current = parent;
    }
    Err(io::Error::other("directory ancestry depth bound"))
}

pub fn duplicate_client_fd(process: &OwnedFd, number: i32) -> io::Result<File> {
    linux::duplicate_process_fd(process, number).map(File::from)
}
