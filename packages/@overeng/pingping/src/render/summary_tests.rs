use super::*;
use crate::probe::ProbeEvent;
#[test]
fn egress_summary_omits_failed_and_invalidated_results() {
    let mut host = HostState::new("example".into());
    let info = crate::egress::Info {
        asn: 64500,
        organization: "Example Network".into(),
        exit_node: true,
    };
    host.apply(ProbeEvent::Egress {
        generation: 0,
        info: Some(info.clone()),
    });
    assert!(plain(&[summary(
        std::slice::from_ref(&host),
        Duration::from_secs(1),
        200
    )])
    .contains(" · Example Network (exit node)"));
    host.apply(ProbeEvent::Egress {
        generation: 1,
        info: None,
    });
    host.apply(ProbeEvent::Egress {
        generation: 0,
        info: Some(info),
    });
    assert!(!plain(&[summary(
        std::slice::from_ref(&host),
        Duration::from_secs(1),
        200
    )])
    .contains("Example Network"));
    host.apply(ProbeEvent::Egress {
        generation: 1,
        info: None,
    });
    assert!(!plain(&[summary(&[host], Duration::from_secs(1), 200)]).contains("Example Network"));
}

#[test]
fn summary_shows_network_and_only_enabled_cost_flags() {
    use crate::netinfo::{Medium, NetInfo, WifiLink};
    let mut host = HostState::new("example".into());
    host.network = Some(std::sync::Arc::new(NetInfo {
        interface: "en0".into(),
        localized_name: None,
        medium: Medium::Wifi,
        speed_mbps: None,
        wifi: Some(WifiLink {
            band: Some("5 GHz"),
            rssi_dbm: Some(-63),
            noise_dbm: None,
            rate_mbps: Some(390.0),
        }),
        expensive: false,
        constrained: false,
        metered: false,
    }));
    let line = summary(std::slice::from_ref(&host), Duration::from_secs(1), 200);
    assert!(plain(std::slice::from_ref(&line)).contains("Wi-Fi 5 GHz · −63 dBm · 390 Mb/s"));
    assert!(!line.iter().any(|span| span.role == Role::Value));
    std::sync::Arc::make_mut(host.network.as_mut().unwrap()).constrained = true;
    std::sync::Arc::make_mut(host.network.as_mut().unwrap()).expensive = true;
    let line = summary(std::slice::from_ref(&host), Duration::from_secs(1), 79);
    assert!(plain(std::slice::from_ref(&line)).ends_with("390 Mb/s · Low Data Mode · expensive"));
    assert!(plain(std::slice::from_ref(&line)).width() <= 79);
    assert_eq!(
        line.iter()
            .filter(|span| span.role == Role::Value)
            .map(|span| span.text.as_str())
            .collect::<Vec<_>>(),
        ["Low Data Mode", "expensive"]
    );
    host.network = None;
    assert!(!plain(&[summary(&[host], Duration::from_secs(1), 79)]).contains("Wi-Fi"));
}

#[test]
fn summary_drops_build_identity_before_other_fields_at_the_width_boundary() {
    let hosts = [HostState::new("example".into())];
    let interval = Duration::from_secs(1);
    let wide = summary(&hosts, interval, 400);
    let text = plain(std::slice::from_ref(&wide));
    let suffix = format!(" · pingping {}", crate::VERSION.as_str());
    assert!(text.ends_with(&suffix));
    assert_eq!(wide.last().unwrap().role, Role::Dim);
    let exact_width = text.width();
    assert_eq!(plain(&[summary(&hosts, interval, exact_width)]), text);
    assert_eq!(
        plain(&[summary(&hosts, interval, exact_width - 1)]),
        text.strip_suffix(&suffix).unwrap()
    );
}
