//! Reclamation requires both exclusive kernel authority and positively dead, expired evidence.
use crate::{
    record::{timestamp, Holder, PidNamespace, Record},
    Identity, Lease, Refusal, Result,
};
use std::{fs, io, time::SystemTime};

#[derive(Debug, PartialEq, Eq)]
pub enum ProcessState {
    Alive(String),
    Dead,
    Unknown,
}
pub fn pid_namespace() -> Option<PidNamespace> {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = fs::metadata("/proc/self/ns/pid").ok()?;
        Some(PidNamespace {
            dev: metadata.dev(),
            ino: metadata.ino(),
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}
fn same_namespace(holder: &Holder, namespace: Option<PidNamespace>) -> bool {
    !cfg!(target_os = "linux") || (namespace.is_some() && holder.pid_namespace == namespace)
}
pub fn hostname() -> Result<String> {
    let mut bytes = [0u8; 256];
    // SAFETY: writable buffer of the declared length; require an actual terminator.
    if unsafe { libc::gethostname(bytes.as_mut_ptr().cast(), bytes.len()) } != 0 {
        return Err(Refusal::UnsafeLock);
    }
    let end = bytes
        .iter()
        .position(|byte| *byte == 0)
        .ok_or(Refusal::UnsafeLock)?;
    let host = std::str::from_utf8(&bytes[..end]).map_err(|_| Refusal::UnsafeLock)?;
    if host.is_empty() {
        return Err(Refusal::UnsafeLock);
    }
    Ok(host.into())
}
#[cfg(target_os = "linux")]
pub fn process(pid: u32) -> ProcessState {
    let text = match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(text) => text,
        Err(error)
            if error.kind() == io::ErrorKind::NotFound
                && fs::read_to_string("/proc/self/stat").is_ok() =>
        {
            return ProcessState::Dead
        }
        Err(_) => return ProcessState::Unknown,
    };
    let Some((_, fields)) = text.rsplit_once(") ") else {
        return ProcessState::Unknown;
    };
    let mut fields = fields.split_whitespace();
    match fields.next() {
        Some("Z" | "X") => ProcessState::Dead,
        Some(_) => match fields.nth(18).filter(|start| valid_start(start)) {
            Some(start) => ProcessState::Alive(start.into()),
            None => ProcessState::Unknown,
        },
        None => ProcessState::Unknown,
    }
}
#[cfg(not(target_os = "linux"))]
pub fn process(pid: u32) -> ProcessState {
    use std::{
        process::{Command, Stdio},
        thread,
        time::{Duration, Instant},
    };
    let Ok(mut child) = Command::new("ps")
        .env("LC_ALL", "C")
        .args(["-p", &pid.to_string(), "-o", "lstart=", "-o", "stat="])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    else {
        return ProcessState::Unknown;
    };
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return ProcessState::Unknown;
            }
        }
    }
    let Ok(output) = child.wait_with_output() else {
        return ProcessState::Unknown;
    };
    if output.status.code() == Some(1) && output.stdout.is_empty() && output.stderr.is_empty() {
        return ProcessState::Dead;
    }
    let Ok(text) = std::str::from_utf8(&output.stdout) else {
        return ProcessState::Unknown;
    };
    let Some((start, state)) = text.trim().rsplit_once(' ') else {
        return ProcessState::Unknown;
    };
    if !output.status.success() || !valid_start(start) {
        ProcessState::Unknown
    } else if state.starts_with('Z') {
        ProcessState::Dead
    } else {
        ProcessState::Alive(start.into())
    }
}
fn valid_start(start: &str) -> bool {
    #[cfg(target_os = "linux")]
    {
        !start.starts_with('0')
            && start.bytes().all(|byte| byte.is_ascii_digit())
            && start.parse::<u64>().is_ok()
    }
    #[cfg(not(target_os = "linux"))]
    {
        chrono::NaiveDateTime::parse_from_str(start, "%a %b %e %T %Y").is_ok()
    }
}
impl Holder {
    pub fn capture(agent: String, pid: u32) -> Result<Self> {
        if !agent.starts_with("agent/") || agent.len() <= 6 || pid == 0 || pid > i32::MAX as u32 {
            return Err(Refusal::InvalidInput);
        }
        let ProcessState::Alive(start_time) = process(pid) else {
            return Err(Refusal::UnsafeLock);
        };
        let pid_namespace = pid_namespace();
        if cfg!(target_os = "linux") && pid_namespace.is_none() {
            return Err(Refusal::UnsafeLock);
        }
        Ok(Self {
            agent,
            pid,
            start_time,
            host: hostname()?,
            pid_namespace,
        })
    }
}
/// Eligibility alone never authorizes mutation; retain the returned guard Lease through mutation.
pub fn eligible(
    record: &Record,
    host: &str,
    now: SystemTime,
    state: &ProcessState,
    namespace: Option<PidNamespace>,
) -> bool {
    record.validate().is_ok()
        && record.holder.host == host
        && same_namespace(&record.holder, namespace)
        && valid_start(&record.holder.start_time)
        && timestamp(&record.expires_at)
            .is_ok_and(|expiry| expiry <= chrono::DateTime::<chrono::Utc>::from(now))
        && match state {
            ProcessState::Dead => true,
            ProcessState::Alive(start) => valid_start(start) && start != &record.holder.start_time,
            ProcessState::Unknown => false,
        }
}
/// Either worktree/reclaim-keep or admin/reclaim-keep (including unreadable state) retains.
pub fn reclaim(identity: Identity) -> Result<Lease> {
    let lease = Lease::open(identity)?;
    lease.acquire(true, false).map_err(|error| {
        if error == Refusal::Busy {
            Refusal::Protected
        } else {
            error
        }
    })?;
    for root in [&lease.identity.worktree, &lease.identity.admin] {
        match fs::symlink_metadata(root.join("reclaim-keep")) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            _ => return Err(Refusal::Protected),
        }
    }
    if let Some(record) = Record::inspect(&lease.identity)? {
        let host = hostname()?;
        let namespace = pid_namespace();
        let state = if record.holder.host == host && same_namespace(&record.holder, namespace) {
            process(record.holder.pid)
        } else {
            ProcessState::Unknown
        };
        if !eligible(&record, &host, SystemTime::now(), &state, namespace) {
            return Err(Refusal::Protected);
        }
    }
    lease.validate()?;
    Ok(lease)
}
