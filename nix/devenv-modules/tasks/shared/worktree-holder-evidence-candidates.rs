use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::{CString, OsStr};
use std::fs::File;
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::{Path, PathBuf};
use std::time::Instant;

use super::{linux, mounts, objects, protocol};
use protocol::{Kind, ObjectIdentity, ReferenceEffect, ReferenceKind};

include!("worktree-holder-evidence-roots.rs");

#[path = "worktree-holder-evidence-scope-devices.rs"]
mod scope_devices;
#[path = "worktree-holder-evidence-shmem.rs"]
mod shmem;
use scope_devices::{CandidateView, ScopeLedger};
use shmem::ShmemWitness;

#[cfg(test)]
#[path = "worktree-holder-evidence-namespace-fixture.rs"]
mod namespace_fixture;

pub struct Candidate {
    pub path: PathBuf,
    pub root: File,
    pub identity: ObjectIdentity,
}

#[derive(Debug, PartialEq, Eq)]
pub struct MatchedReference {
    pub root_index: usize,
    pub relative_path: String,
    pub identity: ObjectIdentity,
    pub effect: ReferenceEffect,
}

pub enum MatchOutcome {
    Native(Vec<MatchedReference>),
    NeedsProxy,
}

impl MatchOutcome {
    /// A changing descriptor may be retired only with actual native absence.
    /// Positive and proxy outcomes remain protective, even after its FD closes.
    pub fn require_native_negative(&self) -> io::Result<()> {
        match self {
            Self::Native(matches) if matches.is_empty() => Ok(()),
            _ => Err(io::Error::other("changing descriptor lacks native negative proof")),
        }
    }
}

pub struct MountCoverage {
    view: CandidateView,
    locations: Vec<mounts::NativeLocation>,
    references: Vec<MatchedReference>,
}

impl MountCoverage {
    pub fn references(&self) -> &[MatchedReference] { &self.references }

    pub fn recheck(&self, candidates: &CandidateSet, deadline: Instant) -> io::Result<()> {
        self.view.recheck(deadline)?;
        self.recheck_membership(candidates, deadline)?;
        self.view.recheck(deadline)
    }

    /// Requires the caller to prove task departure under its retained live leader.
    /// Mount/root objects and complete namespace coverage remain mandatory.
    pub fn recheck_retained(&self, candidates: &CandidateSet, deadline: Instant) -> io::Result<()> {
        self.view.recheck_retained(deadline)?;
        self.recheck_membership(candidates, deadline)?;
        self.view.recheck_retained(deadline)
    }

    fn recheck_membership(&self, candidates: &CandidateSet, deadline: Instant) -> io::Result<()> {
        let mut offset = 0;
        for location in &self.locations {
            let current = self.view.view.location(location.object(), deadline)?;
            if current.device != location.device || current.filesystem != location.filesystem
                || current.path != location.path
            { return Err(io::Error::other("mounted source mapping changed")); }
            let identity = object_identity(location.object())?;
            let actual = candidates.matches_native(&current, &identity, ReferenceEffect::InUse, deadline)?;
            let end = offset + actual.len();
            if self.references.get(offset..end) != Some(actual.as_slice()) {
                return Err(io::Error::other("mounted root membership changed"));
            }
            offset = end;
        }
        if offset != self.references.len() {
            return Err(io::Error::other("mounted root reference membership changed"));
        }
        Ok(())
    }
}

struct Scope {
    enrollment_path: PathBuf,
    enrollment: File,
    enrollment_identity: (objects::Identity, u64),
    location: mounts::NativeLocation,
}

struct NativeMatch {
    metadata: std::fs::Metadata,
    identity: ObjectIdentity,
    effect: ReferenceEffect,
    filesystem: u64,
}

enum PreparedMatch {
    Complete(MatchOutcome),
    Native(NativeMatch),
}

pub struct CandidateSet {
    kind: Kind,
    uid: u32,
    roots: Vec<Candidate>,
    scopes: Vec<Scope>,
    devices: BTreeSet<u64>,
    // Initial store inventory is deliberately deferred until after the caller
    // has authenticated the original exclusive lease OFD. No worktree walk.
    store_inventory: RefCell<Option<BTreeMap<objects::Identity, PathBuf>>>,
    enrolled_view: CandidateView,
    namespace_cache: super::namespace::NamespaceCache,
    scope_ledger: RefCell<ScopeLedger>,
    witness: RefCell<Option<ShmemWitness>>,
    // Captured once per task, then moved into its retained MountCoverage.
    native_view: RefCell<Option<CandidateView>>,
    failed_views: RefCell<Vec<CandidateView>>,
}

fn bound(deadline: Instant) -> io::Result<()> {
    if Instant::now() >= deadline { Err(io::Error::other("candidate deadline")) }
    else { Ok(()) }
}

fn object_identity(file: &File) -> io::Result<ObjectIdentity> {
    let (dev, ino) = objects::identity(file)?;
    Ok(ObjectIdentity { dev, ino, mount_id: objects::mount_id(file)? })
}

fn same_identity(a: &ObjectIdentity, b: &ObjectIdentity) -> bool {
    (a.dev, a.ino, a.mount_id) == (b.dev, b.ino, b.mount_id)
}

fn pin_absolute(path: &Path) -> io::Result<File> {
    if !mounts::canonical(path) { return Err(io::Error::other("noncanonical root")); }
    let host = File::open("/")?;
    let name = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::other("NUL in root"))?;
    linux::open_path(host.as_raw_fd(), &name, linux::O_DIRECTORY,
        linux::RESOLVE_IN_ROOT | linux::RESOLVE_NO_SYMLINKS | linux::RESOLVE_NO_MAGICLINKS)
        .map(File::from)
}

fn relative_name(path: &Path) -> &OsStr {
    if path.as_os_str().is_empty() { OsStr::new(".") } else { path.as_os_str() }
}

fn relative_text(path: &Path) -> io::Result<String> {
    let path = if path.as_os_str().is_empty() { Path::new(".") } else { path };
    let value = path.to_str().ok_or_else(|| io::Error::other("non-UTF-8 member path"))?;
    if value.len() > 4096 || value.bytes().any(|b| matches!(b, 0 | b'\r' | b'\n')) {
        return Err(io::Error::other("member path bound"));
    }
    Ok(value.to_owned())
}

fn membership_step<T>(_stage: &'static str, result: io::Result<T>) -> io::Result<T> {
    #[cfg(holder_owned_vm_class_diagnostics)]
    if let Err(error) = &result {
        eprintln!("worktree-holder-membership-owned-vm stage={_stage} kind={:?} errno={:?}",
            error.kind(), error.raw_os_error());
    }
    result
}

impl CandidateSet {
    pub fn pin(request: &protocol::Request, uid: u32, deadline: Instant) -> io::Result<Self> {
        Self::pin_enrolled(request, uid, ALLOWED_ROOTS, deadline)
    }

