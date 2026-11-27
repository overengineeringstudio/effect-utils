//! Retained proc scopes and native resources, extracted from the production census.
//! All errors remain unqualified evidence; callers must never interpret them as absence.
//! Initial table churn permits three whole-task recaptures before publication.
//! Retained final closure never recaptures away a previously observed reference.
use std::fs::{self, File};
use std::io;
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::Path;
use std::time::Instant;
use super::{linux, objects, process};
use super::objects::Identity;
use super::process::Process;

const TASK_LIMIT: usize = 262144;
const OBJECT_LIMIT: usize = 1048576;

/// Closed kernel spellings, not a prefix or anonymous-filesystem exemption.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AnonymousKernelObject {
    BpfMap, BpfProgram, BpfLink, Btf, BpfStats, EventFd, TimerFd, SignalFd, Epoll, Inotify,
    PidFd, UserfaultFd, PerfEvent, IoUring, Fanotify, Unrecognized,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum KernelObjectPathClass { NonPathKernelObject, PathBearingOrUnknown }

impl AnonymousKernelObject {
    fn path_class(self) -> KernelObjectPathClass {
        match self {
            Self::BpfMap | Self::BpfProgram | Self::BpfLink | Self::Btf | Self::BpfStats | Self::EventFd
            | Self::TimerFd | Self::SignalFd | Self::Epoll | Self::Inotify
            | Self::PidFd | Self::UserfaultFd | Self::PerfEvent =>
                KernelObjectPathClass::NonPathKernelObject,
            Self::IoUring | Self::Fanotify | Self::Unrecognized =>
                KernelObjectPathClass::PathBearingOrUnknown,
        }
    }
}

fn anonymous_kernel_object(name: &Path) -> AnonymousKernelObject {
    match name.to_str() {
        Some("anon_inode:bpf-map") => AnonymousKernelObject::BpfMap,
        Some("anon_inode:bpf-prog") => AnonymousKernelObject::BpfProgram,
        Some("anon_inode:bpf-link" | "anon_inode:bpf_link") => AnonymousKernelObject::BpfLink,
        Some("anon_inode:btf") => AnonymousKernelObject::Btf,
        Some("anon_inode:bpf-stats") => AnonymousKernelObject::BpfStats,
        Some("anon_inode:[eventfd]") => AnonymousKernelObject::EventFd,
        Some("anon_inode:[timerfd]") => AnonymousKernelObject::TimerFd,
        Some("anon_inode:[signalfd]") => AnonymousKernelObject::SignalFd,
        Some("anon_inode:[eventpoll]") => AnonymousKernelObject::Epoll,
        Some("anon_inode:inotify") => AnonymousKernelObject::Inotify,
        Some("anon_inode:[pidfd]" | "anon_inode:pidfd") => AnonymousKernelObject::PidFd,
        Some("anon_inode:[userfaultfd]" | "anon_inode:userfaultfd") => AnonymousKernelObject::UserfaultFd,
        Some("anon_inode:[perf_event]") => AnonymousKernelObject::PerfEvent,
        Some("anon_inode:[io_uring]") => AnonymousKernelObject::IoUring,
        Some("anon_inode:[fanotify]" | "anon_inode:fanotify") => AnonymousKernelObject::Fanotify,
        _ => AnonymousKernelObject::Unrecognized,
    }
}

