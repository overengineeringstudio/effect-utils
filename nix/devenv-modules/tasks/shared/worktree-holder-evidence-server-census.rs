//! Root membership and management policy over retained proc-library snapshots.
use std::cell::{Cell, RefCell};
use std::fs::File;
use std::io;
use std::os::fd::OwnedFd;
use std::time::Instant;
use super::candidates::{CandidateSet, MatchOutcome, MountCoverage};
use super::client::{self, Client, Peer, Process, SelfRole};
use super::objects;
use super::protocol::{self, ObjectIdentity, Reference, ReferenceEffect, ReferenceKind, RootEvidence, Status, UnknownReason};
use super::{linux, runtime::Runtime};
use worktree_holder_proc::scopes::{ProcessScope, TaskScope, Held, References as NativeReferences,
    ResourceKind, deadline_check, scope_path, numbers, mapping_names, qualify_object};
const ROOT_REFERENCE_LIMIT: usize = 4096;
const TOTAL_REFERENCE_LIMIT: usize = 65536;
const TASK_LIMIT: usize = 262144;
const OBJECT_LIMIT: usize = 1048576;
const FAILURE_LOG_LIMIT: usize = 64;

/// Private journal evidence, never deletion authority or a wire extension.
pub struct ProcessSurvey<'a> {
    nonce: &'a str,
    discovered: Option<usize>,
    visited: std::collections::BTreeSet<u32>,
    proven: std::collections::BTreeSet<u32>,
    failed: std::collections::BTreeSet<u32>,
    failures: Vec<ProcessFailure>,
    truncated: bool,
    global_failure: bool,
    pub phase: &'static str,
}
struct ProcessFailure {
    pid: u32, uid: Option<u32>, tasks: Option<usize>, phase: &'static str, reason: &'static str,
    cwd: NativeStatus, maps: NativeStatus,
}
struct DiagnosticCount(Option<usize>);
impl std::fmt::Display for DiagnosticCount {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.0 { Some(value) => std::fmt::Display::fmt(&value, out), None => out.write_str("unknown") }
    }
}
impl<'a> ProcessSurvey<'a> {
    pub fn new(nonce: &'a str) -> Self {
        Self { nonce, discovered: None, visited: Default::default(), proven: Default::default(),
            failed: Default::default(), failures: Vec::new(), truncated: false, global_failure: false, phase: "setup" }
    }
    pub fn restart(&mut self) {
        self.discovered = None;
        self.visited.clear(); self.proven.clear(); self.failed.clear();
        self.failures.clear(); self.truncated = false;
        self.global_failure = false; self.phase = "setup";
    }
    pub fn mark_global_failure(&mut self, phase: &'static str) {
        self.global_failure = true;
        self.phase = phase;
    }
    pub fn request_failed(&mut self) {
        if self.failed.is_empty() && !self.global_failure {
            self.mark_global_failure("request-closing");
        }
    }
    fn fail(&mut self, pid: u32, process: Option<&ProcessScope>, phase: &'static str,
        error: &io::Error, cwd: NativeStatus, maps: NativeStatus) {
        self.visited.insert(pid);
        self.proven.remove(&pid);
        self.failed.insert(pid);
        if let Some(previous) = self.failures.iter_mut().find(|failure| failure.pid == pid) {
            previous.cwd.merge(cwd); previous.maps.merge(maps);
            return;
        }
        if self.failures.len() == FAILURE_LOG_LIMIT { self.truncated = true; return; }
        let uid = process.and_then(|process| process.tasks.iter()
            .find(|task| task.identity.pid == pid)).map(|task| task.uids[0]);
        let tasks = process.map(|process| process.tasks.len());
        let reason = match worktree_holder_proc::scopes::descriptor_instability(error) {
            Some(worktree_holder_proc::scopes::DescriptorInstability::StablePair) => "descriptor-stable-pair",
            Some(worktree_holder_proc::scopes::DescriptorInstability::ProcessClosing) => "process-closing-budget",
            Some(worktree_holder_proc::scopes::DescriptorInstability::ClassMembership) => "descriptor-class-membership",
            None => match error.kind() {
                io::ErrorKind::PermissionDenied => "permission", io::ErrorKind::NotFound => "vanished",
                io::ErrorKind::Interrupted => "unstable", io::ErrorKind::TimedOut => "deadline",
                io::ErrorKind::Unsupported => "unsupported", _ => "unqualified",
            },
        };
        self.failures.push(ProcessFailure { pid, uid, tasks, phase, reason, cwd, maps });
    }
    fn prove(&mut self, pid: u32) {
        self.visited.insert(pid);
        if !self.failed.contains(&pid) { self.proven.insert(pid); }
    }
    fn incomplete(&self) -> bool {
        self.global_failure || !self.failed.is_empty() || self.discovered != Some(self.proven.len())
    }
}
impl Drop for ProcessSurvey<'_> {
    fn drop(&mut self) {
        for failure in &self.failures {
            eprintln!("worktree-holder-evidence: census-process nonce={} producer={} pid={} uid={} tasks={} phase={} reason={} native_cwd={} native_maps={}",
                self.nonce, super::PRODUCER, failure.pid, DiagnosticCount(failure.uid.map(|uid| uid as usize)),
                DiagnosticCount(failure.tasks), failure.phase, failure.reason, failure.cwd.text(), failure.maps.text());
        }
        let discovered = DiagnosticCount(self.discovered);
        let unvisited = DiagnosticCount(self.discovered.map(|count| count.saturating_sub(self.visited.len())));
        eprintln!("worktree-holder-evidence: census-summary nonce={} producer={} terminal=true discovered={} visited={} proven={} failed={} unvisited={} truncated={} phase={} global_failure={} outcome={}",
            self.nonce, super::PRODUCER, discovered, self.visited.len(), self.proven.len(), self.failed.len(),
            unvisited, self.truncated, self.phase, self.global_failure,
            if self.incomplete() { "unknown" } else { "proven" });
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum NativeStatus { Negative, Positive, Unknown }
impl NativeStatus {
    fn text(self) -> &'static str {
        match self { Self::Negative => "negative", Self::Positive => "positive", Self::Unknown => "unknown" }
    }
    fn merge(&mut self, other: Self) {
        *self = match (*self, other) {
            (Self::Positive, _) | (_, Self::Positive) => Self::Positive,
            (Self::Unknown, _) | (_, Self::Unknown) => Self::Unknown, _ => Self::Negative,
        };
    }
    fn from_match(outcome: MatchOutcome) -> Self {
        match outcome {
            MatchOutcome::Native(matches) if matches.is_empty() => Self::Negative,
            MatchOutcome::Native(_) => Self::Positive, MatchOutcome::NeedsProxy => Self::Unknown,
        }
    }
}

