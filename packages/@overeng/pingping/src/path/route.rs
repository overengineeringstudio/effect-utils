//! Safe kernel route queries; no subprocess or raw memory casts.
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::os::fd::AsRawFd;

use nix::sys::socket::{
    recv, setsockopt, socket, sockopt, AddressFamily, MsgFlags, SockFlag, SockType,
};
use nix::sys::time::TimeVal;

use super::Note;

/// `None` when the interface name could inject terminal control sequences
/// (Linux interface names may contain any byte except `/`, `:` and whitespace).
pub(super) fn format(
    ifname: &str,
    gateway: Option<IpAddr>,
    source: Option<IpAddr>,
) -> Option<Note> {
    if ifname.is_empty() || ifname.chars().any(char::is_control) {
        return None;
    }
    Some(Note {
        text: gateway.map_or_else(
            || format!("on-link {ifname}"),
            |gateway| format!("via {ifname} → {gateway}"),
        ),
        endpoint: None,
        interface: Some(ifname.to_owned()),
        source,
    })
}

fn ip(bytes: &[u8], v6: bool) -> Option<IpAddr> {
    if v6 {
        Some(Ipv6Addr::from(<[u8; 16]>::try_from(bytes).ok()?).into())
    } else {
        Some(Ipv4Addr::from(<[u8; 4]>::try_from(bytes).ok()?).into())
    }
}

#[cfg(target_os = "linux")]
pub(super) fn lookup(address: IpAddr) -> Option<Note> {
    use nix::sys::socket::{bind, sendto, NetlinkAddr, SockProtocol};
    let socket = socket(
        AddressFamily::Netlink,
        SockType::Datagram,
        SockFlag::SOCK_CLOEXEC,
        SockProtocol::NetlinkRoute,
    )
    .ok()?;
    setsockopt(&socket, sockopt::ReceiveTimeout, &TimeVal::new(0, 100_000)).ok()?;
    bind(socket.as_raw_fd(), &NetlinkAddr::new(0, 0)).ok()?;
    let v6 = address.is_ipv6();
    let length = if v6 { 48_u32 } else { 36_u32 };
    let mut request = [0; 48];
    request[..4].copy_from_slice(&length.to_ne_bytes());
    request[4..6].copy_from_slice(&26_u16.to_ne_bytes()); // RTM_GETROUTE
    request[6..8].copy_from_slice(&1_u16.to_ne_bytes()); // NLM_F_REQUEST
    request[8..12].copy_from_slice(&1_u32.to_ne_bytes()); // sequence
    request[16] = if v6 { 10 } else { 2 };
    request[17] = if v6 { 128 } else { 32 };
    request[28..30].copy_from_slice(&(if v6 { 20_u16 } else { 8_u16 }).to_ne_bytes());
    request[30..32].copy_from_slice(&1_u16.to_ne_bytes()); // RTA_DST
    match address {
        IpAddr::V4(ip) => request[32..36].copy_from_slice(&ip.octets()),
        IpAddr::V6(ip) => request[32..48].copy_from_slice(&ip.octets()),
    }
    sendto(
        socket.as_raw_fd(),
        &request[..usize::try_from(length).ok()?],
        &NetlinkAddr::new(0, 0),
        MsgFlags::empty(),
    )
    .ok()?;
    let mut response = [0; 8192];
    let count = recv(socket.as_raw_fd(), &mut response, MsgFlags::empty()).ok()?;
    parse_linux(&response[..count], v6)
}

#[cfg(target_os = "linux")]
fn parse_linux(response: &[u8], v6: bool) -> Option<Note> {
    let length = usize::try_from(u32::from_ne_bytes(response.get(..4)?.try_into().ok()?)).ok()?;
    let response = response.get(..length)?;
    if u16::from_ne_bytes(response.get(4..6)?.try_into().ok()?) != 24
        || u32::from_ne_bytes(response.get(8..12)?.try_into().ok()?) != 1
    {
        return None;
    }
    let mut attributes = response.get(28..)?;
    let (mut interface, mut gateway, mut source) = (None, None, None);
    while attributes.len() >= 4 {
        let length = usize::from(u16::from_ne_bytes(attributes[..2].try_into().ok()?));
        let kind = u16::from_ne_bytes(attributes[2..4].try_into().ok()?);
        let value = attributes.get(4..length)?;
        match kind {
            4 => interface = Some(u32::from_ne_bytes(value.try_into().ok()?)),
            5 => gateway = Some(ip(value, v6)?),
            7 => source = Some(ip(value, v6)?),
            _ => {}
        }
        attributes = attributes.get((length + 3) & !3..)?;
    }
    let name = nix::net::if_::if_indextoname(interface?).ok()?;
    format(name.to_str().ok()?, gateway, source)
}

