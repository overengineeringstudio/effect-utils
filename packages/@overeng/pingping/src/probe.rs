//! One worker thread per host: resolve, then send one echo per interval and
//! report replies and timeouts to the UI thread.

use std::collections::hash_map::RandomState;
use std::collections::BTreeMap;
use std::hash::{BuildHasher, Hasher};
use std::io::Write;
use std::net::{IpAddr, ToSocketAddrs};
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime};

use crate::icmp::{EchoSocket, OpenError, Receive};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Family {
    Any,
    V4,
    V6,
}

#[derive(Debug, Clone)]
pub struct ProbeConfig {
    pub interval: Duration,
    pub timeout: Duration,
    pub count: Option<u32>,
    pub family: Family,
    /// Shared schedule origin: every host sends at `start + slot · interval`,
    /// so slot `n` is the same moment for all hosts.
    pub start: Instant,
}

/// Why a host could not be probed. Socket failures are setup errors (exit 2),
/// resolution failures mean the host received nothing (exit 1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    Resolve,
    NotPermitted,
    Socket,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ProbeEvent {
    /// A probe due on the shared real-time axis, before its outcome arrives.
    Scheduled {
        slot: u64,
        position: Duration,
        interval: Duration,
    },
    Resolved(IpAddr),
    Path {
        note: Option<crate::path::Note>,
        slot: u64,
        seen: SystemTime,
    },
    Network(Option<Arc<crate::netinfo::NetInfo>>),
    /// Tailnet uptime eligibility, pending read, or completed result.
    Boot(crate::uptime::State),
    Egress {
        generation: u64,
        info: Option<crate::egress::Info>,
    },
    Failed {
        reason: String,
        kind: Failure,
    },
    /// `slot` is the probe's position on the shared schedule; `sent` is the
    /// wall-clock send time, used to label the timeline.
    Reply {
        seq: u16,
        slot: u64,
        rtt: Duration,
        sent: SystemTime,
    },
    Lost {
        seq: u16,
        slot: u64,
        sent: SystemTime,
    },
    Finished,
}

/// Owns the worker and its cancellation endpoint.
pub struct Worker {
    thread: JoinHandle<()>,
    interrupt: Option<Arc<UnixStream>>,
}

impl Worker {
    /// Cancels a blocked receive before waiting for the worker to finish.
    pub fn join(self) -> std::thread::Result<()> {
        if let Some(interrupt) = self.interrupt {
            let _ = interrupt.shutdown(std::net::Shutdown::Both);
        }
        self.thread.join()
    }
}

/// Mutable shared schedule. Changing the rate wakes blocked workers.
pub struct Schedule {
    state: Mutex<ScheduleState>,
    wake: Mutex<Vec<Arc<UnixStream>>>,
}

#[derive(Clone)]
struct ScheduleState {
    config: ProbeConfig,
    first: u64,
}

impl Schedule {
    pub fn new(config: ProbeConfig) -> Self {
        Self {
            state: Mutex::new(ScheduleState { config, first: 0 }),
            wake: Mutex::new(Vec::new()),
        }
    }

    pub fn interval(&self) -> Duration {
        self.state.lock().expect("schedule lock").config.interval
    }

    /// The probe slot in progress, including the previous slot while a new
    /// rate segment waits for its first deadline.
    pub fn slot(&self, now: Instant) -> u64 {
        let state = self.state.lock().expect("schedule lock");
        if now < state.config.start {
            state.first.saturating_sub(1)
        } else {
            state.first + slot_at(&state.config, now, false)
        }
    }

    pub fn change(&self, interval: Duration, now: Instant) {
        {
            let mut state = self.state.lock().expect("schedule lock");
            let next = if now < state.config.start {
                0
            } else {
                slot_at(&state.config, now, false) + 1
            };
            let deadline = slot_time(&state.config, next);
            state.first += next;
            state.config.start = deadline.min(now + interval);
            state.config.interval = interval;
        }
        for stream in self.wake.lock().expect("schedule wake lock").iter() {
            let mut stream = stream.as_ref();
            let _ = stream.write_all(&[1]);
        }
    }

    fn snapshot(&self) -> ScheduleState {
        self.state.lock().expect("schedule lock").clone()
    }
}

