//! Stable live membership, shared scheduling, and target-local cancellation.
use std::collections::BTreeMap;
use std::io;
use std::net::IpAddr;
use std::os::unix::net::UnixStream;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc::Sender;
use std::sync::Arc;

use crate::history::{HistoricalSession, Store};
use crate::probe::{self, ProbeConfig, ProbeEvent, Schedule};
use crate::stats::HostState;
use crate::target::{Target, TargetId, GLOBAL_ID};
use crate::{egress, netinfo, path, render, uptime};

struct Workers {
    probe: probe::Worker,
    uptime: Option<uptime::Worker>,
}

impl Workers {
    fn cancel(&self) {
        self.probe.cancel();
        if let Some(uptime) = &self.uptime {
            uptime.cancel();
        }
    }

    fn finished(&self) -> bool {
        self.probe.finished() && self.uptime.as_ref().is_none_or(uptime::Worker::finished)
    }
}

impl Drop for Workers {
    fn drop(&mut self) {
        self.cancel();
    }
}

pub struct Runtime {
    pub hosts: Vec<HostState>,
    pub schedule: Arc<Schedule>,
    config: ProbeConfig,
    events: Sender<(TargetId, ProbeEvent)>,
    wake: Option<Arc<UnixStream>>,
    paths: Option<path::Monitor>,
    next_id: TargetId,
    addresses: BTreeMap<TargetId, IpAddr>,
    workers: BTreeMap<TargetId, Workers>,
    // Retiring never waits for SSH. Keep ownership until its child has been
    // reaped, including when the user quits before cancellation finishes.
    retired: Vec<Workers>,
    network: Option<Arc<netinfo::NetInfo>>,
    egress: egress::State,
    history: Option<Store>,
}

impl Runtime {
    pub fn new(
        initial: Vec<String>,
        config: ProbeConfig,
        events: Sender<(TargetId, ProbeEvent)>,
        wake: Option<Arc<UnixStream>>,
    ) -> Self {
        let schedule = Arc::new(Schedule::new(config.clone()));
        let paths = wake.as_ref().map(|wake| {
            path::Monitor::spawn(Arc::clone(&schedule), events.clone(), Arc::clone(wake))
        });
        let mut runtime = Self {
            hosts: Vec::with_capacity(initial.len()),
            schedule,
            paths,
            config,
            events,
            wake,
            next_id: 0,
            addresses: BTreeMap::new(),
            workers: BTreeMap::new(),
            retired: Vec::new(),
            network: None,
            egress: egress::State::default(),
            history: None,
        };
        for name in initial {
            let id = runtime.insert(name);
            runtime.start(id, None, runtime.config.count);
        }
        runtime
    }

    /// Attaches the store opened for the initial targets without opening it again.
    pub fn enable_history(&mut self, store: Store, prior: Vec<Vec<HistoricalSession>>) {
        assert!(self.history.is_none(), "history is already enabled");
        assert_eq!(prior.len(), self.hosts.len(), "initial history target count");
        for (host, sessions) in self.hosts.iter_mut().zip(prior) {
            host.prior_sessions = render::restore_history(sessions);
        }
        self.history = Some(store);
    }

    /// Late retired-target and run-wide events must never reach a target journal.
    pub fn record(&mut self, id: TargetId, event: &ProbeEvent) -> io::Result<()> {
        if !self.hosts.iter().any(|host| host.id == id) {
            return Ok(());
        }
        if let Some(history) = &mut self.history {
            history.record(id, event)?;
        }
        Ok(())
    }

    fn insert(&mut self, name: String) -> TargetId {
        assert!(self.next_id < GLOBAL_ID, "target identity space exhausted");
        let id = self.next_id;
        self.next_id += 1;
        let mut host = HostState::new(name);
        host.id = id;
        host.set_interval(self.schedule.interval());
        host.network.clone_from(&self.network);
        host.egress.clone_from(&self.egress);
        self.hosts.push(host);
        id
    }