#[cfg(test)]
mod anonymous_object_tests {
    #[test]
    fn anonymous_kind_is_closed_and_typed() {
        use super::{AnonymousKernelObject as Object, KernelObjectPathClass as Class};
        for (name, object) in [
            ("anon_inode:bpf-map", Object::BpfMap),
            ("anon_inode:bpf-prog", Object::BpfProgram),
            ("anon_inode:bpf-link", Object::BpfLink),
            ("anon_inode:bpf_link", Object::BpfLink),
            ("anon_inode:btf", Object::Btf),
            ("anon_inode:bpf-stats", Object::BpfStats),
            ("anon_inode:[eventfd]", Object::EventFd),
            ("anon_inode:[timerfd]", Object::TimerFd),
            ("anon_inode:[signalfd]", Object::SignalFd),
            ("anon_inode:[eventpoll]", Object::Epoll),
            ("anon_inode:inotify", Object::Inotify),
            ("anon_inode:[pidfd]", Object::PidFd),
            ("anon_inode:pidfd", Object::PidFd),
            ("anon_inode:[userfaultfd]", Object::UserfaultFd),
            ("anon_inode:userfaultfd", Object::UserfaultFd),
            ("anon_inode:[perf_event]", Object::PerfEvent),
        ] {
            let actual = super::anonymous_kernel_object(std::path::Path::new(name));
            assert_eq!(actual, object);
            assert_eq!(actual.path_class(), Class::NonPathKernelObject);
        }
        for name in [
            "anon_inode:[io_uring]", "anon_inode:[fanotify]", "anon_inode:fanotify",
            "anon_inode:bpf-map-unknown", "anon_inode:bpf-prog/child",
            "anon_inode:[btf]", "anon_inode:btf-unknown", "anon_inode:btf/child",
            "anon_inode:[bpf_link]", "anon_inode:bpf_link-unknown", "anon_inode:bpf_link/child",
            "anon_inode:[bpf-stats]", "anon_inode:bpf-stats-unknown", "anon_inode:bpf-stats/child",
            "/untrusted/proc-link-target",
        ] {
            assert_eq!(super::anonymous_kernel_object(std::path::Path::new(name)).path_class(),
                Class::PathBearingOrUnknown);
        }
        use std::os::unix::ffi::OsStrExt;
        let non_utf8 = std::ffi::OsStr::from_bytes(b"anon_inode:bpf-map\xff");
        assert_eq!(super::anonymous_kernel_object(std::path::Path::new(non_utf8)), Object::Unrecognized);
    }

    #[test]
    fn linux_6_18_62_unapproved_emitter_inventory_stays_unknown() {
        // Reviewed inventory, not an anonymous-filesystem admission rule.
        use super::KernelObjectPathClass::PathBearingOrUnknown;
        for suffix in [
            "kvm-htab", "kvm-spapr-tce", "[papr-hvpipe]", "[papr-platform-dump]",
            "[papr-indices]", "[papr-physical-attestation]", "[papr-vpd]",
            "binder_alloc_kunit", "[vtpms]", "sync_file", "gpio-linehandle",
            "gpio-line", "gpio-event", "drm", "syncobj_file", "kfd_smi_ev",
            "[i915_perf]", "i915.gem", "[xe_eu_stall]", "[xe_oa]",
            "mshv_vp", "mshv_partition", "iio:buffer", "iio:event",
            "[infinibandevent]", "[devx_async_cmd]", "[devx_async_event]",
            "[iommufd-pgfault]", "[iommufd-viommu-event]", "[iommufd_test_staccess]",
            "request", "ntsync", "tee_shm", "[vduse-domain]", "[vfio-device]",
            "hisi_acc_vf_mig", "mlx5vf_mig", "pds_vfio_lm", "qat_vf_mig",
            "virtiovf_mig", "ne-vm", "[fscontext]", "[cachefiles]", "[fanotify]",
            "[io_uring]", "[io_uring_mock]", "seccomp notify", "bpf_iter",
            "mtty_mig", "[landlock-ruleset]", "[kvm-gmem]", "kvm-vm-stats", "kvm-vm",
            "kvm-vfio", "kvm-arm-vgic-its", "kvm-arm-vgic-v2", "kvm-arm-vgic-v3",
            "kvm-loongarch-eiointc", "kvm-loongarch-ipi", "kvm-loongarch-pch-pic",
            "kvm-xics", "kvm-xive", "kvm-xive-native", "kvm-mpic", "kvm-riscv-aia",
            "kvm-flic", "future-unknown",
        ] {
            let name = format!("anon_inode:{suffix}");
            assert_eq!(super::anonymous_kernel_object(std::path::Path::new(&name)).path_class(),
                PathBearingOrUnknown, "{suffix}");
        }
        for id in 0..128 {
            let name = format!("anon_inode:snd-utimer{id}");
            assert_eq!(super::anonymous_kernel_object(std::path::Path::new(&name)).path_class(),
                PathBearingOrUnknown);
        }
        for id in [0, 1, 127, i32::MAX] {
            for prefix in ["kvm-vcpu:", "kvm-vcpu-stats:"] {
                let name = format!("anon_inode:{prefix}{id}");
                assert_eq!(super::anonymous_kernel_object(std::path::Path::new(&name)).path_class(),
                    PathBearingOrUnknown);
            }
        }
    }
}

