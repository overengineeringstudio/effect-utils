//! Retained proc scopes and native resources, extracted from the production census.
//! All errors remain unqualified evidence; callers must never interpret them as absence.
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

/// Only audited source literals reach this diagnostic; never format an error
/// object, proc value, object name or caller-provided string here.
fn incomplete(reason: &'static str) -> io::Error {
    eprintln!("worktree-holder-proc-incomplete reason={reason}");
    io::Error::other(reason)
}

/// Closed kernel spellings, not a prefix or anonymous-filesystem exemption.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AnonymousKernelObject {
    BpfMap, BpfProgram, BpfLink, EventFd, TimerFd, SignalFd, Epoll, Inotify,
    PidFd, UserfaultFd, PerfEvent, IoUring, Fanotify, Unrecognized,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum KernelObjectPathClass { NonPathKernelObject, PathBearingOrUnknown }

impl AnonymousKernelObject {
    fn path_class(self) -> KernelObjectPathClass {
        match self {
            Self::BpfMap | Self::BpfProgram | Self::BpfLink | Self::EventFd
            | Self::TimerFd | Self::SignalFd | Self::Epoll | Self::Inotify
            | Self::PidFd | Self::UserfaultFd | Self::PerfEvent =>
                KernelObjectPathClass::NonPathKernelObject,
            Self::IoUring | Self::Fanotify | Self::Unrecognized =>
                KernelObjectPathClass::PathBearingOrUnknown,
        }
    }

    fn rejected_kind(self) -> &'static str {
        match self {
            Self::IoUring => "io-uring",
            Self::Fanotify => "fanotify",
            _ => "other",
        }
    }
}

