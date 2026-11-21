use std::fs::File;
use std::io;
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::time::Instant;

use super::{linux, objects, request::StoreRequest};

pub const LEASE_NAME: &str = ".effect-utils-pnpm-store-cache-maintenance.lock";

pub use worktree_holder_proc::process::{Process, process, uids};
fn before(deadline: Instant) -> io::Result<()> {
    if Instant::now() >= deadline {
        Err(io::Error::other("client attestation deadline"))
    } else {
        Ok(())
    }
}

fn live(entry: &Process, pidfd: &OwnedFd, uid: u32) -> io::Result<()> {
    let current = process(entry.pid)?;
    if linux::pidfd_terminated(pidfd)? || !current.same_identity(entry)
        || matches!(current.state, b'Z' | b'X') || uids(entry.pid)? != [uid; 4]
    {
        return Err(io::Error::other("process lifetime or credentials changed"));
    }
    linux::require_process_initial_user_namespace(pidfd)
}

fn same_object(left: &File, right: &File) -> io::Result<bool> {
    Ok(objects::identity(left)? == objects::identity(right)?
        && objects::mount_id(left)? == objects::mount_id(right)?)
}

fn compiled_executable() -> io::Result<File> {
    let output = env!("HOLDER_EVIDENCE_PRODUCER_ID");
    if !output.starts_with("/nix/store/") || output[11..].contains('/') {
        return Err(io::Error::other("invalid immutable producer output"));
    }
    let root = File::open("/")?;
    let executable = objects::pin_beneath(&root,
        Path::new(output).join("bin/worktree-holder-evidence").strip_prefix("/")
            .map_err(|_| io::Error::other("nonabsolute producer executable"))?.as_os_str())?;
    let metadata = executable.metadata()?;
    if !metadata.is_file() || metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
        return Err(io::Error::other("mutable producer executable"));
    }
    Ok(executable)
}

fn process_executable(pid: u32) -> io::Result<File> {
    objects::pin_magic(Path::new(&format!("/proc/{pid}/exe")))
}

/// Credentials originate in SO_PEERCRED, never request JSON or environment.
pub struct Peer {
    pub process: Process,
    pub pidfd: OwnedFd,
    executable: File,
    root: File,
    mount_namespace: File,
    pub uid: u32,
}

impl Peer {
    pub fn attest(socket: &File, expected_uid: u32, deadline: Instant) -> io::Result<Self> {
        before(deadline)?;
        let (pid, uid, _) = linux::socket_peer_credentials(socket)?;
        if uid != expected_uid {
            return Err(io::Error::other("unconfigured socket peer"));
        }
        let process = process(pid)?;
        let pidfd = linux::pin_process(pid)?;
        let executable = compiled_executable()?;
        let root = objects::pin_magic(format!("/proc/{pid}/root"))?;
        let mount_namespace = objects::pin_magic(format!("/proc/{pid}/ns/mnt"))?;
        let peer = Self { process, pidfd, executable, root, mount_namespace, uid };
        peer.recheck(deadline)?;
        Ok(peer)
    }

    pub fn recheck(&self, deadline: Instant) -> io::Result<()> {
        before(deadline)?;
        live(&self.process, &self.pidfd, self.uid)?;
        if !same_object(&self.executable, &process_executable(self.process.pid)?)? {
            return Err(io::Error::other("socket peer executable changed"));
        }
        if !same_object(&self.root, &objects::pin_magic(format!("/proc/{}/root", self.process.pid))?)?
            || !same_object(&self.mount_namespace, &objects::pin_magic(format!("/proc/{}/ns/mnt", self.process.pid))?)?
        {
            return Err(io::Error::other("socket peer root or mount namespace changed"));
        }
        before(deadline)
    }
}
/// Wire root mount IDs describe the authenticated client view, not the
/// reader's initial mount namespace. Physical dev/ino must match enrollment.
pub struct PeerRoots {
    roots: Vec<(std::path::PathBuf, File)>,
}


impl PeerRoots {
    pub fn root(&self, index: usize) -> &File { &self.roots[index].1 }

    pub fn pin(peer: &Peer, candidates: &super::candidates::CandidateSet,
        deadline: Instant) -> io::Result<Self>
    {
        let mut roots = Vec::with_capacity(candidates.len());
        for index in 0..candidates.len() {
            before(deadline)?;
            let candidate = candidates.get(index);
            let relative = candidate.path.strip_prefix("/")
                .map_err(|_| io::Error::other("nonabsolute peer candidate"))?;
            let root = objects::pin_beneath(&peer.root, relative.as_os_str())?;
            if !root.metadata()?.is_dir()
                || objects::identity(&root)? != objects::identity(&candidate.root)?
            {
                return Err(io::Error::other("peer root differs from enrolled native root"));
            }
            roots.push((candidate.path.clone(), root));
        }
        let pins = Self { roots };
        pins.recheck(peer, deadline)?;
        Ok(pins)
    }