pub struct ProcessScope {
    pub identity: Process,
    pidfd: OwnedFd,
    pub scope: File,
    pub tasks: Vec<TaskScope>,
}

pub struct TaskScope {
    pub tgid: u32,
    pub identity: Process,
    pub uids: [u32; 4],
    pub scope: File,
    /// Top-level /proc/<tid>; nested task directories do not expose map_files.
    pub mapping_scope: File,
    pub namespaces: Vec<File>,
}

/// Pins survive until the owner drops the snapshot. No descriptor contents are read.
pub struct References {
    pub root: Option<Held>,
    pub cwd: Option<Held>,
    pub exe: Option<Held>,
    pub descriptors: Vec<(u32, Held)>,
    pub mappings: Vec<(String, Held)>,
    no_mm: bool,
}


pub struct Held {
    pub file: File,
    pub identity: Identity,
    pub mount: u64,
    pub directory: bool,
}

/// Read only kernel-produced resource metadata through the pinned task scope.
/// PF_KTHREAD is stat field 9, not a name/UID heuristic. Terminal qualification
/// is enabled only after the caller has checked every task in the thread group.
fn no_mm_role(task: &TaskScope, all_terminal: bool, deadline: Instant) -> io::Result<bool> {
    deadline_check(deadline)?;
    let base = scope_path(&task.scope);
    let stat = objects::bounded_text(format!("{base}/stat"), 64 * 1024)?;
    let (_, tail) = stat.rsplit_once(')').ok_or_else(|| io::Error::other("malformed task stat"))?;
    let fields: Vec<_> = tail.split_whitespace().collect();
    if fields.len() < 20 { return Err(io::Error::other("truncated task stat")); }
    let flags = fields[6].parse::<u64>().map_err(|_| io::Error::other("invalid task flags"))?;
    let terminal = matches!(fields[0], "Z" | "X");
    if flags & 0x00200000 == 0 && !(all_terminal && terminal) { return Ok(false); }
    if !objects::bounded_text(format!("{base}/maps"), 1024 * 1024)?.is_empty() {
        return Err(io::Error::other("resource-empty task retains mappings"));
    }
    let statm = objects::bounded_text(format!("{base}/statm"), 4096)?;
    let pages = statm.split_whitespace().map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>().map_err(|_| io::Error::other("invalid task statm"))?;
    if pages.len() != 7 || pages.iter().any(|page| *page != 0)
        || !numbers(format!("{base}/fd"), deadline)?.is_empty()
    { return Err(io::Error::other("resource-empty task retains mm or descriptors")); }
    Ok(true)
}

