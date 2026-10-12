//! Read-only sysfs and netlink snapshots. Missing kernel/provider data stays unknown.
#![forbid(unsafe_code)]

use std::fs;
use std::os::fd::{AsRawFd, OwnedFd};
use std::path::Path;
use std::time::{Duration, Instant};

use nix::sys::socket::{
    bind, recvfrom, sendto, setsockopt, socket, sockopt, AddressFamily, MsgFlags, NetlinkAddr,
    SockFlag, SockProtocol, SockType,
};
use nix::sys::time::TimeVal;

use super::{Medium, NetInfo, WifiLink};

/// Link identity and Ethernet speed only; the caller owns Wi-Fi refresh cadence.
pub(super) fn snapshot(ifname: &str) -> Option<NetInfo> {
    if ifname.is_empty()
        || ifname == "."
        || ifname == ".."
        || ifname.chars().any(|c| c.is_control() || c == '/')
    {
        return None;
    }
    let root = Path::new("/sys/class/net").join(ifname);
    let hardware_type = fs::read_to_string(root.join("type"))
        .ok()?
        .trim()
        .parse()
        .ok()?;
    let wireless = root.join("wireless").exists() || root.join("phy80211").exists();
    let driver = fs::read_link(root.join("device/driver")).ok();
    let driver = driver
        .as_ref()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str());
    let index = nix::net::if_::if_nametoindex(ifname).ok()?;
    let kind = if wireless || driver == Some("ipheth") {
        None
    } else {
        link_kind(index)
    };
    let medium = classify(
        wireless,
        driver,
        kind.as_deref(),
        hardware_type,
        root.join("device").exists(),
    );
    let speed_mbps = if matches!(medium, Medium::Ethernet) {
        fs::read_to_string(root.join("speed"))
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
            .filter(|speed| *speed > 0)
    } else {
        None
    };
    Some(NetInfo {
        interface: ifname.to_owned(),
        localized_name: None,
        medium,
        speed_mbps,
        wifi: None,
        // No NetworkManager provider; do not infer policy from medium.
        expensive: false,
        constrained: false,
        metered: false,
    })
}

/// Read selected Wi-Fi metrics separately so route resolution cannot trigger polling.
/// The caller must throttle this query; each call has a 200 ms receive budget.
pub(super) fn snapshot_wifi(ifname: &str) -> Option<WifiLink> {
    let index = nix::net::if_::if_nametoindex(ifname).ok()?;
    let root = Path::new("/sys/class/net").join(ifname);
    if !root.join("wireless").exists() && !root.join("phy80211").exists() {
        return None;
    }
    wifi_link(index)
}

fn classify(
    wireless: bool,
    driver: Option<&str>,
    kind: Option<&str>,
    hardware_type: u16,
    device: bool,
) -> Medium {
    if wireless {
        Medium::Wifi
    } else if driver == Some("ipheth") {
        Medium::IphoneUsb
    } else if let Some(kind) = kind {
        match kind {
            "tun" | "wireguard" | "ipip" | "sit" | "gre" | "gretap" | "ip6gre" | "ip6gretap"
            | "ip6tnl" | "vti" | "vti6" | "xfrm" => Medium::Vpn,
            _ => Medium::Other(kind.to_owned()),
        }
    } else if hardware_type == 1 && device {
        Medium::Ethernet
    } else {
        let name = if hardware_type == 772 {
            "loopback"
        } else if device {
            "other"
        } else {
            "virtual"
        };
        Medium::Other(name.to_owned())
    }
}

/// Main-table default route, IPv4 first and IPv6 fallback; no Internet probe.
/// This is a local primary-link hint, not a policy-routing lookup for a destination.
pub(super) fn primary_interface() -> Option<String> {
    fs::read_to_string("/proc/net/route")
        .ok()
        .and_then(|text| default_route(&text, false))
        .or_else(|| {
            fs::read_to_string("/proc/net/ipv6_route")
                .ok()
                .and_then(|text| default_route(&text, true))
        })
}

