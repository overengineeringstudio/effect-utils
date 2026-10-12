//! Per-host state folded from probe events. Pure; the renderer reads it.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::net::IpAddr;
use std::time::{Duration, SystemTime};

use crate::probe::{Failure, ProbeEvent};

/// Retain at most 86,400 actual scheduled probes per host, independent of rate.
const HISTORY_LEN: usize = 86_400;

// Ten retained replies keep relative colouring from reacting to startup noise.
const RTT_BASELINE_REPLIES: usize = 10;

/// Cache only coarse ranges; narrow live windows read their visible slots.
const SUMMARY_SLOTS: u64 = 128;
#[allow(
    clippy::cast_possible_truncation,
    reason = "128 fits every supported usize"
)]
const SUMMARY_LEN: usize = HISTORY_LEN.div_ceil(SUMMARY_SLOTS as usize) + 1;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Sample {
    Reply(Duration),
    Lost,
}

/// One completed probe with its wall-clock send time.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Entry {
    pub sent: SystemTime,
    pub sample: Sample,
}

/// Compact wall time relative to one host origin, retaining nanosecond RTTs.
#[derive(Debug, Clone, Copy, PartialEq)]
struct StoredEntry {
    sample: Sample,
    wall_delta: i64,
}

impl StoredEntry {
    fn expand(self, origin: SystemTime) -> Entry {
        let delta = Duration::from_nanos(self.wall_delta.unsigned_abs());
        Entry {
            sent: if self.wall_delta >= 0 {
                origin + delta
            } else {
                origin - delta
            },
            sample: self.sample,
        }
    }
}

/// Lazy per-host median, with reusable selection storage bounded by retention.
#[derive(Debug, Clone, PartialEq, Default)]
struct RttBaseline {
    dirty: bool,
    replies: usize,
    median: Option<Duration>,
    scratch: Vec<Duration>,
}

impl RttBaseline {
    fn update(&mut self, previous: Option<Sample>, current: Option<Sample>) {
        if previous == current {
            return;
        }
        let was_reply = matches!(previous, Some(Sample::Reply(_)));
        let is_reply = matches!(current, Some(Sample::Reply(_)));
        self.replies = self.replies - usize::from(was_reply) + usize::from(is_reply);
        self.dirty |= was_reply || is_reply;
    }

    fn refresh(&mut self, history: &VecDeque<Option<StoredEntry>>) -> Option<Duration> {
        if !self.dirty {
            return self.median;
        }
        self.scratch.clear();
        if self.replies < RTT_BASELINE_REPLIES {
            self.median = None;
            self.dirty = false;
            return None;
        }
        if self.scratch.capacity() < self.replies && self.replies >= HISTORY_LEN / 2 {
            self.scratch.reserve_exact(HISTORY_LEN);
        }
        self.scratch.extend(
            history
                .iter()
                .flatten()
                .filter_map(|entry| match entry.sample {
                    Sample::Reply(rtt) => Some(rtt),
                    Sample::Lost => None,
                }),
        );
        self.median = Some(self.select_median());
        self.dirty = false;
        self.median
    }

    fn select_median(&mut self) -> Duration {
        let middle = self.scratch.len() / 2;
        let even = self.scratch.len().is_multiple_of(2);
        let (lower, median, _) = self.scratch.select_nth_unstable(middle);
        let upper = *median;
        if even {
            let lower = lower.iter().copied().max().expect("at least ten replies");
            lower + upper.abs_diff(lower) / 2
        } else {
            upper
        }
    }
}
/// A probe's shared scheduled deadline and the rate in effect at that deadline.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Placement {
    slot: u64,
    position: f64,
    interval: f64,
}

#[allow(
    clippy::cast_precision_loss,
    reason = "time coordinates preserve exact nanoseconds for ordinary run durations"
)]
fn nanos(value: Duration) -> f64 {
    value.as_nanos() as f64
}

/// Slowest reply, loss count, and earliest send time for a timeline range.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Bucket {
    pub slowest: Option<Duration>,
    pub samples: usize,
    pub lost: usize,
    pub first: SystemTime,
}

impl Bucket {
    fn include(bucket: &mut Option<Self>, entry: Entry) {
        let summary = bucket.get_or_insert(Self {
            slowest: None,
            samples: 0,
            lost: 0,
            first: entry.sent,
        });
        summary.samples += 1;
        summary.first = summary.first.min(entry.sent);
        match entry.sample {
            Sample::Lost => summary.lost += 1,
            Sample::Reply(rtt) => {
                summary.slowest = Some(summary.slowest.map_or(rtt, |slowest| slowest.max(rtt)));
            }
        }
    }

    fn merge(bucket: &mut Option<Self>, other: Self) {
        if let Some(summary) = bucket {
            summary.samples += other.samples;
            summary.lost += other.lost;
            summary.first = summary.first.min(other.first);
            summary.slowest = match (summary.slowest, other.slowest) {
                (Some(a), Some(b)) => Some(a.max(b)),
                (a, b) => a.or(b),
            };
        } else {
            *bucket = Some(other);
        }
    }
}

/// Statistics for completed outcomes in a slot range, or for the whole run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Stats {
    pub current: Option<Duration>,
    pub min: Option<Duration>,
    pub max: Option<Duration>,
    pub received: u32,
    pub lost: u32,
    total: Duration,
    latest: Option<u64>,
}

impl Stats {
    fn include(&mut self, slot: u64, sample: Sample) {
        let current = match sample {
            Sample::Lost => {
                self.lost += 1;
                None
            }
            Sample::Reply(rtt) => {
                self.received += 1;
                self.total += rtt;
                self.min = Some(self.min.map_or(rtt, |min| min.min(rtt)));
                self.max = Some(self.max.map_or(rtt, |max| max.max(rtt)));
                Some(rtt)
            }
        };
        if self.latest.is_none_or(|latest| slot >= latest) {
            self.latest = Some(slot);
            self.current = current;
        }
    }

    fn merge(&mut self, other: Self) {
        self.received += other.received;
        self.lost += other.lost;
        self.total += other.total;
        if let Some(min) = other.min {
            self.min = Some(self.min.map_or(min, |current| current.min(min)));
        }
        if let Some(max) = other.max {
            self.max = Some(self.max.map_or(max, |current| current.max(max)));
        }
        if other
            .latest
            .is_some_and(|slot| self.latest.is_none_or(|latest| slot >= latest))
        {
            self.latest = other.latest;
            self.current = other.current;
        }
    }

