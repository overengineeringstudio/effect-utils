use super::{
    append_note, identity_tooltip, note_region, overview_axis, overview_sparkline, tooltip,
    visible_stats,
};
use super::{
    block, fmt_ms, key_hint, loss, span, sparkline, stacked_spark_width, summary, timeline,
    Duration, Extent, Frame, Grid, HostState, Layout, Line, Role, Stats, Status, Timeline,
    UnicodeWidthStr, LABEL_WIDTH, RULE,
};

const RAIL_WIDTH: usize = 28;
/// The chart is as tall as the paired rail (decision 0003).
const CHART_ROWS: usize = 3;
/// Rail order: Current/Avg, Min/Max, Received/Loss pairs, read row by row.
const RAIL_ORDER: [usize; 6] = [0, 2, 1, 3, 4, 5];

fn stat_cells(stats: Stats) -> [Line; 6] {
    let ms = |value: Option<Duration>| value.map_or_else(|| "-".into(), fmt_ms);
    let mut cells = [
        vec![
            span(Role::Label, "Current "),
            span(Role::Value, ms(stats.current)),
        ],
        vec![span(Role::Label, "Min "), span(Role::Value, ms(stats.min))],
        vec![
            span(Role::Label, "Avg "),
            span(Role::Value, ms(stats.avg())),
        ],
        vec![span(Role::Label, "Max "), span(Role::Value, ms(stats.max))],
        vec![
            span(Role::Label, "Received "),
            span(
                Role::Value,
                if stats.completed() == 0 {
                    "-".into()
                } else {
                    format!("{} of {}", stats.received, stats.completed())
                },
            ),
        ],
        vec![span(Role::Label, "Loss ")],
    ];
    cells[5].extend(loss(stats));
    cells
}

/// Reserve run-wide value bounds so zoom, hover and scope never move the rail.
fn sizing_cells(host: &HostState) -> [Line; 6] {
    let mut cells = stat_cells(host.run_stats());
    let value_width = cells[..4]
        .iter()
        .map(|cell| cell[1].text.width())
        .max()
        .unwrap_or(0)
        .max(7);
    for cell in &mut cells[..4] {
        cell[1].text = format!("{:<value_width$}", cell[1].text);
    }
    cells[5][1].text = "100%".into();
    cells
}

fn line_width(line: &Line) -> usize {
    line.iter().map(|span| span.text.width()).sum()
}

/// The rail: statistics in `RAIL_ORDER`, packed into `rows` rows of equal
/// columns; labels and cells are padded per column so values line up.
fn rail(cells: &[Line; 6], sizing: &[Line; 6], rows: usize) -> Vec<Line> {
    let columns = 6_usize.div_ceil(rows);
    let cell = |row: usize, column: usize| {
        let index = row * columns + column;
        (index < 6).then(|| &cells[RAIL_ORDER[index]])
    };
    let label_width = |column: usize| {
        (0..rows)
            .filter_map(|row| cell(row, column))
            .map(|cell| cell[0].text.trim_end().width())
            .max()
            .unwrap_or(0)
    };
    let padded = |row: usize, column: usize| {
        cell(row, column).map(|cell| {
            let mut line = vec![span(
                Role::Label,
                format!("{:<w$} ", cell[0].text.trim_end(), w = label_width(column)),
            )];
            line.extend(cell[1..].iter().cloned());
            line
        })
    };
    let cell_width = |column: usize| {
        (0..rows)
            .filter_map(|row| {
                let index = row * columns + column;
                (index < 6).then(|| {
                    label_width(column)
                        + 1
                        + sizing[RAIL_ORDER[index]][1..]
                            .iter()
                            .map(|span| span.text.width())
                            .sum::<usize>()
                })
            })
            .max()
            .unwrap_or(0)
    };
    (0..rows)
        .map(|row| {
            let mut line = Vec::new();
            for column in 0..columns {
                let Some(cell) = padded(row, column) else {
                    continue;
                };
                if column > 0 {
                    let previous = cell_width(column - 1);
                    let used = padded(row, column - 1).map_or(0, |cell| line_width(&cell));
                    line.push(span(Role::Plain, " ".repeat(previous - used + 3)));
                }
                line.extend(cell);
            }
            line
        })
        .collect()
}

