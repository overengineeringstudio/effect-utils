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
fn actual_descriptor_replacement_requires_whole_snapshot_recapture() {
    use std::fs::File;
    use std::os::fd::AsRawFd;
    use std::time::{Duration, Instant};
    unsafe extern "C" { fn dup2(old: i32, new: i32) -> i32; }

    let first = File::open("/dev/null").unwrap();
    let replacement = File::open("/dev/zero").unwrap();
    let path = format!("/proc/self/fd/{}", first.as_raw_fd());
    let deadline = Instant::now() + Duration::from_secs(10);
    let held = scopes::Held::pin(&path, deadline).unwrap();
    held.recheck(&path, deadline).unwrap();
    // SAFETY: both descriptors are live, distinct and owned by this test. The
    // first File retains sole closing ownership of its replaced descriptor.
    assert_eq!(unsafe { dup2(replacement.as_raw_fd(), first.as_raw_fd()) }, first.as_raw_fd());
    let error = held.recheck(&path, deadline).unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::Interrupted);
    // The retained old object must not silently become the replacement. Only
    // a fresh complete snapshot may admit the new reference.
    assert_ne!(held.identity, scopes::Held::pin(&path, deadline).unwrap().identity);
    assert!(held.recheck(&path, deadline).is_err());
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
        assert!(scope.collect_resources(departed_index, deadline, None).unwrap().is_none());
        let index = scope.tasks.iter().position(|task| task.identity.pid == survivor).unwrap();
        let task = &scope.tasks[index];
        let nested = std::fs::read_dir(format!("{}/map_files", scopes::scope_path(&task.scope)))
            .err().expect("the nested per-task proc table must not expose map_files");
        assert_eq!(nested.kind(), std::io::ErrorKind::NotFound);
        assert!(!scopes::mapping_names(&task.mapping_scope, deadline).unwrap().is_empty(),
            "the same actual TID's top-level mapping scope must expose real mappings");
        let references = scope.collect_resources(index, deadline, None).unwrap()
            .expect("a surviving task must not become an empty departed slot");
        assert!(references.descriptors.iter().any(|(fd, held)| *fd == descriptor && held.identity == identity));
        assert!(references.mappings.iter().any(|(_, held)| held.identity == identity),
            "the actual file-backed candidate mapping must remain observed");
        scope.recheck_resources(index, &references, deadline, None).unwrap();
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
    let references = scope.collect_resources(index, deadline, None).unwrap().unwrap();
    worker.commands.as_ref().unwrap().send(1).unwrap();
    reports.recv().unwrap();
    assert!(!scope.task_departed(index, deadline).unwrap());
    assert!(scope.recheck_resources(index, &references, deadline, None).is_err(),
        "live-task descriptor disappearance must not become non-holding");
    let leader = scope.tasks.iter().position(|task| task.identity.pid == pid).unwrap();
    assert!(!scope.task_departed(leader, deadline).unwrap());
    scope.identity.start += 1;
    assert!(scope.task_departed(index, deadline).is_err(),
        "failed leader-generation proof must remain protective");
    drop(worker);
}

#[test]
#[ignore = "requires isolated root Linux with per-task resource and namespace visibility"]
fn actual_large_group_task_resources_require_final_sibling_closure() {
    use std::os::fd::AsRawFd;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};
    const CHILD: &str = "HOLDER_GROUP_CLOSURE_PROBE";
    const TEST: &str = "tests::actual_large_group_task_resources_require_final_sibling_closure";
    if std::env::var_os(CHILD).is_none() {
        assert!(std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", TEST, "--nocapture"]).env(CHILD, "1")
            .status().unwrap().success());
        return;
    }
    unsafe extern "C" {
        fn unshare(flags: std::os::raw::c_int) -> std::os::raw::c_int;
        fn gettid() -> std::os::raw::c_int;
    }
    struct Worker {
        commands: Option<mpsc::Sender<u8>>,
        thread: Option<std::thread::JoinHandle<()>>,
    }
    impl Drop for Worker {
        fn drop(&mut self) {
            self.commands.take();
            if let Some(thread) = self.thread.take() { thread.join().unwrap(); }
        }
    }
    struct Root(std::path::PathBuf);
    impl Drop for Root {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
    }
    let root = Root(std::env::temp_dir().join(format!("holder-group-closure-{}-{}",
        std::process::id(), linux::boot_time_ns().unwrap())));
    std::fs::create_dir(&root.0).unwrap();
    std::fs::write(root.0.join("candidate"), b"retained candidate").unwrap();
    let (report, reports) = mpsc::channel();
    let mut workers = Vec::new();
    for number in 0..64 {
        let (commands, receive) = mpsc::channel();
        let report = report.clone();
        let candidate = root.0.join("candidate");
        let thread = std::thread::spawn(move || {
            // SAFETY: only this owned worker unshares its descriptor table, so
            // collector-created evidence FDs cannot perturb its task snapshot.
            assert_eq!(unsafe { unshare(0x00000400) }, 0);
            let held = std::fs::File::open(candidate).unwrap();
            // SAFETY: argument-free identity of the actual calling worker.
            let tid = u32::try_from(unsafe { gettid() }).unwrap();
            report.send((number, tid, held.as_raw_fd())).unwrap();
            while let Ok(command) = receive.recv() {
                assert_eq!(command, 1);
                let before = std::fs::File::open("/proc/thread-self/ns/mnt").unwrap();
                // SAFETY: changes only this worker's namespace; no mount
                // operation is performed and the collector remains unchanged.
                assert_eq!(unsafe { unshare(0x00020000) }, 0);
                let after = std::fs::File::open("/proc/thread-self/ns/mnt").unwrap();
                assert_ne!(objects::identity(&before).unwrap(), objects::identity(&after).unwrap());
                report.send((number, tid, held.as_raw_fd())).unwrap();
            }
        });
        workers.push(Worker { commands: Some(commands), thread: Some(thread) });
    }
    let mut targets = (0..64).map(|_| reports.recv_timeout(Duration::from_secs(5)).unwrap()).collect::<Vec<_>>();
    targets.sort_unstable_by_key(|(number, _, _)| *number);
    let deadline = Instant::now() + Duration::from_secs(20);
    let scope = scopes::ProcessScope::discover(std::process::id(), deadline).unwrap();
    scope.recheck(deadline).unwrap();
    let mut resources = Vec::new();
    for (_, tid, descriptor) in &targets {
        let index = scope.tasks.iter().position(|task| task.identity.pid == *tid).unwrap();
        let expected = objects::identity(&objects::pin_magic(format!("/proc/{tid}/fd/{descriptor}")).unwrap()).unwrap();
        let references = scope.collect_resources(index, deadline, None).unwrap().unwrap();
        assert!(references.descriptors.iter().any(|(fd, held)|
            fd == &u32::try_from(*descriptor).unwrap() && held.identity == expected));
        resources.push((index, references));
    }
    scope.recheck(deadline).unwrap();
    for (index, references) in &resources {
        scope.recheck_resources(*index, references, deadline, None).unwrap();
    }
    scope.recheck(deadline).unwrap();
    workers[0].commands.as_ref().unwrap().send(1).unwrap();
    assert_eq!(reports.recv_timeout(Duration::from_secs(5)).unwrap().0, 0);
    let (index, references) = resources.last().unwrap();
    scope.recheck_resources(*index, references, deadline, None).unwrap();
    assert!(scope.recheck(deadline).is_err(),
        "a sibling namespace change must veto the complete process even when this task is stable");
    let fresh = scopes::ProcessScope::discover(std::process::id(), deadline).unwrap();
    let (stop, stopped) = mpsc::channel();
    let (ready, entered) = mpsc::channel();
    let thread = std::thread::spawn(move || {
        ready.send(()).unwrap();
        let _ = stopped.recv();
    });
    let newcomer = Worker { commands: Some(stop), thread: Some(thread) };
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(fresh.recheck(deadline).is_err(), "new live tasks still veto final complete-group closure");
    drop(newcomer);
    drop(workers);
}