    pub fn recheck(&self, peer: &Peer, deadline: Instant) -> io::Result<()> {
        peer.recheck(deadline)?;
        for (path, root) in &self.roots {
            before(deadline)?;
            let relative = path.strip_prefix("/")
                .map_err(|_| io::Error::other("nonabsolute peer candidate"))?;
            let current = objects::pin_beneath(&peer.root, relative.as_os_str())?;
            if !same_object(root, &current)? {
                return Err(io::Error::other("peer-visible root path or mount changed"));
            }
        }
        Ok(())
    }

    pub fn bind(&self, observation: &mut super::protocol::Observation) -> io::Result<()> {
        if self.roots.len() != observation.roots.len() {
            return Err(io::Error::other("peer root coverage mismatch"));
        }
        observation.receipt.extend_from_slice(b"holder-evidence-peer-roots-v1\0");
        for ((path, root), evidence) in self.roots.iter().zip(&mut observation.roots) {
            let (dev, ino) = objects::identity(root)?;
            let mount_id = objects::mount_id(root)?;
            if &evidence.path != path
                || evidence.identity.as_ref().is_none_or(|id| (id.dev, id.ino) != (dev, ino))
            {
                return Err(io::Error::other("peer root evidence identity mismatch"));
            }
            evidence.identity.as_mut().expect("checked root identity").mount_id = mount_id;
            use std::os::unix::ffi::OsStrExt;
            observation.receipt.extend_from_slice(path.as_os_str().as_bytes());
            observation.receipt.push(0);
            for value in [dev, ino, mount_id] {
                observation.receipt.extend_from_slice(value.to_string().as_bytes());
                observation.receipt.push(0);
            }
        }
        Ok(())
    }
}

/// Bootstrap authenticates the reader before opening candidate/proc metadata
/// pins. Subsequent descriptors originate only in this fixed reader: it never
/// accepts SCM_RIGHTS. This is a source-bound role, not a PID/name exemption.
pub struct SelfRole {
    process: Process,
    pidfd: OwnedFd,
    namespaces: [u64; 4],
    root: File,
    cwd: File,
    executable: File,
    stdio: [File; 3],
}

impl SelfRole {
    pub fn bootstrap(socket: &File, deadline: Instant) -> io::Result<Self> {
        before(deadline)?;
        let namespaces = linux::initial_namespace_ids()?;
        let pid = std::process::id();
        let process = process(pid)?;
        let tasks: Vec<_> = std::fs::read_dir(format!("/proc/{pid}/task"))?
            .collect::<Result<_, _>>()?;
        if tasks.len() != 1 || tasks[0].file_name() != pid.to_string().as_str() {
            return Err(io::Error::other("reader bootstrap is not single-threaded"));
        }
        drop(tasks);
        // read_dir's own transient descriptor is closed before classification.
        let numbers: Vec<_> = std::fs::read_dir("/proc/self/fd")?
            .map(|entry| entry.and_then(|entry| entry.file_name().to_string_lossy()
                .parse::<i32>().map_err(|_| io::Error::other("invalid reader descriptor"))))
            .collect::<Result<_, _>>()?;
        for number in numbers {
            if number <= 2 {
                continue;
            }
            match linux::same_own_descriptor(number, socket) {
                Ok(true) => {}
                Err(error) if error.raw_os_error() == Some(9) => {}
                _ => return Err(io::Error::other("unexpected inherited reader capability")),
            }
        }
        let stdio = [
            File::from(linux::duplicate_own_descriptor(0)?),
            File::from(linux::duplicate_own_descriptor(1)?),
            File::from(linux::duplicate_own_descriptor(2)?),
        ];
        if !linux::same_open_file(&stdio[0], socket)?
            || !linux::same_open_file(&stdio[1], socket)?
            || linux::same_open_file(&stdio[2], socket)?
            || linux::socket_peer_credentials(&stdio[2])?.1 != 0
        {
            return Err(io::Error::other("unproved reader standard streams"));
        }
        let pidfd = linux::pin_process(pid)?;
        let root = objects::pin_magic(Path::new("/proc/self/root"))?;
        let cwd = objects::pin_magic(Path::new("/proc/self/cwd"))?;
        let host_root = objects::pin_magic(Path::new("/proc/1/root"))?;
        if !same_object(&root, &host_root)? || !same_object(&cwd, &root)? {
            return Err(io::Error::other("reader is chrooted or has a non-root cwd"));
        }
        let executable = compiled_executable()?;
        let role = Self { process, pidfd, namespaces, root, cwd, executable, stdio };
        role.recheck(deadline)?;
        Ok(role)
    }

    pub fn pid(&self) -> u32 { self.process.pid }

    pub fn namespace_ids(&self) -> [u64; 4] { self.namespaces }

