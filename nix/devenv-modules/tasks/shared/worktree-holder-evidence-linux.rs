//! Narrow Linux syscall boundary for the read-only namespace evidence helper.
//! Descriptor duplication never accepts an arbitrary caller-supplied process ID.
use std::ffi::{CStr, CString};
use std::fs::File;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::raw::{c_int, c_long};
use std::os::unix::fs::{FileTypeExt, MetadataExt};

#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
compile_error!("namespace evidence syscall numbers require x86_64 or aarch64");

const SYS_PIDFD_OPEN: c_long = 434;
const SYS_PIDFD_GETFD: c_long = 438;
const SYS_OPENAT2: c_long = 437;
#[cfg(target_arch = "x86_64")]
const SYS_KCMP: c_long = 312;
#[cfg(target_arch = "aarch64")]
const SYS_KCMP: c_long = 272;
const O_PATH: u64 = 0x200000;
const O_CLOEXEC: u64 = 0x80000;
#[cfg(target_arch = "x86_64")]
pub const O_DIRECTORY: u64 = 0x10000;
#[cfg(target_arch = "aarch64")]
pub const O_DIRECTORY: u64 = 0x4000;
pub const RESOLVE_NO_MAGICLINKS: u64 = 0x02;
pub const RESOLVE_NO_SYMLINKS: u64 = 0x04;
pub const RESOLVE_BENEATH: u64 = 0x08;
pub const RESOLVE_IN_ROOT: u64 = 0x10;

#[repr(C)]
struct OpenHow {
    flags: u64,
    mode: u64,
    resolve: u64,
}

#[repr(C)]
struct Timespec { seconds: c_long, nanoseconds: c_long }

unsafe extern "C" {
    fn syscall(number: c_long, ...) -> c_long;
    fn fstatfs(fd: c_int, buffer: *mut u64) -> c_int;
    fn ioctl(fd: c_int, request: u64, ...) -> c_int;
    fn getsockopt(fd: c_int, level: c_int, option: c_int, value: *mut std::ffi::c_void, length: *mut u32) -> c_int;
    fn getuid() -> u32;
    fn geteuid() -> u32;
    fn signal(number: c_int, handler: usize) -> usize;
    fn alarm(seconds: u32) -> u32;
    fn prctl(option: c_int, ...) -> c_int;
    fn getppid() -> c_int;
    fn socket(domain: c_int, kind: c_int, protocol: c_int) -> c_int;
    fn getsockname(fd: c_int, address: *mut UnixAddress, length: *mut u32) -> c_int;
    fn fcntl(fd: c_int, command: c_int, ...) -> c_int;
    fn connect(fd: c_int, address: *const UnixAddress, length: u32) -> c_int;
    fn poll(descriptors: *mut PollDescriptor, count: usize, timeout: c_int) -> c_int;
    fn clock_gettime(clock: c_int, time: *mut Timespec) -> c_int;
}

fn descriptor(result: c_long) -> io::Result<OwnedFd> {
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    let fd = c_int::try_from(result)
        .map_err(|_| io::Error::other("kernel returned out-of-range descriptor"))?;
    // SAFETY: the successful descriptor-creating syscall transfers ownership of
    // this fresh descriptor; OwnedFd closes it exactly once.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

pub fn pin_process(pid: u32) -> io::Result<OwnedFd> {
    // SAFETY: pidfd_open takes scalar PID/flags and returns an owned descriptor.
    descriptor(unsafe { syscall(SYS_PIDFD_OPEN, c_long::from(pid), 0 as c_int) })
}

pub fn pin_client_task(tid: u32) -> io::Result<OwnedFd> {
    // Linux PIDFD_THREAD is O_EXCL on both supported architectures. Callers
    // derive this TID from the authenticated client's actual proc task directory.
    // SAFETY: scalar PID/flags; success transfers a fresh pidfd to OwnedFd.
    descriptor(unsafe { syscall(SYS_PIDFD_OPEN, c_long::from(tid), 0x80 as c_int) })
}

pub fn duplicate_process_fd(process: &OwnedFd, fd: i32) -> io::Result<OwnedFd> {
    if fd < 3 {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "standard descriptor is not an admitted lease/root"));
    }
    // SAFETY: pidfd remains live, fd is a scalar descriptor number, flags must
    // be zero. The caller must already have attested the actual client ancestry.
    descriptor(unsafe { syscall(SYS_PIDFD_GETFD, process.as_raw_fd(), fd, 0 as c_int) })
}

