//! Zoom and pan over the RTT history. One `View` is shared by all hosts so
//! stacked timelines stay aligned. Coordinates are elapsed time divided by the
//! run-start interval, independent of rate changes and history trimming.

use std::fmt::Write as _;
use std::time::{Duration, SystemTime};

use chrono::{DateTime, Local, TimeZone, Utc};

use crate::render::fmt_ms;
use crate::stats::{Bucket, HostState};

/// Zoom steps per doubling: one wheel tick scales by 2^(1/4) ≈ 1.19.
const STEPS_PER_DOUBLING: i32 = 4;
/// Zoomed in: one sample spans up to 64 cells.
const MIN_LEVEL: i32 = -6 * STEPS_PER_DOUBLING;
/// Permit sparse mixed-rate histories to fit well beyond the old slot limit.
/// Normal histories still stop zooming out as soon as they fit the viewport.
const MAX_LEVEL: i32 = 64 * STEPS_PER_DOUBLING;

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct View {
    /// Zoom level; base time units per cell = 2^(level / 4).
    pub level: i32,
    /// Exclusive time-axis end; `None` follows the newest scheduled probe.
    pub end: Option<f64>,
}

/// Retained time extent across all hosts, in fixed run-start interval units.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Extent {
    pub oldest: f64,
    pub latest: f64,
}

impl Extent {
    pub fn of(hosts: &[HostState]) -> Self {
        Self {
            oldest: hosts
                .iter()
                .filter(|host| !host.history_is_empty())
                .map(HostState::oldest_position)
                .reduce(f64::min)
                .unwrap_or(0.0),
            latest: hosts
                .iter()
                .map(HostState::latest_position)
                .reduce(f64::max)
                .unwrap_or(0.0),
        }
    }

    fn bounds(self) -> (f64, f64) {
        (self.oldest, self.latest)
    }
}

#[allow(clippy::cast_precision_loss, reason = "terminal widths are small")]
fn cells(width: usize) -> f64 {
    width.max(1) as f64
}

impl View {
    pub fn is_default(self) -> bool {
        self == Self::default()
    }

    /// Samples per cell; below 1 when zoomed in.
    pub fn per_cell(self) -> f64 {
        f64::exp2(f64::from(self.level) / f64::from(STEPS_PER_DOUBLING))
    }

    /// Zoom by one step. `anchor` is the cell (0 = left edge of a
    /// `width`-cell timeline) that keeps pointing at the same time; a live
    /// view stays live and keeps its right edge on the newest sample. Zooming
    /// out stops once the whole history is visible at one sample per cell or
    /// coarser; zooming in always works down to 64 cells per sample.
    #[allow(
        clippy::cast_precision_loss,
        reason = "terminal cell indices are small"
    )]
    pub fn zoom(&mut self, zoom_in: bool, anchor: Option<usize>, width: usize, extent: Extent) {
        let (oldest, latest) = extent.bounds();
        let visible = cells(width) * self.per_cell();
        if !zoom_in && self.level >= 0 && visible >= latest - oldest {
            return;
        }
        let next = if zoom_in {
            (self.level - 1).max(MIN_LEVEL)
        } else {
            (self.level + 1).min(MAX_LEVEL)
        };
        if next == self.level {
            return;
        }
        if let Some(end) = self.end {
            let anchor = anchor.map_or(cells(width), |cell| (cell as f64).min(cells(width)));
            let pivot = end - visible + anchor * self.per_cell();
            self.level = next;
            self.end = Some(pivot + (cells(width) - anchor) * self.per_cell());
            self.clamp(width, extent);
        } else {
            self.level = next;
        }
    }

    /// Pan by `cells`; positive moves toward older samples.
    #[allow(clippy::cast_precision_loss, reason = "pan distances are small")]
    pub fn pan(&mut self, by_cells: i64, width: usize, extent: Extent) {
        self.shift(-(by_cells as f64) * self.per_cell(), width, extent);
    }

    /// Move the window by `samples`; positive moves toward newer samples.
    pub fn shift(&mut self, samples: f64, width: usize, extent: Extent) {
        let current = self.end.unwrap_or(extent.bounds().1);
        self.end = Some(current + samples);
        self.clamp(width, extent);
    }

    /// Center the window on absolute sample position `sample`.
    pub fn center_on(&mut self, sample: f64, width: usize, extent: Extent) {
        self.end = Some(sample + cells(width) * self.per_cell() / 2.0);
        self.clamp(width, extent);
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// Keeps a paused window inside the history; reaching the newest sample
    /// resumes following it.
    fn clamp(&mut self, width: usize, extent: Extent) {
        let Some(end) = self.end else { return };
        let (oldest, latest) = extent.bounds();
        let lowest = (oldest + cells(width) * self.per_cell()).min(latest);
        let end = end.max(lowest);
        self.end = (end < latest).then_some(end);
    }

    /// Dim status shown while the view differs from the default, e.g.
    /// `1 cell = 4.8s · 2m10s ago · 0 live`.
    pub fn hint(self, extent: Extent, interval: Duration) -> Option<String> {
        if self.is_default() {
            return None;
        }
        let mut parts = Vec::new();
        if self.level != 0 {
            parts.push(format!(
                "1 cell = {}",
                fmt_short(interval.mul_f64(self.per_cell()))
            ));
        }
        if let Some(end) = self.end {
            let behind = (extent.bounds().1 - end).max(0.0);
            parts.push(format!("{} ago", fmt_span(interval.mul_f64(behind))));
        }
        parts.push("0 live".into());
        Some(parts.join(" \u{b7} "))
    }
}

