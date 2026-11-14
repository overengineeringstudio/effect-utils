//! Private, append-only session history, separate from current-run statistics.
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime};

use chrono::{DateTime, SecondsFormat, Utc};
use nix::errno::Errno;
use nix::fcntl::{Flock, FlockArg, OFlag};
use serde::{Deserialize, Serialize};

use crate::probe::ProbeEvent;
use crate::stats::{Sample, HISTORY_LEN};
use crate::tailnet::{self, Status};
use crate::target::TargetId;

const RETENTION: Duration = Duration::from_hours(168);
static NEXT_FILE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, PartialEq)]
pub struct HistoricalSession {
    pub id: String,
    pub start: SystemTime,
    pub interval: Duration,
    pub samples: Vec<HistoricalSample>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HistoricalSample {
    pub sent: SystemTime,
    pub offset: Duration,
    pub sample: Sample,
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
    file: Flock<File>,
    positions: HashMap<u64, Duration>,
    // One high-water slot per wire sequence, bounded at 65,536 entries.
    recorded: HashMap<u16, u64>,
}
/// Journals are owned by stable target IDs, never by mutable display positions.
pub struct Store {
    writers: HashMap<TargetId, Writer>,
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
            .enumerate()
            .map(|(id, identity)| {
                let (file, _) = create_session(root, identity, now, interval)?;
                Ok((
                    id,
                    Writer {
                        file,
                        positions: HashMap::new(),
                        recorded: HashMap::new(),
                    },
                ))
            })
            .collect::<io::Result<_>>()?;
        Ok((Self { writers, clock }, prior))
    }