pub fn open_path(directory: c_int, path: &CStr, flags: u64, resolve: u64) -> io::Result<OwnedFd> {
    let how = OpenHow { flags: O_PATH | O_CLOEXEC | flags, mode: 0, resolve };
    // SAFETY: path is NUL-terminated, OpenHow is Linux's repr(C) ABI, all
    // pointers and the supplied exact structure size remain valid for the call.
    descriptor(unsafe {
        syscall(SYS_OPENAT2, directory, path.as_ptr(), &how as *const OpenHow, std::mem::size_of::<OpenHow>())
    })
}

pub fn filesystem_type(fd: &impl AsRawFd) -> io::Result<u64> {
    // Linux struct statfs is smaller than this aligned buffer on both supported
    // 64-bit ABIs. Its first word is the signed long f_type on both architectures.
    let mut buffer = [0_u64; 32];
    // SAFETY: the buffer is writable, suitably aligned, larger than statfs and
    // remains live for the call; fd is an owned live descriptor.
    if unsafe { fstatfs(fd.as_raw_fd(), buffer.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(buffer[0])
}

pub fn is_real_root() -> bool {
    // SAFETY: getuid/geteuid have no arguments or memory effects.
    unsafe { getuid() == 0 && geteuid() == 0 }
}

/// These reserved identities come from Linux uapi/linux/nsfs.h, not proc paths.
const INITIAL_NAMESPACES: [(u64, c_int, u64); 4] = [
    (0xff09, 0x10000000, 0xeffffffd),
    (0xff05, 0x20000000, 0xeffffffc),
    (0xff03, 0x00020000, 0xeffffff8),
    (0xff04, 0x40000000, 0xeffffff9),
];

fn initial_namespace(process: &OwnedFd, command: u64, kind: c_int, inode: u64) -> io::Result<u64> {
    // SAFETY: a fixed pidfd GET_*_NAMESPACE ioctl returns a fresh namespace FD.
    let fd = descriptor(c_long::from(unsafe { ioctl(process.as_raw_fd(), command, 0) }))?;
    if filesystem_type(&fd)? != 0x6e736673 {
        return Err(io::Error::other("namespace descriptor is not nsfs"));
    }
    // SAFETY: NS_GET_NSTYPE reads an integer kind, with no pointer arguments.
    let actual_kind = unsafe { ioctl(fd.as_raw_fd(), 0xb703, 0) };
    let file = File::from(fd);
    let actual_inode = file.metadata()?.ino();
    if actual_kind != kind || actual_inode != inode {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "not the initial host namespace"));
    }
    Ok(actual_inode)
}

pub fn initial_namespace_ids() -> io::Result<[u64; 4]> {
    if !is_real_root() {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "real and effective host root required"));
    }
    let process = pin_process(std::process::id())?;
    let mut result = [0; 4];
    for (index, (command, kind, inode)) in INITIAL_NAMESPACES.into_iter().enumerate() {
        result[index] = initial_namespace(&process, command, kind, inode)?;
    }
    Ok(result)
}

pub fn require_process_initial_user_namespace(process: &OwnedFd) -> io::Result<()> {
    let (command, kind, inode) = INITIAL_NAMESPACES[0];
    initial_namespace(process, command, kind, inode).map(|_| ())
}

fn require_initial_user_namespace() -> io::Result<()> {
    let process = pin_process(std::process::id())?;
    require_process_initial_user_namespace(&process)
}

#[repr(C)]
#[derive(Debug)]
pub struct Peer {
    pub pid: c_int,
    pub uid: u32,
    pub gid: u32,
}

