//! Private, append-only session history, separate from current-run statistics.
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

use crate::probe::ProbeEvent;
use crate::stats::{Entry, Sample};
use crate::tailnet::{self, Status};

const RETENTION: Duration = Duration::from_hours(168);
static NEXT_FILE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, PartialEq)]
pub struct HistoricalSession {
    pub id: String,
    pub start: SystemTime,
    pub interval: Duration,
    pub samples: Vec<Entry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", content = "name", rename_all = "snake_case")]
enum Identity {
    TailnetDns(String),
    Host(String),
}

impl Identity {
    fn resolve(host: &str, status: Option<&Status>) -> Self {
        let normalized = host.trim_end_matches('.').to_ascii_lowercase();
        let ip = host.parse::<std::net::IpAddr>().ok();
        if let Some(status) = status {
            for peer in status.self_peer.iter().chain(status.peers.values()) {
                let dns = peer.dns_name.trim_end_matches('.').to_ascii_lowercase();
                if !dns.is_empty()
                    && (normalized == dns
                        || dns.split('.').next() == Some(normalized.as_str())
                        || ip.is_some_and(|ip| peer.ips.contains(&ip)))
                {
                    return Self::TailnetDns(dns);
                }
            }
        }
        Self::Host(host.to_owned())
    }

    fn filename(&self) -> String {
        use std::fmt::Write as _;
        let (kind, name) = match self {
            Self::TailnetDns(name) => ("tailnet", name),
            Self::Host(name) => ("host", name),
        };
        let mut encoded = format!("{kind}-");
        // Bound the display prefix below NAME_MAX; the header stores full identity.
        for byte in name.bytes().take(48) {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_') {
                encoded.push(char::from(byte));
            } else {
                write!(encoded, "%{byte:02X}").expect("writing to a String cannot fail");
            }
        }
        encoded
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    version: u32,
    session_id: String,
    host: Identity,
    start_utc: String,
    interval_ns: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredSample {
    utc: String,
    offset_ns: u64,
    outcome: Outcome,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Outcome {
    Reply { rtt_ns: u64 },
    Lost,
}

struct Writer {
    file: File,
    positions: HashMap<u64, Duration>,
    // One high-water slot per wire sequence, bounded at 65,536 entries.
    recorded: HashMap<u16, u64>,
}
pub struct Store {
    writers: Vec<Writer>,
    clock: Instant,
}

impl Store {
    pub fn open(
        hosts: &[String],
        interval: Duration,
    ) -> io::Result<(Self, Vec<Vec<HistoricalSession>>)> {
        Self::open_at(
            &state_directory()?,
            hosts,
            interval,
            SystemTime::now(),
            tailnet::status().as_ref(),
        )
    }

    fn open_at(
        root: &Path,
        hosts: &[String],
        interval: Duration,
        now: SystemTime,
        status: Option<&Status>,
    ) -> io::Result<(Self, Vec<Vec<HistoricalSession>>)> {
        let clock = Instant::now();
        private_directory(root)?;
        if interval.is_zero() {
            return Err(invalid("history interval must be positive"));
        }
        let identities: Vec<_> = hosts
            .iter()
            .map(|host| Identity::resolve(host, status))
            .collect();
        let prior = load(root, &identities, now)?;
        let writers = identities
            .iter()
            .map(|identity| {
                let (file, _) = create_session(root, identity, now, interval)?;
                Ok(Writer {
                    file,
                    positions: HashMap::new(),
                    recorded: HashMap::new(),
                })
            })
            .collect::<io::Result<_>>()?;
        Ok((Self { writers, clock }, prior))
    }

    /// Records final outcomes once per schedule slot; metadata is not a sample.
    pub fn record(&mut self, index: usize, event: &ProbeEvent) -> io::Result<()> {
        let writer = self
            .writers
            .get_mut(index)
            .ok_or_else(|| invalid("invalid history host index"))?;
        if let ProbeEvent::Scheduled { slot, position, .. } = event {
            writer.positions.insert(*slot, *position);
            return Ok(());
        }
        let (seq, slot, sent, outcome) = match event {
            ProbeEvent::Reply {
                seq,
                slot,
                sent,
                rtt,
            } => (
                *seq,
                *slot,
                *sent,
                Outcome::Reply {
                    rtt_ns: nanos(*rtt)?,
                },
            ),
            ProbeEvent::Lost { seq, slot, sent } => (*seq, *slot, *sent, Outcome::Lost),
            _ => return Ok(()),
        };
        if writer
            .recorded
            .get(&seq)
            .is_some_and(|previous| *previous >= slot)
        {
            return Ok(());
        }
        let offset = writer
            .positions
            .get(&slot)
            .copied()
            .unwrap_or_else(|| self.clock.elapsed());
        append(
            &mut writer.file,
            &StoredSample {
                utc: utc(sent),
                offset_ns: nanos(offset)?,
                outcome,
            },
        )?;
        writer.recorded.insert(seq, slot);
        writer.positions.remove(&slot);
        Ok(())
    }
}

fn state_directory() -> io::Result<PathBuf> {
    let base = std::env::var_os("XDG_STATE_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/state")))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "neither XDG_STATE_HOME nor HOME is set",
            )
        })?;
    Ok(base.join("pingping"))
}

