//! Restored prior sessions as one connected history row above the live chart:
//! earlier runs, compressed off gaps, then the whole current run up to now.
//!
//! The row reads `HostState::prior_sessions` only, so restored samples never
//! reach live statistics. It is not interactive: the live chart and its
//! overview keep their geometry, hover, zoom and pan. Each old run and the
//! current run scale their RTT stems independently.

use std::cell::RefCell;
use std::time::{Duration, SystemTime};

use unicode_width::UnicodeWidthStr;

use crate::history::{HistoricalSample, HistoricalSession};
use crate::stats::{Bucket, HostState, Sample};
use crate::timeline;

use super::raster::{braille_stems, main_reply_role, render_sparkline, Scale};
use super::{span, Line, Role, Tint, RULE};

/// Runs separated by less off time than this (or overlapping) join without a
/// gap. Fixed rather than derived from the probe interval, so adjusting the
/// rate never changes how recorded history reads.
const JOIN_BELOW: Duration = Duration::from_secs(5);
/// Each restored run is reduced once to at most this many time blocks; the
/// row never draws more subcells per run.
const BLOCKS: usize = 1024;
/// Every off gap gets the same width, whatever its duration.
const GAP_WIDTH: usize = 5;
const MIN_SEGMENT: usize = 4;
/// The current run always keeps at least this many cells of the row.
const MIN_LIVE: usize = 8;

/// Restored history prepared once at startup: joined runs reduced to fixed
/// time blocks, plus the last drawn prior part of the row. History is
/// immutable, so only a new width or current-run start redraws it.
#[derive(Debug, Clone, Default)]
pub struct History {
    runs: Vec<Run>,
    /// Median restored reply, so old-run colors never follow live data.
    baseline: Option<Duration>,
    cache: RefCell<Option<Prefix>>,
    #[cfg(test)]
    projections: std::cell::Cell<usize>,
}

impl PartialEq for History {
    fn eq(&self, other: &Self) -> bool {
        self.runs == other.runs && self.baseline == other.baseline
    }
}

#[derive(Debug, Clone, PartialEq)]
struct Run {
    start: SystemTime,
    /// Monotonic time the run covers, from its first offset to one interval
    /// after its last probe.
    covered: Duration,
    blocks: Box<[Option<Bucket>]>,
}

#[derive(Debug, Clone)]
struct Prefix {
    budget: usize,
    final_gap: bool,
    line: Line,
    used: usize,
}

impl History {
    pub fn is_empty(&self) -> bool {
        self.runs.is_empty()
    }

    pub fn len(&self) -> usize {
        self.runs.len()
    }

    /// The prior runs and the off gaps between them within `budget` cells,
    /// reserving room for a `final_gap` before the current run, and their
    /// width. Independent of the clock, so it stays cached from startup on.
    fn prefix(&self, budget: usize, final_gap: bool) -> (Line, usize) {
        let mut cache = self.cache.borrow_mut();
        if let Some(prefix) = cache
            .as_ref()
            .filter(|prefix| prefix.budget == budget && prefix.final_gap == final_gap)
        {
            return (prefix.line.clone(), prefix.used);
        }
        #[cfg(test)]
        self.projections.set(self.projections.get() + 1);
        let mut line = Vec::new();
        let mut used = 0;
        for piece in pieces(&self.runs, budget, final_gap) {
            match piece {
                Piece::Run(run, columns) => {
                    draw_run(&mut line, &run.cells(columns), self.baseline);
                    used += columns;
                }
                Piece::Off(off) => {
                    push(&mut line, Role::Dim, &gap_label(off));
                    used += GAP_WIDTH;
                }
            }
        }
        *cache = Some(Prefix {
            budget,
            final_gap,
            line: line.clone(),
            used,
        });
        (line, used)
    }
}

impl Run {
    /// Aggregates samples by monotonic offset; wall-clock `sent` only labels
    /// them, so a clock step inside a run never reorders it.
    fn of(session: &HistoricalSession) -> Self {
        let covered = covered(session);
        let count = session.samples.len().min(BLOCKS);
        let mut blocks = vec![None; count];
        let span = covered.as_secs_f64().max(1e-3);
        for sample in &session.samples {
            let index = cells_of(sample.offset.as_secs_f64() / span, count).min(count - 1);
            include(&mut blocks[index], sample);
        }
        Self {
            start: session.start,
            covered,
            blocks: blocks.into(),
        }
    }