pub fn socket_peer(socket: &impl AsRawFd) -> io::Result<Peer> {
    let mut peer = Peer { pid: -1, uid: u32::MAX, gid: u32::MAX };
    let mut length = std::mem::size_of::<Peer>() as u32;
    // SAFETY: Peer is Linux's repr(C) ucred and the exact writable buffer size
    // is provided. SOL_SOCKET/SO_PEERCRED read the connected socket's peer.
    if unsafe { getsockopt(socket.as_raw_fd(), 1, 17, (&mut peer as *mut Peer).cast(), &mut length) } != 0 {
        return Err(io::Error::last_os_error());
    }
    if length as usize != std::mem::size_of::<Peer>() || peer.pid <= 0 {
        return Err(io::Error::other("incomplete Unix peer credentials"));
    }
    Ok(peer)
}

pub fn socket_peer_credentials(socket: &impl AsRawFd) -> io::Result<(u32, u32, u32)> {
    let peer = socket_peer(socket)?;
    let pid = u32::try_from(peer.pid).map_err(|_| io::Error::other("invalid peer PID"))?;
    Ok((pid, peer.uid, peer.gid))
}

pub fn boot_time_ns() -> io::Result<u64> {
    let mut time = Timespec { seconds: 0, nanoseconds: 0 };
    // SAFETY: CLOCK_BOOTTIME=7 writes one live, aligned timespec. Both supported
    // Linux architectures have 64-bit time_t/long; no time32 translation occurs.
    if unsafe { clock_gettime(7, &mut time) } != 0 {
        return Err(io::Error::last_os_error());
    }
    if time.seconds < 0 || !(0..1_000_000_000).contains(&time.nanoseconds) {
        return Err(io::Error::other("invalid kernel boot clock"));
    }
    (time.seconds as u64).checked_mul(1_000_000_000)
        .and_then(|seconds| seconds.checked_add(time.nanoseconds as u64))
        .ok_or_else(|| io::Error::other("boot clock overflow"))
}

pub fn duplicate_own_descriptor(number: c_int) -> io::Result<OwnedFd> {
    if number < 0 {
        return Err(io::Error::other("negative own descriptor"));
    }
    // SAFETY: fixed F_DUPFD_CLOEXEC reads only this process's live FD table and
    // returns a new descriptor >=3; the source is never closed or changed.
    descriptor(c_long::from(unsafe { fcntl(number, 1030, 3 as c_int) }))
}

pub fn same_own_descriptor(number: c_int, expected: &impl AsRawFd) -> io::Result<bool> {
    let current = duplicate_own_descriptor(number)?;
    same_open_file(&current, expected)
}

