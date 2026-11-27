//! Compiled only into the exported mounted test runner, never the server RLIB.
use std::fs::File;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use super::{mounts, objects, CandidateView};
use worktree_holder_proc::scopes::ProcessScope;

const TEST: &str = "candidates::tests::jailed_namespace_outside_candidate_bind_matches_oracle_without_admin";
const CAPS: &str = "CAP_DAC_READ_SEARCH CAP_SYS_PTRACE CAP_CHECKPOINT_RESTORE CAP_NET_ADMIN";
const CAP_BITS: u64 = (1 << 2) | (1 << 12) | (1 << 19) | (1 << 40);

fn assert_profile() {
    let status = std::fs::read_to_string("/proc/self/status").unwrap();
    for name in ["CapEff:", "CapPrm:", "CapBnd:"] {
        let value = status.lines().find_map(|line| line.strip_prefix(name)).unwrap();
        assert_eq!(u64::from_str_radix(value.trim(), 16).unwrap(), CAP_BITS,
            "probe must have exactly the intended production capability set");
    }
    assert_eq!(status.lines().find_map(|line| line.strip_prefix("NoNewPrivs:")).unwrap().trim(), "1");
    assert_eq!(CAP_BITS & (1 << 21), 0, "CAP_SYS_ADMIN must be absent");
}

fn probe() {
    assert_profile();
    let pid: u32 = std::env::var("HOLDER_NAMESPACE_PID").unwrap().parse().unwrap();
    let root = PathBuf::from(std::env::var_os("HOLDER_NAMESPACE_ROOT").unwrap());
    let oracle_path = PathBuf::from(std::env::var_os("HOLDER_NAMESPACE_ORACLE").unwrap());
    let outside = root.join("outside");
    let jail = root.join("jail");
    let candidate = root.join("candidate");
    let deadline = Instant::now() + Duration::from_secs(20);
    let process = ProcessScope::discover(pid, deadline).unwrap();
    assert_eq!(process.tasks.len(), 1, "only the jailed keeper task may remain");
    let task = &process.tasks[0];
    assert_eq!(task.identity.pid, pid);
    let pins = process.collect_resources(0, deadline).unwrap().unwrap();
    assert_eq!(pins.descriptors.len(), 3, "keeper must not retain an outside source FD");
    let host_jail = File::open(&jail).unwrap();
    let expected_root = objects::identity(&host_jail).unwrap();
    assert_eq!(objects::identity(&pins.root.as_ref().unwrap().file).unwrap(), expected_root);
    assert_eq!(objects::identity(&pins.cwd.as_ref().unwrap().file).unwrap(), expected_root);
    let expected_exe = objects::identity(&File::open(jail.join("bin/busybox")).unwrap()).unwrap();
    assert_eq!(objects::identity(&pins.exe.as_ref().unwrap().file).unwrap(), expected_exe);
    for (_, mapping) in &pins.mappings {
        assert_eq!(objects::identity(&mapping.file).unwrap(), expected_exe);
    }
    for (number, held) in &pins.descriptors {
        let path = if *number == 0 { jail.join("input") } else { jail.join("output") };
        assert_eq!(objects::identity(&held.file).unwrap(), objects::identity(&File::open(path).unwrap()).unwrap());
    }
    let oracle = mounts::parse(&objects::bounded_text(&oracle_path, 1_048_576).unwrap()).unwrap();
    assert_profile();
    let candidates = super::tests::fixture_set(std::slice::from_ref(&candidate));
    assert_profile();
    // This is the production NativeView/NamespaceSnapshot path, not oracle
    // replay or a privileged alternate query. Any kernel refusal fails the test.
    let view = mounts::NativeView::capture(&task.scope, deadline).unwrap();
    let namespace_file = File::open(format!("/proc/self/fd/{}/ns/mnt",
        std::os::fd::AsRawFd::as_raw_fd(&task.scope))).unwrap();
    assert_eq!(view.namespace_id(), super::linux::mount_namespace_id(&namespace_file).unwrap());
    assert_eq!(view.mounts().count(), oracle.len());
    let expected_device = mounts::device_pair(candidates.get(0).identity.dev);
    let mut outside_id = None;
    for actual in view.mounts() {
        let reference = oracle.get(&actual.id).expect("kernel unique/legacy IDs must match oracle explicitly");
        assert_eq!(actual.parent, reference.parent);
        assert_eq!((actual.device_major, actual.device_minor), (reference.device_major, reference.device_minor));
        assert_eq!(actual.root.path().unwrap(), &reference.root);
        assert_eq!(actual.point, reference.point);
        assert_eq!(actual.kind, reference.kind);
        if actual.point == outside {
            assert_eq!((actual.device_major, actual.device_minor), expected_device);
            assert_eq!(actual.root.path().unwrap(), &candidates.scopes[0].location.path);
            outside_id = Some(actual.id);
        }
    }
    let outside_id = outside_id.expect("outside-chroot candidate-source bind MUST be seen");
    // Demonstrate that this is the formerly unsafe filtered case. This text
    // is a test oracle/control only and never feeds production acceptance.
    let filtered = mounts::parse(&objects::bounded_text(format!("/proc/{pid}/mountinfo"), 1_048_576).unwrap()).unwrap();
    assert!(!filtered.contains_key(&outside_id));
    assert!(filtered.len() < oracle.len());
    assert_profile();
    view.recheck(deadline).unwrap();
    let jailed_candidates = super::tests::fixture_set(std::slice::from_ref(&jail));
    assert!(jailed_candidates.matches(&pins.root.as_ref().unwrap().file, &task.scope,
        super::protocol::ReferenceKind::Root, deadline).is_err(),
        "stripping a jail prefix must never report its own candidate root as non-holding");
    assert_profile();
    let failure = match CandidateView::from_view(view, &candidates.scopes, deadline) {
        Ok(_) => panic!("jailed-root bridge must veto the outside namespace view"),
        Err(error) => error,
    };
    // This exact source-literal bridge veto cannot disguise EPERM, ENOSYS,
    // an incomplete kernel enumeration, or any other query failure as a pass.
    assert_eq!(failure.kind(), std::io::ErrorKind::Other);
    assert_eq!(failure.to_string(), "mounted root changed or shadowed");
    process.recheck_resources(0, &pins, deadline).unwrap();
    process.recheck(deadline).unwrap();
    assert_profile();
}