    fn pin_enrolled(request: &protocol::Request, uid: u32, allowed_roots: &[&str],
        deadline: Instant) -> io::Result<Self>
    {
        bound(deadline)?;
        if uid == 0 || request.paths.is_empty() || request.paths.len() > 4096 {
            return Err(io::Error::other("candidate count or owner"));
        }
        match request.kind {
            Kind::Store => {
                let store = request.store.as_ref().ok_or_else(|| io::Error::other("missing store lease request"))?;
                if request.paths.len() != 1 || request.paths[0] != store.candidate
                    || !store.candidate.ends_with(".devenv/pnpm-store-pure-v1")
                { return Err(io::Error::other("invalid historical store scope")); }
            }
            Kind::Worktree if request.store.is_some() => {
                return Err(io::Error::other("worktree request carries store authority"));
            }
            Kind::Worktree => {}
        }
        let self_task = objects::pin_magic("/proc/self")?;
        let mut roots = Vec::with_capacity(request.paths.len());
        let mut scopes = Vec::with_capacity(request.paths.len());
        let mut devices = BTreeSet::new();
        let mut unique = BTreeSet::new();
        for path in &request.paths {
            bound(deadline)?;
            if !mounts::canonical(path) || !unique.insert(path.clone()) {
                return Err(io::Error::other("noncanonical or duplicate requested root"));
            }
            let enrollment_path = allowed_roots.iter().map(Path::new)
                .filter(|allowed| mounts::canonical(allowed) && path.starts_with(allowed))
                .max_by_key(|allowed| allowed.as_os_str().len())
                .ok_or_else(|| io::Error::other("root outside compiled enrollment"))?.to_path_buf();
            let enrollment = pin_absolute(&enrollment_path)?;
            let enrollment_metadata = enrollment.metadata()?;
            if enrollment_metadata.uid() != uid || !objects::native_filesystem(&enrollment)? {
                return Err(io::Error::other("enrollment owner or filesystem"));
            }
            let enrollment_identity = (objects::identity(&enrollment)?, objects::mount_id(&enrollment)?);
            let relative = path.strip_prefix(&enrollment_path).map_err(io::Error::other)?;
            let root = objects::pin_beneath(&enrollment, relative_name(relative))?;
            let metadata = root.metadata()?;
            let identity = object_identity(&root)?;
            if !metadata.is_dir() || metadata.uid() != uid || !objects::native_filesystem(&root)?
                || identity.dev != enrollment_identity.0.0 || identity.mount_id != enrollment_identity.1
            { return Err(io::Error::other("root owner, type, or enrollment mount bridge")); }
            if let Some(store) = &request.store {
                if identity.dev != store.device || identity.ino != store.inode {
                    return Err(io::Error::other("store root identity changed"));
                }
            }
            let location = mounts::native_location(&root, &self_task, deadline)?;
            devices.insert(identity.dev);
            roots.push(Candidate { path: path.clone(), root, identity });
            scopes.push(Scope { enrollment_path, enrollment, enrollment_identity, location });
        }
        let namespace_cache = super::namespace::NamespaceCache::new();
        let enrolled_view = CandidateView::capture(&self_task, &scopes, &namespace_cache, deadline)?;
        let scope_ledger = RefCell::new(ScopeLedger::new(devices.clone(), &enrolled_view));
        Ok(Self { kind: request.kind, uid, roots, scopes, devices, enrolled_view, namespace_cache, scope_ledger,
            witness: RefCell::new(None), store_inventory: RefCell::new(None), native_view: RefCell::new(None),
            failed_views: RefCell::new(Vec::new()) })
    }

    /// Preserve, rather than silently discard, an interrupted task's registered
    /// view while the fail-closed census surveys the remaining processes.
    pub fn retain_failed_task_view(&self) -> io::Result<()> {
        if let Some(view) = self.native_view.borrow_mut().take() {
            self.failed_views.borrow_mut().push(view);
            self.scope_ledger.borrow_mut().retain()?;
        }
        Ok(())
    }

    pub fn len(&self) -> usize { self.roots.len() }
    pub fn get(&self, index: usize) -> &Candidate { &self.roots[index] }
    pub fn devices(&self) -> &BTreeSet<u64> { &self.devices }

    fn ensure_store_inventory(&self, deadline: Instant) -> io::Result<()> {
        if self.kind == Kind::Store && self.store_inventory.borrow().is_none() {
            let inventory = super::inventory::inventory_paths(&self.roots[0].root, deadline)?;
            *self.store_inventory.borrow_mut() = Some(inventory);
        }
        Ok(())
    }

    pub fn recheck(&self, deadline: Instant) -> io::Result<()> {
        self.namespace_cache.recheck_all(deadline)?;
        self.enrolled_view.recheck(deadline)?;
        if let Some(witness) = self.witness.borrow().as_ref() { witness.recheck()?; }
        if let Some(view) = self.native_view.borrow().as_ref() { view.recheck(deadline)?; }
        for view in self.failed_views.borrow().iter() { view.recheck(deadline)?; }
        let self_task = objects::pin_magic("/proc/self")?;
        for (root, scope) in self.roots.iter().zip(&self.scopes) {
            bound(deadline)?;
            let enrollment = pin_absolute(&scope.enrollment_path)?;
            if (objects::identity(&enrollment)?, objects::mount_id(&enrollment)?) != scope.enrollment_identity
                || (objects::identity(&scope.enrollment)?, objects::mount_id(&scope.enrollment)?) != scope.enrollment_identity
                || enrollment.metadata()?.uid() != self.uid
            { return Err(io::Error::other("enrollment changed")); }
            let relative = root.path.strip_prefix(&scope.enrollment_path).map_err(io::Error::other)?;
            let current = objects::pin_beneath(&enrollment, relative_name(relative))?;
            if !same_identity(&object_identity(&current)?, &root.identity)
                || !same_identity(&object_identity(&root.root)?, &root.identity)
                || current.metadata()?.uid() != self.uid
            { return Err(io::Error::other("canonical root changed")); }
            let location = mounts::native_location(&current, &self_task, deadline)?;
            if location.device != scope.location.device || location.filesystem != scope.location.filesystem
                || location.path != scope.location.path
            { return Err(io::Error::other("native root mapping changed")); }
        }
        if self.kind == Kind::Store {
            let current = super::inventory::inventory_paths(&self.roots[0].root, deadline)?;
            let mut inventory = self.store_inventory.borrow_mut();
            if inventory.as_ref().is_some_and(|previous| previous != &current) {
                return Err(io::Error::other("store inventory changed under original lease"));
            }
            *inventory = Some(current);
        }
        bound(deadline)
    }

    pub fn capture_mounts(&self, task_scope: &File, deadline: Instant) -> io::Result<MountCoverage> {
        bound(deadline)?;
        let cached = self.native_view.borrow_mut().take();
        let view = match cached {
            Some(view) if view.view.is_task(task_scope)? => { view.recheck(deadline)?; view }
            Some(_) => return Err(io::Error::other("candidate scope cache task changed")),
            None => self.pin_task_view(task_scope, deadline)?,
        };
        let mut coverage = MountCoverage { view, locations: Vec::new(), references: Vec::new() };
        for mount in coverage.view.view.mounts() {
            bound(deadline)?;
            if !self.scopes.iter().any(|scope|
                mounts::device_pair(scope.location.device) == (mount.device_major, mount.device_minor)
                    && mount.root.path().is_ok_and(|root| root.starts_with(&scope.location.path)))
            { continue; }
            let location = coverage.view.view.pin_mount_root(mount, deadline)?;
            let identity = object_identity(location.object())?;
            let matched = self.matches_native(&location, &identity, ReferenceEffect::InUse, deadline)?;
            if matched.is_empty() { return Err(io::Error::other("mounted source lost candidate bridge")); }
            if coverage.references.len() + matched.len() > protocol::MAX_REFERENCES {
                return Err(io::Error::other("mounted reference capacity"));
            }
            coverage.references.extend(matched);
            coverage.locations.push(location);
        }
        coverage.recheck(self, deadline)?;
        self.scope_ledger.borrow_mut().retain()?;
        Ok(coverage)
    }

    fn pin_task_view(&self, task_scope: &File, deadline: Instant) -> io::Result<CandidateView> {
        let view = CandidateView::capture(task_scope, &self.scopes, &self.namespace_cache, deadline)?;
        self.scope_ledger.borrow_mut().register(&view)?;
        Ok(view)
    }

    pub fn freeze_scope_devices(&self, deadline: Instant) -> io::Result<()> {
        bound(deadline)?;
        self.scope_ledger.borrow_mut().freeze(self.native_view.borrow().is_none())
    }

