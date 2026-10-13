//! Direct RTT-to-Braille rasterization and terminal-column span aggregation.

use std::time::Duration;

use crate::stats::{Bucket, HostState};
use crate::timeline::{self, Grid};

use super::{Line, Role, Span, Tint};

// Sub-20 ms replies are quiet even when their host's baseline is very low.
const RTT_QUIET_FLOOR: Duration = Duration::from_millis(20);
// Absolute amber keeps uniformly slow links visible despite a high median.
const RTT_ELEVATED_FLOOR: Duration = Duration::from_millis(150);
// Absolute orange flags severe latency without needing a relative deviation.
const RTT_HIGH_FLOOR: Duration = Duration::from_millis(300);
// Relative amber begins beyond ordinary 1.5x baseline variation.
const RTT_ELEVATED_RATIO: f64 = 1.5;
// Relative orange marks replies beyond three times the retained host median.
const RTT_HIGH_RATIO: f64 = 3.0;

pub(super) fn render_sparkline(
    host: &HostState,
    grid: Grid,
    cells: &[Option<Bucket>],
    height: usize,
    hover: Option<usize>,
    window: Option<(usize, usize)>,
) -> (Vec<Line>, Option<(usize, Bucket)>) {
    let hovered = hover.and_then(|cell| {
        let bucket = if window.is_some() && cell < grid.width {
            let (from, to) = grid.range_of(cell);
            host.time_bucket(from, to, false)
        } else {
            timeline::cell_bucket(host, grid, cell)
        }?;
        Some((cell, bucket))
    });
    let (min, max) = cells
        .iter()
        .filter_map(|cell| cell.and_then(|bucket| bucket.slowest))
        .map(|rtt| rtt.as_secs_f64())
        .fold((f64::INFINITY, 0.0_f64), |(lo, hi), v| {
            (lo.min(v), hi.max(v))
        });
    let scale = Scale {
        base: min,
        span: (max - min).max(min * 0.5),
    };
    let mut lines: Vec<Line> = vec![Vec::new(); height];
    let baseline = window.is_none().then(|| host.rtt_baseline()).flatten();
    for (column, pair) in cells.chunks(2).take(grid.width).enumerate() {
        let present = pair.iter().any(Option::is_some);
        let failures: [usize; 2] = std::array::from_fn(|side| {
            usize::from(
                pair.get(side)
                    .copied()
                    .flatten()
                    .is_some_and(|bucket| bucket.lost > 0),
            )
        });
        let overview_loss = window.is_some() && {
            let (samples, lost) = pair
                .iter()
                .flatten()
                .fold((0, 0), |(samples, lost), bucket| {
                    (samples + bucket.samples, lost + bucket.lost)
                });
            samples > 0 && lost * 2 >= samples
        };
        let units: [usize; 2] = std::array::from_fn(|side| {
            pair.get(side)
                .copied()
                .flatten()
                .and_then(|bucket| bucket.slowest)
                .map_or(0, |rtt| scale.units(rtt.as_secs_f64(), height * 4))
        });
        let reply_role = main_reply_role(pair, units, baseline);
        let tint = if hover == Some(column) && present {
            Tint::Hover
        } else if host
            .path_change_in(grid.range_of(column).0, grid.range_of(column).1)
            .is_some()
        {
            Tint::PathChange
        } else if window.is_some_and(|(from, to)| (from..to).contains(&column)) {
            Tint::Window
        } else {
            Tint::None
        };
        for (row, line) in lines.iter_mut().enumerate() {
            let below = (height - 1 - row) * 4;
            let fill = units.map(|units| units.saturating_sub(below).min(4));
            // One foreground per glyph: successful reply dots keep their color,
            // suppressing any failures that share the bottom character.
            let loss_marker =
                row + 1 == height && fill == [0, 0] && failures.iter().any(|failed| *failed > 0);
            let role = if loss_marker { Role::Bad } else { reply_role };
            let role = match window {
                Some(_) if !present => role,
                Some((from, to)) => overview_role((from..to).contains(&column), overview_loss),
                None => role,
            };
            let glyph = if loss_marker {
                braille_stems(failures)
            } else {
                braille_stems(fill)
            };
            match line.last_mut() {
                Some(previous) if previous.role == role && previous.tint == tint => {
                    previous.text.push(glyph);
                }
                _ => line.push(Span {
                    role,
                    text: glyph.to_string(),
                    tint,
                }),
            }
        }
    }
    (lines, hovered)
}

