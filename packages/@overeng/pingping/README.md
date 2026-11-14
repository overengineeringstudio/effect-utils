# pingping

`pingping` probes several hosts concurrently and shows latency, loss and network
context in an inline terminal view. It uses unprivileged ICMP datagram sockets
on Linux and macOS: no setuid binary, file capabilities or system `ping` wrapper.

```bash
pingping example.com
pingping example.com 1.1.1.1 host-a
pingping -c 10 -i 0.5 --layout rows example.com
pingping -4 -c 3 example.com > probes.txt
```

`host-a` is a neutral example of a peer in your own tailnet, not a built-in host.
Without a TTY, output is one plain line per probe outcome; `--count` adds final
per-host statistics. Interactive output redraws below the prompt and leaves its
final frame in scrollback.

## CLI

```text
pingping [OPTIONS] <HOST>...

  -c, --count <N>                 stop after N probes per host
  -i, --interval <SECS>           probe interval [default: 1]
  -W, --timeout <SECS>            reply timeout [default: 2]
  -4 / -6                        IPv4 / IPv6 only
      --layout <stacked|rows>     [default: stacked]
      --theme <auto|light|dark>   [default: auto]
      --no-history               disable session history reads and writes
      --history-view <a|b|c>      prototype presentation [default: a]
```

Exit status is 0 when every host received at least one reply, 1 when any host
received none, and 2 for a setup error. If Linux refuses ICMP datagram sockets,
configure `net.ipv4.ping_group_range` for the user's group; pingping does not
fall back to a privileged implementation.

## Interactive View

| Input                                    | Effect                                                      |
| ---------------------------------------- | ----------------------------------------------------------- |
| `l`                                      | Toggle stacked / rows layout.                               |
| `s`                                      | Toggle visible-window / whole-run statistics.               |
| `[` / `]`                                | Slow down / speed up probing without rescaling old history. |
| Wheel, `+` / `-`, `↑` / `↓`              | Zoom the shared time window.                                |
| Chart drag, horizontal scroll, `←` / `→` | Pan history.                                                |
| Overview click / drag                    | Navigate the retained history; newest end resumes live.     |
| Pointer over a chart                     | Show send time and RTT/loss without obscuring stems.        |
| `0` / `End`                              | Return to the live, unzoomed view.                          |
| `q` / `Esc` / `Ctrl-C`                   | Quit.                                                       |

Stacked blocks adapt to terminal width and height, shrinking charts before
falling back to rows. Each stacked host has an always-present overview. The
live window follows newest probes at its chosen zoom. Hover temporarily freezes
the displayed window; probes continue in the background.

RTT stems use per-host median-relative warning bands with absolute latency
floors. Failed probes use red bottom dots; successful stems retain priority in
mixed cells. The overview stays muted: a glyph becomes muted red only when
its two time halves combined contain completed samples and at least half are
lost (`lost * 2 >= samples`). Tooltips and statistics retain all losses, even
when a successful stem hides a loss dot.

## History Bakeoff Prototype

Interactive sessions retain seven days of append-only, per-host/per-session JSONL
in `$XDG_STATE_HOME/pingping` (default `~/.local/state/pingping`, private directory
mode `0700`). Known tailnet peers use canonical DNS identity; other targets use
the typed name. Plain output never reads or writes history. `--no-history`
disables both. Statistics always describe the current session, not prior runs.

Compare `--history-view a` (compressed off gaps), `b` (dim prior sessions and a
session marker), and `c` (last-runs summary without old chart samples). These are
prototype presentations, not a stable storage or interaction contract.
The A/B history overview is a connected past-to-live strip above the unchanged
interactive live chart; only that detailed live chart supports hover/zoom/pan.
The overview fits recent sessions to the available width and scales each run
independently. History writes are not individually fsynced, so power loss can
discard the most recent records. Incomplete trailing records are ignored; a
malformed complete record produces an explicit startup error.

The hidden `--history-seed-demo` switch creates realistic synthetic runs in the
separate `pingping-demo` directory and uses that directory for the live session
too. Point `XDG_STATE_HOME` at a task scratch directory to isolate the whole
trial; for example, `XDG_STATE_HOME="$PWD/tmp/history-trial" pingping
--history-seed-demo --history-view a 127.0.0.1 host-a host-b`.

## Network Context And Uptime

Local route and Tailscale status provide compact path notes. The summary shows
available link medium, speed, Wi-Fi quality and enabled OS cost flags, omitting
unknown fields rather than guessing. Egress organization lookup uses Cloudflare
and Team Cymru DNS services; they learn the public IPv4 address through these
queries. The label is informational, not authenticated routing evidence. The
public address is not displayed or retained in the result.

Remote uptime is always enabled for known tailnet peers in the TTY view and
shown as elapsed time since remote boot, such as `up 14d22h`. A background worker
reads it at startup and at most every ten minutes. It uses the canonical peer
DNS name from Tailscale status, never arbitrary internet or LAN SSH targets.
SSH is noninteractive (`BatchMode=yes`, `IdentityAgent=none`, strict host-key
checking), with closed stdin, a three-second connection timeout, an eight-second
total deadline and bounded output. Advertised Tailscale SSH host keys are stored
in a private temporary known_hosts file for each read, followed by the user's
configured known_hosts files resolved locally with `ssh -G` once per worker.
Discovery uses the read's SSH options and remote command, and shares its deadline,
cancellation and bounded output handling.
The temporary file is removed after the read. If configuration resolution fails,
paths contain unsafe SSH syntax, or a non-default configured file is missing,
the read leaves SSH's own trust configuration unchanged.
SSH cannot prompt for passwords, agent approval or host-key enrollment and never
modifies the user's SSH files. Pending reads show `up –`; failed reads show dim
`up ?`, with a hover explanation (host key unknown, auth refused, timed out,
unreachable, or failed). ICMP and rendering never wait for SSH. Plain mode
performs no uptime SSH reads.

## Installation And Shell Completion

The repository exports the package as `.#pingping` and the Buck2 native product
as `//packages/@overeng/pingping:pingping-product`. Install the package through
your normal Nix profile or package configuration; no machine-specific Home
Manager module or short-name alias is required.

```bash
nix profile install .#pingping
```

The package installs dynamic completion registrations for fish, zsh and bash,
generated from the installed binary. Completion offers flags, enum values and
MagicDNS short names from the local Tailscale status source. It is bounded to
about 100 ms and returns no host candidates when that source is unavailable.
Shell configuration must enable its normal completion support.
Registration and callback commands both use the invocation's basename, preserving
adopter aliases without embedding absolute installation paths in shell scripts.

## Package Boundary

| Component                                                         | Responsibility                                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------------------- |
| `src/main.rs`                                                     | CLI, TTY/plain selection and exit status.                           |
| `src/icmp.rs`, `src/probe.rs`, `src/stats.rs`                     | Probe transport, scheduling and bounded history.                    |
| `src/render.rs`, `src/timeline.rs`, `src/live.rs`, `src/theme.rs` | Responsive inline view and interactions.                            |
| `src/path.rs`, `src/tailnet.rs`, `src/completion.rs`              | Local route, tailnet status and completion.                         |
| `src/netinfo.rs`, `src/egress.rs`, `src/uptime.rs`                | Network context and remote uptime enrichment.                       |
| `crates/netinfo-macos`                                            | Reviewed native macOS boundary; the main crate forbids unsafe code. |

The complete vision, requirements, specification, decisions and visual
reference live in [context/pingping](../../../context/pingping/spec.md).
