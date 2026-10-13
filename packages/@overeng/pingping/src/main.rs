mod completion;
mod egress;
mod icmp;
mod live;
mod netinfo;
mod path;
mod probe;
mod render;
mod stats;
mod tailnet;
mod theme;
mod timeline;
mod uptime;
mod version;

use std::io::{IsTerminal, Write};
use std::os::unix::net::UnixStream;
use std::process::ExitCode;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use clap::Parser;

use crate::probe::{Failure, Family, ProbeConfig, ProbeEvent};
use crate::render::{fmt_ms, Layout};
use crate::stats::{HostState, Status};
use crate::theme::ThemeChoice;

/// Ping one or more hosts with a live view of latency and loss.
#[derive(Debug, Parser)]
#[command(name = "pingping", version = version(), about)]
struct Cli {
    /// Hosts to ping concurrently (names or IP addresses).
    #[arg(required = true, value_name = "HOST", value_parser = parse_host,
        add = clap_complete::ArgValueCompleter::new(completion::host_candidates))]
    hosts: Vec<String>,

    /// Stop after sending this many probes per host.
    #[arg(short = 'c', long)]
    count: Option<u32>,

    /// Seconds between probes per host.
    #[arg(short = 'i', long, default_value_t = 1.0, value_parser = parse_secs)]
    interval: f64,

    /// Seconds to wait for a reply before counting a probe as lost.
    #[arg(short = 'W', long, default_value_t = 2.0, value_parser = parse_secs)]
    timeout: f64,

    /// Use IPv4 only.
    #[arg(short = '4', conflicts_with = "ipv6")]
    ipv4: bool,

    /// Use IPv6 only.
    #[arg(short = '6')]
    ipv6: bool,

    /// Live view layout; toggle at runtime with `l`.
    #[arg(long, value_enum, default_value_t = Layout::Stacked)]
    layout: Layout,

    /// Color palette.
    #[arg(long, value_enum, default_value_t = ThemeChoice::Auto)]
    theme: ThemeChoice,
}

static VERSION: LazyLock<String> =
    LazyLock::new(|| version::resolve(env!("CARGO_PKG_VERSION"), option_env!("CLI_BUILD_STAMP")));

fn version() -> &'static str {
    &VERSION
}

fn parse_secs(value: &str) -> Result<f64, String> {
    let secs: f64 = value
        .parse()
        .map_err(|_| format!("`{value}` is not a number"))?;
    if secs >= 0.01
        && Duration::try_from_secs_f64(secs)
            .is_ok_and(|duration| Instant::now().checked_add(duration).is_some())
    {
        Ok(secs)
    } else {
        Err("must be a finite duration of at least 0.01 seconds".into())
    }
}

fn parse_host(value: &str) -> Result<String, String> {
    if value.is_empty() || value.chars().any(char::is_control) {
        Err("host must be nonempty and contain no control characters".into())
    } else {
        Ok(value.to_owned())
    }
}