/// A terminal glyph has one foreground, so its worst time half wins.
fn main_reply_role(pair: &[Option<Bucket>], units: [usize; 2], baseline: Option<Duration>) -> Role {
    if units == [0, 0] {
        return Role::Plain;
    }
    let band = pair
        .iter()
        .flatten()
        .filter_map(|bucket| bucket.slowest)
        .max()
        .map_or(Role::Spark, |rtt| rtt_role(rtt, baseline));
    // Warning bands must remain visible even when every reply is the lowest stem.
    if band == Role::Spark && units.iter().all(|units| *units <= 1) {
        Role::Baseline
    } else {
        band
    }
}

fn rtt_role(rtt: Duration, baseline: Option<Duration>) -> Role {
    if rtt < RTT_QUIET_FLOOR {
        return Role::Spark;
    }
    if rtt >= RTT_HIGH_FLOOR {
        return Role::RttHigh;
    }
    let relative = baseline.map_or(Role::Spark, |median| {
        let seconds = rtt.as_secs_f64();
        let median = median.as_secs_f64();
        if seconds <= median * RTT_ELEVATED_RATIO {
            Role::Spark
        } else if seconds <= median * RTT_HIGH_RATIO {
            Role::RttElevated
        } else {
            Role::RttHigh
        }
    });
    if rtt >= RTT_ELEVATED_FLOOR && relative == Role::Spark {
        Role::RttElevated
    } else {
        relative
    }
}

/// At least half the samples across both time halves must be lost to color
/// the minimap glyph red, without changing its stems or all-loss marker.
fn overview_role(inside: bool, majority_loss: bool) -> Role {
    match (inside, majority_loss) {
        (true, true) => Role::MinimapLoss,
        (false, true) => Role::MinimapLossFaint,
        (true, false) => Role::Label,
        (false, false) => Role::Faint,
    }
}

/// Bottom-up Braille dots for the left and right vertical stems.
fn braille_stems(fill: [usize; 2]) -> char {
    const DOTS: [[u32; 4]; 2] = [[0x40, 0x04, 0x02, 0x01], [0x80, 0x20, 0x10, 0x08]];
    let mut mask = 0;
    for (side, dots) in DOTS.iter().enumerate() {
        for dot in dots.iter().take(fill[side].min(4)) {
            mask |= dot;
        }
    }
    if mask == 0 {
        ' '
    } else {
        char::from_u32(0x2800 + mask).expect("Braille mask is at most eight bits")
    }
}

struct Scale {
    base: f64,
    span: f64,
}

