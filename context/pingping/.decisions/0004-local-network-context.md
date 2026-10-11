# Local network context in the summary line, macOS through a reviewed FFI crate

Status: accepted

## Context

the user asked on 2026-10-04 for information about the current local network
(Ethernet, Wi-Fi, tethering, Low Data Mode) so a viewer can set expectations
for the latencies shown. Decided in three interview rounds
(design interview decisions Q23, Q24, Q26).

## Evidence and Argument

- macOS (macos-host): SystemConfiguration names the used interface (en7 =
  Ethernet) in about 2.6 ms; Network.framework's NWPath reports expensive and
  constrained (Low Data Mode) with change callbacks; CoreWLAN gives RSSI,
  noise, band and link rate in about 4 ms without Location permission when
  SSID/BSSID are not read. No safe Rust binding covers Network.framework, and
  CoreWLAN getters are `unsafe fn` in objc2-core-wlan.
- Linux (linux-host): route interface, netlink link kind, sysfs speed and nl80211
  station data are unprivileged and cost microseconds with the existing `nix`
  socket approach. NetworkManager does not run on host-a, host-b or linux-host, so a
  metered flag is unavailable there.
- Captive portal and "internet down" cannot be known without active probes.

## Options

| Option | Tradeoffs |
| --- | --- |
| Scope: medium + speed, cost flags, Wi-Fi quality, path status, Low Power Mode | First three chosen; path status and Low Power Mode left out. |
| Placement: header line, summary line, axis line | Summary line chosen: no extra line. |
| Flags always vs only when on | Only when on: normal networks stay quiet. |
| macOS: Swift helper process | Full scope, unsafe-free, ~12 MiB extra per run, Swift in the build. |
| macOS: reviewed unsafe boundary crate | Full scope, no extra process; explicit unsafe exception. |
| macOS: safe system-configuration only | Medium only on the Mac. |

## Decision

The summary line carries the local network context: medium and link speed,
Wi-Fi band, signal and link rate when on Wi-Fi, and cost flags only when on.
On macOS a separate crate, the only place in pingping where `unsafe` is
allowed, wraps SystemConfiguration, Network.framework and CoreWLAN behind a
safe, event-driven API; the main crate keeps `unsafe_code = "forbid"`. Linux
uses safe netlink and sysfs reads in the main crate.

## Consequences

The macOS crate needs an FFI review (lifetimes, threads, cancellation) and
is built and tested only on macOS. Linux shows no metered flag without
NetworkManager.