fn anonymous_kernel_object(name: &Path) -> AnonymousKernelObject {
    match name.to_str() {
        Some("anon_inode:bpf-map") => AnonymousKernelObject::BpfMap,
        Some("anon_inode:bpf-prog") => AnonymousKernelObject::BpfProgram,
        Some("anon_inode:bpf-link") => AnonymousKernelObject::BpfLink,
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

/// Only the disposable-VM build can format this bounded, prefix-free class.
#[cfg(any(test, holder_owned_vm_class_diagnostics))]
fn owned_vm_anonymous_class(name: &Path) -> Option<&str> {
    let suffix = name.to_str()?.strip_prefix("anon_inode:")?;
    let body = if let Some(bracketed) = suffix.strip_prefix('[') {
        bracketed.strip_suffix(']')?
    } else {
        suffix
    };
    if body.is_empty() || body.len() > 80 || !body.bytes().all(|byte|
        byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-' | b' '))
    {
        return None;
    }
    Some(suffix)
}

#[cfg(test)]
mod diagnostic_tests {
    #[test]
    fn static_reason_preserves_original_other_error() {
        let error = super::incomplete("process reference changed");
        assert_eq!(error.kind(), std::io::ErrorKind::Other);
        assert_eq!(error.raw_os_error(), None);
        assert_eq!(error.to_string(), "process reference changed");
    }

    #[test]
    fn anonymous_kind_is_closed_and_typed() {
        use super::{AnonymousKernelObject as Object, KernelObjectPathClass as Class};
        for (name, object) in [
            ("anon_inode:bpf-map", Object::BpfMap),
            ("anon_inode:bpf-prog", Object::BpfProgram),
            ("anon_inode:bpf-link", Object::BpfLink),
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
    fn owned_vm_class_preserves_exact_safe_spelling_only() {
        for (name, expected) in [
            ("anon_inode:bpf-map", Some("bpf-map")),
            ("anon_inode:[pidfd]", Some("[pidfd]")),
            ("anon_inode:seccomp notify", Some("seccomp notify")),
            ("anon_inode:[seccomp notify]", Some("[seccomp notify]")),
            ("anon_inode:[nested[bracket]]", None),
            ("anon_inode:[unclosed", None),
            ("anon_inode:closed]", None),
            ("anon_inode:has/slash", None),
            ("anon_inode:line\nbreak", None),
            ("anon_inode:", None),
            ("/untrusted/path", None),
        ] {
            assert_eq!(super::owned_vm_anonymous_class(std::path::Path::new(name)), expected);
        }
        use std::os::unix::ffi::OsStrExt;
        let mut oversized = [b'x'; 92];
        oversized[..11].copy_from_slice(b"anon_inode:");
        let path = std::path::Path::new(std::ffi::OsStr::from_bytes(&oversized));
        assert_eq!(super::owned_vm_anonymous_class(path), None);
        let non_utf8 = std::ffi::OsStr::from_bytes(b"anon_inode:\xff");
        assert_eq!(super::owned_vm_anonymous_class(std::path::Path::new(non_utf8)), None);
    }
}

pub struct ProcessScope {
    pub identity: Process,
    pidfd: OwnedFd,
    pub scope: File,
    pub tasks: Vec<TaskScope>,
}

pub struct TaskScope {
    pub identity: Process,
    pub uids: [u32; 4],
    pub scope: File,
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
    let (_, tail) = stat.rsplit_once(')').ok_or_else(|| incomplete("malformed task stat"))?;
    let fields: Vec<_> = tail.split_whitespace().collect();
    if fields.len() < 20 { return Err(incomplete("truncated task stat")); }
    let flags = fields[6].parse::<u64>().map_err(|_| incomplete("invalid task flags"))?;
    let terminal = matches!(fields[0], "Z" | "X");
    if flags & 0x00200000 == 0 && !(all_terminal && terminal) { return Ok(false); }
    if !objects::bounded_text(format!("{base}/maps"), 1024 * 1024)?.is_empty() {
        return Err(incomplete("resource-empty task retains mappings"));
    }
    let statm = objects::bounded_text(format!("{base}/statm"), 4096)?;
    let pages = statm.split_whitespace().map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>().map_err(|_| incomplete("invalid task statm"))?;
    if pages.len() != 7 || pages.iter().any(|page| *page != 0)
        || !numbers(format!("{base}/fd"), deadline)?.is_empty()
    { return Err(incomplete("resource-empty task retains mm or descriptors")); }
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
            return Err(incomplete("task namespace changed"));
        }
    }
    if task.namespaces.len() != 4 { return Err(incomplete("incomplete task namespaces")); }
    Ok(())
}

pub fn deadline_check(deadline: Instant) -> io::Result<()> {
    if Instant::now() >= deadline {
        Err(incomplete("process census deadline"))
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
            return Err(incomplete("proc census capacity"));
        }
        values.push(name.parse().map_err(|_| incomplete("proc numeric identifier overflow"))?);
    }
    values.sort_unstable();
    if values.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(incomplete("duplicate proc identifier"));
    }
    Ok(values)
}

pub fn mapping_names(scope: &File, deadline: Instant) -> io::Result<Vec<String>> {
    let mut names = Vec::new();
    for entry in fs::read_dir(format!("{}/map_files", scope_path(scope)))? {
        deadline_check(deadline)?;
        let name = entry?.file_name().into_string()
            .map_err(|_| incomplete("invalid map_files name"))?;
        let (start, end) = name.split_once('-').ok_or_else(|| incomplete("invalid map_files range"))?;
        if start.is_empty() || end.is_empty()
            || !start.bytes().chain(end.bytes()).all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(incomplete("invalid map_files address"));
        }
        let start = u64::from_str_radix(start, 16).map_err(|_| incomplete("invalid map start"))?;
        let end = u64::from_str_radix(end, 16).map_err(|_| incomplete("invalid map end"))?;
        if start >= end || names.len() >= OBJECT_LIMIT {
            return Err(incomplete("invalid or excessive map_files ranges"));
        }
        names.push(name);
    }
    names.sort_unstable();
    if names.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(incomplete("duplicate mapping range"));
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
            return Err(incomplete("process reference changed"));
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
        return Err(incomplete("unqualified block device"));
    }
    if filesystem == 0x09041934 {
        let name = fs::read_link(scope_path(&held.file))?;
        let object = anonymous_kernel_object(&name);
        if object.path_class() == KernelObjectPathClass::PathBearingOrUnknown {
            #[cfg(holder_owned_vm_class_diagnostics)]
            {
                let class = owned_vm_anonymous_class(&name).unwrap_or("unprintable");
                eprintln!("worktree-holder-proc-owned-vm-rejected-anon class={class}");
            }
            eprintln!("worktree-holder-proc-unsupported-anon kind={}", object.rejected_kind());
            return Err(incomplete("unsupported path-bearing kernel object"));
        }
        return Ok(());
    }
    if metadata.file_type().is_char_device()
        || matches!(filesystem, 0x6e736673 | 0x534f434b | 0x50494446)
        || held.directory || metadata.file_type().is_file()
        || metadata.file_type().is_fifo() || metadata.file_type().is_socket()
    { return Ok(()); }
    Err(incomplete("unqualified held object"))
}