    pub fn matches(&self, file: &File, task_scope: &File, kind: ReferenceKind,
        deadline: Instant) -> io::Result<MatchOutcome>
    {
        let native = match self.prepare_match(file, kind, deadline)? {
            PreparedMatch::Complete(outcome) => return Ok(outcome),
            PreparedMatch::Native(native) => native,
        };
        let mut cached = self.native_view.borrow_mut();
        if let Some(view) = cached.as_ref() {
            if !view.view.is_task(task_scope)? {
                return Err(io::Error::other("candidate scope cache task changed"));
            }
        } else {
            *cached = Some(self.pin_task_view(task_scope, deadline)?);
        }
        let view = cached.as_ref().ok_or_else(|| io::Error::other("missing native view"))?;
        self.match_in_view(file, kind, native, view, deadline)
    }

    pub fn recheck_matches(&self, file: &File, task_scope: &File, kind: ReferenceKind,
        coverage: Option<&MountCoverage>, deadline: Instant) -> io::Result<MatchOutcome>
    {
        self.scope_ledger.borrow().require_frozen()?;
        self.matches_with_coverage(file, task_scope, kind, coverage, deadline)
    }

    /// Match in an explicitly retained task view during collection or closure.
    /// Unlike the single-task collection cache, this supports process-wide
    /// closing proof without assuming sibling resource contexts are shared.
    pub fn matches_with_coverage(&self, file: &File, task_scope: &File, kind: ReferenceKind,
        coverage: Option<&MountCoverage>, deadline: Instant) -> io::Result<MatchOutcome> {
        let native = match self.prepare_match(file, kind, deadline)? {
            PreparedMatch::Complete(outcome) => return Ok(outcome),
            PreparedMatch::Native(native) => native,
        };
        let view = &coverage.ok_or_else(|| io::Error::other("missing retained candidate scope"))?.view;
        if !view.view.is_task(task_scope)? {
            return Err(io::Error::other("retained candidate scope task changed"));
        }
        self.match_in_view(file, kind, native, view, deadline)
    }

    fn prepare_match(&self, file: &File, kind: ReferenceKind,
        deadline: Instant) -> io::Result<PreparedMatch>
    {
        bound(deadline)?;
        let metadata = membership_step("held-metadata", file.metadata())?;
        if metadata.file_type().is_char_device() {
            return Ok(PreparedMatch::Complete(MatchOutcome::Native(Vec::new())));
        }
        let identity = membership_step("held-identity", object_identity(file))?;
        let effect = if metadata.is_file() && matches!(kind, ReferenceKind::Fd | ReferenceKind::Map | ReferenceKind::Exe) {
            ReferenceEffect::RetainedBytes
        } else { ReferenceEffect::InUse };
        membership_step("store-inventory", self.ensure_store_inventory(deadline))?;
        // Exact store positives precede every internal-shmem/namespace proof.
        if let Some(path) = self.store_inventory.borrow().as_ref()
            .and_then(|inventory| inventory.get(&(identity.dev, identity.ino)))
        {
            return Ok(PreparedMatch::Complete(MatchOutcome::Native(vec![MatchedReference { root_index: 0,
                relative_path: relative_text(path)?, identity, effect }])));
        }
        let filesystem = membership_step("held-filesystem", linux::filesystem_type(file))?;
        if matches!(filesystem, 0x794c7630 | 0x65735546) {
            #[cfg(holder_owned_vm_class_diagnostics)]
            {
                let filesystem_class = if filesystem == 0x794c7630 { "overlay" } else { "fuse" };
                let object = if metadata.is_file() { "file" }
                    else if metadata.is_dir() { "directory" } else { "other" };
                eprintln!("worktree-holder-membership-owned-vm needs-proxy reference={kind:?} object={object} filesystem={filesystem_class}");
            }
            return Ok(PreparedMatch::Complete(MatchOutcome::NeedsProxy));
        }
        if !membership_step("native-filesystem-class", objects::native_filesystem(file))? {
            // Independent dircap/kernel/IPC qualification is never waived.
            if matches!(filesystem, 0x9fa0 | 0x62656572 | 0x63677270 | 0x27e0eb
                | 0x6e736673 | 0x1cd1 | 0x19800202 | 0x50495045 | 0x534f434b
                | 0x09041934 | 0x50494446 | 0x74726163 | 0xcafe4a11 | 0x64626720 | 0x73636673)
            { return Ok(PreparedMatch::Complete(MatchOutcome::Native(Vec::new()))); }
            #[cfg(holder_owned_vm_class_diagnostics)]
            {
                let class = if filesystem == 0x01021997 { "9p" } else { "other" };
                eprintln!("worktree-holder-membership-owned-vm unsupported-filesystem={class}");
            }
            return Err(io::Error::other("unsupported held filesystem"));
        }
        Ok(PreparedMatch::Native(NativeMatch { metadata, identity, effect, filesystem }))
    }

    fn match_in_view(&self, file: &File, kind: ReferenceKind, native: NativeMatch,
        view: &CandidateView, deadline: Instant) -> io::Result<MatchOutcome>
    {
        bound(deadline)?;
        let NativeMatch { metadata, identity, effect, filesystem } = native;
        if matches!(kind, ReferenceKind::Fd | ReferenceKind::Map)
            && metadata.is_file() && metadata.nlink() == 0 && filesystem == shmem::TMPFS
            && !self.scope_ledger.borrow().contains(identity.dev)
        {
            let mut witness = self.witness.borrow_mut();
            if witness.is_none() { *witness = Some(ShmemWitness::new()?); }
            if witness.as_ref().ok_or_else(|| io::Error::other("missing internal shmem witness"))?
                .same_mount(&identity)?
            {
                bound(deadline)?;
                return Ok(MatchOutcome::Native(Vec::new()));
            }
        }
        // Missing task mounts may still be pinned in the enrolled namespace;
        // both paths require exact native reopen proofs, never a provider waiver.
        let result = view.view.location_with_enrolled(file, &self.enrolled_view.view, deadline);
        #[cfg(holder_owned_vm_class_diagnostics)]
        if result.is_err() {
            let object = if metadata.is_file() { "file" }
                else if metadata.is_dir() { "directory" } else { "other" };
            let links = if metadata.nlink() == 0 { "unlinked" } else { "linked" };
            let filesystem_class = match filesystem {
                0xef53 => "ext4",
                0x2fc12fc1 => "zfs",
                0x9123683e => "btrfs",
                0x58465342 => "xfs",
                0x01021994 => "tmpfs",
                0x858458f6 => "ramfs",
                _ => "other",
            };
            eprintln!("worktree-holder-membership-owned-vm rejected-native-object reference={kind:?} object={object} links={links} filesystem={filesystem_class}");
        }
        let location = membership_step("native-location", result)?;
        membership_step("native-candidate-match", self.matches_native(&location, &identity, effect, deadline))
            .map(MatchOutcome::Native)
    }