fn identity(host: &HostState, merged: bool) -> Vec<Line> {
    let address = match &host.status {
        Status::Running(addr) => span(Role::Pill, format!(" {addr} ")),
        Status::Resolving => span(Role::Dim, "resolving…"),
        Status::Failed { reason, .. } => span(Role::Bad, format!("✗ {reason}")),
    };
    if merged {
        vec![vec![
            span(Role::Rule, RULE),
            span(Role::Host, host.host.clone()),
            span(Role::Plain, "  "),
            address,
        ]]
    } else {
        vec![
            vec![
                span(Role::Rule, RULE),
                span(Role::Label, format!("{:<LABEL_WIDTH$}", "Host")),
                span(Role::Host, host.host.clone()),
            ],
            vec![
                span(Role::Rule, RULE),
                span(
                    Role::Label,
                    format!(
                        "{:<width$}",
                        "Address",
                        width =
                            LABEL_WIDTH - usize::from(matches!(host.status, Status::Running(_)))
                    ),
                ),
                address,
            ],
        ]
    }
}

struct Plan {
    chart_rows: usize,
    stats: Vec<Vec<Line>>,
    cells: Vec<[Line; 6]>,
    values: Vec<Stats>,
    spark_width: usize,
    overviews: Vec<Grid>,
}

fn plan(
    hosts: &[HostState],
    timeline: &Timeline,
    width: usize,
    height: usize,
    footer: bool,
    cells: &[[Line; 6]],
) -> Option<Plan> {
    let sidecar = width >= 110;
    let merged = width >= 90;
    let reference = width < 60;
    let footer_height = 2 + usize::from(footer);
    let axis_height = usize::from(hosts.iter().any(|host| host.first_sample().is_some()));
    for chart_rows in (1..=if sidecar { CHART_ROWS } else { 2 }).rev() {
        let stat_rows = if sidecar {
            chart_rows
        } else if reference {
            6
        } else if merged {
            2
        } else {
            3
        };
        // A shortened chart gives its recovered horizontal space to packed stats.
        let rail_width = if sidecar {
            cells
                .iter()
                .flat_map(|cells| rail(cells, cells, stat_rows))
                .map(|line| line_width(&line))
                .max()
                .unwrap_or(0)
                .max(RAIL_WIDTH)
        } else {
            0
        };
        let spark_width = if sidecar {
            width.saturating_sub(RULE.width() + 3 + rail_width)
        } else {
            stacked_spark_width(width)
        };
        let needed = hosts.len()
            * (usize::from(!merged) + 2 + chart_rows + if sidecar { 0 } else { stat_rows })
            + hosts.len().saturating_sub(1)
            + footer_height
            + axis_height;
        if needed < height && spark_width > 0 {
            let values = if reference {
                hosts
                    .iter()
                    .map(|host| visible_stats(host, timeline, spark_width, footer))
                    .collect()
            } else {
                Vec::new()
            };
            let visible: Vec<_> = if reference {
                Vec::new()
            } else {
                hosts
                    .iter()
                    .map(|host| stat_cells(visible_stats(host, timeline, spark_width, footer)))
                    .collect()
            };
            let stats = if sidecar {
                visible
                    .iter()
                    .zip(cells)
                    .map(|(visible, sizing)| rail(visible, sizing, stat_rows))
                    .collect()
            } else {
                Vec::new()
            };
            return Some(Plan {
                chart_rows,
                stats,
                cells: visible,
                values,
                spark_width,
                overviews: hosts
                    .iter()
                    .map(|host| timeline::overview(host, spark_width, timeline.overview_end))
                    .collect(),
            });
        }
    }
    None
}

