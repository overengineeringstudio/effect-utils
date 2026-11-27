//! Whole-namespace kernel queries, never task-root-filtered mountinfo absence.
use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io;
use std::os::unix::ffi::OsStringExt;
use std::path::PathBuf;
use std::time::Instant;
use super::{linux, mounts, objects};

const LIMIT: usize = 4096;

#[derive(Debug, PartialEq, Eq)]
pub enum NamespaceRoot {
    Path(PathBuf),
    NamespaceObject { namespace: &'static str, inode: u64 },
}

impl NamespaceRoot {
    pub fn path(&self) -> io::Result<&PathBuf> {
        match self {
            Self::Path(path) => Ok(path),
            Self::NamespaceObject { .. } => Err(io::Error::other("namespace object is not a filesystem coordinate")),
        }
    }
}

fn mount_root(bytes: &[u8], filesystem: u64, kind: &str) -> io::Result<NamespaceRoot> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::path::Path::new(std::ffi::OsStr::from_bytes(bytes));
    if mounts::canonical(path) { return Ok(NamespaceRoot::Path(path.to_owned())); }
    // nsfs binds identify kernel namespace objects, not paths inside a filesystem.
    // Retain these records in the complete snapshot, never as native coordinates.
    if filesystem != 0x6e736673 || kind != "nsfs" { return Err(incomplete()); }
    let text = std::str::from_utf8(bytes).map_err(|_| incomplete())?;
    let (name, number) = text.split_once(":[").ok_or_else(incomplete)?;
    let namespace = match name {
        "mnt" => "mnt", "net" => "net", "user" => "user", "pid" => "pid",
        "uts" => "uts", "ipc" => "ipc", "cgroup" => "cgroup", "time" => "time",
        _ => return Err(incomplete()),
    };
    let number = number.strip_suffix(']').ok_or_else(incomplete)?;
    if number.starts_with('0') || number.is_empty() || !number.bytes().all(|b| b.is_ascii_digit()) {
        return Err(incomplete());
    }
    let inode = number.parse::<u64>().map_err(|_| incomplete())?;
    Ok(NamespaceRoot::NamespaceObject { namespace, inode })
}

#[derive(Debug, PartialEq, Eq)]
pub struct NamespaceMount {
    pub unique_id: u64,
    pub unique_parent: u64,
    pub id: u64,
    pub parent: u64,
    pub device_major: u32,
    pub device_minor: u32,
    pub filesystem: u64,
    pub super_flags: u32,
    pub attributes: u64,
    pub propagation: u64,
    pub peer_group: u64,
    pub master: u64,
    pub root: NamespaceRoot,
    pub point: PathBuf,
    pub kind: String,
}