fn pin_optional(path: impl AsRef<Path>, no_mm: bool, deadline: Instant) -> io::Result<Option<Held>> {
    match Held::pin(path, deadline) {
        Ok(held) => Ok(Some(held)),
        Err(error) if no_mm && error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

pub fn recheck_namespaces(task: &TaskScope) -> io::Result<()> {
    for (name, retained) in ["user", "pid", "mnt", "net"].into_iter().zip(&task.namespaces) {
        let actual = objects::pin_magic(format!("{}/ns/{name}", scope_path(&task.scope)))?;
        if objects::identity(&actual)? != objects::identity(retained)? {
            return Err(io::Error::other("task namespace changed"));
        }
    }
    if task.namespaces.len() != 4 { return Err(io::Error::other("incomplete task namespaces")); }
    Ok(())
}

pub fn deadline_check(deadline: Instant) -> io::Result<()> {
    if Instant::now() >= deadline {
        Err(io::Error::other("process census deadline"))
    } else {
        Ok(())
    }
}

pub fn scope_path(scope: &File) -> String {
    format!("/proc/self/fd/{}", scope.as_raw_fd())
}

pub fn numbers(path: impl AsRef<Path>, deadline: Instant) -> io::Result<Vec<u32>> {
    let mut values = Vec::new();
    for entry in fs::read_dir(path)? {
        deadline_check(deadline)?;
        let name = entry?.file_name();
        let Some(name) = name.to_str() else { continue };
        if name.is_empty() || !name.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }
        if values.len() >= TASK_LIMIT {
            return Err(io::Error::other("proc census capacity"));
        }
        values.push(name.parse().map_err(|_| io::Error::other("proc numeric identifier overflow"))?);
    }
    values.sort_unstable();
    if values.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(io::Error::other("duplicate proc identifier"));
    }
    Ok(values)
}

pub fn mapping_names(scope: &File, deadline: Instant) -> io::Result<Vec<String>> {
    let mut names = Vec::new();
    for entry in fs::read_dir(format!("{}/map_files", scope_path(scope)))? {
        deadline_check(deadline)?;
        let name = entry?.file_name().into_string()
            .map_err(|_| io::Error::other("invalid map_files name"))?;
        let (start, end) = name.split_once('-').ok_or_else(|| io::Error::other("invalid map_files range"))?;
        if start.is_empty() || end.is_empty()
            || !start.bytes().chain(end.bytes()).all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(io::Error::other("invalid map_files address"));
        }
        let start = u64::from_str_radix(start, 16).map_err(|_| io::Error::other("invalid map start"))?;
        let end = u64::from_str_radix(end, 16).map_err(|_| io::Error::other("invalid map end"))?;
        if start >= end || names.len() >= OBJECT_LIMIT {
            return Err(io::Error::other("invalid or excessive map_files ranges"));
        }
        names.push(name);
    }
    names.sort_unstable();
    if names.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(io::Error::other("duplicate mapping range"));
    }
    Ok(names)
}

impl Held {
    pub fn pin(path: impl AsRef<Path>, deadline: Instant) -> io::Result<Self> {
        deadline_check(deadline)?;
        let file = objects::pin_magic(path)?;
        let metadata = file.metadata()?;
        Ok(Self { identity: (metadata.dev(), metadata.ino()), mount: objects::mount_id(&file)?,
            directory: metadata.is_dir(), file })
    }