#[test]
#[ignore = "requires Linux with io_uring enabled and native FIFO support"]
fn actual_unregistered_inflight_read_is_not_excluded_by_zero_user_files() {
    use std::io::Write;
    use std::mem::ManuallyDrop;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::raw::{c_int, c_long};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::{Duration, Instant};
    unsafe extern "C" {
        fn syscall(number: c_long, ...) -> c_long;
        fn mmap(address: *mut std::ffi::c_void, length: usize, protection: c_int,
            flags: c_int, fd: c_int, offset: i64) -> *mut std::ffi::c_void;
        fn munmap(address: *mut std::ffi::c_void, length: usize) -> c_int;
        fn mkfifo(path: *const std::ffi::c_char, mode: u32) -> c_int;
    }
    struct Root(std::path::PathBuf);
    impl Drop for Root {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
    }
    struct Mapping { address: *mut u8, length: usize }
    impl Mapping {
        fn new(fd: c_int, length: usize, offset: i64) -> Self {
            // SAFETY: owned ring FD, checked UAPI length and fixed ring offset;
            // successful MAP_SHARED/PROT_READ|PROT_WRITE owns this exact mapping.
            let address = unsafe { mmap(std::ptr::null_mut(), length, 3, 1, fd, offset) };
            assert_ne!(address as isize, -1, "ring mmap: {}", std::io::Error::last_os_error());
            Self { address: address.cast(), length }
        }
        fn word(&self, offset: usize) -> &AtomicU32 {
            assert!(offset % 4 == 0 && offset + 4 <= self.length);
            // SAFETY: page-aligned ring mapping, bounded aligned UAPI u32
            // location. Kernel/userspace ring publication uses acquire/release.
            unsafe { &*self.address.add(offset).cast::<AtomicU32>() }
        }
    }
    impl Drop for Mapping {
        fn drop(&mut self) {
            // SAFETY: this guard exclusively owns this live mapping and length.
            let _ = unsafe { munmap(self.address.cast(), self.length) };
        }
    }
    struct ReadBuffer { bytes: ManuallyDrop<Box<[u8; 1]>>, completed: bool }
    impl Drop for ReadBuffer {
        fn drop(&mut self) {
            if self.completed {
                // SAFETY: the CQE acquire proved the kernel finished accessing
                // this buffer; its one Box has not previously been dropped.
                unsafe { ManuallyDrop::drop(&mut self.bytes); }
            }
            // On assertion unwinding with a pending request, keep this byte
            // allocated until process exit instead of freeing kernel-owned I/O
            // memory. Ring teardown cancels the owned request; no foreign task
            // is signalled. The successful path frees it normally.
        }
    }
    fn parameter(parameters: &[u64; 15], offset: usize) -> u32 {
        u32::from_ne_bytes(parameters[offset / 8].to_ne_bytes()[offset % 8..offset % 8 + 4]
            .try_into().unwrap())
    }
    let root = Root(std::env::temp_dir().join(format!("holder-unregistered-ring-{}-{}",
        std::process::id(), linux::boot_time_ns().unwrap())));
    std::fs::create_dir(&root.0).unwrap();
    let fifo = root.0.join("candidate-fifo");
    let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
    // SAFETY: fixed permissions and a live NUL-terminated owned fixture path.
    assert_eq!(unsafe { mkfifo(name.as_ptr(), 0o600) }, 0);
    let candidate = std::fs::OpenOptions::new().read(true).write(true).open(&fifo).unwrap();
    let identity = objects::identity(&candidate).unwrap();
    let mut parameters = [0u64; 15];
    // SAFETY: syscall425 is io_uring_setup on both supported architectures;
    // the full initialized aligned 120-byte parameter buffer remains writable.
    let raw_ring = unsafe { syscall(425, 8u32, parameters.as_mut_ptr()) };
    assert!(raw_ring >= 0, "io_uring_setup: {}", std::io::Error::last_os_error());
    // SAFETY: successful setup transferred this fresh descriptor exactly once.
    let ring = unsafe { OwnedFd::from_raw_fd(c_int::try_from(raw_ring).unwrap()) };
    let sq_entries = parameter(&parameters, 0) as usize;
    let cq_entries = parameter(&parameters, 4) as usize;
    let sq_head = parameter(&parameters, 40) as usize;
    let sq_tail = parameter(&parameters, 44) as usize;
    let sq_mask = parameter(&parameters, 48) as usize;
    let sq_array = parameter(&parameters, 64) as usize;
    let cq_head = parameter(&parameters, 80) as usize;
    let cq_tail = parameter(&parameters, 84) as usize;
    let cq_mask = parameter(&parameters, 88) as usize;
    let cq_entries_offset = parameter(&parameters, 100) as usize;
    let sq_length = sq_array + sq_entries * 4;
    let cq_length = cq_entries_offset + cq_entries * 16;
    let single_mapping = parameter(&parameters, 20) & 1 != 0;
    let sq = Mapping::new(ring.as_raw_fd(),
        if single_mapping { sq_length.max(cq_length) } else { sq_length }, 0);
    let separate_cq = (!single_mapping).then(|| Mapping::new(ring.as_raw_fd(), cq_length, 0x08000000));
    let cq = separate_cq.as_ref().unwrap_or(&sq);
    let sqes = Mapping::new(ring.as_raw_fd(), sq_entries * 64, 0x10000000);
    let mut buffer = ReadBuffer { bytes: ManuallyDrop::new(Box::new([0])), completed: false };
    let tail = sq.word(sq_tail).load(Ordering::Acquire);
    let index = (tail & sq.word(sq_mask).load(Ordering::Acquire)) as usize;
    let mut entry = [0u8; 64];
    entry[0] = 22; // IORING_OP_READ, ordinary FD, not IOSQE_FIXED_FILE.
    entry[4..8].copy_from_slice(&candidate.as_raw_fd().to_ne_bytes());
    entry[16..24].copy_from_slice(&(buffer.bytes.as_mut_ptr() as u64).to_ne_bytes());
    entry[24..28].copy_from_slice(&1u32.to_ne_bytes());
    entry[32..40].copy_from_slice(&0x12345678u64.to_ne_bytes());
    assert!(index < sq_entries);
    // SAFETY: the fixed 64-byte SQE fits this owned SQE slot. Release-publishing
    // the SQ tail below makes its initialized fields visible to the kernel.
    unsafe { std::ptr::copy_nonoverlapping(entry.as_ptr(), sqes.address.add(index * 64), 64); }
    sq.word(sq_array + index * 4).store(index as u32, Ordering::Relaxed);
    sq.word(sq_tail).store(tail + 1, Ordering::Release);
    // SAFETY: syscall426/enter submits exactly one initialized READ, no signal
    // mask or registered files; the owned FIFO is empty and held read/write.
    assert_eq!(unsafe { syscall(426, ring.as_raw_fd(), 1u32, 0u32, 0u32,
        std::ptr::null::<u8>(), 0usize) }, 1);
    drop(candidate);
    let head = cq.word(cq_head).load(Ordering::Acquire);
    assert_eq!(cq.word(cq_tail).load(Ordering::Acquire), head, "empty FIFO READ must remain pending");
    assert_eq!(sq.word(sq_head).load(Ordering::Acquire), sq.word(sq_tail).load(Ordering::Acquire));
    let deadline = Instant::now() + Duration::from_secs(5);
    let info = objects::bounded_text(format!("/proc/self/fdinfo/{}", ring.as_raw_fd()), 65536).unwrap();
    for field in ["UserFiles:", "SQEs:", "CQEs:"] {
        assert_eq!(info.lines().find_map(|line| line.strip_prefix(field)).map(str::trim), Some("0"));
    }
    for fd in scopes::numbers("/proc/self/fd", deadline).unwrap() {
        match std::fs::metadata(format!("/proc/self/fd/{fd}")) {
            Ok(metadata) => assert_ne!((metadata.dev(), metadata.ino()), identity,
                "no ordinary descriptor may retain the candidate"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => panic!("owned descriptor metadata: {error}"),
        }
    }
    let held = scopes::Held::pin(format!("/proc/self/fd/{}", ring.as_raw_fd()), deadline).unwrap();
    assert_eq!(scopes::qualify_object(&held).unwrap_err().to_string(),
        "unsupported path-bearing kernel object");
    // Nonblocking FIFO write-open proves a reader still exists after every
    // ordinary candidate FD was closed. Only the submitted ring READ owns it.
    let mut writer = std::fs::OpenOptions::new().write(true).custom_flags(0x800).open(&fifo).unwrap();
    writer.write_all(b"x").unwrap();
    drop(writer);
    while cq.word(cq_tail).load(Ordering::Acquire) == head {
        assert!(Instant::now() < deadline, "owned pending READ did not complete");
        std::thread::yield_now();
    }
    let offset = cq_entries_offset + (head & cq.word(cq_mask).load(Ordering::Acquire)) as usize * 16;
    assert_eq!(cq.word(offset).load(Ordering::Acquire), 0x12345678);
    assert_eq!(cq.word(offset + 4).load(Ordering::Acquire), 0);
    buffer.completed = true;
    assert_eq!(cq.word(offset + 8).load(Ordering::Acquire) as i32, 1);
    assert_eq!(buffer.bytes[0], b'x');
    cq.word(cq_head).store(head + 1, Ordering::Release);
}

/// Reexec rather than fork: no collector-created pin enters the owned target.
#[test]
#[ignore = "owned helper for isolated root missing-descriptor regressions"]
fn actual_missing_descriptor_worker() {
    use std::io::{BufRead, Write};
    use std::os::fd::{AsRawFd, FromRawFd};
    let Some(root) = std::env::var_os("HOLDER_MISSING_FD_ROOT") else { return; };
    let root = std::path::PathBuf::from(root);
    let mut slot = Some(std::fs::File::open(root.join("outside")).unwrap());
    let number = slot.as_ref().unwrap().as_raw_fd();
    let mut duplicate = None;
    let mut private_worker = None;
    let mut shared_workers = Vec::new();
    let mut replacement = 0u32;
    println!("MISSING-FD-ACK {number}");
    std::io::stdout().flush().unwrap();
    for command in std::io::stdin().lock().lines() {
        match command.unwrap().as_str() {
            "close" => { slot.take(); }
            "open-outside" => {
                slot = Some(std::fs::File::open(root.join("outside")).unwrap());
                assert_eq!(slot.as_ref().unwrap().as_raw_fd(), number);
            }
            "open-candidate" => {
                slot = Some(std::fs::File::open(root.join("candidate")).unwrap());
                assert_eq!(slot.as_ref().unwrap().as_raw_fd(), number);
            }
            "duplicate" => { duplicate = Some(std::fs::File::open(root.join("candidate")).unwrap()); }
            "drop-duplicate" => { duplicate.take(); }
            "birth" => {
                let (ready, receive) = std::sync::mpsc::sync_channel(0);
                let (stop, wait) = std::sync::mpsc::channel();
                let candidate = root.join("candidate");
                let thread = std::thread::spawn(move || {
                    unsafe extern "C" { fn unshare(flags: i32) -> i32; }
                    // SAFETY: split only this owned fixture task's files_struct.
                    assert_eq!(unsafe { unshare(0x400) }, 0);
                    let held = std::fs::File::open(candidate).unwrap();
                    ready.send(()).unwrap();
                    wait.recv().unwrap();
                    drop(held);
                });
                receive.recv().unwrap();
                shared_workers.push((stop, thread));
            }
            "exit-leader" => {
                unsafe extern "C" {
                    fn signal(number: i32, handler: extern "C" fn(i32)) -> usize;
                    fn syscall(number: std::os::raw::c_long, ...) -> std::os::raw::c_long;
                }
                extern "C" fn exit_this_task(_: i32) {
                    #[cfg(target_arch = "x86_64")]
                    const EXIT: std::os::raw::c_long = 60;
                    #[cfg(target_arch = "aarch64")]
                    const EXIT: std::os::raw::c_long = 93;
                    // SAFETY: async-signal-safe raw exit kills only the owned
                    // receiving leader task, not the live sibling test worker.
                    unsafe { syscall(EXIT, 0i32); }
                }
                #[cfg(target_arch = "x86_64")]
                const TGKILL: std::os::raw::c_long = 234;
                #[cfg(target_arch = "aarch64")]
                const TGKILL: std::os::raw::c_long = 131;
                // SAFETY: this isolated owned child installs its own handler
                // and targets only its own thread-group leader.
                assert_ne!(unsafe { signal(10, exit_this_task) }, usize::MAX);
                let pid = std::process::id();
                assert_eq!(unsafe { syscall(TGKILL, pid, pid, 10i32) }, 0);
            }
            "private" => {
                let (ready, receive) = std::sync::mpsc::sync_channel(0);
                let (stop, wait) = std::sync::mpsc::channel();
                let candidate = root.join("candidate");
                let thread = std::thread::spawn(move || {
                    unsafe extern "C" { fn unshare(flags: i32) -> i32; }
                    // SAFETY: only this owned fixture thread's files_struct
                    // is split; no namespace or foreign task is modified.
                    assert_eq!(unsafe { unshare(0x400) }, 0);
                    let held = std::fs::File::open(candidate).unwrap();
                    ready.send(()).unwrap();
                    wait.recv().unwrap();
                    drop(held);
                });
                receive.recv().unwrap();
                private_worker = Some((stop, thread));
            }
            "large-shared" => {
                assert!(shared_workers.is_empty());
                for _ in 0..128 {
                    let (ready, receive) = std::sync::mpsc::sync_channel(0);
                    let (stop, wait) = std::sync::mpsc::channel();
                    let thread = std::thread::spawn(move || {
                        ready.send(()).unwrap();
                        wait.recv().unwrap();
                    });
                    receive.recv().unwrap();
                    shared_workers.push((stop, thread));
                }
            }
            "mutate-class" => {
                unsafe extern "C" { fn unshare(flags: i32) -> i32; }
                // SAFETY: split only this owned worker's descriptor context.
                assert_eq!(unsafe { unshare(0x400) }, 0);
            }
            "replace" => {
                unsafe extern "C" { fn dup2(old: i32, new: i32) -> i32; }
                let path = root.join(format!("replacement-{replacement}"));
                replacement += 1;
                let source = std::fs::OpenOptions::new().read(true).write(true).create_new(true)
                    .open(&path).unwrap();
                std::fs::remove_file(path).unwrap();
                // SAFETY: this fixture owns both live descriptors; slot's
                // File remains the unique closing owner of the replaced FD.
                assert_eq!(unsafe { dup2(source.as_raw_fd(), number) }, number);
            }
            "open-opaque" => {
                unsafe extern "C" { fn syscall(number: std::os::raw::c_long, ...) -> std::os::raw::c_long; }
                let mut parameters = [0u64; 15];
                // SAFETY: Linux syscall425 reads/writes a full aligned
                // io_uring_params; the fresh ring is owned exactly once below.
                let fd = unsafe { syscall(425, 2u32, parameters.as_mut_ptr()) };
                assert!(fd >= 0, "io_uring_setup: {}", std::io::Error::last_os_error());
                assert_eq!(fd, i64::from(number));
                // SAFETY: successful setup transferred this unused FD once.
                slot = Some(unsafe { std::fs::File::from_raw_fd(number) });
            }
            other => panic!("unknown owned fixture command: {other}"),
        }
        println!("MISSING-FD-ACK {number}");
        std::io::stdout().flush().unwrap();
    }
    for (stop, thread) in shared_workers {
        let _ = stop.send(());
        thread.join().unwrap();
    }
    if let Some((stop, thread)) = private_worker {
        let _ = stop.send(());
        thread.join().unwrap();
    }
}

#[derive(Clone, Copy)]
enum MissingFdCase {
    Closed, CurrentDuplicate, RetainedDuplicate, CandidateReuse, OpaqueReuse, Unstable,
    SharedClass, LinearSharedClass, PrivateClass, ClassMutation, StablePairFallback,
    NewTasks, DiscoveryBirth, ExitDuringDiscovery, ExitProcess, ExitLeader,
}

fn missing_fd_case(case: MissingFdCase) {
    use std::io::{BufRead, Write};
    use std::os::unix::fs::MetadataExt;
    use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
    use std::time::{Duration, Instant};
    use std::{cell::RefCell, rc::Rc};
    struct Root(std::path::PathBuf);
    impl Drop for Root {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(self.0.join("candidate"));
            let _ = std::fs::remove_file(self.0.join("outside"));
            let _ = std::fs::remove_dir(&self.0);
        }
    }
    struct Worker {
        child: Child, input: Option<ChildStdin>, output: std::io::BufReader<ChildStdout>,
    }
    impl Worker {
        fn ack(&mut self) -> u32 {
            loop {
                let mut line = String::new();
                assert_ne!(self.output.read_line(&mut line).unwrap(), 0, "owned helper exited");
                if let Some((_, number)) = line.split_once("MISSING-FD-ACK ") {
                    return number.trim().parse().unwrap();
                }
            }
        }
        fn command(&mut self, command: &str) {
            writeln!(self.input.as_mut().unwrap(), "{command}").unwrap();
            self.input.as_mut().unwrap().flush().unwrap();
            self.ack();
        }
    }
    impl Drop for Worker {
        fn drop(&mut self) { self.input.take(); let _ = self.child.wait(); }
    }
    struct Hook;
    impl Drop for Hook {
        fn drop(&mut self) { scopes::descriptor_capture_hook(None); }
    }
    let root = Root(std::env::temp_dir().join(format!("holder-missing-fd-{}-{}",
        std::process::id(), linux::boot_time_ns().unwrap())));
    std::fs::create_dir(&root.0).unwrap();
    std::fs::write(root.0.join("outside"), b"outside").unwrap();
    std::fs::write(root.0.join("candidate"), b"candidate").unwrap();
    let metadata = std::fs::metadata(root.0.join("candidate")).unwrap();
    let candidate = (metadata.dev(), metadata.ino());
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "tests::actual_missing_descriptor_worker", "--nocapture", "--test-threads=1"])
        .env("HOLDER_MISSING_FD_ROOT", &root.0).stdin(Stdio::piped()).stdout(Stdio::piped())
        .spawn().unwrap();
    let input = child.stdin.take();
    let output = std::io::BufReader::new(child.stdout.take().unwrap());
    let worker = Rc::new(RefCell::new(Worker { child, input, output }));
    let slot = worker.borrow_mut().ack();
    if matches!(case, MissingFdCase::CurrentDuplicate | MissingFdCase::RetainedDuplicate) {
        worker.borrow_mut().command("duplicate");
    }
    if matches!(case, MissingFdCase::PrivateClass) { worker.borrow_mut().command("private"); }
    if matches!(case, MissingFdCase::LinearSharedClass) { worker.borrow_mut().command("large-shared"); }
    if matches!(case, MissingFdCase::NewTasks | MissingFdCase::ExitProcess | MissingFdCase::ExitLeader) {
        worker.borrow_mut().command("duplicate");
    }
    let pid = worker.borrow().child.id();
    let deadline = Instant::now() + Duration::from_secs(30);
    if matches!(case, MissingFdCase::ExitDuringDiscovery) {
        let witness = scopes::ProcessWitness::capture(pid, deadline).unwrap().unwrap();
        let fixture = Rc::clone(&worker);
        let fired = Rc::new(std::cell::Cell::new(false));
        let hook_fired = Rc::clone(&fired);
        scopes::descriptor_capture_hook(Some(Box::new(move |stage| {
            if matches!(stage, scopes::DescriptorCaptureStage::TaskMembership(tgid) if tgid == pid)
                && !hook_fired.replace(true) {
                fixture.borrow_mut().child.kill().unwrap();
                fixture.borrow_mut().child.wait().unwrap();
            }
        })));
        let hook = Hook;
        let error = witness.discover(deadline).err().expect("reaped generation cannot finish discovery");
        drop(hook);
        assert!(fired.get(), "exit must occur after generation/proc/task pins are retained");
        assert!(scopes::process_lifecycle_error(&error));
        assert!(witness.terminated().unwrap());
        assert!(!witness.covers_current(deadline).unwrap());
        assert!(!scopes::process_lifecycle_error(&std::io::Error::from_raw_os_error(13)));
        assert!(!scopes::process_lifecycle_error(&std::io::Error::from(std::io::ErrorKind::Unsupported)));
        return;
    }
    let discovery_birth = Rc::new(std::cell::Cell::new(false));
    if matches!(case, MissingFdCase::DiscoveryBirth) {
        let fired = Rc::clone(&discovery_birth);
        let fixture = Rc::clone(&worker);
        scopes::descriptor_capture_hook(Some(Box::new(move |stage| {
            if matches!(stage, scopes::DescriptorCaptureStage::TaskMembership(tgid) if tgid == pid)
                && !fired.replace(true) {
                fixture.borrow_mut().command("birth");
            }
        })));
    }
    let discovery_hook = matches!(case, MissingFdCase::DiscoveryBirth).then(|| Hook);
    let mut process = scopes::ProcessScope::discover(pid, deadline).unwrap();
    let index = process.tasks.iter().position(|task| task.identity.pid == pid).unwrap();
    if matches!(case, MissingFdCase::DiscoveryBirth) {
        drop(discovery_hook);
        assert!(discovery_birth.get(), "birth must happen after the first task enumeration");
        let mut resources = Vec::new();
        for index in 0..process.tasks.len() {
            resources.push(process.collect_resources(index, deadline, None).unwrap());
        }
        assert!(process.descriptor_class_count() >= 2);
        assert!(resources.iter().flatten().any(|references|
            references.descriptors.iter().any(|(_, held)| held.identity == candidate)),
            "discovery must capture the genuinely new private task's candidate");
        process.recheck(deadline).unwrap();
        return;
    }
    if matches!(case, MissingFdCase::NewTasks | MissingFdCase::ExitProcess | MissingFdCase::ExitLeader) {
        let mut witness = scopes::ProcessWitness::capture(pid, deadline).unwrap().unwrap();
        let prior = process.collect_resources(index, deadline, None).unwrap().unwrap();
        assert!(prior.descriptors.iter().any(|(_, held)| held.identity == candidate));
        if matches!(case, MissingFdCase::NewTasks) {
            let original_tasks = process.tasks.len();
            let original_classes = process.descriptor_class_count();
            let mut admitted = Vec::new();
            for pass in 0..4 {
                worker.borrow_mut().command("birth");
                let error = process.recheck(deadline).unwrap_err();
                assert!(scopes::task_membership_changed(&error));
                if pass == 3 {
                    assert!(scopes::task_membership_changed(&process.reconcile_tasks(deadline).unwrap_err()),
                        "the membership budget belongs to the retained process, not a new pass");
                    break;
                }
                let before = process.tasks.len();
                assert_eq!(process.reconcile_tasks(deadline).unwrap(), 1);
                assert_eq!(process.tasks.len(), original_tasks + pass + 1);
                assert_eq!(process.descriptor_class_count(), original_classes + pass + 1);
                let fresh = process.collect_resources(before, deadline, None).unwrap().unwrap();
                assert!(fresh.descriptors.iter().any(|(_, held)| held.identity == candidate),
                    "new private files_struct must be captured, never inferred from TGID");
                assert!(fresh.root.is_some() && fresh.cwd.is_some() && fresh.exe.is_some());
                assert!(!fresh.mappings.is_empty(), "capture the new actual task's native mm view");
                process.recheck_resources(before, &fresh, deadline, None).unwrap();
                admitted.push(fresh);
                process.recheck(deadline).unwrap();
            }
            assert_eq!(admitted.len(), 3);
            assert!(prior.descriptors.iter().any(|(_, held)| held.identity == candidate),
                "birth reconciliation must retain earlier positive capabilities");
            // An actual live task with an intentionally stale generation must
            // remain UNKNOWN; numeric TID membership never authorizes reuse.
            let new_index = original_tasks;
            process.tasks[new_index].identity.start += 1;
            assert!(process.task_present(new_index, deadline).is_err());
            assert!(process.recheck(deadline).is_err());
            return;
        }
        if matches!(case, MissingFdCase::ExitLeader) {
            worker.borrow_mut().command("exit-leader");
            while !matches!(process::process(pid).unwrap().state, b'Z' | b'X') {
                assert!(Instant::now() < deadline, "owned leader did not exit");
                std::thread::yield_now();
            }
            assert!(!witness.terminated().unwrap(), "a dead leader is not a dead thread group");
            assert!(!process.terminated().unwrap());
            assert!(!process.task_departed(index, deadline).unwrap(),
                "leader-only exit cannot waive live siblings or their resources");
        }
        worker.borrow_mut().child.kill().unwrap();
        worker.borrow_mut().child.wait().unwrap();
        assert!(witness.terminated().unwrap(), "kernel pidfd death must survive process reap");
        assert!(witness.discover(deadline).is_err(), "an exited generation cannot become a live snapshot");
        assert!(process.terminated().unwrap());
        assert!(process.task_departed(index, deadline).unwrap());
        assert!(!witness.covers_current(deadline).unwrap());
        assert!(scopes::ProcessWitness::capture(pid, deadline).unwrap().is_none(),
            "unpinned disappearance requires actual pidfd ESRCH plus native proc absence");
        prior.qualify_retained(deadline).unwrap();
        // Route an old retained capability at a different real live PID. Its
        // proc inode, not the numeric field, must refuse the rebinding.
        witness.pid = std::process::id();
        assert!(!witness.covers_current(deadline).unwrap());
        assert!(witness.terminated().unwrap());
        return;
    }
    let races = Rc::new(std::cell::Cell::new(0));
    let captures = Rc::new(std::cell::Cell::new(0));
    let hook_captures = Rc::clone(&captures);
    let task_ids = process.tasks.iter().map(|task| task.identity.pid).collect::<std::collections::BTreeSet<_>>();
    let work = Rc::new(RefCell::new([0usize; 3]));
    let hook_work = Rc::clone(&work);
    let authenticated = Rc::new(RefCell::new(std::collections::BTreeSet::new()));
    let hook_authenticated = Rc::clone(&authenticated);
    let hook_worker = Rc::clone(&worker);
    let hook_races = Rc::clone(&races);
    scopes::descriptor_capture_hook(Some(Box::new(move |stage| {
        match stage {
            scopes::DescriptorCaptureStage::BeforeSeal(tid) if task_ids.contains(&tid) => {
                hook_work.borrow_mut()[1] += 1;
                if tid == pid && matches!(case, MissingFdCase::StablePairFallback) && hook_races.get() < 6 {
                    hook_worker.borrow_mut().command("replace");
                    hook_races.set(hook_races.get() + 1);
                }
            }
            scopes::DescriptorCaptureStage::FilesComparison(left, right) => {
                assert!(task_ids.contains(&left) && task_ids.contains(&right));
                hook_work.borrow_mut()[0] += 1;
            }
            scopes::DescriptorCaptureStage::TaskMembership(tgid) if tgid == pid => {
                hook_work.borrow_mut()[2] += 1;
            }
            scopes::DescriptorCaptureStage::TaskValidated(tid) if task_ids.contains(&tid) => {
                hook_authenticated.borrow_mut().insert(tid);
            }
            scopes::DescriptorCaptureStage::BeforePin(tid, fd)
                if tid == pid && fd == slot
                    && !matches!(case, MissingFdCase::SharedClass | MissingFdCase::LinearSharedClass
                        | MissingFdCase::PrivateClass | MissingFdCase::ClassMutation | MissingFdCase::StablePairFallback)
                    && (hook_races.get() == 0 || matches!(case, MissingFdCase::Unstable)) => {
                hook_worker.borrow_mut().command("close");
                hook_races.set(hook_races.get() + 1);
            }
            scopes::DescriptorCaptureStage::Missing(tid, fd) if tid == pid && fd == slot => {
                match case {
                    MissingFdCase::CandidateReuse => hook_worker.borrow_mut().command("open-candidate"),
                    MissingFdCase::OpaqueReuse => hook_worker.borrow_mut().command("open-opaque"),
                    _ => (),
                }
            }
            scopes::DescriptorCaptureStage::Complete(tid) if tid == pid => {
                hook_captures.set(hook_captures.get() + 1);
                match case {
                    MissingFdCase::Unstable => hook_worker.borrow_mut().command("open-outside"),
                    MissingFdCase::RetainedDuplicate => hook_worker.borrow_mut().command("drop-duplicate"),
                    _ => (),
                }
            }
            scopes::DescriptorCaptureStage::Complete(tid) if task_ids.contains(&tid) => {
                hook_captures.set(hook_captures.get() + 1);
            }
            _ => (),
        }
    })));
    let hook = Hook;
    let covered = RefCell::new(std::collections::BTreeSet::new());
    // Real native inode membership for this one-file test candidate. Production
    // additionally proves path/backing provenance in each supplied task scope.
    let mut negative = |task: &scopes::TaskScope, held: &scopes::Held,
        _: scopes::ResourceKind, _: bool| {
        covered.borrow_mut().insert(task.identity.pid);
        scopes::qualify_object(held)?;
        if held.identity == candidate {
            return Err(std::io::Error::other("candidate pin veto"));
        }
        Ok(())
    };
    if matches!(case, MissingFdCase::SharedClass | MissingFdCase::LinearSharedClass
        | MissingFdCase::PrivateClass | MissingFdCase::ClassMutation) {
        let phase = process.resource_phase(deadline).unwrap();
        let mut resources = Vec::new();
        for index in 0..process.tasks.len() {
            if let Some(references) = process.collect_resources(index, deadline, Some(&mut negative)).unwrap() {
                resources.push((index, references));
            }
        }
        match case {
            MissingFdCase::SharedClass | MissingFdCase::LinearSharedClass => {
                assert_eq!(process.descriptor_class_count(), 1, "requires actual KCMP_FILES authority");
                assert_eq!(captures.get(), 1, "one physical capture, not one per TID");
                assert_eq!(resources.len(), process.tasks.len());
                let first = &resources[0].1.descriptors;
                assert!(resources.iter().all(|(_, references)| Rc::ptr_eq(first, &references.descriptors)));
                let charged = resources.iter().map(|(_, references)|
                    references.uncharged_descriptor_pin_count()).sum::<usize>();
                assert_eq!(charged, first.len(), "physical budgets must not multiply by logical TIDs");
                for (index, references) in &resources {
                    assert!(references.root.is_some() && references.cwd.is_some() && references.exe.is_some());
                    for (_, held) in references.descriptors.iter() {
                        negative(&process.tasks[*index], held, scopes::ResourceKind::Fd, false).unwrap();
                    }
                }
                assert_eq!(covered.borrow().len(), process.tasks.len());
                if matches!(case, MissingFdCase::LinearSharedClass) {
                    assert!(process.tasks.len() >= 128, "owned ready thread group, not a timing fixture");
                    for (index, references) in &resources {
                        assert!(process.task_present(*index, deadline).unwrap());
                        process.recheck_resources(*index, references, deadline, Some(&mut negative)).unwrap();
                        assert!(process.task_present(*index, deadline).unwrap());
                        process.recheck_resources(*index, references, deadline, Some(&mut negative)).unwrap();
                    }
                }
            }
            MissingFdCase::PrivateClass => {
                assert!(process.descriptor_class_count() >= 2);
                assert!(resources.iter().any(|(_, references)|
                    references.descriptors.iter().any(|(_, held)| held.identity == candidate)),
                    "the private files_struct's candidate must remain observed");
                assert_eq!(captures.get(), process.descriptor_class_count());
            }
            MissingFdCase::ClassMutation => {
                assert_eq!(process.descriptor_class_count(), 1);
                worker.borrow_mut().command("mutate-class");
                assert!(process.recheck(deadline).is_err(), "equal FD contents do not preserve class authority");
                drop(phase); drop(hook); return;
            }
            _ => unreachable!(),
        }
        let refs = resources.iter().map(|(index, references)| (*index, references));
        process.finish_resource_phase(refs, deadline, Some(&mut negative)).unwrap();
        if matches!(case, MissingFdCase::LinearSharedClass) {
            let counted = *work.borrow();
            assert_eq!(counted[0], 2 * (process.tasks.len() - 1),
                "one native class admission and one final membership seal per nonrepresentative");
            assert_eq!(counted[1], 3, "physical FD pair work must not scale with logical TIDs");
            assert_eq!(counted[2], 8, "retain all four complete group boundaries, not one enumeration per live TID");
            assert_eq!(authenticated.borrow().len(), process.tasks.len(),
                "all actual task generations, credentials and native namespaces remain authenticated");
        }
        drop(phase); drop(hook); return;
    }
    let result = process.collect_resources(index, deadline, Some(&mut negative));
    drop(hook);
    assert!(races.get() > 0, "must exercise a real before-pin or before-seal FD race");
    match case {
        MissingFdCase::Closed => {
            let references = result.unwrap().unwrap();
            assert!(!references.descriptors.iter().any(|(fd, _)| *fd == slot));
            assert!(process.tasks.iter().all(|task| covered.borrow().contains(&task.identity.pid)),
                "closing proof must cover every task, not a selected representative");
            process.recheck_resources(index, &references, deadline, Some(&mut negative)).unwrap();
            process.recheck(deadline).unwrap();
        }
        MissingFdCase::CurrentDuplicate | MissingFdCase::RetainedDuplicate | MissingFdCase::CandidateReuse => {
            let error = result.err().expect("candidate must HOLD");
            assert_eq!(error.to_string(), "candidate pin veto");
        }
        MissingFdCase::OpaqueReuse => {
            let error = result.err().expect("opaque reuse must HOLD");
            assert_eq!(error.to_string(), "unsupported path-bearing kernel object");
        }
        MissingFdCase::Unstable => {
            let error = result.err().expect("persistent uncertainty must HOLD");
            assert_eq!(error.to_string(), "process closing pass budget exhausted");
            assert_eq!(races.get(), 4, "initial capture plus three full-process follow-up passes");
        }
        MissingFdCase::StablePairFallback => {
            let references = result.unwrap().unwrap();
            assert_eq!(races.get(), 6, "exhaust the original five-pass pair repair before fallback");
            assert!(process.tasks.iter().all(|task| covered.borrow().contains(&task.identity.pid)));
            process.recheck_resources(index, &references, deadline, Some(&mut negative)).unwrap();
        }
        MissingFdCase::SharedClass | MissingFdCase::LinearSharedClass | MissingFdCase::PrivateClass
            | MissingFdCase::ClassMutation | MissingFdCase::NewTasks | MissingFdCase::DiscoveryBirth
            | MissingFdCase::ExitDuringDiscovery | MissingFdCase::ExitProcess | MissingFdCase::ExitLeader => unreachable!(),
    }
}

