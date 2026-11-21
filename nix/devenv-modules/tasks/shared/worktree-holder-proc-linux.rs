//! Narrow Linux syscall boundary for the read-only namespace evidence helper.
//! Descriptor duplication requires a retained pidfd, never a numeric remote PID.
use std::ffi::CStr;
use std::fs::File;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::raw::{c_int, c_long};
use std::os::unix::fs::MetadataExt;

#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
compile_error!("namespace evidence syscall numbers require x86_64 or aarch64");

const SYS_PIDFD_OPEN: c_long = 434;
const SYS_PIDFD_GETFD: c_long = 438;
const SYS_OPENAT2: c_long = 437;
#[cfg(target_arch = "x86_64")]
const SYS_KCMP: c_long = 312;
#[cfg(target_arch = "aarch64")]
const SYS_KCMP: c_long = 272;
#[cfg(target_arch = "x86_64")]
const SYS_MEMFD_CREATE: c_long = 319;
#[cfg(target_arch = "aarch64")]
const SYS_MEMFD_CREATE: c_long = 279;
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
    fn getuid() -> u32;
    fn geteuid() -> u32;
    fn fcntl(fd: c_int, command: c_int, ...) -> c_int;
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

pub fn pin_task(tid: u32) -> io::Result<OwnedFd> {
    // Linux PIDFD_THREAD is O_EXCL on both supported architectures. Callers
    // derive this TID from the actual pinned proc task directory.
    // SAFETY: scalar PID/flags; success transfers a fresh pidfd to OwnedFd.
    descriptor(unsafe { syscall(SYS_PIDFD_OPEN, c_long::from(tid), 0x80 as c_int) })
}

