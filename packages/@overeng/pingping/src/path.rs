//! Compact path identity, change history, and one deadline-driven monitor.
mod route;

use std::collections::{BTreeMap, VecDeque};
use std::fmt::Write as _;
use std::io::Write;
use std::net::IpAddr;
use std::os::unix::net::UnixStream;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime};

use crate::tailnet::{Peer, Status};

use crate::probe::{ProbeEvent, Schedule};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Note {
    pub text: String,
    pub endpoint: Option<String>,
    pub interface: Option<String>,
    pub source: Option<IpAddr>,
}

impl Note {
    pub fn tooltip(&self) -> String {
        let mut text = self.text.clone();
        if let Some(endpoint) = &self.endpoint {
            text.push_str(" · endpoint ");
            text.push_str(endpoint);
        }
        if let Some(source) = self.source {
            let _ = write!(text, " · source {source}");
        }
        text
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Change {
    pub slot: u64,
    pub seen: SystemTime,
    pub old: String,
    pub new: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct State {
    pub note: Option<Note>,
    pub changes: VecDeque<Change>,
}

impl State {
    pub fn update(&mut self, note: Option<Note>, slot: u64, seen: SystemTime) {
        if let (Some(old), Some(new)) = (&self.note, &note) {
            if old.text != new.text {
                // Several transport refreshes can share a long probe interval.
                // That timeline slot describes its latest observed transition.
                if self
                    .changes
                    .back()
                    .is_some_and(|change| change.slot == slot)
                {
                    self.changes.pop_back();
                }
                self.changes.push_back(Change {
                    slot,
                    seen,
                    old: old.text.clone(),
                    new: new.text.clone(),
                });
            }
        }
        self.note = note;
    }

    /// Evict transitions only when their corresponding probes leave history.
    pub fn retain_from(&mut self, oldest_slot: u64) {
        while self
            .changes
            .front()
            .is_some_and(|change| change.slot < oldest_slot)
        {
            self.changes.pop_front();
        }
    }

    pub fn label(&self, now: SystemTime) -> Option<String> {
        let note = self.note.as_ref()?;
        let mut label = note.text.clone();
        if let Some(change) = self.changes.back() {
            let age = now.duration_since(change.seen).unwrap_or_default();
            if age < Duration::from_secs(30) {
                let _ = write!(label, " (was {}, {}s ago)", change.old, age.as_secs());
            }
        }
        Some(label)
    }

    pub fn marker_remaining(&self, now: SystemTime) -> Option<Duration> {
        self.note.as_ref()?;
        let age = now
            .duration_since(self.changes.back()?.seen)
            .unwrap_or_default();
        Duration::from_secs(30)
            .checked_sub(age)
            .filter(|remaining| !remaining.is_zero())
    }
}

fn peer(status: &Status, address: IpAddr) -> Option<&Peer> {
    status
        .peers
        .values()
        .find(|peer| peer.ips.contains(&address))
}

fn peer_note(peer: &Peer) -> Option<Note> {
    fn field(text: &str) -> Option<&str> {
        (!text.is_empty() && !text.chars().any(char::is_control)).then_some(text)
    }
    let endpoint = peer.active.then(|| field(&peer.cur_addr)).flatten();
    let text = if !peer.active {
        "tailnet idle".into()
    } else if endpoint.is_some() {
        "tailnet direct".into()
    } else if field(&peer.peer_relay).is_some() {
        "tailnet peer relay".into()
    } else {
        let region = field(&peer.relay)?;
        format!("tailnet DERP {region}")
    };
    Some(Note {
        text,
        endpoint: endpoint.map(str::to_owned),
        interface: None,
        source: None,
    })
}

pub fn initial(status: Option<&Status>, address: IpAddr) -> Option<Note> {
    if let Some(status) = status.filter(|status| peer(status, address).is_some()) {
        tailnet_note(status, address)
    } else {
        route::lookup(address)
    }
}

fn tailnet_note(status: &Status, address: IpAddr) -> Option<Note> {
    let mut note = peer_note(peer(status, address)?)?;
    note.source = status
        .self_peer
        .as_ref()
        .into_iter()
        .flat_map(|peer| &peer.ips)
        .copied()
        .find(|ip| ip.is_ipv6() == address.is_ipv6());
    Some(note)
}

enum Command {
    Address(usize, IpAddr),
    Remove(usize),
    #[cfg(target_os = "macos")]
    NetworkChanged,
}

pub struct Monitor {
    commands: Option<Sender<Command>>,
    thread: Option<JoinHandle<()>>,
    #[cfg(target_os = "macos")]
    native: Option<pingping_netinfo_macos::NetInfoMonitor>,
}

impl Monitor {
    pub fn spawn(
        schedule: Arc<Schedule>,
        events: Sender<(usize, ProbeEvent)>,
        wake: Arc<UnixStream>,
    ) -> Self {
        let (commands, receiver) = mpsc::channel();
        #[cfg(target_os = "macos")]
        let native = {
            let commands = commands.clone();
            pingping_netinfo_macos::NetInfoMonitor::start(move || {
                let _ = commands.send(Command::NetworkChanged);
            })
        };
        let thread = std::thread::spawn(move || monitor(&receiver, &schedule, &events, &wake));
        Self {
            commands: Some(commands),
            thread: Some(thread),
            #[cfg(target_os = "macos")]
            native,
        }
    }
    pub fn resolved(&self, index: usize, address: IpAddr) {
        if let Some(commands) = &self.commands {
            let _ = commands.send(Command::Address(index, address));
        }
    }
    pub fn finished(&self, index: usize) {
        if let Some(commands) = &self.commands {
            let _ = commands.send(Command::Remove(index));
        }
    }
}

impl Drop for Monitor {
    fn drop(&mut self) {
        #[cfg(target_os = "macos")]
        self.native.take();
        self.commands.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

struct Watched {
    address: IpAddr,
    tailnet: bool,
    note: Option<Note>,
    next: Instant,
}

fn refresh_interval() -> Duration {
    if std::path::Path::new("/var/run/tailscale/tailscaled.sock").exists() {
        Duration::from_secs(3)
    } else {
        Duration::from_secs(30)
    }
}

#[allow(
    clippy::too_many_lines,
    reason = "one deadline loop owns route, tailnet and selected-link refresh sequencing"
)]
fn monitor(
    commands: &Receiver<Command>,
    schedule: &Schedule,
    events: &Sender<(usize, ProbeEvent)>,
    wake: &UnixStream,
) {
    let mut hosts = BTreeMap::<usize, Watched>::new();
    let mut status = None;
    let mut loaded = false;
    let mut next_tailnet = Instant::now();
    let mut next_network = Instant::now();
    let mut network = crate::netinfo::Tracker::new();
    let mut egress_generation = 0;
    let mut network_loaded = false;
    loop {
        let deadline = hosts
            .values()
            .map(|host| host.next)
            .min()
            .map(|deadline| deadline.min(next_network));
        let command = if let Some(deadline) = deadline {
            match commands.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(command) => Some(command),
                Err(mpsc::RecvTimeoutError::Timeout) => None,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        } else {
            match commands.recv() {
                Ok(command) => Some(command),
                Err(_) => break,
            }
        };
        if let Some(command) = command {
            match command {
                Command::Address(index, address) => {
                    if !loaded {
                        status = crate::tailnet::status();
                        loaded = true;
                        next_tailnet = Instant::now() + refresh_interval();
                    }
                    hosts.insert(
                        index,
                        Watched {
                            address,
                            tailnet: status
                                .as_ref()
                                .and_then(|status| peer(status, address))
                                .is_some(),
                            note: None,
                            next: Instant::now(),
                        },
                    );
                    next_network = Instant::now();
                }
                Command::Remove(index) => {
                    hosts.remove(&index);
                }
                #[cfg(target_os = "macos")]
                Command::NetworkChanged => {
                    next_network = Instant::now();
                    network.invalidate();
                    for host in hosts.values_mut().filter(|host| !host.tailnet) {
                        host.next = next_network;
                    }
                }
            }
        }
        let now = Instant::now();
        if now >= next_tailnet && hosts.values().any(|host| host.tailnet) {
            status = crate::tailnet::status();
            next_tailnet = Instant::now() + refresh_interval();
        }
        for (&index, host) in &mut hosts {
            if now < host.next {
                continue;
            }
            let note = if host.tailnet {
                status
                    .as_ref()
                    .and_then(|status| tailnet_note(status, host.address))
            } else {
                route::lookup(host.address)
            };
            host.next = if host.tailnet {
                next_tailnet
            } else {
                Instant::now() + Duration::from_secs(10)
            };
            if note != host.note {
                if !host.tailnet {
                    next_network = now;
                }
                host.note.clone_from(&note);
                let slot = schedule.slot(Instant::now());
                if events
                    .send((
                        index,
                        ProbeEvent::Path {
                            note,
                            slot,
                            seen: SystemTime::now(),
                        },
                    ))
                    .is_err()
                {
                    return;
                }
                let mut notifier = wake;
                let _ = notifier.write_all(&[1]);
            }
        }
        if !hosts.is_empty() && now >= next_network {
            let interface = crate::netinfo::select(
                hosts
                    .values()
                    .filter(|host| !host.tailnet)
                    .filter_map(|host| host.note.as_ref()?.interface.as_deref()),
            );
            let changed = network.refresh(interface.as_deref());
            next_network = Instant::now() + Duration::from_secs(10);
            if changed {
                if network_loaded {
                    egress_generation += 1;
                    let _ = events.send((
                        0,
                        ProbeEvent::Egress {
                            generation: egress_generation,
                            info: None,
                        },
                    ));
                    crate::egress::spawn(
                        egress_generation,
                        events.clone(),
                        wake.try_clone().ok().map(Arc::new),
                    );
                }
                if events
                    .send((0, ProbeEvent::Network(network.current.clone())))
                    .is_err()
                {
                    return;
                }
                let mut notifier = wake;
                let _ = notifier.write_all(&[1]);
            }
            network_loaded = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tailscale_precedence_and_idle() {
        for (active, current, peer_relay, relay, expected) in [
            (
                true,
                "1.2.3.4:123",
                "relay-peer",
                "nue",
                Some("tailnet direct"),
            ),
            (true, "", "relay-peer", "nue", Some("tailnet peer relay")),
            (true, "", "", "nue", Some("tailnet DERP nue")),
            (false, "1.2.3.4:123", "", "nue", Some("tailnet idle")),
            (false, "", "", "", Some("tailnet idle")),
            (true, "", "", "", None),
        ] {
            let peer = serde_json::json!({"Active":active,"CurAddr":current,"PeerRelay":peer_relay,"Relay":relay});
            let peer: Peer = serde_json::from_value(peer).unwrap();
            assert_eq!(
                peer_note(&peer).as_ref().map(|note| note.text.as_str()),
                expected
            );
        }
    }
    #[test]
    fn marker_expires_without_losing_timeline_change() {
        let mut state = State::default();
        let seen = SystemTime::UNIX_EPOCH;
        let note = |text: &str| {
            Some(Note {
                text: text.into(),
                endpoint: None,
                interface: None,
                source: None,
            })
        };
        state.update(note("tailnet DERP nue"), 1, seen);
        state.update(note("tailnet direct"), 2, seen);
        assert_eq!(
            state.label(seen + Duration::from_secs(29)).unwrap(),
            "tailnet direct (was tailnet DERP nue, 29s ago)"
        );
        assert_eq!(
            state.label(seen + Duration::from_secs(30)).unwrap(),
            "tailnet direct"
        );
        assert_eq!(state.changes.back().unwrap().old, "tailnet DERP nue");
        state.update(note("tailnet peer relay"), 2, seen);
        assert_eq!(state.changes.back().unwrap().old, "tailnet direct");
        assert_eq!(
            state.label(seen).unwrap(),
            "tailnet peer relay (was tailnet direct, 0s ago)"
        );
        state.retain_from(3);
        assert!(state.changes.is_empty());
    }

    fn note(text: &str) -> Note {
        Note {
            text: text.into(),
            endpoint: None,
            interface: None,
            source: None,
        }
    }

    fn schedule(interval: Duration, start: Instant) -> Schedule {
        Schedule::new(crate::probe::ProbeConfig {
            interval,
            timeout: Duration::from_secs(1),
            count: None,
            family: crate::probe::Family::Any,
            start,
        })
    }

    #[test]
    fn faster_rate_keeps_transitions_in_distinct_probe_slots() {
        let start = Instant::now();
        let schedule = schedule(Duration::from_mins(1), start);
        let mut state = State::default();
        let seen = SystemTime::UNIX_EPOCH;
        state.update(Some(note("relay")), schedule.slot(start), seen);
        schedule.change(Duration::from_secs(1), start + Duration::from_secs(2));
        assert_eq!(schedule.slot(start + Duration::from_secs(2)), 0);
        for (seconds, text) in [(3, "direct"), (6, "idle")] {
            state.update(
                Some(note(text)),
                schedule.slot(start + Duration::from_secs(seconds)),
                seen + Duration::from_secs(seconds),
            );
        }
        assert_eq!(state.changes.len(), 2);
        assert_eq!(state.changes.front().unwrap().slot, 1);
        assert_eq!(state.changes.back().unwrap().slot, 4);
    }

    #[test]
    fn slower_rate_does_not_expire_transitions_by_startup_interval() {
        let start = Instant::now();
        let schedule = schedule(Duration::from_secs(1), start);
        let mut state = State::default();
        let seen = SystemTime::UNIX_EPOCH;
        state.update(Some(note("relay")), schedule.slot(start), seen);
        state.update(
            Some(note("direct")),
            schedule.slot(start + Duration::from_secs(1)),
            seen,
        );
        schedule.change(Duration::from_mins(1), start + Duration::from_secs(1));
        state.update(
            Some(note("idle")),
            schedule.slot(start + Duration::from_secs(86_402)),
            seen + Duration::from_secs(86_402),
        );
        assert_eq!(state.changes.len(), 2);
        assert_eq!(state.changes.front().unwrap().slot, 1);
        assert_eq!(state.changes.back().unwrap().slot, 1_442);
    }
}
