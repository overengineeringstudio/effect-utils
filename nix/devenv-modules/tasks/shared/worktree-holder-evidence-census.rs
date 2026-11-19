//! Retained all-UID/all-task evidence for exactly the requested candidate set.
//! Any unclosed identity, resource, namespace or membership race fails closed.
use std::fs::{self, File};
use std::io;
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::Path;
use std::time::Instant;

use super::candidates::{CandidateSet, MatchOutcome, MountCoverage};
use super::client::{self, Client, Peer, Process, SelfRole};
use super::objects::{self, Identity};
use super::protocol::{self, ObjectIdentity, Reference, ReferenceEffect, ReferenceKind, RootEvidence,
    Status, UnknownReason};
use super::{linux, runtime::Runtime};

const ROOT_REFERENCE_LIMIT: usize = 4096;
const TOTAL_REFERENCE_LIMIT: usize = 65536;
const TASK_LIMIT: usize = 262144;
const OBJECT_LIMIT: usize = 1048576;

pub struct Census<'a> {
    runtime: Option<Runtime>,
    processes: Vec<ProcessScope>,
    self_role: &'a SelfRole,
    request: &'a protocol::Request,
    observation: protocol::Observation,
}

struct ProcessScope {
    identity: Process,
    _pidfd: OwnedFd,
    scope: File,
    tasks: Vec<TaskScope>,
}

struct TaskScope {
    identity: Process,
    uids: [u32; 4],
    scope: File,
    namespaces: Vec<File>,
    resources: Resources,
}

enum Resources {
    Ordinary(References),
    // Discovery-only state; a completed census may never contain this variant.
    Unobserved,
}

struct References {
    root: Option<Held>,
    cwd: Option<Held>,
    exe: Option<Held>,
    descriptors: Vec<(u32, Held)>,
    mappings: Vec<(String, Held)>,
    foreign: bool,
    management: bool,
    no_mm: bool,
    memberships: Vec<MatchOutcome>,
    mounted: Option<MountCoverage>,
}

fn whole_group_terminal(tasks: &[TaskScope]) -> bool {
    !tasks.is_empty() && tasks.iter().all(|task| matches!(task.identity.state, b'Z' | b'X'))
}