    pub fn recheck(&self, path: impl AsRef<Path>, deadline: Instant) -> io::Result<()> {
        let actual = Self::pin(path, deadline)?;
        if actual.identity != self.identity || actual.mount != self.mount
            || actual.directory != self.directory
            || objects::identity(&self.file)? != self.identity
            || objects::mount_id(&self.file)? != self.mount
        {
            return Err(io::Error::new(io::ErrorKind::Interrupted, "process reference changed"));
        }
        Ok(())
    }
}
/// Exact non-path object classes do not grant access to a candidate payload.
/// io_uring, fanotify and unrecognized anonymous objects remain unqualified.
pub fn qualify_object(held: &Held) -> io::Result<()> {
    let metadata = held.file.metadata()?;
    let filesystem = linux::filesystem_type(&held.file)?;
    // The agreed model protects accidental path use, not adversarial queued
    // SCM_RIGHTS capability transfer. Sockets/nsfs and terminal devices do not
    // themselves identify a candidate payload path.
    if metadata.file_type().is_block_device() {
        return Err(io::Error::other("unqualified block device"));
    }
    if filesystem == 0x09041934 {
        let name = fs::read_link(scope_path(&held.file))?;
        if anonymous_kernel_object(&name).path_class() == KernelObjectPathClass::PathBearingOrUnknown {
            return Err(io::Error::other("unsupported path-bearing kernel object"));
        }
        return Ok(());
    }
    if metadata.file_type().is_char_device()
        || matches!(filesystem, 0x6e736673 | 0x534f434b | 0x50494446)
        || held.directory || metadata.file_type().is_file()
        || metadata.file_type().is_fifo() || metadata.file_type().is_socket()
    { return Ok(()); }
    Err(io::Error::other("unqualified held object"))
}

/// A missing nonleader is non-holding only within the original live generation.
/// In particular, a missing descriptor of a still-listed task is not departure.
fn proven_task_departure(leader: &Process, pidfd: &OwnedFd, scope: &File,
    tid: u32, deadline: Instant) -> io::Result<bool>
{
    deadline_check(deadline)?;
    if tid == leader.pid { return Ok(false); }
    if linux::pidfd_terminated(pidfd)? || !process::process(leader.pid)?.same_identity(leader) {
        return Err(io::Error::other("departure proof leader generation changed"));
    }
    let absent = numbers(format!("{}/task", scope_path(scope)), deadline)?.binary_search(&tid).is_err();
    if linux::pidfd_terminated(pidfd)? || !process::process(leader.pid)?.same_identity(leader) {
        return Err(io::Error::other("departure proof leader did not close"));
    }
    Ok(absent)
}

impl ProcessScope {
    pub fn discover(pid: u32, deadline: Instant) -> io::Result<Self> {
        deadline_check(deadline)?;
        let identity = process::process(pid)?;
        let pidfd = linux::pin_process(pid)?;
        let scope = objects::pin_magic(format!("/proc/{pid}"))?;
        if !process::process(pid)?.same_identity(&identity) {
            return Err(io::Error::other("process changed during pin"));
        }
        let base = scope_path(&scope);
        let tids = numbers(format!("{base}/task"), deadline)?;
        let mut tasks = Vec::new();
        for tid in &tids {
            let captured: io::Result<TaskScope> = (|| {
                let identity = process::process(*tid)?;
                let task_scope = objects::pin_magic(format!("{base}/task/{tid}"))?;
                let mapping_scope = objects::pin_magic(format!("/proc/{tid}"))?;
                let uids = process::uids(*tid)?;
                let mut namespaces = Vec::with_capacity(4);
                for name in ["user", "pid", "mnt", "net"] {
                    namespaces.push(objects::pin_magic(format!("{}/ns/{name}", scope_path(&task_scope)))?);
                }
                if !process::process(*tid)?.same_identity(&identity) {
                    return Err(io::Error::other("task changed during pin"));
                }
                Ok(TaskScope { tgid: pid, identity, uids, scope: task_scope, mapping_scope, namespaces })
            })();
            match captured {
                Ok(task) => tasks.push(task),
                Err(error) if error.kind() == io::ErrorKind::NotFound
                    && proven_task_departure(&identity, &pidfd, &scope, *tid, deadline)? => (),
                Err(error) => return Err(error),
            }
        }
        if tasks.is_empty() || !tasks.iter().any(|task| task.identity.pid == pid) {
            return Err(io::Error::other("process task discovery did not close"));
        }
        let captured = Self { identity, pidfd, scope, tasks };
        captured.recheck(deadline)?;
        Ok(captured)
    }

