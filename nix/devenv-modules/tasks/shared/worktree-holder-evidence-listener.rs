//! Exact kernel-bound Docker listener filesystem objects, without truncated diagnostics.
use std::fs::File;
use std::io;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use super::{linux, objects};

pub struct Listener { bound: File }

/// None means an ordinary socket other than the fixed listening stream. A
/// matching address with an unavailable SIOCUNIXFILE primitive is UNKNOWN.
pub fn query(socket: &File) -> io::Result<Option<Listener>> {
    let Some(bound) = linux::fixed_listener_path(socket)? else { return Ok(None); };
    let stat = socket.metadata()?;
    let bound = File::from(bound);
    let path_stat = bound.metadata()?;
    if !stat.file_type().is_socket() || stat.uid() != 0
        || linux::filesystem_type(socket)? != 0x534f434b
        || !path_stat.file_type().is_socket() || path_stat.uid() != 0 {
        return Err(io::Error::other("listener kernel objects are not root-owned sockets"));
    }
    Ok(Some(Listener { bound }))
}

impl Listener {
    pub fn matches_path(&self, path: &File) -> io::Result<bool> {
        Ok(objects::identity(&self.bound)? == objects::identity(path)?
            && objects::mount_id(&self.bound)? == objects::mount_id(path)?)
    }

    pub fn recheck(&self, socket: &File) -> io::Result<()> {
        let current = query(socket)?.ok_or_else(|| io::Error::other("fixed listener state changed"))?;
        if !current.matches_path(&self.bound)? {
            return Err(io::Error::other("listener bound filesystem object changed"));
        }
        Ok(())
    }
}