fn default_route(text: &str, ipv6: bool) -> Option<String> {
    let mut best: Option<(&str, u32)> = None;
    for line in text.lines() {
        let mut fields = line.split_whitespace();
        let candidate = if ipv6 {
            let destination = fields.next();
            let prefix = fields.next();
            let source = fields.next();
            let source_prefix = fields.next();
            let _gateway = fields.next();
            let metric = fields.next().and_then(|s| u32::from_str_radix(s, 16).ok());
            let _reference = fields.next();
            let _usage = fields.next();
            let flags = fields.next().and_then(|s| u32::from_str_radix(s, 16).ok());
            let name = fields.next();
            match (
                destination,
                prefix,
                source,
                source_prefix,
                metric,
                flags,
                name,
            ) {
                (
                    Some("00000000000000000000000000000000"),
                    Some("00"),
                    Some("00000000000000000000000000000000"),
                    Some("00"),
                    Some(metric),
                    Some(flags),
                    Some(name),
                ) if flags & 1 != 0 && flags & 0x200 == 0 => Some((name, metric)),
                _ => None,
            }
        } else {
            let name = fields.next();
            let destination = fields.next();
            let _gateway = fields.next();
            let flags = fields.next().and_then(|s| u32::from_str_radix(s, 16).ok());
            let _reference = fields.next();
            let _usage = fields.next();
            let metric = fields.next().and_then(|s| s.parse::<u32>().ok());
            let mask = fields.next();
            match (name, destination, flags, metric, mask) {
                (Some(name), Some("00000000"), Some(flags), Some(metric), Some("00000000"))
                    if flags & 1 != 0 && flags & 0x200 == 0 =>
                {
                    Some((name, metric))
                }
                _ => None,
            }
        };
        if let Some((name, metric)) = candidate {
            if best.is_none_or(|(_, previous)| metric < previous) {
                best = Some((name, metric));
            }
        }
    }
    best.map(|(name, _)| name.to_owned())
}

fn u16_value(bytes: &[u8]) -> Option<u16> {
    Some(u16::from_ne_bytes(bytes.try_into().ok()?))
}

fn u32_value(bytes: &[u8]) -> Option<u32> {
    Some(u32::from_ne_bytes(bytes.try_into().ok()?))
}

/// Validate the complete attribute stream before exposing any of its values.
fn attributes(mut bytes: &[u8]) -> Option<impl Iterator<Item = (u16, &[u8])>> {
    let original = bytes;
    while !bytes.is_empty() {
        let length = usize::from(u16_value(bytes.get(..2)?)?);
        if length < 4 {
            return None;
        }
        bytes.get(..length)?;
        let padded = (length + 3) & !3;
        bytes = if length == bytes.len() {
            &[]
        } else {
            bytes.get(padded..)?
        };
    }
    let mut bytes = original;
    Some(std::iter::from_fn(move || {
        if bytes.is_empty() {
            return None;
        }
        let length = usize::from(u16_value(&bytes[..2])?);
        let kind = u16_value(&bytes[2..4])? & 0x3fff;
        let value = &bytes[4..length];
        bytes = if length == bytes.len() {
            &[]
        } else {
            &bytes[(length + 3) & !3..]
        };
        Some((kind, value))
    }))
}

struct Netlink {
    fd: OwnedFd,
    deadline: Instant,
}

impl Netlink {
    fn open(protocol: SockProtocol) -> Option<Self> {
        let fd = socket(
            AddressFamily::Netlink,
            SockType::Datagram,
            SockFlag::SOCK_CLOEXEC,
            protocol,
        )
        .ok()?;
        bind(fd.as_raw_fd(), &NetlinkAddr::new(0, 0)).ok()?;
        Some(Self {
            fd,
            deadline: Instant::now() + Duration::from_millis(200),
        })
    }