    /// `self` is the retained before set; `other` is its later recapture.
    pub fn same_selection(&self, other: &Self, deadline: Instant) -> io::Result<bool> {
        self.recheck(deadline)?;
        other.recheck(deadline)?;
        if !self.identity.same_identity(&other.identity)
            || objects::identity(&self.scope)? != objects::identity(&other.scope)?
        { return Ok(false); }
        for after in &other.tasks {
            let Ok(index) = self.tasks.binary_search_by_key(&after.identity.pid, |task| task.identity.pid)
                else { return Ok(false); };
            let before = &self.tasks[index];
            if !before.identity.same_identity(&after.identity) || before.uids != after.uids
                || objects::identity(&before.scope)? != objects::identity(&after.scope)?
                || before.tgid != after.tgid
                || objects::identity(&before.mapping_scope)? != objects::identity(&after.mapping_scope)?
                || before.namespaces.len() != after.namespaces.len()
            { return Ok(false); }
            for (a, b) in before.namespaces.iter().zip(&after.namespaces) {
                if objects::identity(a)? != objects::identity(b)? { return Ok(false); }
            }
        }
        for before in &self.tasks {
            if other.tasks.binary_search_by_key(&before.identity.pid, |task| task.identity.pid).is_err()
                && !self.task_departed_by_id(before.identity.pid, deadline)?
            { return Ok(false); }
        }
        self.recheck(deadline)?;
        Ok(true)
    }

    fn task_departed_by_id(&self, tid: u32, deadline: Instant) -> io::Result<bool> {
        proven_task_departure(&self.identity, &self.pidfd, &self.scope, tid, deadline)
    }

    pub fn task_departed(&self, index: usize, deadline: Instant) -> io::Result<bool> {
        let task = self.tasks.get(index).ok_or_else(|| io::Error::other("unknown task index"))?;
        self.task_departed_by_id(task.identity.pid, deadline)
    }