    /// Records final outcomes once per schedule slot; metadata is not a sample.
    pub fn record(&mut self, id: TargetId, event: &ProbeEvent) -> io::Result<()> {
        let writer = self
            .writers
            .get_mut(&id)
            .ok_or_else(|| invalid("unknown history target ID"))?;
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
) -> io::Result<(Flock<File>, String)> {
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
            Ok(file) => {
                let mut file = Flock::lock(file, FlockArg::LockExclusive)
                    .map_err(|(_, error)| io::Error::from(error))?;
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
    if bytes.len() > 65_536 {
        return Err(invalid("oversized history record"));
    }
    file.write_all(&bytes)
}

// Shared session IDs avoid allocating a string for every eviction-index entry.
type SessionKey = (SystemTime, Rc<str>);
type SampleKey = (SystemTime, SessionKey, Duration, u64);

#[derive(Default)]
struct RestoreBuffer {
    sessions: BTreeMap<SessionKey, SessionBuffer>,
    oldest: BTreeSet<SampleKey>,
    empty: BTreeSet<SessionKey>,
}

struct SessionBuffer {
    interval: Duration,
    samples: BTreeMap<(Duration, u64), HistoricalSample>,
}

impl RestoreBuffer {
    fn register(&mut self, key: &SessionKey, interval: Duration) {
        if let std::collections::btree_map::Entry::Vacant(entry) = self.sessions.entry(key.clone())
        {
            entry.insert(SessionBuffer {
                interval,
                samples: BTreeMap::new(),
            });
            self.empty.insert(key.clone());
        }
        self.trim();
    }

    fn insert(
        &mut self,
        key: &SessionKey,
        interval: Duration,
        ordinal: u64,
        sample: HistoricalSample,
    ) -> io::Result<()> {
        let coordinate = key
            .0
            .checked_add(sample.offset)
            .ok_or_else(|| invalid("history sample coordinate overflows system time"))?;
        // Metadata may have been trimmed before this journal's later records arrive.
        let session = self
            .sessions
            .entry(key.clone())
            .or_insert_with(|| SessionBuffer {
                interval,
                samples: BTreeMap::new(),
            });
        self.empty.remove(key);
        session.samples.insert((sample.offset, ordinal), sample);
        self.oldest
            .insert((coordinate, key.clone(), sample.offset, ordinal));
        self.trim();
        Ok(())
    }

    fn trim(&mut self) {
        while self.oldest.len() > HISTORY_LEN {
            let (_, key, offset, ordinal) = self.oldest.pop_first().expect("nonempty sample index");
            let session = self.sessions.get_mut(&key).expect("indexed session exists");
            session.samples.remove(&(offset, ordinal));
            if session.samples.is_empty() {
                self.empty.insert(key);
            }
        }
        // Nonempty sessions cannot outnumber the retained samples. Drop only empty
        // metadata, never an old-start session whose late samples are still recent.
        while self.sessions.len() > HISTORY_LEN {
            let key = self
                .empty
                .pop_first()
                .expect("excess session metadata is empty");
            self.sessions.remove(&key);
        }
    }

    fn finish(self, cutoff: SystemTime) -> Vec<HistoricalSession> {
        self.sessions
            .into_iter()
            // A competing pruner can hold the lock after we opened an old journal.
            // Keep fresh empty sessions, but not expired sessions without retained samples.
            .filter(|((start, _), session)| *start >= cutoff || !session.samples.is_empty())
            .map(|((start, id), session)| HistoricalSession {
                id: id.to_string(),
                start,
                interval: session.interval,
                samples: session.samples.into_values().collect(),
            })
            .collect()
    }
}

fn load(
    root: &Path,
    hosts: &[Identity],
    now: SystemTime,
) -> io::Result<Vec<Vec<HistoricalSession>>> {
    let cutoff = now.checked_sub(RETENTION).unwrap_or(SystemTime::UNIX_EPOCH);
    let mut buffers: HashMap<_, _> = hosts
        .iter()
        .map(|host| (host, RestoreBuffer::default()))
        .collect();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        if path
            .extension()
            .is_none_or(|extension| extension != "jsonl")
        {
            continue;
        }
        match entry.file_type() {
            Ok(kind) if kind.is_symlink() => {
                return Err(invalid("history journal must not be a symlink"))
            }
            Ok(kind) if kind.is_file() => {}
            Ok(_) => continue,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        }
        let file = match OpenOptions::new()
            .read(true)
            .custom_flags(OFlag::O_NOFOLLOW.bits())
            .open(&path)
        {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        if prune_expired(&file, &path, cutoff)? {
            continue;
        }
        let mut reader = BufReader::new(file);
        let header = read_header(&mut reader, &path)?;
        let Some(buffer) = buffers.get_mut(&header.host) else {
            continue;
        };
        let key = (
            parse_utc(&header.start_utc)?,
            Rc::<str>::from(header.session_id),
        );
        let interval = Duration::from_nanos(header.interval_ns);
        buffer.register(&key, interval);
        read_samples(&mut reader, &path, |ordinal, sample| {
            if sample.sent >= cutoff {
                buffer.insert(&key, interval, ordinal, sample)?;
            }
            Ok(())
        })?;
    }
    let mut restored: HashMap<_, _> = buffers
        .into_iter()
        .map(|(host, buffer)| (host, buffer.finish(cutoff)))
        .collect();
    let mut result = vec![Vec::new(); hosts.len()];
    for (index, host) in hosts.iter().enumerate().rev() {
        if let Some(sessions) = restored.remove(host) {
            for earlier in 0..index {
                if hosts[earlier] == *host {
                    result[earlier].clone_from(&sessions);
                }
            }
            result[index] = sessions;
        }
    }
    Ok(result)
}

fn prune_expired(file: &File, path: &Path, cutoff: SystemTime) -> io::Result<bool> {
    if file.metadata()?.modified()? >= cutoff {
        return Ok(false);
    }
    let locked = match Flock::lock(file.try_clone()?, FlockArg::LockExclusiveNonblock) {
        Ok(locked) => locked,
        Err((_, Errno::EWOULDBLOCK)) => return Ok(false),
        Err((_, error)) => return Err(error.into()),
    };
    // Recheck after locking: the previous writer may have appended and exited.
    if locked.metadata()?.modified()? >= cutoff {
        return Ok(false);
    }
    match fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error),
    }
}

fn read_record(reader: &mut impl BufRead, line: &mut Vec<u8>, path: &Path) -> io::Result<bool> {
    line.clear();
    // Bound even malformed input; legitimate v1 records are much smaller.
    reader.take(65_537).read_until(b'\n', line)?;
    if line.len() > 65_536 {
        return Err(invalid(format!(
            "{}: oversized history record",
            path.display()
        )));
    }
    Ok(line.ends_with(b"\n"))
}