    fn start(&mut self, id: TargetId, address: Option<IpAddr>, count: Option<u32>) {
        let host = self
            .hosts
            .iter()
            .find(|host| host.id == id)
            .expect("new target");
        let stop = Arc::new(AtomicBool::new(false));
        let mut config = self.config.clone();
        config.count = count;
        let probe = probe::spawn(
            Target {
                id,
                name: host.host.clone(),
                address,
            },
            config,
            Arc::clone(&stop),
            self.events.clone(),
            self.wake.clone(),
            Arc::clone(&self.schedule),
        );
        let uptime = self.wake.as_ref().map(|wake| {
            uptime::spawn(
                id,
                host.host.clone(),
                self.events.clone(),
                Arc::clone(wake),
                stop,
            )
        });
        self.workers.insert(id, Workers { probe, uptime });
    }

    #[cfg(test)]
    pub fn family(&self) -> probe::Family {
        self.config.family
    }

    #[cfg(test)]
    pub fn add_resolved(&mut self, name: String, address: IpAddr) -> io::Result<TargetId> {
        let prior = self.register_history(&name)?;
        let id = self.insert(name);
        self.hosts.last_mut().expect("new target").prior_sessions = render::restore_history(prior);
        self.apply(id, ProbeEvent::Resolved(address));
        self.start(id, Some(address), None);
        Ok(id)
    }

    #[cfg(test)]
    fn register_history(&mut self, name: &str) -> io::Result<Vec<HistoricalSession>> {
        assert!(self.next_id < GLOBAL_ID, "target identity space exhausted");
        match &mut self.history {
            Some(history) => history.register(self.next_id, name, self.schedule.interval()),
            None => Ok(Vec::new()),
        }
    }

    /// Same-address edits rename in place; replacements get a new identity and
    /// fresh history at the old row position. Neither path changes other rows.
    #[cfg(test)]
    pub fn edit_resolved(
        &mut self,
        id: TargetId,
        name: String,
        address: IpAddr,
    ) -> io::Result<Option<TargetId>> {
        let Some(position) = self.hosts.iter().position(|host| host.id == id) else {
            return Ok(None);
        };
        if self.addresses.get(&id) == Some(&address) {
            self.hosts[position].host = name;
            return Ok(Some(id));
        }
        // Complete fallible storage work before touching the old row or workers.
        // Replacements intentionally do not restore any prior presentation history.
        self.register_history(&name)?;
        self.retire(id);
        let replacement = self.insert(name);
        self.apply(replacement, ProbeEvent::Resolved(address));
        self.start(replacement, Some(address), None);
        let host = self.hosts.pop().expect("replacement target");
        self.hosts.insert(position, host);
        Ok(Some(replacement))
    }

    #[cfg(test)]
    pub fn retire(&mut self, id: TargetId) {
        let Some(position) = self.hosts.iter().position(|host| host.id == id) else {
            return;
        };
        self.hosts.remove(position);
        self.addresses.remove(&id);
        if let Some(history) = &mut self.history {
            history.retire(id);
        }
        if let Some(paths) = &self.paths {
            paths.finished(id);
        }
        if let Some(workers) = self.workers.remove(&id) {
            workers.cancel();
            self.retired.push(workers);
        }
        self.reap();
    }

    fn reap(&mut self) {
        self.retired.retain(|workers| !workers.finished());
    }

    /// Returns whether this event changed a live row or run-wide context.
    pub fn apply(&mut self, id: TargetId, event: ProbeEvent) -> bool {
        self.reap();
        match event {
            ProbeEvent::Network(info) if id == GLOBAL_ID => {
                self.network = info;
                for host in &mut self.hosts {
                    host.network.clone_from(&self.network);
                }
                return true;
            }
            ProbeEvent::Egress { generation, info } if id == GLOBAL_ID => {
                self.egress.update(generation, info);
                for host in &mut self.hosts {
                    host.egress.clone_from(&self.egress);
                }
                return true;
            }
            ProbeEvent::Network(_) | ProbeEvent::Egress { .. } => return false,
            _ => {}
        }
        let Some(host) = self.hosts.iter_mut().find(|host| host.id == id) else {
            return false;
        };
        match &event {
            ProbeEvent::Resolved(address) => {
                let changed = self.addresses.insert(id, *address) != Some(*address);
                if let Some(paths) = &self.paths {
                    if changed {
                        paths.resolved(id, *address);
                    }
                }
            }
            ProbeEvent::Finished | ProbeEvent::Failed { .. } => {
                if let Some(paths) = &self.paths {
                    paths.finished(id);
                }
            }
            _ => {}
        }
        host.apply(event);
        true
    }

    pub fn finished(&self) -> bool {
        !self.hosts.is_empty() && self.hosts.iter().all(|host| host.finished)
    }