fn incomplete() -> io::Error { io::Error::other("incomplete kernel mount namespace snapshot") }
fn bound(deadline: Instant) -> io::Result<()> {
    if Instant::now() >= deadline { return Err(incomplete()); }
    Ok(())
}
fn u32_at(bytes: &[u8], offset: usize) -> io::Result<u32> {
    Ok(u32::from_ne_bytes(bytes.get(offset..offset + 4).ok_or_else(incomplete)?
        .try_into().map_err(|_| incomplete())?))
}
fn u64_at(bytes: &[u8], offset: usize) -> io::Result<u64> {
    Ok(u64::from_ne_bytes(bytes.get(offset..offset + 8).ok_or_else(incomplete)?
        .try_into().map_err(|_| incomplete())?))
}
fn string_at(bytes: &[u8], offset: usize) -> io::Result<&[u8]> {
    let start = 512usize.checked_add(u32_at(bytes, offset)? as usize).ok_or_else(incomplete)?;
    let tail = bytes.get(start..).ok_or_else(incomplete)?;
    let end = tail.iter().position(|byte| *byte == 0).ok_or_else(incomplete)?;
    Ok(&tail[..end])
}
fn decode(bytes: &[u8], unique_id: u64, namespace_id: u64) -> io::Result<NamespaceMount> {
    if bytes.len() < 512 || u32_at(bytes, 0)? as usize != bytes.len()
        || u64_at(bytes, 8)? & linux::REQUIRED_MOUNT_FIELDS != linux::REQUIRED_MOUNT_FIELDS
        || u64_at(bytes, 40)? != unique_id || u64_at(bytes, 112)? != namespace_id
    { return Err(incomplete()); }
    let id = u64::from(u32_at(bytes, 56)?);
    let point = PathBuf::from(std::ffi::OsString::from_vec(string_at(bytes, 108)?.to_vec()));
    if id == 0 || !mounts::canonical(&point) { return Err(incomplete()); }
    let kind = std::str::from_utf8(string_at(bytes, 36)?).map_err(|_| incomplete())?.to_owned();
    if kind.is_empty() { return Err(incomplete()); }
    let root = mount_root(string_at(bytes, 104)?, u64_at(bytes, 24)?, &kind)?;
    Ok(NamespaceMount { unique_id, unique_parent: u64_at(bytes, 48)?, id,
        parent: u64::from(u32_at(bytes, 60)?), device_major: u32_at(bytes, 16)?,
        device_minor: u32_at(bytes, 20)?, filesystem: u64_at(bytes, 24)?,
        super_flags: u32_at(bytes, 32)?, attributes: u64_at(bytes, 64)?,
        propagation: u64_at(bytes, 72)?, peer_group: u64_at(bytes, 80)?,
        master: u64_at(bytes, 88)?, root, point, kind })
}

fn list_all(namespace: &File, deadline: Instant) -> io::Result<BTreeSet<u64>> {
    let mut ids = BTreeSet::new();
    let mut page = [0u64; 256];
    let mut cursor = 0;
    loop {
        bound(deadline)?;
        let count = linux::list_mount_page(namespace, cursor, &mut page)?;
        if count == 0 { break; }
        for id in &page[..count] {
            if *id <= cursor || *id == u64::MAX || !ids.insert(*id) { return Err(incomplete()); }
            cursor = *id;
            if ids.len() > LIMIT { return Err(incomplete()); }
        }
    }
    Ok(ids)
}

fn read_records(
    namespace: &File,
    deadline: Instant,
    mut visit: impl FnMut(NamespaceMount) -> io::Result<()>,
) -> io::Result<(u64, usize)> {
    bound(deadline)?;
    let id = linux::mount_namespace_id(namespace)?;
    let before = linux::mount_namespace_info(namespace)?;
    if before.namespace_id != id || before.mounts == 0 || before.mounts as usize > LIMIT {
        return Err(incomplete());
    }
    let ids = list_all(namespace, deadline)?;
    // LSMT_ROOT itself still applies reachability filtering. The independent
    // nsfs count includes all namespace mounts except the kernel's internal
    // root: a filtered/partial list cannot serve as complete evidence.
    if ids.len() != before.mounts as usize { return Err(incomplete()); }
    let mut buffer = linux::MountBuffer::new();
    for unique_id in &ids {
        bound(deadline)?;
        let record = decode(linux::stat_mount(namespace, *unique_id, &mut buffer)?, *unique_id, id)?;
        visit(record)?;
    }
    let after = linux::mount_namespace_info(namespace)?;
    if after != before || linux::mount_namespace_id(namespace)? != id
        || list_all(namespace, deadline)? != ids
    { return Err(incomplete()); }
    bound(deadline)?;
    Ok((id, ids.len()))
}

fn mount_route(records: &BTreeMap<u64, NamespaceMount>, ancestor: u64,
    descendant: u64, deadline: Instant) -> io::Result<Option<&NamespaceMount>>
{
    let Some(mut mount) = records.get(&descendant) else { return Ok(None); };
    for _ in 0..=records.len() {
        bound(deadline)?;
        if mount.id == ancestor || mount.parent == ancestor { return Ok(Some(mount)); }
        if mount.parent == mount.id { return Ok(None); }
        let Some(parent) = records.get(&mount.parent) else { return Ok(None); };
        mount = parent;
    }
    Err(incomplete())
}

