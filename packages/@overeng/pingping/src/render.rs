//! Pure frame layout: host states -> lines of role-tagged spans. Styling is
//! applied later by the theme, so layout is testable as plain text.
#[cfg(test)]
#[path = "render/summary_tests.rs"]
mod summary_tests;

#[path = "render/drop.rs"]
mod drop;

use std::fmt::Write as _;
use std::time::{Duration, SystemTime};

use unicode_width::UnicodeWidthStr;

use crate::stats::{Bucket, HostState, Stats, Status};
use crate::timeline::{self, Extent, Grid, View};

#[cfg(test)]
mod bench;
mod keys;
use keys::key_hint;
mod hover;
mod raster;
mod sidecar;
use raster::render_sparkline;

/// Shared timeline state for a frame: the zoom/pan view, run-start scale,
/// and current probe rate.
pub struct Timeline {
    pub view: View,
    /// Fixed run-start interval used for timeline coordinates and zoom labels.
    pub interval: Duration,
    /// Current interval used by the next scheduled probe and the summary.
    pub current_interval: Duration,
    pub stats_scope: StatsScope,
    /// Physical terminal column under the pointer, if any.
    pub hover: Option<Hover>,
    /// Current clock for axes and path-change ages.
    pub now: SystemTime,
    /// Frozen readout clock and overview extent while hovering a live cell.
    pub hover_now: Option<SystemTime>,
    pub overview_end: Option<f64>,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum StatsScope {
    #[default]
    Window,
    Run,
}

impl StatsScope {
    pub fn toggled(self) -> Self {
        match self {
            Self::Window => Self::Run,
            Self::Run => Self::Window,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Window => "window",
            Self::Run => "run",
        }
    }
}

fn visible_stats(host: &HostState, timeline: &Timeline, width: usize, footer: bool) -> Stats {
    if timeline.stats_scope == StatsScope::Run || !footer {
        return host.run_stats();
    }
    let (from, to) = timeline::window(host, timeline.view, width);
    host.time_range_stats(from, to)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Hover {
    pub host: usize,
    /// Terminal-column index from the left edge of the timeline.
    pub cell: usize,
    /// On the host's overview line rather than its timeline.
    pub overview: bool,
}

/// A note occupies the identity line, not a timeline cell.
pub const NOTE_CELL: usize = usize::MAX;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Rule,
    Label,
    PathNote,
    Host,
    Pill,
    Spark,
    /// RTT above the hybrid threshold: amber, distinct from failed pings.
    RttElevated,
    /// Highest hybrid RTT band: orange, never failed-ping red.
    RttHigh,
    /// Lowest RTT-history stem, drawn fainter than higher stems.
    Baseline,
    /// Minimap cells outside the visible window: the faintest content color.
    Faint,
    /// Muted loss color for minimap cells inside the visible window.
    MinimapLoss,
    /// Muted loss color for minimap cells outside the visible window.
    MinimapLossFaint,
    /// Hover description next to the pointer.
    Tooltip,
    Value,
    Good,
    Bad,
    Dim,
    Plain,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Span {
    pub role: Role,
    pub text: String,
    /// Background tint over the role's colors, so marked cells keep their
    /// glyph and color (R17).
    pub tint: Tint,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tint {
    None,
    /// The cell under the pointer.
    Hover,
    /// The visible window on an overview.
    Window,
    PathChange,
}

pub type Line = Vec<Span>;
type RowsOutput = (Vec<Line>, (usize, usize), Option<(usize, String)>);

#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum Layout {
    /// Full block per host, as in the single-host view.
    Stacked,
    /// One row per host.
    Rows,
}

impl Layout {
    pub fn toggled(self) -> Self {
        match self {
            Layout::Stacked => Layout::Rows,
            Layout::Rows => Layout::Stacked,
        }
    }
}

pub struct Frame {
    pub lines: Vec<Line>,
    /// Column and width of the RTT timeline, for mouse anchoring.
    pub timeline: (usize, usize),
    /// `(line, host, is_overview)` for every timeline and overview line.
    pub timeline_lines: Vec<(usize, usize, bool)>,
    /// Per host, the overview grid when its overview is drawn.
    pub overviews: Vec<Option<Grid>>,
    /// `(line, host, start, end)` for the visible path-note hit areas.
    pub notes: Vec<(usize, usize, usize, usize)>,
}

const RULE: &str = "\u{2502} ";
const LABEL_WIDTH: usize = 10;

fn span(role: Role, text: impl Into<String>) -> Span {
    Span {
        role,
        text: text.into(),
        tint: Tint::None,
    }
}

/// Lays out all hosts for a terminal of `width` x `height` cells.
/// `footer` enables the dim trailing key hint while running.
pub fn frame(
    hosts: &[HostState],
    layout: Layout,
    timeline: &Timeline,
    width: usize,
    height: usize,
    footer: bool,
) -> Frame {
    if layout == Layout::Stacked {
        if let Some(frame) = sidecar::frame(hosts, timeline, width, height, footer) {
            return frame;
        }
    }
    let hint = timeline.view.hint(Extent::of(hosts), timeline.interval);
    let (mut lines, origin, tooltip) = rows(hosts, timeline, width, footer);
    let timeline_lines = (0..hosts.len())
        .map(|index| (index + 1, index, false))
        .collect();
    if let Some(axis) = time_axis(hosts, timeline, origin) {
        lines.push(axis);
    }
    lines.push(vec![]);
    lines.push(summary(hosts, timeline.current_interval, width));
    if footer {
        let mut hint_line = key_hint(
            Layout::Rows,
            layout,
            timeline.stats_scope,
            hint.as_deref(),
            timeline.hover_now.is_some(),
        );
        if let Some((pointer_col, description)) = tooltip {
            hover::append(&mut hint_line, &description, width, pointer_col);
        }
        lines.push(hint_line);
    }
    let available = height.saturating_sub(1);
    if lines.len() > available {
        let hidden = lines.len().saturating_sub(available.saturating_sub(1));
        lines.truncate(available.saturating_sub(1));
        if available > 0 {
            lines.push(vec![span(
                Role::Dim,
                format!("  + {hidden} more lines (enlarge terminal)"),
            )]);
        }
    }
    let overviews = vec![None; hosts.len()];
    Frame {
        lines,
        timeline: origin,
        timeline_lines,
        overviews,
        notes: Vec::new(),
    }
}

fn stacked_spark_width(width: usize) -> usize {
    width.saturating_sub(RULE.width() + 1)
}

fn block(
    host: &HostState,
    timeline: &Timeline,
    stats: Stats,
    overview: Grid,
    hover: Option<Hover>,
    width: usize,
    chart_rows: usize,
) -> Vec<Line> {
    let row = |label: &str, value: Vec<Span>| {
        let mut line = vec![
            span(Role::Rule, RULE),
            span(Role::Label, format!("{label:<LABEL_WIDTH$}")),
        ];
        line.extend(value);
        line
    };
    let ms =
        |value: Option<Duration>| vec![span(Role::Value, value.map_or_else(|| "-".into(), fmt_ms))];

    let address = match &host.status {
        Status::Resolving => vec![span(Role::Dim, "resolving\u{2026}")],
        Status::Running(addr) => vec![span(Role::Pill, format!(" {addr} "))],
        Status::Failed { reason, .. } => vec![span(Role::Bad, format!("\u{2717} {reason}"))],
    };
    let spark_width = stacked_spark_width(width);
    let main_hover = hover
        .filter(|hover| !hover.overview)
        .map(|hover| hover.cell);
    let (spark, mut hovered) = sparkline(host, timeline.view, spark_width, chart_rows, main_hover);
    let overview_line = {
        let grid = overview;
        let marked =
            timeline::window_cells(grid, timeline::window(host, timeline.view, spark_width));
        let over_hover = hover.filter(|hover| hover.overview).map(|hover| hover.cell);
        let (spans, over_hovered) = overview_sparkline(host, grid, spark_width, over_hover, marked);
        hovered = hovered.or(over_hovered);
        let mut line = vec![span(Role::Rule, RULE)];
        line.extend(spans);
        line
    };
    let received = if stats.completed() == 0 {
        vec![span(Role::Value, "-")]
    } else {
        vec![span(
            Role::Value,
            format!("{} of {}", stats.received, stats.completed()),
        )]
    };

    let mut lines = vec![
        row("Host", vec![span(Role::Host, host.host.clone())]),
        // The pill's leading pad sits in the label gutter so the address text
        // aligns with the other values.
        {
            let mut line = vec![
                span(Role::Rule, RULE),
                span(
                    Role::Label,
                    format!("{:<w$}", "Address", w = LABEL_WIDTH - 1),
                ),
            ];
            if !matches!(host.status, Status::Running(_)) {
                line.push(span(Role::Plain, " "));
            }
            line.extend(address);
            append_note(&mut line, host, timeline.now, width);
            line
        },
    ];
    for bars in spark {
        let mut line = vec![span(Role::Rule, RULE)];
        line.extend(bars);
        lines.push(line);
    }
    lines.push(overview_line);
    lines.extend([
        row("Current", ms(stats.current)),
        row("Min", ms(stats.min)),
        row("Avg", ms(stats.avg())),
        row("Max", ms(stats.max)),
        row("Received", received),
        row("Loss", loss(stats)),
    ]);
    if let Some((pointer_col, description)) = tooltip(host, timeline, spark_width, hover, hovered) {
        identity_tooltip(&mut lines[1], &description, width, pointer_col);
    }
    lines
}

/// Replaces the path note with a cursor-near readout without adding a row.
fn identity_tooltip(line: &mut Line, description: &str, width: usize, pointer_col: usize) {
    drop::clear_notice(line);
    if let Some(note) = line.iter().position(|span| span.role == Role::PathNote) {
        line.truncate(note.saturating_sub(1));
    }
    hover::append(line, description, width, pointer_col);
}

fn loss(stats: Stats) -> Vec<Span> {
    match stats.loss_pct() {
        None => vec![span(Role::Value, "-")],
        Some(pct) => {
            let role = if stats.lost == 0 {
                Role::Good
            } else if pct < 5.0 {
                Role::Value
            } else {
                Role::Bad
            };
            vec![span(role, fmt_pct(pct))]
        }
    }
}

fn append_note(line: &mut Line, host: &HostState, now: SystemTime, width: usize) {
    let note = drop::notice(host, now).or_else(|| {
        host.path
            .label(now)
            .map(|label| span(Role::PathNote, label))
    });
    let uptime = match host.boot {
        crate::uptime::State::Disabled => None,
        crate::uptime::State::Unavailable => Some(span(Role::Dim, uptime_label(None, now))),
        crate::uptime::State::Boot(boot) => Some(span(Role::Dim, uptime_label(Some(boot), now))),
    };
    let total_width = note.as_ref().map_or(0, |note| note.text.width())
        + uptime.as_ref().map_or(0, |uptime| uptime.text.width())
        + usize::from(note.is_some() && uptime.is_some()) * 3;
    if total_width == 0 {
        return;
    }
    let used: usize = line.iter().map(|span| span.text.width()).sum();
    let Some(start) = width
        .checked_sub(total_width)
        .filter(|start| *start >= used + 3)
    else {
        return;
    };
    line.push(span(Role::Plain, " ".repeat(start - used)));
    if let Some(note) = note {
        line.push(note);
        if uptime.is_some() {
            line.push(span(Role::Dim, " · "));
        }
    }
    if let Some(uptime) = uptime {
        line.push(uptime);
    }
}

fn uptime_label(boot: Option<SystemTime>, now: SystemTime) -> String {
    let Some(uptime) = boot.and_then(|boot| now.duration_since(boot).ok()) else {
        return "up –".into();
    };
    let hours = uptime.as_secs() / 3600;
    if hours >= 24 {
        format!("up {}d{}h", hours / 24, hours % 24)
    } else if hours > 0 {
        format!("up {hours}h{}m", uptime.as_secs() / 60 % 60)
    } else {
        format!("up {}m", uptime.as_secs() / 60)
    }
}

#[cfg(test)]
#[test]
fn uptime_note_renders_label_and_dim_placeholder() {
    let now = SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000);
    let mut host = HostState::new("host-a".into());
    host.path.note = Some(crate::path::Note {
        text: "tailnet direct".into(),
        endpoint: None,
        interface: None,
        source: None,
    });
    host.boot = crate::uptime::State::Boot(now - Duration::from_hours(14 * 24 + 22));
    let mut line = vec![span(Role::Plain, "host-a")];
    append_note(&mut line, &host, now, 80);
    let text: String = line.iter().map(|span| span.text.as_str()).collect();
    assert!(text.ends_with("tailnet direct · up 14d22h"));
    host.boot = crate::uptime::State::Unavailable;
    let mut line = vec![span(Role::Plain, "host-a")];
    append_note(&mut line, &host, now, 80);
    assert!(line
        .iter()
        .any(|span| span.role == Role::Dim && span.text == "up –"));
    host.boot = crate::uptime::State::Disabled;
    let mut line = vec![span(Role::Plain, "host-a")];
    append_note(&mut line, &host, now, 80);
    assert!(!line.iter().any(|span| span.text.starts_with("up ")));
}

fn note_region(line: &Line) -> Option<(usize, usize)> {
    let mut column = 0;
    for span in line {
        let end = column + span.text.width();
        if span.role == Role::PathNote {
            return Some((column, end));
        }
        column = end;
    }
    None
}

fn tooltip(
    host: &HostState,
    timeline: &Timeline,
    width: usize,
    hover: Option<Hover>,
    hovered: Option<(usize, Bucket)>,
) -> Option<(usize, String)> {
    if hover.is_some_and(|hover| hover.cell == NOTE_CELL) {
        return Some((width, host.path.note.as_ref()?.tooltip()));
    }
    let (cell, bucket) = hovered?;
    let grid = if hover.is_some_and(|hover| hover.overview) {
        timeline::overview(host, width, timeline.overview_end)
    } else {
        Grid::of(host, timeline.view, width)
    };
    let (from, to) = grid.range_of(cell);
    let mut description = timeline::describe(&bucket, timeline.hover_now.unwrap_or(timeline.now));
    if let Some(change) = host.path_change_in(from, to) {
        let _ = write!(description, " · {} → {}", change.old, change.new);
    }
    Some((RULE.width() + cell, description))
}

/// RTT history with two horizontal Braille stems per physical terminal column.
/// Heights map RTTs directly to the chart's four dots per row, using the
/// visible scale floor/span; no intermediate eight-level glyph quantization.
fn sparkline(
    host: &HostState,
    view: View,
    width: usize,
    height: usize,
    hover: Option<usize>,
) -> (Vec<Line>, Option<(usize, Bucket)>) {
    if host.history_is_empty() {
        return (vec![Vec::new(); height], None);
    }
    let grid = Grid::of(host, view, width);
    let cells = timeline::subcell_buckets(host, grid);
    render_sparkline(host, grid, &cells, height, hover, None)
}

fn overview_sparkline(
    host: &HostState,
    grid: Grid,
    width: usize,
    hover: Option<usize>,
    window: (usize, usize),
) -> (Vec<Span>, Option<(usize, Bucket)>) {
    if host.history_is_empty() {
        return (Vec::new(), None);
    }
    let cells = host.time_buckets(grid.start, grid.end, width * 2);
    let (mut lines, hovered) = render_sparkline(host, grid, &cells, 1, hover, Some(window));
    (lines.pop().unwrap_or_default(), hovered)
}

fn rows(hosts: &[HostState], timeline: &Timeline, width: usize, footer: bool) -> RowsOutput {
    let mut tooltip = None;
    let host_w = hosts
        .iter()
        .map(|h| h.host.width())
        .max()
        .unwrap_or(4)
        .max(4);
    let addr_w = hosts
        .iter()
        .map(|h| h.address().map_or(1, |a| a.to_string().len()))
        .max()
        .unwrap_or(7)
        .max(7);
    let current_w = hosts
        .iter()
        .map(|host| drop::current_width(host, timeline.now))
        .max()
        .unwrap_or(9);
    let stats_w = 2 + current_w + 9 + 9 + 7;
    let spark_w = width.saturating_sub(RULE.width() + host_w + 2 + addr_w + 2 + stats_w + 1);

    let header = vec![
        span(Role::Plain, "  "),
        span(
            Role::Label,
            format!(
                "{:<host_w$}  {:<addr_w$}  {:<spark_w$}  {:>current_w$}{:>9}{:>9}{:>7}",
                "Host", "Address", "", "Current", "Avg", "Max", "Loss"
            ),
        ),
    ];
    let mut lines = vec![header];
    for (index, host) in hosts.iter().enumerate() {
        let pad = host_w - host.host.width();
        let mut line = vec![
            span(Role::Rule, RULE),
            span(Role::Host, host.host.clone()),
            span(Role::Plain, " ".repeat(pad + 2)),
        ];
        match &host.status {
            Status::Failed { reason, .. } => {
                line.push(span(Role::Bad, format!("\u{2717} {reason}")));
                lines.push(line);
                continue;
            }
            Status::Resolving => line.push(span(Role::Dim, format!("{:<addr_w$}", "\u{2026}"))),
            Status::Running(addr) => {
                line.push(span(Role::Label, format!("{:<addr_w$}", addr.to_string())));
            }
        }
        line.push(span(Role::Plain, "  "));
        let spark = if host.history_is_empty() {
            vec![]
        } else {
            let hover = timeline
                .hover
                .filter(|hover| hover.host == index)
                .map(|hover| hover.cell);
            let (mut chart, hovered) = sparkline(host, timeline.view, spark_w, 1, hover);
            if let Some((pointer_col, description)) = self::tooltip(
                host,
                timeline,
                spark_w,
                timeline.hover.filter(|hover| hover.host == index),
                hovered,
            ) {
                let origin = RULE.width() + host_w + 2 + addr_w + 2;
                tooltip = Some((
                    pointer_col + origin - RULE.width(),
                    format!("{}: {description}", host.host),
                ));
            }
            chart.pop().unwrap_or_default()
        };
        let used: usize = spark.iter().map(|s| s.text.width()).sum();
        line.extend(spark);
        line.push(span(
            Role::Plain,
            " ".repeat(spark_w.saturating_sub(used) + 2),
        ));
        let stats = visible_stats(host, timeline, spark_w, footer);
        let cell =
            |value: Option<Duration>| format!("{:>9}", value.map_or_else(|| "-".into(), fmt_ms));
        line.push(drop::current(host, timeline.now, current_w, stats.current));
        line.push(span(Role::Value, cell(stats.avg())));
        line.push(span(Role::Value, cell(stats.max)));
        let mut loss_spans = loss(stats);
        for s in &mut loss_spans {
            s.text = format!("{:>7}", s.text);
        }
        line.extend(loss_spans);
        lines.push(line);
    }
    (
        lines,
        (RULE.width() + host_w + 2 + addr_w + 2, spark_w),
        tooltip,
    )
}

fn summary(hosts: &[HostState], current_interval: Duration, width: usize) -> Line {
    let sent: u64 = hosts.iter().map(HostState::sent).sum();
    let completed: u32 = hosts.iter().map(HostState::completed).sum();
    let lost: u32 = hosts.iter().map(|h| h.lost).sum();
    let count = match hosts.len() {
        1 => "1 host".to_string(),
        n => format!("{n} hosts"),
    };
    let network = hosts.iter().find_map(|host| host.network.as_ref());
    let label = network.map(|info| info.label());
    let network_width = network.map_or(0, |info| {
        3 + label.as_ref().map_or(0, |label| label.width())
            + info.flags().map(|flag| 3 + flag.width()).sum::<usize>()
    });
    let egress = hosts
        .iter()
        .find_map(|host| host.egress.info.as_ref())
        .map(crate::egress::Info::label);
    let available = width
        .saturating_sub(2 + network_width + egress.as_ref().map_or(0, |label| 3 + label.width()));
    let mut text = format!("{count} \u{b7} every {current_interval:?} \u{b7} {sent} sent");
    if network.is_some() && text.width() > available {
        text = format!("{count} · every {current_interval:?}");
        if text.width() > available {
            text = count;
        }
    }
    if completed > 0 {
        let loss_text = format!(
            " · {} loss",
            fmt_pct(f64::from(lost) * 100.0 / f64::from(completed))
        );
        if network.is_none() || text.width() + loss_text.width() <= available {
            text.push_str(&loss_text);
        }
    }
    if let Some(fastest) = hosts
        .iter()
        .filter_map(|h| h.avg().map(|avg| (h, avg)))
        .min_by_key(|(_, avg)| *avg)
    {
        let fastest = format!(" · fastest {} {}", fastest.0.host, fmt_ms(fastest.1));
        if network.is_none() || text.width() + fastest.width() <= available {
            text.push_str(&fastest);
        }
    }
    let mut line = vec![span(Role::Plain, "  "), span(Role::Dim, text)];
    if let Some(info) = network {
        line.push(span(
            Role::Label,
            format!(" · {}", label.unwrap_or_default()),
        ));
        for flag in info.flags() {
            line.push(span(Role::Label, " · "));
            line.push(span(Role::Value, flag));
        }
    }
    if let Some(label) = egress {
        line.push(span(Role::Dim, format!(" · {label}")));
    }
    let version = crate::VERSION.as_str();
    let used: usize = line.iter().map(|span| span.text.width()).sum();
    if used + 12 + version.width() <= width {
        line.push(span(Role::Dim, format!(" · pingping {version}")));
    }
    line
}

/// One muted axis below all host blocks, aligned with their chart columns.
fn time_axis(
    hosts: &[HostState],
    timeline: &Timeline,
    (col, width): (usize, usize),
) -> Option<Line> {
    let axis = timeline::axis(hosts, timeline.view, width, timeline.interval, timeline.now)?;
    let left = format!("{} observed", timeline::fmt_span(axis.observed));
    let shown = format!("{} shown", timeline::fmt_span(axis.shown));
    let behind = axis
        .behind
        .or_else(|| timeline.hover_now.map(|_| Duration::ZERO));
    let right = behind.map_or_else(
        || "now".into(),
        |age| format!("{} ago", timeline::fmt_span(age)),
    );
    let text = axis_labels(&left, &shown, &right, width);
    Some(vec![
        span(Role::Rule, RULE),
        span(Role::Plain, " ".repeat(col.saturating_sub(RULE.width()))),
        span(Role::Label, text),
    ])
}

/// The overview owns this scale; its window mark uses the very same grid.
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    reason = "overview positions are nonnegative and far below 2^52"
)]
fn overview_axis(
    hosts: &[HostState],
    timeline: &Timeline,
    (col, width): (usize, usize),
    grid: Grid,
) -> Option<Line> {
    let axis = timeline::axis(hosts, timeline.view, width, timeline.interval, timeline.now)?;
    let host = hosts.last()?;
    let marked = timeline::window_cells(grid, timeline::window(host, timeline.view, width));
    let mut text = bracket_labels(
        &format!("{} ago", timeline::fmt_span(axis.observed)),
        &timeline::fmt_span(axis.shown),
        marked,
        width,
    );
    if timeline.hover_now.is_some() {
        let right = format!(
            "{} ago",
            timeline::fmt_span(axis.behind.unwrap_or_default())
        );
        let left_width = width.saturating_sub(right.width() + 1);
        if let Some((end, _)) = text.char_indices().nth(left_width) {
            text.truncate(end);
        }
        text.push_str(&" ".repeat(width.saturating_sub(text.width() + right.width())));
        text.push_str(&right);
    }
    Some(vec![
        span(Role::Rule, RULE),
        span(Role::Plain, " ".repeat(col.saturating_sub(RULE.width()))),
        span(Role::Label, text),
    ])
}