/// Negative requires every actual task context and its native closing seals.
fn diagnostic_cwd_maps(process: &ProcessScope, candidates: &CandidateSet,
    deadline: Instant, resources: Option<&[Option<References>]>) -> (NativeStatus, NativeStatus) {
    let mut cwd = NativeStatus::Negative;
    let mut maps = NativeStatus::Negative;
    if process.recheck(deadline).is_err() { return (NativeStatus::Unknown, NativeStatus::Unknown); }
    for (index, task) in process.tasks.iter().enumerate() {
        if Instant::now() >= deadline {
            cwd.merge(NativeStatus::Unknown); maps.merge(NativeStatus::Unknown); break;
        }
        let checked: io::Result<(NativeStatus, NativeStatus)> = (|| {
            if process.task_departed(index, deadline)? { return Ok((NativeStatus::Negative, NativeStatus::Negative)); }
            task.recheck(deadline)?;
            let owned;
            let coverage = match resources.and_then(|resources| resources.get(index))
                .and_then(Option::as_ref).and_then(|references| references.mounted.as_ref()) {
                Some(coverage) => coverage,
                None => { owned = candidates.capture_mounts(&task.scope, deadline)?; &owned }
            };
            let current_cwd = (|| {
                let held = Held::pin(format!("{}/cwd", scope_path(&task.scope)), deadline)?;
                qualify_object(&held)?;
                let status = NativeStatus::from_match(candidates.matches_with_coverage(&held.file,
                    &task.scope, ReferenceKind::Cwd, Some(coverage), deadline)?);
                held.recheck(format!("{}/cwd", scope_path(&task.scope)), deadline)?;
                Ok::<_, io::Error>(status)
            })().unwrap_or(NativeStatus::Unknown);
            let current_maps = (|| {
                let names = mapping_names(&task.mapping_scope, deadline)?;
                let mut status = NativeStatus::Negative;
                for name in &names {
                    let path = format!("{}/map_files/{name}", scope_path(&task.mapping_scope));
                    let held = Held::pin(&path, deadline)?;
                    qualify_object(&held)?;
                    status.merge(NativeStatus::from_match(candidates.matches_with_coverage(&held.file,
                        &task.scope, ReferenceKind::Map, Some(coverage), deadline)?));
                    held.recheck(&path, deadline)?;
                }
                if mapping_names(&task.mapping_scope, deadline)? != names {
                    return Err(io::Error::other("diagnostic mappings did not close"));
                }
                Ok::<_, io::Error>(status)
            })().unwrap_or(NativeStatus::Unknown);
            coverage.recheck(candidates, deadline)?;
            task.recheck(deadline)?;
            Ok((current_cwd, current_maps))
        })();
        match checked {
            Ok((actual_cwd, actual_maps)) => { cwd.merge(actual_cwd); maps.merge(actual_maps); }
            Err(_) => { cwd.merge(NativeStatus::Unknown); maps.merge(NativeStatus::Unknown); }
        }
    }
    if process.recheck(deadline).is_err() {
        cwd.merge(NativeStatus::Unknown); maps.merge(NativeStatus::Unknown);
    }
    (cwd, maps)
}
pub struct Census<'a, 'nonce> {
    runtime: Option<Runtime>,
    processes: Vec<ObservedProcess>,
    self_role: &'a SelfRole,
    request: &'a protocol::Request,
    observation: protocol::Observation,
    aliases: AliasSeal,
    object_count: Cell<usize>,
    survey: &'a RefCell<ProcessSurvey<'nonce>>,
}
struct ObservedProcess {
    scope: ProcessScope,
    references: Vec<Option<References>>,
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
    closing_mounts: Vec<MountCoverage>,
}

