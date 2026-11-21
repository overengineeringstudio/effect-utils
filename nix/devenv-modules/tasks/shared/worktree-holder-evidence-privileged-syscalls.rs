//! Privileged socket and child-lifetime boundary; proc owns kernel census calls.
pub use worktree_holder_proc::linux::*;
use std::fs::File;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::raw::{c_int, c_long};
use std::os::unix::fs::FileTypeExt;
unsafe extern "C" {
    fn ioctl(fd: c_int, request: u64, ...) -> c_int;
    fn getsockopt(fd: c_int, level: c_int, option: c_int, value: *mut std::ffi::c_void, length: *mut u32) -> c_int;
    fn signal(number: c_int, handler: usize) -> usize;
    fn alarm(seconds: u32) -> u32;
    fn prctl(option: c_int, ...) -> c_int;
    fn getppid() -> c_int;
    fn socket(domain: c_int, kind: c_int, protocol: c_int) -> c_int;
    fn getsockname(fd: c_int, address: *mut UnixAddress, length: *mut u32) -> c_int;
    fn fcntl(fd: c_int, command: c_int, ...) -> c_int;
    fn connect(fd: c_int, address: *const UnixAddress, length: u32) -> c_int;
    fn poll(descriptors: *mut PollDescriptor, count: usize, timeout: c_int) -> c_int;
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
