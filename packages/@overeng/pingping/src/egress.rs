//! Optional IPv4 egress identity; no recurring work or public-address storage.
use std::io::{Read, Write};
use std::net::{Ipv4Addr, UdpSocket};
use std::os::unix::net::UnixStream;
use std::sync::{mpsc::Sender, Arc};
use std::time::{Duration, Instant};

use crate::probe::ProbeEvent;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Info {
    pub asn: u32,
    pub organization: String,
    pub exit_node: bool,
}

impl Info {
    pub fn label(&self) -> String {
        format!(
            "{}{}",
            self.organization,
            if self.exit_node { " (exit node)" } else { "" }
        )
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct State {
    generation: u64,
    pub info: Option<Info>,
}

impl State {
    pub fn update(&mut self, generation: u64, info: Option<Info>) {
        if generation >= self.generation {
            self.generation = generation;
            self.info = info;
        }
    }
}

pub fn spawn(generation: u64, events: Sender<(usize, ProbeEvent)>, wake: Option<Arc<UnixStream>>) {
    std::thread::spawn(move || {
        let info = lookup();
        let _ = events.send((0, ProbeEvent::Egress { generation, info }));
        if let Some(mut wake) = wake.as_deref() {
            let _ = wake.write_all(&[1]);
        }
    });
}

fn lookup() -> Option<Info> {
    let deadline = Instant::now() + Duration::from_secs(1);
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((Ipv4Addr::new(1, 1, 1, 1), 53)).ok()?;
    let ip: Ipv4Addr = query(&socket, "whoami.cloudflare", 3, deadline)?
        .trim()
        .parse()
        .ok()?;
    let [a, b, c, d] = ip.octets();
    let origin = query(
        &socket,
        &format!("{d}.{c}.{b}.{a}.origin.asn.cymru.com"),
        1,
        deadline,
    )?;
    let asn: u32 = origin.split('|').next()?.trim().parse().ok()?;
    if asn == 0 {
        return None;
    }
    let name = query(&socket, &format!("AS{asn}.asn.cymru.com"), 1, deadline)?;
    let mut fields = name.splitn(5, '|');
    if fields.next()?.trim().parse::<u32>().ok()? != asn {
        return None;
    }
    let organization = organization(fields.nth(3)?);
    if organization.is_empty() {
        return None;
    }
    Some(Info {
        asn,
        organization,
        exit_node: crate::tailnet::status().is_some_and(|status| status.exit_node.is_some()),
    })
}

fn organization(raw: &str) -> String {
    let raw = raw.trim();
    let short = raw
        .split_once(" - ")
        .and_then(|(prefix, rest)| {
            let (name, country) = rest.rsplit_once(", ")?;
            (!prefix.is_empty()
                && country.len() == 2
                && country.bytes().all(|b| b.is_ascii_uppercase()))
            .then_some(name)
        })
        .unwrap_or(raw);
    short
        .chars()
        .filter(|ch| !ch.is_control())
        .take(96)
        .collect::<String>()
        .trim()
        .to_owned()
}

fn packet(id: u16, name: &str, class: u16) -> Option<Vec<u8>> {
    let mut bytes = Vec::with_capacity(12 + name.len() + 6);
    for word in [id, 0x0100, 1, 0, 0, 0] {
        bytes.extend_from_slice(&u16::to_be_bytes(word));
    }
    for label in name.split('.') {
        let length = u8::try_from(label.len())
            .ok()
            .filter(|length| (1..=63).contains(length))?;
        bytes.push(length);
        bytes.extend_from_slice(label.as_bytes());
    }
    bytes.push(0);
    bytes.extend_from_slice(&16_u16.to_be_bytes());
    bytes.extend_from_slice(&class.to_be_bytes());
    (bytes.len() <= 512).then_some(bytes)
}

fn query(socket: &UdpSocket, name: &str, class: u16, deadline: Instant) -> Option<String> {
    let mut random = [0; 2];
    std::fs::File::open("/dev/urandom")
        .ok()?
        .read_exact(&mut random)
        .ok()?;
    let id = u16::from_ne_bytes(random);
    let request = packet(id, name, class)?;
    let remaining = deadline.checked_duration_since(Instant::now())?;
    socket.set_write_timeout(Some(remaining)).ok()?;
    socket.send(&request).ok()?;
    let mut response = [0; 4097];
    loop {
        socket
            .set_read_timeout(Some(deadline.checked_duration_since(Instant::now())?))
            .ok()?;
        let length = socket.recv(&mut response).ok()?;
        if length > 4096 {
            return None;
        }
        if response.get(..2)? != id.to_be_bytes() {
            continue;
        }
        return parse(&response[..length], id, name, class);
    }
}

fn word(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_be_bytes(
        bytes.get(offset..offset.checked_add(2)?)?.try_into().ok()?,
    ))
}

fn read_name(bytes: &[u8], offset: &mut usize) -> Option<String> {
    let mut at = *offset;
    let mut end = None;
    let mut name = String::new();
    for _ in 0..128 {
        let length = *bytes.get(at)?;
        at += 1;
        if length & 0xc0 == 0xc0 {
            let next = usize::from(length & 0x3f) * 256 + usize::from(*bytes.get(at)?);
            end.get_or_insert(at + 1);
            at = next;
        } else if length == 0 {
            *offset = end.unwrap_or(at);
            return Some(name);
        } else {
            if length > 63 {
                return None;
            }
            let label = std::str::from_utf8(bytes.get(at..at + usize::from(length))?).ok()?;
            if !name.is_empty() {
                name.push('.');
            }
            name.push_str(label);
            if name.len() > 253 {
                return None;
            }
            at += usize::from(length);
        }
    }
    None
}

fn parse(bytes: &[u8], id: u16, name: &str, class: u16) -> Option<String> {
    let flags = word(bytes, 2)?;
    if word(bytes, 0)? != id || flags & 0xfa0f != 0x8000 || word(bytes, 4)? != 1 {
        return None;
    }
    let answers = word(bytes, 6)?;
    if answers > 64 {
        return None;
    }
    let mut offset = 12;
    if !read_name(bytes, &mut offset)?.eq_ignore_ascii_case(name)
        || word(bytes, offset)? != 16
        || word(bytes, offset + 2)? != class
    {
        return None;
    }
    offset += 4;
    for _ in 0..answers {
        let owner = read_name(bytes, &mut offset)?;
        let typ = word(bytes, offset)?;
        let record_class = word(bytes, offset + 2)?;
        let length = usize::from(word(bytes, offset + 8)?);
        offset += 10;
        let data = bytes.get(offset..offset.checked_add(length)?)?;
        offset += length;
        if typ != 16 || record_class != class || !owner.eq_ignore_ascii_case(name) {
            continue;
        }
        let mut text = Vec::new();
        let mut cursor = 0;
        while cursor < data.len() {
            let length = usize::from(data[cursor]);
            cursor += 1;
            text.extend_from_slice(data.get(cursor..cursor + length)?);
            cursor += length;
            if text.len() > 1024 {
                return None;
            }
        }
        return String::from_utf8(text).ok();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response() -> Vec<u8> {
        let mut bytes = packet(42, "whoami.cloudflare", 3).unwrap();
        bytes[2..4].copy_from_slice(&0x8180_u16.to_be_bytes());
        bytes[6..8].copy_from_slice(&1_u16.to_be_bytes());
        bytes.extend_from_slice(&[
            0xc0, 12, 0, 16, 0, 3, 0, 0, 0, 0, 0, 9, 3, b'o', b'n', b'e', 4, b' ', b't', b'w', b'o',
        ]);
        bytes
    }

    #[test]
    fn dns_txt_chaos_and_response_validation() {
        let bytes = response();
        assert_eq!(
            parse(&bytes, 42, "whoami.cloudflare", 3).as_deref(),
            Some("one two")
        );
        assert!(parse(&bytes, 41, "whoami.cloudflare", 3).is_none());
        assert!(parse(&bytes, 42, "other.cloudflare", 3).is_none());
        assert!(parse(&bytes, 42, "whoami.cloudflare", 1).is_none());
        for length in 0..bytes.len() {
            assert!(parse(&bytes[..length], 42, "whoami.cloudflare", 3).is_none());
        }
        for flags in [0x8380_u16, 0x8183] {
            let mut invalid = bytes.clone();
            invalid[2..4].copy_from_slice(&flags.to_be_bytes());
            assert!(parse(&invalid, 42, "whoami.cloudflare", 3).is_none());
        }
        let mut cyclic = bytes;
        let offset = packet(42, "whoami.cloudflare", 3).unwrap().len();
        cyclic[offset + 1] = u8::try_from(offset).unwrap();
        assert!(parse(&cyclic, 42, "whoami.cloudflare", 3).is_none());
    }

    #[test]
    fn organization_is_shortened_sanitized_and_bounded() {
        assert_eq!(
            organization("EXAMPLE - Example Network, ZZ"),
            "Example Network"
        );
        assert_eq!(organization("Other network"), "Other network");
        assert_eq!(organization("\x1bnetwork\n\t"), "network");
        assert_eq!(organization(&"a".repeat(200)).chars().count(), 96);
    }

    #[test]
    fn network_change_invalidates_and_rejects_stale_results() {
        let info = Info {
            asn: 64500,
            organization: "Example Network".into(),
            exit_node: false,
        };
        let mut state = State::default();
        state.update(0, Some(info.clone()));
        state.update(1, None);
        assert!(state.info.is_none());
        state.update(0, Some(info));
        assert!(state.info.is_none());
        state.update(1, None);
        assert!(state.info.is_none());
    }
}
