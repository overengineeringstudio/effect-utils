//! Kernel process generation and all four Linux UID fields. No policy filtering.
use std::io;
use super::objects;

#[derive(Debug, PartialEq, Eq)]
pub struct Process {
    pub pid: u32,
    pub parent: u32,
    pub start: u64,
    pub state: u8,
}

impl Process {
    pub fn same_identity(&self, other: &Self) -> bool {
        self.pid == other.pid && self.parent == other.parent && self.start == other.start
    }
}

pub fn process(pid: u32) -> io::Result<Process> {
    let value = objects::bounded_text(format!("/proc/{pid}/stat"), 64 * 1024)?;
    parse_process(pid, &value)
}

pub fn parse_process(pid: u32, value: &str) -> io::Result<Process> {
    let (prefix, tail) = value.rsplit_once(')').ok_or_else(|| io::Error::other("malformed process stat"))?;
    let recorded_pid = prefix.split_once(" (").ok_or_else(|| io::Error::other("malformed process identity"))?.0;
    if recorded_pid.parse::<u32>().ok() != Some(pid) {
        return Err(io::Error::other("process identity mismatch"));
    }
    let mut fields = tail.split_whitespace();
    let state = fields.next().filter(|state| state.len() == 1)
        .ok_or_else(|| io::Error::other("invalid process state"))?.as_bytes()[0];
    let parent = fields.next().ok_or_else(|| io::Error::other("missing process parent"))?
        .parse().map_err(|_| io::Error::other("invalid process parent"))?;
    let start = fields.nth(17).ok_or_else(|| io::Error::other("missing process start"))?
        .parse().map_err(|_| io::Error::other("invalid process start"))?;
    Ok(Process { pid, parent, start, state })
}
pub fn uids(pid: u32) -> io::Result<[u32; 4]> {
    let status = objects::bounded_text(format!("/proc/{pid}/status"), 64 * 1024)?;
    parse_uids(&status)
}

pub fn parse_uids(status: &str) -> io::Result<[u32; 4]> {
    let mut fields = status.lines().filter_map(|line| line.strip_prefix("Uid:"));
    let mut numbers = fields.next().ok_or_else(|| io::Error::other("missing process UID"))?
        .split_whitespace();
    let mut values = [0; 4];
    for value in &mut values {
        *value = numbers.next().ok_or_else(|| io::Error::other("missing process UID field"))?
            .parse().map_err(|_| io::Error::other("invalid process UID"))?;
    }
    if fields.next().is_some() || numbers.next().is_some() {
        return Err(io::Error::other("ambiguous process UID"));
    }
    Ok(values)
}