    fn query(
        &self,
        kind: u16,
        expected: u16,
        flags: u16,
        sequence: u32,
        payload: &[u8],
        mut visit: impl FnMut(&[u8]) -> Option<()>,
    ) -> Option<()> {
        let length = 16 + payload.len();
        let mut request = [0; 128];
        request.get_mut(16..length)?.copy_from_slice(payload);
        request[..4].copy_from_slice(&u32::try_from(length).ok()?.to_ne_bytes());
        request[4..6].copy_from_slice(&kind.to_ne_bytes());
        request[6..8].copy_from_slice(&flags.to_ne_bytes());
        request[8..12].copy_from_slice(&sequence.to_ne_bytes());
        sendto(
            self.fd.as_raw_fd(),
            &request[..length],
            &NetlinkAddr::new(0, 0),
            MsgFlags::empty(),
        )
        .ok()?;
        let mut response = [0; 16384];
        for _ in 0..64 {
            let remaining = self.deadline.checked_duration_since(Instant::now())?;
            let micros = i64::try_from(remaining.as_micros()).ok()?.max(1);
            setsockopt(
                &self.fd,
                sockopt::ReceiveTimeout,
                &TimeVal::new(micros / 1_000_000, micros % 1_000_000),
            )
            .ok()?;
            let (count, sender) =
                recvfrom::<NetlinkAddr>(self.fd.as_raw_fd(), &mut response).ok()?;
            // recvfrom does not expose MSG_TRUNC in nix: a full buffer is
            // conservatively unavailable, even when it might fit exactly.
            if count >= response.len() || sender?.pid() != 0 {
                return None;
            }
            if decode_datagram(&response[..count], expected, sequence, &mut visit)? {
                return Some(());
            }
        }
        None
    }
}

/// `Some(true)` only at a non-multipart reply or successful multipart DONE.
fn decode_datagram(
    mut bytes: &[u8],
    expected: u16,
    sequence: u32,
    visit: &mut impl FnMut(&[u8]) -> Option<()>,
) -> Option<bool> {
    let mut finished = false;
    while !bytes.is_empty() {
        let length = usize::try_from(u32_value(bytes.get(..4)?)?).ok()?;
        if length < 16 {
            return None;
        }
        let message = bytes.get(..length)?;
        let kind = u16_value(&message[4..6])?;
        let flags = u16_value(&message[6..8])?;
        if u32_value(&message[8..12])? != sequence || flags & 0x10 != 0 {
            return None;
        } // NLM_F_DUMP_INTR
        let payload = &message[16..];
        match kind {
            2 => {
                // NLMSG_ERROR: zero is an ACK, not a completed dump.
                if u32_value(payload.get(..4)?)? != 0 {
                    return None;
                }
            }
            3 => {
                // NLMSG_DONE may carry a negative error code.
                if !payload.is_empty() && u32_value(payload.get(..4)?)? != 0 {
                    return None;
                }
                finished = true;
            }
            kind if kind == expected => {
                visit(payload)?;
                if flags & 2 == 0 {
                    finished = true;
                }
            }
            _ => return None,
        }
        bytes = if length == bytes.len() {
            &[]
        } else {
            bytes.get((length + 3) & !3..)?
        };
    }
    Some(finished)
}

fn link_kind(index: u32) -> Option<String> {
    let socket = Netlink::open(SockProtocol::NetlinkRoute)?;
    let mut request = [0; 16]; // ifinfomsg
    request[4..8].copy_from_slice(&index.to_ne_bytes());
    let mut link_kind = None;
    socket.query(18, 16, 1, 1, &request, |payload| {
        // RTM_GETLINK → RTM_NEWLINK
        if u32_value(payload.get(4..8)?)? != index {
            return None;
        }
        for (kind, value) in attributes(payload.get(16..)?)? {
            if kind == 18 {
                // IFLA_LINKINFO
                for (kind, value) in attributes(value)? {
                    if kind == 1 {
                        // IFLA_INFO_KIND, a NUL-terminated string
                        let text = std::str::from_utf8(value.strip_suffix(&[0])?).ok()?;
                        if text.is_empty() || text.chars().any(char::is_control) {
                            return None;
                        }
                        link_kind = Some(text.to_owned());
                    }
                }
            }
        }
        Some(())
    })?;
    link_kind
}

