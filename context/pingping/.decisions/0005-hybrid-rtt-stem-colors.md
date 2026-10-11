# RTT stems are coloured relative to the host median with absolute floors

Status: accepted

## Context

One spark blue for every RTT stem shows height but not whether latency is
unusual for that host. The same view mixes LAN hosts at 1–5 ms and internet
hosts at 10–30 ms; one absolute scale does not capture both baselines.
the user compared schemes and constants live in the real `pingping`, choosing
hybrid bands (decision q34) and the previewed constants (decision q35).

## Evidence and Argument

- [PingPlotter](https://www.pingplotter.com/manual/displayoptions/) uses
  absolute 200/500 ms defaults.
- [pyng](https://pynosaur.org/pyng) uses 50/150 ms thresholds.
- [Prettyping](https://raw.githubusercontent.com/denilsonsa/prettyping/master/prettyping)
  uses a 10–230 ms ramp.
- [Cisco's VoIP guidance](https://www.cisco.com/c/en/us/td/docs/ios/solutions_docs/qos_solutions/QoSVoIP/QoSVoIP.html)
  gives an RTT budget below 300 ms.
- [Nielsen's response-time limits](https://www.nngroup.com/articles/response-times-3-important-limits)
  identify 0.1 s as the limit for a response to feel instantaneous.
- No surveyed tool colors RTT relative to a per-host baseline.

Medians measured from macos-host on 2026-10-07:

| Host | Median RTT |
| --- | --- |
| linux-host | 1.2 ms |
| google.com | 12 ms |
| host-a | 16 ms |
| host-b | 17 ms |
| host-e | 25 ms |

The relative bands identify deviations from these different baselines.
Absolute floors keep a persistently slow link from appearing healthy merely
because its median is also slow. A 20 ms quiet zone avoids warning colors
for harmless small absolute changes on fast links.

## Options

| Scheme | Tradeoffs |
| --- | --- |
| Absolute bands | Comparable across hosts, but insensitive to smaller spikes on fast links. |
| Log ramp | Covers a broad RTT range with gradual colors, but gives no host-relative warning boundary. |
| Relative | Detects deviations from each host's baseline, but normalizes persistent slowness. |
| Hybrid | Relative bands with a quiet zone and absolute floors; chosen (q34). |

| Band constants | Tradeoffs |
| --- | --- |
| Previewed | 20 ms quiet zone, 1.5×/3× median bands, 150/300 ms floors; chosen (q35). |
| Sensitive | Earlier warning transitions, with more visual noise from small variations. |
| Calm | Later warning transitions, with less noise but less sensitivity to degradation. |

## Decision

The baseline is the median of completed replies in the host's retained
history, excluding lost probes. It does not depend on the visible window
or statistics scope. Each terminal column takes the band of its worst
subcell RTT across the stem's rows.

Below 20 ms there are no warning colors. Otherwise, after at least 10
replies, RTT at or below 1.5× the median uses `spark`, at or below 3× uses
amber (`RttElevated`), and above 3× uses orange (`RttHigh`). Absolute floors
always apply: RTT at least 150 ms is at least amber; RTT at least 300 ms is
orange. With fewer than 10 replies, only the floors apply. Non-warning
lowest stems retain the faint baseline color; higher stems use `spark`.
Warning bands also color lowest stems. Red remains reserved for failed
pings, and successful dots retain priority in mixed chart cells. Glyph
shapes, stem heights and hover/window background tints are unchanged.

## Consequences

A link that stays slow still warns through the absolute floors. There is a
warm-up period before relative bands apply. Colors are per host, not
comparable across hosts: the same amber can represent different absolute
RTTs. The median follows retained history, so relative warnings adapt as
the host's baseline changes.
