//! Prior-session presentation, read from `HostState::prior_sessions` and never
//! folded into live statistics.
//!
//! A and B add one history overview row above the live chart: prior sessions
//! compressed on the left, then the whole current run (live, updating) on the
//! right, so the row reads past → off → now as one connected stream.
//! - A: old sessions keep their RTT/loss colors; every off period, including
//!   the one up to this run, is a fixed-width dashed gap labelled with its
//!   real duration.
//! - B: old sessions dimmed, divided by thin rules, then one bright session
//!   marker before the current run.
//! - C: no old samples drawn; a one-line last-runs summary instead.
//!
//! The row is not interactive; the live chart and its minimap keep their
//! geometry, hover, zoom and pan.

use std::time::{Duration, SystemTime};

use unicode_width::UnicodeWidthStr;

use crate::history::{HistoricalSession, HistoryView};
use crate::stats::{Bucket, HostState, Sample};
use crate::timeline;

use super::raster::{braille_stems, main_reply_role, render_sparkline, Scale};
use super::{fmt_ms, fmt_pct, span, Line, Role, Span, Tint, RULE};

/// Every off gap gets the same small width, whatever its duration.
pub(super) const GAP_WIDTH: usize = 5;
const MIN_SEGMENT: usize = 4;
/// The current run always keeps at least this many cells of the stream.
const MIN_LIVE: usize = 8;

/// Whether this host gets a history overview row.
pub(super) fn has_stream(host: &HostState) -> bool {
    host.history_view != HistoryView::C && !host.prior_sessions.is_empty()
}

/// The current run begins at its first retained probe, or now while the very
/// first probe is still in flight.
fn live_start(host: &HostState, now: SystemTime) -> SystemTime {
    host.first_sample().map_or(now, |(_, entry)| entry.sent)
}

fn session_end(session: &HistoricalSession) -> SystemTime {
    session
        .samples
        .iter()
        .map(|entry| entry.sent)
        .max()
        .map_or(session.start, |last| last + session.interval)
}

fn chronological(host: &HostState) -> Vec<&HistoricalSession> {
    let mut sessions: Vec<_> = host.prior_sessions.iter().collect();
    sessions.sort_by_key(|session| session.start);
    sessions
}

enum Piece<'a> {
    Segment(&'a HistoricalSession, usize),
    /// Off time between two runs, or between the last prior run and this one.
    Gap(Duration),
    /// B: thin divider between two dimmed prior runs.
    Divider,
    /// B: the distinct boundary where the current session starts.
    Marker,
}

impl Piece<'_> {
    fn width(&self) -> usize {
        match self {
            Self::Segment(_, width) => *width,
            Self::Gap(_) => GAP_WIDTH,
            Self::Divider | Self::Marker => 1,
        }
    }
}

/// The most recent sessions that fit `budget`, each sized by its duration but
/// never wider than one Braille stem per sample.
fn pieces<'a>(
    sessions: &[&'a HistoricalSession],
    view: HistoryView,
    budget: usize,
    live: SystemTime,
) -> Vec<Piece<'a>> {
    let separator = match view {
        HistoryView::A => GAP_WIDTH,
        HistoryView::B | HistoryView::C => 1,
    };
    let shown = sessions.len().min(budget / (MIN_SEGMENT + separator));
    let sessions = &sessions[sessions.len() - shown..];
    let durations: Vec<f64> = sessions
        .iter()
        .map(|session| {
            session_end(session)
                .duration_since(session.start)
                .unwrap_or_default()
                .as_secs_f64()
                .max(1e-3)
        })
        .collect();
    let total: f64 = durations.iter().sum();
    let extra = budget.saturating_sub(shown * (MIN_SEGMENT + separator));
    let mut pieces = Vec::with_capacity(shown * 2);
    for (index, session) in sessions.iter().enumerate() {
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            clippy::cast_precision_loss,
            reason = "the share is bounded by the strip budget, a few dozen cells"
        )]
        let share = (extra as f64 * durations[index] / total).floor() as usize;
        let cap = session.samples.len().div_ceil(2).max(MIN_SEGMENT);
        pieces.push(Piece::Segment(session, (MIN_SEGMENT + share).min(cap)));
        let next = sessions.get(index + 1).map_or(live, |next| next.start);
        pieces.push(match view {
            HistoryView::A => Piece::Gap(
                next.duration_since(session_end(session))
                    .unwrap_or_default(),
            ),
            HistoryView::B | HistoryView::C if index + 1 == shown => Piece::Marker,
            HistoryView::B | HistoryView::C => Piece::Divider,
        });
    }
    pieces
}

