use super::{span, timeline, HostState, Line, Role, Span, SystemTime, UnicodeWidthStr};
use crate::stats::DropAge;

pub(super) fn notice(host: &HostState, now: SystemTime) -> Option<Span> {
    let text = match host.drop_age(now)? {
        DropAge::NeverReplied => "no reply yet".into(),
        DropAge::SinceReply(age) => format!("no reply for {}", timeline::fmt_span(age)),
    };
    Some(span(Role::Bad, text))
}

pub(super) fn clear_notice(line: &mut Line) {
    if line.len() >= 2
        && line.last().is_some_and(|span| span.role == Role::Bad)
        && line[line.len() - 2].role == Role::Plain
        && line[line.len() - 2].text.width() >= 3
        && line[line.len() - 2].text.chars().all(char::is_whitespace)
    {
        line.truncate(line.len() - 2);
    }
}

pub(super) fn current(
    host: &HostState,
    now: SystemTime,
    width: usize,
    value: Option<super::Duration>,
) -> Span {
    let (role, text) = match host.drop_age(now) {
        None => (Role::Value, value.map_or_else(|| "-".into(), super::fmt_ms)),
        Some(DropAge::NeverReplied) => (Role::Bad, "no reply yet".into()),
        Some(DropAge::SinceReply(age)) => (Role::Bad, format!("down {}", timeline::fmt_span(age))),
    };
    span(role, format!("{text:>width$}"))
}

