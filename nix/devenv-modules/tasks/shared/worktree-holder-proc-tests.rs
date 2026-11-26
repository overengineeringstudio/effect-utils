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

#[test]
#[ignore = "requires root CAP_SYS_ADMIN inside the isolated Linux VM"]
fn actual_bpf_stats_lease_is_nonpath() {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::raw::{c_int, c_long};
    use std::time::{Duration, Instant};
    unsafe extern "C" { fn syscall(number: c_long, ...) -> c_long; }
    #[cfg(target_arch = "x86_64")]
    const BPF_SYSCALL: c_long = 321;
    #[cfg(target_arch = "aarch64")]
    const BPF_SYSCALL: c_long = 280;
    // BPF_ENABLE_STATS(32) reads only the initialized u32 runtime type(0).
    // A successful descriptor enables the guest-wide statistics static key
    // until close; it does not load a program or target a filesystem object.
    let runtime_type = 0u32;
    // SAFETY: supported architecture's bpf syscall receives a live aligned
    // four-byte attribute with exactly its initialized UAPI size.
    let raw = unsafe { syscall(BPF_SYSCALL, 32u32, &runtime_type, 4usize) };
    assert!(raw >= 0, "BPF_ENABLE_STATS: {}", std::io::Error::last_os_error());
    // SAFETY: successful enable transfers this fresh descriptor exactly once.
    let stats = unsafe { OwnedFd::from_raw_fd(c_int::try_from(raw).unwrap()) };
    let held = scopes::Held::pin(
        format!("/proc/self/fd/{}", stats.as_raw_fd()),
        Instant::now() + Duration::from_secs(10),
    ).unwrap();
    assert_eq!(linux::filesystem_type(&held.file).unwrap(), 0x09041934);
    assert_eq!(std::fs::read_link(scopes::scope_path(&held.file)).unwrap(),
        std::path::Path::new("anon_inode:bpf-stats"));
    scopes::qualify_object(&held).unwrap();
}