impl ProcessScope {
    pub fn discover(pid: u32, deadline: Instant) -> io::Result<Self> {
        deadline_check(deadline)?;
        let identity = process::process(pid)?;
        let pidfd = linux::pin_process(pid)?;
        let scope = objects::pin_magic(format!("/proc/{pid}"))?;
        if !process::process(pid)?.same_identity(&identity) {
            return Err(incomplete("process changed during pin"));
        }
        let base = scope_path(&scope);
        let tids = numbers(format!("{base}/task"), deadline)?;
        let mut tasks = Vec::new();
        for tid in &tids {
            let identity = process::process(*tid)?;
            let task_scope = objects::pin_magic(format!("{base}/task/{tid}"))?;
            let uids = process::uids(*tid)?;
            let mut namespaces = Vec::with_capacity(4);
            for name in ["user", "pid", "mnt", "net"] {
                namespaces.push(objects::pin_magic(format!("{}/ns/{name}", scope_path(&task_scope)))?);
            }
            if !process::process(*tid)?.same_identity(&identity) {
                return Err(incomplete("task changed during pin"));
            }
            tasks.push(TaskScope { identity, uids, scope: task_scope, namespaces });
        }
        if tasks.is_empty() || !tasks.iter().any(|task| task.identity.pid == pid)
            || numbers(format!("{base}/task"), deadline)? != tids
        {
            return Err(incomplete("process task discovery did not close"));
        }
        Ok(Self { identity, pidfd, scope, tasks })
    }

    pub fn same_selection(&self, other: &Self) -> io::Result<bool> {
        if !self.identity.same_identity(&other.identity)
            || objects::identity(&self.scope)? != objects::identity(&other.scope)?
            || self.tasks.len() != other.tasks.len()
        { return Ok(false); }
        for (before, after) in self.tasks.iter().zip(&other.tasks) {
            if !before.identity.same_identity(&after.identity) || before.uids != after.uids
                || objects::identity(&before.scope)? != objects::identity(&after.scope)?
                || before.namespaces.len() != after.namespaces.len()
            { return Ok(false); }
            for (a, b) in before.namespaces.iter().zip(&after.namespaces) {
                if objects::identity(a)? != objects::identity(b)? { return Ok(false); }
            }
        }
        Ok(true)
    }

    /// Reclose task membership, generations, all UID fields and namespaces.
    /// A terminated leader is not proof that a live sibling has no resources.
    pub fn recheck(&self, deadline: Instant) -> io::Result<()> {
        deadline_check(deadline)?;
        let pid = self.identity.pid;
        if !process::process(pid)?.same_identity(&self.identity) {
            return Err(incomplete("process identity changed"));
        }
        let tids: Vec<_> = self.tasks.iter().map(|task| task.identity.pid).collect();
        let base = scope_path(&self.scope);
        if numbers(format!("{base}/task"), deadline)? != tids {
            return Err(incomplete("process task membership changed"));
        }
        for task in &self.tasks {
            task.recheck(deadline)?;
        }
        if numbers(format!("{base}/task"), deadline)? != tids
            || !process::process(pid)?.same_identity(&self.identity)
        { return Err(incomplete("process changed during closure")); }
        Ok(())
    }

    /// Actual pidfd readiness is exposed separately: terminal processes may
    /// remain in the census, and a terminal leader can have live siblings.
    pub fn terminated(&self) -> io::Result<bool> {
        linux::pidfd_terminated(&self.pidfd)
    }

    fn terminal_group(&self, deadline: Instant) -> io::Result<bool> {
        self.recheck(deadline)?;
        let mut terminal = !self.tasks.is_empty();
        for task in &self.tasks {
            terminal &= matches!(process::process(task.identity.pid)?.state, b'Z' | b'X');
        }
        Ok(terminal)
    }

    pub fn collect_resources(&self, index: usize, deadline: Instant) -> io::Result<References> {
        let all_terminal = self.terminal_group(deadline)?;
        let task = self.tasks.get(index).ok_or_else(|| incomplete("unknown task index"))?;
        let references = References::collect(task, all_terminal, deadline)?;
        references.recheck_task(task, all_terminal, deadline)?;
        self.recheck(deadline)?;
        Ok(references)
    }