impl Scale {
    /// A visible reply always has its bottom dot; higher dots are floored
    /// directly from the RTT ratio at the actual chart height.
    fn units(&self, value: f64, dots: usize) -> usize {
        if self.span <= 0.0 || dots == 0 {
            return usize::from(dots > 0);
        }
        let ratio = ((value - self.base) / self.span).clamp(0.0, 1.0);
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            clippy::cast_precision_loss,
            reason = "ratio is clamped to 0..=1 and scaled to a small dot count"
        )]
        let units = 1 + (ratio * (dots - 1) as f64).floor() as usize;
        units
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use unicode_width::UnicodeWidthStr;

    use super::*;
    use crate::probe::ProbeEvent;
    use crate::render::{
        sparkline,
        tests::{host_from_slot, t0},
    };
    use crate::timeline::View;

    #[test]
    fn hybrid_rtt_quiet_floor_boundary() {
        let baseline = Some(Duration::from_millis(10));
        assert_eq!(
            rtt_role(Duration::from_micros(19_900), baseline),
            Role::Spark
        );
        assert_eq!(
            rtt_role(Duration::from_millis(20), baseline),
            Role::RttElevated
        );
    }

    #[test]
    fn hybrid_rtt_relative_band_boundaries() {
        let baseline = Some(Duration::from_millis(40));
        for (micros, expected) in [
            (60_000, Role::Spark),
            (60_001, Role::RttElevated),
            (120_000, Role::RttElevated),
            (120_001, Role::RttHigh),
        ] {
            assert_eq!(rtt_role(Duration::from_micros(micros), baseline), expected);
        }
    }

    #[test]
    fn hybrid_rtt_absolute_band_boundaries() {
        let baseline = Some(Duration::from_secs(1));
        for (micros, expected) in [
            (149_999, Role::Spark),
            (150_000, Role::RttElevated),
            (299_999, Role::RttElevated),
            (300_000, Role::RttHigh),
        ] {
            assert_eq!(rtt_role(Duration::from_micros(micros), baseline), expected);
        }
        assert_eq!(
            rtt_role(Duration::from_millis(200), Some(Duration::from_millis(10))),
            Role::RttHigh,
            "the amber floor never downgrades a relative orange"
        );
    }

    #[test]
    fn hybrid_rtt_warmup_keeps_absolute_floors() {
        let host = host_from_slot("a", 0, &[10; 9]);
        let baseline = host.rtt_baseline();
        assert_eq!(baseline, None);
        for (ms, expected) in [
            (20, Role::Spark),
            (90, Role::Spark),
            (149, Role::Spark),
            (150, Role::RttElevated),
            (299, Role::RttElevated),
            (300, Role::RttHigh),
        ] {
            assert_eq!(rtt_role(Duration::from_millis(ms), baseline), expected);
        }
    }

    fn reply_bucket(ms: u64) -> Bucket {
        Bucket {
            slowest: Some(Duration::from_millis(ms)),
            samples: 1,
            lost: 0,
            first: t0(),
        }
    }

    fn assert_overview_loss_roles(pair: [Option<Bucket>; 2], red: bool) {
        let host = HostState::new("a".into());
        let grid = Grid {
            per_cell: 1.0,
            start: 0.0,
            end: 1.0,
            width: 1,
        };
        for (window, expected) in [
            ((0, 1), if red { Role::MinimapLoss } else { Role::Label }),
            (
                (1, 1),
                if red {
                    Role::MinimapLossFaint
                } else {
                    Role::Faint
                },
            ),
        ] {
            for height in 1..=3 {
                let (chart, _) = render_sparkline(&host, grid, &pair, height, None, Some(window));
                assert!(chart.iter().flatten().all(|span| span.role == expected));
            }
        }
    }

    #[test]
    fn overview_aggregated_replies_do_not_hide_a_loss() {
        let host = HostState::new("a".into());
        let grid = Grid {
            per_cell: 1.0,
            start: 0.0,
            end: 1.0,
            width: 1,
        };
        let mut mixed = reply_bucket(90);
        mixed.samples = 2;
        mixed.lost = 1;
        let cells = [Some(mixed), Some(reply_bucket(10))];
        let (chart, _) = render_sparkline(&host, grid, &cells, 3, None, Some((0, 1)));
        assert_eq!(stem_dots(&chart, 0), [12, 1]);
        assert!(chart.iter().flatten().all(|span| span.role == Role::Label));
        mixed.lost = 2;
        mixed.samples = 3;
        assert_overview_loss_roles([Some(mixed), Some(reply_bucket(10))], true);
    }

    #[test]
    fn overview_sporadic_loss_is_not_red() {
        let failed = Bucket {
            slowest: None,
            samples: 1,
            lost: 1,
            first: t0(),
        };
        let mut replies = reply_bucket(10);
        replies.samples = 9;
        for pair in [[Some(failed), Some(replies)], [Some(replies), Some(failed)]] {
            assert_overview_loss_roles(pair, false);
        }
    }

    #[test]
    fn overview_majority_loss_is_red() {
        for lost in [1, 2] {
            let failed = Bucket {
                slowest: None,
                samples: lost,
                lost,
                first: t0(),
            };
            let reply = reply_bucket(10);
            for pair in [[Some(failed), Some(reply)], [Some(reply), Some(failed)]] {
                assert_overview_loss_roles(pair, true);
            }
        }
    }

    #[test]
    fn overview_full_loss_is_red() {
        let failed = Some(Bucket {
            slowest: None,
            samples: 3,
            lost: 3,
            first: t0(),
        });
        for pair in [[failed, failed], [failed, None], [None, failed]] {
            assert_overview_loss_roles(pair, true);
        }
    }

    #[test]
    fn hybrid_rtt_worst_subcell_colors_entire_column_and_preserves_hover() {
        let host = host_from_slot("a", 0, &[10; 10]);
        let grid = Grid {
            per_cell: 1.0,
            start: 0.0,
            end: 2.0,
            width: 2,
        };
        let mut spike = reply_bucket(90);
        spike.lost = 1;
        for pair in [[reply_bucket(10), spike], [spike, reply_bucket(10)]] {
            let cells = [
                Some(pair[0]),
                Some(pair[1]),
                Some(reply_bucket(10)),
                Some(reply_bucket(10)),
            ];
            for height in 1..=3 {
                let (chart, _) = render_sparkline(&host, grid, &cells, height, Some(0), None);
                assert!(chart.iter().all(|line| {
                    line[0].role == Role::RttHigh
                        && line[0].tint == Tint::Hover
                        && line[0].text.width() == 1
                        && line[1].role == Role::Baseline
                        && line.iter().all(|span| span.role != Role::Bad)
                }));
            }
        }
    }

    #[test]
    fn hybrid_rtt_uniformly_slow_window_colors_lowest_stems() {
        for replies in [9, 10] {
            let host = host_from_slot("a", 0, &vec![200; replies]);
            for height in 1..=3 {
                let (chart, _) = sparkline(&host, View::default(), 3, height, None);
                assert_eq!(stem_dots(&chart, 0), [1, 1]);
                assert!(chart
                    .iter()
                    .flatten()
                    .all(|span| span.role == Role::RttElevated));
            }
        }
    }

    fn stem_dots(chart: &[Line], column: usize) -> [u32; 2] {
        let mut dots = [0; 2];
        for line in chart {
            let text: String = line.iter().map(|span| span.text.as_str()).collect();
            let ch = text.chars().nth(column).unwrap();
            let mask = if ch == ' ' {
                0
            } else {
                assert!((0x2800..=0x28ff).contains(&u32::from(ch)));
                u32::from(ch) - 0x2800
            };
            dots[0] += (mask & 0x47).count_ones();
            dots[1] += (mask & 0xb8).count_ones();
        }
        dots
    }

    #[test]
    fn braille_raster_maps_rtt_directly_at_each_height_without_exceeding_width() {
        let host = host_from_slot("a", 0, &[10, 12, 30]);
        for height in 1..=3 {
            let (chart, _) = sparkline(&host, View::default(), 3, height, None);
            assert_eq!(stem_dots(&chart, 0), [1, 1]);
            assert_eq!(
                stem_dots(&chart, 1),
                if height == 3 { [2, 2] } else { [1, 1] }
            );
            assert_eq!(
                stem_dots(&chart, 2),
                [u32::try_from(height).unwrap() * 4; 2]
            );
            for width in 0..=3 {
                let (clipped, _) = sparkline(&host, View::default(), width, height, None);
                assert!(clipped.iter().all(|line| {
                    line.iter().map(|span| span.text.width()).sum::<usize>() <= width
                }));
            }
        }
        let scale = Scale {
            base: 10.0,
            span: 20.0,
        };
        assert_eq!(scale.units(0.0, 12), 1);
        assert_eq!(scale.units(40.0, 12), 12);
        assert_eq!(scale.units(11.0, 12), 1);
        assert_eq!(scale.units(12.0, 12), 2);
    }

    #[test]
    fn paired_subcells_keep_spikes_and_hover_aggregates_the_terminal_column_once() {
        let host = host_from_slot("a", 0, &[10, 90, 10, 10]);
        let view = View {
            level: 4,
            end: None,
        };
        let (chart, hovered) = sparkline(&host, view, 2, 3, Some(0));
        assert_eq!(stem_dots(&chart, 0), [1, 12]);
        assert_eq!(stem_dots(&chart, 1), [1, 1]);
        let (column, bucket) = hovered.unwrap();
        assert_eq!(column, 0);
        assert_eq!(bucket.samples, 2);
        assert_eq!(bucket.slowest, Some(Duration::from_millis(90)));
        assert_eq!(bucket.first, t0());
        assert!(chart.iter().all(|line| line
            .iter()
            .any(|span| { span.tint == Tint::Hover && span.text.width() == 1 })));
        let (_, expanded) = sparkline(&host, View::default(), 4, 3, Some(1));
        assert_eq!(
            expanded.unwrap().1.samples,
            1,
            "two expanded stems are one probe"
        );
    }

    #[test]
    fn mixed_reply_and_loss_retains_reply_stems_and_loss_only_stays_distinct() {
        let mut host = host_from_slot("a", 0, &[10, 10, 90]);
        host.apply(ProbeEvent::Lost {
            seq: 0,
            slot: 3,
            sent: t0() + Duration::from_secs(3),
        });
        host.apply(ProbeEvent::Lost {
            seq: 0,
            slot: 4,
            sent: t0() + Duration::from_secs(4),
        });
        let view = View {
            level: 4,
            end: None,
        };
        let (chart, hovered) = sparkline(&host, view, 3, 3, Some(1));
        let (_, bucket) = hovered.unwrap();
        assert_eq!((bucket.samples, bucket.lost), (2, 1));
        assert_eq!(bucket.slowest, Some(Duration::from_millis(90)));
        assert_eq!(stem_dots(&chart, 1), [12, 0]);
        assert!(chart[..2].iter().all(|line| line
            .iter()
            .any(|span| span.tint == Tint::Hover && span.role == Role::Spark)));
        assert!(chart[2].iter().any(|span| {
            span.tint == Tint::Hover && span.role == Role::Spark && span.text == "⡇"
        }));
        assert!(chart[2]
            .iter()
            .any(|span| span.role == Role::Bad && span.text == "⡀"));
        for line in &chart[..2] {
            assert!(line.iter().all(|span| span.role != Role::Bad));
            let text: String = line.iter().map(|span| span.text.as_str()).collect();
            assert_eq!(text.chars().nth(2), Some(' '));
        }
    }

    #[test]
    fn bottom_only_mixed_replies_preserve_successful_baseline() {
        let mut host = host_from_slot("a", 0, &[10]);
        host.apply(ProbeEvent::Lost {
            seq: 1,
            slot: 1,
            sent: t0() + Duration::from_secs(1),
        });
        for height in 1..=3 {
            let (chart, hovered) = sparkline(
                &host,
                View {
                    level: 4,
                    end: None,
                },
                1,
                height,
                Some(0),
            );
            let (_, bucket) = hovered.unwrap();
            assert_eq!((bucket.samples, bucket.lost), (2, 1));
            assert_eq!(bucket.slowest, Some(Duration::from_millis(10)));
            assert!(chart[..height - 1].iter().all(|line| {
                line.iter()
                    .all(|span| span.role != Role::Bad && span.text.trim().is_empty())
            }));
            assert!(chart[height - 1].iter().all(|span| {
                span.role == Role::Baseline && span.tint == Tint::Hover && span.text == "⡀"
            }));
        }
    }

    #[test]
    fn failed_halves_only_use_bottom_dots_and_unscheduled_cells_stay_blank() {
        let host = HostState::new("a".into());
        let failed = Some(Bucket {
            slowest: None,
            samples: 1,
            lost: 1,
            first: t0(),
        });
        let grid = Grid {
            per_cell: 1.0,
            start: 0.0,
            end: 1.0,
            width: 1,
        };
        for (cells, glyph) in [
            ([failed, None], "⡀"),
            ([None, failed], "⢀"),
            ([failed, failed], "⣀"),
            ([None, None], " "),
        ] {
            for height in 1..=3 {
                let (chart, _) = render_sparkline(&host, grid, &cells, height, None, None);
                assert!(chart[..height - 1].iter().all(|line| {
                    line.iter()
                        .all(|span| span.text == " " && span.role == Role::Plain)
                }));
                assert_eq!(chart[height - 1][0].text, glyph);
                assert_eq!(
                    chart[height - 1][0].role,
                    if glyph == " " { Role::Plain } else { Role::Bad }
                );
                assert!(chart
                    .iter()
                    .all(|line| { line.iter().map(|span| span.text.width()).sum::<usize>() == 1 }));
            }
        }
    }

    #[test]
    fn replies_in_either_half_suppress_loss_even_inside_the_reply_bucket() {
        let host = HostState::new("a".into());
        let failed = Some(Bucket {
            slowest: None,
            samples: 1,
            lost: 1,
            first: t0(),
        });
        let grid = Grid {
            per_cell: 1.0,
            start: 0.0,
            end: 2.0,
            width: 2,
        };
        for lost in 0..=1 {
            let reply = Some(Bucket {
                slowest: Some(Duration::from_millis(90)),
                samples: 1 + lost,
                lost,
                first: t0(),
            });
            let baseline = Some(Bucket {
                slowest: Some(Duration::from_millis(10)),
                samples: 1,
                lost: 0,
                first: t0(),
            });
            for (pair, expected) in [([reply, failed], [12, 0]), ([failed, reply], [0, 12])] {
                let cells = [pair[0], pair[1], baseline, baseline];
                let (chart, _) = render_sparkline(&host, grid, &cells, 3, Some(0), None);
                assert_eq!(stem_dots(&chart, 0), expected);
                assert!(chart.iter().all(|line| {
                    line.iter()
                        .any(|span| span.tint == Tint::Hover && span.role == Role::Spark)
                        && line.iter().all(|span| span.role != Role::Bad)
                }));
            }
        }
    }
}
