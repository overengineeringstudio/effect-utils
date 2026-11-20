//! Root membership and management policy over retained proc-library snapshots.
#[cfg(test)]
use std::fs::File;
use std::io;
use std::time::Instant;
use super::candidates::{CandidateSet, MatchOutcome, MountCoverage};
use super::client::{self, Client, Peer, Process, SelfRole};
use super::objects;
use super::protocol::{self, ObjectIdentity, Reference, ReferenceEffect, ReferenceKind, RootEvidence, Status, UnknownReason};
use super::{linux, runtime::Runtime};
use worktree_holder_proc::scopes::{ProcessScope, TaskScope, Held, References as NativeReferences,
    deadline_check, scope_path, numbers, mapping_names, qualify_object};
const ROOT_REFERENCE_LIMIT: usize = 4096;
const TOTAL_REFERENCE_LIMIT: usize = 65536;
const TASK_LIMIT: usize = 262144;
const OBJECT_LIMIT: usize = 1048576;
pub struct Census<'a> {
    runtime: Option<Runtime>,
    processes: Vec<ObservedProcess>,
    self_role: &'a SelfRole,
    request: &'a protocol::Request,
    observation: protocol::Observation,
}
struct ObservedProcess {
    scope: ProcessScope,
    references: Vec<References>,
}
// Only the source-authenticated bootstrap uses a local resource classification.
// Its metadata FDs are created by this server; its real root/cwd/exe/stdio and
// every vm_file mapping still undergo ordinary candidate and mount matching.
struct ManagementReferences {
    root: Option<Held>, cwd: Option<Held>, exe: Option<Held>,
    descriptors: Vec<(u32, Held)>, mappings: Vec<(String, Held)>,
}
enum Pins { Ordinary(NativeReferences), Management(ManagementReferences) }
impl Pins {
    fn root(&self) -> &Option<Held> { match self { Self::Ordinary(p) => &p.root, Self::Management(p) => &p.root } }
    fn cwd(&self) -> &Option<Held> { match self { Self::Ordinary(p) => &p.cwd, Self::Management(p) => &p.cwd } }
    fn exe(&self) -> &Option<Held> { match self { Self::Ordinary(p) => &p.exe, Self::Management(p) => &p.exe } }
    fn descriptors(&self) -> &Vec<(u32, Held)> { match self { Self::Ordinary(p) => &p.descriptors, Self::Management(p) => &p.descriptors } }
    fn mappings(&self) -> &Vec<(String, Held)> { match self { Self::Ordinary(p) => &p.mappings, Self::Management(p) => &p.mappings } }
}
struct References {
    pins: Pins,
    foreign: bool,
    memberships: Vec<MatchOutcome>,
    mounted: Option<MountCoverage>,
    aliases: Option<AliasPins>,
    alias_fds: Vec<u32>,
}
struct AliasPins {
    leader: std::os::fd::OwnedFd,
    task: std::os::fd::OwnedFd,
}
impl AliasPins {
    fn pin(process: &ProcessScope, task: &TaskScope) -> io::Result<Self> {
        let pins=Self {leader:linux::pin_process(process.identity.pid)?,
            task:linux::pin_task(task.identity.pid)?};
        pins.check_generation(process,task)?;
        Ok(pins)
    }
    fn check_generation(&self, process: &ProcessScope, task: &TaskScope) -> io::Result<()> {
        if !client::process(process.identity.pid)?.same_identity(&process.identity)
            || !client::process(task.identity.pid)?.same_identity(&task.identity)
            || linux::pidfd_terminated(&self.leader)? || linux::pidfd_terminated(&self.task)? {
            return Err(io::Error::other("thread alias generation changed"));
        }
        Ok(())
    }
    fn proves(&self, process: &ProcessScope, task: &TaskScope, fd: u32) -> io::Result<bool> {
        self.check_generation(process,task)?;
        let same=linux::shared_task_descriptor(process.identity.pid,task.identity.pid,fd,
            &self.leader,&self.task)?;
        self.check_generation(process,task)?;
        Ok(same)
    }
}
fn whole_group_terminal(tasks: &[TaskScope]) -> bool {
    !tasks.is_empty() && tasks.iter().all(|task| matches!(task.identity.state, b'Z' | b'X'))
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
    let thread = linux::pin_task(task.identity.pid)?;
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
    pid: &Process, task: &TaskScope, kind: ReferenceKind, fd: Option<u32>, total: &mut usize,
    leader_fd_alias: Option<&protocol::LeaderFdAlias>)
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
            effect: matched.effect, fd, leader_fd_alias:leader_fd_alias.cloned() });
        *total += 1;
    }
}
impl References {
    fn collect(process: &ProcessScope, index: usize, request: &protocol::Request,
        candidates: &CandidateSet, store_client: Option<&Client>, management: bool,
        runtime: &mut Option<Runtime>, observation: &mut protocol::Observation,
        reference_count: &mut usize, deadline: Instant) -> io::Result<Self>
    {
        let task = &process.tasks[index];
        let pid = &process.identity;
        let pins = if management {
            let base = scope_path(&task.scope);
            let root = Some(Held::pin(format!("{base}/root"), deadline)?);
            let cwd = Some(Held::pin(format!("{base}/cwd"), deadline)?);
            let exe = Some(Held::pin(format!("{base}/exe"), deadline)?);
            if !root.as_ref().is_some_and(|held| held.directory)
                || !cwd.as_ref().is_some_and(|held| held.directory)
            { return Err(io::Error::other("invalid server directory capability")); }
            let mut descriptors = Vec::new();
            for number in [0, 1, 2] {
                descriptors.push((number, Held::pin(format!("{base}/fd/{number}"), deadline)?));
            }
            let mut mappings = Vec::new();
            for name in mapping_names(&task.scope, deadline)? {
                let held = Held::pin(format!("{base}/map_files/{name}"), deadline)?;
                if !held.file.metadata()?.is_file() || linux::filesystem_type(&held.file)? == 0x09041934 {
                    return Err(io::Error::other("unqualified mapped kernel object"));
                }
                mappings.push((name, held));
            }
            Pins::Management(ManagementReferences { root, cwd, exe, descriptors, mappings })
        } else {
            Pins::Ordinary(super::collect_step("native-task-resources",process.collect_resources(index, deadline))?)
        };
        let (root, cwd, exe, descriptors, mappings) =
            (pins.root(), pins.cwd(), pins.exe(), pins.descriptors(), pins.mappings());
        let mut foreign = false;
        let mut memberships = Vec::new();
        let mut aliases=None;
        let mut alias_fds=Vec::new();
        for (kind, fd, held) in root.iter().map(|held| (ReferenceKind::Root, None, held))
            .chain(cwd.iter().map(|held| (ReferenceKind::Cwd, None, held)))
            .chain(exe.iter().map(|held| (ReferenceKind::Exe, None, held)))
            .chain(descriptors.iter().map(|(number, held)| (ReferenceKind::Fd, Some(*number), held)))
            .chain(mappings.iter().map(|(_, held)| (ReferenceKind::Map, None, held)))
        {
            deadline_check(deadline)?;
            super::collect_step("object-qualification",qualify_object(held))?;
            let exempt = match fd {
                Some(number) => exempt_descriptor(store_client, request, pid.pid, task, number, held)?,
                None => false,
            };
            // Canonical store positives are resolved by CandidateSet before
            // any proxy policy. Management slots alone may omit those matches.
            let outcome = super::collect_step("candidate-object-membership",candidates.matches(&held.file, &task.scope, kind, deadline))?;
            match &outcome {
                MatchOutcome::Native(matches) => {
                    if !exempt {
                        let alias=fd.filter(|_| kind==ReferenceKind::Fd && !matches.is_empty()
                            && pid.pid!=task.identity.pid).and_then(|number| {
                            if aliases.is_none() { aliases=AliasPins::pin(process,task).ok(); }
                            if !aliases.as_ref().is_some_and(|pins| pins.proves(process,task,number).unwrap_or(false)) {
                                return None;
                            }
                            alias_fds.push(number);
                            Some(protocol::LeaderFdAlias {tgid:pid.pid,leader_start:pid.start,
                                tid:task.identity.pid,task_start:task.identity.start,fd:number})
                        });
                        append_matches(observation,matches,pid,task,kind,fd,reference_count,alias.as_ref());
                    }
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
            let coverage = super::collect_step("mounted-root-capture",candidates.capture_mounts(&task.scope, deadline))?;
            append_matches(observation, coverage.references(), pid, task, ReferenceKind::Mount,
                None, reference_count, None);
            Some(coverage)
        } else { None };
        Ok(Self { pins, foreign, memberships, mounted, aliases, alias_fds })
    }

    fn recheck(&self, process: &ProcessScope, index: usize, candidates: &CandidateSet,
        runtime: Option<&Runtime>, request: &protocol::Request,
        store_client: Option<&Client>, deadline: Instant) -> io::Result<()>
    {
        let task = &process.tasks[index];
        let pid = process.identity.pid;
        let base = scope_path(&task.scope);
        match &self.pins {
            Pins::Ordinary(pins) => process.recheck_resources(index, pins, deadline)?,
            Pins::Management(pins) => {
                for (name, held) in [("root", &pins.root), ("cwd", &pins.cwd), ("exe", &pins.exe)] {
                    held.as_ref().ok_or_else(|| io::Error::other("missing server bootstrap reference"))?
                        .recheck(format!("{base}/{name}"), deadline)?;
                }
                for (number, held) in &pins.descriptors {
                    held.recheck(format!("{base}/fd/{number}"), deadline)?;
                }
                let names = mapping_names(&task.scope, deadline)?;
                if !names.iter().eq(pins.mappings.iter().map(|(name, _)| name)) {
                    return Err(io::Error::other("server mapping membership changed"));
                }
                for (name, held) in &pins.mappings {
                    held.recheck(format!("{base}/map_files/{name}"), deadline)?;
                }
            }
        }
        for (number, held) in self.pins.descriptors() {
            exempt_descriptor(store_client, request, pid, task, *number, held)?;
        }
        if let Some(aliases)=&self.aliases {
            for fd in &self.alias_fds {
                if !aliases.proves(process,task,*fd)? {
                    return Err(io::Error::other("thread descriptor alias did not close"));
                }
            }
        }
        if let Some(mounted) = &self.mounted { mounted.recheck(candidates, deadline)?; }
        for (index, (kind, held)) in self.pins.root().iter().map(|held| (ReferenceKind::Root, held))
            .chain(self.pins.cwd().iter().map(|held| (ReferenceKind::Cwd, held)))
            .chain(self.pins.exe().iter().map(|held| (ReferenceKind::Exe, held)))
            .chain(self.pins.descriptors().iter().map(|(_, held)| (ReferenceKind::Fd, held)))
            .chain(self.pins.mappings().iter().map(|(_, held)| (ReferenceKind::Map, held))).enumerate()
        {
            qualify_object(held)?;
            // Repeat native namespace/backing proofs, not only inode equality.
            let actual = candidates.matches(&held.file, &task.scope, kind, deadline)?;
            if !same_matches(&self.memberships[index], &actual) {
                return Err(io::Error::other("task root-relative membership or provenance changed"));
            }
            if self.foreign && held.directory {
                let root = self.pins.root().as_ref().ok_or_else(|| io::Error::other("proxy task lacks root"))?;
                if !objects::contained_directory(&held.file, &root.file, deadline)? {
                    return Err(io::Error::other("proxy directory containment changed"));
                }
            }
        }
        if self.foreign {
            let root = self.pins.root().as_ref().ok_or_else(|| io::Error::other("proxy task lacks root"))?;
            runtime.ok_or_else(|| io::Error::other("missing retained proxy proof"))?
                .admits(pid, task.identity.pid, &root.file, deadline)?;
        }
        match &self.pins {
            Pins::Ordinary(pins) => process.recheck_resources(index, pins, deadline)?,
            Pins::Management(pins) => {
                if !mapping_names(&task.scope, deadline)?.iter().eq(pins.mappings.iter().map(|(name, _)| name)) {
                    return Err(io::Error::other("server mappings changed during closure"));
                }
            }
        }
        Ok(())
    }
}

impl ObservedProcess {
    fn recheck(&self, candidates: &CandidateSet, runtime: Option<&Runtime>,
        request: &protocol::Request, store_client: Option<&Client>, deadline: Instant) -> io::Result<()> {
        self.scope.recheck(deadline)?;
        let all_terminal = whole_group_terminal(&self.scope.tasks);
        if self.references.len() != self.scope.tasks.len() {
            return Err(io::Error::other("unobserved task resources"));
        }
        for (index, task) in self.scope.tasks.iter().enumerate() {
            task.recheck(deadline)?;
            self.references[index].recheck(&self.scope, index, candidates, runtime, request, store_client, deadline)?;
            if let Some(runtime) = runtime {
                runtime.scoped_task(self.scope.identity.pid, task.identity.pid, all_terminal, deadline)?;
            }
            task.recheck(deadline)?;
        }
        self.scope.recheck(deadline)
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
        let pids = super::collect_step("process-enumeration",numbers("/proc", deadline))?;
        let mut total_tasks = 0usize;
        let mut total_objects = 0usize;
        let mut reference_count = 0usize;
        for pid in &pids {
            // No unpinned process_gone shortcut: discovery churn is UNKNOWN.
            let process = super::collect_step("process-scope-capture",ProcessScope::discover(*pid, deadline))?;
            let management = *pid == self_role.pid();
            if management && process.tasks.len() != 1 {
                return Err(io::Error::other("server management task set changed"));
            }
            total_tasks += process.tasks.len();
            if total_tasks > TASK_LIMIT { return Err(io::Error::other("task census capacity")); }
            let mut resources = Vec::with_capacity(process.tasks.len());
            for index in 0..process.tasks.len() {
                // Still inspect any root/cwd held by a proven no-mm task.
                let references = super::collect_step("task-reference-capture",References::collect(&process, index, request, candidates,
                    store_client, management, &mut census.runtime, &mut census.observation,
                    &mut reference_count, deadline))?;
                total_objects += 3 + references.pins.descriptors().len() + references.pins.mappings().len();
                if total_objects > OBJECT_LIMIT { return Err(io::Error::other("object census capacity")); }
                resources.push(references);
            }
            census.processes.push(ObservedProcess { scope: process, references: resources });
        }
        if numbers("/proc", deadline)? != pids {
            return super::collect_step("process-membership-capture-close",Err(io::Error::other("full process membership changed")));
        }
        census.observation.process_count = u32::try_from(census.processes.len())
            .map_err(|_| io::Error::other("process count overflow"))?;
        census.observation.task_count = u32::try_from(total_tasks)
            .map_err(|_| io::Error::other("task count overflow"))?;
        super::collect_step("captured-census-recheck",census.recheck(candidates, store_client, deadline))?;
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
        if !pids.iter().copied().eq(self.processes.iter().map(|process| process.scope.identity.pid)) {
            return super::collect_step("process-membership-recheck",Err(io::Error::other("full process membership did not close")));
        }
        for retained in &self.processes {
            let current = super::collect_step("process-scope-recapture",ProcessScope::discover(retained.scope.identity.pid, deadline))?;
            if !retained.scope.same_selection(&current)? {
                return super::collect_step("process-selection-recheck",Err(io::Error::other("all-task identity credentials or membership changed")));
            }
        }
        if numbers("/proc", deadline)? != pids {
            return super::collect_step("process-membership-recheck-close",Err(io::Error::other("full process membership changed during closure")));
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
        super::collect_step("selection-before-reference-recheck",self.recheck_selection(deadline))?;
        for process in &self.processes {
            super::collect_step("process-reference-recheck",process.recheck(candidates, self.runtime.as_ref(), self.request, store_client, deadline))?;
        }
        if let Some(runtime) = &self.runtime { runtime.recheck(deadline)?; }
        super::collect_step("selection-after-reference-recheck",self.recheck_selection(deadline))?;
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
            namespaces: Vec::new() }
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
        append_matches(&mut result, &[matched()], &leader, &task, ReferenceKind::Map, None, &mut 0, None);
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
            append_matches(&mut result, &[matched()], &task.identity, &task, ReferenceKind::Fd, Some(4), &mut count, None);
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
        append_matches(&mut result, &[matched()], &task.identity, &task, ReferenceKind::Fd, Some(5), &mut total, None);
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

}