pub fn inherited_evidence_socket() -> io::Result<File> {
    let socket = File::from(duplicate_own_descriptor(0)?);
    if !socket.metadata()?.file_type().is_socket()
        || socket_integer(&socket, 39)? != 1 || socket_integer(&socket, 3)? != 1
        || socket_integer(&socket, 30)? != 0
    {
        return Err(io::Error::other("stdin is not a connected Unix evidence stream"));
    }
    let mut address = UnixAddress { family: 0, path: [0; 108] };
    let mut length = std::mem::size_of::<UnixAddress>() as u32;
    // SAFETY: one live sockaddr_un and its exact length receive local metadata.
    if unsafe { getsockname(socket.as_raw_fd(), &mut address, &mut length) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let expected = b"/run/worktree-holder-evidence/evidence.sock\0";
    if address.family != 1 || length as usize != 2 + expected.len()
        || &address.path[..expected.len()] != expected
    {
        return Err(io::Error::other("inherited socket is not the fixed evidence endpoint"));
    }
    Ok(socket)
}

/// Read-only readiness on a genuine pidfd: no signal, wait/reap or PID lookup.
pub fn pidfd_terminated(process: &impl AsRawFd) -> io::Result<bool> {
    if filesystem_type(process)? != 0x50494446 {
        return Err(io::Error::other("liveness descriptor is not pidfs"));
    }
    let mut descriptor = PollDescriptor { fd: process.as_raw_fd(), events: 1, returned: 0 };
    // SAFETY: poll receives one live pollfd and a zero timeout.
    let answer = unsafe { poll(&mut descriptor, 1, 0) };
    if answer < 0 { return Err(io::Error::last_os_error()); }
    if answer == 0 { return Ok(false); }
    if answer != 1 || descriptor.returned & !(1 | 16) != 0 {
        return Err(io::Error::other("unqualified pidfd readiness"));
    }
    Ok(descriptor.returned & (1 | 16) != 0)
}

/// A blocking local socket connect or proc operation must not outlive the
/// consumer's thirty-second bound. Install the default fatal SIGALRM disposition
/// explicitly, rather than inheriting an ignored signal from the caller.
pub fn bound_helper_lifetime() -> io::Result<()> {
    // SAFETY: SIGALRM=14 and SIG_DFL=0 are the supported Linux signal ABI;
    // signal returns SIG_ERR on failure. No Rust signal handler is installed.
    if unsafe { signal(14, 0) } == usize::MAX {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: alarm accepts a scalar duration and schedules the default fatal
    // signal. Descriptor ownership is released by kernel process teardown.
    unsafe { alarm(25); }
    Ok(())
}

pub fn bind_child_lifetime(command: &mut std::process::Command) {
    use std::os::unix::process::CommandExt;
    let parent = std::process::id() as c_int;
    // SAFETY: this pre-exec closure performs only async-signal-safe Linux
    // prctl/getppid calls and errno inspection. It allocates no memory.
    unsafe {
        command.pre_exec(move || {
            // PR_SET_PDEATHSIG/SIGKILL ensures our fixed pure decoder cannot
            // survive the helper's global deadline. Recheck parent after the
            // prctl to close the parent-died-before-registration race.
            if prctl(1, 9 as c_int) != 0 {
                return Err(io::Error::last_os_error());
            }
            if getppid() != parent {
                return Err(io::Error::from_raw_os_error(3));
            }
            Ok(())
        });
    }
}


#[repr(C)]
struct UnixAddress {
    family: u16,
    path: [u8; 108],
}

#[repr(C)]
struct PollDescriptor {
    fd: c_int,
    events: i16,
    returned: i16,
}

pub fn connect_unix(path: &str, deadline: std::time::Instant) -> io::Result<std::os::unix::net::UnixStream> {
    if path != "/run/docker.sock" {
        return Err(io::Error::other("unadmitted Docker endpoint"));
    }
    connect_fixed_path(path, deadline)
}

fn pin_evidence_path() -> io::Result<File> {
    let mut current = File::open("/")?;
    for (name, directory) in [
        ("/", true), ("run", true), ("worktree-holder-evidence", true), ("evidence.sock", false),
    ] {
        if name != "/" {
            let name = CString::new(name).map_err(|_| io::Error::other("invalid compiled socket component"))?;
            current = File::from(open_path(current.as_raw_fd(), &name,
                if directory { O_DIRECTORY } else { 0 },
                RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS)?);
        }
        let stat = current.metadata()?;
        if stat.uid() != 0 || (directory && (!stat.is_dir() || stat.mode() & 0o022 != 0))
            || (!directory && (!stat.file_type().is_socket() || stat.mode() & 0o777 != 0o660))
        {
            return Err(io::Error::other("evidence socket ancestry is not root controlled"));
        }
    }
    Ok(current)
}

pub fn connect_evidence(deadline: std::time::Instant) -> io::Result<std::os::unix::net::UnixStream> {
    require_initial_user_namespace()?;
    let expected_uid = env!("HOLDER_EVIDENCE_UID").parse::<u32>()
        .map_err(|_| io::Error::other("invalid compiled evidence owner"))?;
    // SAFETY: scalar current-process UID getters, no memory arguments.
    if unsafe { getuid() != expected_uid || geteuid() != expected_uid } {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "evidence client is not the enrolled user"));
    }
    let pinned = pin_evidence_path()?;
    let stream = connect_fixed_path("/run/worktree-holder-evidence/evidence.sock", deadline)?;
    let peer = socket_peer(&stream)?;
    let current = pin_evidence_path()?;
    let before = pinned.metadata()?;
    let after = current.metadata()?;
    if peer.uid != 0 || peer.gid != 0 || (before.dev(), before.ino()) != (after.dev(), after.ino())
        || super::objects::mount_id(&pinned)? != super::objects::mount_id(&current)?
    {
        return Err(io::Error::other("evidence endpoint changed or peer is not host root"));
    }
    Ok(stream)
}