    pub fn completed(self) -> u32 {
        self.received + self.lost
    }

    pub fn avg(self) -> Option<Duration> {
        (self.received > 0).then(|| self.total / self.received)
    }

    pub fn loss_pct(self) -> Option<f64> {
        (self.completed() > 0).then(|| f64::from(self.lost) * 100.0 / f64::from(self.completed()))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SummaryBlock {
    index: u64,
    bucket: Option<Bucket>,
    stats: Stats,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Status {
    Resolving,
    Running(IpAddr),
    Failed { reason: String, kind: Failure },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DropAge {
    NeverReplied,
    SinceReply(Duration),
}

#[derive(Debug, Clone, PartialEq)]
pub struct HostState {
    pub host: String,
    pub status: Status,
    /// Outcomes in scheduled order; unresolved probes retain their placement.
    history: VecDeque<Option<StoredEntry>>,
    rtt_baseline: RefCell<RttBaseline>,
    placements: VecDeque<Placement>,
    /// Dense retained-sample indices trimmed from the front.
    dropped: u64,
    interval: f64,
    scheduled: u64,
    scheduled_mode: bool,
    origin: Option<SystemTime>,
    /// Absolute block indices distinguish reused ring positions after trimming.
    summaries: Vec<SummaryBlock>,
    pub current: Option<Duration>,
    pub min: Option<Duration>,
    pub max: Option<Duration>,
    total: Duration,
    pub received: u32,
    pub lost: u32,
    loss_streak: u8,
    last_reply: Option<SystemTime>,
    pub finished: bool,
    pub path: crate::path::State,
    pub boot: crate::uptime::State,
    /// Run-wide selected link, carried by the first host's network event.
    pub network: Option<std::sync::Arc<crate::netinfo::NetInfo>>,
    pub egress: crate::egress::State,
}

impl HostState {
    pub fn new(host: String) -> Self {
        Self {
            host,
            status: Status::Resolving,
            history: VecDeque::new(),
            rtt_baseline: RefCell::default(),
            placements: VecDeque::new(),
            dropped: 0,
            summaries: Vec::new(),
            interval: 1_000_000_000.0,
            scheduled: 0,
            scheduled_mode: false,
            origin: None,
            current: None,
            min: None,
            max: None,
            total: Duration::ZERO,
            received: 0,
            lost: 0,
            loss_streak: 0,
            last_reply: None,
            finished: false,
            path: crate::path::State::default(),
            boot: crate::uptime::State::Disabled,
            network: None,
            egress: crate::egress::State::default(),
        }
    }

    /// The run-start interval is a fixed time-axis unit, never the current rate.
    pub fn set_interval(&mut self, interval: Duration) {
        assert!(!interval.is_zero());
        self.interval = nanos(interval);
    }

    pub fn sent(&self) -> u64 {
        if self.scheduled_mode {
            self.scheduled
        } else {
            u64::from(self.completed())
        }
    }

    pub fn apply(&mut self, event: ProbeEvent) {
        self.fold::<true>(event);
    }

    /// Plain output needs lifetime statistics, but never retains a timeline or
    /// allocates its aggregate cache, even during an arbitrarily long run.
    pub fn apply_plain(&mut self, event: ProbeEvent) {
        self.fold::<false>(event);
    }

    fn fold<const RETAIN_HISTORY: bool>(&mut self, event: ProbeEvent) {
        match event {
            ProbeEvent::Resolved(addr) => self.status = Status::Running(addr),
            ProbeEvent::Scheduled {
                slot,
                position,
                interval,
            } => {
                self.scheduled_mode = true;
                self.scheduled += 1;
                if RETAIN_HISTORY {
                    let index = self.total_samples();
                    self.extend_history(index);
                    *self.placements.back_mut().expect("new scheduled placement") = Placement {
                        slot,
                        position: nanos(position),
                        interval: nanos(interval),
                    };
                }
            }
            ProbeEvent::Path { note, slot, seen } => self.path.update(note, slot, seen),
            ProbeEvent::Network(info) => self.network = info,
            ProbeEvent::Boot(boot) => {
                self.boot = boot.map_or(
                    crate::uptime::State::Unavailable,
                    crate::uptime::State::Boot,
                );
            }
            ProbeEvent::Egress { generation, info } => self.egress.update(generation, info),
            ProbeEvent::Failed { reason, kind } => {
                self.status = Status::Failed { reason, kind };
                self.finished = true;
            }
            ProbeEvent::Reply {
                rtt, sent, slot, ..
            } => {
                self.received += 1;
                self.loss_streak = 0;
                self.last_reply = Some(sent + rtt);
                self.total += rtt;
                self.current = Some(rtt);
                self.min = Some(self.min.map_or(rtt, |min| min.min(rtt)));
                self.max = Some(self.max.map_or(rtt, |max| max.max(rtt)));
                if RETAIN_HISTORY {
                    self.place(
                        slot,
                        Entry {
                            sent,
                            sample: Sample::Reply(rtt),
                        },
                    );
                }
            }
            ProbeEvent::Lost { sent, slot, .. } => {
                self.lost += 1;
                self.loss_streak = self.loss_streak.saturating_add(1);
                if RETAIN_HISTORY {
                    self.place(
                        slot,
                        Entry {
                            sent,
                            sample: Sample::Lost,
                        },
                    );
                }
            }
            ProbeEvent::Finished => self.finished = true,
        }
    }

    /// Match outcomes by unique probe ordinal, not reply arrival or current rate.
    fn place(&mut self, slot: u64, entry: Entry) {
        let index = if self.scheduled_mode {
            let offset = self
                .placements
                .partition_point(|placement| placement.slot < slot);
            let Some(placement) = self.placements.get(offset).filter(|p| p.slot == slot) else {
                return;
            };
            self.origin.get_or_insert_with(|| {
                entry
                    .sent
                    .checked_sub(Duration::from_secs_f64(placement.position / 1e9))
                    .unwrap_or(entry.sent)
            });
            self.dropped + offset as u64
        } else {
            slot
        };
        if index < self.dropped {
            return;
        }
        self.extend_history(index);
        self.store(index, entry);
    }

    #[allow(
        clippy::cast_precision_loss,
        reason = "synthetic sample ordinals convert to bounded time coordinates"
    )]
    fn extend_history(&mut self, slot: u64) {
        let Some(offset) = slot.checked_sub(self.dropped) else {
            return;
        };
        let Ok(mut index) = usize::try_from(offset) else {
            return;
        };
        if index >= HISTORY_LEN {
            let trim = index + 1 - HISTORY_LEN;
            let popped = trim.min(self.history.len());
            for entry in self.history.drain(..popped).flatten() {
                self.rtt_baseline.get_mut().update(Some(entry.sample), None);
            }
            self.placements.drain(..popped);
            self.dropped += trim as u64;
            self.path.retain_from(
                self.placements
                    .front()
                    .map_or(self.dropped, |placement| placement.slot),
            );
            index -= trim;
        }
        if self.history.len() <= index {
            // Keep ordinary geometric growth for short runs, but do not
            // allocate the next power of two beyond the retention limit.
            if self.history.capacity() <= index && index >= HISTORY_LEN / 2 {
                self.history.reserve_exact(HISTORY_LEN - self.history.len());
                self.placements
                    .reserve_exact(HISTORY_LEN - self.placements.len());
            }
            self.history.resize(index + 1, None);
            for offset in self.placements.len()..self.history.len() {
                let slot = self.dropped + offset as u64;
                self.placements.push_back(Placement {
                    slot,
                    position: self.interval * slot as f64,
                    interval: self.interval,
                });
            }
        }
    }

    fn store(&mut self, slot: u64, entry: Entry) {
        let index = usize::try_from(slot - self.dropped).expect("retained outcome");
        let replaced = self.history[index].is_some();
        let previous = self.history[index].map(|stored| stored.sample);
        self.rtt_baseline
            .get_mut()
            .update(previous, Some(entry.sample));
        let origin = *self.origin.get_or_insert(entry.sent);
        let wall_delta = match entry.sent.duration_since(origin) {
            Ok(delta) => i64::try_from(delta.as_nanos()).expect("wall time within 292 years"),
            Err(error) => {
                -i64::try_from(error.duration().as_nanos()).expect("wall time within 292 years")
            }
        };
        self.history[index] = Some(StoredEntry {
            sample: entry.sample,
            wall_delta,
        });
        let block = slot / SUMMARY_SLOTS;
        let position = usize::try_from(block % SUMMARY_LEN as u64).expect("bounded ring position");
        if self.summaries.is_empty() {
            self.summaries.resize(
                SUMMARY_LEN,
                SummaryBlock {
                    index: u64::MAX,
                    bucket: None,
                    stats: Stats::default(),
                },
            );
        }
        if replaced {
            let from = (block * SUMMARY_SLOTS).max(self.dropped);
            let to = ((block + 1) * SUMMARY_SLOTS).min(self.total_samples());
            let mut summary = SummaryBlock {
                index: block,
                bucket: None,
                stats: Stats::default(),
            };
            let start = usize::try_from(from - self.dropped).expect("retained offset");
            let end = usize::try_from(to - self.dropped).expect("retained offset");
            for (offset, entry) in self.history.range(start..end).enumerate() {
                if let Some(entry) = entry {
                    let entry = entry.expand(origin);
                    Bucket::include(&mut summary.bucket, entry);
                    summary.stats.include(from + offset as u64, entry.sample);
                }
            }
            self.summaries[position] = summary;
        } else {
            let summary = &mut self.summaries[position];
            if summary.index != block {
                *summary = SummaryBlock {
                    index: block,
                    bucket: None,
                    stats: Stats::default(),
                };
            }
            Bucket::include(&mut summary.bucket, entry);
            summary.stats.include(slot, entry.sample);
        }
    }

    /// Absolute index of the first retained sample.
    #[cfg(test)]
    pub fn oldest_index(&self) -> u64 {
        self.dropped
    }

    /// Absolute index one past the newest sample.
    pub fn total_samples(&self) -> u64 {
        self.dropped + self.history.len() as u64
    }

    #[cfg(test)]
    pub fn entry_at(&self, slot: u64) -> Option<Entry> {
        let offset = self
            .placements
            .partition_point(|placement| placement.slot < slot);
        self.placements.get(offset).filter(|p| p.slot == slot)?;
        self.history
            .get(offset)
            .copied()
            .flatten()
            .map(|entry| entry.expand(self.origin.expect("outcome origin")))
    }

    pub fn history_is_empty(&self) -> bool {
        self.history.is_empty()
    }

    /// Retained-reply median, independent of zoom and statistics scope.
    /// Reuses the cached result until a retained reply changes or is evicted.
    pub(crate) fn rtt_baseline(&self) -> Option<Duration> {
        self.rtt_baseline.borrow_mut().refresh(&self.history)
    }

    fn units(&self, position: f64) -> f64 {
        position / self.interval
    }

    pub(crate) fn has_schedule(&self) -> bool {
        self.scheduled_mode
    }

    pub fn oldest_position(&self) -> f64 {
        self.placements
            .front()
            .map_or(0.0, |p| self.units(p.position))
    }

    pub fn latest_position(&self) -> f64 {
        self.placements.back().map_or(0.0, |p| {
            self.units(p.position + p.interval.min(self.interval))
        })
    }

    /// Binary-search actual deadlines, not a grid of presumed due probes.
    /// Expanded ranges include sample bars overlapping their left boundary.
    fn time_indices(&self, from: f64, to: f64, expand: bool) -> (u64, u64) {
        let mut start = 0;
        let mut high = self.placements.len();
        while start < high {
            let middle = start + (high - start) / 2;
            let placement = self.placements[middle];
            let position = if expand {
                let end = placement.position + placement.interval.min(self.interval);
                self.placements
                    .get(middle + 1)
                    .map_or(end, |next| end.min(next.position))
            } else {
                placement.position
            };
            let before = if expand {
                self.units(position) <= from
            } else {
                self.units(position) < from
            };
            if before {
                start = middle + 1;
            } else {
                high = middle;
            }
        }
        let end = self
            .placements
            .partition_point(|p| self.units(p.position) < to);
        (
            self.dropped + start.min(end) as u64,
            self.dropped + end as u64,
        )
    }

    pub fn time_range_stats(&self, from: f64, to: f64) -> Stats {
        let (from, to) = self.time_indices(from, to, true);
        self.range_stats(from, to)
    }

    pub fn time_bucket(&self, from: f64, to: f64, expand: bool) -> Option<Bucket> {
        if from >= to {
            return None;
        }
        let window = (from, to);
        let (from, to) = self.time_indices(from, to, expand);
        if from >= to {
            return self.skipped_bucket(window.0, window.1, expand);
        }
        self.bucket(from, to).or_else(|| {
            if !self.scheduled_mode {
                return None;
            }
            let offset = usize::try_from(from - self.dropped).expect("retained placement");
            let placement = self.placements[offset];
            Some(Bucket {
                slowest: None,
                samples: 0,
                lost: 0,
                first: self.origin.map_or(SystemTime::UNIX_EPOCH, |origin| {
                    origin + Duration::from_secs_f64(placement.position / 1e9)
                }),
            })
        })
    }

    /// Non-overlapping minimap ranges. Advance deadline indices in cached-block
    /// strides, scanning only each cell's boundary fragments: O(width + range /
    /// `SUMMARY_SLOTS`), after one indexed start lookup. Do not expand replies into
    /// adjacent cells: sub-probe cells without a due deadline remain blank.
    #[allow(
        clippy::cast_precision_loss,
        reason = "bounded cell indices convert to elapsed-time coordinates"
    )]
    pub fn time_buckets(&self, from: f64, to: f64, width: usize) -> Vec<Option<Bucket>> {
        if width == 0 || from >= to {
            return vec![None; width];
        }
        let duration = (to - from) / width as f64;
        let mut cursor = self
            .placements
            .partition_point(|placement| self.units(placement.position) < from);
        (0..width)
            .map(|cell| {
                let left = from + cell as f64 * duration;
                let right = if cell + 1 == width {
                    to
                } else {
                    from + (cell + 1) as f64 * duration
                };
                let start = cursor;
                while cursor < self.placements.len()
                    && self.units(self.placements[cursor].position) < right
                {
                    let index = self.dropped + cursor as u64;
                    let step = usize::try_from(SUMMARY_SLOTS - index % SUMMARY_SLOTS)
                        .expect("bounded summary stride");
                    let end = cursor + step;
                    if end <= self.placements.len()
                        && self.units(self.placements[end - 1].position) < right
                    {
                        cursor = end;
                    } else {
                        cursor += 1;
                    }
                }
                if start == cursor {
                    return self.skipped_bucket_at(left, right, false, cursor);
                }
                self.bucket(self.dropped + start as u64, self.dropped + cursor as u64)
                    .or_else(|| {
                        if !self.scheduled_mode {
                            return None;
                        }
                        Some(Bucket {
                            slowest: None,
                            samples: 0,
                            lost: 0,
                            first: self.origin.map_or(SystemTime::UNIX_EPOCH, |origin| {
                                origin
                                    + Duration::from_secs_f64(self.placements[start].position / 1e9)
                            }),
                        })
                    })
            })
            .collect()
    }