#[allow(
    clippy::too_many_lines,
    reason = "Assembly keeps shared timeline geometry and ordered host rows together"
)]
pub(super) fn frame(
    hosts: &[HostState],
    timeline: &Timeline,
    width: usize,
    height: usize,
    footer: bool,
) -> Option<Frame> {
    let sidecar = width >= 110;
    let merged = width >= 90;
    let reference = width < 60;
    let sizing: Vec<_> = if sidecar {
        hosts.iter().map(sizing_cells).collect()
    } else {
        Vec::new()
    };
    let hint = timeline.view.hint(Extent::of(hosts), timeline.interval);
    let Plan {
        chart_rows,
        stats,
        cells,
        values,
        spark_width,
        overviews,
    } = plan(hosts, timeline, width, height, footer, &sizing)?;
    let mut lines = Vec::new();
    let mut timeline_lines = Vec::new();
    let mut notes = Vec::new();
    for (index, host) in hosts.iter().enumerate() {
        if index > 0 {
            lines.push(vec![]);
        }
        if reference {
            timeline_lines.extend((0..chart_rows).map(|row| (lines.len() + 2 + row, index, false)));
            timeline_lines.push((lines.len() + 2 + chart_rows, index, true));
            let block = block(
                host,
                timeline,
                values[index],
                overviews[index],
                timeline.hover.filter(|hover| hover.host == index),
                width,
                chart_rows,
            );
            if let Some((start, end)) = note_region(&block[1]) {
                notes.push((lines.len() + 1, index, start, end));
            }
            lines.extend(block);
            continue;
        }
        let mut identity = identity(host, merged);
        let address_line = identity.len() - 1;
        let identity_line = lines.len() + address_line;
        append_note(&mut identity[address_line], host, timeline.now, width);
        if let Some((start, end)) = note_region(&identity[address_line]) {
            notes.push((lines.len() + address_line, index, start, end));
        }
        lines.extend(identity);
        let hover = timeline.hover.filter(|hover| hover.host == index);
        let (spark, mut hovered) = sparkline(
            host,
            timeline.view,
            spark_width,
            chart_rows,
            hover
                .filter(|hover| !hover.overview)
                .map(|hover| hover.cell),
        );
        for (row, bars) in spark.into_iter().enumerate() {
            timeline_lines.push((lines.len(), index, false));
            let mut line = vec![span(Role::Rule, RULE)];
            line.extend(bars);
            if sidecar && row >= chart_rows - stats[index].len() {
                line.push(span(
                    Role::Plain,
                    " ".repeat((RULE.width() + spark_width).saturating_sub(line_width(&line))),
                ));
                line.push(span(Role::Rule, " │ "));
                line.extend(
                    stats[index][row - (chart_rows - stats[index].len())]
                        .iter()
                        .cloned(),
                );
            }
            lines.push(line);
        }
        {
            let grid = overviews[index];
            let marked =
                timeline::window_cells(grid, timeline::window(host, timeline.view, spark_width));
            let (spark, overview_hovered) = overview_sparkline(
                host,
                grid,
                spark_width,
                hover.filter(|hover| hover.overview).map(|hover| hover.cell),
                marked,
            );
            hovered = hovered.or(overview_hovered);
            timeline_lines.push((lines.len(), index, true));
            let mut line = vec![span(Role::Rule, RULE)];
            line.extend(spark);
            lines.push(line);
        }
        if let Some((pointer_col, description)) =
            tooltip(host, timeline, spark_width, hover, hovered)
        {
            identity_tooltip(&mut lines[identity_line], &description, width, pointer_col);
        }
        if !sidecar {
            for stat_row in 0..if merged { 2 } else { 3 } {
                let mut line = vec![span(Role::Rule, RULE)];
                let field_width = stacked_spark_width(width) / if merged { 3 } else { 2 };
                let fields = if merged { 3 } else { 2 };
                let start = stat_row * fields;
                for cell in &cells[index][start..start + fields] {
                    line.extend(cell.iter().cloned());
                    line.push(span(
                        Role::Plain,
                        " ".repeat(field_width.saturating_sub(line_width(cell))),
                    ));
                }
                lines.push(line);
            }
        }
    }
    if let Some(axis) = overviews
        .last()
        .and_then(|grid| overview_axis(hosts, timeline, (RULE.width(), spark_width), *grid))
    {
        lines.push(axis);
    }
    lines.push(vec![]);
    lines.push(summary(hosts, timeline.current_interval, width));
    if footer {
        lines.push(key_hint(
            Layout::Stacked,
            Layout::Stacked,
            timeline.stats_scope,
            hint.as_deref(),
            timeline.hover_now.is_some(),
        ));
    }
    Some(Frame {
        lines,
        timeline: (RULE.width(), spark_width),
        timeline_lines,
        overviews: overviews.into_iter().map(Some).collect(),
        notes,
    })
}