    pub fn recheck(&self, deadline: Instant) -> io::Result<()> {
        before(deadline)?;
        live(&self.process, &self.pidfd, 0)?;
        if linux::initial_namespace_ids()? != self.namespaces
            || !same_object(&self.root, &objects::pin_magic(Path::new("/proc/self/root"))?)?
            || !same_object(&self.cwd, &objects::pin_magic(Path::new("/proc/self/cwd"))?)?
            || !same_object(&self.executable, &process_executable(self.process.pid)?)?
        {
            return Err(io::Error::other("reader management role changed"));
        }
        for (number, descriptor) in self.stdio.iter().enumerate() {
            if !linux::same_own_descriptor(number as i32, descriptor)? {
                return Err(io::Error::other("reader standard stream changed"));
            }
        }
        before(deadline)
    }
}

pub struct Client {
    pub process: Process,
    pub pidfd: OwnedFd,
    pub root: File,
    pub lease: File,
    expected_uid: u32,
}

impl Client {
    /// The immutable adapter's actual parent owns the original GC descriptors.
    /// No sudo ancestry, environment PID, or caller-selected PID is accepted.
    pub fn attest_from_peer(peer: &Peer, request: &StoreRequest,
        expected_uid: u32, candidate: &File) -> io::Result<Self>
    {
        let owner = process(peer.process.parent)?;
        if owner.start != request.client_start || owner.pid <= 1 {
            return Err(io::Error::other("original GC lifetime mismatch"));
        }
        let pidfd = linux::pin_process(owner.pid)?;
        live(&owner, &pidfd, expected_uid)?;
        let root = objects::duplicate_client_fd(&pidfd, request.root_fd)?;
        let lease = objects::duplicate_client_fd(&pidfd, request.lease_fd)?;
        let metadata = root.metadata()?;
        if !metadata.is_dir() || metadata.uid() != expected_uid
            || (metadata.dev(), metadata.ino()) != (request.device, request.inode)
            || !same_object(&root, candidate)?
        {
            return Err(io::Error::other("admitted root descriptor mismatch"));
        }
        let client = Self { process: owner, pidfd, root, lease, expected_uid };
        client.recheck(request)?;
        Ok(client)
    }

    pub fn recheck(&self, request: &StoreRequest) -> io::Result<()> {
        live(&self.process, &self.pidfd, self.expected_uid)?;
        let actual_lease = objects::pin_beneath(&self.root, std::ffi::OsStr::new(LEASE_NAME))?;
        let metadata = self.lease.metadata()?;
        if !metadata.is_file() || metadata.uid() != self.expected_uid
            || metadata.mode() & 0o7777 != 0o600
            || !same_object(&self.lease, &actual_lease)?
            || objects::mount_id(&self.lease)? != objects::mount_id(&self.root)?
        {
            return Err(io::Error::other("maintenance lease identity mismatch"));
        }
        require_existing_exclusive_lease(&self.lease)?;
        for (number, expected) in [(request.root_fd, &self.root), (request.lease_fd, &self.lease)] {
            let current = objects::duplicate_client_fd(&self.pidfd, number)?;
            if !same_object(&current, expected)?
                || !linux::same_open_file(&current, expected)?
            {
                return Err(io::Error::other("original GC descriptor/OFD changed"));
            }
        }
        Ok(())
    }
}

/// fdinfo is generated for this exact retained struct file/OFD. A global
/// /proc/locks PID+inode match would not authenticate that OFD. Never call flock:
/// acquiring a missing lock here would manufacture admission instead of prove it.
fn require_existing_exclusive_lease(lease: &File) -> io::Result<()> {
    let info = objects::bounded_text(format!("/proc/self/fdinfo/{}", lease.as_raw_fd()), 64 * 1024)?;
    let metadata = lease.metadata()?;
    let device = metadata.dev();
    let major = ((device >> 8) & 0xfff) | ((device >> 32) & 0xfffff000);
    let minor = (device & 0xff) | ((device >> 12) & 0xffffff00);
    let records: Vec<_> = info.lines().filter_map(|line| line.strip_prefix("lock:"))
        .map(|line| line.split_whitespace().collect::<Vec<_>>()).collect();
    if records.len() != 1 {
        return Err(io::Error::other("missing or ambiguous OFD lease evidence"));
    }
    let fields = &records[0];
    // Canonical GC acquires FLOCK in a short-lived child, retaining the same
    // OFD in its parent. The saved creator PID is syntax, not authentication.
    // Authentication is pidfd_getfd plus this exact retained file's fdinfo.
    let creator = fields.get(4).copied().unwrap_or_default();
    let digits = creator.strip_prefix('-').unwrap_or(creator);
    if fields.len() != 8 || fields[1..4] != ["FLOCK", "ADVISORY", "WRITE"]
        || digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit())
        || creator.parse::<i32>().is_err() || fields[6..] != ["0", "EOF"]
    {
        return Err(io::Error::other("no existing exclusive lease on caller's retained OFD"));
    }
    let identity: Vec<_> = fields[5].split(':').collect();
    if identity.len() != 3 || u64::from_str_radix(identity[0], 16).ok() != Some(major)
        || u64::from_str_radix(identity[1], 16).ok() != Some(minor)
        || identity[2].parse::<u64>().ok() != Some(metadata.ino())
    {
        return Err(io::Error::other("exclusive lease OFD inode mismatch"));
    }
    Ok(())
}