/// Two time-ordered subcells per column; slowest reply and loss per subcell.
fn buckets(session: &HistoricalSession, columns: usize) -> Vec<Option<Bucket>> {
    let subcells = columns * 2;
    let mut cells = vec![None; subcells];
    let span = session_end(session)
        .duration_since(session.start)
        .unwrap_or_default()
        .as_secs_f64()
        .max(1e-9);
    for entry in &session.samples {
        let at = entry
            .sent
            .duration_since(session.start)
            .unwrap_or_default()
            .as_secs_f64();
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            clippy::cast_precision_loss,
            reason = "the position is clamped to the segment's subcells"
        )]
        let index = ((at / span * subcells as f64) as usize).min(subcells - 1);
        let bucket = cells[index].get_or_insert(Bucket {
            slowest: None,
            samples: 0,
            lost: 0,
            first: entry.sent,
        });
        bucket.samples += 1;
        bucket.first = bucket.first.min(entry.sent);
        match entry.sample {
            Sample::Lost => bucket.lost += 1,
            Sample::Reply(rtt) => {
                bucket.slowest = Some(bucket.slowest.map_or(rtt, |slowest| slowest.max(rtt)));
            }
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

/// One-row Braille stems, colored like the live chart (A) or dimmed (B).
/// Compression packs many probes per glyph, so any loss colors the glyph
/// rather than hiding behind a reply in the same cell.
fn draw_segment(
    line: &mut Line,
    cells: &[Option<Bucket>],
    scale: &Scale,
    baseline: Option<Duration>,
    dim: bool,
) {
    for pair in cells.chunks(2) {
        let units: [usize; 2] = std::array::from_fn(|side| {
            pair.get(side)
                .copied()
                .flatten()
                .and_then(|bucket| bucket.slowest)
                .map_or(0, |rtt| scale.units(rtt.as_secs_f64(), 4))
        });
        let failures: [usize; 2] = std::array::from_fn(|side| {
            usize::from(
                pair.get(side)
                    .copied()
                    .flatten()
                    .is_some_and(|bucket| bucket.lost > 0),
            )
        });
        let lossy = failures.contains(&1);
        let role = match (dim, lossy) {
            (false, true) => Role::Bad,
            (false, false) => main_reply_role(pair, units, baseline),
            (true, true) => Role::MinimapLossFaint,
            (true, false) => Role::Faint,
        };
        let glyph = braille_stems(if units == [0, 0] { failures } else { units });
        push(line, role, glyph.encode_utf8(&mut [0; 4]));
    }
}

/// The connected history stream, exactly `width` cells: prior sessions, the
/// off gap (A) or session marker (B), then the whole current run up to now.
pub(super) fn stream(host: &HostState, now: SystemTime, width: usize) -> Line {
    let mut line = Vec::new();
    if !has_stream(host) || width == 0 {
        line.push(span(Role::Plain, " ".repeat(width)));
        return line;
    }
    let sessions = chronological(host);
    let budget = (width / 2).min(width.saturating_sub(MIN_LIVE));
    let pieces = pieces(&sessions, host.history_view, budget, live_start(host, now));
    let scale = Scale::of(
        pieces
            .iter()
            .filter_map(|piece| match piece {
                Piece::Segment(session, _) => Some(&session.samples),
                _ => None,
            })
            .flatten()
            .filter_map(|entry| match entry.sample {
                Sample::Reply(rtt) => Some(rtt),
                Sample::Lost => None,
            }),
    );
    let baseline = host.rtt_baseline();
    let dim = host.history_view == HistoryView::B;
    for piece in &pieces {
        match piece {
            Piece::Segment(session, columns) => {
                draw_segment(
                    &mut line,
                    &buckets(session, *columns),
                    &scale,
                    baseline,
                    dim,
                );
            }
            Piece::Gap(off) => push(&mut line, Role::Dim, &gap_label(*off)),
            Piece::Divider => push(&mut line, Role::Faint, "╎"),
            Piece::Marker => push(&mut line, Role::Value, "┃"),
        }
    }
    let run_width = width - pieces.iter().map(Piece::width).sum::<usize>();
    let used = if host.history_is_empty() {
        let waiting = if run_width >= 8 { "probing…" } else { "" };
        push(&mut line, Role::Dim, waiting);
        waiting.width()
    } else {
        let grid = timeline::overview(host, run_width, None);
        let cells = host.time_buckets(grid.start, grid.end, run_width * 2);
        let (mut rows, _) = render_sparkline(host, grid, &cells, 1, None, None);
        let run = rows.pop().unwrap_or_default();
        let used = run.iter().map(|span| span.text.width()).sum();
        line.extend(run);
        used
    };
    push(
        &mut line,
        Role::Plain,
        &" ".repeat(run_width.saturating_sub(used)),
    );
    line
}

/// `╌3h╌╌`: dashes say "off", the label says for how long.
fn gap_label(off: Duration) -> String {
    format!("╌{:╌^3}╌", fmt_off(off))
}

/// At most three cells, so every gap has the same width.
fn fmt_off(value: Duration) -> String {
    let secs = value.as_secs();
    match secs {
        0..60 => format!("{secs}s"),
        60..3_600 => format!("{}m", secs / 60),
        3_600..360_000 => format!("{}h", secs / 3_600),
        360_000..8_640_000 => format!("{}d", secs / 86_400),
        8_640_000..60_480_000 => format!("{}w", secs / 604_800),
        _ => ">1y".into(),
    }
}

/// Label for the history row, longest variant that fits `width`.
pub(super) fn caption(host: &HostState, width: usize) -> String {
    let runs = match host.prior_sessions.len() {
        1 => "1 prior run".to_string(),
        n => format!("{n} prior runs"),
    };
    let detail = match host.history_view {
        HistoryView::A => "off gaps not to scale",
        HistoryView::B | HistoryView::C => "dim │ this run",
    };
    [
        format!("history overview · {runs} → now · {detail}"),
        format!("history overview · {runs} → now"),
        format!("history · {runs}"),
        "history".to_string(),
    ]
    .into_iter()
    .find(|text| text.width() <= width)
    .unwrap_or_default()
}

/// The history row for layouts without a rail: stream plus a trailing
/// caption, keeping at least two thirds of `width` for the stream.
pub(super) fn labelled(host: &HostState, now: SystemTime, width: usize) -> Line {
    let label = caption(host, (width / 3).saturating_sub(1));
    let gap = usize::from(!label.is_empty());
    let mut line = stream(host, now, width - label.width() - gap);
    if !label.is_empty() {
        line.push(span(Role::Plain, " "));
        line.push(span(Role::Dim, label));
    }
    line
}

/// Column geometry of the rows layout, all relative to the end of `RULE`.
#[derive(Debug, Clone, Copy)]
pub(super) struct RowColumns {
    /// Start of the Address column.
    pub(super) indent: usize,
    /// Start and width of the live timeline column.
    pub(super) chart: (usize, usize),
    /// Width of the trailing statistics columns.
    pub(super) stats: usize,
}

/// Rows layout: prior sessions get their own non-interactive line under the
/// host row, aligned with the live timeline column when it is wide enough.
pub(super) fn row_line(
    host: &HostState,
    now: SystemTime,
    width: usize,
    columns: RowColumns,
) -> Option<Line> {
    let room = width.saturating_sub(RULE.width() + columns.indent + 1);
    let mut line = vec![span(Role::Rule, RULE)];
    if let Some(text) = last_runs(host, now, room) {
        line.extend([span(Role::Plain, " ".repeat(columns.indent)), text]);
    } else if !has_stream(host) {
        return None;
    } else if columns.chart.1 >= 24 {
        line.push(span(Role::Plain, " ".repeat(columns.chart.0)));
        line.extend(stream(host, now, columns.chart.1));
        line.push(span(Role::Plain, "  "));
        line.push(span(Role::Dim, caption(host, columns.stats)));
    } else {
        line.push(span(Role::Plain, " ".repeat(columns.indent)));
        line.extend(labelled(host, now, room));
    }
    Some(line)
}

/// C: last seen (UTC and age), loss and p50 over every retained prior sample,
/// as the longest variant that fits `width`.
pub(super) fn last_runs(host: &HostState, now: SystemTime, width: usize) -> Option<Span> {
    if host.history_view != HistoryView::C {
        return None;
    }
    let last = host.prior_sessions.iter().map(session_end).max()?;
    let mut replies: Vec<Duration> = Vec::new();
    let mut dropped = 0_u32;
    for entry in host
        .prior_sessions
        .iter()
        .flat_map(|session| &session.samples)
    {
        match entry.sample {
            Sample::Reply(rtt) => replies.push(rtt),
            Sample::Lost => dropped += 1,
        }
    }
    let runs = match host.prior_sessions.len() {
        1 => "1 prior run".to_string(),
        n => format!("{n} prior runs"),
    };
    let age = fmt_off(now.duration_since(last).unwrap_or_default());
    #[allow(
        clippy::cast_precision_loss,
        reason = "retained sample counts are far below 2^52"
    )]
    let completed = (replies.len() + dropped as usize) as f64;
    let loss = if completed > 0.0 {
        format!(
            " · loss {}",
            fmt_pct(f64::from(dropped) * 100.0 / completed)
        )
    } else {
        String::new()
    };
    let p50 = if replies.is_empty() {
        String::new()
    } else {
        let middle = replies.len() / 2;
        let (_, p50, _) = replies.select_nth_unstable(middle);
        format!(" · p50 {}", fmt_ms(*p50))
    };
    let seen = format!("last seen {} ({age} ago)", fmt_utc(last));
    [
        format!("{runs} · {seen}{loss}{p50}"),
        format!("{seen}{loss}{p50}"),
        format!("last {age} ago{loss}{p50}"),
        format!("last {age} ago{p50}"),
    ]
    .into_iter()
    .find(|text| text.width() <= width)
    .map(|text| span(Role::Dim, text))
}

