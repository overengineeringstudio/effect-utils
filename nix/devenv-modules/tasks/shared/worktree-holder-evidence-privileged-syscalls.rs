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
    fn syscall(number: c_long, ...) -> c_long;
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

#[cfg(target_arch = "x86_64")]
const SYS_ALIAS_KCMP: c_long = 312;
#[cfg(target_arch = "aarch64")]
const SYS_ALIAS_KCMP: c_long = 272;

fn task_comparison(leader: u32, task: u32, kind: c_int, fd: u32) -> io::Result<bool> {
    if leader == 0 || task == 0 || leader == task || fd > c_int::MAX as u32 {
        return Err(io::Error::other("invalid leader alias comparison"));
    }
    // SAFETY: Linux kcmp reads scalar PID/type/slot arguments only. Callers
    // retain pidfds and check both generations/liveness around these numeric
    // lookups. Only exact zero is equality; errors never confer alias proof.
    let result = unsafe { syscall(SYS_ALIAS_KCMP, c_long::from(leader),
        c_long::from(task), kind, c_long::from(fd), c_long::from(fd)) };
    if result < 0 { return Err(io::Error::last_os_error()); }
    Ok(result == 0)
}

/// KCMP_FILES compares the real task descriptor-table objects, not their contents.
pub fn same_task_descriptor_table(leader: u32, task: u32) -> io::Result<bool> {
    task_comparison(leader, task, 2, 0)
}

/// KCMP_FILE compares the corresponding numeric slot's open-file descriptions.
pub fn same_task_descriptor(leader: u32, task: u32, fd: u32) -> io::Result<bool> {
    task_comparison(leader, task, 0, fd)
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

#[cfg(holder_evidence_clients)]
fn pin_evidence_path() -> io::Result<File> {
    use std::ffi::CString;
    use std::os::unix::fs::MetadataExt;
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

#[cfg(holder_evidence_clients)]
pub fn connect_evidence(deadline: std::time::Instant) -> io::Result<std::os::unix::net::UnixStream> {
    use std::os::unix::fs::MetadataExt;
    let process = pin_process(std::process::id())?;
    require_process_initial_user_namespace(&process)?;
    let expected_uid = env!("HOLDER_EVIDENCE_UID").parse::<u32>()
        .map_err(|_| io::Error::other("invalid compiled evidence owner"))?;
    let uids = worktree_holder_proc::process::uids(std::process::id())?;
    if uids[0] != expected_uid || uids[1] != expected_uid {
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

#[cfg(test)]
mod leader_alias_tests {
    use super::*;

    #[test]
    fn invalid_alias_comparisons_never_prove_equality() {
        for (leader, task, fd) in [(0, 1, 0), (1, 0, 0), (1, 1, 0), (1, 2, u32::MAX)] {
            assert!(same_task_descriptor(leader, task, fd).is_err());
        }
        assert!(same_task_descriptor_table(1, 1).is_err());
        assert!(same_task_descriptor_table(0, 1).is_err());
        // Neither a missing task nor an unsupported/denied syscall is equality.
        assert!(!matches!(same_task_descriptor_table(std::process::id(), i32::MAX as u32), Ok(true)));
    }

    #[test]
    #[ignore = "requires privileged Linux kcmp and unshare(CLONE_FILES) qualification lane"]
    fn actual_table_and_ofd_equality_are_independent_requirements() {
        use std::sync::mpsc;
        unsafe extern "C" {
            fn unshare(flags: c_int) -> c_int;
            fn dup2(old: c_int, new: c_int) -> c_int;
        }
        let original = File::open("/dev/null").unwrap();
        let number = original.as_raw_fd();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (step_tx, step_rx) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            let path = std::fs::read_link("/proc/thread-self").unwrap();
            let tid: u32 = path.file_name().unwrap().to_str().unwrap().parse().unwrap();
            ready_tx.send(tid).unwrap();
            step_rx.recv().unwrap();
            // SAFETY: change only this test thread's table, never namespaces.
            assert_eq!(unsafe { unshare(0x400) }, 0);
            ready_tx.send(tid).unwrap();
            step_rx.recv().unwrap();
            let reopened = File::open("/dev/null").unwrap();
            // SAFETY: after unshare, replace only the child test's numeric slot.
            // Same inode, deliberately distinct OFD; parent retains its own FD.
            assert_eq!(unsafe { dup2(reopened.as_raw_fd(), number) }, number);
            ready_tx.send(tid).unwrap();
            step_rx.recv().unwrap();
        });
        let pid = std::process::id();
        let tid = ready_rx.recv().unwrap();
        assert!(same_task_descriptor_table(pid, tid).unwrap());
        assert!(same_task_descriptor(pid, tid, number as u32).unwrap());
        step_tx.send(()).unwrap();
        assert_eq!(ready_rx.recv().unwrap(), tid);
        assert!(!same_task_descriptor_table(pid, tid).unwrap());
        assert!(same_task_descriptor(pid, tid, number as u32).unwrap());
        step_tx.send(()).unwrap();
        assert_eq!(ready_rx.recv().unwrap(), tid);
        assert!(!same_task_descriptor_table(pid, tid).unwrap());
        assert!(!same_task_descriptor(pid, tid, number as u32).unwrap());
        step_tx.send(()).unwrap();
        thread.join().unwrap();
    }
}
