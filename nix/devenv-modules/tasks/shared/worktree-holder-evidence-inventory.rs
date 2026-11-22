use std::fs::{self, File};
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::time::Instant;

use super::objects::{Identity, mount_id, native_filesystem, pin_beneath};

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