fn private_directory(root: &Path) -> io::Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(root)?;
    if fs::symlink_metadata(root)?.file_type().is_symlink() {
        return Err(invalid("history directory must not be a symlink"));
    }
    fs::set_permissions(root, fs::Permissions::from_mode(0o700))
}

fn create_session(
    root: &Path,
    host: &Identity,
    start: SystemTime,
    interval: Duration,
) -> io::Result<(File, String)> {
    let timestamp = start
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(invalid)?
        .as_nanos();
    let interval_ns = nanos(interval)?;
    loop {
        let serial = NEXT_FILE.fetch_add(1, Ordering::Relaxed);
        let id = format!("{timestamp}-{}-{serial}", std::process::id());
        let path = root.join(format!("{}--{id}.jsonl", host.filename()));
        // Publish a complete header atomically, without replacing another writer.
        // Readers ignore .pending files, including abandoned partial headers.
        let pending = path.with_extension("pending");
        match OpenOptions::new()
            .append(true)
            .create_new(true)
            .mode(0o600)
            .open(&pending)
        {
            Ok(mut file) => {
                let published = append(
                    &mut file,
                    &Header {
                        version: 1,
                        session_id: id.clone(),
                        host: host.clone(),
                        start_utc: utc(start),
                        interval_ns,
                    },
                )
                .and_then(|()| fs::hard_link(&pending, &path));
                fs::remove_file(&pending)?;
                match published {
                    Ok(()) => return Ok((file, id)),
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(error),
                }
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
}

fn append(file: &mut File, value: &impl Serialize) -> io::Result<()> {
    let mut bytes = serde_json::to_vec(value).map_err(invalid)?;
    bytes.push(b'\n');
    file.write_all(&bytes)
}

fn load(
    root: &Path,
    hosts: &[Identity],
    now: SystemTime,
) -> io::Result<Vec<Vec<HistoricalSession>>> {
    let cutoff = now.checked_sub(RETENTION).unwrap_or(SystemTime::UNIX_EPOCH);
    let mut result = vec![Vec::new(); hosts.len()];
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if entry
            .path()
            .extension()
            .is_none_or(|extension| extension != "jsonl")
        {
            continue;
        }
        // Another startup can prune an expired journal after directory enumeration.
        match entry.file_type() {
            Ok(kind) if kind.is_file() => {}
            Ok(_) => continue,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        }
        let (identity, mut session) = match read_session(&entry.path()) {
            Ok(session) => session,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        let latest = session
            .samples
            .iter()
            .map(|sample| sample.sent)
            .max()
            .unwrap_or(session.start);
        if latest < cutoff {
            match fs::remove_file(entry.path()) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            continue;
        }
        session.samples.retain(|sample| sample.sent >= cutoff);
        session.samples.sort_by_key(|sample| sample.sent);
        let mut matches = hosts
            .iter()
            .zip(&mut result)
            .filter(|(host, _)| **host == identity);
        if let Some((_, first)) = matches.next() {
            for (_, other) in matches {
                other.push(session.clone());
            }
            first.push(session);
        }
    }
    for sessions in &mut result {
        sessions.sort_by(|a, b| a.start.cmp(&b.start).then_with(|| a.id.cmp(&b.id)));
    }
    Ok(result)
}

fn read_session(path: &Path) -> io::Result<(Identity, HistoricalSession)> {
    let mut reader = BufReader::new(File::open(path)?);
    let mut line = Vec::new();
    reader.read_until(b'\n', &mut line)?;
    if !line.ends_with(b"\n") {
        return Err(invalid(format!(
            "{}: incomplete history header",
            path.display()
        )));
    }
    let header: Header = serde_json::from_slice(&line)
        .map_err(|error| invalid(format!("{}: {error}", path.display())))?;
    if header.version != 1 || header.session_id.is_empty() || header.interval_ns == 0 {
        return Err(invalid(format!(
            "{}: invalid or unsupported history header",
            path.display()
        )));
    }
    let mut session = HistoricalSession {
        id: header.session_id,
        start: parse_utc(&header.start_utc)?,
        interval: Duration::from_nanos(header.interval_ns),
        samples: Vec::new(),
    };
    loop {
        line.clear();
        // A crash or concurrent append can leave an uncommitted final record.
        if reader.read_until(b'\n', &mut line)? == 0 || !line.ends_with(b"\n") {
            break;
        }
        let sample: StoredSample = serde_json::from_slice(&line)
            .map_err(|error| invalid(format!("{}: {error}", path.display())))?;
        session.samples.push(Entry {
            sent: parse_utc(&sample.utc)?,
            sample: match sample.outcome {
                Outcome::Reply { rtt_ns } => Sample::Reply(Duration::from_nanos(rtt_ns)),
                Outcome::Lost => Sample::Lost,
            },
        });
    }
    Ok((header.host, session))
}

fn utc(time: SystemTime) -> String {
    DateTime::<Utc>::from(time).to_rfc3339_opts(SecondsFormat::Nanos, true)
}
fn parse_utc(value: &str) -> io::Result<SystemTime> {
    DateTime::parse_from_rfc3339(value)
        .map(|time| SystemTime::from(time.with_timezone(&Utc)))
        .map_err(invalid)
}
fn nanos(duration: Duration) -> io::Result<u64> {
    u64::try_from(duration.as_nanos()).map_err(invalid)
}
fn invalid(error: impl std::fmt::Display) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            let serial = NEXT_FILE.fetch_add(1, Ordering::Relaxed);
            let timestamp = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "pingping-history-test-{}-{timestamp}-{serial}",
                std::process::id()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
    fn now() -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_hours(500_000)
    }
    fn hosts() -> Vec<String> {
        vec!["host-a.example.test".into()]
    }
    fn open(root: &Path, at: SystemTime) -> (Store, Vec<Vec<HistoricalSession>>) {
        Store::open_at(root, &hosts(), Duration::from_secs(1), at, None).unwrap()
    }

    #[test]
    fn roundtrip_deduplicates_outcomes_and_preserves_loss() {
        let directory = Directory::new();
        let (mut store, prior) = open(&directory.0, now());
        assert_eq!(prior[0].len(), 0);
        let reply = ProbeEvent::Reply {
            seq: 1,
            slot: 0,
            sent: now(),
            rtt: Duration::from_micros(1234),
        };
        store.record(0, &reply).unwrap();
        store.record(0, &reply).unwrap();
        store
            .record(
                0,
                &ProbeEvent::Lost {
                    seq: 2,
                    slot: 1,
                    sent: now() + Duration::from_secs(1),
                },
            )
            .unwrap();
        let (_, prior) = open(&directory.0, now() + Duration::from_secs(2));
        assert_eq!(prior[0].len(), 1);
        assert_eq!(prior[0][0].interval, Duration::from_secs(1));
        assert_eq!(
            prior[0][0].samples,
            vec![
                Entry {
                    sent: now(),
                    sample: Sample::Reply(Duration::from_micros(1234))
                },
                Entry {
                    sent: now() + Duration::from_secs(1),
                    sample: Sample::Lost
                },
            ]
        );
        assert_eq!(
            fs::metadata(&directory.0).unwrap().permissions().mode() & 0o777,
            0o700
        );
        for entry in fs::read_dir(&directory.0).unwrap() {
            assert_eq!(
                entry.unwrap().metadata().unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn out_of_order_outcomes_and_sequence_wrap_remain_distinct() {
        let directory = Directory::new();
        let (mut store, _) = open(&directory.0, now());
        for slot in [1, 0, 65_536] {
            store
                .record(
                    0,
                    &ProbeEvent::Scheduled {
                        slot,
                        position: Duration::from_secs(slot),
                        interval: Duration::from_secs(1),
                    },
                )
                .unwrap();
            store
                .record(
                    0,
                    &ProbeEvent::Lost {
                        seq: u16::try_from(slot % 65_536).unwrap(),
                        slot,
                        sent: now() + Duration::from_secs(slot),
                    },
                )
                .unwrap();
        }
        store
            .record(
                0,
                &ProbeEvent::Lost {
                    seq: 0,
                    slot: 0,
                    sent: now(),
                },
            )
            .unwrap();
        let (_, previous) = open(&directory.0, now());
        assert_eq!(previous[0][0].samples.len(), 3);
        assert_eq!(previous[0][0].samples[0].sent, now());
        assert_eq!(
            previous[0][0].samples[1].sent,
            now() + Duration::from_secs(1)
        );
        assert_eq!(store.writers[0].recorded.len(), 2);
        let path = fs::read_dir(&directory.0)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| read_session(path).unwrap().1.samples.len() == 3)
            .unwrap();
        let lines = fs::read_to_string(path).unwrap();
        let samples: Vec<StoredSample> = lines
            .lines()
            .skip(1)
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(samples[0].offset_ns, 1_000_000_000);
        assert_eq!(samples[1].offset_ns, 0);
    }

    #[test]
    fn concurrent_sessions_have_distinct_files_and_ids() {
        let directory = Directory::new();
        let (_first, _) = open(&directory.0, now());
        let (_second, previous) = open(&directory.0, now());
        let (_third, all) = open(&directory.0, now());
        assert_eq!(previous[0].len(), 1);
        assert_eq!(all[0].len(), 2);
        assert_ne!(all[0][0].id, all[0][1].id);
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 3);
    }

    #[test]
    fn retention_prunes_expired_sessions_but_keeps_recent_samples() {
        let directory = Directory::new();
        let old = now() - RETENTION - Duration::from_secs(1);
        let (mut recent, _) = open(&directory.0, old);
        recent
            .record(
                0,
                &ProbeEvent::Lost {
                    seq: 0,
                    slot: 0,
                    sent: old,
                },
            )
            .unwrap();
        recent
            .record(
                0,
                &ProbeEvent::Lost {
                    seq: 1,
                    slot: 1,
                    sent: now(),
                },
            )
            .unwrap();
        let (_expired, _) = open(&directory.0, old);
        let (_, prior) = open(&directory.0, now());
        assert_eq!(prior[0].len(), 1);
        assert_eq!(prior[0][0].samples.len(), 1);
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 2);
    }

    #[test]
    fn canonical_tailnet_identity_unifies_dns_short_name_and_ip() {
        let mut status = Status::default();
        status.peers.insert(
            "peer".into(),
            tailnet::Peer {
                dns_name: "host-a.example.ts.net.".into(),
                ips: vec!["100.64.0.1".parse().unwrap()],
                ..tailnet::Peer::default()
            },
        );
        let expected = Identity::TailnetDns("host-a.example.ts.net".into());
        for host in ["HOST-A", "Host-A.Example.Ts.Net.", "100.64.0.1"] {
            assert_eq!(Identity::resolve(host, Some(&status)), expected);
        }
        assert_eq!(
            Identity::resolve("other.example.test", Some(&status)),
            Identity::Host("other.example.test".into())
        );
        assert_eq!(
            Identity::resolve("Other.Example.Test.", None),
            Identity::Host("Other.Example.Test.".into())
        );
        assert_eq!(
            Identity::Host("a/b%:c".into()).filename(),
            "host-a%2Fb%25%3Ac"
        );
        assert_ne!(
            Identity::Host("host-a".into()).filename(),
            Identity::TailnetDns("host-a".into()).filename()
        );
        let directory = Directory::new();
        let (mut store, _) = Store::open_at(
            &directory.0,
            &["HOST-A".into()],
            Duration::from_secs(1),
            now(),
            Some(&status),
        )
        .unwrap();
        store
            .record(
                0,
                &ProbeEvent::Lost {
                    seq: 0,
                    slot: 0,
                    sent: now(),
                },
            )
            .unwrap();
        let (_, previous) = Store::open_at(
            &directory.0,
            &["100.64.0.1".into()],
            Duration::from_secs(1),
            now(),
            Some(&status),
        )
        .unwrap();
        assert_eq!(previous[0].len(), 1);
        assert_eq!(previous[0][0].samples.len(), 1);
    }

    #[test]
    fn non_tailnet_identity_matches_the_exact_typed_host() {
        let directory = Directory::new();
        let (_store, _) = Store::open_at(
            &directory.0,
            &["Other.Example.Test.".into()],
            Duration::from_secs(1),
            now(),
            None,
        )
        .unwrap();
        let (_, prior) = Store::open_at(
            &directory.0,
            &["other.example.test".into(), "Other.Example.Test.".into()],
            Duration::from_secs(1),
            now(),
            None,
        )
        .unwrap();
        assert_eq!(prior[0].len(), 0);
        assert_eq!(prior[1].len(), 1);
    }

    #[test]
    fn initializing_partial_header_is_not_visible_to_loaders() {
        let directory = Directory::new();
        let pending = directory.0.join("host-example--initializing.pending");
        fs::write(&pending, b"{\"version\":1").unwrap();
        let (_store, prior) = open(&directory.0, now());
        assert_eq!(prior[0].len(), 0);
        assert_eq!(fs::read(pending).unwrap(), b"{\"version\":1");
    }

    #[test]
    fn truncated_sample_is_ignored_but_bad_headers_and_complete_records_fail() {
        let directory = Directory::new();
        let identity = Identity::resolve(&hosts()[0], None);
        let (mut file, _) =
            create_session(&directory.0, &identity, now(), Duration::from_secs(1)).unwrap();
        file.write_all(b"{\"utc\":").unwrap();
        let path = fs::read_dir(&directory.0)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(read_session(&path).unwrap().1.samples.len(), 0);
        file.write_all(b"garbage}\n").unwrap();
        assert!(read_session(&path).is_err());
        let invalid_path = directory.0.join("invalid.jsonl");
        fs::write(&invalid_path, b"{\"version\":1").unwrap();
        assert!(read_session(&invalid_path).is_err());
        fs::write(&invalid_path, b"{}\n").unwrap();
        assert!(read_session(&invalid_path).is_err());
    }

    #[test]
    fn reads_existing_v1_jsonl_without_migration() {
        let directory = Directory::new();
        let path = directory.0.join("host-example--existing.jsonl");
        fs::write(&path, concat!(
            "{\"version\":1,\"session_id\":\"existing\",\"host\":{\"kind\":\"host\",\"name\":\"host-a.example.test\"},\"start_utc\":\"2026-11-14T00:00:00.000000000Z\",\"interval_ns\":1000000000}\n",
            "{\"utc\":\"2026-11-14T00:00:01.000000000Z\",\"offset_ns\":1000000000,\"outcome\":{\"kind\":\"reply\",\"rtt_ns\":1234000}}\n",
            "{\"utc\":\"2026-11-14T00:00:02.000000000Z\",\"offset_ns\":2000000000,\"outcome\":{\"kind\":\"lost\"}}\n",
        )).unwrap();
        let (_, previous) = open(&directory.0, parse_utc("2026-11-14T00:00:03Z").unwrap());
        assert_eq!(previous[0][0].id, "existing");
        assert_eq!(previous[0][0].samples.len(), 2);
        assert_eq!(
            previous[0][0].samples[0].sample,
            Sample::Reply(Duration::from_micros(1234))
        );
        assert!(path.exists());
    }

    #[test]
    fn concurrent_loaders_can_prune_the_same_expired_journals() {
        let directory = Directory::new();
        let root = &directory.0;
        let identity = Identity::Host("host-a.example.test".into());
        let now = SystemTime::UNIX_EPOCH + Duration::from_hours(500_000);
        for _ in 0..128 {
            create_session(
                root,
                &identity,
                now - RETENTION - Duration::from_secs(1),
                Duration::from_secs(1),
            )
            .unwrap();
        }
        let barrier = std::sync::Barrier::new(4);
        std::thread::scope(|scope| {
            let mut readers = Vec::new();
            for _ in 0..4 {
                readers.push(scope.spawn(|| {
                    barrier.wait();
                    load(root, std::slice::from_ref(&identity), now)
                }));
            }
            for reader in readers {
                assert_eq!(reader.join().unwrap().unwrap()[0].len(), 0);
            }
        });
        assert_eq!(fs::read_dir(root).unwrap().count(), 0);
    }
}