fn read_header(reader: &mut impl BufRead, path: &Path) -> io::Result<Header> {
    let mut line = Vec::new();
    if !read_record(reader, &mut line, path)? {
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
    Ok(header)
}

fn read_samples(
    reader: &mut impl BufRead,
    path: &Path,
    mut record: impl FnMut(u64, HistoricalSample) -> io::Result<()>,
) -> io::Result<()> {
    let mut line = Vec::new();
    let mut ordinal = 0;
    // Ignore an uncommitted final record left by a crash or concurrent append.
    while read_record(reader, &mut line, path)? {
        let sample: StoredSample = serde_json::from_slice(&line)
            .map_err(|error| invalid(format!("{}: {error}", path.display())))?;
        record(
            ordinal,
            HistoricalSample {
                sent: parse_utc(&sample.utc)?,
                offset: Duration::from_nanos(sample.offset_ns),
                sample: match sample.outcome {
                    Outcome::Reply { rtt_ns } => Sample::Reply(Duration::from_nanos(rtt_ns)),
                    Outcome::Lost => Sample::Lost,
                },
            },
        )?;
        ordinal += 1;
    }
    Ok(())
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

    fn read_session(path: &Path) -> io::Result<(Identity, HistoricalSession)> {
        let mut reader = BufReader::new(File::open(path)?);
        let header = read_header(&mut reader, path)?;
        let mut session = HistoricalSession {
            id: header.session_id,
            start: parse_utc(&header.start_utc)?,
            interval: Duration::from_nanos(header.interval_ns),
            samples: Vec::new(),
        };
        read_samples(&mut reader, path, |_, sample| {
            session.samples.push(sample);
            Ok(())
        })?;
        Ok((header.host, session))
    }

    #[test]
    fn roundtrip_deduplicates_outcomes_and_preserves_loss() {
        let directory = Directory::new();
        let (mut store, prior) = open(&directory.0, now());
        assert_eq!(prior[0].len(), 0);
        for slot in 0..2 {
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
        }
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
                HistoricalSample {
                    offset: Duration::ZERO,
                    sent: now(),
                    sample: Sample::Reply(Duration::from_micros(1234))
                },
                HistoricalSample {
                    offset: Duration::from_secs(1),
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
    fn removing_a_writer_does_not_reassign_remaining_target_ids() {
        let directory = Directory::new();
        let names = vec!["host-a".into(), "host-a.example.test".into()];
        let (mut store, _) =
            Store::open_at(&directory.0, &names, Duration::from_secs(1), now(), None).unwrap();
        drop(store.writers.remove(&0));
        let outcome = ProbeEvent::Lost {
            seq: 1,
            slot: 0,
            sent: now(),
        };
        assert!(store.record(0, &outcome).is_err());
        assert!(store.record(2, &outcome).is_err());
        store.record(1, &outcome).unwrap();
        let (_, prior) =
            Store::open_at(&directory.0, &names, Duration::from_secs(1), now(), None).unwrap();
        assert!(prior[0].iter().all(|session| session.samples.is_empty()));
        assert_eq!(prior[1].len(), 1);
        assert_eq!(prior[1][0].samples.len(), 1);
        assert_eq!(prior[1][0].samples[0].sample, Sample::Lost);
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
        assert_eq!(store.writers[&0].recorded.len(), 2);
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
        let (expired, _) = open(&directory.0, old);
        expired.writers[&0].file.set_modified(old).unwrap();
        drop(expired);
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
        File::open(&path)
            .unwrap()
            .set_modified(parse_utc("2026-11-14T00:00:02Z").unwrap())
            .unwrap();
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
            let (file, _) = create_session(
                root,
                &identity,
                now - RETENTION - Duration::from_secs(1),
                Duration::from_secs(1),
            )
            .unwrap();
            file.set_modified(now - RETENTION - Duration::from_secs(1))
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

    #[test]
    fn backward_wall_clock_steps_preserve_monotonic_offsets() {
        let directory = Directory::new();
        let identity = Identity::resolve(&hosts()[0], None);
        let (mut file, _) =
            create_session(&directory.0, &identity, now(), Duration::from_secs(1)).unwrap();
        for (offset, sent) in [(2, now() - Duration::from_secs(30)), (1, now())] {
            append(
                &mut file,
                &StoredSample {
                    utc: utc(sent),
                    offset_ns: offset * 1_000_000_000,
                    outcome: Outcome::Lost,
                },
            )
            .unwrap();
        }
        let restored = load(&directory.0, &[identity], now()).unwrap();
        assert_eq!(restored[0][0].samples[0].offset, Duration::from_secs(1));
        assert_eq!(restored[0][0].samples[1].offset, Duration::from_secs(2));
        assert!(restored[0][0].samples[0].sent > restored[0][0].samples[1].sent);
    }

    #[test]
    fn expired_mtime_does_not_prune_a_live_writer() {
        let directory = Directory::new();
        let identity = Identity::resolve(&hosts()[0], None);
        let (mut file, _) = create_session(
            &directory.0,
            &identity,
            now() - RETENTION - Duration::from_secs(1),
            Duration::from_secs(1),
        )
        .unwrap();
        // An old, still-locked empty journal is not restored or unlinked.
        file.set_modified(now() - RETENTION - Duration::from_secs(1))
            .unwrap();
        assert_eq!(
            load(&directory.0, std::slice::from_ref(&identity), now()).unwrap()[0].len(),
            0
        );
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
        append(
            &mut file,
            &StoredSample {
                utc: utc(now()),
                offset_ns: 0,
                outcome: Outcome::Lost,
            },
        )
        .unwrap();
        file.set_modified(now() - RETENTION - Duration::from_secs(1))
            .unwrap();
        let restored = load(&directory.0, std::slice::from_ref(&identity), now()).unwrap();
        assert_eq!(restored[0][0].samples.len(), 1);
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
        drop(file);
        assert_eq!(load(&directory.0, &[identity], now()).unwrap()[0].len(), 0);
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 0);
    }

    #[test]
    fn skips_unrequested_records_and_bounds_restoration_across_sessions() {
        let directory = Directory::new();
        let identity = Identity::resolve(&hosts()[0], None);
        let other = Identity::Host("unrequested.example.test".into());
        let (mut unrelated, _) =
            create_session(&directory.0, &other, now(), Duration::from_secs(1)).unwrap();
        unrelated.write_all(b"not valid JSON\n").unwrap();
        let per_session = HISTORY_LEN / 2 + 2;
        for seconds in [2, 1] {
            let (mut file, _) = create_session(
                &directory.0,
                &identity,
                now() - Duration::from_secs(seconds),
                Duration::from_secs(1),
            )
            .unwrap();
            for ordinal in 0..u64::try_from(per_session).unwrap() {
                append(
                    &mut file,
                    &StoredSample {
                        utc: utc(now()),
                        offset_ns: ordinal * 1_000_000_000,
                        outcome: Outcome::Lost,
                    },
                )
                .unwrap();
            }
            file.set_modified(now()).unwrap();
        }
        let restored = load(&directory.0, &[identity], now()).unwrap();
        assert_eq!(
            restored[0]
                .iter()
                .map(|session| session.samples.len())
                .sum::<usize>(),
            HISTORY_LEN
        );
        assert_eq!(restored[0].len(), 2);
        assert_eq!(restored[0][0].samples[0].offset, Duration::from_secs(3));
        assert_eq!(restored[0][1].samples[0].offset, Duration::from_secs(1));
        assert_eq!(restored[0][1].samples.len(), per_session - 1);
    }

    #[test]
    fn rejects_symlinked_state_roots_and_journals() {
        let directory = Directory::new();
        let real = directory.0.join("real");
        fs::create_dir(&real).unwrap();
        let linked = directory.0.join("linked");
        std::os::unix::fs::symlink(&real, &linked).unwrap();
        assert!(Store::open_at(&linked, &hosts(), Duration::from_secs(1), now(), None).is_err());
        let target = directory.0.join("outside");
        fs::write(&target, b"private unrelated content").unwrap();
        std::os::unix::fs::symlink(&target, real.join("linked.jsonl")).unwrap();
        assert!(load(&real, &[Identity::resolve(&hosts()[0], None)], now()).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"private unrelated content");
    }
}

#[cfg(test)]
mod restore_regressions {
    use super::*;

    #[test]
    fn restore_buffer_never_exceeds_the_host_sample_limit() {
        let mut buffer = RestoreBuffer::default();
        let key = (SystemTime::UNIX_EPOCH, Rc::<str>::from("session"));
        buffer.register(&key, Duration::from_secs(1));
        for ordinal in (0..u64::try_from(HISTORY_LEN + 10).unwrap()).rev() {
            let offset = Duration::from_secs(ordinal);
            let sample = HistoricalSample {
                offset,
                sent: SystemTime::UNIX_EPOCH,
                sample: Sample::Lost,
            };
            buffer
                .insert(&key, Duration::from_secs(1), ordinal, sample)
                .unwrap();
            assert!(buffer.oldest.len() <= HISTORY_LEN);
        }
        let sessions = buffer.finish(SystemTime::UNIX_EPOCH);
        assert_eq!(sessions[0].samples.len(), HISTORY_LEN);
        assert_eq!(sessions[0].samples[0].offset, Duration::from_secs(10));
    }

    #[test]
    fn overlapping_sessions_keep_the_globally_newest_long_run_tail() {
        let interval = Duration::from_secs(1);
        let per_session = HISTORY_LEN / 2 + 2;
        let old = (SystemTime::UNIX_EPOCH, Rc::<str>::from("long-running"));
        let later = (
            SystemTime::UNIX_EPOCH + Duration::from_secs(500),
            Rc::<str>::from("finished"),
        );
        // Exercise both file traversal orders. The earlier-start session's tail is
        // newer than every sample from the later-start, already finished session.
        for order in [
            [(&old, 100_000), (&later, 0)],
            [(&later, 0), (&old, 100_000)],
        ] {
            let mut buffer = RestoreBuffer::default();
            for (key, base) in order {
                buffer.register(key, interval);
                for ordinal in 0..u64::try_from(per_session).unwrap() {
                    buffer
                        .insert(
                            key,
                            interval,
                            ordinal,
                            HistoricalSample {
                                sent: SystemTime::UNIX_EPOCH,
                                offset: Duration::from_secs(base + ordinal),
                                sample: Sample::Lost,
                            },
                        )
                        .unwrap();
                    assert!(buffer.oldest.len() <= HISTORY_LEN);
                }
            }
            let sessions = buffer.finish(SystemTime::UNIX_EPOCH);
            assert_eq!(sessions[0].samples.len(), per_session);
            assert_eq!(
                sessions[0].samples.last().unwrap().offset,
                Duration::from_secs(100_000 + u64::try_from(per_session - 1).unwrap())
            );
            assert_eq!(sessions[1].samples[0].offset, Duration::from_secs(4));
            assert_eq!(sessions[1].samples.len(), per_session - 4);
        }
    }

    #[test]
    fn metadata_pressure_preserves_nonempty_sessions_and_recreates_trimmed_headers() {
        let interval = Duration::from_secs(1);
        let mut buffer = RestoreBuffer::default();
        let old = (SystemTime::UNIX_EPOCH, Rc::<str>::from("old-live"));
        buffer
            .insert(
                &old,
                interval,
                0,
                HistoricalSample {
                    sent: SystemTime::UNIX_EPOCH,
                    offset: Duration::from_secs(100_000),
                    sample: Sample::Lost,
                },
            )
            .unwrap();
        for ordinal in 1..=u64::try_from(HISTORY_LEN).unwrap() {
            let key = (
                SystemTime::UNIX_EPOCH + Duration::from_secs(ordinal),
                Rc::<str>::from("empty"),
            );
            buffer.register(&key, interval);
            assert!(buffer.sessions.len() <= HISTORY_LEN);
        }
        assert_eq!(buffer.sessions.get(&old).unwrap().samples.len(), 1);
        let trimmed = (
            SystemTime::UNIX_EPOCH + Duration::from_secs(1),
            Rc::<str>::from("empty"),
        );
        assert!(!buffer.sessions.contains_key(&trimmed));
        buffer
            .insert(
                &trimmed,
                interval,
                0,
                HistoricalSample {
                    sent: SystemTime::UNIX_EPOCH,
                    offset: Duration::from_secs(200_000),
                    sample: Sample::Lost,
                },
            )
            .unwrap();
        assert!(buffer.sessions.contains_key(&trimmed));
        assert!(buffer.sessions.contains_key(&old));
        assert!(buffer.sessions.len() <= HISTORY_LEN);
    }
}
