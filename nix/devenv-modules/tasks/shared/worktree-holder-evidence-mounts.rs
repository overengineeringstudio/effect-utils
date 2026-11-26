use std::collections::BTreeMap;
use std::os::unix::ffi::OsStringExt;
use std::path::PathBuf;

#[derive(Debug, PartialEq, Eq)]
pub struct Mount {
    pub id: u64,
    pub parent: u64,
    pub device_major: u32,
    pub device_minor: u32,
    pub root: PathBuf,
    pub point: PathBuf,
    pub options: String,
    pub optional: Vec<String>,
    pub kind: String,
    pub source: String,
    pub super_options: String,
}

fn number<T: std::str::FromStr>(value: &str) -> Result<T, &'static str> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("invalid mount numeric field");
    }
    value.parse().map_err(|_| "mount numeric overflow")
}

fn pathname(value: &str) -> Result<PathBuf, &'static str> {
    let mut decoded = Vec::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'\\' {
            let escaped = bytes.get(index + 1..index + 4).ok_or("truncated mount escape")?;
            let byte = match escaped {
                b"040" => b' ',
                b"011" => b'\t',
                b"012" => b'\n',
                b"134" => b'\\',
                _ => return Err("unsupported mount escape"),
            };
            decoded.push(byte);
            index += 4;
        } else {
            if bytes[index] == 0 {
                return Err("NUL in mount pathname");
            }
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    if !decoded.starts_with(b"/") {
        return Err("relative mount pathname");
    }
    Ok(std::ffi::OsString::from_vec(decoded).into())
}

/// Decode a complete bounded snapshot. Textual backing paths are never trusted
/// merely because parsing succeeded: the caller must attest their daemon origin
/// and compare actual held-object identities against the active overlay graph.
pub fn parse(snapshot: &str) -> Result<BTreeMap<u64, Mount>, &'static str> {
    if snapshot.is_empty() || snapshot.len() > 1_048_576 || !snapshot.ends_with('\n') {
        return Err("incomplete or oversized mount snapshot");
    }
    let mut mounts = BTreeMap::new();
    for line in snapshot.lines() {
        if mounts.len() >= 4096 {
            return Err("too many mounts");
        }
        let (before, after) = line.split_once(" - ").ok_or("missing mount separator")?;
        let fields: Vec<_> = before.split_whitespace().collect();
        let suffix: Vec<_> = after.split_whitespace().collect();
        if fields.len() < 6 || suffix.len() != 3 {
            return Err("malformed mount record");
        }
        let (major, minor) = fields[2].split_once(':').ok_or("malformed mount device")?;
        let id = number(fields[0])?;
        if id == 0 || mounts.contains_key(&id) {
            return Err("zero or duplicate mount identity");
        }
        mounts.insert(id, Mount {
            id,
            parent: number(fields[1])?,
            device_major: number(major)?,
            device_minor: number(minor)?,
            root: pathname(fields[3])?,
            point: pathname(fields[4])?,
            options: fields[5].to_owned(),
            optional: fields[6..].iter().map(|value| (*value).to_owned()).collect(),
            kind: suffix[0].to_owned(),
            source: suffix[1].to_owned(),
            super_options: suffix[2].to_owned(),
        });
    }
    Ok(mounts)
}

/// A kernel mount-root coordinate, backed by a pinned actual mountpoint and a
/// reopen of the held object's pathname. Mountinfo text alone is not evidence.
pub struct NativeLocation {
    pub device: u64,
    pub filesystem: u64,
    pub path: PathBuf,
    _mountpoint: std::fs::File,
}

impl NativeLocation {
    pub fn object(&self) -> &std::fs::File { &self._mountpoint }
}

pub fn canonical(path: &std::path::Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let bytes = path.as_os_str().as_bytes();
    bytes.starts_with(b"/") && bytes.len() <= 4096
        && !bytes.iter().any(|byte| matches!(byte, 0 | b'\r' | b'\n'))
        && (bytes == b"/" || (!bytes.ends_with(b"/")
            && bytes[1..].split(|byte| *byte == b'/')
                .all(|part| !part.is_empty() && part != b"." && part != b"..")))
}

pub fn device_pair(device: u64) -> (u32, u32) {
    // Linux's userspace dev_t encoding, not a filesystem-specific inode guess.
    let major = ((device >> 8) & 0xfff) | ((device >> 32) & 0xffff_f000);
    let minor = (device & 0xff) | ((device >> 12) & 0xffff_ff00);
    (major as u32, minor as u32)
}

/// One bounded task view reused across that task's references. The owner must
/// recheck before switching tasks and before completing the capture.
pub struct NativeView {
    task: std::fs::File,
    root: std::fs::File,
    namespace: super::namespace::NamespaceSnapshot,
}

