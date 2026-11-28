//! Retained proc scopes and native resources, extracted from the production census.
//! Failed proofs remain unqualified evidence; callers never treat errors as absence.
//! Native KCMP_FILES classes share FD pins/seals, never task membership authority.
//! Five unpublished pair-repair passes belong to a process resource phase.
//! Missing-before-pin or pair exhaustion invokes three bounded process-closing
//! passes; every old pin remains qualified through final closure.
use std::cell::{Cell, RefCell};
use std::fs::{self, File};
use std::io;
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::rc::Rc;
use std::collections::BTreeSet;
use std::ops::Deref;
use std::path::Path;
use std::time::Instant;
use super::{linux, objects, process};
use super::objects::Identity;
use super::process::Process;

const TASK_LIMIT: usize = 262144;
const OBJECT_LIMIT: usize = 1048576;
const FD_SNAPSHOT_PASSES: usize = 5;
const PROCESS_CLOSING_PASSES: usize = 3;

/// Resource semantics and the actual task scope must accompany native proof:
/// siblings may have private files/fs/mount contexts.
#[derive(Clone, Copy)]
pub enum ResourceKind { Root, Cwd, Exe, Fd, Map }

/// `fresh` charges a newly retained pin to the transaction-wide budget.
/// Success means authenticated native negative, never unknown or positive.
/// None requests the strict snapshot contract, with no closing repair.
pub type NativeNegativeProof<'a> =
    dyn FnMut(&TaskScope, &Held, ResourceKind, bool) -> io::Result<()> + 'a;

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
    file_classes: Vec<FileClass>,
    task_file_class: Vec<usize>,
    resource_epoch: Cell<u64>,
    resource_phase_active: Cell<bool>,
    closing_passes: Cell<usize>,
    fd_repair_passes: Cell<usize>,
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
    pub descriptors: Rc<DescriptorSnapshot>,
    pub mappings: Vec<(String, Held)>,
    table: Rc<DescriptorTable>,
    /// Full-process follow-up pins remain alive with the selected snapshot.
    closing_witness: RefCell<Vec<(usize, References)>>,
    no_mm: bool,
}