/// Retained until emission; task departure never waives positive alias proof.
#[derive(Default)]
pub struct AliasSeal {
    proofs: Vec<LeaderFdAlias>,
}
struct LeaderFdAlias {
    leader: Process,
    task: Process,
    leader_pin: OwnedFd,
    task_pin: OwnedFd,
    descriptor: File,
    number: u32,
}
fn live_generation(expected: &Process, current: &Process) -> bool {
    expected.same_identity(current) && !matches!(current.state, b'Z' | b'X')
}
fn actual_tgid(tid: u32) -> io::Result<u32> {
    let status = objects::bounded_text(format!("/proc/{tid}/status"), 64 * 1024)?;
    let mut values = status.lines().filter_map(|line| line.strip_prefix("Tgid:"));
    let value = values.next().ok_or_else(|| io::Error::other("missing task group"))?
        .trim().parse().map_err(|_| io::Error::other("invalid task group"))?;
    if values.next().is_some() { return Err(io::Error::other("duplicate task group")); }
    Ok(value)
}
impl LeaderFdAlias {
    fn capture(leader: &Process, task: &TaskScope, number: u32, held: &Held,
        deadline: Instant) -> io::Result<Self>
    {
        deadline_check(deadline)?;
        if task.tgid != leader.pid || task.identity.pid == leader.pid {
            return Err(io::Error::other("not a nonleader descriptor"));
        }
        let leader_pin = linux::pin_process(leader.pid)?;
        let task_pin = linux::pin_task(task.identity.pid)?;
        let current_leader = client::process(leader.pid)?;
        let current_task = client::process(task.identity.pid)?;
        if !live_generation(leader, &current_leader) || !live_generation(&task.identity, &current_task) {
            return Err(io::Error::other("alias generation changed during pin"));
        }
        let descriptor = objects::duplicate_client_fd(&task_pin, i32::try_from(number)
            .map_err(|_| io::Error::other("alias descriptor out of range"))?)?;
        if objects::identity(&descriptor)? != held.identity || objects::mount_id(&descriptor)? != held.mount {
            return Err(io::Error::other("alias descriptor differs from observed reference"));
        }
        let proof = Self { leader: current_leader, task: current_task, leader_pin,
            task_pin, descriptor, number };
        proof.recheck(deadline)?;
        Ok(proof)
    }

    fn recheck_identity(&self, deadline: Instant) -> io::Result<()> {
        deadline_check(deadline)?;
        if linux::pidfd_terminated(&self.leader_pin)? || linux::pidfd_terminated(&self.task_pin)?
            || !live_generation(&self.leader, &client::process(self.leader.pid)?)
            || !live_generation(&self.task, &client::process(self.task.pid)?)
            || actual_tgid(self.leader.pid)? != self.leader.pid
            || actual_tgid(self.task.pid)? != self.leader.pid
            || linux::pidfd_terminated(&self.leader_pin)? || linux::pidfd_terminated(&self.task_pin)?
        { return Err(io::Error::other("leader alias generation or liveness changed")); }
        Ok(())
    }

