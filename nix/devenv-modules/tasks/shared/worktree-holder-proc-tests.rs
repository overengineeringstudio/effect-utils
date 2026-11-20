use super::{linux, objects, process, scopes};

#[test]
fn stat_parser_uses_last_parenthesis_and_actual_generation() {
    let mut fields = vec!["S", "7"];
    fields.extend(["0"; 17]);
    fields.push("123456");
    let stat = format!("42 (name with ) and spaces) {}", fields.join(" "));
    let parsed = process::parse_process(42, &stat).unwrap();
    assert_eq!(parsed.pid, 42);
    assert_eq!(parsed.parent, 7);
    assert_eq!(parsed.start, 123456);
    assert_eq!(parsed.state, b'S');
    assert!(process::parse_process(43, &stat).is_err());
    assert!(process::parse_process(42, "42 (short) S 7").is_err());
    assert!(process::parse_process(42, &stat.replace(") S ", ") SS ")).is_err());
}

#[test]
fn uid_parser_requires_exactly_one_complete_record() {
    assert_eq!(process::parse_uids("Name:\tx\nUid:\t1 2 3 4\n").unwrap(), [1, 2, 3, 4]);
    assert!(process::parse_uids("Uid: 1 2 3").is_err());
    assert!(process::parse_uids("Uid: 1 2 3 4 5").is_err());
    assert!(process::parse_uids("Uid: 1 2 3 4\nUid: 1 2 3 4").is_err());
    assert!(process::parse_uids("Uid: 1 2 3 4294967296").is_err());
    assert!(process::parse_uids("Uid: 1 2 3 nope").is_err());
    assert!(process::parse_uids("Name: no-uids").is_err());
}

#[test]
fn actual_self_generation_and_read_only_pins() {
    let pid = std::process::id();
    let before = process::process(pid).unwrap();
    let pidfd = linux::pin_process(pid).unwrap();
    let scope = objects::pin_magic(format!("/proc/{pid}")).unwrap();
    let pinned = objects::bounded_text(format!("{}/stat", scopes::scope_path(&scope)), 65536).unwrap();
    assert!(process::parse_process(pid, &pinned).unwrap().same_identity(&before));
    assert_eq!(process::uids(pid).unwrap(), process::parse_uids(
        &objects::bounded_text(format!("{}/status", scopes::scope_path(&scope)), 65536).unwrap()
    ).unwrap());
    let root = objects::pin_magic(format!("/proc/{pid}/root")).unwrap();
    assert!(root.metadata().unwrap().is_dir());
    assert!(objects::mount_id(&root).unwrap() > 0);
    assert!(!linux::pidfd_terminated(&pidfd).unwrap());
    let clock = linux::boot_time_ns().unwrap();
    assert!(linux::boot_time_ns().unwrap() >= clock);
    assert!(process::process(pid).unwrap().same_identity(&before));
}