fn bracket_labels(left: &str, label: &str, marked: (usize, usize), width: usize) -> String {
    if width < 2 {
        return " ".repeat(width);
    }
    let end = marked.1.min(width).max(2);
    let start = marked.0.min(end - 2);
    let mut cells = vec![' '; width];
    cells[start] = '├';
    cells[end - 1] = '┤';
    cells[start + 1..end - 1].fill('─');
    let label_width = label.width();
    let placement = if label_width + 2 <= end - start {
        Some(start + (end - start - label_width) / 2)
    } else if end + 1 + label_width <= width {
        Some(end + 1)
    } else {
        start.checked_sub(label_width + 1)
    };
    let mut occupied_start = start;
    let mut occupied_end = end;
    if let Some(at) = placement {
        for (cell, ch) in cells[at..at + label_width].iter_mut().zip(label.chars()) {
            *cell = ch;
        }
        occupied_start = occupied_start.min(at);
        occupied_end = occupied_end.max(at + label_width);
    }
    if left.width() < occupied_start {
        for (cell, ch) in cells.iter_mut().zip(left.chars()) {
            *cell = ch;
        }
    }
    if occupied_end < width.saturating_sub(3) {
        cells[width - 3..].copy_from_slice(&['n', 'o', 'w']);
    }
    cells.into_iter().collect()
}

