# Dynamic tailnet completion, sidecar layout, compact path note

Status: accepted

## Context

the user asked for shell completion (especially host names), a layout that
uses horizontal space and adapts on resize, and possibly the network path next
to the address. Sub-agents prototyped each in scratch copies on linux-host; the user
decided in three rounds on 2026-10-03 (design interview decisions
Q9-Q16).

## Evidence and Argument

- Completion: clap's static fish generator ignores the positional hostname
  hint and bash has no host hint, so static scripts complete hosts in zsh only.
  A dynamic completer answered `pingping d<TAB>` in about 12-14 ms with tailnet
  names, and in about 100 ms when `tailscale` hangs (bounded). Tailscale
  `HostName` values can be stale or duplicated; MagicDNS names are canonical.
  `/etc/hosts` is self-only on linux-host; ssh aliases such as `host-a-root` are not
  resolvable by pingping.
- Layout: the stacked block used 9 lines per host at every width, leaving
  80-90% of a 200-column row empty. Three variants passed hover, zoom,
  overview and resize checks in a real PTY.
- Path: unprivileged ICMP traceroute works on Linux, but a tailnet peer shows
  one overlay hop, routers rate-limit ICMP, and a hop list does not locate
  latency. Tailscale transport state (direct, DERP region, peer relay) and the
  local route (interface, gateway) are cheap local reads and explain common
  latency changes. On macOS the route lookup (`RTM_GET`) uses a `PF_ROUTE`
  control socket, which is `SOCK_RAW` but is not a raw IP socket.

## Options

| Option | Tradeoffs |
| --- | --- |
| Dynamic completion (clap `unstable-dynamic`, like axe) | Curated, labelled hosts in every shell; a pingping process per TAB; unstable protocol, so registration must come from the same binary. |
| Static completion scripts | Stable, no process per TAB; hosts only in zsh; ssh aliases leak in. |
| Host sources: tailnet / ssh config / `/etc/hosts` / recent targets | Tailnet is high signal and cheap; ssh needs a parser and mostly duplicates tailnet; `/etc/hosts` is low signal; recent targets need a written state file. |
| Ribbon / Bars / Sidecar layout | Ribbon is densest and closest to the reference; Bars shows spikes larger; Sidecar gives a tall chart with a statistics rail but uses more lines on wide terminals. |
| Overflow: shrink chart rows / fall back to rows | Shrinking keeps the stacked view longer; fallback is simpler. |
| Path: tailnet + route / tailnet only / plus on-demand trace | Tailnet + route covers tailnet and LAN cases with local reads; tracing adds code and probes. |
| Path detail: compact / full | Full shows public endpoints in screenshots. |
| macOS route: allow `PF_ROUTE` / sysctl dump / Linux only | Allowing it needs a precise requirement wording; sysctl needs own prefix matching. |

## Decision

- Completion is dynamic (clap `unstable-dynamic`) and offers tailnet peers by
  MagicDNS short name only ("only low-hanging, high-signal sources").
- The stacked view uses the Sidecar layout from 111 columns, with narrower
  breakpoints below; when blocks do not fit the height, chart rows shrink
  before the view falls back to rows.
- The address line carries a compact path note: Tailscale transport for
  tailnet peers, outgoing interface and gateway for other hosts; endpoint and
  source address appear only in the hover tooltip.
- R02 forbids raw IP/ICMP sockets; local control sockets such as macOS
  `PF_ROUTE` are allowed.

## Consequences

- Sidecar uses more lines per host on wide terminals than Ribbon would, so
  many-host runs shrink the chart and reach the rows fallback sooner.
- pingping gains `clap_complete` and `serde_json`, added through the Buck2
  dependency path after the Buck2 port lands.
- Not now: ssh config, `/etc/hosts` and recent-target completion; traceroute.