    /// Infer skipped worker sends from the last actual schedule's cadence.
    fn skipped_bucket(&self, from: f64, to: f64, expand: bool) -> Option<Bucket> {
        let next = self
            .placements
            .partition_point(|p| self.units(p.position) <= from);
        self.skipped_bucket_at(from, to, expand, next)
    }

    fn skipped_bucket_at(&self, from: f64, to: f64, expand: bool, next: usize) -> Option<Bucket> {
        if !self.scheduled_mode {
            return None;
        }
        let previous = self.placements.get(next.checked_sub(1)?)?;
        let following = self.placements.get(next)?;
        let start = self.units(previous.position);
        let interval = self.units(previous.interval);
        let span = interval.min(1.0);
        let elapsed = (from - start) / interval;
        let ordinal = if expand {
            elapsed.floor()
        } else {
            elapsed.ceil()
        }
        .max(1.0);
        let mut due = start + ordinal * interval;
        if expand && due + span <= from {
            due += interval;
        }
        if due >= to || due >= self.units(following.position) {
            return None;
        }
        Some(Bucket {
            slowest: None,
            samples: 0,
            lost: 0,
            first: self.origin.map_or(SystemTime::UNIX_EPOCH, |origin| {
                origin + Duration::from_secs_f64(self.interval / 1e9).mul_f64(due)
            }),
        })
    }