/// Elapsed-time cell grid. Main charts align to discrete zoom cells; minimaps
/// use a continuous scale from the oldest retained deadline to their endpoint.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Grid {
    pub per_cell: f64,
    pub start: f64,
    pub end: f64,
    pub width: usize,
}

impl Grid {
    pub(crate) fn of(host: &HostState, view: View, width: usize) -> Self {
        Self::for_view(view, width, host.latest_position())
    }

    /// Main-chart grid at a captured endpoint, including live-cell alignment.
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_precision_loss,
        reason = "cell and sample positions are non-negative and far below 2^52"
    )]
    pub(crate) fn for_view(view: View, width: usize, total: f64) -> Self {
        let end = view.end.map_or(total, |end| end.min(total));
        let end_cell = (end / view.per_cell() - 1e-9).ceil().max(0.0) as u64;
        Self {
            per_cell: view.per_cell(),
            start: end_cell.saturating_sub(width as u64) as f64 * view.per_cell(),
            end,
            width,
        }
    }

    /// Sample position at the middle of relative cell `cell`.
    #[allow(clippy::cast_precision_loss, reason = "cell indices are small")]
    pub fn center_of(self, cell: usize) -> f64 {
        self.start + (cell as f64 + 0.5) * self.per_cell
    }

    #[allow(
        clippy::cast_precision_loss,
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "nonnegative sample indices are far below 2^52"
    )]
    pub fn range_of(self, cell: usize) -> (f64, f64) {
        let from = self.start + cell as f64 * self.per_cell;
        let to = if cell + 1 == self.width {
            self.end
        } else {
            (self.start + (cell + 1) as f64 * self.per_cell).min(self.end)
        };
        (from, to)
    }
}

/// The elapsed-time window `[start, end)` in fixed run-start interval units.
#[allow(
    clippy::cast_precision_loss,
    reason = "sample counts stay far below 2^52"
)]
pub fn window(host: &HostState, view: View, width: usize) -> (f64, f64) {
    let grid = Grid::of(host, view, width);
    (grid.start, grid.end)
}

/// A continuous full-width overview of the retained real-time history.
#[allow(
    clippy::cast_precision_loss,
    reason = "sample counts stay far below 2^52"
)]
pub fn overview(host: &HostState, width: usize, end: Option<f64>) -> Grid {
    let total = host.latest_position();
    let end = end.map_or(total, |end| end.min(total));
    let start = host.oldest_position().min(end);
    let span = end - start;
    Grid {
        start,
        end,
        width,
        per_cell: if span > 0.0 {
            span / width.max(1) as f64
        } else {
            1.0
        },
    }
}

/// Relative overview cells `[from, to)` that overlap the window.
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    reason = "cell positions are non-negative and small"
)]
pub fn window_cells(grid: Grid, window: (f64, f64)) -> (usize, usize) {
    let to_cell = |sample: f64| ((sample - grid.start) / grid.per_cell).max(0.0);
    let width = grid.width;
    let to = ((to_cell(window.1) - 1e-9).ceil() as usize)
        .min(width)
        .max(2)
        .min(width);
    // The axis needs two cells for its end caps; tint the same cells.
    let from = (to_cell(window.0).floor() as usize).min(to.saturating_sub(2));
    (from, to)
}