    fn matches_native(&self, location: &mounts::NativeLocation, identity: &ObjectIdentity,
        effect: ReferenceEffect, deadline: Instant) -> io::Result<Vec<MatchedReference>>
    {
        let mut matched = Vec::new();
        for (index, (root, scope)) in self.roots.iter().zip(&self.scopes).enumerate() {
            bound(deadline)?;
            if location.device != scope.location.device
                || location.filesystem != scope.location.filesystem { continue; }
            let Ok(relative) = location.path.strip_prefix(&scope.location.path) else { continue };
            let member = objects::pin_beneath(&root.root, relative_name(relative))?;
            if objects::identity(&member)? != (identity.dev, identity.ino)
                || objects::mount_id(&member)? != root.identity.mount_id
            { return Err(io::Error::other("native member raced or crossed root mount")); }
            matched.push(MatchedReference { root_index: index,
                relative_path: relative_text(relative)?, identity: identity.clone(), effect });
        }
        bound(deadline)?;
        Ok(matched)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn membership_is_component_scoped_not_a_string_prefix() {
        let root = Path::new("/pool/worktree");
        assert!(Path::new("/pool/worktree/src/a").strip_prefix(root).is_ok());
        assert!(Path::new("/pool/worktree-other/src/a").strip_prefix(root).is_err());
    }

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            use std::sync::atomic::{AtomicU64, Ordering};
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!("holder-path-fixture-{}-{}",
                std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            std::fs::create_dir(&path).unwrap();
            Self(std::fs::canonicalize(path).unwrap())
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
    }

    fn deadline() -> Instant { Instant::now() + std::time::Duration::from_secs(5) }

    // Native fixture boundary: the test runner must provide a native temporary
    // filesystem, not overlay/FUSE. No production enrollment/proc override.
    pub(super) fn fixture_set(paths: &[PathBuf]) -> CandidateSet {
        let task = objects::pin_magic("/proc/self").unwrap();
        let mut roots = Vec::new();
        let mut scopes = Vec::new();
        let mut devices = BTreeSet::new();
        for path in paths {
            let root = pin_absolute(path).unwrap();
            let identity = object_identity(&root).unwrap();
            devices.insert(identity.dev);
            scopes.push(Scope { enrollment_path: path.clone(),
                enrollment: root.try_clone().unwrap(),
                enrollment_identity: (objects::identity(&root).unwrap(), identity.mount_id),
                location: mounts::native_location(&root, &task, deadline()).unwrap() });
            roots.push(Candidate { path: path.clone(), root, identity });
        }
        let namespace_cache = super::super::namespace::NamespaceCache::new();
        let enrolled_view = CandidateView::capture(&task, &scopes, &namespace_cache, deadline()).unwrap();
        let scope_ledger = RefCell::new(ScopeLedger::new(devices.clone(), &enrolled_view));
        CandidateSet { kind: Kind::Worktree, uid: roots[0].root.metadata().unwrap().uid(),
            roots, scopes, devices, enrolled_view, namespace_cache, scope_ledger, witness: RefCell::new(None),
            store_inventory: RefCell::new(None), native_view: RefCell::new(None),
            failed_views: RefCell::new(Vec::new()) }
    }

    #[test]
    fn descriptor_repair_requires_native_empty_membership() {
        assert!(MatchOutcome::Native(Vec::new()).require_native_negative().is_ok());
        assert!(MatchOutcome::NeedsProxy.require_native_negative().is_err());
        let positive = MatchOutcome::Native(vec![MatchedReference {
            root_index: 0, relative_path: "payload".into(),
            identity: ObjectIdentity { dev: 1, ino: 2, mount_id: 3 },
            effect: ReferenceEffect::RetainedBytes,
        }]);
        assert!(positive.require_native_negative().is_err());
    }

    #[test]
    #[ignore = "requires isolated root Linux, native temp filesystem and io_uring"]
    #[allow(unsafe_code)]
    fn actual_fd_snapshot_repair_preserves_positive_unknown_and_final_seals() {
        use std::io::{BufRead, Write};
        use std::os::fd::{FromRawFd, OwnedFd};
        use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
        use worktree_holder_proc::scopes::{Held, ProcessScope};
        const CHILD: &str = "HOLDER_FD_SNAPSHOT_MUTATOR_ROOT";
        const TEST: &str = "candidates::tests::actual_fd_snapshot_repair_preserves_positive_unknown_and_final_seals";
        const ACK: &str = "HOLDER_FD_ACK ";
        if let Some(root) = std::env::var_os(CHILD) {
            let root = PathBuf::from(root);
            let trigger = File::open(root.join("outside")).unwrap();
            let mut extra = None;
            let mut candidate: Option<File> = None;
            let mut opaque: Option<OwnedFd> = None;
            println!("{ACK}{}", trigger.as_raw_fd());
            std::io::stdout().flush().unwrap();
            for command in std::io::stdin().lock().lines() {
                let number = match command.unwrap().as_str() {
                    "toggle" => {
                        extra = if extra.is_some() { None } else {
                            Some(File::open(root.join("outside-extra")).unwrap())
                        };
                        extra.as_ref().map_or(0, AsRawFd::as_raw_fd)
                    }
                    "candidate" => {
                        candidate = Some(File::open(root.join("candidate/payload")).unwrap());
                        candidate.as_ref().unwrap().as_raw_fd()
                    }
                    "drop-candidate" => {
                        let file = candidate.take().unwrap();
                        let number = file.as_raw_fd();
                        drop(file);
                        number
                    }
                    "opaque" => {
                        unsafe extern "C" {
                            fn syscall(number: std::os::raw::c_long, ...) -> std::os::raw::c_long;
                        }
                        let mut parameters = [0u64; 15];
                        // SAFETY: owned child, supported Linux syscall425 and
                        // initialized aligned 120-byte io_uring_params buffer.
                        let raw = unsafe { syscall(425, 8u32, parameters.as_mut_ptr()) };
                        assert!(raw >= 0, "io_uring_setup: {}", io::Error::last_os_error());
                        // SAFETY: successful setup transfers this fresh FD once.
                        opaque = Some(unsafe { OwnedFd::from_raw_fd(i32::try_from(raw).unwrap()) });
                        opaque.as_ref().unwrap().as_raw_fd()
                    }
                    "drop-opaque" => {
                        drop(opaque.take().unwrap());
                        0
                    }
                    _ => panic!("unexpected owned mutator command"),
                };
                println!("{ACK}{number}");
                std::io::stdout().flush().unwrap();
            }
            return;
        }
        struct Mutator {
            child: Child,
            input: Option<ChildStdin>,
            output: std::io::BufReader<ChildStdout>,
        }
        impl Mutator {
            fn ack(&mut self) -> u32 {
                loop {
                    let mut line = String::new();
                    assert_ne!(self.output.read_line(&mut line).unwrap(), 0, "owned mutator exited");
                    if let Some((_, value)) = line.split_once(ACK) {
                        return value.trim().parse().unwrap();
                    }
                }
            }
            fn command(&mut self, command: &str) -> u32 {
                writeln!(self.input.as_mut().unwrap(), "{command}").unwrap();
                self.input.as_mut().unwrap().flush().unwrap();
                self.ack()
            }
        }
        impl Drop for Mutator {
            fn drop(&mut self) {
                self.input.take(); // EOF releases only this owned child.
                let _ = self.child.wait();
            }
        }
        let fixture = Fixture::new();
        let root = fixture.0.join("candidate");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("payload"), b"candidate").unwrap();
        std::fs::write(fixture.0.join("outside"), b"outside").unwrap();
        std::fs::write(fixture.0.join("outside-extra"), b"outside").unwrap();
        // Exec before any candidate/evidence pins exist: the target must not
        // inherit collector-created capabilities or a mutable helper FD table.
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", TEST, "--nocapture", "--test-threads=1"])
            .env(CHILD, &fixture.0).stdin(Stdio::piped()).stdout(Stdio::piped())
            .spawn().unwrap();
        let input = child.stdin.take();
        let output = std::io::BufReader::new(child.stdout.take().unwrap());
        let mut worker = Mutator { child, input, output };
        let trigger_fd = worker.ack();
        let process = ProcessScope::discover(worker.child.id(), deadline()).unwrap();
        let index = process.tasks.iter().position(|task| task.identity.pid == worker.child.id()).unwrap();
        let task = &process.tasks[index];
        let trigger = Held::pin(format!("/proc/{}/fd/{trigger_fd}", worker.child.id()), deadline()).unwrap();
        let set = fixture_set(&[root]);
        let mounted = set.capture_mounts(&task.scope, deadline()).unwrap();
        set.freeze_scope_devices(deadline()).unwrap();
        let prove = |held: &Held| {
            set.recheck_matches(&held.file, &task.scope, ReferenceKind::Fd,
                Some(&mounted), deadline())?.require_native_negative()
        };
        let resources = process.collect_resources(index, deadline(), None).unwrap().unwrap();
        let original = resources.descriptor_pin_count();
        worker.command("toggle");
        let mut fresh_pins = 0;
        {
            let mut proof = |_: &worktree_holder_proc::scopes::TaskScope, held: &Held,
                _: worktree_holder_proc::scopes::ResourceKind, fresh: bool| {
                if fresh { fresh_pins += 1; }
                prove(held)
            };
            process.recheck_resources(index, &resources, deadline(), Some(&mut proof)).unwrap();
            process.recheck(deadline()).unwrap();
            // A second later FD mutation must repair and reseal too; initial
            // stabilization is not a waiver for the later closing phase.
            worker.command("toggle");
            process.recheck_resources(index, &resources, deadline(), Some(&mut proof)).unwrap();
        }
        assert!(fresh_pins > 0);
        assert_eq!(resources.descriptor_pin_count(), original + fresh_pins);
        assert_eq!(resources.current_descriptor_count(),
            worktree_holder_proc::scopes::numbers(
                format!("/proc/{}/fd", worker.child.id()), deadline()).unwrap().len());
        process.recheck(deadline()).unwrap();
        mounted.recheck(&set, deadline()).unwrap();
        set.recheck(deadline()).unwrap();

        let candidate_fd = worker.command("candidate");
        let positive = process.collect_resources(index, deadline(), None).unwrap().unwrap();
        let retained = &positive.descriptors.iter().find(|(fd, _)| *fd == candidate_fd).unwrap().1;
        let MatchOutcome::Native(matches) = set.recheck_matches(&retained.file, &task.scope,
            ReferenceKind::Fd, Some(&mounted), deadline()).unwrap() else { panic!("lost native candidate") };
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].relative_path, "payload");
        assert_eq!(matches[0].effect, ReferenceEffect::RetainedBytes);
        worker.command("drop-candidate");
        assert_eq!(Held::pin(format!("/proc/{}/fd/{candidate_fd}", worker.child.id()),
            deadline()).err().unwrap().kind(), io::ErrorKind::NotFound);
        let mut proof = |_: &worktree_holder_proc::scopes::TaskScope, held: &Held,
            _: worktree_holder_proc::scopes::ResourceKind, _: bool| prove(held);
        let error = process.recheck_resources(index, &positive, deadline(), Some(&mut proof)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::Other);
        assert_eq!(error.to_string(), "changing descriptor lacks native negative proof");
        assert!(set.recheck_matches(&retained.file, &task.scope, ReferenceKind::Fd,
            Some(&mounted), deadline()).unwrap().require_native_negative().is_err());

        let ordinary = process.collect_resources(index, deadline(), None).unwrap().unwrap();
        worker.command("opaque");
        let error = process.recheck_resources(index, &ordinary, deadline(), Some(&mut proof)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::Other);
        assert_eq!(error.to_string(), "unsupported path-bearing kernel object");
        worker.command("drop-opaque");

        let unstable = process.collect_resources(index, deadline(), None).unwrap().unwrap();
        worker.command("toggle");
        let mut changes = 0;
        {
            let mut proof = |_: &worktree_holder_proc::scopes::TaskScope, held: &Held,
                _: worktree_holder_proc::scopes::ResourceKind, fresh: bool| {
                prove(held)?;
                if fresh && held.identity == trigger.identity {
                    worker.command("toggle");
                    changes += 1;
                }
                Ok(())
            };
            let error = process.recheck_resources(index, &unstable, deadline(), Some(&mut proof)).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::Other);
            assert_eq!(error.to_string(), "process closing pass budget exhausted");
        }
        assert!(changes >= 4, "the original five-pass repair must run before process fallback");
        assert!(changes <= 4 + 3 * (process.descriptor_class_count() + 4),
            "fallback retains the three full-process passes and original four recaptures per failed pair");
        process.recheck(deadline()).unwrap();
    }

    #[test]
    #[ignore = "requires controlled full-root namespace VM; mandatory exact test there"]
    fn common_hardlinks_match_only_actual_held_worktree_path() {
        let fixture = Fixture::new();
        let a = fixture.0.join("a");
        let b = fixture.0.join("b");
        std::fs::create_dir(&a).unwrap();
        std::fs::create_dir(&b).unwrap();
        std::fs::write(a.join("shared.js"), b"library").unwrap();
        std::fs::hard_link(a.join("shared.js"), b.join("shared.js")).unwrap();
        let set = fixture_set(&[a.clone(), b.clone()]);
        let task = objects::pin_magic("/proc/self").unwrap();
        for (index, path) in [a.join("shared.js"), b.join("shared.js")].iter().enumerate() {
            let file = objects::pin_magic(path).unwrap();
            let MatchOutcome::Native(matches) = set.matches(&file, &task, ReferenceKind::Fd,
                deadline()).unwrap() else { panic!("native object classified as proxy") };
            assert_eq!(matches.len(), 1);
            assert_eq!(matches[0].root_index, index);
            assert_eq!(matches[0].relative_path, "shared.js");
        }
        // A symlink to shared storage is not recursively inventoried.
        std::os::unix::fs::symlink(&b, a.join("node_modules")).unwrap();
        set.recheck(deadline()).unwrap();
    }

    #[test]
    #[ignore = "requires controlled full-root namespace VM; mandatory exact test there"]
    fn root_replacement_deadline_and_symlink_confinement_fail_closed() {
        let fixture = Fixture::new();
        let root = fixture.0.join("root");
        std::fs::create_dir(&root).unwrap();
        let set = fixture_set(std::slice::from_ref(&root));
        let task = objects::pin_magic("/proc/self").unwrap();
        assert!(set.matches(&set.get(0).root, &task, ReferenceKind::Cwd,
            Instant::now()).is_err());
        std::fs::rename(&root, fixture.0.join("old-root")).unwrap();
        std::fs::create_dir(&root).unwrap();
        assert!(set.recheck(deadline()).is_err());
        std::os::unix::fs::symlink(fixture.0.join("old-root"), fixture.0.join("alias")).unwrap();
        assert!(pin_absolute(&fixture.0.join("alias")).is_err());
        assert!(objects::pin_beneath(&set.get(0).root, OsStr::new("../root")).is_err());
    }

    #[test]
    #[ignore = "requires controlled full-root namespace VM; mandatory exact test there"]
    fn store_positive_precedes_unlinked_native_mapping_failure() {
        let fixture = Fixture::new();
        let root = fixture.0.join("store");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("payload"), b"retained").unwrap();
        let mut set = fixture_set(std::slice::from_ref(&root));
        set.kind = Kind::Store;
        set.recheck(deadline()).unwrap();
        let file = objects::pin_magic(root.join("payload")).unwrap();
        std::fs::remove_file(root.join("payload")).unwrap();
        let task = objects::pin_magic("/proc/self").unwrap();
        let MatchOutcome::Native(matches) = set.matches(&file, &task, ReferenceKind::Map,
            deadline()).unwrap() else { panic!("store positive lost") };
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].relative_path, "payload");
        assert_eq!(matches[0].effect, ReferenceEffect::RetainedBytes);
        assert!(set.recheck(deadline()).is_err());
    }

    #[test]
    #[ignore = "requires isolated mount namespace with CAP_SYS_ADMIN and native temp filesystem"]
    fn bind_alias_and_detached_mount_fixture() {
        let fixture = Fixture::new();
        let root = fixture.0.join("root");
        let alias = fixture.0.join("alias");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&alias).unwrap();
        std::fs::write(root.join("payload"), b"native").unwrap();
        assert!(std::process::Command::new("mount").arg("--bind").arg(&root).arg(&alias)
            .status().unwrap().success());
        struct Unmount(PathBuf);
        impl Drop for Unmount {
            fn drop(&mut self) {
                let _ = std::process::Command::new("umount").arg("-l").arg(&self.0).status();
            }
        }
        let _unmount = Unmount(alias.clone());
        let set = fixture_set(std::slice::from_ref(&root));
        let task = objects::pin_magic("/proc/self").unwrap();
        let mounted = set.capture_mounts(&task, deadline()).unwrap();
        assert_eq!(mounted.references().len(), 1);
        assert_eq!(mounted.references()[0].relative_path, ".");
        assert_eq!(mounted.references()[0].effect, ReferenceEffect::InUse);
        mounted.recheck(&set, deadline()).unwrap();
        for (path, relative) in [(&alias, "."), (&alias.join("payload"), "payload")] {
            let held = objects::pin_magic(path).unwrap();
            let MatchOutcome::Native(matches) = set.matches(&held, &task,
                ReferenceKind::Fd, deadline()).unwrap() else { panic!("native alias lost") };
            assert_eq!(matches.len(), 1);
            assert_eq!(matches[0].relative_path, relative);
        }
        let detached = objects::pin_magic(alias.join("payload")).unwrap();
        let surviving_directory = objects::pin_magic(&alias).unwrap();
        let _surviving_mounts = set.capture_mounts(&task, deadline()).unwrap();
        let (ready, receive) = std::sync::mpsc::sync_channel(0);
        let (release, wait) = std::sync::mpsc::channel::<()>();
        let worker = std::thread::spawn(move || {
            ready.send(objects::pin_magic("/proc/thread-self").unwrap()).unwrap();
            let _ = wait.recv();
        });
        let worker_task = receive.recv().unwrap();
        let process = worktree_holder_proc::scopes::ProcessScope::discover(
            std::process::id(), deadline()).unwrap();
        let worker_identity = objects::identity(&worker_task).unwrap();
        let index = process.tasks.iter().position(|task|
            objects::identity(&task.scope).unwrap() == worker_identity).unwrap();
        assert_ne!(process.tasks[index].identity.pid, process.identity.pid);
        let departed_mounts = set.capture_mounts(&worker_task, deadline()).unwrap();
        assert_eq!(departed_mounts.references().len(), 1);
        drop(release);
        worker.join().unwrap();
        assert!(process.task_departed(index, deadline()).unwrap());
        assert!(departed_mounts.recheck(&set, deadline()).is_err());
        departed_mounts.recheck_retained(&set, deadline()).unwrap();
        assert!(process.task_departed(index, deadline()).unwrap());
        // Preserve both typed effects for FDs held by the surviving task.
        for (held, effect) in [
            (&detached, ReferenceEffect::RetainedBytes),
            (&surviving_directory, ReferenceEffect::InUse),
        ] {
            let MatchOutcome::Native(matches) = set.matches(held, &task,
                ReferenceKind::Fd, deadline()).unwrap() else { panic!("survivor FD became proxy") };
            assert_eq!(matches.len(), 1);
            assert_eq!(matches[0].effect, effect);
        }
        assert!(std::process::Command::new("umount").arg("-l").arg(&alias)
            .status().unwrap().success());
        assert!(mounted.recheck(&set, deadline()).is_err());
        assert!(departed_mounts.recheck_retained(&set, deadline()).is_err());
        assert!(set.matches(&detached, &task, ReferenceKind::Fd, deadline()).is_err());
    }

    #[test]
    #[ignore = "requires controlled full-root namespace VM; mandatory exact test there"]
    fn terminal_devices_do_not_pin_candidate_paths() {
        let fixture = Fixture::new();
        let root = fixture.0.join("root");
        std::fs::create_dir(&root).unwrap();
        let set = fixture_set(&[root]);
        let task = objects::pin_magic("/proc/self").unwrap();
        let null = objects::pin_magic("/dev/null").unwrap();
        let MatchOutcome::Native(matches) = set.matches(&null, &task,
            ReferenceKind::Fd, deadline()).unwrap() else { panic!("device became proxy") };
        assert!(matches.is_empty());
        let mounted = set.capture_mounts(&task, deadline()).unwrap();
        assert!(mounted.references().is_empty());
        mounted.recheck(&set, deadline()).unwrap();
    }

    #[test]
    fn member_paths_are_bounded_and_never_ambiguous() {
        assert_eq!(relative_text(Path::new("")).unwrap(), ".");
        assert_eq!(relative_text(Path::new("src/a.rs")).unwrap(), "src/a.rs");
        assert!(relative_text(Path::new("bad\nname")).is_err());
        assert!(relative_text(Path::new(&"a".repeat(4097))).is_err());
    }

    #[test]
    #[ignore = "requires controlled full-root namespace VM; mandatory exact test there"]
    fn actual_internal_memfd_recloses_with_frozen_retained_views() {
        let fixture = Fixture::new();
        let root = fixture.0.join("root");
        std::fs::create_dir(&root).unwrap();
        let set = fixture_set(&[root]);
        let task = objects::pin_magic("/proc/self").unwrap();
        let file = File::from(linux::internal_shmem_witness().unwrap());
        assert!(file.metadata().unwrap().is_file());
        assert_eq!(file.metadata().unwrap().nlink(), 0);
        assert_eq!(linux::filesystem_type(&file).unwrap(), shmem::TMPFS);
        for kind in [ReferenceKind::Fd, ReferenceKind::Map] {
            let MatchOutcome::Native(matches) = set.matches(&file, &task, kind, deadline()).unwrap()
                else { panic!("internal shmem classified as proxy") };
            assert!(matches.is_empty());
        }
        assert!(set.witness.borrow().is_some());
        assert!(set.freeze_scope_devices(deadline()).is_err());
        let mounted = set.capture_mounts(&task, deadline()).unwrap();
        set.freeze_scope_devices(deadline()).unwrap();
        for kind in [ReferenceKind::Fd, ReferenceKind::Map] {
            let MatchOutcome::Native(matches) = set.recheck_matches(&file, &task, kind,
                Some(&mounted), deadline()).unwrap() else { panic!("internal shmem classified as proxy") };
            assert!(matches.is_empty());
        }
        let late = set.capture_mounts(&task, deadline()).unwrap();
        assert_eq!(late.view.devices, mounted.view.devices);
        set.freeze_scope_devices(deadline()).unwrap();
        late.recheck(&set, deadline()).unwrap();
        let MatchOutcome::Native(positive) = set.recheck_matches(&set.get(0).root,
            &task, ReferenceKind::Cwd, Some(&late), deadline()).unwrap()
            else { panic!("late frozen view lost actual candidate root") };
        assert_eq!(positive.len(), 1);
        assert_eq!(positive[0].root_index, 0);
        mounted.recheck(&set, deadline()).unwrap();
        set.recheck(deadline()).unwrap();
    }

    #[test]
    #[ignore = "requires controlled full-root namespace VM; mandatory exact test there"]
    fn linked_candidate_and_unlinked_same_filesystem_never_use_shmem_exclusion() {
        let fixture = Fixture::new();
        let root = fixture.0.join("root");
        std::fs::create_dir(&root).unwrap();
        let path = root.join("payload");
        std::fs::write(&path, b"candidate").unwrap();
        let file = File::open(&path).unwrap();
        let set = fixture_set(&[root]);
        let task = objects::pin_magic("/proc/self").unwrap();
        assert_eq!(file.metadata().unwrap().dev(), set.get(0).identity.dev);
        let MatchOutcome::Native(matches) = set.matches(&file, &task, ReferenceKind::Fd,
            deadline()).unwrap() else { panic!("linked candidate lost") };
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].relative_path, "payload");
        std::fs::remove_file(path).unwrap();
        assert_eq!(file.metadata().unwrap().nlink(), 0);
        assert!(set.matches(&file, &task, ReferenceKind::Fd, deadline()).is_err());
        assert!(set.witness.borrow().is_none());
    }

    #[test]
    #[ignore = "requires controlled guest root with CAP_SYS_ADMIN and native temp filesystem"]
    fn internal_memfd_bind_is_einval_and_preserves_frozen_scope() {
        let fixture = Fixture::new();
        let root = fixture.0.join("root");
        std::fs::create_dir(&root).unwrap();
        let target = root.join("bound-file");
        std::fs::write(&target, b"mount target").unwrap();
        let task = objects::pin_magic("/proc/self").unwrap();
        let file = File::from(linux::internal_shmem_witness().unwrap());
        let before = fixture_set(std::slice::from_ref(&root));
        let MatchOutcome::Native(matches) = before.matches(&file, &task, ReferenceKind::Fd,
            deadline()).unwrap() else { panic!("internal shmem classified as proxy") };
        assert!(matches.is_empty());
        let retained = before.capture_mounts(&task, deadline()).unwrap();
        before.freeze_scope_devices(deadline()).unwrap();
        // Linux 6.18.62 fs/namespace.c:2984-3018 rejects copying an internal
        // shmem mount: may_copy_tree sees !is_mounted and __do_loopback returns
        // EINVAL. fs/mount.h:131-134 excludes MNT_NS_INTERNAL from is_mounted.
        // This is a real refusal proof, not coverage of an impossible bind.
        // Keep the mutating syscall confined to this cfg(test) VM fixture.
        unsafe extern "C" {
            fn mount(source: *const std::ffi::c_char, target: *const std::ffi::c_char,
                filesystem: *const std::ffi::c_char, flags: std::ffi::c_ulong,
                data: *const std::ffi::c_void) -> std::ffi::c_int;
        }
        use std::os::unix::ffi::OsStrExt;
        let source = std::ffi::CString::new(
            format!("/proc/{}/fd/{}", std::process::id(), file.as_raw_fd())).unwrap();
        let destination = std::ffi::CString::new(target.as_os_str().as_bytes()).unwrap();
        // SAFETY: live NUL-terminated paths, MS_BIND=4096, no filesystem/data
        // pointers. Only this isolated guest-root test can call this binding.
        let result = unsafe { mount(source.as_ptr(), destination.as_ptr(),
            std::ptr::null(), 4096, std::ptr::null()) };
        let error = io::Error::last_os_error();
        assert_eq!(result, -1, "internal shmem must not become namespace-mounted");
        assert_eq!(error.raw_os_error(), Some(22), "exact bind syscall must return EINVAL");
        assert_eq!(std::fs::read(&target).unwrap(), b"mount target");
        before.recheck(deadline()).unwrap();
        retained.recheck(&before, deadline()).unwrap();
        assert_eq!(file.metadata().unwrap().nlink(), 0);
        let MatchOutcome::Native(matches) = before.recheck_matches(&file, &task,
            ReferenceKind::Fd, Some(&retained), deadline()).unwrap()
            else { panic!("refused bind changed native classification") };
        assert!(matches.is_empty());
    }
    #[test]
    #[ignore = "requires controlled guest root, exact production-capability probe and static busybox"]
    fn jailed_namespace_outside_candidate_bind_matches_oracle_without_admin() {
        namespace_fixture::run();
    }

    #[test]
    #[ignore = "requires controlled guest root with CAP_SYS_ADMIN and overlayfs"]
    fn actual_overlay_held_file_requires_proxy_without_native_exemption() {
        let fixture = Fixture::new();
        for directory in ["candidate", "lower", "upper", "work", "overlay"] {
            std::fs::create_dir(fixture.0.join(directory)).unwrap();
        }
        std::fs::write(fixture.0.join("lower/held"), b"overlay payload").unwrap();
        let target = fixture.0.join("overlay");
        let options = format!("lowerdir={},upperdir={},workdir={}",
            fixture.0.join("lower").display(), fixture.0.join("upper").display(),
            fixture.0.join("work").display());
        assert!(std::process::Command::new("mount")
            .args(["-t", "overlay", "overlay", "-o"]).arg(options).arg(&target)
            .status().unwrap().success());
        struct Unmount(PathBuf);
        impl Drop for Unmount {
            fn drop(&mut self) {
                let _ = std::process::Command::new("umount").arg("-l").arg(&self.0).status();
            }
        }
        let _unmount = Unmount(target.clone());
        let file = File::open(target.join("held")).unwrap();
        assert_eq!(linux::filesystem_type(&file).unwrap(), 0x794c7630);
        let candidates = fixture_set(&[fixture.0.join("candidate")]);
        let task = objects::pin_magic("/proc/self").unwrap();
        assert!(matches!(candidates.matches(&file, &task, ReferenceKind::Fd,
            deadline()).unwrap(), MatchOutcome::NeedsProxy));
        assert_eq!(std::fs::read(target.join("held")).unwrap(), b"overlay payload");
        // NeedsProxy is deliberately not native absence. The serving VM
        // separately proves that managedPolicy=null turns it into UNKNOWN.
    }

    #[test]
    #[ignore = "requires controlled guest root with CAP_SYS_ADMIN and overlayfs"]
    fn detached_overlay_lower_cannot_be_excluded_by_current_path_device() {
        use std::process::Command;
        struct Mounted(Option<PathBuf>);
        impl Drop for Mounted {
            fn drop(&mut self) {
                if let Some(path) = &self.0 {
                    let _ = Command::new("umount").arg("-l").arg(path).status();
                }
            }
        }
        let fixture = Fixture::new();
        let candidate = fixture.0.join("candidate");
        let outside = fixture.0.join("outside");
        std::fs::create_dir(&candidate).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(candidate.join("held"), b"retained candidate lower").unwrap();
        let candidate_device = std::fs::metadata(&candidate).unwrap().dev();
        assert!(Command::new("mount").args(["-t", "tmpfs", "-o", "size=4m", "tmpfs"])
            .arg(&outside).status().unwrap().success());
        let _outside = Mounted(Some(outside.clone()));
        assert_ne!(std::fs::metadata(&outside).unwrap().dev(), candidate_device);
        let alias = outside.join("lower");
        let merged = outside.join("merged");
        let empty = outside.join("empty-lower");
        std::fs::create_dir(&alias).unwrap();
        std::fs::create_dir(&merged).unwrap();
        std::fs::create_dir(&empty).unwrap();
        assert!(Command::new("mount").arg("--bind").arg(&candidate).arg(&alias)
            .status().unwrap().success());
        let mut lower = Mounted(Some(alias.clone()));
        assert_eq!(std::fs::metadata(&alias).unwrap().dev(), candidate_device);
        // A read-only overlay requires at least two lower layers.
        let options = format!("lowerdir={}:{}", alias.display(), empty.display());
        assert!(Command::new("mount").args(["-t", "overlay", "overlay", "-o"])
            .arg(&options).arg(&merged).status().unwrap().success());
        let _merged = Mounted(Some(merged.clone()));
        let held = File::open(merged.join("held")).unwrap();
        assert_eq!(linux::filesystem_type(&held).unwrap(), 0x794c7630);
        // Detach only this owned bind. Overlay retains its original lower
        // mount; the same lowerdir spelling now resolves into the tmpfs.
        assert!(Command::new("umount").arg("-l").arg(&alias)
            .status().unwrap().success());
        lower.0.take();
        assert_ne!(std::fs::metadata(&alias).unwrap().dev(), candidate_device);
        assert!(!alias.join("held").exists());
        assert_eq!(std::fs::read(merged.join("held")).unwrap(),
            b"retained candidate lower");
        let candidates = fixture_set(&[candidate]);
        let task = objects::pin_magic("/proc/self").unwrap();
        assert!(matches!(candidates.matches(&held, &task, ReferenceKind::Fd,
            deadline()).unwrap(), MatchOutcome::NeedsProxy));
        // Rechecking the textual lowerdir cannot replace an actual backing
        // identity/origin seal, even when the path is stable after capture.
        assert_ne!(std::fs::metadata(&alias).unwrap().dev(), candidate_device);
    }

    #[test]
    #[ignore = "requires controlled guest root, mkfs.erofs and loop block devices"]
    fn block_erofs_candidate_file_vetoes_and_outside_file_is_native() {
        let fixture = Fixture::new();
        let source = fixture.0.join("source");
        for directory in ["candidate", "outside"] {
            std::fs::create_dir_all(source.join(directory)).unwrap();
            std::fs::write(source.join(directory).join("payload"), b"erofs payload").unwrap();
        }
        let image = fixture.0.join("image.erofs");
        assert!(std::process::Command::new("mkfs.erofs").arg(&image).arg(&source)
            .status().unwrap().success());
        let target = fixture.0.join("mounted");
        std::fs::create_dir(&target).unwrap();
        assert!(std::process::Command::new("mount").args(["-t", "erofs", "-o", "loop,ro"])
            .arg(&image).arg(&target).status().unwrap().success());
        struct Unmount(PathBuf);
        impl Drop for Unmount {
            fn drop(&mut self) {
                let _ = std::process::Command::new("umount").arg("-l").arg(&self.0).status();
            }
        }
        let _unmount = Unmount(target.clone());
        let inside = File::open(target.join("candidate/payload")).unwrap();
        let outside = File::open(target.join("outside/payload")).unwrap();
        assert_eq!(linux::filesystem_type(&inside).unwrap(), 0xe0f5e1e2);
        assert_ne!(mounts::device_pair(inside.metadata().unwrap().dev()).0, 0);
        assert_eq!(inside.metadata().unwrap().dev(), outside.metadata().unwrap().dev());
        let candidates = fixture_set(&[target.join("candidate")]);
        let task = objects::pin_magic("/proc/self").unwrap();
        let MatchOutcome::Native(matches) = candidates.matches(&inside, &task,
            ReferenceKind::Fd, deadline()).unwrap() else { panic!("block EROFS requested proxy") };
        assert_eq!(matches.len(), 1, "held candidate file must veto");
        assert_eq!(matches[0].relative_path, "payload");
        let MatchOutcome::Native(matches) = candidates.matches(&outside, &task,
            ReferenceKind::Fd, deadline()).unwrap() else { panic!("outside EROFS requested proxy") };
        assert!(matches.is_empty());
        let coverage = candidates.capture_mounts(&task, deadline()).unwrap();
        candidates.freeze_scope_devices(deadline()).unwrap();
        candidates.recheck(deadline()).unwrap();
        coverage.recheck(&candidates, deadline()).unwrap();
        for (file, expected) in [(&inside, 1), (&outside, 0)] {
            let MatchOutcome::Native(matches) = candidates.recheck_matches(file, &task,
                ReferenceKind::Fd, Some(&coverage), deadline()).unwrap()
                else { panic!("EROFS reclosure requested proxy") };
            assert_eq!(matches.len(), expected);
        }
        assert_eq!(std::fs::read(target.join("candidate/payload")).unwrap(), b"erofs payload");
        assert_eq!(std::fs::read(target.join("outside/payload")).unwrap(), b"erofs payload");
    }

    #[test]
    #[ignore = "requires controlled root Linux with mount namespace administration"]
    fn retained_pre_unshare_mounts_match_and_detached_mounts_remain_unknown() {
        const CHILD: &str = "HOLDER_PRE_UNSHARE_MOUNT_PROBE";
        const TEST: &str = "candidates::tests::retained_pre_unshare_mounts_match_and_detached_mounts_remain_unknown";
        if std::env::var_os(CHILD).is_none() {
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--ignored", "--exact", TEST, "--nocapture"])
                .env(CHILD, "1").status().unwrap();
            assert!(status.success());
            return;
        }
        let fixture = Fixture::new();
        let root = fixture.0.join("candidate");
        let target = fixture.0.join("target");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&target).unwrap();
        std::fs::write(root.join("payload"), b"held candidate").unwrap();
        let set = fixture_set(std::slice::from_ref(&root));
        let collector_namespace = File::open("/proc/thread-self/ns/mnt").unwrap();
        let (ready, receive) = std::sync::mpsc::sync_channel(0);
        let (advance, wait) = std::sync::mpsc::sync_channel::<()>(0);
        let worker_root = root.clone();
        let worker = std::thread::spawn(move || {
            use std::os::fd::AsRawFd;
            let inside = objects::pin_magic(worker_root.join("payload")).unwrap();
            let exe = objects::pin_magic("/proc/thread-self/exe").unwrap();
            let original = File::open("/proc/thread-self/ns/mnt").unwrap();
            unsafe extern "C" { fn unshare(flags: std::ffi::c_int) -> std::ffi::c_int; }
            // SAFETY: only this owned target thread unshares. The collector
            // remains in its original enrollment namespace throughout closure.
            assert_eq!(unsafe { unshare(0x00020000) }, 0);
            let private = File::open("/proc/thread-self/ns/mnt").unwrap();
            assert_ne!(objects::identity(&original).unwrap(), objects::identity(&private).unwrap());
            assert!(std::process::Command::new("mount").args(["--make-rprivate", "/"])
                .status().unwrap().success());
            let tid = std::fs::read_link("/proc/thread-self").unwrap().file_name().unwrap()
                .to_str().unwrap().parse::<u32>().unwrap();
            ready.send((tid, inside.as_raw_fd(), exe.as_raw_fd())).unwrap();
            if wait.recv().is_err() { return; }
            assert!(std::process::Command::new("mount").arg("--bind").arg(&worker_root).arg(&target)
                .status().unwrap().success());
            let detached = objects::pin_magic(target.join("payload")).unwrap();
            assert!(std::process::Command::new("umount").arg("-l").arg(&target)
                .status().unwrap().success());
            ready.send((tid, detached.as_raw_fd(), exe.as_raw_fd())).unwrap();
            let _ = wait.recv();
        });
        let (tid, inside_fd, exe_fd) = receive.recv().unwrap();
        assert_ne!(tid, std::process::id(), "target is the actual worker TID, not TGID");
        let task = objects::pin_magic(format!("/proc/{tid}")).unwrap();
        let inside = objects::pin_magic(format!("/proc/{tid}/fd/{inside_fd}")).unwrap();
        let exe = objects::pin_magic(format!("/proc/{tid}/fd/{exe_fd}")).unwrap();
        let view = mounts::NativeView::capture(&task, deadline()).unwrap();
        assert!(view.location(&inside, deadline()).is_err(),
            "the retained original mount must not be listed in the cloned task namespace");
        for (file, kind, expected) in [(&inside, ReferenceKind::Fd, 1), (&exe, ReferenceKind::Exe, 0)] {
            let MatchOutcome::Native(matches) = set.matches(file, &task, kind, deadline()).unwrap()
                else { panic!("retained native mount requested proxy") };
            assert_eq!(matches.len(), expected);
        }
        let coverage = set.capture_mounts(&task, deadline()).unwrap();
        set.freeze_scope_devices(deadline()).unwrap();
        set.recheck(deadline()).unwrap();
        coverage.recheck(&set, deadline()).unwrap();
        for (file, kind, expected) in [(&inside, ReferenceKind::Fd, 1), (&exe, ReferenceKind::Exe, 0)] {
            let MatchOutcome::Native(matches) = set.recheck_matches(file, &task,
                kind, Some(&coverage), deadline()).unwrap()
                else { panic!("object lost its retained mount proof") };
            assert_eq!(matches.len(), expected);
            if expected == 1 { assert_eq!(matches[0].relative_path, "payload"); }
        }
        // The collector stays initial while the actual target changes only its
        // owned namespace. Neither final enrollment nor task closure is skipped.
        assert_eq!(objects::identity(&collector_namespace).unwrap(),
            objects::identity(&File::open("/proc/thread-self/ns/mnt").unwrap()).unwrap());
        advance.send(()).unwrap();
        let (same_tid, detached_fd, _) = receive.recv().unwrap();
        assert_eq!(same_tid, tid);
        let detached = objects::pin_magic(format!("/proc/{tid}/fd/{detached_fd}")).unwrap();
        let absent = fixture_set(std::slice::from_ref(&root));
        assert!(absent.matches(&detached, &task, ReferenceKind::Fd, deadline()).is_err());
        advance.send(()).unwrap();
        worker.join().unwrap();
    }
}