pub fn internal_shmem_witness() -> io::Result<OwnedFd> {
    // No HUGETLB: the kernel creates this empty file on its internal shmem
    // mount. MFD_CLOEXEC | MFD_NOEXEC_SEAL = 0x9; no names or flags from callers.
    // SAFETY: the static name is NUL-terminated, scalar flags use the Linux ABI,
    // and success transfers this fresh descriptor to exactly one OwnedFd.
    descriptor(unsafe {
        syscall(SYS_MEMFD_CREATE, c"holder-evidence-internal-shmem".as_ptr(), 0x9 as c_int)
    })
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

/// The caller binds numeric IDs to these retained pidfds and rechecks generation.
/// Both table sharing and the exact same descriptor's OFD are mandatory.
pub fn shared_task_descriptor(leader: u32, task: u32, number: u32,
    leader_pin: &OwnedFd, task_pin: &OwnedFd) -> io::Result<bool>
{
    if leader==task || number<3 || pidfd_terminated(leader_pin)? || pidfd_terminated(task_pin)? {
        return Ok(false);
    }
    let compare = |kind: c_int, fd: u32| -> io::Result<bool> {
        // SAFETY: kcmp is read-only; all arguments are scalar kernel IDs/FD
        // numbers. Retained, live pidfds and caller generation checks prevent
        // numeric-ID reuse from manufacturing a positive proof.
        let result=unsafe { syscall(SYS_KCMP,c_long::from(leader),c_long::from(task),
            kind,c_long::from(fd),c_long::from(fd)) };
        if result<0 { return Err(io::Error::last_os_error()); }
        Ok(result==0)
    };
    // KCMP_FILES=2 compares files_struct, KCMP_FILE=0 compares open descriptions.
    Ok(compare(2,0)? && compare(0,number)? && compare(2,0)?
        && !pidfd_terminated(leader_pin)? && !pidfd_terminated(task_pin)?)
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
#[repr(C)]
struct PollDescriptor {
    fd: c_int,
    events: i16,
    returned: i16,
}
/// Compare two retained helper-owned descriptors, never moving remote FD slots.
pub fn same_open_file(left: &impl AsRawFd, right: &impl AsRawFd) -> io::Result<bool> {
    let pid = c_long::from(std::process::id());
    // SAFETY: KCMP_FILE=0 reads only two current-process, live descriptor slots.
    let answer = unsafe { syscall(SYS_KCMP, pid, pid, 0 as c_int, c_long::from(left.as_raw_fd()), c_long::from(right.as_raw_fd())) };
    if answer < 0 { return Err(io::Error::last_os_error()); }
    Ok(answer == 0)
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

#[cfg(test)]
mod alias_tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    #[ignore = "requires isolated Linux root with CAP_SYS_PTRACE and pidfd-thread support"]
    fn actual_worker_shared_unshared_and_reopened_descriptions() {
        unsafe extern "C" {
            fn gettid() -> c_int;
            fn unshare(flags: c_int) -> c_int;
            fn dup2(old: c_int, new: c_int) -> c_int;
        }
        let leader=std::process::id();
        let directory=File::open("/").unwrap();
        let number=u32::try_from(directory.as_raw_fd()).unwrap();
        let (report,receive)=mpsc::channel();
        let (resume,commands)=mpsc::channel();
        let worker=std::thread::spawn(move || {
            // SAFETY: gettid has no arguments; it identifies this actual worker.
            let tid=u32::try_from(unsafe { gettid() }).unwrap();
            report.send((tid,0)).unwrap();
            commands.recv().unwrap();
            // SAFETY: CLONE_FILES detaches only this disposable worker's table.
            assert_eq!(unsafe { unshare(0x400) },0);
            report.send((tid,1)).unwrap();
            commands.recv().unwrap();
            let reopened=File::open("/").unwrap();
            // SAFETY: the worker owns a private table; dup2 replaces only its
            // inherited test descriptor with a distinct OFD for the same inode.
            assert_eq!(unsafe { dup2(reopened.as_raw_fd(),number as c_int) },number as c_int);
            report.send((tid,2)).unwrap();
            commands.recv().unwrap();
        });
        let (tid,stage)=receive.recv().unwrap();
        assert_eq!(stage,0);
        let leader_pin=pin_process(leader).unwrap();
        let task_pin=pin_task(tid).unwrap();
        assert!(shared_task_descriptor(leader,tid,number,&leader_pin,&task_pin).unwrap());
        resume.send(()).unwrap();
        assert_eq!(receive.recv().unwrap(),(tid,1));
        // The inherited OFD is still identical, but the table is no longer shared.
        let inherited=duplicate_process_fd(&task_pin,number as i32).unwrap();
        assert!(same_open_file(&directory,&inherited).unwrap());
        assert!(!shared_task_descriptor(leader,tid,number,&leader_pin,&task_pin).unwrap());
        resume.send(()).unwrap();
        assert_eq!(receive.recv().unwrap(),(tid,2));
        let different=duplicate_process_fd(&task_pin,number as i32).unwrap();
        assert!(!same_open_file(&directory,&different).unwrap());
        assert!(!shared_task_descriptor(leader,tid,number,&leader_pin,&task_pin).unwrap());
        resume.send(()).unwrap();
        worker.join().unwrap();
        assert!(!shared_task_descriptor(leader,tid,number,&leader_pin,&task_pin).unwrap());
    }
}

#[repr(C)]
struct MountRequest {
    size: u32,
    namespace_fd: u32,
    mount_id: u64,
    param: u64,
    namespace_id: u64,
}
const _: () = assert!(std::mem::size_of::<MountRequest>() == 32);

fn mount_request(namespace: &File, mount_id: u64, param: u64) -> io::Result<MountRequest> {
    let fd = u32::try_from(namespace.as_raw_fd())
        .map_err(|_| io::Error::other("invalid mount namespace descriptor"))?;
    if fd < 3 { return Err(io::Error::other("mount namespace descriptor is not dedicated")); }
    Ok(MountRequest { size: 32, namespace_fd: fd, mount_id, param, namespace_id: 0 })
}

pub fn mount_namespace_id(namespace: &File) -> io::Result<u64> {
    let mut id = 0u64;
    // SAFETY: NS_GET_MNTNS_ID writes exactly one live aligned u64. The kernel
    // validates that this retained nsfs descriptor is a mount namespace.
    if unsafe { ioctl(namespace.as_raw_fd(), 0x8008_b705, &mut id as *mut u64) } != 0 {
        return Err(io::Error::last_os_error());
    }
    if id == 0 { return Err(io::Error::other("zero mount namespace identity")); }
    Ok(id)
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MountNamespaceInfo {
    size: u32,
    pub mounts: u32,
    pub namespace_id: u64,
}
const _: () = assert!(std::mem::size_of::<MountNamespaceInfo>() == 16);

pub fn mount_namespace_info(namespace: &File) -> io::Result<MountNamespaceInfo> {
    let mut info = MountNamespaceInfo { size: 16, mounts: 0, namespace_id: 0 };
    // SAFETY: NS_MNT_GET_INFO's published v0 ABI is exactly this initialized,
    // aligned repr(C) 16-byte buffer. This query neither enters nor changes it.
    if unsafe { ioctl(namespace.as_raw_fd(), 0x8010_b70a, &mut info as *mut MountNamespaceInfo) } != 0 {
        return Err(io::Error::last_os_error());
    }
    if info.size != 16 || info.namespace_id == 0 {
        return Err(io::Error::other("incomplete mount namespace information"));
    }
    Ok(info)
}

pub fn list_mount_page(namespace: &File, cursor: u64, ids: &mut [u64; 256]) -> io::Result<usize> {
    let request = mount_request(namespace, u64::MAX, cursor)?;
    // SAFETY: listmount=458 on both supported 64-bit Linux architectures. The
    // fixed request selects only this live namespace FD and LSMT_ROOT; the
    // exact writable array capacity is supplied, flags=0, no namespace entry.
    let result = unsafe { syscall(458 as c_long, &request as *const MountRequest, ids.as_mut_ptr(), ids.len(), 0u32) };
    if result < 0 { return Err(io::Error::last_os_error()); }
    let count = usize::try_from(result).map_err(|_| io::Error::other("invalid mount page size"))?;
    if count > ids.len() { return Err(io::Error::other("mount page exceeds buffer")); }
    Ok(count)
}

pub const REQUIRED_MOUNT_FIELDS: u64 = 0x7b;
pub struct MountBuffer([u64; 2048]);

impl MountBuffer {
    pub const fn new() -> Self { Self([0; 2048]) }
}

pub fn stat_mount<'a>(namespace: &File, mount_id: u64, buffer: &'a mut MountBuffer)
    -> io::Result<&'a [u8]>
{
    let request = mount_request(namespace, mount_id, REQUIRED_MOUNT_FIELDS)?;
    // SAFETY: statmount=457 on both supported architectures. The fixed 32-byte
    // request and complete aligned initialized 16-KiB output remain live;
    // its capacity is passed exactly. No setns or mounting operation occurs.
    let result = unsafe {
        syscall(457 as c_long, &request as *const MountRequest, buffer.0.as_mut_ptr(),
            std::mem::size_of_val(&buffer.0), 0u32)
    };
    if result < 0 { return Err(io::Error::last_os_error()); }
    if result != 0 { return Err(io::Error::other("unexpected statmount result")); }
    // SAFETY: all bytes of this u64 array are initialized, and the immutable
    // byte view has precisely its allocation's extent and retained lifetime.
    let bytes = unsafe { std::slice::from_raw_parts(buffer.0.as_ptr().cast::<u8>(),
        std::mem::size_of_val(&buffer.0)) };
    let size = u32::from_ne_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    if !(512..=bytes.len()).contains(&size) {
        return Err(io::Error::other("incomplete or oversized statmount record"));
    }
    Ok(&bytes[..size])
}
