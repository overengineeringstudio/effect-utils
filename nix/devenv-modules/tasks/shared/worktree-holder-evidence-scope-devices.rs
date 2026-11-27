//! Conservative physical-source alias coverage; never an admission mechanism.
use std::collections::BTreeSet;
use std::fs::File;
use std::io;
use std::path::PathBuf;
use std::time::Instant;
use super::{Scope, bound, mounts, protocol};

pub(super) struct CandidateView {
    pub view: mounts::NativeView,
    locations: Vec<mounts::NativeLocation>,
    pub devices: BTreeSet<u64>,
}

impl CandidateView {
    pub fn capture(task: &File, scopes: &[Scope], cache: &super::super::namespace::NamespaceCache,
        deadline: Instant) -> io::Result<Self>
    {
        let view = mounts::NativeView::capture_cached(task, cache, deadline)?;
        Self::from_view(view, scopes, deadline)
    }

    pub fn from_view(view: mounts::NativeView, scopes: &[Scope], deadline: Instant) -> io::Result<Self> {
        let mut aliases = BTreeSet::<PathBuf>::new();
        for mount in view.mounts() {
            bound(deadline)?;
            for scope in scopes {
                bound(deadline)?;
                if mounts::device_pair(scope.location.device) != (mount.device_major, mount.device_minor) {
                    continue;
                }
                let root = mount.root.path()?;
                if !mounts::canonical(root) || !mounts::canonical(&mount.point) {
                    return Err(io::Error::other("noncanonical candidate scope mount"));
                }
                let alias = if let Ok(relative) = scope.location.path.strip_prefix(root) {
                    if relative.as_os_str().is_empty() { mount.point.clone() }
                    else { mount.point.join(relative) }
                } else if root.starts_with(&scope.location.path) {
                    mount.point.clone()
                } else { continue };
                if !mounts::canonical(&alias) {
                    return Err(io::Error::other("noncanonical candidate scope alias"));
                }
                aliases.insert(alias);
                if aliases.len() > protocol::MAX_REFERENCES {
                    return Err(io::Error::other("candidate scope alias capacity"));
                }
            }
        }
        let mut locations = Vec::new();
        let mut devices = BTreeSet::new();
        for mount in view.mounts() {
            bound(deadline)?;
            let mut selected = false;
            for alias in &aliases {
                bound(deadline)?;
                // Include covering ancestors too: a masked candidate can only
                // enlarge this inventory, never create a false disjointness.
                if mount.point.starts_with(alias) || alias.starts_with(&mount.point) {
                    selected = true;
                    break;
                }
            }
            if !selected { continue; }
            let location = match view.pin_mount_root(mount, deadline) {
                Ok(location) => location,
                Err(error) => {
                    if !view.covered_mount(mount.id, deadline)? { return Err(error); }
                    // A covered mount has no reopenable pathname. Keep its
                    // physical device and complete, rechecked kernel record;
                    // do not invent a NativeLocation or discard its coverage.
                    devices.insert(mounts::device_number(mount.device_major, mount.device_minor));
                    continue;
                }
            };
            devices.insert(location.device);
            locations.push(location);
        }
        let result = Self { view, locations, devices };
        result.recheck(deadline)?;
        Ok(result)
    }

    pub fn recheck(&self, deadline: Instant) -> io::Result<()> {
        self.view.recheck(deadline)?;
        self.recheck_locations(deadline)?;
        self.view.recheck(deadline)
    }

    pub fn recheck_retained(&self, deadline: Instant) -> io::Result<()> {
        self.view.recheck_retained(deadline)?;
        self.recheck_locations(deadline)?;
        self.view.recheck_retained(deadline)
    }

    fn recheck_locations(&self, deadline: Instant) -> io::Result<()> {
        for location in &self.locations {
            bound(deadline)?;
            let current = self.view.location(location.object(), deadline)?;
            if current.device != location.device || current.filesystem != location.filesystem
                || current.path != location.path
            {
                return Err(io::Error::other("candidate scope mount mapping changed"));
            }
        }
        Ok(())
    }
}

pub(super) struct ScopeLedger {
    devices: BTreeSet<u64>,
    captured: usize,
    retained: usize,
    frozen: bool,
}

impl ScopeLedger {
    pub fn new(mut devices: BTreeSet<u64>, enrolled: &CandidateView) -> Self {
        devices.extend(enrolled.devices.iter().copied());
        Self { devices, captured: 0, retained: 0, frozen: false }
    }

    pub fn require_collecting(&self) -> io::Result<()> {
        if self.frozen { return Err(io::Error::other("candidate scope inventory is frozen")); }
        Ok(())
    }

    pub fn register(&mut self, view: &CandidateView) -> io::Result<()> {
        if self.frozen { return Err(io::Error::other("candidate scope inventory is frozen")); }
        self.devices.extend(view.devices.iter().copied());
        self.captured += 1;
        Ok(())
    }

    pub fn retain(&mut self) -> io::Result<()> {
        if self.frozen || self.retained >= self.captured {
            return Err(io::Error::other("candidate scope contribution ownership changed"));
        }
        self.retained += 1;
        Ok(())
    }

    pub fn freeze(&mut self, cache_empty: bool) -> io::Result<()> {
        if !cache_empty || self.captured != self.retained {
            return Err(io::Error::other("candidate scope contribution is not retained"));
        }
        self.frozen = true;
        Ok(())
    }

    pub fn require_frozen(&self) -> io::Result<()> {
        if !self.frozen { return Err(io::Error::other("candidate scope inventory is not frozen")); }
        Ok(())
    }

    pub fn contains(&self, device: u64) -> bool { self.devices.contains(&device) }
}