impl NativeView {
    pub fn capture(task: &std::fs::File, deadline: std::time::Instant) -> std::io::Result<Self> {
        use std::os::fd::AsRawFd;
        use super::objects;
        if std::time::Instant::now() >= deadline {
            return Err(std::io::Error::other("native mount snapshot deadline"));
        }
        let base = format!("/proc/self/fd/{}", task.as_raw_fd());
        let namespace = super::namespace::NamespaceSnapshot::capture(
            std::fs::File::open(format!("{base}/ns/mnt"))?, deadline)?;
        let root = objects::pin_magic(format!("{base}/root"))?;
        if !namespace.same_namespace(&std::fs::File::open(format!("{base}/ns/mnt"))?)? {
            return Err(std::io::Error::other("native task mount namespace changed"));
        }
        Ok(Self { task: task.try_clone()?, root, namespace })
    }

    pub fn is_task(&self, task: &std::fs::File) -> std::io::Result<bool> {
        use super::objects;
        Ok(objects::identity(&self.task)? == objects::identity(task)?
            && objects::mount_id(&self.task)? == objects::mount_id(task)?)
    }

    pub fn recheck(&self, deadline: std::time::Instant) -> std::io::Result<()> {
        use std::os::fd::AsRawFd;
        use super::objects;
        let base = format!("/proc/self/fd/{}", self.task.as_raw_fd());
        let root = objects::pin_magic(format!("{base}/root"))?;
        if std::time::Instant::now() >= deadline
            || !self.namespace.same_namespace(&std::fs::File::open(format!("{base}/ns/mnt"))?)?
            || objects::identity(&root)? != objects::identity(&self.root)?
            || objects::mount_id(&root)? != objects::mount_id(&self.root)?
        { return Err(std::io::Error::other("native task mount view changed")); }
        self.namespace.recheck(deadline)?;
        if !self.namespace.same_namespace(&std::fs::File::open(format!("{base}/ns/mnt"))?)? {
            return Err(std::io::Error::other("native task mount namespace changed"));
        }
        Ok(())
    }

    /// Reclose the pinned namespace, without reopening a departed task's proc entries.
    pub fn recheck_retained(&self, deadline: std::time::Instant) -> std::io::Result<()> {
        self.namespace.recheck(deadline)
    }

    pub fn mounts(&self) -> impl Iterator<Item = &super::namespace::NamespaceMount> {
        self.namespace.records().values()
    }

    pub fn namespace_id(&self) -> u64 { self.namespace.id() }

    pub fn pin_mount_root(&self, mount: &super::namespace::NamespaceMount, deadline: std::time::Instant)
        -> std::io::Result<NativeLocation>
    {
        use std::io;
        use super::{linux, objects};
        if std::time::Instant::now() >= deadline
            || !canonical(&mount.root) || !canonical(&mount.point)
        { return Err(io::Error::other("unobservable mounted root")); }
        let relative = mount.point.strip_prefix("/").map_err(io::Error::other)?;
        let point = objects::pin_beneath(&self.root,
            if relative.as_os_str().is_empty() { std::ffi::OsStr::new(".") }
            else { relative.as_os_str() })?;
        let device = objects::identity(&point)?.0;
        let filesystem = linux::filesystem_type(&point)?;
        if !objects::native_filesystem_type(filesystem, device) || filesystem != mount.filesystem
            || objects::mount_id(&point)? != mount.id
            || device_pair(device) != (mount.device_major, mount.device_minor)
        { return Err(io::Error::other("mounted root changed or shadowed")); }
        Ok(NativeLocation { device, filesystem,
            path: mount.root.clone(), _mountpoint: point })
    }