    pub fn stop(&self) {
        for workers in self.workers.values().chain(&self.retired) {
            workers.cancel();
        }
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        self.stop();
        self.workers.clear();
        self.retired.clear();
        self.paths.take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::probe::Family;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    fn runtime() -> Runtime {
        let (events, _) = mpsc::channel();
        Runtime::new(
            Vec::new(),
            ProbeConfig {
                interval: Duration::from_secs(1),
                timeout: Duration::from_secs(1),
                count: Some(1),
                family: Family::Any,
                start: Instant::now(),
            },
            events,
            None,
        )
    }

    #[test]
    fn retired_events_never_route_to_a_reused_position() {
        let mut runtime = runtime();
        let retired = runtime.insert("old".into());
        runtime.retire(retired);
        let replacement = runtime.insert("new".into());
        assert!(replacement > retired);
        assert!(!runtime.apply(retired, ProbeEvent::Finished));
        assert!(!runtime.hosts[0].finished);
        assert!(runtime.apply(replacement, ProbeEvent::Finished));
        assert!(runtime.finished());
        runtime.retire(replacement);
        assert!(!runtime.finished());
    }

    #[test]
    fn global_cache_survives_deleting_every_target() {
        let mut runtime = runtime();
        let retired = runtime.insert("old".into());
        let info = egress::Info {
            asn: 42,
            organization: "network".into(),
            exit_node: false,
        };
        assert!(runtime.apply(
            GLOBAL_ID,
            ProbeEvent::Egress {
                generation: 2,
                info: Some(info.clone())
            }
        ));
        runtime.retire(retired);
        assert!(!runtime.apply(
            retired,
            ProbeEvent::Egress {
                generation: 3,
                info: None
            }
        ));
        assert!(!runtime.apply(retired, ProbeEvent::Network(None)));
        runtime.apply(
            GLOBAL_ID,
            ProbeEvent::Egress {
                generation: 1,
                info: None,
            },
        );
        runtime.insert("new".into());
        assert_eq!(runtime.hosts[0].egress.info, Some(info));
        assert!(!runtime.finished());
    }

    #[test]
    fn added_targets_keep_finite_initial_runs_live() {
        let mut runtime = runtime();
        let initial = runtime.insert("initial".into());
        runtime.apply(initial, ProbeEvent::Finished);
        assert!(runtime.finished());
        let added = runtime.insert("added".into());
        assert!(!runtime.finished());
        runtime.retire(initial);
        assert!(!runtime.finished());
        runtime.apply(added, ProbeEvent::Finished);
        assert!(runtime.finished());
    }

    #[test]
    fn replacement_gets_fresh_history_at_the_original_position() {
        let mut runtime = runtime();
        assert_eq!(runtime.family(), Family::Any);
        let first = runtime.insert("first".into());
        let old = runtime.insert("old".into());
        let last = runtime.insert("last".into());
        runtime.apply(old, ProbeEvent::Resolved("127.0.0.1".parse().unwrap()));
        runtime.apply(old, ProbeEvent::Finished);

        let replacement = runtime
            .edit_resolved(old, "replacement".into(), "127.0.0.2".parse().unwrap())
            .unwrap()
            .unwrap();

        assert!(replacement > last);
        assert_eq!(
            runtime.hosts.iter().map(|host| host.id).collect::<Vec<_>>(),
            [first, replacement, last]
        );
        assert!(!runtime.hosts[1].finished);
        assert!(!runtime.apply(old, ProbeEvent::Finished));
        assert!(!runtime.hosts[1].finished);
        assert_eq!(
            runtime.addresses[&replacement],
            "127.0.0.2".parse::<IpAddr>().unwrap()
        );
    }

    #[test]
    fn same_address_edit_keeps_identity_and_history() {
        let mut runtime = runtime();
        let id = runtime.insert("old".into());
        let address = "127.0.0.1".parse().unwrap();
        runtime.apply(id, ProbeEvent::Resolved(address));
        runtime.apply(
            id,
            ProbeEvent::Failed {
                reason: "socket".into(),
                kind: probe::Failure::Socket,
            },
        );
        assert_eq!(
            runtime.edit_resolved(id, "renamed".into(), address).unwrap(),
            Some(id)
        );
        assert_eq!(runtime.hosts[0].host, "renamed");
        assert!(runtime.hosts[0].finished);
    }
}
