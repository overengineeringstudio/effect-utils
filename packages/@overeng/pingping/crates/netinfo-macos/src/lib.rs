//! Read-only macOS local-link context. The native boundary lives in this crate.
//!
//! `snapshot` never samples Wi-Fi: the caller explicitly samples only its selected
//! Wi-Fi interface with `snapshot_wifi`. Neither function reads SSID/BSSID, scans,
//! requests Location authorization, changes configuration, or launches a process.
//! Policy flags are event-cached by BSD name, not copied from the global path.
#![deny(unsafe_op_in_unsafe_fn)]

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Medium {
    Ethernet,
    Wifi,
    IphoneUsb,
    Vpn,
    Other(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct WifiLink {
    pub band: Option<&'static str>,
    pub rssi_dbm: Option<i32>,
    pub noise_dbm: Option<i32>,
    pub rate_mbps: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct NetInfo {
    pub interface: String,
    pub localized_name: Option<String>,
    pub medium: Medium,
    pub speed_mbps: Option<u64>,
    pub wifi: Option<WifiLink>,
    /// OS expensive-path policy, not proof of billed usage. False also covers
    /// unavailable policy (initial callback pending or ambiguous attribution).
    pub expensive: bool,
    /// OS Low Data Mode policy, with the same unavailable convention.
    pub constrained: bool,
    /// No distinct public macOS metered bit is available; false means unknown.
    pub metered: bool,
}

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::{primary_interface, snapshot, snapshot_wifi, NetInfoMonitor};

#[cfg(any(target_os = "macos", test))]
fn medium(ifname: &str, kind: &str, label: Option<&str>) -> Medium {
    // utun/ipsec names identify a tunnel, not its vendor or underlying medium.
    if ifname.starts_with("utun")
        || ifname.starts_with("ipsec")
        || matches!(kind, "PPP" | "IPSec" | "VPN" | "6to4")
    {
        Medium::Vpn
    } else if kind == "IEEE80211" {
        Medium::Wifi
    } else if kind == "Ethernet" {
        // This is only the OS-provided hardware label, never an SSID heuristic.
        // Localized/unrecognized labels remain Ethernet and are preserved verbatim.
        if label.is_some_and(|name| name.eq_ignore_ascii_case("iPhone USB")) {
            Medium::IphoneUsb
        } else {
            Medium::Ethernet
        }
    } else {
        Medium::Other(kind.to_owned())
    }
}

#[cfg(any(target_os = "macos", test))]
fn wifi_band(band: isize) -> Option<&'static str> {
    match band {
        1 => Some("2.4 GHz"),
        2 => Some("5 GHz"),
        3 => Some("6 GHz"),
        _ => None,
    }
}

#[cfg(any(target_os = "macos", test))]
fn dbm(value: isize) -> Option<i32> {
    if value == 0 {
        None
    } else {
        i32::try_from(value).ok()
    }
}

#[cfg(any(target_os = "macos", test))]
fn link_rate(value: f64) -> Option<f64> {
    (value.is_finite() && value > 0.0).then_some(value)
}

// A type-restricted NWPath can still enumerate multiple interfaces. Attribution
// is sound only when it has a usable path, uses that type, and names exactly one
// interface of that type. Available interface enumeration alone is insufficient.
#[cfg(any(target_os = "macos", test))]
fn policy_interface(satisfied: bool, uses_type: bool, names: &[String]) -> Option<&str> {
    if satisfied && uses_type && names.len() == 1 {
        Some(&names[0])
    } else {
        None
    }
}

/// Decode Darwin's active Ethernet media word, including extended subtypes.
/// Constants match the public `net/if_media.h`; option flags are not speed bits.
#[cfg(any(target_os = "macos", test))]
fn ethernet_rate(active: i32, status: i32) -> Option<u64> {
    if status & 0x3 != 0x3 || active & 0xe0 != 0x20 {
        return None; // IFM_AVALID | IFM_ACTIVE, IFM_ETHER
    }
    let subtype = (active & 0x1f) | ((active & 0x000f_0000) >> 11);
    match subtype {
        3..=5 | 12 | 13 => Some(10),
        6..=10 | 52 | 62 => Some(100),
        11 | 14..=16 | 24 | 25 | 41 => Some(1_000),
        17 => Some(1), // HomePNA
        22 | 32 | 36 | 63 => Some(2_500),
        23 | 64 | 69 | 70 => Some(5_000),
        18..=21 | 26..=29 | 33..=35 | 42 | 59 => Some(10_000),
        30 => Some(20_000),
        40 | 53..=55 | 58 | 60 | 61 | 65..=68 | 71 | 86 => Some(25_000),
        37 | 38 | 43..=45 | 72..=74 => Some(40_000),
        39 | 56 | 57 | 75..=85 | 87 | 88 => Some(50_000),
        51 => Some(56_000),
        47..=50 | 89..=102 => Some(100_000),
        103..=112 => Some(200_000),
        113..=117 => Some(400_000),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ethernet_media_requires_an_active_ethernet_link_and_decodes_extensions() {
        assert_eq!(ethernet_rate(0x0050_0030, 3), Some(1_000)); // measured en7, FDX/flow
        assert_eq!(ethernet_rate(0x20 | 0x16, 3), Some(2_500));
        assert_eq!(ethernet_rate(0x20 | 0x17, 3), Some(5_000));
        assert_eq!(ethernet_rate(0x20 | 0x0001_0003, 3), Some(10_000)); // IFM_X(35), LRM
        assert_eq!(ethernet_rate(0x20 | 0x0003_0008, 3), Some(200_000)); // IFM_X(104), SR4
        assert_eq!(ethernet_rate(0x20 | 0x10, 0), None);
        assert_eq!(ethernet_rate(0x20 | 0x10, 1), None);
        assert_eq!(ethernet_rate(0x80 | 0x10, 3), None); // Wi-Fi, not Ethernet
        assert_eq!(ethernet_rate(0x20, 3), None); // auto, not a negotiated subtype
        assert_eq!(ethernet_rate(0x20 | 0x000f_001f, 3), None); // unknown future subtype
    }

    #[test]
    fn classifies_os_metadata_without_interface_number_or_hotspot_guesses() {
        assert_eq!(
            medium("en7", "Ethernet", Some("Thunderbolt Ethernet Slot 1")),
            Medium::Ethernet
        );
        assert_eq!(medium("en7", "IEEE80211", Some("Wi-Fi")), Medium::Wifi);
        assert_eq!(
            medium("en0", "Ethernet", Some("iPhone USB")),
            Medium::IphoneUsb
        );
        assert_eq!(medium("en0", "IEEE80211", Some("iPhone USB")), Medium::Wifi);
        assert_eq!(medium("utun8", "", None), Medium::Vpn);
        assert_eq!(medium("ppp0", "PPP", None), Medium::Vpn);
        assert_eq!(
            medium("bridge0", "Bridge", None),
            Medium::Other("Bridge".into())
        );
    }

    #[test]
    fn omits_corewlan_error_values_and_unknown_bands() {
        assert_eq!(dbm(0), None);
        assert_eq!(dbm(-63), Some(-63));
        assert_eq!(dbm(-97), Some(-97));
        assert_eq!(link_rate(0.0), None);
        assert_eq!(link_rate(-1.0), None);
        assert_eq!(link_rate(f64::NAN), None);
        assert_eq!(link_rate(f64::INFINITY), None);
        assert_eq!(link_rate(390.0), Some(390.0));
        assert_eq!(wifi_band(0), None);
        assert_eq!(wifi_band(1), Some("2.4 GHz"));
        assert_eq!(wifi_band(2), Some("5 GHz"));
        assert_eq!(wifi_band(3), Some("6 GHz"));
        assert_eq!(wifi_band(4), None);
    }

    #[test]
    fn never_attributes_global_or_ambiguous_path_policy_to_selected_interface() {
        let one = ["en0".to_owned()];
        let two = ["en0".to_owned(), "en7".to_owned()];
        assert_eq!(policy_interface(true, true, &one), Some("en0"));
        assert_eq!(policy_interface(false, true, &one), None);
        assert_eq!(policy_interface(true, false, &one), None);
        assert_eq!(policy_interface(true, true, &two), None);
        assert_eq!(policy_interface(true, true, &[]), None);
    }
}