/// Aggregate a physical terminal cell. Hover uses this range once, rather than
/// adding expanded raster subcells and counting a probe twice.
pub(crate) fn cell_bucket(host: &HostState, grid: Grid, cell: usize) -> Option<Bucket> {
    if cell >= grid.width {
        return None;
    }
    let (from, to) = grid.range_of(cell);
    bucket_between(host, from, to, grid.per_cell, grid.per_cell / 2.0 < 1.0)
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "non-negative retained sample coordinates fit in u64"
)]
fn bucket_between(host: &HostState, from: f64, to: f64, step: f64, expand: bool) -> Option<Bucket> {
    if from >= to {
        return None;
    }
    if !host.has_schedule() {
        // Synthetic outcome-only streams keep the original slot grid.
        let start = from.floor() as u64;
        let range_end = ((from + step).floor() as u64)
            .max(start + 1)
            .min(to.ceil() as u64);
        return host.bucket(start, range_end);
    }
    host.time_bucket(from, to, expand)
}

/// Physical-column summaries used by the timeline behavior regressions.
#[cfg(test)]
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "bounded viewport cell counts fit in usize"
)]
fn buckets(host: &HostState, view: View, width: usize) -> Vec<Option<Bucket>> {
    let grid = Grid::of(host, view, width);
    let count = ((grid.end - grid.start) / grid.per_cell - 1e-9)
        .ceil()
        .max(0.0) as usize;
    (0..count.min(width))
        .map(|cell| cell_bucket(host, grid, cell))
        .collect()
}

/// Two horizontal raster subcells per terminal column. Subdivision preserves
/// the physical grid's start/end: it must not round a new right edge or double
/// the time span used by axes, statistics, zoom, pan, or pointer hit-testing.
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    reason = "bounded raster indices convert to elapsed-time coordinates"
)]
pub(crate) fn subcell_buckets(host: &HostState, grid: Grid) -> Vec<Option<Bucket>> {
    let step = grid.per_cell / 2.0;
    let count = ((grid.end - grid.start) / grid.per_cell - 1e-9)
        .ceil()
        .max(0.0) as usize;
    (0..count.min(grid.width) * 2)
        .map(|subcell| {
            let from = grid.start + subcell as f64 * step;
            let to = (from + step).min(grid.end);
            bucket_between(host, from, to, step, step < 1.0)
        })
        .collect()
}

/// Durations shared by all hosts on the frame's time axis.
pub(crate) struct Axis {
    pub observed: Duration,
    pub shown: Duration,
    /// `None` follows the live edge; otherwise the age of the window's end.
    pub behind: Option<Duration>,
}

#[allow(
    clippy::cast_precision_loss,
    reason = "sample indices and terminal widths stay far below 2^52"
)]
pub(crate) fn axis(
    hosts: &[HostState],
    view: View,
    width: usize,
    interval: Duration,
    now: SystemTime,
) -> Option<Axis> {
    let (position, first) = hosts
        .iter()
        .filter_map(HostState::first_timed_sample)
        .min_by_key(|(_, entry)| entry.sent)?;
    let observed = now.duration_since(first.sent).unwrap_or_default();
    let shown = interval
        .mul_f64(width as f64 * view.per_cell())
        .min(observed);
    let behind = view
        .end
        .filter(|end| *end < Extent::of(hosts).latest)
        .map(|end| observed.saturating_sub(interval.mul_f64((end - position).max(0.0))));
    Some(Axis {
        observed,
        shown,
        behind,
    })
}

/// Hover text for a cell, e.g. `12s ago · 18:04:23 · 14.2 ms` or, zoomed
/// out, `2m10s ago · 18:02:13 · max 22.0 ms · 1 lost`.
pub fn describe(bucket: &Bucket, now: SystemTime) -> String {
    describe_in(bucket, now, &Local)
}

fn describe_in<Tz: TimeZone>(bucket: &Bucket, now: SystemTime, zone: &Tz) -> String
where
    Tz::Offset: std::fmt::Display,
{
    if bucket.samples == 0 && bucket.first == SystemTime::UNIX_EPOCH {
        return "pending".into();
    }
    let age = now.duration_since(bucket.first).unwrap_or_default();
    let relative = if age < Duration::from_secs(1) {
        "now".to_string()
    } else {
        format!("{} ago", fmt_span(Duration::from_secs(age.as_secs())))
    };
    let at = DateTime::<Utc>::from(bucket.first).with_timezone(zone);
    let today = DateTime::<Utc>::from(now).with_timezone(zone).date_naive();
    let absolute = if at.date_naive() == today {
        at.format("%H:%M:%S").to_string()
    } else {
        at.format("%b %d %H:%M:%S").to_string()
    };
    let mut text = format!("{relative} \u{b7} {absolute}");
    match (bucket.slowest, bucket.samples) {
        (Some(rtt), 1) => {
            let _ = write!(text, " \u{b7} {}", fmt_ms(rtt));
        }
        (Some(rtt), _) => {
            let _ = write!(text, " \u{b7} max {}", fmt_ms(rtt));
        }
        (None, 0) => text.push_str(" \u{b7} pending"),
        (None, 1) => text.push_str(" \u{b7} lost"),
        (None, _) => {}
    }
    if bucket.lost > 0 && bucket.samples > 1 {
        let _ = write!(text, " \u{b7} {} lost", bucket.lost);
    }
    text
}