#[allow(
    clippy::too_many_lines,
    reason = "entrypoint owns worker startup and shutdown ordering"
)]
fn main() -> ExitCode {
    completion::activate();
    let cli = Cli::parse();
    let config = ProbeConfig {
        interval: Duration::from_secs_f64(cli.interval),
        timeout: Duration::from_secs_f64(cli.timeout),
        count: cli.count,
        family: if cli.ipv4 {
            Family::V4
        } else if cli.ipv6 {
            Family::V6
        } else {
            Family::Any
        },
        start: Instant::now(),
    };

    let stop = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::channel();
    let interactive = std::io::stdout().is_terminal();
    let notification = if interactive {
        match UnixStream::pair().and_then(|(reader, writer)| {
            reader.set_nonblocking(true)?;
            writer.set_nonblocking(true)?;
            Ok((reader, Arc::new(writer)))
        }) {
            Ok(pair) => Some(pair),
            Err(err) => {
                eprintln!("pingping: terminal notification error: {err}");
                return ExitCode::from(2);
            }
        }
    } else {
        None
    };
    let mut hosts: Vec<HostState> = cli.hosts.iter().cloned().map(HostState::new).collect();
    let schedule = Arc::new(probe::Schedule::new(config.clone()));
    let workers: Vec<_> = cli
        .hosts
        .iter()
        .enumerate()
        .map(|(index, host)| {
            probe::spawn(
                index,
                host.clone(),
                config.clone(),
                Arc::clone(&stop),
                tx.clone(),
                notification.as_ref().map(|(_, writer)| Arc::clone(writer)),
                Arc::clone(&schedule),
            )
        })
        .collect();
    let uptime_workers: Vec<_> = notification
        .as_ref()
        .map(|(_, writer)| {
            cli.hosts
                .iter()
                .enumerate()
                .map(|(index, host)| {
                    uptime::spawn(
                        index,
                        host.clone(),
                        tx.clone(),
                        Arc::clone(writer),
                        Arc::clone(&stop),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    let paths = notification.as_ref().map(|(_, writer)| {
        path::Monitor::spawn(Arc::clone(&schedule), tx.clone(), Arc::clone(writer))
    });
    egress::spawn(
        0,
        tx.clone(),
        notification.as_ref().map(|(_, writer)| Arc::clone(writer)),
    );
    drop(tx);

    let notification_reader = notification.map(|(reader, _)| reader);
    let result = if let Some(notification_reader) = &notification_reader {
        live::run(
            &mut hosts,
            &rx,
            notification_reader,
            &stop,
            cli.layout,
            cli.theme,
            config.interval,
            paths.as_ref().expect("interactive monitor"),
            &schedule,
        )
    } else {
        print_plain(&mut hosts, &rx, &mut std::io::stdout().lock())
    };
    // The reader went away (`pingping host | head`): stop quietly, like `ping`.
    let pipe_closed = matches!(&result, Err(err) if err.kind() == std::io::ErrorKind::BrokenPipe);
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    drop(uptime_workers);
    drop(paths);
    for worker in workers {
        let _ = worker.join();
    }
    if pipe_closed {
        return ExitCode::SUCCESS;
    }
    if let Err(err) = result {
        eprintln!("pingping: terminal error: {err}");
        return ExitCode::from(2);
    }

    for host in &hosts {
        if let Status::Failed { reason, kind } = &host.status {
            match kind {
                Failure::NotPermitted => print_not_permitted(reason),
                Failure::Socket => {
                    eprintln!(
                        "CRITICAL: cannot open an ICMP socket for {} ({reason})",
                        host.host
                    );
                }
                Failure::Resolve => {}
            }
        }
    }
    ExitCode::from(exit_status(&hosts))
}

/// R04: 2 on any setup error (ICMP socket not permitted or not available),
/// 1 when some host received no reply, else 0.
fn exit_status(hosts: &[HostState]) -> u8 {
    let setup_error = hosts.iter().any(|host| {
        matches!(
            host.status,
            Status::Failed {
                kind: Failure::NotPermitted | Failure::Socket,
                ..
            }
        )
    });
    if setup_error {
        2
    } else {
        u8::from(!hosts.iter().all(|host| host.received > 0))
    }
}

/// Non-TTY output: one line per probe outcome, then a summary per host.
fn print_plain(
    hosts: &mut [HostState],
    rx: &mpsc::Receiver<(usize, ProbeEvent)>,
    out: &mut impl Write,
) -> std::io::Result<()> {
    let tailnet = tailnet::status();
    #[cfg(target_os = "macos")]
    let _network_monitor = pingping_netinfo_macos::NetInfoMonitor::start(|| {});
    let mut network_printed = false;
    let mut egress_printed = false;
    for (index, event) in rx {
        let host = &mut hosts[index];
        let name = host.host.as_str();
        match &event {
            ProbeEvent::Resolved(addr) => {
                writeln!(out, "{name} resolved to {addr}")?;
                if let Some(note) = path::initial(tailnet.as_ref(), *addr) {
                    writeln!(out, "{name} {}", note.text)?;
                    host.path.note = Some(note);
                }
            }
            ProbeEvent::Failed { reason, .. } => writeln!(out, "{name} failed: {reason}")?,
            ProbeEvent::Reply { seq, rtt, .. } => {
                writeln!(out, "{name} seq={seq} time={}", fmt_ms(*rtt))?;
            }
            ProbeEvent::Lost { seq, .. } => writeln!(out, "{name} seq={seq} lost")?,
            ProbeEvent::Finished
            | ProbeEvent::Path { .. }
            | ProbeEvent::Scheduled { .. }
            | ProbeEvent::Network(_)
            | ProbeEvent::Boot(_)
            | ProbeEvent::Egress { .. } => {}
        }
        host.apply_plain(event);
        if !egress_printed {
            if let Some(info) = &hosts[0].egress.info {
                writeln!(out, "egress: {} (AS{})", info.label(), info.asn)?;
                egress_printed = true;
            }
        }
        if !network_printed
            && hosts
                .iter()
                .all(|host| !matches!(host.status, Status::Resolving))
        {
            let interface = netinfo::select(
                hosts
                    .iter()
                    .filter_map(|host| host.path.note.as_ref()?.interface.as_deref()),
            );
            if let Some(info) = interface.as_deref().and_then(netinfo::snapshot) {
                let info = netinfo::with_wifi(info);
                writeln!(out, "network: {}", info.plain())?;
            }
            network_printed = true;
        }
        // Optional lookup workers must never prolong a completed plain run.
        if hosts.iter().all(|host| host.finished) {
            break;
        }
    }
    for host in hosts.iter() {
        if host.completed() == 0 {
            continue;
        }
        let pct = host.loss_pct().unwrap_or(0.0);
        let rtts = match (host.min, host.avg(), host.max) {
            (Some(min), Some(avg), Some(max)) => format!(
                ", min/avg/max {} / {} / {}",
                fmt_ms(min),
                fmt_ms(avg),
                fmt_ms(max)
            ),
            _ => String::new(),
        };
        writeln!(
            out,
            "{}: {} of {} received, {pct:.0}% loss{rtts}",
            host.host,
            host.received,
            host.completed()
        )?;
    }
    out.flush()
}

fn print_not_permitted(reason: &str) {
    eprintln!("CRITICAL: unprivileged ICMP sockets are not permitted for this user ({reason})");
    if cfg!(target_os = "linux") {
        eprintln!("  net.ipv4.ping_group_range must include one of your group ids");
        eprintln!(
            "  fix: configure net.ipv4.ping_group_range to include one of the current user's groups"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_durations_that_cannot_be_scheduled() {
        for value in ["NaN", "inf", "-1", "0", "1e100"] {
            assert!(parse_secs(value).is_err(), "{value}");
        }
        assert_eq!(parse_secs("0.01"), Ok(0.01));
    }

    #[test]
    fn rejects_terminal_control_characters_in_hosts() {
        assert!(parse_host("example.com\n\x1b[2J").is_err());
        assert_eq!(parse_host("example.com"), Ok("example.com".into()));
    }

    fn with_status(events: &[ProbeEvent]) -> HostState {
        let mut host = HostState::new("h".into());
        for event in events {
            host.apply(event.clone());
        }
        host
    }

    /// A writer whose reader has gone away, like stdout piped into `head`.
    struct ClosedPipe;

    impl Write for ClosedPipe {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::ErrorKind::BrokenPipe.into())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn plain_output_reports_a_closed_pipe_instead_of_panicking() {
        let (tx, rx) = mpsc::channel();
        tx.send((
            0,
            ProbeEvent::Reply {
                seq: 1,
                slot: 0,
                rtt: Duration::from_millis(3),
                sent: std::time::SystemTime::UNIX_EPOCH,
            },
        ))
        .unwrap();
        drop(tx);
        let mut hosts = vec![HostState::new("example".into())];
        let err = print_plain(&mut hosts, &rx, &mut ClosedPipe).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::BrokenPipe);
    }

    #[test]
    fn exit_status_distinguishes_setup_errors_from_unreachable_hosts() {
        let reply = ProbeEvent::Reply {
            seq: 1,
            slot: 0,
            rtt: Duration::from_millis(1),
            sent: std::time::SystemTime::UNIX_EPOCH,
        };
        let failed = |kind| ProbeEvent::Failed {
            reason: "x".into(),
            kind,
        };
        let ok = with_status(std::slice::from_ref(&reply));
        let silent = with_status(&[]);
        assert_eq!(exit_status(std::slice::from_ref(&ok)), 0);
        assert_eq!(exit_status(&[ok.clone(), silent]), 1);
        assert_eq!(
            exit_status(&[ok.clone(), with_status(&[failed(Failure::Resolve)])]),
            1
        );
        assert_eq!(
            exit_status(&[ok.clone(), with_status(&[failed(Failure::Socket)])]),
            2
        );
        assert_eq!(
            exit_status(&[ok, with_status(&[failed(Failure::NotPermitted)])]),
            2
        );
    }
}