#[test]
#[ignore = "requires isolated Linux root with task-resource visibility"]
fn actual_vanished_before_pin_full_process_negative_closes() {
    missing_fd_case(MissingFdCase::Closed);
}

#[test]
#[ignore = "requires isolated Linux root with task-resource visibility"]
fn actual_vanished_slot_preserves_current_and_prior_candidate_pins() {
    missing_fd_case(MissingFdCase::CurrentDuplicate);
    missing_fd_case(MissingFdCase::RetainedDuplicate);
}

#[test]
#[ignore = "requires isolated Linux root with io_uring and task-resource visibility"]
fn actual_vanished_slot_reuse_to_candidate_or_opaque_holds() {
    missing_fd_case(MissingFdCase::CandidateReuse);
    missing_fd_case(MissingFdCase::OpaqueReuse);
}

#[test]
#[ignore = "requires isolated Linux root with task-resource visibility"]
fn actual_vanished_before_pin_process_instability_is_bounded() {
    missing_fd_case(MissingFdCase::Unstable);
}

#[test]
#[ignore = "requires isolated root Linux KCMP_FILES and task-resource visibility"]
fn actual_shared_files_class_captures_once_and_qualifies_every_task() {
    missing_fd_case(MissingFdCase::SharedClass);
}

#[test]
#[ignore = "requires isolated root Linux KCMP_FILES and unshare(CLONE_FILES)"]
fn actual_private_files_class_keeps_candidate_and_membership_mutation_holds() {
    missing_fd_case(MissingFdCase::PrivateClass);
    missing_fd_case(MissingFdCase::ClassMutation);
}