struct Keeper(Child);
impl Drop for Keeper {
    fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
}
struct OwnedDirectory(PathBuf);
impl Drop for OwnedDirectory {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

pub(super) fn run() {
    match std::env::var("HOLDER_NAMESPACE_PHASE") {
        Ok(phase) if phase == "probe" => { probe(); return; }
        Ok(_) => panic!("unknown controlled namespace fixture phase"),
        Err(std::env::VarError::NotPresent) => (),
        Err(error) => panic!("invalid controlled fixture phase: {error}"),
    }
    let busybox = PathBuf::from(std::env::var_os("HOLDER_NAMESPACE_BUSYBOX").expect("VM must supply static busybox"));
    assert!(busybox.is_absolute() && busybox.is_file());
    let root = std::env::temp_dir().join(format!("holder-namespace-fixture-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let _owned = OwnedDirectory(root.clone());
    let jail = root.join("jail");
    let candidate = root.join("candidate");
    let outside = root.join("outside");
    let oracle = root.join("oracle");
    std::fs::create_dir_all(jail.join("bin")).unwrap();
    std::fs::create_dir(&candidate).unwrap();
    std::fs::create_dir(&outside).unwrap();
    std::fs::copy(busybox, jail.join("bin/busybox")).unwrap();
    std::fs::write(jail.join("input"), b"").unwrap();
    std::fs::write(candidate.join("payload"), b"must remain mounted").unwrap();
    let script = r#"
set -eu
jail=$1
candidate=$2
outside=$3
oracle=$4
mount --bind "$jail" "$jail"
mount --bind "$candidate" "$outside"
cat /proc/self/mountinfo >"$oracle"
cd "$jail"
exec 0<"$jail/input" 1>"$jail/output" 2>&1
exec chroot "$jail" /bin/busybox sleep 300
"#;
    let mut keeper = Keeper(Command::new("unshare")
        .args(["--mount", "--propagation", "private", "sh", "-c", script, "--"])
        .args([&jail, &candidate, &outside, &oracle])
        .stdin(Stdio::null()).spawn().unwrap());
    let pid = keeper.0.id();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        assert!(keeper.0.try_wait().unwrap().is_none(), "jailed keeper exited during setup");
        if oracle.is_file() {
            if let Ok(root_file) = objects::pin_magic(format!("/proc/{pid}/root")) {
                if objects::identity(&root_file).unwrap() == objects::identity(&File::open(&jail).unwrap()).unwrap()
                    && objects::identity(&objects::pin_magic(format!("/proc/{pid}/exe")).unwrap()).unwrap()
                        == objects::identity(&File::open(jail.join("bin/busybox")).unwrap()).unwrap()
                { break; }
            }
        }
        assert!(Instant::now() < deadline, "jailed keeper did not finish setup");
        std::thread::sleep(Duration::from_millis(10));
    }
    let namespace = File::open(format!("/proc/{pid}/ns/mnt")).unwrap();
    let identity = objects::identity(&namespace).unwrap();
    assert_ne!(identity, objects::identity(&File::open("/proc/self/ns/mnt").unwrap()).unwrap());
    let mut members = Vec::new();
    for leader in worktree_holder_proc::scopes::numbers("/proc", deadline).unwrap() {
        let tasks = match worktree_holder_proc::scopes::numbers(format!("/proc/{leader}/task"), deadline) {
            Ok(tasks) => tasks,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => panic!("namespace fixture membership: {error}"),
        };
        for tid in tasks {
            match File::open(format!("/proc/{leader}/task/{tid}/ns/mnt")) {
                Ok(file) if objects::identity(&file).unwrap() == identity => members.push(tid),
                Ok(_) => (),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Err(error) => panic!("namespace fixture member: {error}"),
            }
        }
    }
    assert_eq!(members, vec![pid], "only the jailed keeper may remain in the private namespace");
    let mut command = Command::new("systemd-run");
    command.args(["--quiet", "--wait", "--pipe"])
        .arg(format!("--unit=holder-namespace-probe-{}", std::process::id()));
    for property in [
        "Type=exec", "RuntimeMaxSec=30", "NoNewPrivileges=yes", "RestrictNamespaces=yes",
        "TimeoutStopSec=2", "KillMode=control-group", "MemoryMax=512M", "TasksMax=16",
        "LimitNOFILE=131072", "UMask=0077",
        "LockPersonality=yes", "MemoryDenyWriteExecute=yes", "RestrictAddressFamilies=AF_UNIX",
        "PrivateMounts=no", "PrivateTmp=no", "PrivateUsers=no", "PrivateNetwork=no", "PrivateDevices=no",
        "ProtectSystem=no", "ProtectHome=no", "ProtectProc=default", "ProcSubset=all",
        "SystemCallFilter=~@mount @reboot @swap @module @raw-io setns unshare",
    ] { command.arg(format!("--property={property}")); }
    command.arg(format!("--property=CapabilityBoundingSet={CAPS}"))
        .arg("--setenv=HOLDER_NAMESPACE_PHASE=probe")
        .arg(format!("--setenv=HOLDER_NAMESPACE_PID={pid}"))
        .arg(format!("--setenv=HOLDER_NAMESPACE_ROOT={}", root.display()))
        .arg(format!("--setenv=HOLDER_NAMESPACE_ORACLE={}", oracle.display()))
        .arg(std::env::current_exe().unwrap())
        .args(["--exact", TEST, "--ignored", "--nocapture"]);
    let output = command.output().unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    eprintln!("{}\n{}", stdout, String::from_utf8_lossy(&output.stderr));
    assert!(output.status.success(),
        "production-profile namespace probe refused or failed: UNKNOWN; qualification must stop");
    assert_eq!(stdout.lines().filter(|line|
        line.starts_with("test result: ok. 1 passed; 0 failed;")).count(), 1,
        "the exact production-profile child test must really execute once");
    assert!(candidate.join("payload").is_file());
    assert!(keeper.0.try_wait().unwrap().is_none());
    assert!(File::open(&jail).unwrap().metadata().unwrap().is_dir());
}