    fn end(&self) -> SystemTime {
        self.start + self.covered
    }

    fn seconds(&self) -> f64 {
        self.covered.as_secs_f64().max(1e-3)
    }

    /// Two time-ordered subcells per column; empty ones never read as loss.
    fn cells(&self, columns: usize) -> Vec<Option<Bucket>> {
        let count = columns * 2;
        let mut cells = vec![None; count];
        for (index, block) in self.blocks.iter().enumerate() {
            if let Some(block) = block {
                let cell = &mut cells[index * count / self.blocks.len()];
                let merged = cell.get_or_insert(Bucket {
                    samples: 0,
                    lost: 0,
                    ..*block
                });
                merged.samples += block.samples;
                merged.lost += block.lost;
                merged.slowest = merged.slowest.max(block.slowest);
                merged.first = merged.first.min(block.first);
            }
        }
        cells
    }
}

fn include(bucket: &mut Option<Bucket>, sample: &HistoricalSample) {
    let bucket = bucket.get_or_insert(Bucket {
        slowest: None,
        samples: 0,
        lost: 0,
        first: sample.sent,
    });
    bucket.samples += 1;
    match sample.sample {
        Sample::Lost => bucket.lost += 1,
        Sample::Reply(rtt) => bucket.slowest = bucket.slowest.max(Some(rtt)),
    }
}

pub(super) fn has_stream(host: &HostState) -> bool {
    !host.prior_sessions.is_empty()
}

/// Monotonic time a stored session covers: samples are ordered by offset,
/// so it ends one interval after its last probe.
fn covered(session: &HistoricalSession) -> Duration {
    session
        .samples
        .last()
        .map_or(Duration::ZERO, |last| last.offset + session.interval)
}

fn session_end(session: &HistoricalSession) -> SystemTime {
    session.start + covered(session)
}

/// Prepares restored sessions (sorted by start) once for drawing.
pub(crate) fn restore(sessions: Vec<HistoricalSession>) -> History {
    let runs = join(sessions);
    let mut replies: Vec<Duration> = runs
        .iter()
        .flat_map(|run| &run.samples)
        .filter_map(|sample| match sample.sample {
            Sample::Reply(rtt) => Some(rtt),
            Sample::Lost => None,
        })
        .collect();
    let middle = replies.len() / 2;
    let baseline = (!replies.is_empty()).then(|| *replies.select_nth_unstable(middle).1);
    History {
        runs: runs.iter().map(Run::of).collect(),
        baseline,
        ..History::default()
    }
}

/// Joins sessions that overlap or are less than `JOIN_BELOW` apart into one
/// run. A run's end is the furthest end of any session it contains, so a
/// short session nested in a longer one never ends the run early. Joined
/// samples keep their offsets relative to the run's start.
fn join(sessions: Vec<HistoricalSession>) -> Vec<HistoricalSession> {
    let mut runs: Vec<(HistoricalSession, SystemTime, bool)> = Vec::with_capacity(sessions.len());
    for session in sessions {
        let end = session_end(&session);
        match runs.last_mut() {
            Some((run, run_end, merged)) if off_gap(*run_end, session.start).is_none() => {
                let shift = session.start.duration_since(run.start).unwrap_or_default();
                run.samples
                    .extend(session.samples.into_iter().map(|sample| HistoricalSample {
                        offset: sample.offset + shift,
                        ..sample
                    }));
                *run_end = (*run_end).max(end);
                *merged = true;
            }
            _ => runs.push((session, end, false)),
        }
    }
    runs.into_iter()
        .map(|(mut run, end, merged)| {
            if merged {
                // Keep `session_end` at the furthest covered end.
                run.samples.sort_by_key(|sample| sample.offset);
                let last = run
                    .samples
                    .last()
                    .map_or(run.start, |sample| run.start + sample.offset);
                run.interval = end.duration_since(last).unwrap_or_default();
            }
            run
        })
        .collect()
}

/// Off time from `end` to `next`, or `None` when the runs join.
fn off_gap(end: SystemTime, next: SystemTime) -> Option<Duration> {
    next.duration_since(end)
        .ok()
        .filter(|off| *off >= JOIN_BELOW)
}

/// `fraction` (0..=1) of `count` cells, rounded down.
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    reason = "row widths are a few hundred cells and the fraction is clamped"
)]
fn cells_of(fraction: f64, count: usize) -> usize {
    (fraction.clamp(0.0, 1.0) * count as f64).floor() as usize
}