fn axis_labels(left: &str, shown: &str, right: &str, width: usize) -> String {
    // Duration labels are ASCII; keep their right edge even at tiny widths.
    let right = &right[right.len().saturating_sub(width)..];
    let right_start = width.saturating_sub(right.width());
    let arrows = format!("◂ {shown} ▸");
    let fits_center = |middle: &str| {
        let start = width.saturating_sub(middle.width()) / 2;
        (start + middle.width() + 2 <= right_start).then_some(start)
    };
    let (middle, start, keep_left) = if let Some(start) = fits_center(&arrows) {
        (arrows.as_str(), start, left.width() + 2 <= start)
    } else if let Some(start) = fits_center(shown) {
        (shown, start, false)
    } else {
        ("", 0, false)
    };
    let mut text = String::with_capacity(width + middle.len());
    if keep_left {
        text.push_str(left);
    }
    if !middle.is_empty() {
        text.push_str(&" ".repeat(start.saturating_sub(text.width())));
        text.push_str(middle);
    }
    text.push_str(&" ".repeat(right_start.saturating_sub(text.width())));
    text.push_str(right);
    text
}

pub fn fmt_ms(value: Duration) -> String {
    let ms = value.as_secs_f64() * 1000.0;
    if ms >= 100.0 {
        format!("{ms:.0} ms")
    } else if ms >= 1.0 {
        format!("{ms:.1} ms")
    } else {
        format!("{ms:.2} ms")
    }
}