fn band(frequency: u32) -> Option<&'static str> {
    match frequency {
        2400..=2500 => Some("2.4 GHz"),
        4900..=5924 => Some("5 GHz"),
        5925..=7125 => Some("6 GHz"),
        57000..=71000 => Some("60 GHz"),
        _ => None,
    }
}

fn decode_interface(payload: &[u8], index: u32) -> Option<WifiLink> {
    if payload.first().copied()? != 7 {
        return None;
    } // NL80211_CMD_NEW_INTERFACE
    let mut matched = false;
    let mut frequency = None;
    for (kind, value) in attributes(payload.get(4..)?)? {
        match kind {
            3 => matched = u32_value(value)? == index,
            38 => frequency = Some(u32_value(value)?), // NL80211_ATTR_WIPHY_FREQ
            _ => {}
        }
    }
    if !matched {
        return None;
    }
    Some(WifiLink {
        band: frequency.and_then(band),
        rssi_dbm: None,
        noise_dbm: None,
        rate_mbps: None,
    })
}

fn decode_station(payload: &[u8], index: u32) -> Option<WifiLink> {
    if payload.first().copied()? != 19 {
        return None;
    } // NL80211_CMD_NEW_STATION
    let mut matched = false;
    let mut station = None;
    for (kind, value) in attributes(payload.get(4..)?)? {
        match kind {
            3 => matched = u32_value(value)? == index,
            21 => station = Some(value), // NL80211_ATTR_STA_INFO
            _ => {}
        }
    }
    if !matched {
        return None;
    }
    let mut signal = None;
    let mut average = None;
    let mut bitrate = None;
    let mut bitrate32 = None;
    for (kind, value) in attributes(station?)? {
        match kind {
            7 | 13 => {
                let value = i32::from(i8::from_ne_bytes(value.try_into().ok()?));
                if kind == 13 {
                    average = Some(value);
                } else {
                    signal = Some(value);
                }
            }
            8 => {
                for (kind, value) in attributes(value)? {
                    match kind {
                        1 => bitrate = Some(u16_value(value)?),
                        5 => bitrate32 = Some(u32_value(value)?),
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    Some(WifiLink {
        band: None,
        rssi_dbm: average.or(signal),
        noise_dbm: None,
        rate_mbps: bitrate32
            .or(bitrate.map(u32::from))
            .filter(|rate| *rate > 0)
            .map(|rate| f64::from(rate) / 10.0),
    })
}

fn wifi_link(index: u32) -> Option<WifiLink> {
    let socket = Netlink::open(SockProtocol::NetlinkGeneric)?;
    // CTRL_CMD_GETFAMILY + CTRL_ATTR_FAMILY_NAME, padded to four bytes.
    let mut resolve = [0; 16];
    resolve[..4].copy_from_slice(&[3, 1, 0, 0]);
    resolve[4..6].copy_from_slice(&12_u16.to_ne_bytes());
    resolve[6..8].copy_from_slice(&2_u16.to_ne_bytes());
    resolve[8..].copy_from_slice(b"nl80211\0");
    let mut family = None;
    socket.query(16, 16, 1, 1, &resolve, |payload| {
        if payload.first().copied()? != 1 {
            return None;
        } // CTRL_CMD_NEWFAMILY
        for (kind, value) in attributes(payload.get(4..)?)? {
            if kind == 1 {
                family = Some(u16_value(value)?);
            }
        }
        Some(())
    })?;
    let family = family?;
    let mut request = [0; 12];
    request[0] = 5; // NL80211_CMD_GET_INTERFACE
    request[4..6].copy_from_slice(&8_u16.to_ne_bytes());
    request[6..8].copy_from_slice(&3_u16.to_ne_bytes()); // NL80211_ATTR_IFINDEX
    request[8..].copy_from_slice(&index.to_ne_bytes());
    let mut link = WifiLink {
        band: None,
        rssi_dbm: None,
        noise_dbm: None,
        rate_mbps: None,
    };
    socket.query(family, family, 1, 2, &request, |payload| {
        link = decode_interface(payload, index)?;
        Some(())
    })?;
    request[0] = 17; // NL80211_CMD_GET_STATION, dump without a peer MAC address.
    let mut station = None;
    let result = socket.query(family, family, 0x301, 3, &request, |payload| {
        let decoded = decode_station(payload, index)?;
        if station.is_none() {
            station = Some(decoded);
        }
        Some(())
    });
    if result.is_some() {
        if let Some(station) = station {
            link.rssi_dbm = station.rssi_dbm;
            link.rate_mbps = station.rate_mbps;
        }
    }
    Some(link)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attr(kind: u16, value: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&u16::try_from(value.len() + 4).unwrap().to_ne_bytes());
        bytes.extend_from_slice(&kind.to_ne_bytes());
        bytes.extend_from_slice(value);
        bytes.resize((bytes.len() + 3) & !3, 0);
        bytes
    }

    fn message(kind: u16, flags: u16, sequence: u32, payload: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&u32::try_from(payload.len() + 16).unwrap().to_ne_bytes());
        bytes.extend_from_slice(&kind.to_ne_bytes());
        bytes.extend_from_slice(&flags.to_ne_bytes());
        bytes.extend_from_slice(&sequence.to_ne_bytes());
        bytes.extend_from_slice(&0_u32.to_ne_bytes());
        bytes.extend_from_slice(payload);
        bytes.resize((bytes.len() + 3) & !3, 0);
        bytes
    }

    fn station(signal: &[u8], average: Option<&[u8]>, rates: &[u8]) -> Vec<u8> {
        let mut info = attr(7, signal);
        if let Some(average) = average {
            info.extend(attr(13, average));
        }
        info.extend(attr(8 | 0x8000, rates));
        let mut payload = vec![19, 0, 0, 0];
        payload.extend(attr(3, &7_u32.to_ne_bytes()));
        payload.extend(attr(0x0015 | 0x8000, &info));
        payload
    }

    #[test]
    fn medium_requires_physical_ethernet_and_preserves_virtual_kinds() {
        assert!(matches!(
            classify(true, Some("mt7921e"), None, 1, true),
            Medium::Wifi
        ));
        assert!(matches!(
            classify(false, Some("ipheth"), None, 1, true),
            Medium::IphoneUsb
        ));
        assert!(matches!(
            classify(false, Some("cdc_ether"), None, 1, true),
            Medium::Ethernet
        ));
        assert!(
            matches!(classify(false, None, None, 1, false), Medium::Other(name) if name == "virtual")
        );
        for kind in ["bridge", "veth", "vlan", "macvlan", "unknown-kind"] {
            assert!(
                matches!(classify(false, None, Some(kind), 1, false), Medium::Other(name) if name == kind)
            );
        }
        for kind in ["tun", "wireguard", "gre", "xfrm"] {
            assert!(matches!(
                classify(false, None, Some(kind), 65534, false),
                Medium::Vpn
            ));
        }
        assert!(
            matches!(classify(false, None, None, 772, false), Medium::Other(name) if name == "loopback")
        );
    }

    #[test]
    fn wifi_signal_average_and_wide_rate_take_precedence() {
        let mut rates = attr(1, &4333_u16.to_ne_bytes());
        rates.extend(attr(5, &8667_u32.to_ne_bytes()));
        let payload = station(&[196], Some(&[191]), &rates); // signed -60, -65 dBm
        let link = decode_station(&payload, 7).unwrap();
        assert_eq!(link.rssi_dbm, Some(-65));
        assert_eq!(link.rate_mbps, Some(866.7));
        assert!(decode_station(&payload, 8).is_none());
        let payload = station(&[196], None, &attr(1, &4333_u16.to_ne_bytes()));
        let link = decode_station(&payload, 7).unwrap();
        assert_eq!(link.rssi_dbm, Some(-60));
        assert_eq!(link.rate_mbps, Some(433.3));
        assert!(decode_station(&station(&[0, 0], None, &rates), 7).is_none());
        assert!(decode_station(&station(&[196], None, &attr(5, &[1, 2])), 7).is_none());
    }

    #[test]
    fn wifi_frequency_and_malformed_attributes() {
        let mut payload = vec![7, 0, 0, 0];
        payload.extend(attr(3, &7_u32.to_ne_bytes()));
        payload.extend(attr(38, &5955_u32.to_ne_bytes()));
        assert_eq!(decode_interface(&payload, 7).unwrap().band, Some("6 GHz"));
        assert_eq!(band(2412), Some("2.4 GHz"));
        assert_eq!(band(5180), Some("5 GHz"));
        assert_eq!(band(58320), Some("60 GHz"));
        assert_eq!(band(8000), None);
        payload.extend_from_slice(&[2, 0, 1, 0]); // attribute shorter than its header
        assert!(decode_interface(&payload, 7).is_none());
    }

    #[test]
    fn netlink_rejects_errors_wrong_sequence_and_incomplete_packets() {
        let payload = station(&[196], None, &attr(1, &4333_u16.to_ne_bytes()));
        let packet = message(42, 2, 3, &payload);
        let mut observed = None;
        let mut visit = |bytes: &[u8]| {
            observed = Some(decode_station(bytes, 7)?);
            Some(())
        };
        assert_eq!(decode_datagram(&packet, 42, 3, &mut visit), Some(false));
        assert_eq!(
            decode_datagram(&message(3, 2, 3, &0_i32.to_ne_bytes()), 42, 3, &mut visit),
            Some(true)
        );
        assert_eq!(
            decode_datagram(&message(2, 0, 3, &0_i32.to_ne_bytes()), 42, 3, &mut visit),
            Some(false)
        );
        assert_eq!(
            decode_datagram(
                &message(2, 0, 3, &(-1_i32).to_ne_bytes()),
                42,
                3,
                &mut visit
            ),
            None
        );
        assert_eq!(
            decode_datagram(
                &message(3, 2, 3, &(-4_i32).to_ne_bytes()),
                42,
                3,
                &mut visit
            ),
            None
        );
        assert_eq!(decode_datagram(&packet, 42, 4, &mut visit), None);
        assert_eq!(
            decode_datagram(&packet[..packet.len() - 1], 42, 3, &mut visit),
            None
        );
        assert_eq!(
            decode_datagram(&message(42, 0x12, 3, &payload), 42, 3, &mut visit),
            None
        );
        let mut combined = packet;
        combined.extend(message(3, 2, 3, &0_i32.to_ne_bytes()));
        assert_eq!(decode_datagram(&combined, 42, 3, &mut visit), Some(true));
        assert_eq!(observed.unwrap().rssi_dbm, Some(-60));
    }

    #[test]
    fn primary_uses_lowest_metric_usable_default_not_specific_routes() {
        let routes = "Iface Destination Gateway Flags RefCnt Use Metric Mask\n\
            high 00000000 0101A8C0 0003 0 0 600 00000000\n\
            down 00000000 0101A8C0 0002 0 0 1 00000000\n\
            reject 00000000 00000000 0201 0 0 0 00000000\n\
            specific 00000000 00000000 0001 0 0 0 000000FF\n\
            low 00000000 0101A8C0 0003 0 0 100 00000000";
        assert_eq!(default_route(routes, false).as_deref(), Some("low"));
        let routes = "00000000000000000000000000000000 00 00000000000000000000000000000000 00 fe800000000000000000000000000001 00000064 00000000 00000000 00000003 eth0\n\
            00000000000000000000000000000000 00 00000000000000000000000000000000 00 00000000000000000000000000000000 ffffffff 00000000 00000000 00200200 lo";
        assert_eq!(default_route(routes, true).as_deref(), Some("eth0"));
    }
}