/// Free-form initial values snap only when stepping in the requested direction.
pub fn step_interval(current: Duration, faster: bool) -> Duration {
    const MILLIS: [u64; 9] = [100, 200, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000];
    if faster {
        MILLIS
            .into_iter()
            .rev()
            .map(Duration::from_millis)
            .find(|candidate| *candidate < current)
            .unwrap_or(current)
    } else {
        MILLIS
            .into_iter()
            .map(Duration::from_millis)
            .find(|candidate| *candidate > current)
            .unwrap_or(current)
    }
}

pub fn spawn(
    index: usize,
    host: String,
    config: ProbeConfig,
    stop: Arc<AtomicBool>,
    events: Sender<(usize, ProbeEvent)>,
    wake: Option<Arc<UnixStream>>,
    schedule: Arc<Schedule>,
) -> Worker {
    let (interrupt, cancellation) = match UnixStream::pair() {
        Ok((reader, writer)) => match writer.set_nonblocking(true) {
            Ok(()) => (Ok(reader), Some(Arc::new(writer))),
            Err(err) => (Err(err), None),
        },
        Err(err) => (Err(err), None),
    };
    if let Some(writer) = &cancellation {
        schedule
            .wake
            .lock()
            .expect("schedule wake lock")
            .push(Arc::clone(writer));
    }
    let thread = std::thread::spawn(move || {
        let emit = |event| {
            if events.send((index, event)).is_ok() {
                if let Some(wake) = &wake {
                    let mut notifier = wake.as_ref();
                    let _ = notifier.write_all(&[1]);
                }
            }
        };
        let result = interrupt
            .map_err(|err| ProbeEvent::Failed {
                reason: err.to_string(),
                kind: Failure::Socket,
            })
            .and_then(|interrupt| run(&host, &config, &stop, &interrupt, &schedule, &emit));
        match result {
            Ok(()) => emit(ProbeEvent::Finished),
            Err(event) => emit(event),
        }
    });
    Worker {
        thread,
        interrupt: cancellation,
    }
}

fn run(
    host: &str,
    config: &ProbeConfig,
    stop: &AtomicBool,
    interrupt: &UnixStream,
    schedule: &Schedule,
    emit: &impl Fn(ProbeEvent),
) -> Result<(), ProbeEvent> {
    let addr = resolve(host, config.family).map_err(|reason| ProbeEvent::Failed {
        reason,
        kind: Failure::Resolve,
    })?;
    emit(ProbeEvent::Resolved(addr));

    let token = RandomState::new().build_hasher().finish();
    let socket = EchoSocket::open(addr, token).map_err(|err| match err {
        OpenError::NotPermitted(reason) => ProbeEvent::Failed {
            reason,
            kind: Failure::NotPermitted,
        },
        OpenError::Other(reason) => ProbeEvent::Failed {
            reason,
            kind: Failure::Socket,
        },
    })?;

    let mut pending: BTreeMap<u16, (Instant, SystemTime, u64)> = BTreeMap::new();
    let mut seq: u16 = 0;
    let mut sent: u32 = 0;
    // The first slot at or after now; resolution time leaves earlier slots empty.
    let mut shared = schedule.snapshot();
    let mut slot = shared.first + slot_at(&shared.config, Instant::now(), true);
    let mut next_send = slot_time(&shared.config, slot - shared.first);

    while !stop.load(Ordering::Relaxed) {
        let now = Instant::now();
        let updated = schedule.snapshot();
        if updated.config.start != shared.config.start
            || updated.config.interval != shared.config.interval
        {
            shared = updated;
            slot = shared.first + slot_at(&shared.config, now, false);
            next_send = slot_time(&shared.config, slot - shared.first);
        }
        let mut may_send = config.count.is_none_or(|count| sent < count);
        if may_send && now >= next_send {
            // After a stall, overdue slots stay empty: send the slot in
            // progress, never a late probe under an old slot or a burst.
            slot = shared.first + send_slot(&shared.config, slot - shared.first, now);
            emit(ProbeEvent::Scheduled {
                slot,
                position: slot_time(&shared.config, slot - shared.first)
                    .saturating_duration_since(config.start),
                interval: shared.config.interval,
            });
            seq = seq.wrapping_add(1);
            // A send error (e.g. no route) counts as a lost probe, like `ping`.
            let sent_at_wall = SystemTime::now();
            if socket.send(seq).is_ok() {
                pending.insert(seq, (now, sent_at_wall, slot));
            } else {
                emit(ProbeEvent::Lost {
                    seq,
                    slot,
                    sent: sent_at_wall,
                });
            }
            sent += 1;
            may_send = config.count.is_none_or(|count| sent < count);
            slot += 1;
            next_send = slot_time(&shared.config, slot - shared.first);
        }

        pending.retain(|&pending_seq, (sent_at, sent, slot)| {
            let expired = now.duration_since(*sent_at) >= config.timeout;
            if expired {
                emit(ProbeEvent::Lost {
                    seq: pending_seq,
                    slot: *slot,
                    sent: *sent,
                });
            }
            !expired
        });

        let Some(wake) = next_deadline(
            may_send.then_some(next_send),
            pending.values().map(|(sent_at, _, _)| *sent_at),
            config.timeout,
        ) else {
            return Ok(());
        };

        // Unrelated datagrams, elapsed deadlines, and ICMP errors (e.g. host
        // unreachable, reported as recv errors on Linux) leave the probe
        // pending until it expires as lost.
        match socket.recv(wake, interrupt) {
            Ok(Receive::Stopped) => return Ok(()),
            Ok(Receive::Reply(reply_seq)) => {
                if let Some((sent_at, sent, slot)) = pending.remove(&reply_seq) {
                    emit(ProbeEvent::Reply {
                        seq: reply_seq,
                        slot,
                        rtt: sent_at.elapsed(),
                        sent,
                    });
                }
            }
            Ok(Receive::Idle) | Err(_) => {}
        }
    }
    Ok(())
}