struct Held {
    file: File,
    identity: Identity,
    mount: u64,
    directory: bool,
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

fn same_matches(before: &MatchOutcome, after: &MatchOutcome) -> bool {
    match (before, after) {
        (MatchOutcome::NeedsProxy, MatchOutcome::NeedsProxy) => true,
        (MatchOutcome::Native(before), MatchOutcome::Native(after)) =>
            before.len() == after.len() && before.iter().zip(after).all(|(a, b)|
                a.root_index == b.root_index && a.relative_path == b.relative_path
                    && a.identity == b.identity && a.effect == b.effect),
        _ => false,
    }
}

fn recheck_namespaces(task: &TaskScope) -> io::Result<()> {
    for (name, retained) in ["user", "pid", "mnt", "net"].into_iter().zip(&task.namespaces) {
        let actual = objects::pin_magic(format!("{}/ns/{name}", scope_path(&task.scope)))?;
        if objects::identity(&actual)? != objects::identity(retained)? {
            return Err(io::Error::other("task namespace changed"));
        }
    }
    if task.namespaces.len() != 4 { return Err(io::Error::other("incomplete task namespaces")); }
    Ok(())
}

fn deadline_check(deadline: Instant) -> io::Result<()> {
    if Instant::now() >= deadline {
        Err(io::Error::other("process census deadline"))
    } else {
        Ok(())
    }
}

fn scope_path(scope: &File) -> String {
    format!("/proc/self/fd/{}", scope.as_raw_fd())
}

fn numbers(path: impl AsRef<Path>, deadline: Instant) -> io::Result<Vec<u32>> {
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

fn mapping_names(scope: &File, deadline: Instant) -> io::Result<Vec<String>> {
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
    fn pin(path: impl AsRef<Path>, deadline: Instant) -> io::Result<Self> {
        deadline_check(deadline)?;
        let file = objects::pin_magic(path)?;
        let metadata = file.metadata()?;
        Ok(Self { identity: (metadata.dev(), metadata.ino()), mount: objects::mount_id(&file)?,
            directory: metadata.is_dir(), file })
    }

    fn recheck(&self, path: impl AsRef<Path>, deadline: Instant) -> io::Result<()> {
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
fn qualify_object(held: &Held) -> io::Result<()> {
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

fn exempt_descriptor(client: Option<&Client>, request: &protocol::Request, pid: u32,
    task: &TaskScope, number: u32, held: &Held) -> io::Result<bool>
{
    let Some(client) = client else { return Ok(false) };
    let store = request.store.as_ref().ok_or_else(|| io::Error::other("missing authenticated store request"))?;
    if pid != client.process.pid {
        return Ok(false);
    }
    let expected = if i32::try_from(number).ok() == Some(store.root_fd) {
        &client.root
    } else if i32::try_from(number).ok() == Some(store.lease_fd) {
        &client.lease
    } else {
        return Ok(false);
    };
    if held.identity != objects::identity(expected)? || held.mount != objects::mount_id(expected)? {
        return Err(io::Error::other("authenticated management slot changed"));
    }
    // The true thread's table may differ from the leader's. Authenticate this
    // numeric slot using a thread pidfd and helper-owned kcmp, not inode equality.
    let thread = linux::pin_client_task(task.identity.pid)?;
    let current = objects::duplicate_client_fd(&thread, i32::try_from(number)
        .map_err(|_| io::Error::other("management descriptor out of range"))?)?;
    if !client::process(task.identity.pid)?.same_identity(&task.identity)
        || !linux::same_open_file(&current, expected)?
    {
        return Err(io::Error::other("management open-file description changed"));
    }
    Ok(true)
}

fn append_matches(observation: &mut protocol::Observation, matches: &[super::candidates::MatchedReference],
    pid: &Process, task: &TaskScope, kind: ReferenceKind, fd: Option<u32>, total: &mut usize)
{
    for matched in matches {
        let root = &mut observation.roots[matched.root_index];
        if root.references.len() >= ROOT_REFERENCE_LIMIT || *total >= TOTAL_REFERENCE_LIMIT {
            root.complete = false;
            root.references_complete = false;
            root.status = Status::Unknown;
            if !root.unknown_reasons.contains(&UnknownReason::ReferenceOverflow) {
                root.unknown_reasons.push(UnknownReason::ReferenceOverflow);
            }
            observation.complete = false;
            continue;
        }
        root.references.push(Reference { tgid: pid.pid, leader_start: pid.start,
            tid: task.identity.pid, task_start: task.identity.start, uid: task.uids,
            reference: kind, relative_path: matched.relative_path.clone(), identity: matched.identity.clone(),
            effect: matched.effect, fd });
        *total += 1;
    }
}

impl References {
    fn collect(task: &TaskScope, pid: &Process, request: &protocol::Request,
        candidates: &CandidateSet, store_client: Option<&Client>, management: bool,
        all_terminal: bool, runtime: &mut Option<Runtime>, observation: &mut protocol::Observation,
        reference_count: &mut usize, deadline: Instant) -> io::Result<Self>
    {
        let base = scope_path(&task.scope);
        let no_mm = !management && no_mm_role(task, all_terminal, deadline)?;
        let root = pin_optional(format!("{base}/root"), no_mm, deadline)?;
        let cwd = pin_optional(format!("{base}/cwd"), no_mm, deadline)?;
        let exe = pin_optional(format!("{base}/exe"), no_mm, deadline)?;
        if root.as_ref().is_some_and(|held| !held.directory)
            || cwd.as_ref().is_some_and(|held| !held.directory)
        { return Err(io::Error::other("invalid task directory capability")); }
        // The sole checked server role has source-owned metadata descriptors.
        // Re-enumerating those pins would feed the census back into itself.
        // Its actual bootstrap root/cwd/exe/stdio still receive normal matching.
        let slots = if management { vec![0, 1, 2] } else { numbers(format!("{base}/fd"), deadline)? };
        let mut descriptors = Vec::new();
        for number in slots {
            descriptors.push((number, Held::pin(format!("{base}/fd/{number}"), deadline)?));
        }
        let mut mappings = Vec::new();
        for name in mapping_names(&task.scope, deadline)? {
            let held = Held::pin(format!("{base}/map_files/{name}"), deadline)?;
            // Always pin actual vm_file objects, not text paths from /maps.
            if !held.file.metadata()?.is_file() || linux::filesystem_type(&held.file)? == 0x09041934 {
                return Err(io::Error::other("unqualified mapped kernel object"));
            }
            mappings.push((name, held));
        }
        if no_mm && (exe.is_some() || !descriptors.is_empty() || !mappings.is_empty()) {
            return Err(io::Error::other("resource-empty task gained user resources"));
        }
        let mut foreign = false;
        let mut memberships = Vec::new();
        for (kind, fd, held) in root.iter().map(|held| (ReferenceKind::Root, None, held))
            .chain(cwd.iter().map(|held| (ReferenceKind::Cwd, None, held)))
            .chain(exe.iter().map(|held| (ReferenceKind::Exe, None, held)))
            .chain(descriptors.iter().map(|(number, held)| (ReferenceKind::Fd, Some(*number), held)))
            .chain(mappings.iter().map(|(_, held)| (ReferenceKind::Map, None, held)))
        {
            deadline_check(deadline)?;
            qualify_object(held)?;
            let exempt = match fd {
                Some(number) => exempt_descriptor(store_client, request, pid.pid, task, number, held)?,
                None => false,
            };
            // Canonical store positives are resolved by CandidateSet before
            // any proxy policy. Management slots alone may omit those matches.
            let outcome = candidates.matches(&held.file, &task.scope, kind, deadline)?;
            match &outcome {
                MatchOutcome::Native(matches) => {
                    if !exempt { append_matches(observation, matches, pid, task, kind, fd, reference_count); }
                }
                MatchOutcome::NeedsProxy => foreign = true,
            }
            memberships.push(outcome);
        }
        if foreign {
            if management {
                return Err(io::Error::other("server bootstrap unexpectedly proxy-backed"));
            }
            let root = root.as_ref().ok_or_else(|| io::Error::other("proxy task lacks root"))?;
            if runtime.is_none() { *runtime = Some(Runtime::attest(candidates.devices(), deadline)?); }
            runtime.as_ref().ok_or_else(|| io::Error::other("missing proxy attestation"))?
                .admits(pid.pid, task.identity.pid, &root.file, deadline)?;
            for held in std::iter::once(root).chain(cwd.iter()).chain(exe.iter())
                .chain(descriptors.iter().map(|(_, held)| held)) {
                if held.directory && !objects::contained_directory(&held.file, &root.file, deadline)? {
                    return Err(io::Error::other("proxy task has outside-root directory capability"));
                }
            }
        }
        let mounted = if root.is_some() {
            let coverage = candidates.capture_mounts(&task.scope, deadline)?;
            append_matches(observation, coverage.references(), pid, task, ReferenceKind::Mount,
                None, reference_count);
            Some(coverage)
        } else { None };
        Ok(Self { root, cwd, exe, descriptors, mappings, foreign, management, no_mm, memberships, mounted })
    }

    fn recheck(&self, task: &TaskScope, pid: u32, candidates: &CandidateSet,
        runtime: Option<&Runtime>, all_terminal: bool, request: &protocol::Request,
        store_client: Option<&Client>, deadline: Instant) -> io::Result<()>
    {
        let base = scope_path(&task.scope);
        if !self.management && no_mm_role(task, all_terminal, deadline)? != self.no_mm {
            return Err(io::Error::other("task mm resource role changed"));
        }
        for (name, held) in [("root", &self.root), ("cwd", &self.cwd), ("exe", &self.exe)] {
            match held {
                Some(held) => held.recheck(format!("{base}/{name}"), deadline)?,
                None => if pin_optional(format!("{base}/{name}"), self.no_mm, deadline)?.is_some() {
                    return Err(io::Error::other("task gained root cwd or executable"));
                },
            }
        }
        let expected: Vec<_> = self.descriptors.iter().map(|(number, _)| *number).collect();
        if !self.management && numbers(format!("{base}/fd"), deadline)? != expected {
            return Err(io::Error::other("task descriptor membership changed"));
        }
        for (number, held) in &self.descriptors {
            held.recheck(format!("{base}/fd/{number}"), deadline)?;
            exempt_descriptor(store_client, request, pid, task, *number, held)?;
        }
        let names = mapping_names(&task.scope, deadline)?;
        if !names.iter().map(String::as_str).eq(self.mappings.iter().map(|(name, _)| name.as_str())) {
            return Err(io::Error::other("task mapping membership changed"));
        }
        for (name, held) in &self.mappings {
            held.recheck(format!("{base}/map_files/{name}"), deadline)?;
        }
        if let Some(mounted) = &self.mounted { mounted.recheck(candidates, deadline)?; }
        for (index, (kind, held)) in self.root.iter().map(|held| (ReferenceKind::Root, held))
            .chain(self.cwd.iter().map(|held| (ReferenceKind::Cwd, held)))
            .chain(self.exe.iter().map(|held| (ReferenceKind::Exe, held)))
            .chain(self.descriptors.iter().map(|(_, held)| (ReferenceKind::Fd, held)))
            .chain(self.mappings.iter().map(|(_, held)| (ReferenceKind::Map, held))).enumerate()
        {
            qualify_object(held)?;
            // Repeat native namespace/backing proofs, not only inode equality.
            let actual = candidates.matches(&held.file, &task.scope, kind, deadline)?;
            if !same_matches(&self.memberships[index], &actual) {
                return Err(io::Error::other("task root-relative membership or provenance changed"));
            }
            if self.foreign && held.directory {
                let root = self.root.as_ref().ok_or_else(|| io::Error::other("proxy task lacks root"))?;
                if !objects::contained_directory(&held.file, &root.file, deadline)? {
                    return Err(io::Error::other("proxy directory containment changed"));
                }
            }
        }
        if self.foreign {
            let root = self.root.as_ref().ok_or_else(|| io::Error::other("proxy task lacks root"))?;
            runtime.ok_or_else(|| io::Error::other("missing retained proxy proof"))?
                .admits(pid, task.identity.pid, &root.file, deadline)?;
        }
        if (!self.management && numbers(format!("{base}/fd"), deadline)? != expected)
            || mapping_names(&task.scope, deadline)? != names
            || (!self.management && no_mm_role(task, all_terminal, deadline)? != self.no_mm)
        {
            return Err(io::Error::other("task resources changed during recheck"));
        }
        Ok(())
    }
}

impl ProcessScope {
    fn discover(pid: u32, deadline: Instant) -> io::Result<Self> {
        deadline_check(deadline)?;
        let identity = client::process(pid)?;
        let pidfd = linux::pin_process(pid)?;
        let scope = objects::pin_magic(format!("/proc/{pid}"))?;
        if !client::process(pid)?.same_identity(&identity) {
            return Err(io::Error::other("process changed during pin"));
        }
        let base = scope_path(&scope);
        let tids = numbers(format!("{base}/task"), deadline)?;
        let mut tasks = Vec::new();
        for tid in &tids {
            let identity = client::process(*tid)?;
            let task_scope = objects::pin_magic(format!("{base}/task/{tid}"))?;
            let uids = client::uids(*tid)?;
            let mut namespaces = Vec::with_capacity(4);
            for name in ["user", "pid", "mnt", "net"] {
                namespaces.push(objects::pin_magic(format!("{}/ns/{name}", scope_path(&task_scope)))?);
            }
            if !client::process(*tid)?.same_identity(&identity) {
                return Err(io::Error::other("task changed during pin"));
            }
            tasks.push(TaskScope { identity, uids, scope: task_scope, namespaces, resources: Resources::Unobserved });
        }
        if tasks.is_empty() || !tasks.iter().any(|task| task.identity.pid == pid)
            || numbers(format!("{base}/task"), deadline)? != tids
        {
            return Err(io::Error::other("process task discovery did not close"));
        }
        Ok(Self { identity, _pidfd: pidfd, scope, tasks })
    }

    fn same_selection(&self, other: &Self) -> io::Result<bool> {
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

    fn recheck(&self, candidates: &CandidateSet, runtime: Option<&Runtime>,
        request: &protocol::Request, store_client: Option<&Client>, deadline: Instant) -> io::Result<()> {
        deadline_check(deadline)?;
        let pid = self.identity.pid;
        if !client::process(pid)?.same_identity(&self.identity) {
            return Err(io::Error::other("process identity changed"));
        }
        let base = scope_path(&self.scope);
        let tids: Vec<_> = self.tasks.iter().map(|task| task.identity.pid).collect();
        if numbers(format!("{base}/task"), deadline)? != tids {
            return Err(io::Error::other("process task membership changed"));
        }
        let all_terminal = whole_group_terminal(&self.tasks);
        for task in &self.tasks {
            let tid = task.identity.pid;
            if !client::process(tid)?.same_identity(&task.identity) || client::uids(tid)? != task.uids {
                return Err(io::Error::other("task identity or credentials changed"));
            }
            recheck_namespaces(task)?;
            match &task.resources {
                Resources::Ordinary(references) => references.recheck(task, pid, candidates, runtime,
                    all_terminal, request, store_client, deadline)?,
                Resources::Unobserved => return Err(io::Error::other("unobserved task resources")),
            }
            if let Some(runtime) = runtime {
                // Includes every UID and every task, even native-view outsiders
                // in the same/descendant managed PID namespace.
                runtime.scoped_task(pid, tid, all_terminal, deadline)?;
            }
            if !client::process(tid)?.same_identity(&task.identity) || client::uids(tid)? != task.uids {
                return Err(io::Error::other("task changed during resource closure"));
            }
            recheck_namespaces(task)?;
        }
        if numbers(format!("{base}/task"), deadline)? != tids
            || !client::process(pid)?.same_identity(&self.identity)
        { return Err(io::Error::other("process changed during closure")); }
        Ok(())
    }
}

impl<'a> Census<'a> {
    pub fn collect(request: &'a protocol::Request, candidates: &CandidateSet,
        store_client: Option<&Client>, peer: &Peer, self_role: &'a SelfRole,
        deadline: Instant) -> io::Result<Self>
    {
        deadline_check(deadline)?;
        self_role.recheck(deadline)?;
        if !client::process(peer.process.pid)?.same_identity(&peer.process) {
            return Err(io::Error::other("authenticated peer changed"));
        }
        match (&request.store, store_client) {
            (Some(store), Some(client)) => client.recheck(store)?,
            (None, None) => (),
            _ => return Err(io::Error::other("store authentication mismatch")),
        }
        let mut roots = Vec::with_capacity(candidates.len());
        for index in 0..candidates.len() {
            let candidate = candidates.get(index);
            roots.push(RootEvidence { path: candidate.path.clone(), identity: Some(ObjectIdentity {
                dev: candidate.identity.dev, ino: candidate.identity.ino, mount_id: candidate.identity.mount_id }),
                complete: true, status: Status::NoCurrentReference, references_complete: true,
                references: Vec::new(), unknown_reasons: Vec::new() });
        }
        let mut census = Self { runtime: None, processes: Vec::new(), self_role, request,
            observation: protocol::Observation { complete: true, process_count: 0, task_count: 0,
                roots, receipt: Vec::new() } };
        let pids = numbers("/proc", deadline)?;
        let mut total_tasks = 0usize;
        let mut total_objects = 0usize;
        let mut reference_count = 0usize;
        for pid in &pids {
            // No unpinned process_gone shortcut: discovery churn is UNKNOWN.
            let mut process = ProcessScope::discover(*pid, deadline)?;
            let management = *pid == self_role.pid();
            if management && process.tasks.len() != 1 {
                return Err(io::Error::other("server management task set changed"));
            }
            total_tasks += process.tasks.len();
            if total_tasks > TASK_LIMIT { return Err(io::Error::other("task census capacity")); }
            let all_terminal = whole_group_terminal(&process.tasks);
            for task in &mut process.tasks {
                // Still inspect any root/cwd held by a proven no-mm task.
                let references = References::collect(task, &process.identity, request, candidates,
                    store_client, management, all_terminal, &mut census.runtime, &mut census.observation,
                    &mut reference_count, deadline)?;
                total_objects += 3 + references.descriptors.len() + references.mappings.len();
                if total_objects > OBJECT_LIMIT { return Err(io::Error::other("object census capacity")); }
                task.resources = Resources::Ordinary(references);
            }
            census.processes.push(process);
        }
        if numbers("/proc", deadline)? != pids {
            return Err(io::Error::other("full process membership changed"));
        }
        census.observation.process_count = u32::try_from(census.processes.len())
            .map_err(|_| io::Error::other("process count overflow"))?;
        census.observation.task_count = u32::try_from(total_tasks)
            .map_err(|_| io::Error::other("task count overflow"))?;
        census.recheck(candidates, store_client, deadline)?;
        for root in &mut census.observation.roots {
            if !root.complete || !root.references_complete { root.status = Status::Unknown; }
            else if root.references.iter().any(|reference| reference.effect == ReferenceEffect::InUse) {
                root.status = Status::InUse;
            }
        }
        census.observation.receipt = format!(
            "all-uid-all-task-root-scoped-census-v1 processes={} tasks={} objects={} self_role=immutable-server-bootstrap self_tgid={} self_start={} peer_tgid={} peer_start={}\n",
            census.observation.process_count, census.observation.task_count, total_objects,
            self_role.pid(), client::process(self_role.pid())?.start, peer.process.pid, peer.process.start).into_bytes();
        if let Some(runtime) = &census.runtime { census.observation.receipt.extend_from_slice(runtime.receipt()); }
        Ok(census)
    }

    fn recheck_selection(&self, deadline: Instant) -> io::Result<()> {
        let pids = numbers("/proc", deadline)?;
        if !pids.iter().copied().eq(self.processes.iter().map(|process| process.identity.pid)) {
            return Err(io::Error::other("full process membership did not close"));
        }
        for retained in &self.processes {
            let current = ProcessScope::discover(retained.identity.pid, deadline)?;
            if !retained.same_selection(&current)? {
                return Err(io::Error::other("all-task identity credentials or membership changed"));
            }
        }
        if numbers("/proc", deadline)? != pids {
            return Err(io::Error::other("full process membership changed during closure"));
        }
        Ok(())
    }

    pub fn recheck(&self, candidates: &CandidateSet, store_client: Option<&Client>, deadline: Instant) -> io::Result<()> {
        deadline_check(deadline)?;
        match (&self.request.store, store_client) {
            (Some(store), Some(client)) => client.recheck(store)?,
            (None, None) => (),
            _ => return Err(io::Error::other("store recheck authentication mismatch")),
        }
        self.self_role.recheck(deadline)?;
        candidates.recheck(deadline)?;
        self.recheck_selection(deadline)?;
        for process in &self.processes {
            process.recheck(candidates, self.runtime.as_ref(), self.request, store_client, deadline)?;
        }
        if let Some(runtime) = &self.runtime { runtime.recheck(deadline)?; }
        self.recheck_selection(deadline)?;
        candidates.recheck(deadline)?;
        self.self_role.recheck(deadline)?;
        if let (Some(store), Some(client)) = (&self.request.store, store_client) { client.recheck(store)?; }
        deadline_check(deadline)
    }

    pub fn into_observation(self) -> protocol::Observation { self.observation }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task() -> TaskScope {
        TaskScope { identity: Process { pid: 8, parent: 1, start: 101, state: b'S' },
            uids: [9, 10, 11, 12], scope: File::open("/proc/self").unwrap(),
            namespaces: Vec::new(), resources: Resources::Unobserved }
    }

    fn observation() -> protocol::Observation {
        protocol::Observation { complete: true, process_count: 1, task_count: 1, receipt: Vec::new(),
            roots: vec![RootEvidence { path: "/candidate".into(), identity: None, complete: true,
                status: Status::NoCurrentReference, references_complete: true,
                references: Vec::new(), unknown_reasons: Vec::new() }] }
    }

    fn matched() -> super::super::candidates::MatchedReference {
        super::super::candidates::MatchedReference { root_index: 0, relative_path: "member".into(),
            identity: ObjectIdentity { dev: 1, ino: 2, mount_id: 3 }, effect: ReferenceEffect::RetainedBytes }
    }

    #[test]
    fn records_actual_task_generation_and_all_credentials() {
        let task = task();
        let leader = Process { pid: 7, parent: 1, start: 100, state: b'Z' };
        let mut result = observation();
        append_matches(&mut result, &[matched()], &leader, &task, ReferenceKind::Map, None, &mut 0);
        let reference = &result.roots[0].references[0];
        assert_eq!((reference.tgid, reference.leader_start, reference.tid, reference.task_start), (7, 100, 8, 101));
        assert_eq!(reference.uid, [9, 10, 11, 12]);
        assert_eq!(reference.effect, ReferenceEffect::RetainedBytes);
        assert_eq!(reference.relative_path, "member");
        assert_eq!(reference.fd, None);
    }

    #[test]
    fn overflow_invalidates_negative_and_exclusivity() {
        let task = task();
        let mut result = observation();
        let mut count = 0;
        for _ in 0..=ROOT_REFERENCE_LIMIT {
            append_matches(&mut result, &[matched()], &task.identity, &task, ReferenceKind::Fd, Some(4), &mut count);
        }
        let root = &result.roots[0];
        assert_eq!(root.references.len(), ROOT_REFERENCE_LIMIT);
        assert!(!root.complete && !root.references_complete && !result.complete);
        assert_eq!(root.status, Status::Unknown);
        assert_eq!(root.unknown_reasons, vec![UnknownReason::ReferenceOverflow]);
    }

    #[test]
    fn renamed_member_or_changed_effect_never_closes() {
        let before = MatchOutcome::Native(vec![matched()]);
        let mut renamed = matched();
        renamed.relative_path = "renamed".into();
        assert!(!same_matches(&before, &MatchOutcome::Native(vec![renamed])));
        let mut active = matched();
        active.effect = ReferenceEffect::InUse;
        assert!(!same_matches(&before, &MatchOutcome::Native(vec![active])));
        assert!(!same_matches(&before, &MatchOutcome::NeedsProxy));
        assert!(!same_matches(&before, &MatchOutcome::Native(Vec::new())));
    }

    #[test]
    fn total_reference_overflow_marks_each_affected_root_unknown() {
        let task = task();
        let mut result = observation();
        let mut total = TOTAL_REFERENCE_LIMIT;
        append_matches(&mut result, &[matched()], &task.identity, &task, ReferenceKind::Fd, Some(5), &mut total);
        assert!(result.roots[0].references.is_empty());
        assert!(!result.complete && !result.roots[0].references_complete);
        assert_eq!(result.roots[0].status, Status::Unknown);
    }

    #[test]
    fn zombie_leader_does_not_qualify_live_sibling() {
        let mut leader = task();
        leader.identity.state = b'Z';
        let sibling = task();
        assert!(!whole_group_terminal(&[leader, sibling]));
        assert!(!whole_group_terminal(&[]));
        let mut terminal = task();
        terminal.identity.state = b'X';
        assert!(whole_group_terminal(&[terminal]));
    }

    #[test]
    fn ordinary_actual_task_never_gets_resource_empty_role() {
        let task = task();
        assert!(!no_mm_role(&task, false, Instant::now() + std::time::Duration::from_secs(2)).unwrap());
    }
}