    fn recheck(&self, deadline: Instant) -> io::Result<()> {
        self.recheck_identity(deadline)?;
        // OFD equality alone cannot authorize an independently unshared table.
        if !linux::same_task_descriptor_table(self.leader.pid, self.task.pid)?
            || !linux::same_task_descriptor(self.leader.pid, self.task.pid, self.number)?
        { return Err(io::Error::other("leader alias table or OFD differs")); }
        let current = objects::duplicate_client_fd(&self.task_pin, i32::try_from(self.number)
            .map_err(|_| io::Error::other("alias descriptor out of range"))?)?;
        if !linux::same_open_file(&self.descriptor, &current)? {
            return Err(io::Error::other("retained leader alias OFD changed"));
        }
        // Bracket the retained-slot check with real table/slot comparisons.
        if !linux::same_task_descriptor_table(self.leader.pid, self.task.pid)?
            || !linux::same_task_descriptor(self.leader.pid, self.task.pid, self.number)?
        { return Err(io::Error::other("leader alias changed during closure")); }
        self.recheck_identity(deadline)
    }
}
impl AliasSeal {
    pub fn recheck(&self, deadline: Instant) -> io::Result<()> {
        for proof in &self.proofs { proof.recheck(deadline)?; }
        deadline_check(deadline)
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

fn charge_objects(count: &Cell<usize>, additional: usize) -> io::Result<()> {
    let next = count.get().checked_add(additional)
        .filter(|next| *next <= OBJECT_LIMIT)
        .ok_or_else(|| io::Error::other("object census capacity"))?;
    count.set(next);
    Ok(())
}

fn append_matches(observation: &mut protocol::Observation, matches: &[super::candidates::MatchedReference],
    pid: &Process, task: &TaskScope, kind: ReferenceKind, fd: Option<u32>,
    leader_fd_alias: bool, total: &mut usize)
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
            effect: matched.effect, fd, leader_fd_alias });
        *total += 1;
    }
}
fn reference_kind(kind: ResourceKind) -> ReferenceKind {
    match kind {
        ResourceKind::Root => ReferenceKind::Root, ResourceKind::Cwd => ReferenceKind::Cwd,
        ResourceKind::Exe => ReferenceKind::Exe, ResourceKind::Fd => ReferenceKind::Fd,
        ResourceKind::Map => ReferenceKind::Map,
    }
}
impl References {
    fn collect(process: &ProcessScope, index: usize, request: &protocol::Request,
        candidates: &CandidateSet, store_client: Option<&Client>, management: bool,
        runtime: &mut Option<Runtime>, observation: &mut protocol::Observation,
        reference_count: &mut usize, aliases: &mut AliasSeal, object_count: &Cell<usize>,
        deadline: Instant) -> io::Result<Option<Self>>
    {
        if process.task_departed(index, deadline)? { return Ok(None); }
        let task = &process.tasks[index];
        let pid = &process.identity;
        let mut closing_mounts = std::collections::BTreeMap::new();
        let pins = if management {
            let base = scope_path(&task.scope);
            let mapping_base = scope_path(&task.mapping_scope);
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
            for name in mapping_names(&task.mapping_scope, deadline)? {
                let held = Held::pin(format!("{mapping_base}/map_files/{name}"), deadline)?;
                if !held.file.metadata()?.is_file() || linux::filesystem_type(&held.file)? == 0x09041934 {
                    return Err(io::Error::other("unqualified mapped kernel object"));
                }
                mappings.push((name, held));
            }
            Pins::Management(ManagementReferences { root, cwd, exe, descriptors, mappings })
        } else {
            let mut prove_negative = |proof_task: &TaskScope, held: &Held, kind: ResourceKind, fresh: bool| {
                if fresh { charge_objects(object_count, 1)?; }
                let coverage = match closing_mounts.entry(proof_task.identity.pid) {
                    std::collections::btree_map::Entry::Occupied(entry) => entry.into_mut(),
                    std::collections::btree_map::Entry::Vacant(entry) =>
                        entry.insert(candidates.capture_mounts(&proof_task.scope, deadline)?),
                };
                candidates.matches_with_coverage(&held.file, &proof_task.scope, reference_kind(kind),
                    Some(coverage), deadline)?.require_native_negative()
            };
            let Some(pins) = process.collect_resources(index, deadline, Some(&mut prove_negative))?
                else { return Ok(None); };
            Pins::Ordinary(pins)
        };
        let (root, cwd, exe, descriptors, mappings) =
            (pins.root(), pins.cwd(), pins.exe(), pins.descriptors(), pins.mappings());
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
                    if !exempt {
                        // Unsupported, denied or churn: retain the ordinary ref.
                        let proof = if *reference_count < TOTAL_REFERENCE_LIMIT && matches.iter().any(|matched|
                            observation.roots[matched.root_index].references.len() < ROOT_REFERENCE_LIMIT) {
                            fd.and_then(|number| LeaderFdAlias::capture(pid, task, number, held, deadline).ok())
                        } else { None };
                        append_matches(observation, matches, pid, task, kind, fd, proof.is_some(), reference_count);
                        if let Some(proof) = proof { aliases.proofs.push(proof); }
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
            let coverage = candidates.capture_mounts(&task.scope, deadline)?;
            append_matches(observation, coverage.references(), pid, task, ReferenceKind::Mount,
                None, false, reference_count);
            Some(coverage)
        } else { None };
        for coverage in closing_mounts.values() { coverage.recheck(candidates, deadline)?; }
        Ok(Some(Self { pins, foreign, memberships, mounted,
            closing_mounts: closing_mounts.into_values().collect() }))
    }

    fn recheck(&self, process: &ProcessScope, index: usize, candidates: &CandidateSet,
        runtime: Option<&Runtime>, request: &protocol::Request,
        store_client: Option<&Client>, all_resources: &[Option<References>],
        object_count: &Cell<usize>, deadline: Instant) -> io::Result<()>
    {
        let task = &process.tasks[index];
        let pid = process.identity.pid;
        let base = scope_path(&task.scope);
        let mapping_base = scope_path(&task.mapping_scope);
        let mut prove_negative = |proof_task: &TaskScope, held: &Held, kind: ResourceKind, fresh: bool| {
            if fresh { charge_objects(object_count, 1)?; }
            let proof_index = process.tasks.binary_search_by_key(&proof_task.identity.pid, |task| task.identity.pid)
                .map_err(|_| io::Error::other("closing proof task not selected"))?;
            let coverage = all_resources.get(proof_index).and_then(Option::as_ref)
                .and_then(|resources| resources.mounted.as_ref());
            candidates.recheck_matches(&held.file, &proof_task.scope, reference_kind(kind),
                coverage, deadline)?.require_native_negative()
        };
        for coverage in &self.closing_mounts { coverage.recheck(candidates, deadline)?; }
        match &self.pins {
            Pins::Ordinary(pins) => process.recheck_resources(index, pins, deadline, Some(&mut prove_negative))?,
            Pins::Management(pins) => {
                for (name, held) in [("root", &pins.root), ("cwd", &pins.cwd), ("exe", &pins.exe)] {
                    held.as_ref().ok_or_else(|| io::Error::other("missing server bootstrap reference"))?
                        .recheck(format!("{base}/{name}"), deadline)?;
                }
                for (number, held) in &pins.descriptors {
                    held.recheck(format!("{base}/fd/{number}"), deadline)?;
                }
                let names = mapping_names(&task.mapping_scope, deadline)?;
                if !names.iter().eq(pins.mappings.iter().map(|(name, _)| name)) {
                    return Err(io::Error::other("server mapping membership changed"));
                }
                for (name, held) in &pins.mappings {
                    held.recheck(format!("{mapping_base}/map_files/{name}"), deadline)?;
                }
            }
        }
        for (number, held) in self.pins.descriptors() {
            exempt_descriptor(store_client, request, pid, task, *number, held)?;
        }
        for (index, (kind, held)) in self.pins.root().iter().map(|held| (ReferenceKind::Root, held))
            .chain(self.pins.cwd().iter().map(|held| (ReferenceKind::Cwd, held)))
            .chain(self.pins.exe().iter().map(|held| (ReferenceKind::Exe, held)))
            .chain(self.pins.descriptors().iter().map(|(_, held)| (ReferenceKind::Fd, held)))
            .chain(self.pins.mappings().iter().map(|(_, held)| (ReferenceKind::Map, held))).enumerate()
        {
            qualify_object(held)?;
            // Repeat native namespace/backing proofs, not only inode equality.
            let actual = candidates.recheck_matches(&held.file, &task.scope, kind, self.mounted.as_ref(), deadline)?;
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
            Pins::Ordinary(pins) => process.recheck_resources(index, pins, deadline, Some(&mut prove_negative))?,
            Pins::Management(pins) => {
                if !mapping_names(&task.mapping_scope, deadline)?.iter().eq(pins.mappings.iter().map(|(name, _)| name)) {
                    return Err(io::Error::other("server mappings changed during closure"));
                }
            }
        }
        for coverage in &self.closing_mounts { coverage.recheck(candidates, deadline)?; }
        Ok(())
    }
}