/// The next send or pending probe expiry; no deadline means the count is done.
fn next_deadline(
    next_send: Option<Instant>,
    pending: impl Iterator<Item = Instant>,
    timeout: Duration,
) -> Option<Instant> {
    pending
        .map(|sent_at| sent_at + timeout)
        .chain(next_send)
        .min()
}

/// Slot index at `now`: the next slot at or after it (`ceil`), or the slot
/// that has already started (`floor`).
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "elapsed / interval is non-negative and far below 2^52"
)]
fn slot_at(config: &ProbeConfig, now: Instant, ceil: bool) -> u64 {
    let ratio =
        now.saturating_duration_since(config.start).as_secs_f64() / config.interval.as_secs_f64();
    (if ceil { ratio.ceil() } else { ratio.floor() }) as u64
}

/// The slot to send at `now` when `due` is the next scheduled slot: `due`
/// itself, or the slot already in progress if `due` is overdue.
fn send_slot(config: &ProbeConfig, due: u64, now: Instant) -> u64 {
    due.max(slot_at(config, now, false))
}

#[allow(
    clippy::cast_precision_loss,
    reason = "slot counts stay far below 2^52"
)]
fn slot_time(config: &ProbeConfig, slot: u64) -> Instant {
    config.start + config.interval.mul_f64(slot as f64)
}

