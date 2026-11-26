//! A fresh live kernel-internal shmem mount witness, never a name classifier.
use std::fs::File;
use std::io;
use std::os::unix::fs::MetadataExt;
use super::{linux, objects, protocol};

pub(super) const TMPFS: u64 = 0x01021994;

pub(super) struct ShmemWitness {
    file: File,
    identity: objects::Identity,
    mount_id: u64,
}

impl ShmemWitness {
    pub fn new() -> io::Result<Self> {
        let file = File::from(linux::internal_shmem_witness()?);
        let result = Self { identity: objects::identity(&file)?,
            mount_id: objects::mount_id(&file)?, file };
        result.recheck()?;
        Ok(result)
    }

    pub fn recheck(&self) -> io::Result<()> {
        let metadata = self.file.metadata()?;
        if !metadata.is_file() || metadata.nlink() != 0
            || linux::filesystem_type(&self.file)? != TMPFS
            || objects::identity(&self.file)? != self.identity
            || objects::mount_id(&self.file)? != self.mount_id
        {
            return Err(io::Error::other("internal shmem witness changed"));
        }
        Ok(())
    }

    pub fn same_mount(&self, identity: &protocol::ObjectIdentity) -> io::Result<bool> {
        self.recheck()?;
        Ok(identity.dev == self.identity.0 && identity.mount_id == self.mount_id)
    }
}