#[test]
#[ignore = "requires the isolated Linux VM with io_uring enabled"]
fn actual_nonpath_eventfd_and_registered_io_uring_veto() {
    use std::io::Write;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::raw::{c_int, c_long};
    use std::time::{Duration, Instant};

    unsafe extern "C" {
        fn eventfd(initial: u32, flags: c_int) -> c_int;
        fn syscall(number: c_long, ...) -> c_long;
    }

    // SAFETY: eventfd takes scalar arguments and transfers a fresh descriptor.
    let raw_event = unsafe { eventfd(0, 0x80000) };
    assert!(raw_event >= 0, "eventfd: {}", std::io::Error::last_os_error());
    // SAFETY: the successful syscall transferred this descriptor exactly once.
    let event = unsafe { OwnedFd::from_raw_fd(raw_event) };
    let event_pin = scopes::Held::pin(
        format!("/proc/self/fd/{}", event.as_raw_fd()), Instant::now() + Duration::from_secs(10),
    ).unwrap();
    assert_eq!(linux::filesystem_type(&event_pin.file).unwrap(), 0x09041934);
    assert_eq!(std::fs::read_link(scopes::scope_path(&event_pin.file)).unwrap(),
        std::path::Path::new("anon_inode:[eventfd]"));
    scopes::qualify_object(&event_pin).unwrap();

    struct Candidate(std::path::PathBuf);
    impl Drop for Candidate {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(self.0.join("candidate"));
            let _ = std::fs::remove_dir(&self.0);
        }
    }
    let root = std::env::temp_dir().join(format!("holder-kernel-object-{}-{}",
        std::process::id(), linux::boot_time_ns().unwrap()));
    std::fs::create_dir(&root).unwrap();
    let fixture = Candidate(root);
    let mut candidate = std::fs::OpenOptions::new().read(true).write(true).create_new(true)
        .open(fixture.0.join("candidate")).unwrap();
    candidate.write_all(b"registered candidate payload\n").unwrap();

    // The stable Linux io_uring_params UAPI is 120 zero-initialized bytes;
    // only the kernel reads/writes it, and no submission/completion rings are mapped.
    let mut parameters = [0u64; 15];
    // SAFETY: both supported architectures use syscall425; the writable buffer
    // is the full aligned UAPI size and remains live for this synchronous call.
    let raw_ring = unsafe { syscall(425, 2u32, parameters.as_mut_ptr()) };
    assert!(raw_ring >= 0, "io_uring_setup: {}", std::io::Error::last_os_error());
    // SAFETY: the successful setup transferred this fresh descriptor once.
    let ring = unsafe { OwnedFd::from_raw_fd(c_int::try_from(raw_ring).unwrap()) };
    let registered = [candidate.as_raw_fd()];
    // SAFETY: syscall427/IORING_REGISTER_FILES(2) receives this live ring,
    // one live regular candidate FD, and the matching one-element array length.
    let registration = unsafe { syscall(427, ring.as_raw_fd(), 2u32, registered.as_ptr(), 1u32) };
    assert_eq!(registration, 0, "io_uring_register: {}", std::io::Error::last_os_error());
    // Only the ring now retains the candidate's file reference; the veto must
    // not depend on finding that candidate as an ordinary process descriptor.
    drop(candidate);
    let ring_pin = scopes::Held::pin(
        format!("/proc/self/fd/{}", ring.as_raw_fd()), Instant::now() + Duration::from_secs(10),
    ).unwrap();
    assert_eq!(linux::filesystem_type(&ring_pin.file).unwrap(), 0x09041934);
    assert_eq!(std::fs::read_link(scopes::scope_path(&ring_pin.file)).unwrap(),
        std::path::Path::new("anon_inode:[io_uring]"));
    let error = scopes::qualify_object(&ring_pin).unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::Other);
    assert_eq!(error.to_string(), "unsupported path-bearing kernel object");
}

#[test]
#[ignore = "requires root BPF privilege inside the isolated Linux VM"]
fn actual_loaded_btf_is_nonpath() {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::raw::{c_int, c_long};
    use std::time::{Duration, Instant};
    unsafe extern "C" { fn syscall(number: c_long, ...) -> c_long; }
    #[cfg(target_arch = "x86_64")]
    const BPF_SYSCALL: c_long = 321;
    #[cfg(target_arch = "aarch64")]
    const BPF_SYSCALL: c_long = 280;

    // Native-endian BTF v1 header, one signed 32-bit integer, then its name table.
    // All offsets are relative to the end of the 24-byte header.
    let mut btf = Vec::with_capacity(45);
    btf.extend_from_slice(&0xeb9fu16.to_ne_bytes());
    btf.extend_from_slice(&[1, 0]);
    for word in [24u32, 0, 16, 16, 5, 1, 1 << 24, 4, (1 << 24) | 32] {
        btf.extend_from_slice(&word.to_ne_bytes());
    }
    btf.extend_from_slice(b"\0int\0");
    assert_eq!(btf.len(), 45);
    // BPF_BTF_LOAD's first 28 bytes: btf pointer, null verifier-log pointer,
    // byte length, zero log length and level; trailing padding is initialized.
    #[repr(C)]
    struct Load {
        btf: u64,
        log: u64,
        size: u32,
        log_size: u32,
        log_level: u32,
        padding: u32,
    }
    let attr = Load {
        btf: btf.as_ptr() as u64, log: 0, size: btf.len() as u32,
        log_size: 0, log_level: 0, padding: 0,
    };
    // SAFETY: supported architectures' bpf syscall, BPF_BTF_LOAD(18), full
    // initialized aligned attr and live read-only BTF bytes; no program loaded.
    let raw = unsafe { syscall(BPF_SYSCALL, 18u32, &attr, std::mem::size_of::<Load>()) };
    assert!(raw >= 0, "BPF_BTF_LOAD: {}", std::io::Error::last_os_error());
    // SAFETY: successful load transfers exactly this fresh descriptor once.
    let btf_fd = unsafe { OwnedFd::from_raw_fd(c_int::try_from(raw).unwrap()) };
    let held = scopes::Held::pin(
        format!("/proc/self/fd/{}", btf_fd.as_raw_fd()),
        Instant::now() + Duration::from_secs(10),
    ).unwrap();
    assert_eq!(linux::filesystem_type(&held.file).unwrap(), 0x09041934);
    assert_eq!(std::fs::read_link(scopes::scope_path(&held.file)).unwrap(),
        std::path::Path::new("anon_inode:btf"));
    scopes::qualify_object(&held).unwrap();
}
