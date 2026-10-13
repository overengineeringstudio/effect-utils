//! Local link context, sampled once per selected interface, never per frame.
#[cfg(target_os = "linux")]
mod linux;

use std::fmt::Write as _;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq)]
pub enum Medium {
    Ethernet,
    Wifi,
    IphoneUsb,
    Vpn,
    Other(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct WifiLink {
    pub band: Option<&'static str>,
    pub rssi_dbm: Option<i32>,
    pub noise_dbm: Option<i32>,
    pub rate_mbps: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NetInfo {
    pub interface: String,
    pub localized_name: Option<String>,
    pub medium: Medium,
    pub speed_mbps: Option<u64>,
    pub wifi: Option<WifiLink>,
    pub expensive: bool,
    pub constrained: bool,
    pub metered: bool,
}

impl NetInfo {
    pub fn label(&self) -> String {
        let mut text = match &self.medium {
            Medium::Ethernet => "Ethernet".into(),
            Medium::Wifi => "Wi-Fi".into(),
            Medium::IphoneUsb => "iPhone USB".into(),
            Medium::Vpn => "VPN".into(),
            Medium::Other(name) => name.clone(),
        };
        if let Some(wifi) = &self.wifi {
            if let Some(band) = wifi.band {
                let _ = write!(text, " {band}");
            }
            if let Some(rssi) = wifi.rssi_dbm {
                let _ = write!(
                    text,
                    " · {}{} dBm",
                    if rssi < 0 { "−" } else { "" },
                    rssi.unsigned_abs()
                );
            }
            if let Some(rate) = wifi.rate_mbps {
                let _ = write!(text, " · {rate:.0} Mb/s");
            }
        } else if let Some(speed) = self.speed_mbps {
            if speed >= 1000 && speed % 1000 == 0 {
                let _ = write!(text, " {} Gb/s", speed / 1000);
            } else {
                let _ = write!(text, " {speed} Mb/s");
            }
        }
        text
    }

    pub fn flags(&self) -> impl Iterator<Item = &'static str> {
        [
            (self.constrained, "Low Data Mode"),
            (self.expensive, "expensive"),
            (self.metered, "metered"),
        ]
        .into_iter()
        .filter_map(|(on, text)| on.then_some(text))
    }

    pub fn plain(&self) -> String {
        let mut text = self.label();
        for flag in self.flags() {
            text.push_str(" · ");
            text.push_str(flag);
        }
        text.push_str(" (");
        text.push_str(&self.interface);
        text.push(')');
        text
    }
}

/// Single selected-link cache. Native metadata changes on callbacks; Linux
/// snapshots share the path monitor cadence. Wi-Fi never samples faster.
pub struct Tracker {
    pub current: Option<Arc<NetInfo>>,
    next_wifi: Instant,
    #[cfg(target_os = "macos")]
    dirty: bool,
}

impl Tracker {
    pub fn new() -> Self {
        Self {
            current: None,
            next_wifi: Instant::now(),
            #[cfg(target_os = "macos")]
            dirty: true,
        }
    }

    #[cfg(target_os = "macos")]
    pub fn invalidate(&mut self) {
        self.dirty = true;
    }

    pub fn refresh(&mut self, interface: Option<&str>) -> bool {
        #[cfg(target_os = "linux")]
        let info = interface.and_then(snapshot);
        #[cfg(target_os = "macos")]
        let info = interface.and_then(|interface| {
            if !self.dirty {
                if let Some(info) = self
                    .current
                    .as_deref()
                    .filter(|info| info.interface == interface)
                {
                    return Some(info.clone());
                }
            }
            snapshot(interface)
        });
        #[cfg(target_os = "macos")]
        {
            self.dirty = false;
        }
        let info = info.map(|mut info| {
            if info.medium == Medium::Wifi {
                if Instant::now() >= self.next_wifi {
                    info.wifi = snapshot_wifi(&info.interface);
                    self.next_wifi = Instant::now() + Duration::from_secs(10);
                } else {
                    info.wifi = self
                        .current
                        .as_deref()
                        .filter(|old| old.interface == info.interface)
                        .and_then(|old| old.wifi.clone());
                }
            }
            info
        });
        if info.as_ref() == self.current.as_deref() {
            return false;
        }
        self.current = info.map(Arc::new);
        true
    }
}

/// A single summary cannot describe multiple independent routes. Prefer their
/// common outgoing interface; when they differ, use the OS primary interface.
/// Tailnet host routes are excluded by the caller, so a tailnet-only run uses
/// the primary underlay, not the Tailscale tunnel.
pub fn select<'a>(interfaces: impl Iterator<Item = &'a str>) -> Option<String> {
    let mut interfaces = interfaces;
    let first = interfaces.next();
    if let Some(first) = first {
        if interfaces.all(|name| name == first) {
            return Some(first.to_owned());
        }
    }
    primary_interface()
}

#[cfg(target_os = "linux")]
pub fn primary_interface() -> Option<String> {
    linux::primary_interface()
}

#[cfg(target_os = "linux")]
pub fn snapshot(interface: &str) -> Option<NetInfo> {
    linux::snapshot(interface)
}

#[cfg(target_os = "linux")]
pub fn snapshot_wifi(interface: &str) -> Option<WifiLink> {
    linux::snapshot_wifi(interface)
}

#[cfg(target_os = "macos")]
pub fn primary_interface() -> Option<String> {
    pingping_netinfo_macos::primary_interface()
}

#[cfg(target_os = "macos")]
pub fn snapshot(interface: &str) -> Option<NetInfo> {
    use pingping_netinfo_macos as mac;
    let info = mac::snapshot(interface)?;
    Some(NetInfo {
        interface: info.interface,
        localized_name: info.localized_name,
        medium: match info.medium {
            mac::Medium::Ethernet => Medium::Ethernet,
            mac::Medium::Wifi => Medium::Wifi,
            mac::Medium::IphoneUsb => Medium::IphoneUsb,
            mac::Medium::Vpn => Medium::Vpn,
            mac::Medium::Other(name) => Medium::Other(name),
        },
        speed_mbps: info.speed_mbps,
        wifi: info.wifi.map(|wifi| WifiLink {
            band: wifi.band,
            rssi_dbm: wifi.rssi_dbm,
            noise_dbm: wifi.noise_dbm,
            rate_mbps: wifi.rate_mbps,
        }),
        expensive: info.expensive,
        constrained: info.constrained,
        metered: info.metered,
    })
}

#[cfg(target_os = "macos")]
pub fn snapshot_wifi(interface: &str) -> Option<WifiLink> {
    let wifi = pingping_netinfo_macos::snapshot_wifi(interface)?;
    Some(WifiLink {
        band: wifi.band,
        rssi_dbm: wifi.rssi_dbm,
        noise_dbm: wifi.noise_dbm,
        rate_mbps: wifi.rate_mbps,
    })
}

pub fn with_wifi(mut info: NetInfo) -> NetInfo {
    if info.medium == Medium::Wifi {
        info.wifi = snapshot_wifi(&info.interface);
    }
    info
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_omits_unknown_metrics_and_off_flags() {
        let mut info = NetInfo {
            interface: "en7".into(),
            localized_name: None,
            medium: Medium::Ethernet,
            speed_mbps: Some(1000),
            wifi: None,
            expensive: false,
            constrained: false,
            metered: false,
        };
        assert_eq!(info.plain(), "Ethernet 1 Gb/s (en7)");
        info.speed_mbps = None;
        info.expensive = true;
        assert_eq!(info.plain(), "Ethernet · expensive (en7)");
        info.medium = Medium::Wifi;
        info.wifi = Some(WifiLink {
            band: Some("5 GHz"),
            rssi_dbm: Some(-63),
            noise_dbm: None,
            rate_mbps: Some(390.0),
        });
        info.constrained = true;
        info.metered = true;
        assert_eq!(
            info.plain(),
            "Wi-Fi 5 GHz · −63 dBm · 390 Mb/s · Low Data Mode · expensive · metered (en7)"
        );
        info.wifi = None;
        assert_eq!(info.label(), "Wi-Fi");
    }
}