fn covered_mount(records: &BTreeMap<u64, NamespaceMount>, id: u64,
    deadline: Instant) -> io::Result<bool>
{
    let mount = records.get(&id).ok_or_else(incomplete)?;
    for cover in records.values() {
        bound(deadline)?;
        if cover.id == id || !mount.point.starts_with(&cover.point)
            || mount_route(records, cover.id, id, deadline)?.is_some()
        { continue; }
        let Some(route) = mount_route(records, cover.parent, id, deadline)? else { continue; };
        if route.id == cover.parent { return Ok(true); }
        // At shared ancestry, the shorter mount point dominates. A mount
        // already hidden by the target's actual route cannot hide that target.
        if route.point == cover.point { return Err(incomplete()); }
        if route.point.starts_with(&cover.point) { return Ok(true); }
    }
    Ok(false)
}

pub struct NamespaceSnapshot {
    namespace: File,
    identity: objects::Identity,
    id: u64,
    records: BTreeMap<u64, NamespaceMount>,
}

impl NamespaceSnapshot {
    pub fn capture(namespace: File, deadline: Instant) -> io::Result<Self> {
        let identity = objects::identity(&namespace)?;
        let mut records = BTreeMap::new();
        let (id, _) = read_records(&namespace, deadline, |record| {
            if records.insert(record.id, record).is_some() { return Err(incomplete()); }
            Ok(())
        })?;
        Ok(Self { namespace, identity, id, records })
    }

    pub fn records(&self) -> &BTreeMap<u64, NamespaceMount> { &self.records }
    pub fn id(&self) -> u64 { self.id }

    pub fn covered_mount(&self, id: u64, deadline: Instant) -> io::Result<bool> {
        covered_mount(&self.records, id, deadline)
    }

    pub fn same_namespace(&self, namespace: &File) -> io::Result<bool> {
        Ok(objects::identity(namespace)? == self.identity
            && linux::mount_namespace_id(namespace)? == self.id)
    }