enum Piece<'a> {
    Run(&'a Run, usize),
    Off(Duration),
}

/// The most recent runs that fit `budget`, each sized by its duration but
/// never wider than one Braille stem per block, with off gaps between them.
/// Runs never overlap after `join`, so only the next start bounds a gap.
/// `final_gap` reserves the width of the gap before the current run.
fn pieces(runs: &[Run], budget: usize, final_gap: bool) -> Vec<Piece<'_>> {
    let shown = runs.len().min(budget / (MIN_SEGMENT + GAP_WIDTH));
    let runs = &runs[runs.len() - shown..];
    let off = |index: usize| {
        let next = runs.get(index + 1)?;
        off_gap(runs[index].end(), next.start)
    };
    let gaps = (0..shown).filter(|index| off(*index).is_some()).count()
        + usize::from(final_gap && shown > 0);
    let extra = budget.saturating_sub(shown * MIN_SEGMENT + gaps * GAP_WIDTH);
    let total: f64 = runs.iter().map(Run::seconds).sum();
    let mut pieces = Vec::with_capacity(shown + gaps);
    for (index, run) in runs.iter().enumerate() {
        let share = cells_of(run.seconds() / total, extra);
        let cap = run.blocks.len().div_ceil(2).max(MIN_SEGMENT);
        pieces.push(Piece::Run(run, (MIN_SEGMENT + share).min(cap)));
        if let Some(off) = off(index) {
            pieces.push(Piece::Off(off));
        }
    }
    pieces
}

fn push(line: &mut Line, role: Role, text: &str) {
    match line.last_mut() {
        Some(previous) if previous.role == role && previous.tint == Tint::None => {
            previous.text.push_str(text);
        }
        _ => line.push(span(role, text)),
    }
}

/// One-row Braille stems colored like the live chart, scaled to this run
/// alone. Compression packs many probes per glyph, so any loss colors the
/// glyph rather than hiding behind a reply in the same cell.
fn draw_run(line: &mut Line, cells: &[Option<Bucket>], baseline: Option<Duration>) {
    let scale = Scale::of(
        cells
            .iter()
            .filter_map(|cell| cell.and_then(|bucket| bucket.slowest)),
    );
    for pair in cells.chunks(2) {
        let side = |index: usize| pair.get(index).copied().flatten();
        let units: [usize; 2] = std::array::from_fn(|index| {
            side(index)
                .and_then(|bucket| bucket.slowest)
                .map_or(0, |rtt| scale.units(rtt.as_secs_f64(), 4))
        });
        let failures: [usize; 2] = std::array::from_fn(|index| {
            usize::from(side(index).is_some_and(|bucket| bucket.lost > 0))
        });
        let role = if failures.contains(&1) {
            Role::Bad
        } else {
            main_reply_role(pair, units, baseline)
        };
        let glyph = braille_stems(if units == [0, 0] { failures } else { units });
        push(line, role, glyph.encode_utf8(&mut [0; 4]));
    }
}

/// Exactly `width` cells: prior runs and their off gaps, then the current
/// run's whole overview up to now.
fn stream(host: &HostState, now: SystemTime, width: usize) -> Line {
    // The run origin never moves when retention evicts early samples.
    let current_start = host.run_origin().unwrap_or(now);
    let budget = (width / 2).min(width.saturating_sub(MIN_LIVE));
    let final_gap = host
        .prior_sessions
        .runs
        .last()
        .and_then(|run| off_gap(run.end(), current_start));
    let (mut line, mut used) = host.prior_sessions.prefix(budget, final_gap.is_some());
    if let Some(off) = final_gap.filter(|_| used > 0) {
        push(&mut line, Role::Dim, &gap_label(off));
        used += GAP_WIDTH;
    }
    let run_width = width.saturating_sub(used);
    if host.history_is_empty() {
        if run_width >= 8 {
            push(&mut line, Role::Dim, "probing…");
            used += 8;
        }
    } else {
        let grid = timeline::overview(host, run_width, None);
        let cells = host.time_buckets(grid.start, grid.end, run_width * 2);
        let (mut rows, _) = render_sparkline(host, grid, &cells, 1, None, None);
        let run = rows.pop().unwrap_or_default();
        used += run.iter().map(|span| span.text.width()).sum::<usize>();
        line.extend(run);
    }
    if used < width {
        push(&mut line, Role::Plain, &" ".repeat(width - used));
    }
    line
}