    #[allow(
        clippy::cast_precision_loss,
        reason = "legacy path slots are bounded time coordinates"
    )]
    pub fn path_change_in(&self, from: f64, to: f64) -> Option<&crate::path::Change> {
        self.path.changes.iter().find(|change| {
            let position = if self.scheduled_mode {
                self.origin.map_or(change.slot as f64, |origin| {
                    change
                        .seen
                        .duration_since(origin)
                        .unwrap_or_default()
                        .as_secs_f64()
                        / (self.interval / 1e9)
                })
            } else {
                change.slot as f64
            };
            position >= from && position < to
        })
    }

    pub fn first_timed_sample(&self) -> Option<(f64, Entry)> {
        self.history
            .iter()
            .zip(&self.placements)
            .find_map(|(entry, placement)| {
                entry.map(|entry| {
                    (
                        self.units(placement.position),
                        entry.expand(self.origin.expect("outcome origin")),
                    )
                })
            })
    }

    /// First retained outcome and its schedule slot, skipping unresolved slots.
    pub fn first_sample(&self) -> Option<(u64, Entry)> {
        self.history
            .iter()
            .zip(&self.placements)
            .find_map(|(entry, placement)| {
                entry.map(|entry| {
                    (
                        placement.slot,
                        entry.expand(self.origin.expect("outcome origin")),
                    )
                })
            })
    }

    pub fn run_stats(&self) -> Stats {
        Stats {
            current: self.current,
            min: self.min,
            max: self.max,
            received: self.received,
            lost: self.lost,
            total: self.total,
            latest: None,
        }
    }

    /// Exact range statistics using the same 128-slot cache as chart buckets.
    pub fn range_stats(&self, from: u64, to: u64) -> Stats {
        let mut from = from.max(self.dropped);
        let to = to.min(self.total_samples());
        let mut stats = Stats::default();
        while from < to {
            let block = from / SUMMARY_SLOTS;
            let boundary = (block + 1) * SUMMARY_SLOTS;
            let end = boundary.min(to);
            if from.is_multiple_of(SUMMARY_SLOTS) && boundary <= to {
                let position =
                    usize::try_from(block % SUMMARY_LEN as u64).expect("bounded ring position");
                if let Some(summary) = self
                    .summaries
                    .get(position)
                    .filter(|summary| summary.index == block)
                {
                    stats.merge(summary.stats);
                }
            } else {
                let start = usize::try_from(from - self.dropped).expect("retained offset");
                let stop = usize::try_from(end - self.dropped).expect("retained offset");
                for (offset, entry) in self.history.range(start..stop).enumerate() {
                    if let Some(entry) = entry {
                        stats.include(from + offset as u64, entry.sample);
                    }
                }
            }
            from = end;
        }
        stats
    }

    /// Aggregates only the visible range, using cached, fully retained blocks
    /// for coarse views and direct deque ranges for the boundary fragments.
    pub fn bucket(&self, from: u64, to: u64) -> Option<Bucket> {
        let mut from = from.max(self.dropped);
        let to = to.min(self.total_samples());
        if to.saturating_sub(from) < SUMMARY_SLOTS {
            return self.raw_bucket(from, to);
        }
        let mut bucket = None;
        while from < to {
            let block = from / SUMMARY_SLOTS;
            let boundary = (block + 1) * SUMMARY_SLOTS;
            let end = boundary.min(to);
            let summary = if from.is_multiple_of(SUMMARY_SLOTS) && boundary <= to {
                let position =
                    usize::try_from(block % SUMMARY_LEN as u64).expect("bounded ring position");
                self.summaries
                    .get(position)
                    .filter(|summary| summary.index == block)
                    .and_then(|summary| summary.bucket)
            } else {
                self.raw_bucket(from, end)
            };
            if let Some(summary) = summary {
                Bucket::merge(&mut bucket, summary);
            }
            from = end;
        }
        bucket
    }

    fn raw_bucket(&self, from: u64, to: u64) -> Option<Bucket> {
        let from = from.max(self.dropped);
        let to = to.min(self.total_samples());
        if from >= to {
            return None;
        }
        let start = usize::try_from(from - self.dropped).expect("retained history offset");
        let end = usize::try_from(to - self.dropped).expect("retained history offset");
        let mut bucket = None;
        for entry in self.history.range(start..end).flatten() {
            Bucket::include(
                &mut bucket,
                entry.expand(self.origin.expect("outcome origin")),
            );
        }
        bucket
    }

    #[cfg(test)]
    pub fn retained_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self.host.capacity()
            + self.history.capacity() * std::mem::size_of::<Option<StoredEntry>>()
            + self.placements.capacity() * std::mem::size_of::<Placement>()
            + self.summaries.capacity() * std::mem::size_of::<SummaryBlock>()
            + self.rtt_baseline.borrow().scratch.capacity() * std::mem::size_of::<Duration>()
    }

    #[cfg(test)]
    pub fn history_allocation(&self) -> (usize, usize) {
        (self.history.len(), self.history.capacity())
    }

    /// Probes with an outcome; in-flight probes are not counted yet.
    pub fn completed(&self) -> u32 {
        self.received + self.lost
    }

    /// Three consecutive completed losses trigger the host drop indicator.
    pub fn drop_age(&self, now: SystemTime) -> Option<DropAge> {
        (self.loss_streak >= 3).then(|| {
            self.last_reply.map_or(DropAge::NeverReplied, |reply| {
                DropAge::SinceReply(now.duration_since(reply).unwrap_or_default())
            })
        })
    }

    pub fn avg(&self) -> Option<Duration> {
        (self.received > 0).then(|| self.total / self.received)
    }

    /// Loss in percent over completed probes.
    pub fn loss_pct(&self) -> Option<f64> {
        (self.completed() > 0).then(|| f64::from(self.lost) * 100.0 / f64::from(self.completed()))
    }

    pub fn address(&self) -> Option<IpAddr> {
        match self.status {
            Status::Running(addr) => Some(addr),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rtt_baseline_ignores_lost_and_pending_probes() {
        let mut state = HostState::new("h".into());
        for slot in 0..10 {
            reply(&mut state, slot * 2, (slot + 1) * 10);
            state.apply(ProbeEvent::Lost {
                seq: 0,
                slot: slot * 2 + 1,
                sent: SystemTime::UNIX_EPOCH + Duration::from_secs(slot * 2 + 1),
            });
        }
        schedule(&mut state, 20, 20_000, 1000);
        assert_eq!(state.rtt_baseline(), Some(Duration::from_millis(55)));
    }

    #[test]
    fn rtt_baseline_even_median_preserves_nanoseconds_without_overflow() {
        for (lower, upper, expected) in [
            (
                Duration::from_nanos(1),
                Duration::from_nanos(3),
                Duration::from_nanos(2),
            ),
            (
                Duration::from_nanos(1),
                Duration::from_nanos(2),
                Duration::from_nanos(1),
            ),
            (Duration::MAX, Duration::MAX, Duration::MAX),
        ] {
            let mut baseline = RttBaseline {
                scratch: [vec![lower; 5], vec![upper; 5]].concat(),
                ..RttBaseline::default()
            };
            assert_eq!(baseline.select_median(), expected);
        }
    }

    #[test]
    fn rtt_baseline_waits_for_ten_retained_replies() {
        let mut state = HostState::new("h".into());
        for slot in 0..9 {
            reply(&mut state, slot, 10);
        }
        assert_eq!(state.rtt_baseline(), None);
        reply(&mut state, 9, 10);
        assert_eq!(state.rtt_baseline(), Some(Duration::from_millis(10)));
    }

    #[test]
    fn rtt_baseline_cache_refreshes_after_new_replies() {
        let mut state = HostState::new("h".into());
        for slot in 0..10 {
            reply(&mut state, slot, (slot + 1) * 10);
        }
        assert_eq!(state.rtt_baseline(), Some(Duration::from_millis(55)));
        assert!(!state.rtt_baseline.borrow().dirty);
        let cache = state.rtt_baseline.borrow().clone();
        let capacity = state.rtt_baseline.borrow().scratch.capacity();
        assert_eq!(state.rtt_baseline(), Some(Duration::from_millis(55)));
        assert_eq!(*state.rtt_baseline.borrow(), cache);
        state.apply(ProbeEvent::Lost {
            seq: 0,
            slot: 10,
            sent: SystemTime::UNIX_EPOCH + Duration::from_secs(10),
        });
        assert!(!state.rtt_baseline.borrow().dirty);
        reply(&mut state, 11, 110);
        assert!(state.rtt_baseline.borrow().dirty);
        assert_eq!(state.rtt_baseline(), Some(Duration::from_millis(60)));
        assert_eq!(state.rtt_baseline.borrow().scratch.capacity(), capacity);
    }

    #[test]
    fn rtt_baseline_cache_refreshes_when_retention_evicts_replies() {
        let mut state = HostState::new("h".into());
        for slot in 0..10 {
            reply(&mut state, slot, 10);
        }
        assert_eq!(state.rtt_baseline(), Some(Duration::from_millis(10)));
        let slot = u64::try_from(HISTORY_LEN).unwrap();
        state.apply(ProbeEvent::Lost {
            seq: 0,
            slot,
            sent: SystemTime::UNIX_EPOCH + Duration::from_secs(slot),
        });
        assert!(state.rtt_baseline.borrow().dirty);
        assert_eq!(state.rtt_baseline(), None);
    }

    #[test]
    fn rtt_baseline_cache_tracks_replaced_outcomes() {
        let mut state = HostState::new("h".into());
        for slot in 0..10 {
            reply(&mut state, slot, (slot + 1) * 10);
        }
        assert_eq!(state.rtt_baseline(), Some(Duration::from_millis(55)));
        reply(&mut state, 0, 200);
        assert_eq!(state.rtt_baseline(), Some(Duration::from_millis(65)));
        assert_eq!(state.rtt_baseline.borrow().replies, 10);
        state.apply(ProbeEvent::Lost {
            seq: 0,
            slot: 0,
            sent: SystemTime::UNIX_EPOCH,
        });
        assert_eq!(state.rtt_baseline(), None);
        assert_eq!(state.rtt_baseline.borrow().replies, 9);
        reply(&mut state, 0, 10);
        assert_eq!(state.rtt_baseline(), Some(Duration::from_millis(55)));
    }

    #[test]
    fn plain_statistics_remain_precise_without_history_growth() {
        let mut state = HostState::new("example".into());
        let retained = state.retained_bytes();
        let mut total = Duration::ZERO;
        state.apply_plain(ProbeEvent::Resolved("127.0.0.1".parse().unwrap()));
        for slot in 0..100_000 {
            let event = if slot % 5 == 0 {
                ProbeEvent::Lost {
                    seq: 0,
                    slot,
                    sent: SystemTime::UNIX_EPOCH,
                }
            } else {
                let rtt = Duration::from_nanos(slot % 11 + 1);
                total += rtt;
                ProbeEvent::Reply {
                    seq: 0,
                    slot,
                    rtt,
                    sent: SystemTime::UNIX_EPOCH,
                }
            };
            state.apply_plain(event);
        }
        state.apply_plain(ProbeEvent::Finished);
        assert_eq!((state.received, state.lost), (80_000, 20_000));
        assert_eq!(state.loss_pct(), Some(20.0));
        assert_eq!(state.min, Some(Duration::from_nanos(1)));
        assert_eq!(state.max, Some(Duration::from_nanos(11)));
        assert_eq!(state.avg(), Some(total / 80_000));
        assert!(state.finished);
        assert_eq!(state.retained_bytes(), retained);
    }

    #[test]
    fn folds_replies_and_losses() {
        let mut state = HostState::new("example".into());
        for (seq, ms) in [(1, 30), (2, 10), (3, 50)] {
            state.apply(ProbeEvent::Reply {
                seq,
                slot: u64::from(seq),
                rtt: Duration::from_millis(ms),
                sent: SystemTime::UNIX_EPOCH,
            });
        }
        state.apply(ProbeEvent::Lost {
            seq: 4,
            slot: 4,
            sent: SystemTime::UNIX_EPOCH,
        });
        assert_eq!(state.current, Some(Duration::from_millis(50)));
        assert_eq!(state.min, Some(Duration::from_millis(10)));
        assert_eq!(state.max, Some(Duration::from_millis(50)));
        assert_eq!(state.avg(), Some(Duration::from_millis(30)));
        assert_eq!((state.received, state.completed()), (3, 4));
        assert_eq!(state.loss_pct(), Some(25.0));
        assert_eq!(
            state
                .history
                .back()
                .copied()
                .flatten()
                .map(|entry| entry.sample),
            Some(Sample::Lost)
        );
    }

    #[test]
    fn history_is_indexed_by_slot_not_arrival() {
        let mut state = HostState::new("late".into());
        let at = |slot| SystemTime::UNIX_EPOCH + Duration::from_secs(slot);
        // Resolved late: first probe at slot 3. Slot 4 is lost, but its loss is
        // only known after slot 5's reply arrived.
        for (slot, ms) in [(3, 10), (5, 12)] {
            state.apply(ProbeEvent::Reply {
                seq: 0,
                slot,
                rtt: Duration::from_millis(ms),
                sent: at(slot),
            });
        }
        state.apply(ProbeEvent::Lost {
            seq: 0,
            slot: 4,
            sent: at(4),
        });
        let samples: Vec<_> = (0..6)
            .map(|slot| state.entry_at(slot).map(|e| e.sample))
            .collect();
        assert_eq!(
            samples,
            vec![
                None,
                None,
                None,
                Some(Sample::Reply(Duration::from_millis(10))),
                Some(Sample::Lost),
                Some(Sample::Reply(Duration::from_millis(12))),
            ]
        );
        assert_eq!(state.total_samples(), 6);
    }

    fn reply(state: &mut HostState, slot: u64, ms: u64) {
        state.apply(ProbeEvent::Reply {
            seq: 0,
            slot,
            rtt: Duration::from_millis(ms),
            sent: SystemTime::UNIX_EPOCH + Duration::from_secs(slot),
        });
    }

    #[test]
    fn coarse_ranges_include_late_losses_and_replace_extrema() {
        let mut state = HostState::new("h".into());
        for slot in (0..256).rev() {
            if slot != 127 {
                reply(&mut state, slot, 5);
            }
        }
        reply(&mut state, 128, 999);
        state.apply(ProbeEvent::Lost {
            seq: 0,
            slot: 127,
            sent: SystemTime::UNIX_EPOCH - Duration::from_secs(1),
        });
        assert_eq!(
            state.bucket(0, 256),
            Some(Bucket {
                slowest: Some(Duration::from_millis(999)),
                samples: 256,
                lost: 1,
                first: SystemTime::UNIX_EPOCH - Duration::from_secs(1),
            }),
        );
        reply(&mut state, 128, 4);
        assert_eq!(
            state.bucket(1, 255),
            Some(Bucket {
                slowest: Some(Duration::from_millis(5)),
                samples: 254,
                lost: 1,
                first: SystemTime::UNIX_EPOCH - Duration::from_secs(1),
            }),
        );
        assert_eq!(
            state.bucket(128, 129).unwrap().slowest,
            Some(Duration::from_millis(4)),
        );
    }

    #[test]
    fn coarse_ranges_exclude_trimmed_extrema_and_stale_ring_blocks() {
        let mut state = HostState::new("h".into());
        reply(&mut state, 0, 999);
        reply(&mut state, 1, 7);
        reply(&mut state, 127, 8);
        reply(&mut state, 128, 9);
        reply(&mut state, 86_400, 6);
        assert_eq!(
            state.bucket(0, 86_401),
            Some(Bucket {
                slowest: Some(Duration::from_millis(9)),
                samples: 4,
                lost: 0,
                first: SystemTime::UNIX_EPOCH + Duration::from_secs(1),
            }),
        );
        // The old first block and this block share a cache ring position.
        reply(&mut state, 128 * SUMMARY_LEN as u64, 3);
        assert_eq!(state.bucket(128, 256), None);
        assert_eq!(
            state
                .bucket(128 * SUMMARY_LEN as u64, u64::MAX)
                .unwrap()
                .samples,
            1,
        );
        reply(&mut state, 1_000_000, 2);
        assert_eq!(
            state.bucket(0, u64::MAX),
            Some(Bucket {
                slowest: Some(Duration::from_millis(2)),
                samples: 1,
                lost: 0,
                first: SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000),
            }),
        );
    }

    #[test]
    fn cached_range_stats_match_independent_rescans() {
        let mut state = HostState::new("h".into());
        for slot in 0..4096 {
            if slot % 7 == 0 {
                continue;
            }
            if slot % 11 == 0 {
                state.apply(ProbeEvent::Lost {
                    seq: 0,
                    slot,
                    sent: SystemTime::UNIX_EPOCH,
                });
            } else {
                reply(&mut state, slot, slot % 97 + 1);
            }
        }
        reply(&mut state, 130, 999);
        reply(&mut state, 130, 3);
        let mut seed = 42_u64;
        for trimmed in [false, true] {
            if trimmed {
                reply(&mut state, 88_000, 4);
            }
            for _ in 0..128 {
                seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
                let a = seed % 4200;
                seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
                let b = seed % 4200;
                let (from, to) = (a.min(b), a.max(b));
                let mut expected = Stats::default();
                for (offset, entry) in state.history.iter().enumerate() {
                    let slot = state.dropped + offset as u64;
                    if !(from..to).contains(&slot) {
                        continue;
                    }
                    if let Some(entry) = entry {
                        expected.latest = Some(slot);
                        match entry.sample {
                            Sample::Lost => {
                                expected.lost += 1;
                                expected.current = None;
                            }
                            Sample::Reply(rtt) => {
                                expected.received += 1;
                                expected.total += rtt;
                                expected.current = Some(rtt);
                                expected.min = Some(expected.min.map_or(rtt, |min| min.min(rtt)));
                                expected.max = Some(expected.max.map_or(rtt, |max| max.max(rtt)));
                            }
                        }
                    }
                }
                assert_eq!(
                    state.range_stats(from, to),
                    expected,
                    "{from}..{to}, trimmed={trimmed}"
                );
                assert_eq!(state.range_stats(from, to).avg(), expected.avg());
            }
        }
        assert_eq!(
            state.range_stats(0, u64::MAX).max,
            Some(Duration::from_millis(97))
        );
    }

    fn schedule(state: &mut HostState, slot: u64, position_ms: u64, interval_ms: u64) {
        state.apply(ProbeEvent::Scheduled {
            slot,
            position: Duration::from_millis(position_ms),
            interval: Duration::from_millis(interval_ms),
        });
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "these schedule positions are exact integer or binary-fraction base coordinates"
    )]
    fn mixed_rates_match_outcomes_and_stats_by_deadline_not_ordinal() {
        let mut state = HostState::new("h".into());
        state.set_interval(Duration::from_millis(500));
        for (slot, position, interval) in [(7, 0, 1000), (8, 1000, 125), (9, 1125, 125)] {
            schedule(&mut state, slot, position, interval);
        }
        reply(&mut state, 9, 30);
        reply(&mut state, 7, 10);
        state.apply(ProbeEvent::Lost {
            seq: 0,
            slot: 8,
            sent: SystemTime::UNIX_EPOCH,
        });
        let summary = state.time_range_stats(2.0, 2.5);
        assert_eq!((summary.received, summary.lost), (1, 1));
        assert_eq!(summary.current, Some(Duration::from_millis(30)));
        assert_eq!(summary.avg(), Some(Duration::from_millis(30)));
        assert_eq!(state.time_range_stats(1.0, 2.0).completed(), 0);
        assert_eq!(state.time_bucket(1.0, 2.0, true), None);
        assert_eq!(state.oldest_position(), 0.0);
        assert_eq!(state.latest_position(), 2.5);
        assert_eq!(state.sent(), 3);
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "the retained boundary is an exact integer base coordinate"
    )]
    fn scheduled_retention_counts_actual_probes_and_ignores_expired_outcomes() {
        let mut state = HostState::new("h".into());
        for index in 0..86_402 {
            let slot = index * 10;
            let position = index * 2000;
            schedule(&mut state, slot, position, 2000);
            state.apply(ProbeEvent::Reply {
                seq: 0,
                slot,
                rtt: Duration::from_millis(if index < 2 { 999 } else { 5 }),
                sent: SystemTime::UNIX_EPOCH + Duration::from_millis(position),
            });
        }
        reply(&mut state, 0, 888);
        assert_eq!(state.history_allocation(), (86_400, 86_400));
        assert_eq!(state.entry_at(0), None);
        assert_eq!(state.entry_at(10), None);
        assert_eq!(state.oldest_position(), 4.0);
        let retained = state.time_range_stats(0.0, state.latest_position());
        assert_eq!(retained.received, 86_400);
        assert_eq!(retained.max, Some(Duration::from_millis(5)));
        assert_eq!(
            state
                .time_bucket(0.0, state.latest_position(), false)
                .unwrap()
                .samples,
            86_400
        );
        assert_eq!(state.run_stats().max, Some(Duration::from_millis(999)));
    }

    #[test]
    fn retained_path_changes_follow_actual_probe_eviction_across_rate_changes() {
        for (initial_ms, changed_ms) in [(60_000, 1_000), (1_000, 60_000)] {
            let mut state = HostState::new("h".into());
            let path = |text: &str, slot| ProbeEvent::Path {
                note: Some(crate::path::Note {
                    text: text.into(),
                    endpoint: None,
                    interface: None,
                    source: None,
                }),
                slot,
                seen: SystemTime::UNIX_EPOCH,
            };
            schedule(&mut state, 0, 0, initial_ms);
            state.apply(path("relay", 0));
            schedule(&mut state, 1, initial_ms, changed_ms);
            state.apply(path("direct", 1));
            // A stall skips ordinal slots, but does not evict actual probes.
            schedule(
                &mut state,
                86_401,
                initial_ms + changed_ms * 86_400,
                changed_ms,
            );
            state.apply(path("direct", 86_401));
            assert_eq!(state.path.changes.front().unwrap().slot, 1);
            for index in 3..86_400 {
                schedule(
                    &mut state,
                    86_399 + index,
                    initial_ms + changed_ms * (86_398 + index),
                    changed_ms,
                );
            }
            schedule(
                &mut state,
                172_799,
                initial_ms + changed_ms * 172_798,
                changed_ms,
            );
            assert_eq!(state.path.changes.front().unwrap().slot, 1);
            schedule(
                &mut state,
                172_800,
                initial_ms + changed_ms * 172_799,
                changed_ms,
            );
            assert!(state.path.changes.is_empty());
        }
    }

    #[test]
    fn pending_deadlines_and_rate_changes_do_not_create_false_due_gaps() {
        let mut state = HostState::new("h".into());
        schedule(&mut state, 0, 0, 1000);
        schedule(&mut state, 1, 250, 250);
        schedule(&mut state, 2, 500, 250);
        reply(&mut state, 0, 1);
        reply(&mut state, 1, 2);
        assert_eq!(state.time_range_stats(0.25, 0.5).received, 1);
        assert_eq!(state.time_bucket(0.25, 0.5, true).unwrap().samples, 1);
        assert_eq!(state.time_bucket(0.5, 0.75, true).unwrap().samples, 0);
        assert_eq!(state.time_bucket(0.75, 1.0, true), None);
    }

    #[test]
    fn plain_scheduled_events_never_allocate_retained_history() {
        let mut state = HostState::new("h".into());
        let before = state.retained_bytes();
        for slot in 0..1000 {
            state.apply_plain(ProbeEvent::Scheduled {
                slot,
                position: Duration::from_millis(slot * 125),
                interval: Duration::from_millis(125),
            });
        }
        assert_eq!(state.sent(), 1000);
        assert_eq!(state.completed(), 0);
        assert_eq!(state.retained_bytes(), before);
    }

    #[test]
    fn worker_stalls_mark_due_deadlines_not_sparse_interstitial_cells() {
        let mut state = HostState::new("h".into());
        schedule(&mut state, 0, 0, 2000);
        schedule(&mut state, 1, 6000, 2000);
        reply(&mut state, 0, 1);
        reply(&mut state, 1, 2);
        assert_eq!(state.time_bucket(1.0, 2.0, false), None);
        assert_eq!(state.time_bucket(2.0, 3.0, false).unwrap().samples, 0);
        assert_eq!(state.time_bucket(3.0, 4.0, false), None);
        assert_eq!(state.time_bucket(4.0, 5.0, false).unwrap().samples, 0);
        assert_eq!(state.time_bucket(5.0, 6.0, false), None);
        assert_eq!(state.time_range_stats(1.0, 6.0).completed(), 0);
        assert_eq!(state.sent(), 2);
    }

    #[test]
    #[allow(clippy::cast_precision_loss, reason = "test sample counts are small")]
    fn mixed_rate_cached_windows_match_scheduled_outcome_rescans() {
        let mut state = HostState::new("h".into());
        let mut position = 0_u64;
        let mut expected = Vec::new();
        for slot in 0..1024 {
            let interval = if slot < 256 {
                2000
            } else if slot < 768 {
                125
            } else {
                4000
            };
            schedule(&mut state, slot, position, interval);
            let sample = if slot % 11 == 0 {
                Sample::Lost
            } else {
                Sample::Reply(Duration::from_millis(slot % 97 + 1))
            };
            expected.push((
                slot,
                position as f64 / 1000.0,
                interval.min(1000) as f64 / 1000.0,
                sample,
            ));
            position += interval;
        }
        // Completion order cannot move outcomes into the wrong rate segment.
        for (slot, _, _, sample) in expected.iter().rev() {
            state.apply(match sample {
                Sample::Lost => ProbeEvent::Lost {
                    seq: 0,
                    slot: *slot,
                    sent: SystemTime::UNIX_EPOCH,
                },
                Sample::Reply(rtt) => ProbeEvent::Reply {
                    seq: 0,
                    slot: *slot,
                    rtt: *rtt,
                    sent: SystemTime::UNIX_EPOCH,
                },
            });
        }
        for (from, to) in [
            (0.5, 500.25),
            (511.5, 576.125),
            (550.375, 1300.5),
            (0.0, 1600.0),
        ] {
            let mut summary = Stats::default();
            for (slot, at, span, sample) in &expected {
                if *at < to && at + span > from {
                    summary.include(*slot, *sample);
                }
            }
            let actual = state.time_range_stats(from, to);
            assert_eq!(actual, summary, "{from}..{to}");
            assert_eq!(actual.avg(), summary.avg());
            assert_eq!(actual.loss_pct(), summary.loss_pct());
        }
    }

    #[test]
    fn timed_path_changes_follow_elapsed_time_instead_of_probe_ordinals() {
        let mut state = HostState::new("h".into());
        schedule(&mut state, 100, 0, 2000);
        state.apply(ProbeEvent::Reply {
            seq: 0,
            slot: 100,
            sent: SystemTime::UNIX_EPOCH,
            rtt: Duration::from_millis(1),
        });
        state.path.changes.push_back(crate::path::Change {
            slot: 999,
            seen: SystemTime::UNIX_EPOCH + Duration::from_millis(2250),
            old: "old".into(),
            new: "new".into(),
        });
        assert_eq!(state.path_change_in(2.0, 2.5).unwrap().new, "new");
        assert_eq!(state.path_change_in(999.0, 1000.0), None);
    }
}
