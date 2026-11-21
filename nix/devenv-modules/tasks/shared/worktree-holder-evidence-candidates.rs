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

pub struct MountCoverage {
    view: CandidateView,
    locations: Vec<mounts::NativeLocation>,
    references: Vec<MatchedReference>,
}

impl MountCoverage {
    pub fn references(&self) -> &[MatchedReference] { &self.references }

    pub fn recheck(&self, candidates: &CandidateSet, deadline: Instant) -> io::Result<()> {
        self.view.recheck(deadline)?;
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
        self.view.recheck(deadline)
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
    scope_ledger: RefCell<ScopeLedger>,
    witness: RefCell<Option<ShmemWitness>>,
    // Captured once per task, then moved into its retained MountCoverage.
    native_view: RefCell<Option<CandidateView>>,
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
        let enrolled_view = CandidateView::capture(&self_task, &scopes, deadline)?;
        let scope_ledger = RefCell::new(ScopeLedger::new(devices.clone(), &enrolled_view));
        Ok(Self { kind: request.kind, uid, roots, scopes, devices, enrolled_view, scope_ledger,
            witness: RefCell::new(None), store_inventory: RefCell::new(None), native_view: RefCell::new(None) })
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
        self.enrolled_view.recheck(deadline)?;
        if let Some(witness) = self.witness.borrow().as_ref() { witness.recheck()?; }
        if let Some(view) = self.native_view.borrow().as_ref() { view.recheck(deadline)?; }
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
                    && mount.root.starts_with(&scope.location.path))
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
        self.scope_ledger.borrow().require_collecting()?;
        let view = CandidateView::capture(task_scope, &self.scopes, deadline)?;
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
        // Ordinary detached/unlisted tmpfs never enters a provider fallback.
        let result = view.view.location(file, deadline);
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
        let enrolled_view = CandidateView::capture(&task, &scopes, deadline()).unwrap();
        let scope_ledger = RefCell::new(ScopeLedger::new(devices.clone(), &enrolled_view));
        CandidateSet { kind: Kind::Worktree, uid: roots[0].root.metadata().unwrap().uid(),
            roots, scopes, devices, enrolled_view, scope_ledger, witness: RefCell::new(None),
            store_inventory: RefCell::new(None), native_view: RefCell::new(None) }
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
        assert!(std::process::Command::new("umount").arg("-l").arg(&alias)
            .status().unwrap().success());
        assert!(mounted.recheck(&set, deadline()).is_err());
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
        assert!(set.capture_mounts(&task, deadline()).is_err());
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
}