/// `2026-10-02 16:00Z`, without a calendar dependency.
fn fmt_utc(at: SystemTime) -> String {
    let secs = at
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |since| since.as_secs());
    let (year, month, day) = civil(secs / 86_400);
    let rem = secs % 86_400;
    format!(
        "{year}-{month:02}-{day:02} {:02}:{:02}Z",
        rem / 3_600,
        rem % 3_600 / 60
    )
}

/// Days since 1970-01-01 to a proleptic Gregorian date (Hinnant's algorithm).
fn civil(days: u64) -> (u64, u64, u64) {
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + u64::from(month <= 2), month, day)
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

    fn session(id: &str, start: SystemTime, rtts_ms: &[Option<u64>]) -> HistoricalSession {
        HistoricalSession {
            id: id.into(),
            start,
            interval: Duration::from_secs(1),
            samples: rtts_ms
                .iter()
                .enumerate()
                .map(|(index, rtt)| Entry {
                    sent: start + Duration::from_secs(index as u64),
                    sample: rtt.map_or(Sample::Lost, |ms| Sample::Reply(Duration::from_millis(ms))),
                })
                .collect(),
        }
    }

    /// Two prior runs, off for 3h between them and 20m before a live run
    /// starting at t0. Stored newest-first to prove ordering is by start.
    fn host(name: &str, view: HistoryView, live: &[u64]) -> HostState {
        let mut host = HostState::new(name.into());
        host.apply(ProbeEvent::Resolved("192.0.2.1".parse().unwrap()));
        let old: Vec<_> = (0..60).map(|i| Some(10 + i % 7)).collect();
        let mut recent: Vec<_> = (0..40).map(|i| Some(12 + i % 5)).collect();
        recent[10] = None;
        let recent_start = t0() - Duration::from_secs(20 * 60 + 40);
        let old_start = recent_start - Duration::from_mins(181);
        host.prior_sessions = vec![
            session("recent", recent_start, &recent),
            session("old", old_start, &old),
        ];
        host.history_view = view;
        for (index, ms) in live.iter().enumerate() {
            host.apply(ProbeEvent::Reply {
                seq: u16::try_from(index).unwrap(),
                slot: index as u64,
                rtt: Duration::from_millis(*ms),
                sent: t0() + Duration::from_secs(index as u64),
            });
        }
        host
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

    #[test]
    fn gap_labels_keep_a_fixed_width() {
        for secs in [
            0,
            59,
            60,
            3_599,
            3_600,
            359_999,
            360_000,
            8_639_999,
            8_640_000,
            u64::MAX / 2,
        ] {
            let label = gap_label(Duration::from_secs(secs));
            assert_eq!(label.width(), GAP_WIDTH, "{label}");
        }
        assert_eq!(gap_label(Duration::from_hours(3)), "╌3h╌╌");
        assert_eq!(gap_label(Duration::from_mins(20)), "╌20m╌");
    }

    #[test]
    fn utc_dates_follow_the_gregorian_calendar() {
        assert_eq!(fmt_utc(t0()), "2026-10-02 16:00Z");
        assert_eq!(fmt_utc(SystemTime::UNIX_EPOCH), "1970-01-01 00:00Z");
        assert_eq!(
            fmt_utc(SystemTime::UNIX_EPOCH + Duration::from_hours(264_384)),
            "2000-02-29 00:00Z"
        );
    }

    #[test]
    fn view_a_connects_old_runs_off_gaps_and_the_live_run() {
        let host = host("host-a", HistoryView::A, &[10, 30, 20]);
        let line = stream(&host, t0() + Duration::from_secs(3), 60);
        assert_eq!(line.iter().map(|span| span.text.width()).sum::<usize>(), 60);
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
    fn view_a_shows_waiting_live_side_at_startup() {
        let host = host("host-a", HistoryView::A, &[]);
        let text = text(&stream(&host, t0(), 60));
        assert!(text.contains("╌20m╌probing…"), "{text}");
    }

    #[test]
    fn view_b_dims_old_runs_before_a_session_marker() {
        let host = host("host-a", HistoryView::B, &[10, 30, 20]);
        let line = stream(&host, t0() + Duration::from_secs(3), 60);
        let marker = line.iter().position(|span| span.text == "┃").unwrap();
        assert_eq!(line[marker].role, Role::Value);
        assert!(line[..marker].iter().all(|span| matches!(
            span.role,
            Role::Faint | Role::MinimapLossFaint | Role::Plain
        )));
        assert!(text(&line).contains('╎'));
        assert!(!text(&line).contains('╌'));
        assert!(line[marker + 1..]
            .iter()
            .any(|span| matches!(span.role, Role::Spark | Role::Baseline | Role::RttElevated)));
    }

    #[test]
    fn view_c_draws_no_old_samples_and_summarizes_prior_runs() {
        let host = host("host-a", HistoryView::C, &[]);
        assert!(!has_stream(&host));
        let now = t0() + Duration::from_secs(5);
        let summary = last_runs(&host, now, 200).unwrap();
        assert_eq!(
            summary.text,
            "2 prior runs · last seen 2026-10-02 15:40Z (20m ago) · loss 1% · p50 13.0 ms"
        );
        assert_eq!(
            last_runs(&host, now, 30).unwrap().text,
            "last 20m ago · p50 13.0 ms"
        );
        assert!(last_runs(&host, now, 10).is_none());
    }

    #[test]
    fn prior_sessions_never_change_current_statistics() {
        let mut with = host("host-a", HistoryView::A, &[50, 60]);
        let mut without = with.clone();
        without.prior_sessions.clear();
        assert_eq!(with.run_stats(), without.run_stats());
        with.history_view = HistoryView::C;
        assert_eq!(with.run_stats(), without.run_stats());
    }

    #[test]
    fn default_view_reads_at_140x50_for_three_hosts_at_startup() {
        let hosts: Vec<_> = ["host-a", "host-b", "host-c"]
            .into_iter()
            .map(|name| host(name, HistoryView::default(), &[]))
            .collect();
        let without: Vec<_> = hosts
            .iter()
            .cloned()
            .map(|mut host| {
                host.prior_sessions.clear();
                host
            })
            .collect();
        let timeline = timeline();
        let frame = frame(&hosts, Layout::Stacked, &timeline, 140, 50, true);
        let text = plain(&frame.lines);
        assert_eq!(text.matches("╌20m╌probing…").count(), 3, "{text}");
        assert_eq!(text.matches("2 prior runs").count(), 3, "{text}");
        assert!(text.contains("history"), "{text}");
        assert!(frame.lines.len() < 50);
        let live = super::super::frame(&without, Layout::Stacked, &timeline, 140, 50, true);
        assert_eq!(
            frame.timeline, live.timeline,
            "live chart geometry is untouched"
        );
    }

    #[test]
    fn every_layout_renders_each_view() {
        for view in [HistoryView::A, HistoryView::B, HistoryView::C] {
            let hosts = vec![
                host("host-a", view, &[10, 12, 11]),
                host("host-b", view, &[20]),
            ];
            for layout in [Layout::Stacked, Layout::Rows] {
                for width in [50, 60, 90, 110, 140, 200] {
                    let frame = frame(&hosts, layout, &timeline(), width, 60, true);
                    let text = plain(&frame.lines);
                    let context = format!("{view:?} {layout:?} {width}:\n{text}");
                    match view {
                        HistoryView::A => assert!(text.contains("╌20m╌"), "{context}"),
                        HistoryView::B => assert!(text.contains('┃'), "{context}"),
                        HistoryView::C => {
                            assert!(text.contains("p50"), "{context}");
                            assert!(!text.contains('┃') && !text.contains('╌'), "{context}");
                        }
                    }
                    for &(line, host, _) in &frame.timeline_lines {
                        assert!(
                            frame.lines[line]
                                .iter()
                                .all(|span| !span.text.contains("history")),
                            "history rows stay out of live hit testing: {context}"
                        );
                        assert!(host < hosts.len());
                    }
                }
            }
        }
    }
}
