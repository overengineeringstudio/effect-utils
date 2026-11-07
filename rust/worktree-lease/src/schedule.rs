use crate::{Refusal, Result};
use std::{
    fs,
    io::{Read, Write},
    os::unix::{ffi::OsStrExt, fs::OpenOptionsExt},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
fn read(path: &Path) -> Result<Option<Vec<u8>>> {
    let file = match fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(Refusal::UnsafeLock),
    };
    if !file.metadata().map_err(|_| Refusal::UnsafeLock)?.is_file() {
        return Err(Refusal::UnsafeLock);
    }
    let mut bytes = Vec::new();
    file.take(65_537)
        .read_to_end(&mut bytes)
        .map_err(|_| Refusal::UnsafeLock)?;
    if bytes.len() > 65_536 {
        return Err(Refusal::UnsafeLock);
    }
    Ok(Some(bytes))
}
fn write(common: &Path, name: &str, bytes: &[u8]) -> Result<()> {
    let mut file = tempfile::NamedTempFile::new_in(common).map_err(|_| Refusal::UnsafeLock)?;
    file.write_all(bytes).map_err(|_| Refusal::UnsafeLock)?;
    file.persist(common.join(name))
        .map_err(|_| Refusal::UnsafeLock)?;
    Ok(())
}
pub(crate) fn prepare(common: &Path, paths: &mut [PathBuf], scheduled: bool) -> Result<bool> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| Refusal::UnsafeLock)?
        .as_secs();
    let stamp = read(&common.join("gate-worktrees.reap.stamp"))?;
    if scheduled {
        if let Some(stamp) = stamp {
            let stamp = std::str::from_utf8(&stamp)
                .ok()
                .and_then(|s| s.parse::<u64>().ok())
                .ok_or(Refusal::UnsafeLock)?;
            if now.saturating_sub(stamp) < 600 {
                return Ok(false);
            }
        }
    }
    if let Some(cursor) = read(&common.join("gate-worktrees.reap.cursor"))? {
        if cursor.is_empty() || cursor.contains(&b'/') || cursor.contains(&0) {
            return Err(Refusal::UnsafeLock);
        }
        let start = paths.partition_point(|path| {
            path.file_name()
                .is_some_and(|name| name.as_bytes() <= cursor.as_slice())
        });
        if start < paths.len() {
            paths.rotate_left(start);
        }
    }
    write(
        common,
        "gate-worktrees.reap.stamp",
        now.to_string().as_bytes(),
    )?;
    Ok(true)
}
pub(crate) fn examined(common: &Path, path: &Path) -> Result<()> {
    write(
        common,
        "gate-worktrees.reap.cursor",
        path.file_name().ok_or(Refusal::UnsafeLock)?.as_bytes(),
    )
}
