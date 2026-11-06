//! Schema-1 creation facts and last-holder evidence; these records never replace flock authority.
use crate::{Identity, Lease, Refusal, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{self, Read},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    time::{Duration, SystemTime},
};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Holder {
    pub agent: String,
    pub pid: u32,
    pub start_time: String,
    pub host: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    pub schema: u8,
    pub creator_seat: String,
    pub purpose: String,
    pub created_at: String,
    pub holder: Holder,
    pub expires_at: String,
}
pub fn timestamp(value: &str) -> Result<DateTime<Utc>> {
    if !value.ends_with('Z') {
        return Err(Refusal::InvalidInput);
    }
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.to_utc())
        .map_err(|_| Refusal::InvalidInput)
}
fn expiry(ttl: u64) -> Result<String> {
    if ttl == 0 {
        return Err(Refusal::InvalidInput);
    }
    let expires = SystemTime::now()
        .checked_add(Duration::from_secs(ttl))
        .ok_or(Refusal::InvalidInput)?;
    let seconds = expires
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|_| Refusal::InvalidInput)?;
    let seconds = i64::try_from(seconds.as_secs()).map_err(|_| Refusal::InvalidInput)?;
    DateTime::<Utc>::from_timestamp(seconds, 0)
        .map(|value| value.to_rfc3339_opts(SecondsFormat::Secs, true))
        .ok_or(Refusal::InvalidInput)
}
impl Record {
    pub fn validate(&self) -> Result<()> {
        let agent = |value: &str| value.starts_with("agent/") && value.len() > 6;
        if self.schema != 1
            || !agent(&self.creator_seat)
            || !agent(&self.holder.agent)
            || !matches!(self.purpose.as_str(), "gate" | "lander" | "ci-baseline")
            || self.holder.pid == 0
            || self.holder.pid > i32::MAX as u32
            || self.holder.start_time.trim().is_empty()
            || self.holder.host.trim().is_empty()
            || timestamp(&self.created_at)? >= timestamp(&self.expires_at)?
        {
            return Err(Refusal::InvalidInput);
        }
        Ok(())
    }
    pub fn inspect(identity: &Identity) -> Result<Option<Self>> {
        identity.validate()?;
        let path = identity.admin.join("gate-lease.json");
        let file = match OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
            .open(&path)
        {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(Refusal::UnsafeLock),
        };
        let fd = file.metadata().map_err(|_| Refusal::UnsafeLock)?;
        if !fd.is_file() {
            return Err(Refusal::UnsafeLock);
        }
        let mut bytes = Vec::new();
        file.take(65_537)
            .read_to_end(&mut bytes)
            .map_err(|_| Refusal::UnsafeLock)?;
        let named = fs::symlink_metadata(path).map_err(|_| Refusal::UnsafeLock)?;
        if bytes.len() > 65_536
            || !named.is_file()
            || (fd.dev(), fd.ino()) != (named.dev(), named.ino())
        {
            return Err(Refusal::UnsafeLock);
        }
        let record: Self = serde_json::from_slice(&bytes).map_err(|_| Refusal::UnsafeLock)?;
        record.validate().map_err(|_| Refusal::UnsafeLock)?;
        identity.validate()?;
        Ok(Some(record))
    }
    pub fn create(
        identity: &Identity,
        creator: String,
        purpose: String,
        holder: Holder,
        ttl: u64,
    ) -> Result<Self> {
        let scope = Lease::open(identity.clone())?;
        scope.acquire(false, false)?;
        let record = Self {
            schema: 1,
            creator_seat: creator,
            purpose,
            created_at: DateTime::<Utc>::from(SystemTime::now())
                .to_rfc3339_opts(SecondsFormat::Secs, true),
            holder,
            expires_at: expiry(ttl)?,
        };
        record.publish(identity, false)?;
        Ok(record)
    }
    fn publish(&self, identity: &Identity, replace: bool) -> Result<()> {
        self.validate()?;
        identity.validate()?;
        let mut temporary =
            tempfile::NamedTempFile::new_in(&identity.admin).map_err(|_| Refusal::InvalidInput)?;
        serde_json::to_writer(&mut temporary, self).map_err(|_| Refusal::InvalidInput)?;
        if temporary
            .as_file()
            .metadata()
            .map_err(|_| Refusal::InvalidInput)?
            .len()
            > 65_536
        {
            return Err(Refusal::InvalidInput);
        }
        temporary
            .as_file()
            .sync_all()
            .map_err(|_| Refusal::InvalidInput)?;
        identity.validate()?;
        let destination = identity.admin.join("gate-lease.json");
        if replace {
            temporary
                .persist(destination)
                .map_err(|_| Refusal::InvalidInput)?;
        } else {
            fs::hard_link(temporary.path(), destination).map_err(|_| Refusal::InvalidInput)?;
        }
        sync_directory(&identity.admin)
    }
}
impl Lease {
    pub fn renew(&self, holder: Holder, ttl: u64) -> Result<Record> {
        if self.held.get().is_none() {
            return Err(Refusal::UnsafeLock);
        }
        self.validate()?;
        let mut record = Record::inspect(&self.identity)?.ok_or(Refusal::InvalidInput)?;
        record.holder = holder;
        record.expires_at = expiry(ttl)?;
        record.publish(&self.identity, true)?;
        self.validate()?;
        Ok(record)
    }
}
fn sync_directory(path: &std::path::Path) -> Result<()> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| Refusal::InvalidInput)
}
#[test]
fn directory_sync_errors_propagate() {
    let root = tempfile::tempdir().unwrap();
    assert_eq!(
        sync_directory(&root.path().join("missing")),
        Err(Refusal::InvalidInput)
    );
}