#[cfg(target_os = "macos")]
pub(super) fn lookup(address: IpAddr) -> Option<Note> {
    use nix::libc::rt_msghdr;
    use nix::sys::socket::send;
    use std::mem::{offset_of, size_of};
    let socket = socket(AddressFamily::Route, SockType::Raw, SockFlag::empty(), None).ok()?;
    setsockopt(&socket, sockopt::ReceiveTimeout, &TimeVal::new(0, 100_000)).ok()?;
    let header = size_of::<rt_msghdr>();
    let mut storage = [0; size_of::<rt_msghdr>() + 28];
    let request = &mut storage[..header + if address.is_ipv6() { 28 } else { 16 }];
    let length = u16::try_from(request.len()).ok()?;
    request[..2].copy_from_slice(&length.to_ne_bytes());
    request[offset_of!(rt_msghdr, rtm_version)] = 5; // RTM_VERSION
    request[offset_of!(rt_msghdr, rtm_type)] = 4; // RTM_GET
    let addrs = offset_of!(rt_msghdr, rtm_addrs);
    request[addrs..addrs + 4].copy_from_slice(&1_i32.to_ne_bytes()); // RTA_DST
    let seq = offset_of!(rt_msghdr, rtm_seq);
    request[seq..seq + 4].copy_from_slice(&1_i32.to_ne_bytes());
    let pid = offset_of!(rt_msghdr, rtm_pid);
    let own_pid = i32::try_from(std::process::id()).ok()?.to_ne_bytes();
    request[pid..pid + 4].copy_from_slice(&own_pid);
    match address {
        IpAddr::V4(ip) => {
            request[header] = 16;
            request[header + 1] = 2;
            request[header + 4..header + 8].copy_from_slice(&ip.octets());
        }
        IpAddr::V6(ip) => {
            request[header] = 28;
            request[header + 1] = 30;
            request[header + 8..header + 24].copy_from_slice(&ip.octets());
        }
    }
    send(socket.as_raw_fd(), request, MsgFlags::empty()).ok()?;
    let start = std::time::Instant::now();
    let mut response = [0; 8192];
    while start.elapsed() < std::time::Duration::from_millis(100) {
        let remaining = std::time::Duration::from_millis(100).checked_sub(start.elapsed())?;
        setsockopt(
            &socket,
            sockopt::ReceiveTimeout,
            &TimeVal::new(0, remaining.as_micros().try_into().ok()?),
        )
        .ok()?;
        let count = recv(socket.as_raw_fd(), &mut response, MsgFlags::empty()).ok()?;
        let response = response.get(..count)?;
        if response.len() < header
            || response[3] != 4
            || response[seq..seq + 4] != 1_i32.to_ne_bytes()
            || response[pid..pid + 4] != own_pid
        {
            continue;
        }
        let errno = offset_of!(rt_msghdr, rtm_errno);
        if response[errno..errno + 4] != 0_i32.to_ne_bytes() {
            return None;
        }
        let index = offset_of!(rt_msghdr, rtm_index);
        let interface = u16::from_ne_bytes(response[index..index + 2].try_into().ok()?);
        let name = nix::net::if_::if_indextoname(u32::from(interface)).ok()?;
        let name = name.to_str().ok()?;
        let mask = i32::from_ne_bytes(response[addrs..addrs + 4].try_into().ok()?);
        let mut offset = header;
        let mut gateway = None;
        let mut source = None;
        for bit in 0..8 {
            if mask & (1 << bit) == 0 {
                continue;
            }
            let length = usize::from(*response.get(offset)?);
            let sockaddr = response.get(offset..offset + length)?;
            if bit == 1 || bit == 5 {
                let address = match sockaddr.get(1)? {
                    2 => Some(ip(sockaddr.get(4..8)?, false)?),
                    30 => Some(ip(sockaddr.get(8..24)?, true)?),
                    _ => None,
                };
                if bit == 1 {
                    gateway = address;
                } else {
                    source = address;
                }
            }
            offset += if length == 0 { 4 } else { (length + 3) & !3 };
        }
        // A host route (e.g. loopback) names the destination itself as gateway.
        let gateway = gateway.filter(|gateway| *gateway != address);
        return format(name, gateway, source);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn route_notes_keep_source_in_details() {
        let gateway = "192.0.2.1".parse().unwrap();
        let source = "192.0.2.2".parse().unwrap();
        assert_eq!(
            format("en0", Some(gateway), Some(source)).unwrap().text,
            "via en0 → 192.0.2.1"
        );
        assert_eq!(
            format("en0", None, Some(source)).unwrap().text,
            "on-link en0"
        );
        assert_eq!(
            format("en0", None, Some(source)).unwrap().source,
            Some(source)
        );
        assert!(format("evil\u{1b}]0;x\u{7}", None, Some(source)).is_none());
        assert!(format("", None, Some(source)).is_none());
    }
}