#[test]
#[ignore = "requires isolated Linux root with task-resource visibility"]
fn actual_departed_thread_churn_preserves_survivor_fd() {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::MetadataExt;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};
    unsafe extern "C" {
        fn gettid() -> std::os::raw::c_int;
        fn unshare(flags: std::os::raw::c_int) -> std::os::raw::c_int;
        fn mmap(address: *mut std::ffi::c_void, length: usize, protection: i32,
            flags: i32, fd: i32, offset: i64) -> *mut std::ffi::c_void;
        fn munmap(address: *mut std::ffi::c_void, length: usize) -> i32;
    }
    struct Root(std::path::PathBuf);
    impl Drop for Root {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(self.0.join("candidate"));
            let _ = std::fs::remove_dir(&self.0);
        }
    }
    struct Mapping(*mut std::ffi::c_void);
    impl Drop for Mapping {
        fn drop(&mut self) {
            // SAFETY: this owns the successful fixed-length mapping once.
            let _ = unsafe { munmap(self.0, 4096) };
        }
    }
    struct Worker {
        commands: Option<mpsc::Sender<u8>>,
        thread: Option<std::thread::JoinHandle<()>>,
    }
    impl Drop for Worker {
        fn drop(&mut self) {
            self.commands.take();
            if let Some(thread) = self.thread.take() { let _ = thread.join(); }
        }
    }
    let root = Root(std::env::temp_dir().join(format!("holder-task-churn-{}-{}",
        std::process::id(), linux::boot_time_ns().unwrap())));
    std::fs::create_dir(&root.0).unwrap();
    let candidate_path = root.0.join("candidate");
    let (commands, receive) = mpsc::channel();
    let (report, reports) = mpsc::channel();
    let thread = std::thread::spawn(move || {
        // SAFETY: unshare(CLONE_FILES) gives this surviving worker its own
        // descriptor table; collector-created pins cannot perturb that table.
        assert_eq!(unsafe { unshare(0x00000400) }, 0);
        let candidate = std::fs::OpenOptions::new().read(true).write(true)
            .create_new(true).open(candidate_path).unwrap();
        candidate.set_len(4096).unwrap();
        // SAFETY: live readable owned file, aligned zero offset, one page,
        // PROT_READ/MAP_PRIVATE; no payload dereference or shared write.
        let mapped = unsafe { mmap(std::ptr::null_mut(), 4096, 1, 2, candidate.as_raw_fd(), 0) };
        assert_ne!(mapped as isize, -1, "mmap: {}", std::io::Error::last_os_error());
        let _mapping = Mapping(mapped);
        let identity = candidate.metadata().unwrap();
        // SAFETY: gettid is an argument-free current-task identity query.
        let tid = u32::try_from(unsafe { gettid() }).unwrap();
        let mut candidate = Some(candidate);
        report.send((tid, candidate.as_ref().unwrap().as_raw_fd() as u32,
            (identity.dev(), identity.ino()))).unwrap();
        while let Ok(command) = receive.recv() {
            assert_eq!(command, 1);
            candidate.take();
            report.send((tid, 0, (0, 0))).unwrap();
        }
    });
    let worker = Worker { commands: Some(commands), thread: Some(thread) };
    let (survivor, descriptor, identity) = reports.recv().unwrap();
    let deadline = Instant::now() + Duration::from_secs(120);
    let pid = std::process::id();
    let wait_departures = |tids: &[u32]| {
        loop {
            let current = scopes::numbers(format!("/proc/{pid}/task"), deadline).unwrap();
            let remaining = tids.iter().filter(|tid| current.binary_search(tid).is_ok()).count();
            if remaining == 0 { break; }
            assert!(Instant::now() < deadline,
                "joined fixture tasks still listed at deadline: count={remaining}");
            std::thread::yield_now();
        }
    };
    for _ in 0..16 {
        let (stop, stopped) = mpsc::channel();
        let (ready, entered) = mpsc::channel();
        let transient = std::thread::spawn(move || {
            // SAFETY: argument-free current-task query.
            ready.send(u32::try_from(unsafe { gettid() }).unwrap()).unwrap();
            let _ = stopped.recv();
        });
        let transient = Worker { commands: Some(stop), thread: Some(transient) };
        let departed = entered.recv().unwrap();
        let scope = scopes::ProcessScope::discover(pid, deadline).unwrap();
        let departed_index = scope.tasks.iter().position(|task| task.identity.pid == departed).unwrap();
        drop(transient);
        // pthread join observes clear_child_tid, which precedes exit_notify /
        // release_task in Linux6.18.62. Require actual task-list disappearance,
        // not a userspace completion signal, before testing departed closure.
        wait_departures(&[departed]);
        // Real births and exits occur after discovery and before resource
        // closure, while the original surviving candidate FD remains live.
        let mut born = Vec::with_capacity(16);
        for _ in 0..16 {
            let (ready, entered) = mpsc::channel();
            let thread = std::thread::spawn(move || {
                // SAFETY: argument-free current-task identity query.
                ready.send(u32::try_from(unsafe { gettid() }).unwrap()).unwrap();
            });
            born.push(entered.recv().unwrap());
            thread.join().unwrap();
        }
        wait_departures(&born);
        scope.recheck(deadline).unwrap();
        assert!(scope.task_departed(departed_index, deadline).unwrap());
        assert!(scope.collect_resources(departed_index, deadline).unwrap().is_none());
        let index = scope.tasks.iter().position(|task| task.identity.pid == survivor).unwrap();
        let task = &scope.tasks[index];
        let nested = std::fs::read_dir(format!("{}/map_files", scopes::scope_path(&task.scope)))
            .err().expect("the nested per-task proc table must not expose map_files");
        assert_eq!(nested.kind(), std::io::ErrorKind::NotFound);
        assert!(!scopes::mapping_names(&task.mapping_scope, deadline).unwrap().is_empty(),
            "the same actual TID's top-level mapping scope must expose real mappings");
        let references = scope.collect_resources(index, deadline).unwrap()
            .expect("a surviving task must not become an empty departed slot");
        assert!(references.descriptors.iter().any(|(fd, held)| *fd == descriptor && held.identity == identity));
        assert!(references.mappings.iter().any(|(_, held)| held.identity == identity),
            "the actual file-backed candidate mapping must remain observed");
        scope.recheck_resources(index, &references, deadline).unwrap();
        let current = scopes::ProcessScope::discover(pid, deadline).unwrap();
        assert!(scope.same_selection(&current, deadline).unwrap());
    }
    let scope = scopes::ProcessScope::discover(pid, deadline).unwrap();
    let (stop, stopped) = mpsc::channel();
    let (ready, entered) = mpsc::channel();
    let newcomer = std::thread::spawn(move || {
        // SAFETY: argument-free current-task identity query.
        ready.send(u32::try_from(unsafe { gettid() }).unwrap()).unwrap();
        let _ = stopped.recv();
    });
    let newcomer = Worker { commands: Some(stop), thread: Some(newcomer) };
    let newcomer_tid = entered.recv().unwrap();
    assert!(scope.recheck(deadline).is_err(), "new live task must not be omitted");
    drop(newcomer);
    wait_departures(&[newcomer_tid]);
    let mut scope = scopes::ProcessScope::discover(pid, deadline).unwrap();
    let index = scope.tasks.iter().position(|task| task.identity.pid == survivor).unwrap();
    let references = scope.collect_resources(index, deadline).unwrap().unwrap();
    worker.commands.as_ref().unwrap().send(1).unwrap();
    reports.recv().unwrap();
    assert!(!scope.task_departed(index, deadline).unwrap());
    assert!(scope.recheck_resources(index, &references, deadline).is_err(),
        "live-task descriptor disappearance must not become non-holding");
    let leader = scope.tasks.iter().position(|task| task.identity.pid == pid).unwrap();
    assert!(!scope.task_departed(leader, deadline).unwrap());
    scope.identity.start += 1;
    assert!(scope.task_departed(index, deadline).is_err(),
        "failed leader-generation proof must remain protective");
    drop(worker);
}
