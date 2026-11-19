use std::ffi::CString;
use std::fs::{self, File};
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

/// Native object inventory with one canonical root-relative spelling per inode.
/// Hardlinks are intentionally coalesced for stores, never for worktrees.
pub fn inventory_paths(root: &File, deadline: Instant)
    -> io::Result<std::collections::BTreeMap<Identity, std::path::PathBuf>>
{
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    let stat = root.metadata()?;
    if !stat.is_dir() || !native_filesystem(root)? {
        return Err(io::Error::other("candidate is not a native directory"));
    }
    let device = stat.dev();
    let mount = mount_id(root)?;
    let mut paths = BTreeMap::from([((device, stat.ino()), PathBuf::from("."))]);
    let mut entries = 0usize;
    let mut path_bytes = 1usize;
    fn walk(directory: &File, relative: &Path, device: u64, mount: u64,
        depth: usize, paths: &mut BTreeMap<Identity, PathBuf>, entries: &mut usize,
        path_bytes: &mut usize, deadline: Instant) -> io::Result<()>
    {
        if depth > 64 || Instant::now() >= deadline {
            return Err(io::Error::other("store inventory bound"));
        }
        for entry in fs::read_dir(format!("/proc/self/fd/{}", directory.as_raw_fd()))? {
            *entries += 1;
            if *entries > 500_000 || Instant::now() >= deadline {
                return Err(io::Error::other("store inventory capacity or deadline"));
            }
            let name = entry?.file_name();
            let child = pin_beneath(directory, &name)?;
            let stat = child.metadata()?;
            if stat.dev() != device || mount_id(&child)? != mount
                || (!stat.is_dir() && !stat.is_file())
            {
                return Err(io::Error::other("store inventory bridge or unsupported object"));
            }
            let path = if relative == Path::new(".") { PathBuf::from(&name) }
                else { relative.join(&name) };
            *path_bytes = path_bytes.checked_add(path.as_os_str().len())
                .ok_or_else(|| io::Error::other("store path budget overflow"))?;
            if path.as_os_str().len() > 4096 || *path_bytes > 64 * 1024 * 1024 {
                return Err(io::Error::other("store path budget"));
            }
            paths.entry((stat.dev(), stat.ino()))
                .and_modify(|previous| { if path < *previous { *previous = path.clone(); } })
                .or_insert_with(|| path.clone());
            if stat.is_dir() {
                walk(&child, &path, device, mount, depth + 1, paths, entries, path_bytes, deadline)?;
            }
        }
        Ok(())
    }
    walk(root, Path::new("."), device, mount, 0, &mut paths, &mut entries, &mut path_bytes, deadline)?;
    Ok(paths)
}