    pub fn recheck_resources(&self, index: usize, references: &References,
        deadline: Instant) -> io::Result<()> {
        let all_terminal = self.terminal_group(deadline)?;
        let task = self.tasks.get(index).ok_or_else(|| incomplete("unknown task index"))?;
        references.recheck_task(task, all_terminal, deadline)?;
        self.recheck(deadline)
    }
}

impl TaskScope {
    pub fn recheck(&self, deadline: Instant) -> io::Result<()> {
        deadline_check(deadline)?;
        if !process::process(self.identity.pid)?.same_identity(&self.identity)
            || process::uids(self.identity.pid)? != self.uids
        { return Err(incomplete("task identity or credentials changed")); }
        recheck_namespaces(self)
    }
}

impl References {
    fn collect(task: &TaskScope, all_terminal: bool, deadline: Instant) -> io::Result<Self> {
        let base = scope_path(&task.scope);
        let no_mm = no_mm_role(task, all_terminal, deadline)?;
        let root = pin_optional(format!("{base}/root"), no_mm, deadline)?;
        let cwd = pin_optional(format!("{base}/cwd"), no_mm, deadline)?;
        let exe = pin_optional(format!("{base}/exe"), no_mm, deadline)?;
        if root.as_ref().is_some_and(|held| !held.directory)
            || cwd.as_ref().is_some_and(|held| !held.directory)
        { return Err(incomplete("invalid task directory capability")); }
        let mut descriptors = Vec::new();
        for number in numbers(format!("{base}/fd"), deadline)? {
            let held = Held::pin(format!("{base}/fd/{number}"), deadline)?;
            qualify_object(&held)?;
            descriptors.push((number, held));
        }
        let mut mappings = Vec::new();
        for name in mapping_names(&task.scope, deadline)? {
            let held = Held::pin(format!("{base}/map_files/{name}"), deadline)?;
            if !held.file.metadata()?.is_file() || linux::filesystem_type(&held.file)? == 0x09041934 {
                return Err(incomplete("unqualified mapped kernel object"));
            }
            mappings.push((name, held));
        }
        if no_mm && (exe.is_some() || !descriptors.is_empty() || !mappings.is_empty()) {
            return Err(incomplete("resource-empty task gained user resources"));
        }
        for held in root.iter().chain(cwd.iter()).chain(exe.iter()) { qualify_object(held)?; }
        Ok(Self { root, cwd, exe, descriptors, mappings, no_mm })
    }

    fn recheck_task(&self, task: &TaskScope, all_terminal: bool, deadline: Instant) -> io::Result<()> {
        task.recheck(deadline)?;
        let base = scope_path(&task.scope);
        if no_mm_role(task, all_terminal, deadline)? != self.no_mm {
            return Err(incomplete("task mm resource role changed"));
        }
        for (name, held) in [("root", &self.root), ("cwd", &self.cwd), ("exe", &self.exe)] {
            match held {
                Some(held) => { held.recheck(format!("{base}/{name}"), deadline)?; qualify_object(held)?; }
                None => if pin_optional(format!("{base}/{name}"), self.no_mm, deadline)?.is_some() {
                    return Err(incomplete("task gained root cwd or executable"));
                },
            }
        }
        let expected: Vec<_> = self.descriptors.iter().map(|(number, _)| *number).collect();
        if numbers(format!("{base}/fd"), deadline)? != expected {
            return Err(incomplete("task descriptor membership changed"));
        }
        for (number, held) in &self.descriptors {
            held.recheck(format!("{base}/fd/{number}"), deadline)?;
            qualify_object(held)?;
        }
        let names = mapping_names(&task.scope, deadline)?;
        if !names.iter().map(String::as_str).eq(self.mappings.iter().map(|(name, _)| name.as_str())) {
            return Err(incomplete("task mapping membership changed"));
        }
        for (name, held) in &self.mappings { held.recheck(format!("{base}/map_files/{name}"), deadline)?; }
        if numbers(format!("{base}/fd"), deadline)? != expected
            || mapping_names(&task.scope, deadline)? != names
            || no_mm_role(task, all_terminal, deadline)? != self.no_mm
        { return Err(incomplete("task resources changed during recheck")); }
        task.recheck(deadline)
    }
}

/// Enumerate all visible thread-group leaders without a UID/name filter.
pub fn process_ids(deadline: Instant) -> io::Result<Vec<u32>> { numbers("/proc", deadline) }