    fn recheck_membership(&self, deadline: Instant) -> io::Result<()> {
        let current = numbers(format!("{}/task", scope_path(&self.scope)), deadline)?;
        for tid in current {
            if self.tasks.binary_search_by_key(&tid, |task| task.identity.pid).is_err()
                && !self.task_departed_by_id(tid, deadline)?
            {
                return Err(io::Error::other("new live task not captured"));
            }
        }
        for task in &self.tasks {
            match task.recheck(deadline) {
                Ok(()) => (),
                Err(error) if error.kind() == io::ErrorKind::NotFound
                    && self.task_departed_by_id(task.identity.pid, deadline)? => (),
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    /// Reclose task membership, generations, all UID fields and namespaces.
    /// A terminated leader is not proof that a live sibling has no resources.
    pub fn recheck(&self, deadline: Instant) -> io::Result<()> {
        deadline_check(deadline)?;
        let pid = self.identity.pid;
        if !process::process(pid)?.same_identity(&self.identity) {
            return Err(io::Error::other("process identity changed"));
        }
        self.recheck_membership(deadline)?;
        self.recheck_membership(deadline)?;
        if !process::process(pid)?.same_identity(&self.identity) {
            return Err(io::Error::other("process changed during closure"));
        }
        Ok(())
    }

    /// Actual pidfd readiness is exposed separately: terminal processes may
    /// remain in the census, and a terminal leader can have live siblings.
    pub fn terminated(&self) -> io::Result<bool> {
        linux::pidfd_terminated(&self.pidfd)
    }

    fn recheck_leader(&self, deadline: Instant) -> io::Result<Process> {
        deadline_check(deadline)?;
        let current = process::process(self.identity.pid)?;
        if !current.same_identity(&self.identity) {
            return Err(io::Error::other("process identity changed"));
        }
        Ok(current)
    }

    fn terminal_group(&self, deadline: Instant) -> io::Result<bool> {
        // One authenticated live leader disproves whole-group termination.
        // Do not rescan every sibling for every ordinary live task.
        if !matches!(self.recheck_leader(deadline)?.state, b'Z' | b'X') {
            return Ok(false);
        }
        self.recheck(deadline)?;
        let mut terminal = !self.tasks.is_empty();
        for (index, task) in self.tasks.iter().enumerate() {
            if self.task_departed(index, deadline)? { continue; }
            terminal &= matches!(process::process(task.identity.pid)?.state, b'Z' | b'X');
        }
        Ok(terminal)
    }

    /// None denotes a re-proven departed nonleader, never a generic read error.
    /// This closes the selected task and leader, not all sibling resources.
    /// Callers must retain every task slot and recheck the complete ProcessScope
    /// before and after the process resource phase, including final closure.
    pub fn collect_resources(&self, index: usize, deadline: Instant) -> io::Result<Option<References>> {
        let mut attempts = 0;
        loop {
            self.recheck_leader(deadline)?;
            if self.task_departed(index, deadline)? { return Ok(None); }
            attempts += 1;
            let captured: io::Result<References> = (|| {
                let all_terminal = self.terminal_group(deadline)?;
                let task = self.tasks.get(index).ok_or_else(|| io::Error::other("unknown task index"))?;
                let references = References::collect(task, all_terminal, deadline)?;
                references.recheck_task(task, all_terminal, deadline)?;
                self.recheck_leader(deadline)?;
                Ok(references)
            })();
            match captured {
                Ok(references) => return Ok(Some(references)),
                Err(error) if error.kind() == io::ErrorKind::NotFound
                    && self.task_departed(index, deadline)? => return Ok(None),
                Err(error) => {
                    // No reference from a failed attempt has been classified or
                    // published. Recapture the WHOLE task; never omit a changed FD.
                    // Final recheck_resources deliberately has no such retry.
                    if attempts == 3 || !matches!(error.kind(),
                        io::ErrorKind::NotFound | io::ErrorKind::Interrupted)
                    { return Err(error); }
                    self.recheck_leader(deadline)?;
                }
            }
        }
    }

    pub fn recheck_resources(&self, index: usize, references: &References,
        deadline: Instant) -> io::Result<()> {
        self.recheck_leader(deadline)?;
        if self.task_departed(index, deadline)? { return Ok(()); }
        let checked: io::Result<()> = (|| {
            let all_terminal = self.terminal_group(deadline)?;
            let task = self.tasks.get(index).ok_or_else(|| io::Error::other("unknown task index"))?;
            references.recheck_task(task, all_terminal, deadline)?;
            self.recheck_leader(deadline).map(|_| ())
        })();
        match checked {
            Err(error) if error.kind() == io::ErrorKind::NotFound
                && self.task_departed(index, deadline)? => Ok(()),
            result => result,
        }
    }
}


impl TaskScope {
    pub fn recheck(&self, deadline: Instant) -> io::Result<()> {
        deadline_check(deadline)?;
        if !process::process(self.identity.pid)?.same_identity(&self.identity)
            || process::uids(self.identity.pid)? != self.uids
        { return Err(io::Error::other("task identity or credentials changed")); }
        let task_scope = objects::pin_magic(format!("/proc/{}/task/{}", self.tgid, self.identity.pid))?;
        let mapping_scope = objects::pin_magic(format!("/proc/{}", self.identity.pid))?;
        if objects::identity(&task_scope)? != objects::identity(&self.scope)?
            || objects::identity(&mapping_scope)? != objects::identity(&self.mapping_scope)?
        { return Err(io::Error::other("task proc directory generation changed")); }
        recheck_namespaces(self)?;
        if !process::process(self.identity.pid)?.same_identity(&self.identity)
            || process::uids(self.identity.pid)? != self.uids
        { return Err(io::Error::other("task generation or credentials did not close")); }
        Ok(())
    }
}

impl References {
    fn collect(task: &TaskScope, all_terminal: bool, deadline: Instant) -> io::Result<Self> {
        let base = scope_path(&task.scope);
        let mapping_base = scope_path(&task.mapping_scope);
        let no_mm = no_mm_role(task, all_terminal, deadline)?;
        let root = pin_optional(format!("{base}/root"), no_mm, deadline)?;
        let cwd = pin_optional(format!("{base}/cwd"), no_mm, deadline)?;
        let exe = pin_optional(format!("{base}/exe"), no_mm, deadline)?;
        if root.as_ref().is_some_and(|held| !held.directory)
            || cwd.as_ref().is_some_and(|held| !held.directory)
        { return Err(io::Error::other("invalid task directory capability")); }
        let mut descriptors = Vec::new();
        for number in numbers(format!("{base}/fd"), deadline)? {
            let held = Held::pin(format!("{base}/fd/{number}"), deadline)?;
            qualify_object(&held)?;
            descriptors.push((number, held));
        }
        let mut mappings = Vec::new();
        for name in mapping_names(&task.mapping_scope, deadline)? {
            let held = Held::pin(format!("{mapping_base}/map_files/{name}"), deadline)?;
            if !held.file.metadata()?.is_file() || linux::filesystem_type(&held.file)? == 0x09041934 {
                return Err(io::Error::other("unqualified mapped kernel object"));
            }
            mappings.push((name, held));
        }
        if no_mm && (exe.is_some() || !descriptors.is_empty() || !mappings.is_empty()) {
            return Err(io::Error::other("resource-empty task gained user resources"));
        }
        for held in root.iter().chain(cwd.iter()).chain(exe.iter()) { qualify_object(held)?; }
        Ok(Self { root, cwd, exe, descriptors, mappings, no_mm })
    }

    fn recheck_task(&self, task: &TaskScope, all_terminal: bool, deadline: Instant) -> io::Result<()> {
        task.recheck(deadline)?;
        let base = scope_path(&task.scope);
        let mapping_base = scope_path(&task.mapping_scope);
        if no_mm_role(task, all_terminal, deadline)? != self.no_mm {
            return Err(io::Error::other("task mm resource role changed"));
        }
        for (name, held) in [("root", &self.root), ("cwd", &self.cwd), ("exe", &self.exe)] {
            match held {
                Some(held) => { held.recheck(format!("{base}/{name}"), deadline)?; qualify_object(held)?; }
                None => if pin_optional(format!("{base}/{name}"), self.no_mm, deadline)?.is_some() {
                    return Err(io::Error::other("task gained root cwd or executable"));
                },
            }
        }
        let expected: Vec<_> = self.descriptors.iter().map(|(number, _)| *number).collect();
        if numbers(format!("{base}/fd"), deadline)? != expected {
            return Err(io::Error::new(io::ErrorKind::Interrupted, "task descriptor membership changed"));
        }
        for (number, held) in &self.descriptors {
            held.recheck(format!("{base}/fd/{number}"), deadline)?;
            qualify_object(held)?;
        }
        let names = mapping_names(&task.mapping_scope, deadline)?;
        if !names.iter().map(String::as_str).eq(self.mappings.iter().map(|(name, _)| name.as_str())) {
            return Err(io::Error::new(io::ErrorKind::Interrupted, "task mapping membership changed"));
        }
        for (name, held) in &self.mappings { held.recheck(format!("{mapping_base}/map_files/{name}"), deadline)?; }
        if numbers(format!("{base}/fd"), deadline)? != expected
            || mapping_names(&task.mapping_scope, deadline)? != names
            || no_mm_role(task, all_terminal, deadline)? != self.no_mm
        { return Err(io::Error::new(io::ErrorKind::Interrupted, "task resources changed during recheck")); }
        task.recheck(deadline)
    }
}

/// Enumerate all visible thread-group leaders without a UID/name filter.
pub fn process_ids(deadline: Instant) -> io::Result<Vec<u32>> { numbers("/proc", deadline) }