fn resolve(host: &str, family: Family) -> Result<IpAddr, String> {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return if matches!(
            (family, ip),
            (Family::V4, IpAddr::V6(_)) | (Family::V6, IpAddr::V4(_))
        ) {
            Err("address does not match the requested family".into())
        } else {
            Ok(ip)
        };
    }
    let addrs: Vec<IpAddr> = (host, 0)
        .to_socket_addrs()
        .map_err(|err| format!("could not resolve: {err}"))?
        .map(|addr| addr.ip())
        .collect();
    let pick = match family {
        // IPv4 first: dual-stack names commonly resolve to AAAA on hosts with
        // no IPv6 route, where every probe would be lost.
        Family::Any => addrs.iter().find(|ip| ip.is_ipv4()).or(addrs.first()),
        Family::V4 => addrs.iter().find(|ip| ip.is_ipv4()),
        Family::V6 => addrs.iter().find(|ip| ip.is_ipv6()),
    };
    pick.copied()
        .ok_or_else(|| "no address of the requested family".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_steps_snap_directionally_and_stop_at_boundaries() {
        let rates = [100, 200, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000];
        for pair in rates.windows(2) {
            let fast = Duration::from_millis(pair[0]);
            let slow = Duration::from_millis(pair[1]);
            assert_eq!(step_interval(fast, false), slow);
            assert_eq!(step_interval(slow, true), fast);
        }
        assert_eq!(
            step_interval(Duration::from_millis(750), true),
            Duration::from_millis(500)
        );
        assert_eq!(
            step_interval(Duration::from_millis(750), false),
            Duration::from_secs(1)
        );
        for (value, faster) in [(100, true), (60_000, false), (10, true), (120_000, false)] {
            let value = Duration::from_millis(value);
            assert_eq!(step_interval(value, faster), value);
        }
    }

    #[test]
    fn rate_restart_is_future_bounded_and_shared_without_duplicate_slots() {
        let start = Instant::now();
        let schedule = Schedule::new(ProbeConfig {
            interval: Duration::from_secs(1),
            timeout: Duration::from_secs(2),
            count: None,
            family: Family::Any,
            start,
        });
        let now = start + Duration::from_millis(250);
        schedule.change(Duration::from_millis(100), now);
        let faster = schedule.snapshot();
        assert_eq!(faster.first, 1);
        assert_eq!(faster.config.start, start + Duration::from_millis(350));
        assert!(faster.config.start > now);
        // A second key before the next send retains its ordinal and deadline.
        schedule.change(Duration::from_mins(1), now + Duration::from_millis(10));
        let slower = schedule.snapshot();
        assert_eq!(slower.first, faster.first);
        assert_eq!(slower.config.start, faster.config.start);
        assert!(slower.config.start.duration_since(now) <= Duration::from_secs(1));
        assert_eq!(
            slot_time(&slower.config, 1),
            slower.config.start + Duration::from_mins(1)
        );
        // Changing exactly on a prior send must never send it twice.
        schedule.change(Duration::from_secs(1), slower.config.start);
        let exact = schedule.snapshot();
        assert_eq!(exact.first, 2);
        assert_eq!(
            exact.config.start,
            slower.config.start + Duration::from_secs(1)
        );
    }

    #[test]
    fn family_flags_apply_to_ip_literals() {
        assert!(resolve("127.0.0.1", Family::V6).is_err());
        assert!(resolve("::1", Family::V4).is_err());
        assert_eq!(resolve("::1", Family::Any), Ok("::1".parse().unwrap()));
    }

    #[test]
    fn slots_follow_the_shared_schedule() {
        let start = Instant::now();
        let config = ProbeConfig {
            interval: Duration::from_millis(100),
            timeout: Duration::from_secs(1),
            count: None,
            family: Family::Any,
            start,
        };
        // A host that resolves 250 ms late starts at slot 3 (t = 300 ms).
        let late = start + Duration::from_millis(250);
        assert_eq!(slot_at(&config, late, true), 3);
        assert_eq!(slot_at(&config, late, false), 2);
        assert_eq!(slot_time(&config, 3), start + Duration::from_millis(300));
        assert_eq!(slot_at(&config, start, true), 0);
    }

    #[test]
    fn a_stalled_worker_skips_overdue_slots_without_bursting() {
        let start = Instant::now();
        let config = ProbeConfig {
            interval: Duration::from_secs(1),
            timeout: Duration::from_secs(1),
            count: None,
            family: Family::Any,
            start,
        };
        // Slot 2 was due, but the worker only runs again at t = 10.2 s.
        let now = start + Duration::from_millis(10_200);
        let sent = send_slot(&config, 2, now);
        assert_eq!(sent, 10, "slots 2..10 stay empty");
        assert!(
            slot_time(&config, sent + 1) > now,
            "next send is in the future"
        );
        // On schedule, the due slot is sent as is.
        assert_eq!(
            send_slot(&config, 3, start + Duration::from_millis(3_050)),
            3
        );
    }

    #[test]
    fn waits_for_the_earliest_send_or_expiry_without_idle_polling() {
        let start = Instant::now();
        let send = start + Duration::from_secs(30);
        assert_eq!(
            next_deadline(Some(send), std::iter::empty(), Duration::from_secs(2)),
            Some(send)
        );
        assert_eq!(
            next_deadline(
                Some(send),
                [start + Duration::from_secs(5), start].into_iter(),
                Duration::from_secs(2),
            ),
            Some(start + Duration::from_secs(2))
        );
        assert_eq!(
            next_deadline(
                Some(start + Duration::from_secs(1)),
                std::iter::once(start),
                Duration::from_secs(2),
            ),
            Some(start + Duration::from_secs(1))
        );
    }

    #[test]
    fn a_finished_count_waits_only_for_outstanding_probes() {
        let start = Instant::now();
        let timeout = Duration::from_secs(2);
        assert_eq!(
            next_deadline(None, std::iter::once(start), timeout),
            Some(start + timeout)
        );
        assert_eq!(next_deadline(None, std::iter::empty(), timeout), None);
    }
}