fn connect_fixed_path(path: &str, deadline: std::time::Instant) -> io::Result<std::os::unix::net::UnixStream> {
    if path.len() >= 108 || path.as_bytes().contains(&0) {
        return Err(io::Error::other("invalid fixed Unix endpoint"));
    }
    if std::time::Instant::now() >= deadline {
        return Err(io::Error::new(io::ErrorKind::TimedOut, "Unix connect deadline"));
    }
    // SAFETY: fixed AF_UNIX/SOCK_STREAM with atomic CLOEXEC|NONBLOCK flags.
    let socket = descriptor(c_long::from(unsafe { socket(1, 1 | 0x80000 | 0x800, 0) }))?;
    let mut address = UnixAddress { family: 1, path: [0; 108] };
    address.path[..path.len()].copy_from_slice(path.as_bytes());
    let length = (std::mem::size_of::<u16>() + path.len() + 1) as u32;
    // SAFETY: the fixed NUL-terminated sockaddr_un fits its exact bounded size.
    let status = unsafe { connect(socket.as_raw_fd(), &address, length) };
    if status != 0 {
        let error = io::Error::last_os_error();
        // AF_UNIX EAGAIN can mean a full backlog without a queued connection;
        // do not mistake POLLOUT on such an unconnected socket for admission.
        if error.raw_os_error() != Some(115) {
            return Err(error);
        }
        loop {
            let now = std::time::Instant::now();
            if now >= deadline {
                return Err(io::Error::new(io::ErrorKind::TimedOut, "Unix connect deadline"));
            }
            let timeout = deadline.duration_since(now).as_millis().clamp(1, c_int::MAX as u128) as c_int;
            let mut descriptor = PollDescriptor { fd: socket.as_raw_fd(), events: 4, returned: 0 };
            // SAFETY: poll receives one live, writable repr(C) pollfd and a
            // finite remaining timeout; interrupted waits recompute the bound.
            let ready = unsafe { poll(&mut descriptor, 1, timeout) };
            if ready < 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(4) { continue; }
                return Err(error);
            }
            if ready == 0 {
                continue;
            }
            if ready != 1 || descriptor.returned & 0x20 != 0 || descriptor.returned & (4 | 8 | 16) == 0 {
                return Err(io::Error::other("unexpected Unix connection poll state"));
            }
            break;
        }
    }
    let mut error: c_int = 0;
    let mut error_length = std::mem::size_of::<c_int>() as u32;
    // SAFETY: SOL_SOCKET/SO_ERROR writes one exact writable int.
    if unsafe { getsockopt(socket.as_raw_fd(), 1, 4, (&mut error as *mut c_int).cast(), &mut error_length) } != 0 {
        return Err(io::Error::last_os_error());
    }
    if error_length != std::mem::size_of::<c_int>() as u32 {
        return Err(io::Error::other("incomplete Unix connection error status"));
    }
    if error != 0 {
        return Err(io::Error::from_raw_os_error(error));
    }
    let stream = std::os::unix::net::UnixStream::from(socket);
    stream.set_nonblocking(false)?;
    Ok(stream)
}

/// Compare two retained helper-owned descriptors, never moving remote FD slots.
pub fn same_open_file(left: &impl AsRawFd, right: &impl AsRawFd) -> io::Result<bool> {
    let pid = c_long::from(std::process::id());
    // SAFETY: KCMP_FILE=0 reads only two current-process, live descriptor slots.
    let answer = unsafe { syscall(SYS_KCMP, pid, pid, 0 as c_int, c_long::from(left.as_raw_fd()), c_long::from(right.as_raw_fd())) };
    if answer < 0 { return Err(io::Error::last_os_error()); }
    Ok(answer == 0)
}