/// `╌3h╌╌`: dashes say "off", the label says for how long.
fn gap_label(off: Duration) -> String {
    format!("╌{:╌^3}╌", fmt_off(off))
}

/// At most three cells, so every gap has the same width. Retention keeps
/// gaps within days; longer ones saturate.
fn fmt_off(value: Duration) -> String {
    match value.as_secs() {
        secs @ 0..60 => format!("{secs}s"),
        secs @ 60..3_600 => format!("{}m", secs / 60),
        secs @ 3_600..360_000 => format!("{}h", secs / 3_600),
        secs => format!("{}d", (secs / 86_400).min(99)),
    }
}

/// The history line: `RULE`, `indent` blank cells, then `width` cells of
/// stream plus the longest caption that leaves two thirds to the stream.
pub(super) fn line(host: &HostState, now: SystemTime, indent: usize, width: usize) -> Option<Line> {
    if !has_stream(host) {
        return None;
    }
    let runs = match host.prior_sessions.len() {
        1 => "1 prior run".to_string(),
        n => format!("{n} prior runs"),
    };
    let label = [
        format!("history · {runs} · off gaps not to scale"),
        format!("history · {runs}"),
        "history".to_string(),
    ]
    .into_iter()
    .find(|text| text.width() < width / 3)
    .unwrap_or_default();
    let mut line = vec![
        span(Role::Rule, RULE),
        span(Role::Plain, " ".repeat(indent)),
    ];
    line.extend(stream(
        host,
        now,
        width - label.width() - usize::from(!label.is_empty()),
    ));
    if !label.is_empty() {
        line.push(span(Role::Plain, " "));
        line.push(span(Role::Dim, label));
    }
    Some(line)
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, SystemTime};

    use unicode_width::UnicodeWidthStr;

    use super::super::tests::{t0, LIVE};
    use super::super::{frame, plain, Layout, Timeline};
    use super::*;
    use crate::probe::ProbeEvent;

    fn session(start: SystemTime, rtts_ms: &[Option<u64>]) -> HistoricalSession {
        HistoricalSession {
            id: "session".into(),
            start,
            interval: Duration::from_secs(1),
            samples: rtts_ms
                .iter()
                .zip(0..)
                .map(|(rtt, index)| HistoricalSample {
                    sent: start + Duration::from_secs(index),
                    offset: Duration::from_secs(index),
                    sample: rtt.map_or(Sample::Lost, |ms| Sample::Reply(Duration::from_millis(ms))),
                })
                .collect(),
        }
    }

    fn with_live(mut host: HostState, live: &[u64]) -> HostState {
        host.apply(ProbeEvent::Resolved("192.0.2.1".parse().unwrap()));
        for (ms, index) in live.iter().zip(0..) {
            host.apply(ProbeEvent::Reply {
                seq: u16::try_from(index).unwrap(),
                slot: index,
                rtt: Duration::from_millis(*ms),
                sent: t0() + Duration::from_secs(index),
            });
        }
        host
    }

    /// Two prior runs, off for 3h between them and 20m before a live run
    /// starting at t0; the recent run has one lost probe.
    fn host(name: &str, live: &[u64]) -> HostState {
        let old: Vec<_> = (0..60).map(|i| Some(10 + i % 7)).collect();
        let mut recent: Vec<_> = (0..40).map(|i| Some(12 + i % 5)).collect();
        recent[10] = None;
        let recent_start = t0() - Duration::from_secs(20 * 60 + 40);
        let mut host = HostState::new(name.into());
        host.prior_sessions = restore(vec![
            session(recent_start - Duration::from_mins(181), &old),
            session(recent_start, &recent),
        ]);
        with_live(host, live)
    }

    fn timeline() -> Timeline {
        Timeline {
            now: t0() + Duration::from_secs(5),
            ..LIVE
        }
    }

    fn text(line: &Line) -> String {
        line.iter().map(|span| span.text.as_str()).collect()
    }

    fn width(line: &Line) -> usize {
        line.iter().map(|span| span.text.width()).sum()
    }

    #[test]
    fn gap_labels_keep_a_fixed_width() {
        for secs in [0, 59, 60, 3_599, 3_600, 359_999, 360_000, u64::MAX / 2] {
            let label = gap_label(Duration::from_secs(secs));
            assert_eq!(label.width(), GAP_WIDTH, "{label}");
        }
        assert_eq!(gap_label(Duration::from_hours(3)), "╌3h╌╌");
        assert_eq!(gap_label(Duration::from_mins(20)), "╌20m╌");
    }

    #[test]
    fn long_gaps_connect_old_runs_and_the_live_run() {
        let host = host("host-a", &[10, 30, 20]);
        let line = stream(&host, t0() + Duration::from_secs(3), 60);
        assert_eq!(width(&line), 60);
        let text = text(&line);
        let between = text.find("╌3h╌╌").expect(&text);
        let to_live = text.find("╌20m╌").expect(&text);
        assert!(between < to_live, "{text}");
        assert!(
            line.iter().any(|span| span.role == Role::Bad),
            "old loss stays red"
        );
        let after_gap = &text[to_live + "╌20m╌".len()..];
        assert!(
            after_gap
                .chars()
                .next()
                .is_some_and(|c| ('\u{2801}'..='\u{28ff}').contains(&c)),
            "the live run starts right after the gap: {text}"
        );
    }

    #[test]
    fn gaps_under_five_seconds_and_overlaps_join_seamlessly() {
        // Ends at t0-56s; next starts 4s later and overlaps the third run,
        // which ends 3s before the live run.
        let first = session(t0() - Duration::from_secs(80), &[Some(10); 24]);
        let second = session(t0() - Duration::from_secs(52), &[Some(11); 30]);
        let third = session(t0() - Duration::from_secs(25), &[Some(12); 22]);
        let mut host = HostState::new("host-a".into());
        host.prior_sessions = restore(vec![first, second, third]);
        assert_eq!(host.prior_sessions.len(), 1);
        let host = with_live(host, &[10, 11]);
        let line = stream(&host, t0() + Duration::from_secs(2), 60);
        assert_eq!(width(&line), 60);
        let text = text(&line);
        assert!(!text.contains('╌') && !text.contains("0s"), "{text}");
    }

    #[test]
    fn exactly_five_seconds_off_is_a_gap() {
        let end = t0() - Duration::from_secs(5);
        let mut host = HostState::new("host-a".into());
        host.prior_sessions = restore(vec![session(
            end - Duration::from_secs(20),
            &[Some(10); 20],
        )]);
        let host = with_live(host, &[10]);
        let text = text(&stream(&host, t0() + Duration::from_secs(1), 40));
        assert!(text.contains("╌5s╌╌"), "{text}");
        assert_eq!(off_gap(end, t0() - Duration::from_millis(1)), None);
        assert_eq!(
            off_gap(end, end - Duration::from_secs(1)),
            None,
            "overlap joins"
        );
    }

    #[test]
    fn nested_sessions_end_at_the_furthest_covered_time() {
        // A covers 0–10s; B (1–2s) nests inside it; C starts at 9s. Only the
        // immediate predecessor (B) would wrongly put a 7s gap before C.
        let base = t0() - Duration::from_mins(1);
        let a = session(base, &[Some(10); 10]);
        let b = session(base + Duration::from_secs(1), &[Some(20)]);
        let c = session(base + Duration::from_secs(9), &[Some(30)]);
        let runs = join(vec![a.clone(), b.clone(), c.clone()]);
        assert_eq!(runs.len(), 1);
        let offsets: Vec<_> = runs[0]
            .samples
            .iter()
            .map(|sample| sample.offset.as_secs())
            .collect();
        assert_eq!(offsets, [0, 1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9]);
        assert_eq!(session_end(&runs[0]), base + Duration::from_secs(10));
        let mut host = HostState::new("host-a".into());
        host.prior_sessions = restore(vec![a, b, c]);
        let host = with_live(host, &[10]);
        let text = text(&stream(&host, t0() + Duration::from_secs(1), 60));
        assert!(text.contains("╌50s╌"), "{text}");
        assert_eq!(
            text.matches('╌').count(),
            2,
            "only the gap to the live run: {text}"
        );
    }

    #[test]
    fn positions_follow_offsets_through_a_backward_clock_step() {
        let base = t0() - Duration::from_mins(5);
        let mut stepped = session(base, &[Some(10); 10]);
        // The wall clock jumps back an hour after the fifth probe; the last
        // probe is lost.
        for sample in &mut stepped.samples[5..] {
            sample.sent -= Duration::from_hours(1);
        }
        stepped.samples[9].sample = Sample::Lost;
        assert_eq!(session_end(&stepped), base + Duration::from_secs(10));
        let cells = Run::of(&stepped).cells(5);
        assert_eq!(cells[9].map(|bucket| bucket.lost), Some(1));
        assert!(cells[..9].iter().flatten().all(|bucket| bucket.lost == 0));

        // Joining keeps each sample's offset relative to the run start and
        // leaves its wall-clock label untouched.
        let mut later = session(base + Duration::from_secs(12), &[Some(20); 3]);
        later.samples[0].sent -= Duration::from_hours(1);
        let label = later.samples[0].sent;
        let runs = join(vec![stepped, later]);
        assert_eq!(runs.len(), 1);
        let offsets: Vec<_> = runs[0]
            .samples
            .iter()
            .map(|sample| sample.offset.as_secs())
            .collect();
        assert_eq!(offsets, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 13, 14]);
        assert_eq!(runs[0].samples[10].sent, label);
        assert_eq!(session_end(&runs[0]), base + Duration::from_secs(15));
    }

    #[test]
    fn touching_and_short_boundaries_join_but_five_seconds_splits() {
        let base = t0() - Duration::from_mins(5);
        let at = |secs| base + Duration::from_secs(secs);
        // A ends at 10s where B starts; B ends at 20s, C starts 4s later.
        let joined = join(vec![
            session(at(0), &[Some(10); 10]),
            session(at(10), &[Some(10); 10]),
            session(at(24), &[Some(10); 5]),
        ]);
        assert_eq!(joined.len(), 1);
        assert_eq!(session_end(&joined[0]), at(29));
        let split = join(vec![
            session(at(0), &[Some(10); 10]),
            session(at(15), &[Some(10); 5]),
        ]);
        assert_eq!(split.len(), 2);
        assert_eq!(
            split[0].interval,
            Duration::from_secs(1),
            "single runs pass through"
        );
    }

    #[test]
    fn each_old_run_scales_independently() {
        let low: Vec<_> = (0..20).map(|i| Some(10 + i % 11)).collect();
        let high: Vec<_> = (0..20).map(|i| Some(100 + 10 * (i % 11))).collect();
        let high_start = t0() - Duration::from_mins(30);
        let mut host = HostState::new("host-a".into());
        host.prior_sessions = restore(vec![
            session(high_start - Duration::from_hours(1), &low),
            session(high_start, &high),
        ]);
        let host = with_live(host, &[10]);
        let text = text(&stream(&host, t0() + Duration::from_secs(1), 80));
        let runs: Vec<_> = text
            .split('╌')
            .filter(|part| part.len() > 3)
            .take(2)
            .collect();
        assert_eq!(runs.len(), 2, "{text}");
        // Top Braille dots (left 0x01, right 0x08): each run reaches its own peak.
        let top =
            |c: char| ('\u{2801}'..='\u{28ff}').contains(&c) && (u32::from(c) - 0x2800) & 0x09 != 0;
        for run in runs {
            assert!(run.chars().any(top), "{text}");
        }
    }

    #[test]
    fn hover_and_new_samples_reuse_the_drawn_history() {
        let mut hosts = vec![host("host-a", &[10, 12, 11])];
        let mut timeline = timeline();
        frame(&hosts, Layout::Stacked, &timeline, 140, 50, true);
        assert_eq!(hosts[0].prior_sessions.projections.get(), 1);
        timeline.hover = Some(super::super::Hover {
            host: 0,
            cell: 1,
            overview: false,
        });
        frame(&hosts, Layout::Stacked, &timeline, 140, 50, true);
        hosts[0].apply(ProbeEvent::Reply {
            seq: 3,
            slot: 3,
            rtt: Duration::from_millis(40),
            sent: t0() + Duration::from_secs(3),
        });
        frame(&hosts, Layout::Stacked, &timeline, 140, 50, true);
        assert_eq!(
            hosts[0].prior_sessions.projections.get(),
            1,
            "history drawn once"
        );
        frame(&hosts, Layout::Stacked, &timeline, 120, 50, true);
        assert_eq!(
            hosts[0].prior_sessions.projections.get(),
            2,
            "a resize redraws it"
        );
    }

    #[test]
    fn startup_ticks_reuse_the_drawn_history() {
        let hosts = vec![host("host-a", &[])];
        for secs in [0, 1, 2] {
            let timeline = Timeline {
                now: t0() + Duration::from_secs(secs),
                ..LIVE
            };
            let frame = frame(&hosts, Layout::Stacked, &timeline, 140, 50, true);
            assert!(plain(&frame.lines).contains("╌20m╌probing…"));
        }
        assert_eq!(hosts[0].prior_sessions.projections.get(), 1);
    }

    #[test]
    fn retention_eviction_keeps_the_gap_to_the_current_run() {
        let mut host = HostState::new("host-a".into());
        host.prior_sessions = restore(vec![session(
            t0() - Duration::from_secs(60),
            &[Some(10); 10],
        )]);
        let mut host = with_live(host, &[10, 11, 12]);
        assert!(text(&stream(&host, t0() + Duration::from_secs(3), 60)).contains("╌50s╌"));
        let slot = u64::try_from(crate::stats::HISTORY_LEN).unwrap() + 9;
        host.apply(ProbeEvent::Reply {
            seq: 9,
            slot,
            rtt: Duration::from_millis(10),
            sent: t0() + Duration::from_secs(slot),
        });
        assert!(
            host.first_sample().is_some_and(|(first, _)| first > 2),
            "early samples evicted"
        );
        let now = t0() + Duration::from_secs(slot + 1);
        let text = text(&stream(&host, now, 60));
        assert!(text.contains("╌50s╌"), "{text}");
    }

    #[test]
    fn startup_shows_the_off_gap_before_a_waiting_live_run() {
        let host = host("host-a", &[]);
        let text = text(&stream(&host, t0(), 60));
        assert!(text.contains("╌20m╌probing…"), "{text}");
    }

    #[test]
    fn statistics_cover_only_the_current_run() {
        let restored = host("host-a", &[50, 60]);
        let mut live = restored.clone();
        live.prior_sessions = History::default();
        assert_eq!(restored.run_stats(), live.run_stats());
        for layout in [Layout::Stacked, Layout::Rows] {
            for width in [50, 90, 140] {
                let with = frame(
                    std::slice::from_ref(&restored),
                    layout,
                    &timeline(),
                    width,
                    60,
                    true,
                );
                let without = frame(
                    std::slice::from_ref(&live),
                    layout,
                    &timeline(),
                    width,
                    60,
                    true,
                );
                let rest: Vec<_> = with
                    .lines
                    .into_iter()
                    .filter(|line| !text(line).contains("history"))
                    .collect();
                assert_eq!(
                    rest, without.lines,
                    "{layout:?} {width}: only the history row is added"
                );
            }
        }
    }

    #[test]
    fn startup_reads_at_140x50_for_three_hosts() {
        let hosts: Vec<_> = ["host-a", "host-b", "host-c"]
            .into_iter()
            .map(|name| host(name, &[]))
            .collect();
        let frame = frame(&hosts, Layout::Stacked, &timeline(), 140, 50, true);
        let text = plain(&frame.lines);
        assert_eq!(text.matches("╌20m╌probing…").count(), 3, "{text}");
        assert_eq!(text.matches("2 prior runs").count(), 3, "{text}");
        assert!(frame.lines.len() < 50);
    }

    #[test]
    fn every_layout_adds_one_non_interactive_row_per_host() {
        let hosts = vec![host("host-a", &[10, 12, 11]), host("host-b", &[20])];
        let live: Vec<_> = hosts
            .iter()
            .cloned()
            .map(|mut host| {
                host.prior_sessions = History::default();
                host
            })
            .collect();
        for layout in [Layout::Stacked, Layout::Rows] {
            for width in [50, 60, 90, 110, 140, 200] {
                let frame = frame(&hosts, layout, &timeline(), width, 60, true);
                let reference = super::super::frame(&live, layout, &timeline(), width, 60, true);
                let text = plain(&frame.lines);
                let context = format!("{layout:?} {width}:\n{text}");
                assert_eq!(text.matches("╌20m╌").count(), 2, "{context}");
                assert_eq!(frame.timeline, reference.timeline, "{context}");
                assert_eq!(frame.timeline_lines.len(), reference.timeline_lines.len());
                for (&(line, host, overview), &(old, old_host, old_overview)) in
                    frame.timeline_lines.iter().zip(&reference.timeline_lines)
                {
                    assert_eq!((host, overview), (old_host, old_overview), "{context}");
                    assert_eq!(frame.lines[line], reference.lines[old], "{context}");
                }
            }
        }
    }
}