impl ObservedProcess {
    fn recheck(&self, candidates: &CandidateSet, runtime: Option<&Runtime>,
        request: &protocol::Request, store_client: Option<&Client>, object_count: &Cell<usize>,
        deadline: Instant) -> io::Result<()> {
        self.scope.recheck(deadline)?;
        let _phase = self.scope.resource_phase(deadline)?;
        let all_terminal = whole_group_terminal(&self.scope.tasks);
        if self.references.len() != self.scope.tasks.len() {
            return Err(io::Error::other("unobserved task resources"));
        }
        for (index, task) in self.scope.tasks.iter().enumerate() {
            if self.scope.task_departed(index, deadline)? { continue; }
            let references = self.references[index].as_ref()
                .ok_or_else(|| io::Error::other("live task lacks resources"))?;
            let checked: io::Result<()> = (|| {
                task.recheck(deadline)?;
                references.recheck(&self.scope, index, candidates, runtime, request, store_client,
                    &self.references, object_count, deadline)?;
                if let Some(runtime) = runtime {
                    runtime.scoped_task(self.scope.identity.pid, task.identity.pid, all_terminal, deadline)?;
                }
                task.recheck(deadline)
            })();
            match checked {
                Err(error) if error.kind() == io::ErrorKind::NotFound
                    && self.scope.task_departed(index, deadline)? => (),
                result => result?,
            }
        }
        self.close_descriptors(candidates, object_count, false, deadline)?;
        self.scope.recheck(deadline)
    }

    fn close_descriptors(&self, candidates: &CandidateSet, object_count: &Cell<usize>,
        collecting: bool, deadline: Instant) -> io::Result<()> {
        let ordinary = self.references.iter().enumerate().filter_map(|(index, references)|
            match references.as_ref().map(|references| &references.pins) {
                Some(Pins::Ordinary(pins)) => Some((index, pins)), _ => None,
            }).collect::<Vec<_>>();
        let mut prove = |task: &TaskScope, held: &Held, kind: ResourceKind, fresh: bool| {
            if fresh { charge_objects(object_count, 1)?; }
            let index = self.scope.tasks.binary_search_by_key(&task.identity.pid, |task| task.identity.pid)
                .map_err(|_| io::Error::other("unknown descriptor proof task"))?;
            let coverage = self.references[index].as_ref().and_then(|references| references.mounted.as_ref());
            let outcome = if collecting {
                candidates.matches_with_coverage(&held.file, &task.scope, reference_kind(kind), coverage, deadline)?
            } else {
                candidates.recheck_matches(&held.file, &task.scope, reference_kind(kind), coverage, deadline)?
            };
            outcome.require_native_negative()
        };
        self.scope.finish_resource_phase(&ordinary, deadline, Some(&mut prove))
    }