fn socket_integer(socket: &impl AsRawFd, option: c_int) -> io::Result<c_int> {
    let mut value: c_int = 0;
    let mut length = std::mem::size_of::<c_int>() as u32;
    // SAFETY: each caller uses a fixed SOL_SOCKET integer getter; the writable
    // int buffer and exact length remain valid throughout the read-only call.
    if unsafe { getsockopt(socket.as_raw_fd(), 1, option, (&mut value as *mut c_int).cast(), &mut length) } != 0 {
        return Err(io::Error::last_os_error());
    }
    if length != std::mem::size_of::<c_int>() as u32 {
        return Err(io::Error::other("incomplete socket integer metadata"));
    }
    Ok(value)
}

fn require_cloexec(fd: OwnedFd) -> io::Result<OwnedFd> {
    // SAFETY: F_GETFD=1 reads flags of this fresh owned descriptor.
    let flags = unsafe { fcntl(fd.as_raw_fd(), 1) };
    if flags < 0 { return Err(io::Error::last_os_error()); }
    if flags & 1 == 0 {
        return Err(io::Error::other("kernel metadata descriptor is not close-on-exec"));
    }
    Ok(fd)
}

/// SIOCUNIXFILE opens the socket's actual retained struct path with O_PATH.
/// Unlike UNIX_DIAG_VFS, this retains mount identity and full-width dev/inode.
/// Only the fixed configured Docker pathname is a candidate for this proof.
pub fn fixed_listener_path(socket: &File) -> io::Result<Option<OwnedFd>> {
    if socket_integer(socket, 39)? != 1 || socket_integer(socket, 3)? != 1
        || socket_integer(socket, 30)? != 1
    {
        return Ok(None);
    }
    let mut address = UnixAddress { family: 0, path: [0; 108] };
    let mut length = std::mem::size_of::<UnixAddress>() as u32;
    // SAFETY: getsockname writes one exact sockaddr_un and updates its length.
    if unsafe { getsockname(socket.as_raw_fd(), &mut address, &mut length) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let expected = b"/run/docker.sock\0";
    if address.family != 1 || length > std::mem::size_of::<UnixAddress>() as u32 {
        return Err(io::Error::other("invalid Unix listener address"));
    }
    if length as usize != std::mem::size_of::<u16>() + expected.len()
        || &address.path[..expected.len()] != expected
    {
        return Ok(None);
    }
    // SAFETY: fixed SIOCUNIXFILE=0x89e0 is a read-only AF_UNIX path query.
    // It returns a fresh O_PATH|CLOEXEC descriptor and requires CAP_NET_ADMIN
    // in the socket's network namespace; no socket queue is consumed.
    let bound = descriptor(c_long::from(unsafe { ioctl(socket.as_raw_fd(), 0x89e0, 0) }))?;
    require_cloexec(bound).map(Some)
}

/// Follow only the kernel parent relation of an actual typed PID namespace.
/// Absence is authorized only for the reserved genuine initial PID namespace.
pub fn pid_namespace_parent(namespace: &File) -> io::Result<Option<File>> {
    if filesystem_type(namespace)? != 0x6e736673 {
        return Err(io::Error::other("PID namespace object is not nsfs"));
    }
    // SAFETY: NS_GET_NSTYPE takes no pointer and reads the namespace's kind.
    let kind = unsafe { ioctl(namespace.as_raw_fd(), 0xb703, 0) };
    if kind < 0 { return Err(io::Error::last_os_error()); }
    if kind != 0x20000000 {
        return Err(io::Error::other("namespace object is not a PID namespace"));
    }
    if namespace.metadata()?.ino() == 0xeffffffc {
        return Ok(None);
    }
    // SAFETY: NS_GET_PARENT returns a fresh descriptor for this namespace's
    // actual kernel parent. Permission/unsupported errors stay UNKNOWN.
    let parent = descriptor(c_long::from(unsafe { ioctl(namespace.as_raw_fd(), 0xb702, 0) }))?;
    require_cloexec(parent).map(|parent| Some(File::from(parent)))
}
