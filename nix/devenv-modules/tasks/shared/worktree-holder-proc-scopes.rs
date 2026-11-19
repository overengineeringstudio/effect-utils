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
            return Err(io::Error::other("process reference changed"));
        }
        Ok(())
    }
}
/// These are event/byte objects, not a blanket pseudo-filesystem exemption.
/// In particular io_uring, pidfds, fanotify and BPF remain unqualified.
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
        if !matches!(name.to_str(), Some("anon_inode:[eventfd]" | "anon_inode:[eventpoll]"
            | "anon_inode:inotify" | "anon_inode:[timerfd]" | "anon_inode:[signalfd]"))
        { return Err(io::Error::other("unsupported path-bearing kernel object")); }
        return Ok(());
    }
    if metadata.file_type().is_char_device()
        || matches!(filesystem, 0x6e736673 | 0x534f434b | 0x50494446)
        || held.directory || metadata.file_type().is_file()
        || metadata.file_type().is_fifo() || metadata.file_type().is_socket()
    { return Ok(()); }
    Err(io::Error::other("unqualified held object"))
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
            let identity = process::process(*tid)?;
            let task_scope = objects::pin_magic(format!("{base}/task/{tid}"))?;
            let uids = process::uids(*tid)?;
            let mut namespaces = Vec::with_capacity(4);
            for name in ["user", "pid", "mnt", "net"] {
                namespaces.push(objects::pin_magic(format!("{}/ns/{name}", scope_path(&task_scope)))?);
            }
            if !process::process(*tid)?.same_identity(&identity) {
                return Err(io::Error::other("task changed during pin"));
            }
            tasks.push(TaskScope { identity, uids, scope: task_scope, namespaces });
        }
        if tasks.is_empty() || !tasks.iter().any(|task| task.identity.pid == pid)
            || numbers(format!("{base}/task"), deadline)? != tids
        {
            return Err(io::Error::other("process task discovery did not close"));
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
            return Err(io::Error::other("process identity changed"));
        }
        let tids: Vec<_> = self.tasks.iter().map(|task| task.identity.pid).collect();
        let base = scope_path(&self.scope);
        if numbers(format!("{base}/task"), deadline)? != tids {
            return Err(io::Error::other("process task membership changed"));
        }
        for task in &self.tasks {
            task.recheck(deadline)?;
        }
        if numbers(format!("{base}/task"), deadline)? != tids
            || !process::process(pid)?.same_identity(&self.identity)
        { return Err(io::Error::other("process changed during closure")); }
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
        let task = self.tasks.get(index).ok_or_else(|| io::Error::other("unknown task index"))?;
        let references = References::collect(task, all_terminal, deadline)?;
        references.recheck_task(task, all_terminal, deadline)?;
        self.recheck(deadline)?;
        Ok(references)
    }

    pub fn recheck_resources(&self, index: usize, references: &References,
        deadline: Instant) -> io::Result<()> {
        let all_terminal = self.terminal_group(deadline)?;
        let task = self.tasks.get(index).ok_or_else(|| io::Error::other("unknown task index"))?;
        references.recheck_task(task, all_terminal, deadline)?;
        self.recheck(deadline)
    }
}

impl TaskScope {
    pub fn recheck(&self, deadline: Instant) -> io::Result<()> {
        deadline_check(deadline)?;
        if !process::process(self.identity.pid)?.same_identity(&self.identity)
            || process::uids(self.identity.pid)? != self.uids
        { return Err(io::Error::other("task identity or credentials changed")); }
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
        { return Err(io::Error::other("invalid task directory capability")); }
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
            return Err(io::Error::other("task descriptor membership changed"));
        }
        for (number, held) in &self.descriptors {
            held.recheck(format!("{base}/fd/{number}"), deadline)?;
            qualify_object(held)?;
        }
        let names = mapping_names(&task.scope, deadline)?;
        if !names.iter().map(String::as_str).eq(self.mappings.iter().map(|(name, _)| name.as_str())) {
            return Err(io::Error::other("task mapping membership changed"));
        }
        for (name, held) in &self.mappings { held.recheck(format!("{base}/map_files/{name}"), deadline)?; }
        if numbers(format!("{base}/fd"), deadline)? != expected
            || mapping_names(&task.scope, deadline)? != names
            || no_mm_role(task, all_terminal, deadline)? != self.no_mm
        { return Err(io::Error::other("task resources changed during recheck")); }
        task.recheck(deadline)
    }
}

/// Enumerate all visible thread-group leaders without a UID/name filter.
pub fn process_ids(deadline: Instant) -> io::Result<Vec<u32>> { numbers("/proc", deadline) }