/// Like `fmt_span`, with one decimal below a minute (`4.8s`, `250ms`).
fn fmt_short(value: Duration) -> String {
    let secs = value.as_secs_f64();
    if secs < 1.0 {
        format!("{}ms", value.as_millis().max(1))
    } else if secs < 60.0 {
        let text = format!("{secs:.1}");
        format!("{}s", text.trim_end_matches(".0"))
    } else {
        fmt_span(value)
    }
}

pub(crate) fn fmt_span(value: Duration) -> String {
    let secs = value.as_secs();
    if secs == 0 {
        format!("{}ms", value.as_millis())
    } else if secs < 60 {
        format!("{secs}s")
    } else if secs < 3600 {
        format!("{}m{:02}s", secs / 60, secs % 60)
    } else {
        format!("{}h{:02}m", secs / 3600, secs % 3600 / 60)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::probe::ProbeEvent;

    /// 2026-10-02 16:00:00 UTC.
    fn t0() -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_hours(497_488)
    }

    fn host_with(samples: &[Option<u64>]) -> HostState {
        let mut host = HostState::new("h".into());
        for (index, sample) in samples.iter().enumerate() {
            let sent = t0() + Duration::from_secs(index as u64);
            let seq = u16::try_from(index % 65_536).unwrap();
            host.apply(match sample {
                Some(ms) => ProbeEvent::Reply {
                    seq,
                    slot: index as u64,
                    rtt: Duration::from_millis(*ms),
                    sent,
                },
                None => ProbeEvent::Lost {
                    seq,
                    slot: index as u64,
                    sent,
                },
            });
        }
        host
    }

    const EXTENT: Extent = Extent {
        oldest: 0.0,
        latest: 1000.0,
    };

    fn at(level: i32, end: Option<f64>) -> View {
        View { level, end }
    }

    #[test]
    fn braille_subdivision_preserves_partial_terminal_edges_and_hover_counts() {
        let mut host = HostState::new("h".into());
        host.set_interval(Duration::from_secs(1));
        for (slot, position, interval, rtt) in [
            (0, Duration::ZERO, Duration::from_secs(1), 10),
            (1, Duration::from_secs(1), Duration::from_millis(250), 90),
        ] {
            host.apply(ProbeEvent::Scheduled {
                slot,
                position,
                interval,
            });
            host.apply(ProbeEvent::Reply {
                seq: 0,
                slot,
                sent: t0() + position,
                rtt: Duration::from_millis(rtt),
            });
        }
        let grid = Grid::of(&host, View::default(), 1);
        assert_eq!(window(&host, View::default(), 1), (1.0, 1.25));
        let raster = subcell_buckets(&host, grid);
        assert_eq!(raster.len(), 2);
        assert_eq!(raster[0].unwrap().slowest, Some(Duration::from_millis(90)));
        assert!(
            raster[1].is_none(),
            "the last half-cell is beyond the captured endpoint"
        );
        assert_eq!(cell_bucket(&host, grid, 0).unwrap().samples, 1);
        assert!(cell_bucket(&host, grid, 1).is_none());
        let stats = host.time_range_stats(grid.start, grid.end);
        assert_eq!(stats.received, 1);
        assert_eq!(stats.current, Some(Duration::from_millis(90)));
    }

    #[test]
    fn terminal_hover_includes_expanded_subcell_replies_without_duplicates() {
        let mut host = HostState::new("h".into());
        host.set_interval(Duration::from_secs(1));
        for (slot, position_ms, rtt) in [(0, 750, 90), (1, 1750, 10)] {
            let position = Duration::from_millis(position_ms);
            host.apply(ProbeEvent::Scheduled {
                slot,
                position,
                interval: Duration::from_secs(1),
            });
            host.apply(ProbeEvent::Reply {
                seq: 0,
                slot,
                sent: t0() + position,
                rtt: Duration::from_millis(rtt),
            });
        }
        let grid = Grid::of(&host, View::default(), 3);
        let raster = subcell_buckets(&host, grid);
        assert_eq!(raster[2].unwrap().samples, 1);
        assert_eq!(raster[3].unwrap().samples, 2);
        let bucket = cell_bucket(&host, grid, 1).unwrap();
        assert_eq!(
            bucket.samples, 2,
            "expanded subcell overlap must not count the spike twice"
        );
        assert_eq!(bucket.slowest, Some(Duration::from_millis(90)));
    }

    #[test]
    fn braille_subcells_follow_rate_changes_without_doubling_the_window() {
        let mut host = HostState::new("h".into());
        host.set_interval(Duration::from_secs(1));
        for (slot, position_ms, interval_ms, rtt) in [
            (0, 0, 2000, Some(10)),
            (1, 2000, 250, Some(90)),
            (2, 2250, 250, None),
            (3, 2500, 500, Some(20)),
        ] {
            let position = Duration::from_millis(position_ms);
            host.apply(ProbeEvent::Scheduled {
                slot,
                position,
                interval: Duration::from_millis(interval_ms),
            });
            host.apply(rtt.map_or(
                ProbeEvent::Lost {
                    seq: 0,
                    slot,
                    sent: t0() + position,
                },
                |rtt| ProbeEvent::Reply {
                    seq: 0,
                    slot,
                    sent: t0() + position,
                    rtt: Duration::from_millis(rtt),
                },
            ));
        }
        let view = View::default();
        let grid = Grid::of(&host, view, 3);
        let raster = subcell_buckets(&host, grid);
        assert_eq!(window(&host, view, 3), (0.0, 3.0));
        assert_eq!(raster.len(), 6);
        assert_eq!(
            raster[0], raster[1],
            "a slow-rate reply still spans one initial interval"
        );
        assert!(raster[2..4].iter().all(Option::is_none));
        assert_eq!(raster[4].unwrap().slowest, Some(Duration::from_millis(90)));
        assert_eq!(
            (raster[4].unwrap().samples, raster[4].unwrap().lost),
            (2, 1)
        );
        assert_eq!(raster[5].unwrap().slowest, Some(Duration::from_millis(20)));
        let hover = cell_bucket(&host, grid, 2).unwrap();
        assert_eq!((hover.samples, hover.lost), (3, 1));
        assert_eq!(hover.slowest, Some(Duration::from_millis(90)));
        let extent = Extent::of(std::slice::from_ref(&host));
        let mut paused = view;
        paused.pan(1, 1, extent);
        assert_eq!(window(&host, paused, 1), (1.0, 2.0));
        assert!(subcell_buckets(&host, Grid::of(&host, paused, 1))
            .iter()
            .all(Option::is_none));
        let durations = axis(
            &[host],
            view,
            3,
            Duration::from_secs(1),
            t0() + Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(durations.shown, Duration::from_secs(3));
    }

    #[test]
    fn zoom_out_aggregates_slowest_and_any_loss() {
        let host = host_with(&[Some(1), Some(9), None, Some(2), Some(3)]);
        let cells = buckets(&host, at(4, None), 10);
        let summary: Vec<_> = cells
            .iter()
            .map(|cell| cell.map(|b| (b.slowest.map(|d| d.as_millis()), b.samples, b.lost)))
            .collect();
        assert_eq!(
            summary,
            vec![
                Some((Some(9), 2, 0)),
                Some((Some(2), 2, 1)),
                Some((Some(3), 1, 0))
            ]
        );
        assert_eq!(cells[1].unwrap().first, t0() + Duration::from_secs(2));
    }

    #[test]
    fn coarse_fractional_cells_keep_partial_edges_and_paused_end() {
        let samples: Vec<_> = (0_u64..400)
            .map(|slot| (!slot.is_multiple_of(100)).then_some(slot))
            .collect();
        let host = host_with(&samples);
        // 2^(33/4) ~= 304.437: the first cell ends at slot 304, not
        // at a cache boundary, and the second is only partly populated.
        assert_eq!(
            buckets(&host, at(33, None), 2),
            vec![
                Some(Bucket {
                    slowest: Some(Duration::from_millis(303)),
                    samples: 304,
                    lost: 4,
                    first: t0(),
                }),
                Some(Bucket {
                    slowest: Some(Duration::from_millis(399)),
                    samples: 96,
                    lost: 0,
                    first: t0() + Duration::from_secs(304),
                }),
            ],
        );
        assert_eq!(
            buckets(&host, at(33, Some(287.25)), 2),
            vec![Some(Bucket {
                slowest: Some(Duration::from_millis(287)),
                samples: 288,
                lost: 3,
                first: t0(),
            })],
        );
    }

    #[test]
    fn zoom_in_spreads_one_sample_over_several_cells() {
        let host = host_with(&[Some(1), Some(9), Some(4)]);
        // Level -4 is one doubling in: 0.5 samples per cell.
        let cells = buckets(&host, at(-4, None), 10);
        let ms: Vec<_> = cells
            .iter()
            .map(|cell| cell.and_then(|b| b.slowest).map(|d| d.as_millis()))
            .collect();
        assert_eq!(
            ms,
            vec![Some(1), Some(1), Some(9), Some(9), Some(4), Some(4)]
        );
    }

    #[test]
    fn zoom_steps_are_fine_grained_and_bounded() {
        let mut view = View::default();
        view.zoom(true, None, 100, EXTENT);
        assert!(
            (view.per_cell() - 0.8409).abs() < 1e-3,
            "{}",
            view.per_cell()
        );
        for _ in 0..100 {
            view.zoom(true, None, 100, EXTENT);
        }
        assert!((view.per_cell() - 1.0 / 64.0).abs() < 1e-9);
    }

    #[test]
    fn zoom_in_and_pan_work_even_when_history_is_short() {
        let short = Extent {
            oldest: 0.0,
            latest: 30.0,
        };
        let mut view = View::default();
        view.zoom(false, None, 100, short);
        assert!(view.is_default(), "nothing hidden, nothing to zoom out to");
        for _ in 0..8 {
            view.zoom(true, None, 100, short);
        }
        // 0.25 samples per cell: 100 cells show 25 of 30 samples.
        view.pan(8, 100, short);
        assert_eq!(view.end, Some(28.0));
        view.pan(1000, 100, short);
        assert_eq!(view.end, Some(25.0), "stops at the oldest full window");
        view.zoom(false, None, 100, short);
        assert_eq!(view.level, -7, "zooming out from a zoomed-in view works");
    }

    #[test]
    fn live_zoom_stays_live() {
        let mut view = View::default();
        view.zoom(false, Some(3), 100, EXTENT);
        assert_eq!(view, at(1, None));
        view.zoom(true, None, 100, EXTENT);
        assert!(view.is_default());
    }

    #[test]
    fn paused_zoom_keeps_anchor_time() {
        let mut view = at(4, Some(600.0));
        // Cell 50 of 100 points at 600 - 200 + 100 = 500.
        view.zoom(true, Some(50), 100, EXTENT);
        let end = view.end.unwrap();
        let start = end - 100.0 * view.per_cell();
        assert!((start + 50.0 * view.per_cell() - 500.0).abs() < 1e-9);
    }

    #[test]
    fn pan_pauses_clamps_and_resumes_live() {
        let mut view = View::default();
        view.pan(10, 100, EXTENT);
        assert_eq!(view.end, Some(990.0));
        view.pan(10_000, 100, EXTENT);
        assert_eq!(
            view.end,
            Some(100.0),
            "cannot pan before the first full window"
        );
        view.pan(-10_000, 100, EXTENT);
        assert_eq!(view.end, None, "panning to now resumes following");
    }

    #[test]
    fn zoom_out_stops_once_everything_fits() {
        let mut view = View::default();
        for _ in 0..100 {
            view.zoom(false, None, 100, EXTENT);
        }
        assert!(100.0 * view.per_cell() >= 1000.0);
        assert!(100.0 * at(view.level - 1, None).per_cell() < 1000.0);
    }

    #[test]
    fn hint_describes_zoom_and_offset() {
        assert_eq!(
            at(8, Some(870.0))
                .hint(EXTENT, Duration::from_secs(1))
                .as_deref(),
            Some("1 cell = 4s \u{b7} 2m10s ago \u{b7} 0 live")
        );
        assert_eq!(
            at(-8, None).hint(EXTENT, Duration::from_secs(1)).as_deref(),
            Some("1 cell = 250ms \u{b7} 0 live")
        );
        assert_eq!(
            at(1, None).hint(EXTENT, Duration::from_secs(1)).as_deref(),
            Some("1 cell = 1.2s \u{b7} 0 live")
        );
        assert_eq!(View::default().hint(EXTENT, Duration::from_secs(1)), None);
    }

    #[test]
    fn describes_hovered_cells_relative_and_absolute() {
        let host = host_with(&[Some(14), None, Some(3), Some(22)]);
        let now = t0() + Duration::from_secs(130);
        let cells = buckets(&host, View::default(), 10);
        assert_eq!(
            describe_in(&cells[0].unwrap(), now, &Utc),
            "2m10s ago \u{b7} 16:00:00 \u{b7} 14.0 ms"
        );
        assert_eq!(
            describe_in(&cells[1].unwrap(), now, &Utc),
            "2m09s ago \u{b7} 16:00:01 \u{b7} lost"
        );
        let zoomed = buckets(&host, at(4, None), 10);
        assert_eq!(
            describe_in(&zoomed[0].unwrap(), now + Duration::from_hours(24), &Utc),
            "24h02m ago \u{b7} Oct 02 16:00:00 \u{b7} max 14.0 ms \u{b7} 1 lost"
        );
    }

    #[test]
    fn frozen_overview_keeps_its_grid_as_new_samples_arrive() {
        let before = host_with(&vec![Some(5); 300]);
        let after = host_with(&vec![Some(5); 600]);
        let frozen = overview(&before, 100, Some(300.0));
        assert_eq!(overview(&after, 100, Some(300.0)), frozen);
        assert_ne!(overview(&after, 100, None), frozen);
        assert_eq!(
            before.time_buckets(frozen.start, frozen.end, frozen.width),
            after.time_buckets(frozen.start, frozen.end, frozen.width)
        );
    }

    #[allow(
        clippy::float_cmp,
        reason = "the last cell must end at the exact stored endpoint"
    )]
    #[test]
    fn overview_fills_width_for_short_hour_and_day_runs_without_inventing_due_probes() {
        for seconds in [10, 3600, 86_400] {
            let mut host = HostState::new("h".into());
            host.set_interval(Duration::from_secs(1));
            for (slot, second, interval) in [(0, 0, seconds - 1), (1, seconds - 1, 1)] {
                host.apply(ProbeEvent::Scheduled {
                    slot,
                    position: Duration::from_secs(second),
                    interval: Duration::from_secs(interval),
                });
                host.apply(ProbeEvent::Reply {
                    slot,
                    seq: u16::try_from(slot).unwrap(),
                    sent: t0() + Duration::from_secs(second),
                    rtt: Duration::from_millis(5),
                });
            }
            let grid = overview(&host, 79, None);
            assert_eq!(grid.range_of(0).0, host.oldest_position());
            assert_eq!(grid.range_of(78).1, host.latest_position());
            let cells = host.time_buckets(grid.start, grid.end, grid.width);
            assert_eq!(cells.len(), 79, "{seconds}s minimap");
            assert_eq!(
                cells
                    .iter()
                    .flatten()
                    .map(|bucket| bucket.samples)
                    .sum::<usize>(),
                2,
                "each due probe occupies exactly one real-time range"
            );
            assert!(cells[1].is_none(), "no deadline was due in the second cell");
            for (cell, actual) in cells.iter().enumerate() {
                let (from, to) = grid.range_of(cell);
                assert_eq!(
                    *actual,
                    host.time_bucket(from, to, false),
                    "{seconds}s cell {cell}"
                );
            }
        }
    }

    #[test]
    fn continuous_batches_preserve_spikes_losses_and_partial_summary_blocks() {
        let mut samples = vec![Some(1); 1001];
        samples[333] = Some(90);
        samples[777] = None;
        let host = host_with(&samples);
        let grid = overview(&host, 7, None);
        let cells = host.time_buckets(grid.start, grid.end, grid.width);
        assert_eq!(
            cells
                .iter()
                .flatten()
                .map(|bucket| bucket.samples)
                .sum::<usize>(),
            1001
        );
        assert_eq!(
            cells
                .iter()
                .flatten()
                .map(|bucket| bucket.lost)
                .sum::<usize>(),
            1
        );
        assert_eq!(
            cells
                .iter()
                .flatten()
                .filter_map(|bucket| bucket.slowest)
                .max(),
            Some(Duration::from_millis(90))
        );
        for (cell, actual) in cells.iter().enumerate() {
            let (from, to) = grid.range_of(cell);
            assert_eq!(*actual, host.time_bucket(from, to, false), "cell {cell}");
        }
    }

    #[test]
    fn continuous_overview_click_and_drag_round_trip_through_the_same_time_scale() {
        let host = host_with(&vec![Some(5); 600]);
        let grid = overview(&host, 79, None);
        let extent = Extent::of(std::slice::from_ref(&host));
        let mut view = at(-4, None);
        let center = grid.center_of(20);
        view.center_on(center, 79, extent);
        let clicked = view.end.unwrap();
        assert!((clicked - (center + 79.0 * view.per_cell() / 2.0)).abs() < 1e-9);
        view.shift(3.0 * grid.per_cell, 79, extent);
        assert!((view.end.unwrap() - clicked - 3.0 * grid.per_cell).abs() < 1e-9);
        view.shift(-3.0 * grid.per_cell, 79, extent);
        assert!((view.end.unwrap() - clicked).abs() < 1e-9);
    }

    #[test]
    fn overview_covers_all_history_and_marks_the_window() {
        let host = host_with(&vec![Some(5); 300]);
        let full = overview(&host, 400, None);
        assert_eq!(
            window_cells(full, window(&host, View::default(), 400)),
            (0, 400)
        );
        let grid = overview(&host, 100, None);
        assert_eq!((grid.start, grid.end, grid.per_cell), (0.0, 300.0, 3.0));
        assert_eq!(
            window_cells(grid, window(&host, View::default(), 100)),
            (66, 100)
        );
        assert!((grid.center_of(10) - 31.5).abs() < 1e-9);
    }

    #[test]
    fn center_on_and_shift_move_the_window_and_resume_live() {
        let mut view = View::default();
        view.center_on(300.0, 100, EXTENT);
        assert_eq!(view.end, Some(350.0));
        view.shift(-1000.0, 100, EXTENT);
        assert_eq!(view.end, Some(100.0));
        view.shift(5000.0, 100, EXTENT);
        assert_eq!(view.end, None);
    }

    #[allow(
        clippy::float_cmp,
        reason = "retained endpoints must not drift at fractional scales"
    )]
    #[test]
    fn overview_covers_the_oldest_retained_sample_at_unaligned_boundaries() {
        // Retained slots [1, 86401): one slot trimmed. At 675 cells a pure
        // length check picks 128 samples per cell, but the aligned grid would
        // then start at slot 128.
        let host = host_with(&vec![Some(5); 86_401]);
        assert_eq!(host.oldest_index(), 1);
        let grid = overview(&host, 675, None);
        assert_eq!(grid.start, host.oldest_position());
        assert_eq!(grid.range_of(674).1, host.latest_position());
    }

    #[test]
    fn mixed_rate_cells_hover_and_navigation_share_elapsed_time() {
        let mut host = HostState::new("h".into());
        for (slot, position_ms, interval_ms) in [(0, 0, 2000), (1, 2000, 500), (2, 2500, 500)] {
            host.apply(ProbeEvent::Scheduled {
                slot,
                position: Duration::from_millis(position_ms),
                interval: Duration::from_millis(interval_ms),
            });
            if slot != 2 {
                host.apply(ProbeEvent::Reply {
                    seq: 0,
                    slot,
                    sent: t0() + Duration::from_millis(position_ms),
                    rtt: Duration::from_millis(if slot == 0 { 1 } else { 9 }),
                });
            }
        }
        let view = at(-4, None);
        let chart = buckets(&host, view, 10);
        assert_eq!(
            chart
                .iter()
                .map(|bucket| bucket.map(|b| b.samples))
                .collect::<Vec<_>>(),
            vec![Some(1), Some(1), None, None, Some(1), Some(0)]
        );
        assert_eq!(
            describe_in(&chart[4].unwrap(), t0() + Duration::from_secs(5), &Utc),
            "3s ago \u{b7} 16:00:02 \u{b7} 9.0 ms"
        );
        assert_eq!(
            describe_in(&chart[5].unwrap(), t0() + Duration::from_secs(5), &Utc),
            "2s ago \u{b7} 16:00:02 \u{b7} pending"
        );
        let extent = Extent::of(&[host.clone()]);
        assert_eq!(
            extent,
            Extent {
                oldest: 0.0,
                latest: 3.0
            }
        );
        let mut paused = view;
        paused.pan(2, 2, extent);
        assert_eq!(paused.end, Some(2.0));
        assert_eq!(window(&host, paused, 2), (1.0, 2.0));
        assert_eq!(buckets(&host, paused, 2), vec![None, None]);
        let mut anchored = paused;
        anchored.zoom(true, Some(0), 2, extent);
        assert!((anchored.end.unwrap() - 2.0 * anchored.per_cell() - 1.0).abs() < 1e-9);
        let grid = overview(&host, 2, None);
        assert!((grid.per_cell * 2.0 - 3.0).abs() < 1e-9);
        assert_eq!(window_cells(grid, window(&host, paused, 2)), (0, 2));
        let axis = axis(
            &[host],
            paused,
            2,
            Duration::from_secs(1),
            t0() + Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(axis.shown, Duration::from_secs(1));
        assert_eq!(axis.behind, Some(Duration::from_secs(3)));
    }

    #[test]
    #[allow(
        clippy::float_cmp,
        reason = "sparse endpoints must not drift at fractional scales"
    )]
    fn overview_fits_sparse_history_far_beyond_the_old_sample_count_zoom_limit() {
        let mut host = HostState::new("h".into());
        host.set_interval(Duration::from_millis(10));
        for (slot, position) in [(0, Duration::ZERO), (1, Duration::from_hours(1440))] {
            host.apply(ProbeEvent::Scheduled {
                slot,
                position,
                interval: Duration::from_mins(1),
            });
        }
        let grid = overview(&host, 2, None);
        assert_eq!(grid.start, host.oldest_position());
        assert_eq!(grid.range_of(1).1, host.latest_position());
        assert!(grid.per_cell > 2_f64.powi(48 / 4));
    }
}