    fn recheck_mounts(&self, candidates: &CandidateSet, deadline: Instant) -> io::Result<()> {
        self.scope.recheck(deadline)?;
        for (index, references) in self.references.iter().enumerate() {
            let Some(mounted) = references.as_ref().and_then(|references| references.mounted.as_ref())
                else { continue; };
            if !self.scope.task_departed(index, deadline)? {
                match mounted.recheck(candidates, deadline) {
                    Ok(()) => continue,
                    Err(error) if error.kind() == io::ErrorKind::NotFound
                        && self.scope.task_departed(index, deadline)? => (),
                    Err(error) => return Err(error),
                }
            }
            mounted.recheck_retained(candidates, deadline)?;
            if !self.scope.task_departed(index, deadline)? {
                return Err(io::Error::other("departed task identity changed during mount closure"));
            }
        }
        self.scope.recheck(deadline)
    }
}
impl<'a, 'nonce> Census<'a, 'nonce> {
    pub fn collect(request: &'a protocol::Request, candidates: &CandidateSet,
        store_client: Option<&Client>, peer: &Peer, self_role: &'a SelfRole,
        survey: &'a RefCell<ProcessSurvey<'nonce>>, deadline: Instant) -> io::Result<Self>
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
            aliases: AliasSeal::default(), object_count: Cell::new(0), survey,
            observation: protocol::Observation { complete: true, process_count: 0, task_count: 0,
                roots, receipt: Vec::new() } };
        let pids = numbers("/proc", deadline)?;
        survey.borrow_mut().discovered = Some(pids.len());
        let mut total_tasks = 0usize;
        let mut reference_count = 0usize;
        for pid in &pids {
            if Instant::now() >= deadline { survey.borrow_mut().phase = "deadline"; break; }
            let process = match ProcessScope::discover(*pid, deadline) {
                Ok(process) => process,
                Err(error) => {
                    survey.borrow_mut().fail(*pid, None, "discover", &error, NativeStatus::Unknown, NativeStatus::Unknown);
                    continue;
                }
            };
            let management = *pid == self_role.pid();
            total_tasks += process.tasks.len();
            let captured: io::Result<Vec<Option<References>>> = (|| {
                if management && process.tasks.len() != 1 {
                    return Err(io::Error::other("server management task set changed"));
                }
                if total_tasks > TASK_LIMIT { return Err(io::Error::other("task census capacity")); }
                let _phase = process.resource_phase(deadline)?;
                let mut resources = Vec::with_capacity(process.tasks.len());
                for index in 0..process.tasks.len() {
                    let captured = References::collect(&process, index, request, candidates,
                        store_client, management, &mut census.runtime, &mut census.observation,
                        &mut reference_count, &mut census.aliases, &census.object_count, deadline);
                    let references = match captured {
                        Err(error) if error.kind() == io::ErrorKind::NotFound
                            && process.task_departed(index, deadline)? => None,
                        result => result?,
                    };
                    if let Some(references) = &references {
                        let descriptor_pins = match &references.pins {
                            Pins::Ordinary(pins) => pins.uncharged_descriptor_pin_count(),
                            Pins::Management(pins) => pins.descriptors.len(),
                        };
                        charge_objects(&census.object_count, references.pins.root().iter().count()
                            + references.pins.cwd().iter().count() + references.pins.exe().iter().count()
                            + descriptor_pins + references.pins.mappings().len())?;
                    }
                    resources.push(references);
                }
                process.recheck(deadline)?;
                Ok(resources)
            })();
            let process = match captured {
                Ok(references) => ObservedProcess { scope: process, references },
                Err(error) => {
                    if candidates.retain_failed_task_view().is_err() { survey.borrow_mut().global_failure = true; }
                    let (cwd, maps) = diagnostic_cwd_maps(&process, candidates, deadline, None);
                    survey.borrow_mut().fail(*pid, Some(&process), "resources", &error, cwd, maps);
                    continue;
                }
            };
            let closed = (|| {
                let _phase = process.scope.resource_phase(deadline)?;
                process.close_descriptors(candidates, &census.object_count, true, deadline)
            })();
            if let Err(error) = closed {
                let (cwd, maps) = diagnostic_cwd_maps(&process.scope, candidates, deadline, Some(&process.references));
                survey.borrow_mut().fail(*pid, Some(&process.scope), "descriptor-close", &error, cwd, maps);
            }
            census.processes.push(process);
        }
        match numbers("/proc", deadline) {
            Ok(current) if current == pids => (),
            _ => { survey.borrow_mut().global_failure = true; survey.borrow_mut().phase = "process-set"; }
        }
        census.observation.process_count = u32::try_from(census.processes.len())
            .map_err(|_| io::Error::other("process count overflow"))?;
        census.observation.task_count = u32::try_from(total_tasks)
            .map_err(|_| io::Error::other("task count overflow"))?;
        // Final reference closure may not grow this transaction's scope devices.
        if candidates.freeze_scope_devices(deadline).is_err() {
            survey.borrow_mut().global_failure = true;
            survey.borrow_mut().phase = "scope-freeze";
        }
        census.recheck(candidates, store_client, deadline)?;
        for root in &mut census.observation.roots {
            if !root.complete || !root.references_complete { root.status = Status::Unknown; }
            else if root.references.iter().any(|reference| reference.effect == ReferenceEffect::InUse) {
                root.status = Status::InUse;
            }
        }
        census.observation.receipt = format!(
            "all-uid-all-task-root-scoped-census-v1 processes={} tasks={} self_role=immutable-server-bootstrap self_tgid={} self_start={} peer_tgid={} peer_start={}\n",
            census.observation.process_count, census.observation.task_count,
            self_role.pid(), client::process(self_role.pid())?.start, peer.process.pid, peer.process.start).into_bytes();
        if let Some(runtime) = &census.runtime { census.observation.receipt.extend_from_slice(runtime.receipt()); }
        Ok(census)
    }

    fn recheck_selection(&self, deadline: Instant) -> io::Result<()> {
        let pids = numbers("/proc", deadline)?;
        if !pids.iter().copied().eq(self.processes.iter().map(|process| process.scope.identity.pid)) {
            return Err(io::Error::other("full process membership did not close"));
        }
        for retained in &self.processes {
            let current = ProcessScope::discover(retained.scope.identity.pid, deadline)?;
            if !retained.scope.same_selection(&current, deadline)? {
                return Err(io::Error::other("all-task identity credentials or membership changed"));
            }
        }
        if numbers("/proc", deadline)? != pids {
            return Err(io::Error::other("full process membership changed during closure"));
        }
        Ok(())
    }

    pub fn recheck(&self, candidates: &CandidateSet, store_client: Option<&Client>, deadline: Instant) -> io::Result<()> {
        let opening: io::Result<()> = (|| {
            deadline_check(deadline)?;
            match (&self.request.store, store_client) {
                (Some(store), Some(client)) => client.recheck(store)?,
                (None, None) => (),
                _ => return Err(io::Error::other("store recheck authentication mismatch")),
            }
            self.self_role.recheck(deadline)?;
            candidates.recheck(deadline)?;
            self.recheck_selection(deadline)
        })();
        if opening.is_err() {
            let mut survey = self.survey.borrow_mut();
            survey.global_failure = true; survey.phase = "global-opening";
        }
        for process in &self.processes {
            if Instant::now() >= deadline { self.survey.borrow_mut().phase = "deadline"; break; }
            let closed = process.recheck(candidates, self.runtime.as_ref(), self.request, store_client,
                &self.object_count, deadline).and_then(|()| process.recheck_mounts(candidates, deadline));
            match closed {
                Ok(()) => self.survey.borrow_mut().prove(process.scope.identity.pid),
                Err(error) => {
                    let (cwd, maps) = diagnostic_cwd_maps(&process.scope, candidates, deadline, Some(&process.references));
                    self.survey.borrow_mut().fail(process.scope.identity.pid, Some(&process.scope),
                        "closure", &error, cwd, maps);
                }
            }
        }
        let closing: io::Result<()> = (|| {
            if let Some(runtime) = &self.runtime { runtime.recheck(deadline)?; }
            self.recheck_selection(deadline)?;
            candidates.recheck(deadline)?;
            self.self_role.recheck(deadline)?;
            if let (Some(store), Some(client)) = (&self.request.store, store_client) { client.recheck(store)?; }
            self.aliases.recheck(deadline)?;
            deadline_check(deadline)
        })();
        if closing.is_err() {
            let mut survey = self.survey.borrow_mut();
            survey.global_failure = true; survey.phase = "global-closing";
        }
        if self.survey.borrow().incomplete() {
            return Err(io::Error::other("one or more processes or global seals remain unproven"));
        }
        self.survey.borrow_mut().phase = "complete";
        Ok(())
    }

    pub fn into_observation(mut self) -> (protocol::Observation, AliasSeal) {
        let mut slots = 0;
        let mut pins = 0;
        let mut objects = 0;
        let mut seen_snapshots = std::collections::BTreeSet::new();
        for process in &self.processes {
            for references in process.references.iter().flatten() {
                objects += references.pins.root().iter().count() + references.pins.cwd().iter().count()
                    + references.pins.exe().iter().count() + references.pins.mappings().len();
                if let Pins::Ordinary(resources) = &references.pins {
                    slots += resources.current_descriptor_count();
                    let descriptor_pins = resources.unique_descriptor_pin_count(&mut seen_snapshots);
                    pins += descriptor_pins;
                    objects += descriptor_pins + resources.closing_non_descriptor_pin_count();
                }
                else {
                    objects += references.pins.descriptors().len();
                }
            }
        }
        self.observation.receipt.extend_from_slice(format!(
            "retained_objects={} ordinary_sealed_descriptor_slots={} ordinary_retained_descriptor_pins={}\n",
            objects, slots, pins).as_bytes());
        (self.observation, self.aliases)
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repaired_descriptor_pins_share_the_existing_global_object_bound() {
        let count = Cell::new(OBJECT_LIMIT - 1);
        charge_objects(&count, 1).unwrap();
        assert_eq!(count.get(), OBJECT_LIMIT);
        assert!(charge_objects(&count, 1).is_err());
        assert_eq!(count.get(), OBJECT_LIMIT);
        assert!(charge_objects(&count, usize::MAX).is_err());
        assert_eq!(count.get(), OBJECT_LIMIT);
    }

    fn task() -> TaskScope {
        TaskScope { tgid: 7, identity: Process { pid: 8, parent: 1, start: 101, state: b'S' },
            uids: [9, 10, 11, 12], scope: File::open("/proc/self").unwrap(),
            mapping_scope: File::open("/proc/self").unwrap(),
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
        append_matches(&mut result, &[matched()], &leader, &task, ReferenceKind::Map, None, false, &mut 0);
        let reference = &result.roots[0].references[0];
        assert_eq!((reference.tgid, reference.leader_start, reference.tid, reference.task_start), (7, 100, 8, 101));
        assert_eq!(reference.uid, [9, 10, 11, 12]);
        assert_eq!(reference.effect, ReferenceEffect::RetainedBytes);
        assert_eq!(reference.relative_path, "member");
        assert_eq!(reference.fd, None);
        assert!(!reference.leader_fd_alias);
    }

    #[test]
    fn overflow_invalidates_negative_and_exclusivity() {
        let task = task();
        let mut result = observation();
        let mut count = 0;
        for _ in 0..=ROOT_REFERENCE_LIMIT {
            append_matches(&mut result, &[matched()], &task.identity, &task, ReferenceKind::Fd, Some(4), false, &mut count);
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
        append_matches(&mut result, &[matched()], &task.identity, &task, ReferenceKind::Fd, Some(5), false, &mut total);
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
    fn alias_generation_requires_exact_live_identity() {
        let expected = Process { pid: 7, parent: 1, start: 100, state: b'S' };
        for (pid, parent, start, state) in [
            (8, 1, 100, b'S'), (7, 2, 100, b'S'), (7, 1, 101, b'S'),
            (7, 1, 100, b'Z'), (7, 1, 100, b'X'),
        ] {
            assert!(!live_generation(&expected, &Process { pid, parent, start, state }));
        }
        assert!(live_generation(&expected, &Process { pid: 7, parent: 1, start: 100, state: b'R' }));
    }

    #[test]
    fn alias_metadata_never_deduplicates_task_references_or_changes_effects() {
        let task = task();
        let leader = Process { pid: task.tgid, parent: 1, start: 100, state: b'S' };
        let mut result = observation();
        let mut total = 0;
        for proved in [false, true] {
            append_matches(&mut result, &[matched()], &leader, &task, ReferenceKind::Fd,
                Some(4), proved, &mut total);
        }
        assert_eq!(total, 2);
        let references = &result.roots[0].references;
        assert_eq!(references.len(), 2);
        assert!(!references[0].leader_fd_alias);
        assert!(references[1].leader_fd_alias);
        for reference in references {
            assert_eq!(reference.effect, ReferenceEffect::RetainedBytes);
            assert_eq!((reference.tgid, reference.leader_start, reference.tid, reference.task_start),
                (7, 100, 8, 101));
            assert_eq!(reference.fd, Some(4));
        }
        assert!(result.complete && result.roots[0].references_complete);
    }

    #[test]
    #[ignore = "requires privileged Linux pidfd_getfd, PIDFD_THREAD and kcmp qualification lane"]
    fn real_shared_thread_alias_retains_ofd_and_rejects_stale_generation() {
        use std::os::fd::AsRawFd;
        use std::sync::mpsc;
        use std::time::Duration;
        let file = File::open("/dev/null").unwrap();
        let number = u32::try_from(file.as_raw_fd()).unwrap();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (stop_tx, stop_rx) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            let path = std::fs::read_link("/proc/thread-self").unwrap();
            let tid: u32 = path.file_name().unwrap().to_str().unwrap().parse().unwrap();
            ready_tx.send(tid).unwrap();
            stop_rx.recv().unwrap();
        });
        let tid = ready_rx.recv().unwrap();
        let pid = std::process::id();
        let scope = File::open(format!("/proc/{pid}/task/{tid}")).unwrap();
        let task = TaskScope { tgid: pid, identity: client::process(tid).unwrap(),
            uids: [0; 4], mapping_scope: scope.try_clone().unwrap(), scope, namespaces: Vec::new() };
        let leader = client::process(pid).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let held = Held::pin(format!("/proc/{tid}/fd/{number}"), deadline).unwrap();
        let proof = LeaderFdAlias::capture(&leader, &task, number, &held, deadline).unwrap();
        proof.recheck(deadline).unwrap();
        let stale = Process { pid: leader.pid, parent: leader.parent, start: leader.start + 1, state: leader.state };
        assert!(LeaderFdAlias::capture(&stale, &task, number, &held, deadline).is_err());
        stop_tx.send(()).unwrap();
        thread.join().unwrap();
        assert!(proof.recheck(deadline).is_err());
    }

    #[test]
    fn incomplete_native_diagnostics_never_become_negative_or_complete() {
        let mut status = NativeStatus::Negative;
        status.merge(NativeStatus::Unknown);
        status.merge(NativeStatus::Negative);
        assert!(status == NativeStatus::Unknown);
        status.merge(NativeStatus::Positive);
        assert!(status == NativeStatus::Positive);
        let survey = ProcessSurvey::new("00000000000000000000000000000000");
        assert!(survey.incomplete(), "setup failure is not an empty fully surveyed host");
        assert!(survey.discovered.is_none());
    }

    #[test]
    #[ignore = "requires isolated Linux root with native process scope visibility"]
    fn actual_independent_owned_process_failures_aggregate_without_hiding_unvisited() {
        use std::process::{Child, Command, Stdio};
        use std::time::Duration;
        struct Owned(Child);
        impl Drop for Owned {
            fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
        }
        let mut workers = (0..4).map(|_| Owned(Command::new("sleep").arg("60")
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap()))
            .collect::<Vec<_>>();
        let deadline = Instant::now() + Duration::from_secs(10);
        let scopes = workers.iter().map(|worker| ProcessScope::discover(worker.0.id(), deadline).unwrap())
            .collect::<Vec<_>>();
        let mut survey = ProcessSurvey::new("00000000000000000000000000000000");
        survey.discovered = Some(scopes.len()); // Fourth owned process intentionally unvisited.
        for index in 0..2 {
            workers[index].0.kill().unwrap();
            workers[index].0.wait().unwrap();
            let failure = scopes[index].recheck(deadline).unwrap_err();
            survey.fail(scopes[index].identity.pid, Some(&scopes[index]), "closure", &failure,
                NativeStatus::Unknown, NativeStatus::Unknown);
            // A second phase failing for the same TGID is not a second process.
            survey.fail(scopes[index].identity.pid, Some(&scopes[index]), "mounts", &failure,
                NativeStatus::Unknown, NativeStatus::Unknown);
        }
        scopes[2].recheck(deadline).unwrap();
        survey.prove(scopes[2].identity.pid);
        assert_eq!(survey.visited.len(), 3);
        assert_eq!(survey.proven.len(), 1);
        assert_eq!(survey.failed.len(), 2);
        assert_eq!(survey.discovered.unwrap() - survey.visited.len(), 1);
        assert!(survey.incomplete());
        assert!(!survey.truncated);
    }

}
