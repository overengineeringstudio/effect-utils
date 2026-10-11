//! Manual full-history render timing and retained-memory report.

use super::tests::{t0, LIVE};
use super::*;
use crate::probe::ProbeEvent;

fn scheduled(host: &mut HostState, slot: u64) {
    host.apply(ProbeEvent::Scheduled {
        slot,
        position: Duration::from_secs(slot),
        interval: Duration::from_secs(1),
    });
}

/// Run with `cargo test --release benchmark_full_history -- --ignored --nocapture`.
#[test]
#[ignore = "manual full-history render timing and retained-memory report"]
fn benchmark_full_history() {
    use std::hint::black_box;
    use std::time::Instant;

    const SLOTS: u64 = 86_400;
    const FRAMES: u32 = 200;
    let mut hosts: Vec<_> = (0..5)
        .map(|index| {
            let mut state = HostState::new(format!("host-{index}"));
            state.apply(ProbeEvent::Resolved("192.0.2.1".parse().unwrap()));
            for slot in 0..SLOTS {
                let sent = t0() + Duration::from_secs(slot);
                scheduled(&mut state, slot);
                state.apply(if slot.is_multiple_of(31) {
                    ProbeEvent::Lost { seq: 0, slot, sent }
                } else {
                    ProbeEvent::Reply {
                        seq: 0,
                        slot,
                        rtt: Duration::from_micros(500 + (slot * 37) % 10_000),
                        sent,
                    }
                });
            }
            state
        })
        .collect();
    for state in &hosts {
        let (len, capacity) = state.history_allocation();
        eprintln!(
            "{}: samples={} history_capacity={} retained_bytes={}",
            state.host,
            len,
            capacity,
            state.retained_bytes(),
        );
    }

    let mut fit = View::default();
    let extent = Extent::of(&hosts);
    for _ in 0..100 {
        fit.zoom(false, None, 100, extent);
    }
    for (name, layout, view) in [
        ("default_live_rows", Layout::Rows, View::default()),
        ("default_live_stacked", Layout::Stacked, View::default()),
        ("fit_all", Layout::Stacked, fit),
        // At full retention, stacked live automatically draws an overview.
        ("default_live_overview", Layout::Stacked, View::default()),
    ] {
        let timeline = Timeline { view, ..LIVE };
        let sample = frame(&hosts, layout, &timeline, 200, 40, true);
        for index in 0..hosts.len() {
            assert!(sample.timeline_lines.iter().any(|(line, host, overview)| {
                *host == index && !overview && *line < sample.lines.len()
            }));
        }
        eprintln!(
            "{name}: timeline_width={} lines={} overview_hosts={}",
            sample.timeline.1,
            sample.lines.len(),
            sample.overviews.iter().flatten().count(),
        );
        for _ in 0..10 {
            black_box(frame(&hosts, layout, &timeline, 200, 40, true));
        }
        let started = Instant::now();
        for _ in 0..FRAMES {
            black_box(frame(
                black_box(&hosts),
                layout,
                black_box(&timeline),
                200,
                40,
                true,
            ));
        }
        eprintln!(
            "{name}: {FRAMES} frames in {:?}, {:?}/frame",
            started.elapsed(),
            started.elapsed() / FRAMES,
        );
    }

    // Touch a complete ring cycle after retention fills. Untouched spare
    // capacity otherwise understates long-run RSS in external `time -v`.
    for host in &mut hosts {
        for slot in SLOTS..SLOTS + 131_072 {
            scheduled(host, slot);
            host.apply(ProbeEvent::Reply {
                seq: 0,
                slot,
                rtt: Duration::from_micros(500),
                sent: t0() + Duration::from_secs(slot),
            });
        }
        eprintln!(
            "{} after rolling: history={:?} retained_bytes={}",
            host.host,
            host.history_allocation(),
            host.retained_bytes(),
        );
    }
}