    pub fn location(&self, file: &std::fs::File,
        deadline: std::time::Instant) -> std::io::Result<NativeLocation>
    {
    use std::fs;
    use std::io;
    use std::os::fd::AsRawFd;
    use super::{linux, objects};
    let unknown = |_stage: &'static str| {
        #[cfg(holder_owned_vm_class_diagnostics)]
        eprintln!("worktree-holder-native-location-owned-vm reason={_stage}");
        io::Error::other("native mount backing unobservable or changed")
    };
    if std::time::Instant::now() >= deadline || !objects::native_filesystem(file)? {
        return Err(unknown("deadline-or-nonnative-filesystem"));
    }
    let held_mount = objects::mount_id(file)?;
    let mount = self.namespace.records().get(&held_mount).ok_or_else(|| unknown("held-mount-not-listed"))?;
    if !canonical(&mount.root) || !canonical(&mount.point) {
        return Err(unknown("noncanonical-mount-coordinate"));
    }
    let task_root = &self.root;
    let point_relative = mount.point.strip_prefix("/").map_err(|_| unknown("mount-point-relative"))?;
    let point = objects::pin_beneath(task_root,
        if point_relative.as_os_str().is_empty() { std::ffi::OsStr::new(".") }
        else { point_relative.as_os_str() })?;
    let held_identity = objects::identity(file)?;
    if objects::mount_id(&point)? != held_mount
        || objects::identity(&point)?.0 != held_identity.0
        || device_pair(held_identity.0) != (mount.device_major, mount.device_minor)
        || linux::filesystem_type(&point)? != linux::filesystem_type(file)?
    {
        return Err(unknown("mount-point-identity"));
    }
    let spelling = fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))?;
    let root_spelling = fs::read_link(format!("/proc/self/fd/{}", task_root.as_raw_fd()))?;
    let mut spellings = vec![spelling.clone()];
    if let Ok(relative) = spelling.strip_prefix(&root_spelling) {
        let inside = std::path::Path::new("/").join(relative);
        if inside != spelling { spellings.push(inside); }
    }
    let mut coordinate = None;
    for spelling in spellings {
        if !canonical(&spelling) { continue; }
        let Ok(relative) = spelling.strip_prefix(&mount.point) else { continue };
        let root_relative = spelling.strip_prefix("/").map_err(|_| unknown("held-spelling-relative"))?;
        let reopened = match objects::pin_beneath(task_root,
            if root_relative.as_os_str().is_empty() { std::ffi::OsStr::new(".") }
            else { root_relative.as_os_str() })
        {
            Ok(value) => value,
            Err(_) => continue,
        };
        if objects::identity(&reopened)? != held_identity
            || objects::mount_id(&reopened)? != held_mount { continue; }
        let path = if relative.as_os_str().is_empty() { mount.root.clone() }
            else { mount.root.join(relative) };
        if !canonical(&path) { return Err(unknown("invalid-object-coordinate")); }
        if coordinate.as_ref().is_some_and(|previous| previous != &path) {
            return Err(unknown("ambiguous-object-coordinate"));
        }
        coordinate = Some(path);
    }
    // The held name is rechecked per object; the complete task mount snapshot
    // is rechecked once at the task boundary, not parsed for every open FD.
    if std::time::Instant::now() >= deadline
        || objects::mount_id(file)? != held_mount
        || fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))? != spelling
    {
        return Err(unknown("held-view-recheck"));
    }
    Ok(NativeLocation { device: held_identity.0,
        filesystem: linux::filesystem_type(file)?,
        path: coordinate.ok_or_else(|| unknown("no-reopenable-coordinate"))?, _mountpoint: point })
}
}

pub fn native_location(file: &std::fs::File, task: &std::fs::File,
    deadline: std::time::Instant) -> std::io::Result<NativeLocation>
{
    let view = NativeView::capture(task, deadline)?;
    let location = view.location(file, deadline)?;
    view.recheck(deadline)?;
    Ok(location)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_native_coordinates_refuse_ambiguous_spellings() {
        for path in ["/pool//a", "/pool/../a", "/pool/./a", "/pool/a/", "relative", "/bad\nname"] {
            assert!(!canonical(std::path::Path::new(path)), "{path:?}");
        }
        assert!(canonical(std::path::Path::new("/")));
        assert!(canonical(std::path::Path::new("/pool/a b")));
        assert_eq!(device_pair(0x801), (8, 1));
        assert_eq!(device_pair(0x1000_0000), (0, 65536));
    }

    #[test]
    fn preserves_actual_mount_identity_and_escaped_paths() {
        let graph = parse("12 9 0:32 /lib/config /config\\040space rw,noatime shared:7 - zfs rpool/state rw,xattr\n").unwrap();
        let mount = &graph[&12];
        assert_eq!(mount.parent, 9);
        assert_eq!(mount.point, PathBuf::from("/config space"));
        assert_eq!(mount.root, PathBuf::from("/lib/config"));
        assert_eq!(mount.device_minor, 32);
        assert_eq!(mount.optional, ["shared:7"]);
    }

    #[test]
    fn refuses_truncated_ambiguous_and_duplicate_records() {
        let record = "12 9 0:32 / / rw - zfs rpool/state rw\n";
        assert!(parse(record.trim_end()).is_err());
        assert!(parse(&(record.to_owned() + record)).is_err());
        assert!(parse("12 9 0:32 / /bad\\000 rw - zfs rpool/state rw\n").is_err());
        assert!(parse("12 9 0:32 / /bad\\0 rw - zfs rpool/state rw\n").is_err());
        assert!(parse("12 9 0:32 relative / rw - zfs rpool/state rw\n").is_err());
        assert!(parse("12 9 0:32 / / rw - zfs rpool/state rw extra\n").is_err());
    }
}