pub(super) fn current_width(host: &HostState, now: SystemTime) -> usize {
    let width = match host.drop_age(now) {
        None => 9,
        Some(DropAge::NeverReplied) => "no reply yet".len(),
        Some(DropAge::SinceReply(age)) => {
            let digits = |value: u64| {
                usize::try_from(value.max(1).ilog10() + 1).expect("decimal digit count fits usize")
            };
            let seconds = age.as_secs();
            5 + if seconds == 0 {
                digits(u64::from(age.subsec_millis())) + 2
            } else if seconds < 60 {
                digits(seconds) + 1
            } else if seconds < 3600 {
                digits(seconds / 60) + 4
            } else {
                digits(seconds / 3600) + 4
            }
        }
    };
    width.max(9)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::probe::ProbeEvent;
    use crate::render::{frame, Hover, Layout, Timeline};
    use crate::timeline::View;
    use std::time::Duration;

    fn dropped_host(replied: bool) -> (HostState, SystemTime) {
        let sent = SystemTime::UNIX_EPOCH + Duration::from_hours(497_488);
        let mut host = HostState::new("downhost".into());
        host.apply(ProbeEvent::Resolved("127.0.0.1".parse().unwrap()));
        if replied {
            host.apply(ProbeEvent::Reply {
                seq: 0,
                slot: 0,
                rtt: Duration::from_millis(5),
                sent,
            });
        }
        for slot in 1..=3 {
            host.apply(ProbeEvent::Lost {
                seq: u16::try_from(slot).unwrap(),
                slot,
                sent: sent + Duration::from_secs(slot),
            });
        }
        (
            host,
            sent + Duration::from_millis(5) + Duration::from_secs(130),
        )
    }

    fn timeline(now: SystemTime) -> Timeline {
        Timeline {
            now,
            interval: Duration::from_secs(1),
            current_interval: Duration::from_secs(1),
            view: View::default(),
            hover_now: None,
            overview_end: None,
            hover: None,
            stats_scope: super::super::StatsScope::Run,
        }
    }

    fn plain(line: &Line) -> String {
        line.iter().map(|span| span.text.as_str()).collect()
    }

    #[test]
    fn pending_probes_do_not_trigger_or_break_three_completed_losses() {
        let (mut host, now) = dropped_host(false);
        // A reply clears the first completed-loss run.
        host.apply(ProbeEvent::Reply {
            seq: 4,
            slot: 4,
            rtt: Duration::from_millis(5),
            sent: now,
        });
        let seen = now + Duration::from_millis(5);
        for slot in 5..=8 {
            host.apply(ProbeEvent::Scheduled {
                slot,
                position: Duration::from_secs(slot),
                interval: Duration::from_secs(1),
            });
        }
        for slot in 5..=6 {
            host.apply(ProbeEvent::Lost {
                seq: u16::try_from(slot).unwrap(),
                slot,
                sent: seen + Duration::from_secs(slot),
            });
            assert_eq!(host.drop_age(seen), None);
        }
        host.apply(ProbeEvent::Lost {
            seq: 7,
            slot: 7,
            sent: seen + Duration::from_secs(7),
        });
        assert_eq!(
            host.drop_age(seen + Duration::from_secs(130)),
            Some(DropAge::SinceReply(Duration::from_secs(130)))
        );
        assert_eq!(
            host.drop_age(seen + Duration::from_secs(131)),
            Some(DropAge::SinceReply(Duration::from_secs(131)))
        );
        host.apply(ProbeEvent::Reply {
            seq: 8,
            slot: 8,
            rtt: Duration::from_millis(5),
            sent: seen + Duration::from_secs(8),
        });
        assert_eq!(host.drop_age(seen + Duration::from_secs(132)), None);
    }

    #[test]
    fn never_replied_host_gets_notice_only_after_three_losses() {
        let sent = SystemTime::UNIX_EPOCH;
        let mut host = HostState::new("h".into());
        for slot in 0..3 {
            assert_eq!(host.drop_age(sent), None);
            host.apply(ProbeEvent::Lost {
                seq: u16::try_from(slot).unwrap(),
                slot,
                sent,
            });
        }
        assert_eq!(host.drop_age(sent), Some(DropAge::NeverReplied));
        assert_eq!(notice(&host, sent).unwrap().text, "no reply yet");
    }

    #[test]
    fn identity_drop_age_replaces_path_and_yields_to_hover_at_every_breakpoint() {
        let (mut host, now) = dropped_host(true);
        host.path.note = Some(crate::path::Note {
            text: "tailnet direct".into(),
            endpoint: None,
            interface: None,
            source: None,
        });
        for width in [60, 80, 100, 140] {
            let mut timeline = timeline(now);
            let normal = frame(
                std::slice::from_ref(&host),
                Layout::Stacked,
                &timeline,
                width,
                40,
                true,
            );
            let identity_row = usize::from(width <= 90);
            let identity = &normal.lines[identity_row];
            assert!(
                identity
                    .iter()
                    .any(|span| span.role == Role::Bad && span.text == "no reply for 2m10s"),
                "width {width}: {}",
                plain(identity)
            );
            assert!(!plain(identity).contains("tailnet direct"));
            assert!(plain(identity).width() <= width);
            timeline.hover = Some(Hover {
                host: 0,
                cell: 0,
                overview: false,
            });
            let hovered = frame(
                std::slice::from_ref(&host),
                Layout::Stacked,
                &timeline,
                width,
                40,
                true,
            );
            assert!(
                hovered.lines[identity_row]
                    .iter()
                    .any(|span| span.role == Role::Tooltip),
                "width {width}"
            );
            assert!(!plain(&hovered.lines[identity_row]).contains("no reply for"));
        }
        let cramped = frame(
            std::slice::from_ref(&host),
            Layout::Stacked,
            &timeline(now),
            35,
            40,
            true,
        );
        assert!(!plain(&cramped.lines[1]).contains("no reply for"));
    }

    #[test]
    fn rows_show_drop_age_in_current_without_wrapping_even_after_long_outages() {
        let (host, now) = dropped_host(true);
        for age in [Duration::from_secs(130), Duration::from_hours(1000)] {
            let seen = now - Duration::from_secs(130);
            let now = seen + age;
            let frame = frame(
                std::slice::from_ref(&host),
                Layout::Rows,
                &timeline(now),
                120,
                40,
                true,
            );
            let row = &frame.lines[1];
            assert!(row.iter().any(|span| span.role == Role::Bad
                && span.text.trim() == format!("down {}", timeline::fmt_span(age))));
            assert!(plain(row).width() <= 120);
        }
        let (host, now) = dropped_host(false);
        let frame = frame(&[host], Layout::Rows, &timeline(now), 120, 40, true);
        assert!(frame.lines[1]
            .iter()
            .any(|span| span.role == Role::Bad && span.text.trim() == "no reply yet"));
    }
}