fn fmt_pct(pct: f64) -> String {
    if pct == 0.0 || pct >= 10.0 || (pct - pct.round()).abs() < 0.05 {
        format!("{pct:.0}%")
    } else {
        format!("{pct:.1}%")
    }
}

/// Truncates a line to `width` cells so redraws never wrap.
pub fn clip(line: &Line, width: usize) -> Line {
    let mut out = Vec::new();
    let mut used = 0;
    for s in line {
        let w = s.text.width();
        if used + w <= width {
            used += w;
            out.push(s.clone());
            continue;
        }
        let mut text = String::new();
        for ch in s.text.chars() {
            let cw = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
            if used + cw > width {
                break;
            }
            used += cw;
            text.push(ch);
        }
        out.push(Span {
            role: s.role,
            text,
            tint: s.tint,
        });
        break;
    }
    out
}

#[cfg(test)]
pub fn plain(lines: &[Line]) -> String {
    lines
        .iter()
        .map(|line| {
            line.iter()
                .map(|s| s.text.as_str())
                .collect::<String>()
                .trim_end()
                .to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::probe::ProbeEvent;

    pub(super) const LIVE: Timeline = Timeline {
        view: View {
            level: 0,
            end: None,
        },
        interval: Duration::from_secs(1),
        current_interval: Duration::from_secs(1),
        stats_scope: StatsScope::Window,
        hover: None,
        now: SystemTime::UNIX_EPOCH,
        hover_now: None,
        overview_end: None,
    };

    /// 2026-10-02 16:00:00 UTC.
    pub(super) fn t0() -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_hours(497_488)
    }

    fn host(name: &str, addr: &str, rtts_ms: &[u64], lost: u32) -> HostState {
        let mut state = HostState::new(name.into());
        state.apply(ProbeEvent::Resolved(addr.parse().unwrap()));
        for (i, ms) in rtts_ms.iter().enumerate() {
            state.apply(ProbeEvent::Reply {
                seq: u16::try_from(i).unwrap(),
                slot: i as u64,
                rtt: Duration::from_micros(ms * 100),
                sent: t0() + Duration::from_secs(i as u64),
            });
        }
        for k in 0..lost {
            state.apply(ProbeEvent::Lost {
                seq: 0,
                slot: (rtts_ms.len() + k as usize) as u64,
                sent: t0() + Duration::from_secs(u64::from(lost)),
            });
        }
        state
    }

    #[test]
    fn path_notes_reserve_identity_space_and_drop_before_collision() {
        let mut host = host("host-a", "100.64.100.10", &[10, 20], 0);
        host.path.note = Some(crate::path::Note {
            text: "tailnet direct".into(),
            endpoint: Some("203.0.113.1:41641".into()),
            interface: None,
            source: Some("100.64.0.1".parse().unwrap()),
        });
        for width in [40, 60, 90, 110, 180] {
            let frame = frame(
                std::slice::from_ref(&host),
                Layout::Stacked,
                &LIVE,
                width,
                40,
                true,
            );
            if width == 40 {
                assert!(frame.notes.is_empty());
                continue;
            }
            let (line, _, start, end) = frame.notes[0];
            let address_end: usize = frame.lines[line]
                .iter()
                .take_while(|span| span.role != Role::Pill)
                .map(|span| span.text.width())
                .sum::<usize>()
                + frame.lines[line]
                    .iter()
                    .find(|span| span.role == Role::Pill)
                    .unwrap()
                    .text
                    .width();
            assert!(start >= address_end + 3);
            assert_eq!(end, width);
            assert!(plain(&frame.lines).contains("tailnet direct"));
            assert!(!plain(&frame.lines).contains("203.0.113.1"));
        }
        assert!(frame(&[host], Layout::Rows, &LIVE, 180, 40, true)
            .notes
            .is_empty());
    }

    #[test]
    fn path_hover_details_and_changed_timeline_slot() {
        let mut host = host("host-a", "100.64.0.1", &[10, 20, 30], 0);
        let note = |text: &str| {
            Some(crate::path::Note {
                text: text.into(),
                endpoint: Some("203.0.113.1:41641".into()),
                interface: None,
                source: Some("100.64.0.1".parse().unwrap()),
            })
        };
        host.path.update(note("tailnet DERP nue"), 0, t0());
        host.path.update(note("tailnet direct"), 1, t0());
        let timeline = Timeline {
            now: t0() + Duration::from_secs(1),
            ..LIVE
        };
        let frame = frame(
            std::slice::from_ref(&host),
            Layout::Stacked,
            &timeline,
            180,
            40,
            true,
        );
        for &(line, _, overview) in &frame.timeline_lines {
            if !overview {
                let mut column = 0;
                let marked = frame.lines[line]
                    .iter()
                    .find(|span| {
                        let range = column..column + span.text.width();
                        column = range.end;
                        range.contains(&(RULE.width() + 1))
                    })
                    .unwrap();
                assert_eq!(marked.tint, Tint::PathChange);
            }
        }
        for (cell, expected) in [
            (1, "tailnet DERP nue → tailnet direct"),
            (NOTE_CELL, "endpoint 203.0.113.1:41641 · source 100.64.0.1"),
        ] {
            let timeline = Timeline {
                hover: Some(Hover {
                    host: 0,
                    cell,
                    overview: false,
                }),
                now: timeline.now,
                ..LIVE
            };
            let frame = super::frame(
                std::slice::from_ref(&host),
                Layout::Stacked,
                &timeline,
                180,
                40,
                true,
            );
            assert!(plain(&frame.lines).contains(expected));
        }
    }

    #[test]
    fn stacked_falls_back_to_rows_when_too_tall() {
        let hosts = [
            host("google.com", "192.178.194.101", &[424], 0),
            host("1.1.1.1", "1.1.1.1", &[82], 1),
        ];
        let frame = frame(&hosts, Layout::Stacked, &LIVE, 80, 12, true);
        assert!(plain(&frame.lines).contains("terminal too short for stacked"));
        assert!(frame.lines.len() < 12);
        assert_eq!(frame.timeline_lines, vec![(1, 0, false), (2, 1, false)]);
    }

    #[test]
    fn clip_never_exceeds_width() {
        let line = vec![span(Role::Rule, RULE), span(Role::Spark, "▁▂▃▄▅▆▇█")];
        let clipped = clip(&line, 5);
        assert_eq!(clipped.iter().map(|s| s.text.width()).sum::<usize>(), 5);
    }

    #[test]
    fn hover_marks_cell_and_shows_readout_on_identity() {
        let hosts = [host(
            "google.com",
            "192.178.194.101",
            &[424, 310, 2500, 640],
            0,
        )];
        let timeline = Timeline {
            hover: Some(Hover {
                host: 0,
                cell: 2,
                overview: false,
            }),
            now: t0() + Duration::from_secs(12),
            ..LIVE
        };
        let frame = frame(&hosts, Layout::Stacked, &timeline, 80, 40, true);
        let before = super::frame(&hosts, Layout::Stacked, &LIVE, 80, 40, true);
        for (line, _, overview) in &frame.timeline_lines {
            if *overview {
                continue;
            }
            let original: String = before.lines[*line]
                .iter()
                .map(|span| span.text.as_str())
                .collect();
            let marked: String = frame.lines[*line]
                .iter()
                .map(|span| span.text.as_str())
                .collect();
            assert_eq!(original, marked, "hover changes tint, not the raster");
            assert!(frame.lines[*line].iter().any(|span| {
                span.tint == Tint::Hover
                    && matches!(
                        span.role,
                        Role::Spark | Role::RttElevated | Role::RttHigh | Role::Baseline
                    )
                    && span.text.width() == 1
            }));
        }
        let tooltip: String = frame.lines[1].iter().map(|s| s.text.as_str()).collect();
        assert!(tooltip.contains(" 10s ago · "), "{tooltip}");
        assert!(frame.lines[1].iter().any(|s| s.role == Role::Tooltip));
    }

    pub(super) fn host_from_slot(name: &str, first_slot: u64, rtts_ms: &[u64]) -> HostState {
        let mut state = HostState::new(name.into());
        state.apply(ProbeEvent::Resolved("127.0.0.1".parse().unwrap()));
        for (i, ms) in rtts_ms.iter().enumerate() {
            let slot = first_slot + i as u64;
            state.apply(ProbeEvent::Reply {
                seq: 0,
                slot,
                rtt: Duration::from_millis(*ms),
                sent: t0() + Duration::from_secs(slot),
            });
        }
        state
    }

    #[test]
    fn hosts_share_one_time_axis() {
        // b resolved late and starts at slot 3: its column 3 is a's column 3.
        let hosts = [
            host_from_slot("a", 0, &[1, 1, 1, 9, 1]),
            host_from_slot("b", 3, &[9, 1]),
        ];
        let frame = frame(&hosts, Layout::Stacked, &LIVE, 40, 40, true);
        for host in 0..hosts.len() {
            let chart = frame
                .timeline_lines
                .iter()
                .find(|(_, index, overview)| *index == host && !overview)
                .unwrap()
                .0;
            let column = frame.lines[chart]
                .iter()
                .take_while(|span| span.role != Role::Spark)
                .map(|span| span.text.width())
                .sum::<usize>();
            assert_eq!(column, frame.timeline.0 + 3);
        }
    }

    #[test]
    fn overview_shows_hidden_history_and_tints_the_window() {
        let hosts = [host_from_slot("a", 0, &vec![5; 300])];
        let frame = frame(&hosts, Layout::Stacked, &LIVE, 80, 40, true);
        assert_eq!(
            frame.timeline_lines,
            vec![(2, 0, false), (3, 0, false), (4, 0, true)]
        );
        assert!(frame.overviews[0].is_some());
        let overview = &frame.lines[4];
        assert!(overview.iter().any(|s| s.tint == Tint::Window));
        let current: String = frame.lines[5].iter().map(|s| s.text.as_str()).collect();
        assert!(current.starts_with("│ Current"), "{current}");

        let short = [host_from_slot("a", 0, &[5; 10])];
        let short_frame = super::frame(&short, Layout::Stacked, &LIVE, 80, 40, true);
        assert!(short_frame.overviews[0].is_some());
        assert!(short_frame.lines[4]
            .iter()
            .filter(|span| span.role != Role::Rule)
            .all(|span| span.role == Role::Plain
                || (span.role == Role::Label && span.tint == Tint::Window)));
    }

    #[test]
    fn responsive_breakpoints_preserve_all_statistics() {
        let hosts = [host("a", "127.0.0.1", &[10, 90], 1)];
        for (columns, identity_rows, chart_rows) in [
            (60, 2, 2),
            (61, 2, 2),
            (90, 2, 2),
            (91, 1, 2),
            (110, 1, 2),
            (111, 1, 3),
        ] {
            let frame = frame(&hosts, Layout::Stacked, &LIVE, columns - 1, 40, true);
            assert_eq!(
                frame.timeline_lines,
                (identity_rows..identity_rows + chart_rows)
                    .map(|row| (row, 0, false))
                    .chain(std::iter::once((identity_rows + chart_rows, 0, true)))
                    .collect::<Vec<_>>()
            );
            let text = plain(&frame.lines);
            for label in ["Current", "Min", "Avg", "Max", "Received", "Loss"] {
                assert!(text.contains(label), "{columns} columns: {label}");
            }
        }
    }

    #[test]
    fn sidecar_rail_pairs_statistics_in_aligned_columns() {
        let hosts = [host("a", "127.0.0.1", &[10, 90], 0)];
        let frame = frame(&hosts, Layout::Stacked, &LIVE, 199, 40, true);
        let rows: Vec<_> = frame
            .timeline_lines
            .iter()
            .filter(|(_, _, overview)| !overview)
            .map(|(line, _, _)| plain(&[frame.lines[*line].clone()]))
            .collect();
        assert_eq!(rows.len(), 3, "chart is as tall as the rail");
        for (row, (left, right)) in
            rows.iter()
                .zip([("Current", "Avg"), ("Min", "Max"), ("Received", "Loss")])
        {
            assert!(row.contains(left) && row.contains(right), "{row}");
        }
        let column = |row: &str, label: &str| row[..row.find(label).unwrap()].chars().count();
        assert_eq!(column(&rows[0], "Avg"), column(&rows[1], "Max"));
        assert_eq!(column(&rows[1], "Max"), column(&rows[2], "Loss"));
        assert_eq!(column(&rows[0], "9.0"), column(&rows[1], "1.0"));
    }

    #[test]
    fn sidecar_shrinks_uniformly_before_falling_back_to_rows() {
        let hosts: Vec<_> = (0..5)
            .map(|index| host(&format!("host-{index}"), "127.0.0.1", &[10, 90], 0))
            .collect();
        let shrunk = frame(&hosts, Layout::Stacked, &LIVE, 199, 31, true);
        assert_eq!(
            shrunk
                .timeline_lines
                .iter()
                .filter(|(_, _, overview)| !overview)
                .count(),
            10
        );
        assert!(shrunk.lines.len() < 31);
        for index in 0..5 {
            assert_eq!(
                shrunk
                    .timeline_lines
                    .iter()
                    .filter(|(_, host, overview)| *host == index && !overview)
                    .count(),
                2
            );
        }
        let one = frame(&hosts, Layout::Stacked, &LIVE, 199, 26, true);
        assert_eq!(
            one.timeline_lines
                .iter()
                .filter(|(_, _, overview)| !overview)
                .count(),
            5
        );
        for (row, _, _) in one
            .timeline_lines
            .iter()
            .filter(|(_, _, overview)| !overview)
        {
            let text = plain(&[one.lines[*row].clone()]);
            for label in ["Current", "Min", "Avg", "Max", "Received", "Loss"] {
                assert!(text.contains(label), "{text}");
            }
        }
        let rows = frame(&hosts, Layout::Stacked, &LIVE, 199, 15, true);
        assert!(plain(&rows.lines).contains("terminal too short for stacked"));
    }

    #[test]
    fn multirow_hover_loss_and_overview_have_shared_geometry() {
        let hosts = [
            host("a", "127.0.0.1", &[10, 90], 1),
            host_from_slot("b", 0, &vec![5; 300]),
        ];
        let timeline = Timeline {
            hover: Some(Hover {
                host: 0,
                cell: 1,
                overview: false,
            }),
            ..LIVE
        };
        let frame = frame(&hosts, Layout::Stacked, &timeline, 199, 40, true);
        assert_eq!(
            frame
                .timeline_lines
                .iter()
                .filter(|(_, _, overview)| !overview)
                .count(),
            6
        );
        for (row, host, overview) in &frame.timeline_lines {
            if *overview {
                continue;
            }
            let line = &frame.lines[*row];
            let hovered: Vec<_> = line
                .iter()
                .filter(|span| span.tint == Tint::Hover)
                .collect();
            if *host == 0 {
                assert_eq!(hovered.len(), 1);
                assert_eq!(hovered[0].text.width(), 1);
            } else {
                assert!(hovered.is_empty());
            }
        }
        let chart: Vec<_> = frame
            .timeline_lines
            .iter()
            .filter(|(_, host, overview)| *host == 0 && !overview)
            .map(|(line, _, _)| &frame.lines[*line])
            .collect();
        assert!(chart
            .last()
            .unwrap()
            .iter()
            .any(|span| span.role == Role::Bad));
        assert!(chart[..chart.len() - 1]
            .iter()
            .all(|line| line.iter().all(|span| span.role != Role::Bad)));
        assert!(chart[..chart.len() - 1]
            .iter()
            .all(|line| line.iter().any(|span| span.role == Role::Spark)));
        assert!(frame.overviews[1].is_some());
        assert!(frame.timeline_lines.last().unwrap().2);
        assert!(frame
            .lines
            .iter()
            .any(|line| line.iter().any(|span| span.role == Role::Tooltip)));
    }

    #[test]
    fn overview_dims_outside_window_including_hovered_losses() {
        let hosts = [host("a", "127.0.0.1", &[10, 90], 1)];
        let view = View {
            level: -4,
            end: Some(0.0),
        };
        let grid = timeline::overview(&hosts[0], 40, None);
        let marked = timeline::window_cells(grid, timeline::window(&hosts[0], view, 40));
        let buckets = hosts[0].time_buckets(grid.start, grid.end, 40);
        let lost_cell = buckets
            .iter()
            .position(|cell| cell.is_some_and(|bucket| bucket.lost > 0))
            .unwrap();
        assert!(!(marked.0..marked.1).contains(&lost_cell));
        let (spans, hovered) = overview_sparkline(&hosts[0], grid, 40, Some(lost_cell), marked);
        let (hovered_cell, bucket) = hovered.unwrap();
        assert_eq!(hovered_cell, lost_cell);
        assert_eq!(bucket.lost, 1);
        assert!(spans
            .iter()
            .any(|span| span.role == Role::MinimapLossFaint && span.tint == Tint::Hover));
        // Loss remains muted red; successful cells keep the label/faint colors.
        assert!(spans.iter().all(|span| matches!(
            span.role,
            Role::Label | Role::Faint | Role::MinimapLoss | Role::MinimapLossFaint | Role::Plain
        )));
        let timeline = Timeline {
            view,
            hover: Some(Hover {
                host: 0,
                cell: lost_cell,
                overview: true,
            }),
            ..LIVE
        };
        let frame = frame(&hosts, Layout::Stacked, &timeline, 43, 40, true);
        assert!(frame
            .lines
            .iter()
            .any(|line| line.iter().any(|span| span.role == Role::Tooltip)));
    }

    #[test]
    fn overview_aggregated_replies_do_not_hide_a_loss() {
        let mut host = host_from_slot("a", 0, &[5; 100]);
        host.apply(ProbeEvent::Lost {
            seq: 0,
            slot: 100,
            sent: t0() + Duration::from_secs(100),
        });
        let grid = timeline::overview(&host, 1, None);
        let buckets = host.time_buckets(grid.start, grid.end, 2);
        assert!(buckets
            .iter()
            .flatten()
            .any(|bucket| bucket.lost == 1 && bucket.samples - bucket.lost > 20));
        let (spans, _) = overview_sparkline(&host, grid, 1, None, (0, 1));
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].role, Role::Label);
        assert_eq!(spans[0].text, "⣀");
        assert_eq!(spans[0].tint, Tint::Window);
    }

    #[test]
    fn overview_loss_uses_distinct_inside_and_outside_roles() {
        let host = host("a", "127.0.0.1", &[], 1);
        let grid = timeline::overview(&host, 1, None);
        let (inside, _) = overview_sparkline(&host, grid, 1, None, (0, 1));
        let (outside, _) = overview_sparkline(&host, grid, 1, None, (0, 0));
        assert_eq!(inside.len(), 1);
        assert_eq!(outside.len(), 1);
        assert_eq!(inside[0].role, Role::MinimapLoss);
        assert_eq!(outside[0].role, Role::MinimapLossFaint);
        assert_eq!(inside[0].tint, Tint::Window);
        assert_eq!(outside[0].tint, Tint::None);
        assert_eq!(inside[0].text, outside[0].text);
        assert!(matches!(inside[0].text.as_str(), "⡀" | "⢀" | "⣀"));
    }

    #[test]
    fn overview_without_loss_keeps_muted_roles() {
        let host = host_from_slot("a", 0, &[5; 100]);
        let grid = timeline::overview(&host, 2, None);
        let (spans, _) = overview_sparkline(&host, grid, 2, None, (0, 1));
        assert_eq!(spans.len(), 2);
        assert_eq!(spans[0].role, Role::Label);
        assert_eq!(spans[0].tint, Tint::Window);
        assert_eq!(spans[1].role, Role::Faint);
        assert_eq!(spans[1].tint, Tint::None);
    }

    #[test]
    fn axis_distinguishes_observed_window_and_paused_age() {
        let hosts = [host_from_slot("a", 0, &vec![5; 600])];
        let live = Timeline {
            now: t0() + Duration::from_secs(723),
            view: View {
                level: 4,
                end: None,
            },
            ..LIVE
        };
        let text = plain(&[time_axis(&hosts, &live, (2, 80)).unwrap()]);
        assert!(text.starts_with("│ 12m03s observed"));
        assert!(text.contains("◂ 2m40s shown ▸"));
        assert!(text.ends_with("now"));
        let paused = Timeline {
            view: View {
                end: Some(500.0),
                ..live.view
            },
            ..live
        };
        let text = plain(&[time_axis(&hosts, &paused, (2, 80)).unwrap()]);
        assert!(text.contains("12m03s observed"));
        assert!(text.contains("◂ 2m40s shown ▸"));
        assert!(text.ends_with("3m43s ago"));
    }

    #[test]
    fn axis_clamps_short_runs_and_formats_subsecond_windows() {
        let hosts = [host_from_slot("a", 5, &[5; 4])];
        let timeline = Timeline {
            now: t0() + Duration::from_secs(7),
            ..LIVE
        };
        let text = plain(&[time_axis(&hosts, &timeline, (2, 80)).unwrap()]);
        assert!(text.contains("2s observed"));
        assert!(text.contains("◂ 2s shown ▸"));
        let timeline = Timeline {
            interval: Duration::from_millis(10),
            ..timeline
        };
        let text = plain(&[time_axis(&hosts, &timeline, (2, 80)).unwrap()]);
        assert!(text.contains("◂ 800ms shown ▸"));
        assert!(time_axis(&[HostState::new("empty".into())], &timeline, (2, 80)).is_none());
    }

    #[test]
    fn narrow_axis_drops_observed_then_arrows_then_window() {
        let labels = |width| axis_labels("12m03s observed", "2m40s shown", "now", width);
        let wide = labels(60);
        assert!(wide.starts_with("12m03s observed"));
        assert_eq!(wide.find('◂').map(|byte| wide[..byte].width()), Some(22));
        assert!(labels(40).contains("◂ 2m40s shown ▸"));
        assert!(!labels(40).contains("observed"));
        assert!(labels(23).contains("2m40s shown"));
        assert!(!labels(23).contains('◂'));
        assert_eq!(labels(18).trim(), "now");
        for width in 0..80 {
            assert_eq!(labels(width).width(), width);
        }
        assert_eq!(
            axis_labels("12m03s observed", "2m40s shown", "3m43s ago", 12).trim(),
            "3m43s ago"
        );
    }

    #[test]
    fn axis_follows_last_host_and_minimap_in_every_layout() {
        let hosts = [
            host_from_slot("a", 0, &vec![5; 300]),
            host_from_slot("b", 0, &vec![5; 300]),
        ];
        let timeline = Timeline {
            now: t0() + Duration::from_mins(5),
            ..LIVE
        };
        for layout in [Layout::Stacked, Layout::Rows] {
            for width in [40, 80, 100, 199] {
                for footer in [true, false] {
                    let frame = frame(&hosts, layout, &timeline, width, 60, footer);
                    if frame.timeline.1 == 0 {
                        continue;
                    }
                    let axis_line = frame.lines.len() - if footer { 4 } else { 3 };
                    assert!(frame
                        .timeline_lines
                        .iter()
                        .all(|(line, _, _)| *line < axis_line));
                    assert!(frame.lines[axis_line + 1].is_empty());
                    assert!(plain(&[frame.lines[axis_line + 2].clone()]).contains("2 hosts"));
                    assert_eq!(
                        frame.lines[axis_line]
                            .iter()
                            .map(|span| span.text.width())
                            .sum::<usize>(),
                        frame.timeline.0 + frame.timeline.1
                    );
                    if layout == Layout::Rows || width >= 110 {
                        assert_eq!(axis_line, frame.timeline_lines.last().unwrap().0 + 1);
                    }
                }
            }
        }
    }

    #[test]
    fn overview_bracket_tracks_live_zoomed_and_left_paused_windows() {
        let hosts = [host_from_slot("a", 0, &vec![5; 600])];
        for view in [
            View {
                level: 0,
                end: None,
            },
            View {
                level: -4,
                end: None,
            },
            View {
                level: -4,
                end: Some(30.0),
            },
        ] {
            let timeline = Timeline {
                view,
                now: t0() + Duration::from_mins(10),
                ..LIVE
            };
            let frame = frame(&hosts, Layout::Stacked, &timeline, 100, 60, true);
            let grid = frame.overviews[0].unwrap();
            let marked =
                timeline::window_cells(grid, timeline::window(&hosts[0], view, frame.timeline.1));
            let line = overview_axis(&hosts, &timeline, frame.timeline, grid).unwrap();
            let text: String = line.iter().map(|span| span.text.as_str()).collect();
            let cells: Vec<_> = text.chars().collect();
            let minimap_row = frame
                .timeline_lines
                .iter()
                .find(|(_, _, overview)| *overview)
                .unwrap()
                .0;
            let tint: Vec<_> = frame.lines[minimap_row]
                .iter()
                .filter(|span| span.role != Role::Rule)
                .flat_map(|span| span.text.chars().map(move |_| span.tint))
                .collect();
            assert_eq!(tint.len(), frame.timeline.1);
            assert!(tint.iter().enumerate().all(|(cell, tint)| {
                (*tint == Tint::Window) == (marked.0..marked.1).contains(&cell)
            }));
            assert_eq!(cells[frame.timeline.0 + marked.0], '├');
            assert_eq!(cells[frame.timeline.0 + marked.1 - 1], '┤');
            assert_eq!(text.width(), frame.timeline.0 + frame.timeline.1);
        }
    }

    #[test]
    fn tiny_brackets_place_duration_outside_and_drop_colliding_edges() {
        assert_eq!(
            bracket_labels("12m03s ago", "2s", (0, 1), 12),
            "├┤ 2s    now"
        );
        assert_eq!(
            bracket_labels("12m03s ago", "2s", (10, 12), 12),
            "       2s ├┤"
        );
        assert_eq!(bracket_labels("12m03s ago", "2s", (3, 5), 8), "   ├┤ 2s");
    }

    #[test]
    fn axis_height_is_reserved_before_chart_shrink_and_rows_fallback() {
        let hosts = [
            host_from_slot("a", 0, &[5; 2]),
            host_from_slot("b", 0, &[5; 2]),
        ];
        let timeline = Timeline {
            now: t0() + Duration::from_secs(2),
            ..LIVE
        };
        let shrunk = frame(&hosts, Layout::Stacked, &LIVE, 199, 15, true);
        assert_eq!(
            shrunk
                .timeline_lines
                .iter()
                .filter(|(_, _, overview)| !overview)
                .count(),
            4
        );
        let rows = frame(&hosts, Layout::Stacked, &timeline, 199, 9, true);
        assert!(plain(&rows.lines).contains("terminal too short for stacked"));
        for layout in [Layout::Stacked, Layout::Rows] {
            for width in [40, 80, 100, 199] {
                for height in 1..40 {
                    assert!(
                        frame(&hosts, layout, &timeline, width, height, true)
                            .lines
                            .len()
                            < height
                    );
                }
            }
        }
    }

    #[test]
    fn identity_hover_never_moves_host_blocks_and_replaces_path_note() {
        let mut hosts = [
            host_from_slot("a", 0, &vec![5; 300]),
            host_from_slot("b", 0, &vec![5; 300]),
        ];
        hosts[1].path.note = Some(crate::path::Note {
            text: "tailnet direct".into(),
            endpoint: Some("203.0.113.1:41641".into()),
            interface: None,
            source: Some("100.64.0.1".parse().unwrap()),
        });
        let live = Timeline {
            now: t0() + Duration::from_mins(5),
            ..LIVE
        };
        for width in [59, 60, 80, 90, 100, 110, 199] {
            let before = frame(&hosts, Layout::Stacked, &live, width, 40, true);
            for (cell, overview) in [(2, false), (2, true), (NOTE_CELL, false)] {
                let hover = Timeline {
                    hover: Some(Hover {
                        host: 1,
                        cell,
                        overview,
                    }),
                    ..live
                };
                let after = frame(&hosts, Layout::Stacked, &hover, width, 40, true);
                assert_eq!(before.lines.len(), after.lines.len(), "{width}");
                assert_eq!(before.timeline_lines, after.timeline_lines, "{width}");
                if width < 60 {
                    continue;
                }
                let identity = after
                    .lines
                    .iter()
                    .position(|line| line.iter().any(|span| span.role == Role::Tooltip))
                    .unwrap();
                let chart = after
                    .timeline_lines
                    .iter()
                    .find(|(_, host, _)| *host == 1)
                    .unwrap()
                    .0;
                assert_eq!(identity + 1, chart);
                assert!(!after.lines[identity]
                    .iter()
                    .any(|span| span.role == Role::PathNote));
                assert!(
                    after.lines[identity]
                        .iter()
                        .map(|span| span.text.width())
                        .sum::<usize>()
                        <= width
                );
                if cell == NOTE_CELL && width == 199 {
                    assert!(plain(&[after.lines[identity].clone()])
                        .contains("endpoint 203.0.113.1:41641 · source 100.64.0.1"));
                    assert_eq!(
                        before.notes, after.notes,
                        "keep the note hit area while its readout is shown"
                    );
                }
            }
        }
    }

    #[test]
    fn minimaps_keep_zoom_and_pan_geometry_constant() {
        for count in [1, 3] {
            let hosts: Vec<_> = (0..count)
                .map(|_| host_from_slot("a", 0, &[5; 20]))
                .collect();
            for width in [40, 80, 100, 199] {
                let before = frame(&hosts, Layout::Stacked, &LIVE, width, 60, true);
                assert_eq!(
                    before
                        .timeline_lines
                        .iter()
                        .filter(|(_, _, overview)| *overview)
                        .count(),
                    count
                );
                for view in [
                    View {
                        level: -16,
                        end: None,
                    },
                    View {
                        level: -16,
                        end: Some(10.0),
                    },
                ] {
                    let after = frame(
                        &hosts,
                        Layout::Stacked,
                        &Timeline { view, ..LIVE },
                        width,
                        60,
                        true,
                    );
                    assert_eq!(before.lines.len(), after.lines.len());
                    assert_eq!(before.timeline_lines, after.timeline_lines);
                }
                let empty: Vec<_> = (0..count).map(|_| HostState::new("a".into())).collect();
                let empty = frame(&empty, Layout::Stacked, &LIVE, width, 60, true);
                for (line, _, overview) in &empty.timeline_lines {
                    if *overview {
                        assert_eq!(plain(&[empty.lines[*line].clone()]), "│");
                    }
                }
            }
        }
    }

    #[test]
    fn window_statistics_and_final_run_record_cover_every_layout() {
        let mut host = HostState::new("a".into());
        host.apply(ProbeEvent::Resolved("127.0.0.1".parse().unwrap()));
        for (slot, rtt) in [100, 2, 0, 6, 8, 200].into_iter().enumerate() {
            let slot = slot as u64;
            let sent = t0() + Duration::from_secs(slot);
            host.apply(if rtt == 0 {
                ProbeEvent::Lost { seq: 0, slot, sent }
            } else {
                ProbeEvent::Reply {
                    seq: 0,
                    slot,
                    sent,
                    rtt: Duration::from_millis(rtt),
                }
            });
        }
        let hosts = [host];
        let window = Timeline {
            view: View {
                level: -24,
                end: Some(5.0),
            },
            now: t0() + Duration::from_secs(6),
            ..LIVE
        };
        let run = Timeline {
            stats_scope: StatsScope::Run,
            ..window
        };
        let value = |frame: &Frame, label: &str| {
            frame
                .lines
                .iter()
                .find_map(|line| {
                    line.windows(2).find_map(|pair| {
                        (pair[0].role == Role::Label && pair[0].text.trim() == label)
                            .then(|| pair[1].text.trim().to_owned())
                    })
                })
                .unwrap()
        };
        for (width, min, avg, received, loss) in [
            (40, "8.0 ms", "8.0 ms", "1 of 1", "0%"),
            (80, "6.0 ms", "7.0 ms", "2 of 2", "0%"),
            (100, "6.0 ms", "7.0 ms", "2 of 2", "0%"),
            (199, "6.0 ms", "7.0 ms", "2 of 3", "33%"),
        ] {
            let visible = frame(&hosts, Layout::Stacked, &window, width, 40, true);
            assert_eq!(value(&visible, "Current"), "8.0 ms");
            assert_eq!(value(&visible, "Min"), min);
            assert_eq!(value(&visible, "Avg"), avg);
            assert_eq!(value(&visible, "Max"), "8.0 ms");
            assert_eq!(value(&visible, "Received"), received);
            assert_eq!(value(&visible, "Loss"), loss);
            assert!(plain(&visible.lines).contains("s stats: window"));
            let whole = frame(&hosts, Layout::Stacked, &run, width, 40, true);
            assert_eq!(visible.timeline, whole.timeline);
            assert_eq!(visible.timeline_lines, whole.timeline_lines);
            assert_eq!(value(&whole, "Current"), "200 ms");
            assert_eq!(value(&whole, "Max"), "200 ms");
            assert_eq!(value(&whole, "Received"), "5 of 6");
            let final_frame = frame(&hosts, Layout::Stacked, &window, width, 40, false);
            assert_eq!(value(&final_frame, "Current"), "200 ms");
            assert_eq!(value(&final_frame, "Max"), "200 ms");
            assert_eq!(value(&final_frame, "Received"), "5 of 6");
            assert!(!plain(&final_frame.lines).contains("s stats:"));
        }
        let visible = frame(&hosts, Layout::Rows, &window, 199, 40, true);
        let whole = frame(&hosts, Layout::Rows, &run, 199, 40, true);
        let values = |frame: &Frame| {
            frame.lines[1]
                .iter()
                .filter(|span| span.role == Role::Value)
                .map(|span| span.text.trim().to_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(values(&visible), ["8.0 ms", "7.0 ms", "8.0 ms"]);
        assert!(plain(&visible.lines).contains("33%"));
        assert_eq!(values(&whole), ["200 ms", "63.2 ms", "200 ms"]);
        let final_frame = frame(&hosts, Layout::Rows, &window, 199, 40, false);
        assert_eq!(values(&final_frame), values(&whole));
    }

    #[test]
    fn paused_current_is_empty_when_the_latest_visible_sample_is_lost() {
        let mut host = host_from_slot("a", 0, &[5; 10]);
        host.apply(ProbeEvent::Lost {
            seq: 0,
            slot: 10,
            sent: t0() + Duration::from_secs(10),
        });
        let timeline = Timeline {
            view: View {
                level: -24,
                end: Some(10.5),
            },
            ..LIVE
        };
        let stats = visible_stats(&host, &timeline, 64, true);
        assert_eq!(stats.current, None);
        assert_eq!((stats.received, stats.lost), (1, 1));
    }

    #[test]
    fn single_host_summary_reports_current_rate_in_every_layout() {
        let hosts = [host("a", "127.0.0.1", &[10, 90], 1)];
        let changed = Timeline {
            current_interval: Duration::from_millis(1250),
            view: View {
                level: -4,
                end: None,
            },
            now: t0() + Duration::from_secs(3),
            ..LIVE
        };
        for layout in [Layout::Stacked, Layout::Rows] {
            for width in [40, 80, 199] {
                for footer in [true, false] {
                    let before = frame(
                        &hosts,
                        layout,
                        &Timeline {
                            current_interval: LIVE.current_interval,
                            ..changed
                        },
                        width,
                        40,
                        footer,
                    );
                    let after = frame(&hosts, layout, &changed, width, 40, footer);
                    let text = plain(&after.lines);
                    assert!(
                        text.contains(
                            "1 host · every 1.25s · 3 sent · 33% loss · fastest a 5.0 ms"
                        ),
                        "{layout:?}, {width} columns, footer {footer}: {text}"
                    );
                    assert_eq!(before.timeline, after.timeline);
                    assert_eq!(before.timeline_lines, after.timeline_lines);
                    assert_eq!(
                        time_axis(
                            &hosts,
                            &Timeline {
                                current_interval: LIVE.current_interval,
                                ..changed
                            },
                            after.timeline
                        ),
                        time_axis(&hosts, &changed, after.timeline),
                        "rate changes cannot rescale the time axis"
                    );
                    assert_eq!(text.contains("[ ] rate"), footer);
                }
            }
        }
    }

    fn variable_rate_host() -> HostState {
        let mut host = HostState::new("a".into());
        host.set_interval(Duration::from_secs(1));
        host.apply(ProbeEvent::Resolved("127.0.0.1".parse().unwrap()));
        for (slot, position, interval) in [
            (0, Duration::ZERO, Duration::from_secs(2)),
            (1, Duration::from_secs(2), Duration::from_millis(500)),
            (2, Duration::from_millis(2500), Duration::from_millis(500)),
        ] {
            host.apply(ProbeEvent::Scheduled {
                slot,
                position,
                interval,
            });
        }
        // Replies arrive in reverse order; placement follows their deadlines.
        for (slot, position, rtt) in [(1, 2000, 9), (0, 0, 1)] {
            host.apply(ProbeEvent::Reply {
                seq: 0,
                slot,
                sent: t0() + Duration::from_millis(position),
                rtt: Duration::from_millis(rtt),
            });
        }
        host
    }

    #[test]
    fn variable_rate_history_leaves_unscheduled_cells_blank_and_due_cells_marked() {
        let host = variable_rate_host();
        let view = View {
            level: -4,
            end: None,
        };
        let (chart, gap) = sparkline(&host, view, 20, 1, Some(2));
        let spans = &chart[0];
        let text: String = spans.iter().map(|span| span.text.as_str()).collect();
        let cells: Vec<_> = text.chars().collect();
        assert!(cells[..2].iter().all(|cell| *cell != ' '));
        assert_eq!(&cells[2..4], &[' ', ' ']);
        assert_ne!(cells[4], ' ');
        assert_eq!(cells[5], ' ', "pending due probes stay blank");
        assert!(gap.is_none(), "no probe was due between 1s and 2s");
        assert!(!spans.iter().any(|span| span.tint == Tint::Hover));
        let (_, pending) = sparkline(&host, view, 20, 1, Some(5));
        let (cell, bucket) = pending.unwrap();
        assert_eq!(cell, 5);
        assert_eq!((bucket.samples, bucket.lost, bucket.slowest), (0, 0, None));
        let timeline = Timeline {
            view,
            current_interval: Duration::from_millis(500),
            now: t0() + Duration::from_secs(4),
            ..LIVE
        };
        let (_, hovered) = sparkline(&host, view, 20, 1, Some(4));
        let (_, description) = tooltip(&host, &timeline, 20, None, hovered).unwrap();
        assert!(description.starts_with("2s ago · "), "{description}");
        assert!(description.ends_with(" · 9.0 ms"), "{description}");
        let stats = visible_stats(
            &host,
            &Timeline {
                view: View {
                    end: Some(2.5),
                    ..view
                },
                ..timeline
            },
            1,
            true,
        );
        assert_eq!((stats.received, stats.lost), (1, 0));
        assert_eq!(stats.current, Some(Duration::from_millis(9)));
    }

    #[test]
    fn single_host_summary_height_is_reserved_before_stacked_fallback() {
        let hosts = [host_from_slot("a", 0, &[5; 2])];
        for width in [40, 80, 100, 199] {
            for height in 1..40 {
                for footer in [true, false] {
                    assert!(
                        frame(&hosts, Layout::Stacked, &LIVE, width, height, footer)
                            .lines
                            .len()
                            < height
                    );
                }
            }
        }
    }

    #[test]
    fn variable_rate_path_changes_follow_time_instead_of_probe_ordinal() {
        let mut host = variable_rate_host();
        let note = |text: &str| {
            Some(crate::path::Note {
                text: text.into(),
                endpoint: None,
                interface: None,
                source: None,
            })
        };
        host.path.update(note("tailnet relay"), 0, t0());
        host.path
            .update(note("tailnet direct"), 1, t0() + Duration::from_secs(2));
        let view = View {
            level: -4,
            end: None,
        };
        let (chart, hovered) = sparkline(&host, view, 20, 3, None);
        assert!(hovered.is_none());
        for line in &chart {
            let tints: Vec<_> = line
                .iter()
                .flat_map(|span| span.text.chars().map(move |_| span.tint))
                .collect();
            assert_eq!(
                tints.iter().position(|tint| *tint == Tint::PathChange),
                Some(4)
            );
            assert_eq!(
                tints.iter().rposition(|tint| *tint == Tint::PathChange),
                Some(4)
            );
        }
        let (_, hovered) = sparkline(&host, view, 20, 3, Some(4));
        let timeline = Timeline {
            view,
            now: t0() + Duration::from_secs(4),
            ..LIVE
        };
        let (_, description) = tooltip(&host, &timeline, 20, None, hovered).unwrap();
        assert!(
            description.ends_with(" · tailnet relay → tailnet direct"),
            "{description}"
        );
    }
}