/// A physical set of O_PATH pins. Rc copies ownership, never kernel FDs.
pub struct DescriptorSnapshot {
    pins: Vec<(u32, Held)>,
    charged: Cell<bool>,
}
impl Deref for DescriptorSnapshot {
    type Target = Vec<(u32, Held)>;
    fn deref(&self) -> &Self::Target { &self.pins }
}
impl DescriptorSnapshot {
    fn new(pins: Vec<(u32, Held)>) -> Rc<Self> {
        Rc::new(Self { pins, charged: Cell::new(false) })
    }
    fn claim_charge(&self) -> bool { !self.charged.replace(true) }
    fn prove(&self, task: &TaskScope, repair: &mut Option<&mut NativeNegativeProof<'_>>,
        fresh: bool) -> io::Result<()> {
        let proof = repair.as_mut().ok_or_else(|| io::Error::other("missing native descriptor proof"))?;
        let charge = fresh && self.claim_charge();
        for (_, held) in self.iter() {
            qualify_object(held)?;
            (**proof)(task, held, ResourceKind::Fd, charge).map_err(descriptor_proof_error)?;
        }
        Ok(())
    }
}
struct DescriptorTable {
    initial: Rc<DescriptorSnapshot>,
    repairs: RefCell<Vec<Rc<DescriptorSnapshot>>>,
    missing: Cell<bool>,
    sealed_epoch: Cell<u64>,
}
struct FileClass {
    representative: usize,
    members: Vec<usize>,
    table: RefCell<Option<Rc<DescriptorTable>>>,
    collected_epoch: Cell<u64>,
}
/// One collection/closure phase. Outside a batch the public per-task APIs
/// create their own phase, so a later direct recheck never reuses an old seal.
pub struct ResourcePhase<'a>(&'a ProcessScope);
impl Drop for ResourcePhase<'_> {
    fn drop(&mut self) { self.0.resource_phase_active.set(false); }
}
#[derive(Debug)]
pub enum DescriptorInstability { StablePair, ProcessClosing, ClassMembership }
impl std::fmt::Display for DescriptorInstability {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(match self {
            Self::StablePair => "descriptor stable-pair budget exhausted",
            Self::ProcessClosing => "process closing pass budget exhausted",
            Self::ClassMembership => "descriptor class membership changed",
        })
    }
}
impl std::error::Error for DescriptorInstability {}
pub fn descriptor_instability(error: &io::Error) -> Option<&DescriptorInstability> {
    error.get_ref()?.downcast_ref()
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
        let mut captured = Self { identity, pidfd, scope, tasks,
            file_classes: Vec::new(), task_file_class: Vec::new(),
            resource_epoch: Cell::new(0), resource_phase_active: Cell::new(false),
            closing_passes: Cell::new(0), fd_repair_passes: Cell::new(0) };
        captured.recheck(deadline)?;
        let mut comparison_available = true;
        for index in 0..captured.tasks.len() {
            let mut shared = None;
            for (class_index, class) in captured.file_classes.iter().enumerate() {
                if !comparison_available { break; }
                deadline_check(deadline)?;
                match linux::same_files(captured.tasks[class.representative].identity.pid,
                    captured.tasks[index].identity.pid) {
                    Ok(true) => { shared = Some(class_index); break; }
                    Ok(false) => (),
                    // Unavailable kernel proof means independent capture.
                    Err(error) if matches!(error.raw_os_error(), Some(1 | 13 | 38 | 95)) => {
                        comparison_available = false; break;
                    }
                    Err(error) if error.raw_os_error() == Some(3) => (),
                    Err(error) => return Err(error),
                }
            }
            let class_index = shared.unwrap_or_else(|| {
                captured.file_classes.push(FileClass { representative: index,
                    members: Vec::new(), table: RefCell::new(None), collected_epoch: Cell::new(0) });
                captured.file_classes.len() - 1
            });
            captured.file_classes[class_index].members.push(index);
            captured.task_file_class.push(class_index);
        }
        captured.recheck(deadline)?;
        Ok(captured)
    }

    fn recheck_file_class(&self, class: &FileClass, deadline: Instant) -> io::Result<()> {
        if class.members.len() == 1 { return Ok(()); }
        let representative = &self.tasks[class.representative];
        for index in &class.members {
            if *index == class.representative { continue; }
            deadline_check(deadline)?;
            match linux::same_files(representative.identity.pid, self.tasks[*index].identity.pid) {
                Ok(true) => (),
                Err(error) if error.raw_os_error() == Some(3)
                    && self.task_departed(*index, deadline)? => (),
                Err(error) => return Err(error),
                Ok(false) => return Err(io::Error::other(DescriptorInstability::ClassMembership)),
            }
        }
        Ok(())
    }

    fn recheck_file_classes(&self, deadline: Instant) -> io::Result<()> {
        for class in &self.file_classes { self.recheck_file_class(class, deadline)?; }
        Ok(())
    }

    /// Standalone task checks authenticate only the physical files class.
    /// A sibling's native namespace/root authority still belongs to its own
    /// logical task check and the caller's mandatory complete-group seals.
    fn recheck_task_file_class(&self, index: usize, deadline: Instant) -> io::Result<()> {
        let class = self.task_file_class.get(index).and_then(|class| self.file_classes.get(*class))
            .ok_or_else(|| io::Error::other("unknown task descriptor class"))?;
        for pass in 0..2 {
            for member in &class.members {
                if self.task_present(*member, deadline)?
                    && process::uids(self.tasks[*member].identity.pid)? != self.tasks[*member].uids
                { return Err(io::Error::other("descriptor class credentials changed")); }
            }
            if pass == 0 { self.recheck_file_class(class, deadline)?; }
        }
        self.recheck_leader(deadline).map(|_| ())
    }

    /// Batch admission authenticates the entire retained process.
    pub fn resource_phase(&self, deadline: Instant) -> io::Result<ResourcePhase<'_>> {
        if self.resource_phase_active.get() { return Err(io::Error::other("nested process resource phase")); }
        self.recheck(deadline)?;
        self.start_resource_phase(deadline)
    }

    fn start_resource_phase(&self, deadline: Instant) -> io::Result<ResourcePhase<'_>> {
        deadline_check(deadline)?;
        if self.resource_phase_active.get() { return Err(io::Error::other("nested process resource phase")); }
        self.resource_epoch.set(self.resource_epoch.get().checked_add(1)
            .ok_or_else(|| io::Error::other("process resource epoch exhausted"))?);
        self.fd_repair_passes.set(0);
        self.resource_phase_active.set(true);
        Ok(ResourcePhase(self))
    }

    fn ensure_resource_phase(&self, deadline: Instant) -> io::Result<Option<ResourcePhase<'_>>> {
        if self.resource_phase_active.get() { Ok(None) } else { self.start_resource_phase(deadline).map(Some) }
    }

    /// Close each physical class once after every logical task context ran.
    /// New/failed snapshots still qualify in *every* member's native view.
    pub fn finish_resource_phase(&self, resources: &[(usize, &References)], deadline: Instant,
        mut proof: Option<&mut NativeNegativeProof<'_>>) -> io::Result<()> {
        let _phase = self.ensure_resource_phase(deadline)?;
        self.recheck(deadline)?;
        let mut seen = BTreeSet::new();
        for (index, references) in resources {
            let class = self.task_file_class[*index];
            if !self.task_present(*index, deadline)? || !seen.insert(class) { continue; }
            references.table.sealed_epoch.set(0);
            match proof.as_mut() {
                Some(proof) => self.recheck_resources(*index, references, deadline, Some(&mut **proof))?,
                None => self.recheck_resources(*index, references, deadline, None)?,
            }
        }
        for (index, references) in resources {
            if !self.task_present(*index, deadline)? { continue; }
            references.prove_repaired_descriptors(&self.tasks[*index], &mut proof)?;
        }
        self.recheck(deadline)?;
        for (index, references) in resources {
            if !self.task_present(*index, deadline)? || !seen.remove(&self.task_file_class[*index]) { continue; }
            match check_descriptors(&references.table.latest(), &self.tasks[*index], deadline) {
                Ok(()) => (),
                Err(error) if matches!(error.kind(), io::ErrorKind::Interrupted | io::ErrorKind::NotFound) => {
                    self.close_missing_descriptors(*index, references, deadline, &mut proof)
                        .map_err(descriptor_proof_error)?;
                }
                Err(error) => return Err(error),
            }
        }
        self.recheck(deadline)
    }

    /// A standalone selected-task phase is not a complete-process census.
    /// Reclose its FD pair after root/cwd/exe/maps, without checking unrelated
    /// sibling namespaces. Real FD instability still invokes the full-process
    /// closing witness and therefore cannot waive any changed sibling context.
    fn finish_task_resource_phase(&self, index: usize, references: &References,
        deadline: Instant, mut proof: Option<&mut NativeNegativeProof<'_>>) -> io::Result<()> {
        let finished = (|| {
            self.recheck_task_file_class(index, deadline)?;
            if !self.task_present(index, deadline)? { return Ok(()); }
            references.table.sealed_epoch.set(0);
            if let Err(error) = references.recheck_descriptors(&self.tasks[index], deadline,
                &mut proof, self.resource_epoch.get(), &self.fd_repair_passes) {
                if !references.table.missing.get() && descriptor_instability(&error).is_none() {
                    return Err(error);
                }
                self.close_missing_descriptors(index, references, deadline, &mut proof)
                    .map_err(descriptor_proof_error)?;
            }
            self.tasks[index].recheck(deadline)?;
            self.recheck_task_file_class(index, deadline)
        })();
        match finished {
            Err(error) if error.kind() == io::ErrorKind::NotFound
                && self.task_departed(index, deadline)? => Ok(()),
            result => result,
        }
    }

    pub fn descriptor_class_count(&self) -> usize { self.file_classes.len() }

    fn task_present(&self, index: usize, deadline: Instant) -> io::Result<bool> {
        deadline_check(deadline)?;
        let task = self.tasks.get(index).ok_or_else(|| io::Error::other("unknown task index"))?;
        match process::process(task.identity.pid) {
            Ok(current) if current.same_identity(&task.identity) => Ok(true),
            Ok(_) => Err(io::Error::other("task generation changed")),
            Err(error) if error.kind() == io::ErrorKind::NotFound
                && self.task_departed(index, deadline)? => Ok(false),
            Err(error) => Err(error),
        }
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
        self.recheck_file_classes(deadline)?;
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
    pub fn collect_resources(&self, index: usize, deadline: Instant,
        mut repair: Option<&mut NativeNegativeProof<'_>>) -> io::Result<Option<References>> {
        let _phase = self.ensure_resource_phase(deadline)?;
        if _phase.is_some() { self.recheck_task_file_class(index, deadline)?; }
        let mut attempts = 0;
        loop {
            self.recheck_leader(deadline)?;
            if !self.task_present(index, deadline)? { return Ok(None); }
            attempts += 1;
            let captured: io::Result<References> = (|| {
                let all_terminal = self.terminal_group(deadline)?;
                let task = self.tasks.get(index).ok_or_else(|| io::Error::other("unknown task index"))?;
                let class = &self.file_classes[self.task_file_class[index]];
                let prior = if class.collected_epoch.get() == self.resource_epoch.get() {
                    class.table.borrow().clone()
                } else { None };
                let references = References::collect(task, all_terminal, deadline, &mut repair, prior)?;
                *class.table.borrow_mut() = Some(Rc::clone(&references.table));
                class.collected_epoch.set(self.resource_epoch.get());
                if references.table.missing.get() {
                    self.close_missing_descriptors(index, &references, deadline, &mut repair)
                        .map_err(descriptor_proof_error)?;
                }
                if let Err(error) = references.recheck_task(task, all_terminal, deadline, &mut repair,
                    self.resource_epoch.get(), &self.fd_repair_passes) {
                    if !references.table.missing.get() && descriptor_instability(&error).is_none() { return Err(error); }
                    self.close_missing_descriptors(index, &references, deadline, &mut repair)
                        .map_err(descriptor_proof_error)?;
                    references.recheck_task(task, all_terminal, deadline, &mut repair,
                        self.resource_epoch.get(), &self.fd_repair_passes)?;
                }
                self.recheck_leader(deadline)?;
                Ok(references)
            })();
            match captured {
                Ok(references) => {
                    if _phase.is_some() {
                        self.finish_task_resource_phase(index, &references, deadline, repair)?;
                    }
                    return Ok(Some(references));
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound
                    && self.task_departed(index, deadline)? => return Ok(None),
                Err(error) => {
                    // Whole-task recapture remains unpublished and bounded.
                    // Once an FD was pinned, native negative proof is required
                    // before this retry can forget it; positives/unknowns HOLD.
                    if attempts == 3 || !matches!(error.kind(),
                        io::ErrorKind::NotFound | io::ErrorKind::Interrupted)
                    { return Err(error); }
                    self.recheck_leader(deadline)?;
                }
            }
        }
    }

    pub fn recheck_resources(&self, index: usize, references: &References,
        deadline: Instant, mut repair: Option<&mut NativeNegativeProof<'_>>) -> io::Result<()> {
        let _phase = self.ensure_resource_phase(deadline)?;
        if _phase.is_some() { self.recheck_task_file_class(index, deadline)?; }
        self.recheck_leader(deadline)?;
        if !self.task_present(index, deadline)? { return Ok(()); }
        let checked: io::Result<()> = (|| {
            let all_terminal = self.terminal_group(deadline)?;
            let task = self.tasks.get(index).ok_or_else(|| io::Error::other("unknown task index"))?;
            if let Err(error) = references.recheck_task(task, all_terminal, deadline, &mut repair,
                self.resource_epoch.get(), &self.fd_repair_passes) {
                if !references.table.missing.get() && descriptor_instability(&error).is_none() { return Err(error); }
                self.close_missing_descriptors(index, references, deadline, &mut repair)
                    .map_err(descriptor_proof_error)?;
                references.recheck_task(task, all_terminal, deadline, &mut repair,
                    self.resource_epoch.get(), &self.fd_repair_passes)?;
            }
            references.prove_closing_witness(self, &mut repair)?;
            self.recheck_leader(deadline).map(|_| ())
        })();
        if checked.is_ok() && _phase.is_some() {
            self.finish_task_resource_phase(index, references, deadline, repair)?;
        }
        match checked {
            Err(error) if error.kind() == io::ErrorKind::NotFound
                && self.task_departed(index, deadline)? => Ok(()),
            result => result,
        }
    }

    /// Missing-before-pin is uncertainty, not absence. Discharge it only with a
    /// complete native-negative process pass and closing task/resource seals.
    /// Never infer CLONE_FILES/CLONE_FS sharing from thread-group membership.
    fn close_missing_descriptors(&self, selected: usize, references: &References,
        deadline: Instant, repair: &mut Option<&mut NativeNegativeProof<'_>>) -> io::Result<()> {
        if repair.is_none() { return Err(io::Error::other("missing descriptor requires process closing proof")); }
        references.prove_resources(&self.tasks[selected], repair, false)?;
        for class in &self.file_classes {
            if let Some(table) = class.table.borrow().as_ref() {
                for index in &class.members {
                    if !self.task_departed(*index, deadline)? {
                        table.prove(&self.tasks[*index], repair, false)?;
                    }
                }
            }
        }
        while self.closing_passes.get() < PROCESS_CLOSING_PASSES {
            self.closing_passes.set(self.closing_passes.get() + 1);
            self.recheck(deadline)?;
            let all_terminal = self.terminal_group(deadline)?;
            let mut pass = Vec::new();
            let mut incomplete = false;
            let mut tables = vec![None; self.file_classes.len()];
            let closing_pair_budget = Cell::new(0);
            for (index, task) in self.tasks.iter().enumerate() {
                if !self.task_present(index, deadline)? { continue; }
                let class = self.task_file_class[index];
                let snapshot = References::collect(task, all_terminal, deadline, repair, tables[class].clone())?;
                tables[class] = Some(Rc::clone(&snapshot.table));
                snapshot.prove_resources(task, repair, true)?;
                incomplete |= snapshot.table.missing.get();
                pass.push((index, snapshot));
            }
            // Retain even incomplete passes. No previously pinned positive or
            // opaque capability can be forgotten by a subsequent negative.
            let start = references.closing_witness.borrow().len();
            references.closing_witness.borrow_mut().extend(pass);
            if incomplete { continue; }
            let mut sealed = true;
            {
                let witness = references.closing_witness.borrow();
                for (index, snapshot) in &witness[start..] {
                    if !self.task_present(*index, deadline)? { continue; }
                    match snapshot.recheck_task(&self.tasks[*index], all_terminal, deadline, repair,
                        self.resource_epoch.get(), &closing_pair_budget) {
                        Ok(()) => (),
                        Err(error) if snapshot.table.missing.get() || descriptor_instability(&error).is_some()
                            || matches!(error.kind(), io::ErrorKind::Interrupted | io::ErrorKind::NotFound) => {
                            sealed = false;
                            break;
                        }
                        Err(error) => return Err(error),
                    }
                }
            }
            for (class, table) in self.file_classes.iter().zip(&tables) {
                if let Some(table) = table {
                    match check_descriptors(&table.latest(), &self.tasks[class.representative], deadline) {
                        Ok(()) => (),
                        Err(error) if matches!(error.kind(), io::ErrorKind::Interrupted | io::ErrorKind::NotFound) => {
                            sealed = false;
                        }
                        Err(error) => return Err(error),
                    }
                }
            }
            if !sealed { continue; }
            self.recheck(deadline)?;
            references.prove_closing_witness(self, repair)?;
            // Adopt the sealed physical table of every class without copying
            // FDs. All old snapshots remain pinned and native-negative.
            for (class, latest) in self.file_classes.iter().zip(tables) {
                let Some(latest) = latest else { continue; };
                let mut cached = class.table.borrow_mut();
                if let Some(original) = cached.as_ref() {
                    original.repairs.borrow_mut().push(latest.latest());
                    original.missing.set(false);
                    original.sealed_epoch.set(self.resource_epoch.get());
                } else {
                    *cached = Some(latest);
                }
                class.collected_epoch.set(self.resource_epoch.get());
            }
            return Ok(());
        }
        Err(io::Error::other(DescriptorInstability::ProcessClosing))
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

impl DescriptorTable {
    fn capture(task: &TaskScope, deadline: Instant) -> io::Result<Rc<Self>> {
        let (pins, missing) = capture_descriptors(task, deadline)?;
        Ok(Rc::new(Self { initial: DescriptorSnapshot::new(pins), repairs: RefCell::new(Vec::new()),
            missing: Cell::new(missing), sealed_epoch: Cell::new(0) }))
    }
    fn latest(&self) -> Rc<DescriptorSnapshot> {
        self.repairs.borrow().last().unwrap_or(&self.initial).clone()
    }
    fn prove(&self, task: &TaskScope, repair: &mut Option<&mut NativeNegativeProof<'_>>,
        fresh: bool) -> io::Result<()> {
        for snapshot in std::iter::once(&self.initial).chain(self.repairs.borrow().iter()) {
            snapshot.prove(task, repair, fresh)?;
        }
        Ok(())
    }
}

impl References {
    fn collect(task: &TaskScope, all_terminal: bool, deadline: Instant,
        repair: &mut Option<&mut NativeNegativeProof<'_>>,
        prior: Option<Rc<DescriptorTable>>) -> io::Result<Self> {
        let base = scope_path(&task.scope);
        let mapping_base = scope_path(&task.mapping_scope);
        let no_mm = no_mm_role(task, all_terminal, deadline)?;
        let root = pin_optional(format!("{base}/root"), no_mm, deadline)?;
        let cwd = pin_optional(format!("{base}/cwd"), no_mm, deadline)?;
        let exe = pin_optional(format!("{base}/exe"), no_mm, deadline)?;
        if root.as_ref().is_some_and(|held| !held.directory)
            || cwd.as_ref().is_some_and(|held| !held.directory)
        { return Err(io::Error::other("invalid task directory capability")); }
        let table = match prior { Some(table) => table, None => DescriptorTable::capture(task, deadline)? };
        let descriptors = Rc::clone(&table.initial);
        let mut mappings = Vec::new();
        let mapped: io::Result<()> = (|| {
            for name in mapping_names(&task.mapping_scope, deadline)? {
                let held = Held::pin(format!("{mapping_base}/map_files/{name}"), deadline)?;
                if !held.file.metadata()?.is_file() || linux::filesystem_type(&held.file)? == 0x09041934 {
                    return Err(io::Error::other("unqualified mapped kernel object"));
                }
                mappings.push((name, held));
            }
            Ok(())
        })();
        if let Err(error) = mapped {
            if matches!(error.kind(), io::ErrorKind::NotFound | io::ErrorKind::Interrupted) {
                if repair.is_some() { table.prove(task, repair, false)?; }
            }
            // An incomplete FD capture may not escape through a mapping retry.
            return Err(if table.missing.get() { descriptor_proof_error(error) } else { error });
        }
        if no_mm && (exe.is_some() || !descriptors.is_empty() || table.missing.get() || !mappings.is_empty()) {
            return Err(io::Error::other("resource-empty task gained user resources"));
        }
        for held in root.iter().chain(cwd.iter()).chain(exe.iter()) { qualify_object(held)?; }
        Ok(Self { root, cwd, exe, descriptors, mappings, no_mm, table,
            closing_witness: RefCell::new(Vec::new()) })
    }

    fn recheck_task(&self, task: &TaskScope, all_terminal: bool, deadline: Instant,
        repair: &mut Option<&mut NativeNegativeProof<'_>>, epoch: u64, budget: &Cell<usize>) -> io::Result<()> {
        let checked: io::Result<()> = (|| {
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
        self.recheck_descriptors(task, deadline, repair, epoch, budget)?;
        let names = mapping_names(&task.mapping_scope, deadline)?;
        if !names.iter().map(String::as_str).eq(self.mappings.iter().map(|(name, _)| name.as_str())) {
            return Err(io::Error::new(io::ErrorKind::Interrupted, "task mapping membership changed"));
        }
        for (name, held) in &self.mappings { held.recheck(format!("{mapping_base}/map_files/{name}"), deadline)?; }
        if mapping_names(&task.mapping_scope, deadline)? != names
            || no_mm_role(task, all_terminal, deadline)? != self.no_mm
        { return Err(io::Error::new(io::ErrorKind::Interrupted, "task resources changed during recheck")); }
        task.recheck(deadline)
        })();
        if let Err(error) = &checked {
            if matches!(error.kind(), io::ErrorKind::NotFound | io::ErrorKind::Interrupted) {
                if repair.is_some() { self.table.prove(task, repair, false)?; }
            }
        }
        checked
    }

    fn prove_resources(&self, task: &TaskScope,
        repair: &mut Option<&mut NativeNegativeProof<'_>>, fresh: bool) -> io::Result<()> {
        let proof = repair.as_mut().ok_or_else(|| io::Error::other("missing native process proof"))?;
        for (kind, held) in self.root.iter().map(|held| (ResourceKind::Root, held))
            .chain(self.cwd.iter().map(|held| (ResourceKind::Cwd, held)))
            .chain(self.exe.iter().map(|held| (ResourceKind::Exe, held)))
            .chain(self.mappings.iter().map(|(_, held)| (ResourceKind::Map, held))) {
            qualify_object(held)?;
            (**proof)(task, held, kind, fresh).map_err(descriptor_proof_error)?;
        }
        self.table.prove(task, repair, fresh)?;
        Ok(())
    }

    fn prove_repaired_descriptors(&self, task: &TaskScope,
        repair: &mut Option<&mut NativeNegativeProof<'_>>) -> io::Result<()> {
        if !self.table.repairs.borrow().is_empty() { self.table.prove(task, repair, false)?; }
        Ok(())
    }

    pub fn uncharged_descriptor_pin_count(&self) -> usize {
        if self.descriptors.claim_charge() { self.descriptors.len() } else { 0 }
    }

    fn prove_closing_witness(&self, process: &ProcessScope,
        repair: &mut Option<&mut NativeNegativeProof<'_>>) -> io::Result<()> {
        for (index, snapshot) in self.closing_witness.borrow().iter() {
            snapshot.prove_resources(&process.tasks[*index], repair, false)?;
        }
        Ok(())
    }

    pub fn descriptor_pin_count(&self) -> usize {
        self.unique_descriptor_pin_count(&mut BTreeSet::new())
    }

    pub fn unique_descriptor_pin_count(&self, seen: &mut BTreeSet<usize>) -> usize {
        let mut total = 0;
        for snapshot in std::iter::once(&self.table.initial).chain(self.table.repairs.borrow().iter()) {
            if seen.insert(Rc::as_ptr(snapshot) as usize) { total += snapshot.len(); }
        }
        for (_, witness) in self.closing_witness.borrow().iter() {
            total += witness.unique_descriptor_pin_count(seen);
        }
        total
    }

    pub fn closing_non_descriptor_pin_count(&self) -> usize {
        self.closing_witness.borrow().iter().map(|(_, snapshot)|
            snapshot.root.iter().count() + snapshot.cwd.iter().count()
                + snapshot.exe.iter().count() + snapshot.mappings.len()
                + snapshot.closing_non_descriptor_pin_count()).sum()
    }

    pub fn current_descriptor_count(&self) -> usize {
        self.table.latest().len()
    }

    fn recheck_descriptors(&self, task: &TaskScope, deadline: Instant,
        repair: &mut Option<&mut NativeNegativeProof<'_>>, epoch: u64, budget: &Cell<usize>) -> io::Result<()> {
        if self.table.missing.get() {
            return Err(io::Error::other("missing descriptor requires process closing proof"));
        }
        if self.table.sealed_epoch.get() == epoch {
            return self.prove_repaired_descriptors(task, repair);
        }
        let checked = check_descriptors(&self.table.latest(), task, deadline);
        if checked.is_ok() {
            self.prove_repaired_descriptors(task, repair)?;
            self.table.sealed_epoch.set(epoch);
            return Ok(());
        }
        if let Err(error) = &checked {
            if !matches!(error.kind(), io::ErrorKind::Interrupted | io::ErrorKind::NotFound) { return checked; }
        }
        if repair.is_none() { return checked; }
        for pass in 0..FD_SNAPSHOT_PASSES {
            if budget.get() == FD_SNAPSHOT_PASSES {
                return Err(io::Error::other(DescriptorInstability::StablePair));
            }
            budget.set(budget.get() + 1);
            if pass != 0 {
                task.recheck(deadline)?;
                let (pins, missing) = capture_descriptors(task, deadline)?;
                let snapshot = DescriptorSnapshot::new(pins);
                self.table.repairs.borrow_mut().push(Rc::clone(&snapshot));
                self.table.missing.set(missing);
                snapshot.prove(task, repair, true)?;
                self.table.prove(task, repair, false)?;
                if missing { return Err(io::Error::other("missing descriptor requires process closing proof")); }
            } else {
                self.table.prove(task, repair, false)?;
            }
            match check_descriptors(&self.table.latest(), task, deadline) {
                Ok(()) => {
                    task.recheck(deadline)?;
                    self.table.sealed_epoch.set(epoch);
                    return Ok(());
                }
                Err(error) if matches!(error.kind(), io::ErrorKind::Interrupted | io::ErrorKind::NotFound) => (),
                Err(error) => return Err(error),
            }
        }
        Err(io::Error::other(DescriptorInstability::StablePair))
    }
}


fn descriptor_proof_error(error: io::Error) -> io::Error {
    if matches!(error.kind(), io::ErrorKind::NotFound | io::ErrorKind::Interrupted) {
        // The request-level ENOENT retry must not forget an unclassified FD.
        io::Error::other(format!("unqualified descriptor snapshot: {error}"))
    } else { error }
}

#[cfg(test)]
mod descriptor_failure_tests {
    #[test]
    fn failed_native_proof_cannot_enter_outer_capture_retry() {
        for errno in [2, 4] {
            let error = super::descriptor_proof_error(std::io::Error::from_raw_os_error(errno));
            assert_eq!(error.kind(), std::io::ErrorKind::Other);
            assert_eq!(error.raw_os_error(), None);
        }
        for errno in [1, 13, 95] {
            let error = super::descriptor_proof_error(std::io::Error::from_raw_os_error(errno));
            assert_eq!(error.raw_os_error(), Some(errno));
        }
    }
}

/// Deterministic real-kernel races: tests mutate the owned target, not pin results.
#[cfg(test)]
pub(crate) enum DescriptorCaptureStage {
    BeforePin(u32, u32), Missing(u32, u32), Complete(u32), BeforeSeal(u32),
}
#[cfg(test)]
thread_local! {
    static DESCRIPTOR_CAPTURE_HOOK:
        RefCell<Option<Box<dyn FnMut(DescriptorCaptureStage)>>> = RefCell::new(None);
}
#[cfg(test)]
pub(crate) fn descriptor_capture_hook(hook: Option<Box<dyn FnMut(DescriptorCaptureStage)>>) {
    DESCRIPTOR_CAPTURE_HOOK.with(|slot| *slot.borrow_mut() = hook);
}
#[cfg(test)]
fn descriptor_capture_step(stage: DescriptorCaptureStage) {
    DESCRIPTOR_CAPTURE_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().as_mut() { hook(stage); }
    });
}

fn capture_descriptors(task: &TaskScope, deadline: Instant) -> io::Result<(Vec<(u32, Held)>, bool)> {
    let base = scope_path(&task.scope);
    let mut descriptors = Vec::new();
    let mut missing = false;
    for number in numbers(format!("{base}/fd"), deadline)? {
        if descriptors.len() >= OBJECT_LIMIT { return Err(io::Error::other("descriptor capacity")); }
        #[cfg(test)]
        descriptor_capture_step(DescriptorCaptureStage::BeforePin(task.identity.pid, number));
        // ENOENT is recorded as unresolved uncertainty, never as a negative.
        // Only ProcessScope's full-process closing witness may discharge it.
        let held = match Held::pin(format!("{base}/fd/{number}"), deadline) {
            Ok(held) => held,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                missing = true;
                #[cfg(test)]
                descriptor_capture_step(DescriptorCaptureStage::Missing(task.identity.pid, number));
                continue;
            }
            Err(error) => return Err(descriptor_proof_error(error)),
        };
        qualify_object(&held)?;
        descriptors.push((number, held));
    }
    #[cfg(test)]
    descriptor_capture_step(DescriptorCaptureStage::Complete(task.identity.pid));
    Ok((descriptors, missing))
}

fn check_descriptors(descriptors: &[(u32, Held)], task: &TaskScope,
    deadline: Instant) -> io::Result<()> {
    #[cfg(test)]
    descriptor_capture_step(DescriptorCaptureStage::BeforeSeal(task.identity.pid));
    let base = scope_path(&task.scope);
    let current = numbers(format!("{base}/fd"), deadline)?;
    if !current.iter().copied().eq(descriptors.iter().map(|(number, _)| *number)) {
        return Err(io::Error::new(io::ErrorKind::Interrupted, "task descriptor membership changed"));
    }
    for (number, held) in descriptors {
        held.recheck(format!("{base}/fd/{number}"), deadline)?;
        qualify_object(held)?;
    }
    if numbers(format!("{base}/fd"), deadline)? != current {
        return Err(io::Error::new(io::ErrorKind::Interrupted, "task descriptor pair did not close"));
    }
    Ok(())
}

/// Enumerate all visible thread-group leaders without a UID/name filter.
pub fn process_ids(deadline: Instant) -> io::Result<Vec<u32>> { numbers("/proc", deadline) }
