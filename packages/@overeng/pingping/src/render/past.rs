//! Restored prior sessions as one connected history row above the live chart:
//! earlier runs, compressed off gaps, then the whole current run up to now.
//!
//! The row reads `HostState::prior_sessions` only, so restored samples never
//! reach live statistics. It is not interactive: the live chart and its
//! overview keep their geometry, hover, zoom and pan. Each old run and the
//! current run scale their RTT stems independently.

use std::time::{Duration, SystemTime};

use unicode_width::UnicodeWidthStr;

use crate::history::HistoricalSession;
use crate::stats::{Bucket, HostState, Sample};
use crate::timeline;

use super::raster::{braille_stems, main_reply_role, render_sparkline, Scale};
use super::{span, Line, Role, Tint, RULE};

/// Runs separated by less off time than this (or overlapping) join without a
/// gap. Fixed rather than derived from the probe interval, so adjusting the
/// rate never changes how recorded history reads.
const JOIN_BELOW: Duration = Duration::from_secs(5);
/// Every off gap gets the same width, whatever its duration.
const GAP_WIDTH: usize = 5;
const MIN_SEGMENT: usize = 4;
/// The current run always keeps at least this many cells of the row.
const MIN_LIVE: usize = 8;

pub(super) fn has_stream(host: &HostState) -> bool {
    !host.prior_sessions.is_empty()
}

/// Restored samples are ordered by send time, so a run ends one interval
/// after its last probe.
fn session_end(session: &HistoricalSession) -> SystemTime {
    session
        .samples
        .last()
        .map_or(session.start, |last| last.sent + session.interval)
}

fn seconds(session: &HistoricalSession) -> f64 {
    session_end(session)
        .duration_since(session.start)
        .unwrap_or_default()
        .as_secs_f64()
        .max(1e-3)
}

/// Joins stored sessions (sorted by start) that overlap or are less than
/// `JOIN_BELOW` apart into one run, once at restore rather than per frame.
/// A run's end is the furthest end of any session it contains, so a short
/// session nested in a longer one never ends the run early.
pub(crate) fn restore(sessions: Vec<HistoricalSession>) -> Vec<HistoricalSession> {
    let mut runs: Vec<(HistoricalSession, SystemTime, bool)> = Vec::with_capacity(sessions.len());
    for session in sessions {
        let end = session_end(&session);
        match runs.last_mut() {
            Some((run, run_end, merged)) if off_gap(*run_end, session.start).is_none() => {
                run.samples.extend(session.samples);
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
                run.samples.sort_by_key(|entry| entry.sent);
                let last = run.samples.last().map_or(run.start, |entry| entry.sent);
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
    Run(&'a HistoricalSession, usize),
    Off(Duration),
}

/// The most recent runs that fit `budget`, each sized by its duration but
/// never wider than one Braille stem per sample. Runs come from `restore`,
/// so neighbours never overlap and only the next start bounds an off gap.
fn pieces(sessions: &[HistoricalSession], budget: usize, live: SystemTime) -> Vec<Piece<'_>> {
    let shown = sessions.len().min(budget / (MIN_SEGMENT + GAP_WIDTH));
    let sessions = &sessions[sessions.len() - shown..];
    let off = |index: usize| {
        let next = sessions.get(index + 1).map_or(live, |next| next.start);
        off_gap(session_end(&sessions[index]), next)
    };
    let gaps = (0..shown).filter(|index| off(*index).is_some()).count();
    let extra = budget.saturating_sub(shown * MIN_SEGMENT + gaps * GAP_WIDTH);
    let total: f64 = sessions.iter().map(seconds).sum();
    let mut pieces = Vec::with_capacity(shown + gaps);
    for (index, session) in sessions.iter().enumerate() {
        let share = cells_of(seconds(session) / total, extra);
        let cap = session.samples.len().div_ceil(2).max(MIN_SEGMENT);
        pieces.push(Piece::Run(session, (MIN_SEGMENT + share).min(cap)));
        if let Some(off) = off(index) {
            pieces.push(Piece::Off(off));
        }
    }
    pieces
}

/// Two time-ordered subcells per column; slowest reply and loss per subcell.
/// Subcells without samples stay empty rather than reading as loss.
fn buckets(session: &HistoricalSession, columns: usize) -> Vec<Option<Bucket>> {
    let mut cells = vec![None; columns * 2];
    let span = seconds(session);
    for entry in &session.samples {
        let at = entry.sent.duration_since(session.start).unwrap_or_default();
        let index = cells_of(at.as_secs_f64() / span, cells.len()).min(cells.len() - 1);
        let bucket = cells[index].get_or_insert(Bucket {
            slowest: None,
            samples: 0,
            lost: 0,
            first: entry.sent,
        });
        bucket.samples += 1;
        match entry.sample {
            Sample::Lost => bucket.lost += 1,
            Sample::Reply(rtt) => bucket.slowest = bucket.slowest.max(Some(rtt)),
        }
    }
    cells
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
    let current_start = host.first_sample().map_or(now, |(_, entry)| entry.sent);
    let budget = (width / 2).min(width.saturating_sub(MIN_LIVE));
    let pieces = pieces(&host.prior_sessions, budget, current_start);
    let baseline = host.rtt_baseline();
    let mut line = Vec::new();
    let mut used = 0;
    for piece in &pieces {
        match piece {
            Piece::Run(session, columns) => {
                draw_run(&mut line, &buckets(session, *columns), baseline);
                used += columns;
            }
            Piece::Off(off) => {
                push(&mut line, Role::Dim, &gap_label(*off));
                used += GAP_WIDTH;
            }
        }
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
    use crate::stats::Entry;

    fn session(start: SystemTime, rtts_ms: &[Option<u64>]) -> HistoricalSession {
        HistoricalSession {
            id: "session".into(),
            start,
            interval: Duration::from_secs(1),
            samples: rtts_ms
                .iter()
                .zip(0..)
                .map(|(rtt, index)| Entry {
                    sent: start + Duration::from_secs(index),
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
        host.prior_sessions = vec![session(end - Duration::from_secs(20), &[Some(10); 20])];
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
        let runs = restore(vec![a, b, c]);
        assert_eq!(runs.len(), 1);
        let sent: Vec<_> = runs[0].samples.iter().map(|entry| entry.sent).collect();
        assert!(sent.is_sorted(), "{sent:?}");
        assert_eq!(sent.len(), 12);
        assert_eq!(session_end(&runs[0]), base + Duration::from_secs(10));
        let mut host = HostState::new("host-a".into());
        host.prior_sessions = runs;
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
    fn touching_and_short_boundaries_join_but_five_seconds_splits() {
        let base = t0() - Duration::from_mins(5);
        let at = |secs| base + Duration::from_secs(secs);
        // A ends at 10s where B starts; B ends at 20s, C starts 4s later.
        let joined = restore(vec![
            session(at(0), &[Some(10); 10]),
            session(at(10), &[Some(10); 10]),
            session(at(24), &[Some(10); 5]),
        ]);
        assert_eq!(joined.len(), 1);
        assert_eq!(session_end(&joined[0]), at(29));
        let split = restore(vec![
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
    fn startup_shows_the_off_gap_before_a_waiting_live_run() {
        let host = host("host-a", &[]);
        let text = text(&stream(&host, t0(), 60));
        assert!(text.contains("╌20m╌probing…"), "{text}");
    }

    #[test]
    fn statistics_cover_only_the_current_run() {
        let restored = host("host-a", &[50, 60]);
        let mut live = restored.clone();
        live.prior_sessions.clear();
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
                host.prior_sessions.clear();
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