#[test]
#[ignore = "requires isolated root Linux KCMP_FILES and task-resource visibility"]
fn actual_process_stable_pair_exhaustion_uses_closing_witness() {
    missing_fd_case(MissingFdCase::StablePairFallback);
}

#[test]
#[ignore = "requires isolated root Linux KCMP_FILES and owned large task-resource visibility"]
fn actual_large_shared_group_phase_proof_work_is_linear() {
    missing_fd_case(MissingFdCase::LinearSharedClass);
}

#[test]
#[ignore = "requires isolated Linux root with native task-resource visibility"]
fn actual_new_task_reconciliation_captures_private_candidate_and_is_bounded() {
    missing_fd_case(MissingFdCase::NewTasks);
}

#[test]
#[ignore = "requires isolated Linux root with pidfs and native task-resource visibility"]
fn actual_process_exit_witness_survives_reap_and_rejects_pid_rebinding() {
    missing_fd_case(MissingFdCase::ExitProcess);
}

#[test]
#[ignore = "requires isolated Linux root; exits only the owned helper thread-group leader"]
fn actual_exited_leader_does_not_discharge_live_sibling_resources() {
    missing_fd_case(MissingFdCase::ExitLeader);
}

#[test]
#[ignore = "requires isolated Linux root with native task-resource visibility"]
fn actual_task_born_during_discovery_is_captured_with_its_private_candidate() {
    missing_fd_case(MissingFdCase::DiscoveryBirth);
}

#[test]
#[ignore = "requires isolated Linux root with pidfs and native task-resource visibility"]
fn actual_exit_during_discovery_has_generation_bound_native_witness() {
    missing_fd_case(MissingFdCase::ExitDuringDiscovery);
}