    pub fn recheck(&self, deadline: Instant) -> io::Result<()> {
        if objects::identity(&self.namespace)? != self.identity { return Err(incomplete()); }
        let (id, count) = read_records(&self.namespace, deadline, |record| {
            if self.records.get(&record.id) != Some(&record) { return Err(incomplete()); }
            Ok(())
        })?;
        if id != self.id || count != self.records.len() { return Err(incomplete()); }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> Vec<u8> {
        let mut bytes = vec![0u8; 522];
        bytes[..4].copy_from_slice(&522u32.to_ne_bytes());
        bytes[8..16].copy_from_slice(&linux::REQUIRED_MOUNT_FIELDS.to_ne_bytes());
        bytes[40..48].copy_from_slice(&0x1_0000_000bu64.to_ne_bytes());
        bytes[56..60].copy_from_slice(&5u32.to_ne_bytes());
        bytes[112..120].copy_from_slice(&19u64.to_ne_bytes());
        bytes[108..112].copy_from_slice(&2u32.to_ne_bytes());
        bytes[36..40].copy_from_slice(&4u32.to_ne_bytes());
        bytes[512..].copy_from_slice(b"/\0/\0tmpfs\0");
        bytes
    }

    fn topology_mount(id: u64, parent: u64, point: &str) -> NamespaceMount {
        let mut mount = decode(&record(), 0x1_0000_000b, 19).unwrap();
        mount.id = id;
        mount.parent = parent;
        mount.unique_id = id + 100;
        mount.unique_parent = parent + 100;
        mount.point = PathBuf::from(point);
        mount
    }

    #[test]
    fn covered_mounts_require_dominating_kernel_topology() {
        let mut records: BTreeMap<_, _> = [
            topology_mount(1, 0, "/"),
            topology_mount(2, 1, "/home/alice"),
            topology_mount(3, 2, "/home/alice/store"),
            topology_mount(4, 1, "/home"),
            topology_mount(5, 4, "/home/alice/store"),
        ].into_iter().map(|mount| (mount.id, mount)).collect();
        let deadline = Instant::now() + std::time::Duration::from_secs(10);
        for id in [2, 3] { assert!(covered_mount(&records, id, deadline).unwrap()); }
        for id in [1, 4, 5] { assert!(!covered_mount(&records, id, deadline).unwrap()); }
        // A mount attached under the new covering mount remains visible, even
        // where an older, hidden tree has the identical pathname.
        records.insert(6, topology_mount(6, 5, "/home/alice/store"));
        assert!(covered_mount(&records, 5, deadline).unwrap());
        assert!(!covered_mount(&records, 6, deadline).unwrap());
        // Equal-point competitors without an ordered ancestry are not proof.
        records.insert(7, topology_mount(7, 1, "/home"));
        assert!(covered_mount(&records, 4, deadline).is_err());
        assert!(covered_mount(&records, 99, deadline).is_err());
        assert!(covered_mount(&records, 3, Instant::now()).is_err());
    }

    #[test]
    fn codec_keeps_unique_and_legacy_ids_distinct() {
        let decoded = decode(&record(), 0x1_0000_000b, 19).unwrap();
        assert_eq!(decoded.unique_id, 0x1_0000_000b);
        assert_eq!(decoded.id, 5);
        assert_eq!(decoded.root, NamespaceRoot::Path(PathBuf::from("/")));
        assert_eq!(decoded.point, PathBuf::from("/"));
        assert_eq!(decoded.kind, "tmpfs");
    }

    #[test]
    fn namespace_objects_are_retained_without_becoming_path_coordinates() {
        let root = mount_root(b"net:[4026533279]", 0x6e736673, "nsfs").unwrap();
        assert_eq!(root, NamespaceRoot::NamespaceObject { namespace: "net", inode: 4026533279 });
        assert!(root.path().is_err());
        for bytes in [
            b"net:[0]".as_slice(), b"net:[01]", b"net:[-1]", b"net:[1]/",
            b"net:[1]\n", b"net:[18446744073709551616]", b"other:[1]",
            b"net:[]", b"net:[1", b"relative",
        ] {
            assert!(mount_root(bytes, 0x6e736673, "nsfs").is_err());
        }
        assert!(mount_root(b"net:[1]", 0x01021994, "tmpfs").is_err());
        assert!(mount_root(b"net:[1]", 0x6e736673, "tmpfs").is_err());
        assert!(mount_root(b"../escape", 0x6e736673, "nsfs").is_err());
    }

    #[test]
    fn malformed_or_incomplete_kernel_records_never_become_evidence() {
        let valid = record();
        assert!(decode(&valid[..511], 0x1_0000_000b, 19).is_err());
        assert!(decode(&valid, 0x1_0000_000c, 19).is_err());
        assert!(decode(&valid, 0x1_0000_000b, 20).is_err());
        for (offset, replacement) in [
            (0, 521u32), (56, 0), (104, u32::MAX), (108, u32::MAX), (36, u32::MAX),
        ] {
            let mut bytes = valid.clone();
            bytes[offset..offset + 4].copy_from_slice(&replacement.to_ne_bytes());
            assert!(decode(&bytes, 0x1_0000_000b, 19).is_err());
        }
        let mut missing = valid.clone();
        missing[8..16].copy_from_slice(&(linux::REQUIRED_MOUNT_FIELDS & !0x40).to_ne_bytes());
        assert!(decode(&missing, 0x1_0000_000b, 19).is_err());
        let mut relative = valid.clone();
        relative[512] = b'x';
        assert!(decode(&relative, 0x1_0000_000b, 19).is_err());
        let mut unterminated = valid;
        unterminated[521] = b'x';
        assert!(decode(&unterminated, 0x1_0000_000b, 19).is_err());
    }
}
