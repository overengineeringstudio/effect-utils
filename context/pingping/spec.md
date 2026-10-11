# pingping — Spec

This document specifies how pingping realizes its requirements. It builds on
[requirements.md](./requirements.md).

## Status

Active.

## Scope

Defines the CLI surface, the probe engine, the live view, and packaging.
Does not define generic CLI styling rules (the inline CLI conventions described in the spec) or
the repository Rust workspace policy.

## Architecture

```
               main thread                       one thread per host
 ┌──────────────────────────────────┐        ┌──────────────────────────┐
 │ cli (clap) -> spawn probes       │        │ resolve (getaddrinfo)    │
 │                                  │ mpsc   │ EchoSocket (ICMP DGRAM)  │
 │ live: keys + events -> HostState │<───────│ send every interval      │
 │       -> render::frame -> theme  │ events │ match replies by token   │
 │ plain: one line per event        │        │ expire after timeout     │
 └──────────────────────────────────┘        └──────────────────────────┘
```

Source lives in `packages/@overeng/pingping/src/`:

| Module | Role | Requirements |
| --- | --- | --- |
| `icmp.rs` | Echo packet codec and unprivileged socket | R02 |
| `probe.rs` | Per-host worker: resolve, send, match, expire | R03, R09 |
| `stats.rs` | Folds probe events into `HostState` | R05, R07 |
| `render.rs` | Pure layout into role-tagged spans | R05, R10–R12, R18 |
| `theme.rs` | Role -> color, background detection | R08 |
| `timeline.rs` | Zoom/pan view, bucketing, hover descriptions | R14, R15 |
| `live.rs` | Inline redraw loop, keys, mouse, hover hit-testing | R06, R11, R14, R15 |
| `path.rs` | Path note: Tailscale transport and local route | R19 |
| `completion.rs` | Dynamic shell completion, tailnet host candidates | R20 |
| `tailnet.rs` | Bounded LocalAPI / CLI status source shared by both features | R19, R20 |
| `main.rs` | CLI, plain output, exit status | R01, R04, R13 |
| `uptime.rs` | Tailnet-only background remote uptime | Live-view enrichment |

## CLI

```
pingping [OPTIONS] <HOST>...

  -c, --count <N>        stop after N probes per host
  -i, --interval <SECS>  seconds between probes per host     [default: 1]
  -W, --timeout <SECS>   seconds until a probe counts as lost [default: 2]
  -4 / -6                IPv4 / IPv6 only
      --layout <stacked|rows>                                [default: stacked]
      --theme <auto|light|dark>                              [default: auto]
```

Interactive input:

| Input | Effect |
| --- | --- |
| `l` | toggle stacked / rows |
| `s` | toggle statistics between visible window (default) and whole run |
| `[` / `]` | slower / faster for all hosts: 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60 s; `-i` stays free-form until stepping |
| wheel up / `+` / `↑` | zoom in (mouse: around the pointer; keys: window end) |
| wheel down / `-` / `↓` | zoom out |
| drag left button on chart, horizontal scroll, `←` / `→` | pan (chart drag right shows older samples) |
| pointer over a timeline or overview cell | tooltip with relative + absolute time |
| click / drag on a host's overview | grab the highlighted window without recentering; outside click centers; drag right moves newer, newest end resumes live; release ends drag |
| `0` / `End` | back to the live, unzoomed view |
| `q` / `Esc` / `Ctrl-C` | quit |

Arguments are validated before any probe starts: durations must be at least
0.01 s and representable as a deadline; host arguments must be nonempty and
free of control characters (they are echoed into the terminal). `-4` / `-6`
also reject IP literals of the other family.

Exit status follows R04.

### Shell completion (R20)

Completion is dynamic (clap_complete `unstable-dynamic`, as in axe; decision
0002). `main` activates `CompleteEnv` before parsing, with the binary name
taken from `argv[0]` (`pingping`). The package
installs the registration for all three shells at build time
(`installShellCompletion --cmd <name> --fish <(COMPLETE=fish $out/bin/<name>)`,
same for bash and zsh), so the script always matches the installed binary.

- Flags and `--layout` / `--theme` values come from the clap definition.
- `HOST` candidates are tailnet peers plus this machine from Tailscale's
  LocalAPI: the first label of each `DNSName` (MagicDNS short name, canonical;
  `HostName` can be stale), labelled `tailnet, online`, `tailnet, offline`,
  or `this machine` where the shell shows descriptions (fish, zsh). Online
  peers precede offline peers. The host source is skipped when the current
  token starts with `-`. Hosts already typed stay offered.
- The shared `tailnet.rs` source connects to
  `/var/run/tailscale/tailscaled.sock`, requesting
  `GET /localapi/v0/status?peers=true` over HTTP/1.0. Read/write deadlines
  total 100 ms and response size is capped at 4 MiB. Unexpected HTTP status,
  encoding, malformed JSON, or unreadable status yields no candidates.
  Only a missing socket falls back to `tailscale status --json`, with stdin
  and stderr closed, the same deadline and cap, and the child killed/reaped
  on timeout. Completion may use this fallback once per TAB.

## Probe engine

### Unprivileged ICMP (R02)

pingping opens `socket(AF_INET, SOCK_DGRAM, IPPROTO_ICMP)` (IPv6:
`IPPROTO_ICMPV6`). This needs no privilege on the supported hosts (A01) and
behaves differently per OS:

| Aspect | Linux | macOS |
| --- | --- | --- |
| Permission | gid in `net.ipv4.ping_group_range` (also governs IPv6) | always |
| Echo identifier | kernel replaces it with the socket port | kept as sent |
| Reply delivery | only to the sending socket | to every ICMP datagram socket |
| IPv4 receive buffer | ICMP message only | IPv4 header + ICMP message |
| IPv4 checksum | kernel | sender |

To work identically on both, pingping:

1. always computes the IPv4 checksum (ICMPv6 checksums are always the
   kernel's);
2. strips an IPv4 header when the first nibble of a received datagram is 4;
3. writes a random 64-bit token into bytes 0–7 of the 56-byte payload and
   accepts only replies that echo the token, the expected source address,
   and a pending sequence number. The identifier is not used for matching.

`EACCES`/`EPERM` on socket creation maps to a CRITICAL message with the Linux
fix `sudo sysctl -w net.ipv4.ping_group_range="0 2147483647"` and exit 2 (T01).
Any other socket creation error (for example `EAFNOSUPPORT`) is also a setup
error: a CRITICAL message naming the host and exit 2 (R04). A resolution
failure is not a setup error; that host received nothing (exit 1).

### Address selection

An IP literal is used as is. A name resolves via the system resolver; `-4` /
`-6` restrict the family; by default the first IPv4 address wins, else the
first address. IPv4 preference avoids silent 100% loss for dual-stack names on
hosts without an IPv6 route.

### Worker loop (R09)

All hosts share one mutable send schedule, initially
`start + n · interval`, where `start` is taken once before the workers spawn.
A host starts at the first deadline after it resolves.

`[` / `]` select the next interval in the requested direction, without
changing the CLI's free-form initial interval. The shared schedule restarts
at `min(previous next deadline, now + new interval)`: the next send is in
the future, no later than the old next deadline, with later sends separated
by the new interval. All hosts are notified through their receive interrupt
sockets, so changing a long interval does not wait for its old deadline.
Repeated keys before the next send preserve that deadline and its ordinal.

Workers emit `Scheduled(slot, position, interval)` before each actual send;
`position` is its monotonic scheduled time since the run start. Reply/loss
events carry the same ordinal, matching outcomes even when replies arrive
out of order. Overdue deadlines are skipped rather than sent in a burst.
Pending probes preserve their original timeout across rate changes.
Workers block for a reply, a schedule change, shutdown, or the earliest
next-send/pending-expiry deadline; finishing a count waits only for pending
outcomes.

Each host has its own thread and socket; the main thread never blocks on
the network. Late replies for expired probes are ignored.

## State (`HostState`)

Statistics count completed probes only: `completed = received + lost`;
in-flight probes are excluded so Loss does not flicker. Avg is the mean RTT of
received replies. Every sample keeps its wall-clock send time (carried on
the probe event) and its scheduled monotonic time on the shared run axis.
Outcomes match scheduled probes by ordinal rather than arrival order. The
last 86,400 actual probes per host are retained, including pending probes;
the retained duration therefore shrinks at faster rates. Time coordinates
survive trimming. Empty time cells where no probe was due remain blank,
not loss/gap markers; due probes without an outcome retain gap rendering.

## Live view

### Inline redraw (R06)

The terminal is in raw mode with the cursor hidden. Each frame:

1. move the cursor up by the previous frame height;
2. write each line, clipped to `width - 1` cells so no line wraps, followed by
   clear-to-end-of-line;
3. clear from the cursor down.

Frames are wrapped in synchronized-update sequences (DEC mode 2026) to avoid
flicker. A redraw happens on probe events, key presses and resize. On exit the
final frame is drawn without the key hint and stays in the scrollback.

Resize invalidates row diffs. Before the first width decrease, the UI queries
the cursor while its input reader is parked and accounts for the previous
lines reflowing at the new width, including wide-character wrap boundaries.
Queued resize bursts settle for 16 ms, preserve intervening input, and remember
intermediate width decreases even when the window grows back before drawing.

On a width decrease, `clear_resized_screen` resets the **visible pane** and
redraws from its top. Subsequent resizes also reset the pane: growing can bring
old frame fragments back from scrollback. Ordinary updates remain row-diffed.
This is an explicit inline tradeoff: visible output above pingping disappears
on shrink, but terminal scrollback is never cleared (no CSI 3J), the alternate
screen is never entered, and the final frame remains in scrollback.

Ghostty 1.3.1 (GTK/OpenGL, Xvfb with Mesa software rendering) exposed the cursor
ambiguity hidden by tmux: with a 39-row, six-host frame below prior output,
shrinking 249→130 columns kept the cursor reply at row 67. Treating this as a
non-reflowing terminal retained origin row 28 and left duplicated identities
and partial charts above the current frame. A pane reset only on decrease
still left fragments after rapid shrink/grow bursts because Ghostty restored
displaced history rows. The GUI smoke covers width and height shrink, grow-back,
three rapid drag-like bursts, and the retained final frame.

Inline limitation: shrinking can displace old frame rows into scrollback before
SIGWINCH is handled. Those history rows cannot be selectively erased. Pingpong
keeps frames shorter than the terminal height and only clears visible content.

The whole-run summary includes the selected local network context (R23), e.g.
`… · fastest linux-host 0.07 ms · Ethernet 1 Gb/s` or
`… · Wi-Fi 5 GHz · −63 dBm · 390 Mb/s · Low Data Mode`. Network facts use
the muted label role; enabled cost flags use the amber value role. At narrow
widths the summary omits fastest/loss and, if necessary, sent/rate fields
before clipping the network context; it does not add a line.
The muted egress organization (R24), when known, follows the local context.

### Stacked block (R05, R10, R14, R18)

```
│ Host      google.com
│ Address   192.178.194.101       address in a pill (bg = pill_bg)
│    ⣿       ⣤                  newest sample on the right
│ ⣀⣀⣤⣿⣀⣀⣤⣀⣀⣀⣤⣀⣀⣀⣀⣀⣀⣀⣀⣀
│ ⣀⣤⣀⣀⣤⣀⣿⣀⣀⣀⣀⣤⣀⣀⣤⣀⣀⣀⣀⣀   minimap: whole retained run
│ Current   42.4 ms
│ Min       31.0 ms
│ Avg       64.1 ms
│ Max       250 ms
│ Received  229 of 230
│ Loss      0%
```

- Labels are 10 cells wide; the pill's leading space sits in the label gutter
  so the address aligns with the other values.
- History: one run-start interval per terminal column at level 0, newest on
  the right. Dotted Braille vertical stems provide two
  horizontal time subcells per terminal character and four vertical dots
  per chart row. Heights are linear between the fastest and slowest visible
  reply, with a span of at least half the fastest RTT. Each reply starts
  with one bottom dot; additional dots are floored directly from its RTT
  ratio across the chart's actual height, not expanded from eight levels.
  Each terminal column uses the RTT band of its worst subcell reply across
  all rows of the stem. The baseline is the host's median of completed
  replies in retained history, excluding lost probes, independent of the
  visible window and statistics scope. Below 20 ms, replies never receive
  warning colors. Otherwise, with at least 10 replies, RTT at or below
  1.5 times the median uses `spark`, at or below 3 times uses amber
  (`RttElevated`), and above 3 times uses orange (`RttHigh`). Absolute floors
  apply regardless of the median: at least 150 ms is at least amber, and
  at least 300 ms is orange. With fewer than 10 replies, only these floors
  apply. Amber and orange bands color every stem in the column, including
  the lowest stems. Only when the band is `spark` do lowest stems keep the
  faint baseline color; higher stems use `spark`.
  Red remains reserved for failed pings.
  Losses use the chosen C encoding: fixed red (`bad`) Braille bottom dots
  on the existing bottom row (R07), `⡀` for the left time half, `⢀` for
  the right, and `⣀` for both. Their fixed one-dot height carries no RTT;
  losses never form variable-height stems or add a row. Successful RTT
  stems retain their glyphs and heights. A terminal glyph has one foreground,
  so successful dots take priority on a mixed bottom row: omit the red loss
  dot rather than recoloring or replacing successful dots, including in a
  one-row chart. Tooltips and statistics still retain every loss, including
  omitted dots. Pending deadlines and unscheduled space stay blank.
- Durations: `< 1 ms` two decimals, `< 100 ms` one decimal, else integer.
- Loss color: `good` at 0 lost, `value` below 5%, else `bad`.
- Statistics describe completed outcomes in the visible chart window by
  default (R14); `s` switches all fields to the whole run. Current is the
  newest visible outcome's RTT (or `-` for a loss), including while paused.
  Avg/Min/Max cover replies; Received and Loss cover all completed outcomes
  in that window. The summary line remains whole-run. The final frame kept
  in scrollback always shows whole-run statistics, without a scope hint.

#### Responsive widths (R18)

Breakpoints use terminal columns (the frame is one column narrower so no line
wraps). The shape is recomputed on every frame, so a resize re-lays out.

| Columns | Host block shape (plus one shared time-axis line after all blocks) | Lines per host |
| --- | --- | --- |
| < 61 | reference block above, with a 2-row chart and minimap | 11 |
| 61–90 | Host and Address lines, 2-row chart, minimap, statistics 3 rows × 2 | 8 |
| 91–110 | identity line (bold host, address pill), 2-row chart, minimap, statistics 2 rows × 3 | 6 |
| ≥ 111 | identity line, 3-row chart with paired statistics rail beside it, minimap | 5 |

```
│ host-a   192.0.2.10                                         tailnet direct
│        ⣀      ⣿      ⣤                              │ Current  16.1 ms   Avg   16.4 ms
│  ⣀   ⣀ ⣿  ⣤ ⣤ ⣿⣤ ⣀⣀⣤ ⣿ ⣀                            │ Min      14.9 ms   Max   31.0 ms
│  ⣿⣿⣿⣶⣿⣿⣿⣶⣿⣿⣿⣿⣿⣿⣿⣿⣶⣿⣶                            │ Received 21 of 21  Loss  0%
```

- The chart is as tall as the rail (decision 0003). The rail pairs the
  statistics as Current/Avg, Min/Max, Received/Loss; labels and cells are
  padded per column so values line up. The rail is as wide as its longest
  row (at least 28 columns); the chart takes the rest. A multi-row chart
  maps the same per-host scale directly across its four dots per row,
  forming dotted stems from the bottom up; losses use the fixed red Braille
  bottom dots, with successful stems taking priority as described under History.
  Every chart row is a timeline line for hit-testing;
  the hovered terminal column is tinted on all rows.
- Shrink (R12): when the frame is taller than the terminal, chart rows shrink
  uniformly from 3 (or 2) toward 1; the rail packs its six fields, in the
  same order, into that many rows (all six on one line at 1 row). Height
  planning includes the shared time axis; only when 1 row plus the axis does
  not fit does the view fall back to rows.
- The right end of the address or identity line holds the path note (R19),
  replaced by the drop indicator while a host is down (R25).

Several hosts are separated by a blank line. Every run, including one host,
has a whole-run summary line:
`3 hosts · every 1s · 690 sent · 0% loss · fastest host-a 3.1 ms · pingping 0.1.0+c67c405`
(fastest by Avg), plus the dim key hint while running. The muted final
`· pingping <machineVersion>` shares the CLI's resolved build identity, including
the dirty marker, and is dropped as a whole before any other summary field
when it does not fit. This compact form follows the shared
repository build-version conventions.

### Rows (R11, R12, R14)

```
  Host        Address                            Current      Avg      Max   Loss
│ google.com  192.178.194.101  ⣀⣤⣀⣿⣀⣤           42.4 ms  64.1 ms   250 ms     0%
│ 1.1.1.1     1.1.1.1          ⣀⣀⣀⣀⡀⣀            8.2 ms   8.9 ms    14 ms     0%
```

The Current, Avg, Max and Loss columns follow the same window/run scope as
stacked statistics, including paused Current and whole-run final frames.

Stacked falls back to rows when even 1-row charts plus the shared time axis
do not fit the terminal height (see Shrink); the key hint then reads
`l layout (terminal too short for stacked)`.
If even rows do not fit, the frame is cut to `height - 1` lines and ends with
`+ N more lines (enlarge terminal)`, so a redraw never scrolls (R12).

### Time axis

After the last host block, one muted `label`-role line spans exactly the
minimap columns, before the blank line and summary:

```
│ 12m03s ago             ├── 2m01s ──┤             now
```

The scale is the minimap's continuous real-time range: oldest retained
sample at the left, exclusive newest endpoint at the right, including
while paused. Labels and `now` span the full chart width; there is no
rounded-zoom blank trailing gap. The bracket occupies the last host's
shared overview grid cells inside the visible window, with the window duration
centered inside. Tiny windows use at least `├┤`; when the duration does not
fit inside, it follows the bracket or precedes it near the right edge.
Edge labels are dropped before they overlap the bracket or duration.
Panning moves the bracket, not the scale; the key hint retains paused status.
Durations use compact spans, including milliseconds below one second.
Rows have no minimap and retain their prior axis: observed duration at left,
centered `◂ … shown ▸`, and `now` or paused age at right, dropping observed,
arrows, then window text at narrow widths. Rows align with chart columns.
The axis is omitted before the first sample, is not a hover hit area, and
remains in the final scrollback frame. Its line is included in shrink,
fallback, and rows truncation height accounting (R12).

### Timeline zoom and pan (R14)

One `View` is shared by all hosts, so stacked timelines stay time-aligned:

```rust
struct View {
    level: i32,       // run-start interval units per cell = 2^(level / 4); -24..=256
    end: Option<f64>, // exclusive real-time window end in initial-interval units
}
```

- One zoom step (wheel tick, `+`/`-`, `↑`/`↓`) scales by 2^(1/4) ≈ 1.19.
  Level 0 is one **run-start interval** per cell, fixed for the entire run;
  changing the rate never rescales old history. This keeps constant-rate
  runs' existing geometry. Zoom starts at 1/64 initial interval per cell;
  its upper bound supports the whole retained time extent even after extreme
  initial/running-rate ratios. Normal zoom-out stops at fit.
- Zoom-in always works, including for short histories. Zoom-out stops when
  the retained time extent fits at level 0 or coarser.
- Absolute terminal column `c` covers real time `[c·k, (c+1)·k)` in
  initial-interval units. Its two raster subcells split that range in half;
  each stem retains its subcell's slowest reply. Subdivision does not
  change the visible time span, axis, window statistics, or input geometry.
  Finer zoom preserves the original sample-across-cells behavior. Losses
  use fixed bottom-row red Braille dots in their left/right time halves;
  mixed bottom rows preserve successful stems and omit colliding red dots
  as described under History. Pending or unscheduled subcells are blank.
  Dense/sparse rate segments contribute more/fewer probes to the same
  fixed time span without false gaps.
- A live view stays live while zooming (right edge on the newest sample) and
  keeps its zoom as samples arrive, so it pans automatically; zoom-out is
  manual ([decision 0001](./.decisions/0001-live-timeline-follows-with-per-host-overview.md)).
  A paused view keeps the time under the pointer (keys: the right edge) fixed
  and stays fixed in time while samples arrive.
- Hovering any chart or minimap cell temporarily freezes a live display at
  its current exclusive endpoint. This is separate from the user's zoom/pan
  state: probing and statistics continue, and the summary keeps updating.
  Leaving the charts/minimaps, a key press, a click, or horizontal wheel pan
  removes the temporary freeze before applying that action. Grabbing the
  highlighted overview window keeps its displayed endpoint and explicitly
  pauses it; other actions resume live first.
  Vertical wheel zoom over a frozen cell preserves the freeze and anchors
  around the pointer; leaving afterward retains the chosen zoom. A view
  already paused by the user is never frozen or resumed by hover.
- Pan moves `end` by cells × `k`. It cannot go before the oldest full
  window; reaching the newest sample resumes following.
- Mouse capture (`?1000/1002/1003/1006h` via crossterm) is enabled after the
  background query and disabled on every exit path. While pingping runs, the
  wheel goes to pingping, not to the terminal scrollback, and text selection
  needs the terminal's selection modifier (often Shift).
- Hint line under the summary, always while running:
  `l layout · s stats: window · [ ] rate · scroll zoom · drag pan · 0 live · q quit`,
  or when zoomed/paused includes `1 cell = 4.8s · 2m10s ago`.
  Cell duration is the run-start interval × `2^(level/4)`; the summary rate
  is the current interval. Toggling `s` changes the scope label to
  `s stats: run` without changing zoom or pan.
- Window statistics aggregate completed probes whose scheduled times fall
  within `timeline::window`, across any number of rate changes. Each host's
  128-probe summary cache holds RTT totals, extrema, received/lost counts
  and the newest outcome, with direct scans only for boundary fragments.
  Whole-run counters stay independent of retained history.
  The sidecar reserves run-wide value widths, so a scope toggle cannot move
  the chart or rail.

### Overview (R16)

```
│ ⣀⣀⣤⣀⣀⣀⣀⣀⣀⣤⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣤⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀   timeline: visible window
│ ⣀⣤⣀⣀⣤⣀⣿⣀⣀⣀⣀⣤⣀⣀⣤⣀⣀⣀⣀⣀⣀⣀⣤⣀⣀⣀⣤⣀⣀⣀⣀⣀⣀   overview: whole run; outside the window dim
│ Current   42.4 ms
```

- Always shown per host under the stacked chart at every breakpoint; rows
  have no minimap. The line is reserved even before the first sample (rule
  only), and included unconditionally in shrink/fallback height planning.
  Zooming and panning therefore never add or remove a row. When nothing is
  hidden, every minimap cell is window-tinted, including blank cells with no
  due probe; occupied cells without loss use the `label` color.
- The overview fills the full timeline width using a continuous real-time
  scale, independent of the main chart's discrete zoom levels:
  `cell_duration = (newest_endpoint - oldest_retained) / minimap_width`.
  Terminal column `i` covers `[oldest + i*d, oldest + (i+1)*d)`; the last
  column ends at the exact newest endpoint. Its two Braille stems divide
  that range in half without changing the physical minimap width.
  Even short runs fill the width; a subcell with no due probe stays blank
  rather than repeating a reply. A frozen hover keeps this scale and its
  buckets stable while probing continues. Buckets use the existing indexed
  time-range summaries with one advancing scan:
  O(width + range / summary-block-size), not a scan of all history per cell.
  The minimap recedes behind the chart: window cells use the `label` color
  on a stronger light/dark `window_bg` tint, cells outside the window the
  fainter `Faint` color. A terminal column uses muted red only when its two halves combined have
  completed samples and `lost * 2 >= samples`: `MinimapLoss` blends `Label` toward `Bad` inside the
  window, and `MinimapLossFaint` blends `Faint` toward `Bad` outside it.
  Losses keep the same fixed-height left/right Braille bottom-dot shapes
  and successful-stem priority as the chart. Glyph shapes are unchanged;
  the muted-red foreground identifies loss even when successful dots hide
  its marker. A glyph below that majority threshold remains muted without
  loss color; an empty glyph never triggers loss color. Both halves' completed
  replies and losses are summed, not evaluated independently or by RTT
  presence (decision 0003, Amendment 2). Other cells stay muted, with no RTT warning bands.
  Tooltip and statistics retain omitted losses.
  The time-axis bracket marks these same window cells, without chart color.
- Input: pressing the left button inside the overview's highlighted window
  grabs it without recentering, preserving the pointer's offset within the
  window. Pressing outside that highlight centers the window on the cell's
  real-time midpoint and pauses. While held, dragging moves the window from its
  grabbed position by the column delta times the mouse-down overview cell
  duration (drag right = newer, left = older), even across rows or redraws.
  Movement clamps at the oldest full window; a window end at or past the newest
  sample resumes live. Releasing the button ends the drag, so subsequent pointer
  motion cannot pan. Hover shows the bucket's description.
- Hit-testing: the frame reports `(line, host, kind)` for timeline and
  overview lines.

### Hover (R15)

```
│ linux-host   192.0.2.12                 3s ago · 08:41:12 · 0.23 ms
│ ⣤⣤⣀⣀⣤⣀⣿⣀⣀⣀⣤⣤⣀⣤⣀⣀⣀
```

- Hover identifies a physical terminal column, not a half-character
  pointer position. Its description aggregates the whole column's time
  range once, including both raster subcells, without double-counting
  replies expanded across them. The column keeps its glyph and color and
  gets a faint background tint (`hover_bg`), so stems stay readable (R17).
  At every breakpoint the tooltip replaces the hovered host's path or drop
  note on its identity/address line. It follows the pointer column
  horizontally, clamped after the fixed identity with at least two spaces
  of gap and inside the terminal's right edge. Path-note readouts retain
  right alignment. Readouts that do not fit are Unicode-cell truncated
  from the right and never wrap. Chart, minimap, and path-note hover all
  use that line with the muted `Tooltip` pill role. No hover adds a row or
  moves another host's timeline. The reference layout below 61 columns
  uses its Address row with the same placement and truncation rule. Rows
  keep `<host>: <description>` on the existing hint row after its fixed
  key-hint and freeze-status spans; those spans constrain horizontal
  placement, and the footer location still limits vertical proximity.
- Description: `<relative> · <absolute> · <value>`. Relative is `now` below
  1 s, else the span (`12s`, `2m10s`, `24h02m`) plus `ago`. Absolute is local
  `HH:MM:SS`, prefixed with `Mon DD` when not today. Value is the RTT or
  `lost`; for a bucket of several samples, `max <rtt>` and `· N lost`. The
  time is the bucket's first send time.
- On entering a live chart/minimap cell, both the displayed endpoint and the
  readout clock are captured. The minimap grid also retains that observed
  extent, so its hovered bucket does not slide or rescale underneath the
  pointer. The tooltip's relative/absolute text remains stable while new
  probes arrive; pending outcomes can still settle. Path-note hover does not
  freeze. Moving between cells keeps the original freeze until the pointer
  leaves the charts/minimaps. The key hint replaces `0 live` with
  `hover paused`; the axis right end shows the paused `… ago` age.
- Hit-testing: mouse rows are screen rows, so after any draw that changes the
  frame height (the terminal may scroll) or after a resize, pingping asks for
  the cursor position (`ESC[6n`) and stores the frame's top row. The frame
  reports `(line, host)` for every timeline line and the timeline's column
  range. Motion events (`?1003h`) update the pointer; a redraw happens only
  when the hovered cell changes. A terminal that does not answer the position
  query disables hover only.

### Drop indicator (R25)

- After the last three completed probes are all lost, the address/identity
  line shows `no reply for 2m10s`, right-aligned in the `bad` role instead
  of the path note. A host that never replied shows `no reply yet`.
  Pending probes neither trigger nor interrupt the completed-loss streak.
- The age is since reply arrival (send time plus RTT), formatted with the
  tooltip's compact duration formatter. It updates on the existing probe
  cadence, with no extra wakeups. One successful reply clears the indicator.
- Every stacked breakpoint, including the narrow reference layout, uses the
  Address/identity line. The notice is omitted when it would collide with
  the address. A hovered readout takes precedence on that line.
- Rows show `down 2m10s` (or `no reply yet`) in Current instead of the stale
  RTT; the column budget includes the compact readout so it never wraps.
  Plain probe output is unchanged.

### Uptime

The live TTY view always enables remote uptime enrichment for known tailnet
peers, without an opt-in flag. It shows elapsed time since the remote machine
booted in compact relative form, such as `up 14d22h`, not an absolute boot
timestamp or time since this invocation started. Pan, zoom and statistics
scope do not alter this field. Plain output is unchanged.

A TTY-only background worker classifies targets using the shared Tailscale
status source and selects the peer's canonical DNS name rather than treating
arbitrary input as an SSH destination. It reads uptime at startup and at most
once per ten minutes per peer, never attempts SSH to arbitrary internet or
LAN targets, and never blocks ICMP workers or rendering.

SSH is noninteractive: stdin is closed, `BatchMode=yes`,
`IdentityAgent=none`, a three-second connection timeout and an eight-second
total child deadline. It uses existing noninteractive credentials and host
trust, never prompts or automatically enrolls unknown host keys. Linux reads
`/proc/uptime`; macOS reads `sysctl -n kern.boottime`. Output is bounded to
4 KiB. Timed-out children are killed and reaped. Failed, unavailable or
unreadable uptime uses an explicit unavailable placeholder, not a fabricated
value; unknown tailnet classification is ineligible. Updates wake the existing
UI notification mechanism.

### Path note (R19)

```
│ host-a   192.0.2.10                    tailnet direct
│ host-b   192.0.2.11                      tailnet DERP nue
│ 1.1.1.1   1.1.1.1                       via enp3s0 → 192.0.2.1
│ 192.0.2.1   192.0.2.1               on-link enp3s0
```

- Tailnet peers (the resolved address equals a peer's Tailscale IP): one
  shared LocalAPI status read every 3 s, with the completion bounds. The
  monitor reads status once to classify resolved addresses; subsequent
  status refreshes run only while a displayed host is a tailnet peer.
  A missing socket uses the bounded CLI fallback at most once per 30 s,
  never every 3 s. Only the required status fields are decoded. Following
  Tailscale's precedence for an active peer: nonempty `CurAddr` means
  `tailnet direct`, else nonempty `PeerRelay` means `tailnet peer relay`, else
  nonempty `Relay` means `tailnet DERP <region>`. An idle peer shows
  `tailnet idle`; an unreadable status shows nothing.
- Other hosts: the route for the resolved address, looked up at start and
  every 10 s (Linux: `RTM_GETROUTE` over netlink; macOS: `RTM_GET` over a
  `PF_ROUTE` socket, allowed by R02). Text: `via <ifname> → <gateway>`, or
  `on-link <ifname>` without a gateway or when the gateway is the
  destination itself (a macOS host route such as loopback).
  Both kernel queries use safe `nix` socket APIs and bounded reads; they
  never spawn a route command. The cfg-gated macOS implementation uses the
  native `rt_msghdr` layout without unsafe casts; it is unverified here:
  `cargo check --target aarch64-apple-darwin` cannot find that target's
  standard library in the pinned Linux toolchain.
- Compact (decision 0002): the direct endpoint (`ip:port`) and the source
  address appear only in the hover tooltip over the note.
- A change (e.g. DERP → direct) shows `(was <old>, <age> ago)` after the note
  for 30 s, and the sample slot where it was seen gets a `path_change`
  background tint on the timeline; hovering that cell names the change.
  Changes use the mutable shared probe schedule's slots, with the latest
  transition per slot, and expire only when their probes leave the retained
  86,400-probe history; runtime rate changes and skipped deadlines do not
  shorten retention. The 30 s expiry is a single UI deadline, not a tick.
- The note is muted (the path-note semantic role uses the `label` palette),
  right-aligned on the identity/address line at every stacked breakpoint,
  and dropped when it would come closer than 3 cells to the address.
  Rows omit it rather than displace the chart/statistics. Plain output prints
  it once per host after `resolved to`.
- One shared background monitor owns tailnet and route deadlines, removing
  finished hosts and waking the existing UI notification socket only when
  a note or its hover details change. Plain output performs one lookup only.
- `path_change` background: light `#f2e2c5`, dark `#4d402a`; a hovered
  timeline cell uses the existing hover tint while its tooltip names the
  transport change.

### Theme (R08)

| Role | Light | Dark | Used for |
| --- | --- | --- | --- |
| rule | `#b4b9c7` | `#3e444f` | left vertical rule |
| label | `#a3a7b0` | `#707886` | labels, dim text |
| host | bold, terminal fg | bold, terminal fg | host name |
| pill | `#555a66` on `#e7e9ef` | `#c6ccd8` on `#2b303a` | address |
| spark | `#5d6b8a` | `#8a9bc4` | RTT history |
| value | `#b8844a` | `#e0a86a` | statistics |
| good / bad | `#5e9a66` / `#cf5248` | `#86c086` / `#f0746a` | loss, lost marks |

Light colors are sampled from the reference and corrected for its JPEG
contrast loss. With `--theme auto`, pingping opens `/dev/tty` nonblocking,
sends OSC 11 (background query), and waits with `select` (macOS `poll` does
not work on `/dev/tty`) against one 300 ms deadline, reading one byte at a
time until BEL or ST. It skips the query when input is already queued and
aborts on a non-OSC prefix. Dark below 0.5 relative luminance; no answer means
dark. No reader thread outlives the query.
Colors are 24-bit when `COLORTERM` is `truecolor`/`24bit`, else the nearest
xterm-256 color. `NO_COLOR` disables colors (crossterm honors it); bold and
layout are unchanged.

## Resource use (R21)

- Workers wait for the next send or the earliest pending timeout, whichever
  comes first, or for a reply; they never poll on a fixed tick. Workers wake
  the UI through a notification socket.
- The UI thread blocks until a probe event or input arrives. A reader thread
  blocks in crossterm `event::read()` and hands over one event at a time. The
  main thread owns the cursor-position query: it runs once before the reader
  starts and again after a resize while the reader is parked; ordinary frame
  growth derives the new top row from the frame and window height.
- Redraws are coalesced to at most one frame per 16 ms; an identical frame is
  not written, and only changed rows are rewritten.
- History is a fixed 86,400-probe ring per host, with 128-probe range
  summaries so zoomed-out and overview buckets do not rescan the ring.
  Plain output keeps no history.

Budgets, measured in a 200×40 PTY at 1 s interval (linux-host, 2026-10-03):

| Scenario | Budget | Measured |
| --- | --- | --- |
| 5 hosts, live | < 0.5% of one core, < 30 wakeups/s | 0.07–0.08%, 14–15/s |
| 20 hosts, live | < 1% of one core, < 80 wakeups/s | 0.17%, 44/s |
| 5 hosts, mouse motion every 50 ms | < 2% of one core, < 64 KiB/s to the terminal | 0.59%, 42 KiB/s |
| 5 hosts, plain | < 0.05% of one core, memory independent of run time | 0.02%, 3.5 MiB |
| 5 hosts, full 24 h history | < 24 MiB RSS, < 1 ms per frame | 22.4 MiB, 0.14–0.96 ms (R22 below) |

R19/R20 re-measurement (linux-host, 2026-10-04; same 200×40 PTY and five hosts:
`127.0.0.1`, `::1`, `1.1.1.1`, `host-a`, `google.com`; two 30 s runs,
medians after 2 s warm-up):

| Scenario | HEAD `295de79f9d` | Built package with path notes |
| --- | --- | --- |
| 5 hosts, live | 0.067% CPU, 13.73 wakeups/s, 4,118 KiB RSS | 0.067% CPU, 15.53 wakeups/s, 4,456 KiB RSS |
| 5 hosts, plain | 0.017% CPU, 12.80 wakeups/s, 3,424 KiB RSS | < 0.033% measurement resolution, 12.85 wakeups/s, 3,798 KiB RSS |

Live stays within the < 0.5% CPU / < 30 wakeups/s budget. The LocalAPI
adds no subprocess; live has one additional deadline-driven monitor thread,
plain has none. No new 20-host/mouse/full-history measurements are claimed.

R22 re-measurement (linux-host, 2026-10-04, release ignored full-history benchmark,
five hosts × 86,400 probes at 1 s, 200×40 frame, 200 frames/layout, `nice -n 19`;
maximum RSS measured with GNU `time -v` after touching a complete ring cycle):

| Metric | Before (`7415f01e41`) | Runtime rate / real-time axis |
| --- | --- | --- |
| Five-host maximum RSS | 15,984 KiB | 22,912 KiB |
| Retained allocation per host | 2,862,458 B | 4,244,922 B |
| Rows frame | 0.045 ms | 0.140 ms |
| Stacked live frame | 0.355 ms | 0.964 ms |
| Fit-all frame | 0.316 ms | 0.866 ms |
| Stacked overview frame | 0.319 ms | 0.929 ms |

The compact placement/outcome rings use 48 bytes per retained probe, plus
128-probe summaries. The new benchmark includes actual `Scheduled` events,
not only outcomes. Both RSS and every measured layout remain within R21.

R23 re-measurement (linux-host, 2026-10-04; simultaneous release binaries before
and after, 200×40 PTYs, same five hosts as R19/R20, 1 s interval, 5 s warm-up
and 30 s measured):

| Metric | Before R23 (`cfcb33126c`) | Local network context |
| --- | --- | --- |
| One-core CPU | 0.100% | 0.100% |
| Wakeups/s (all-thread context-switch proxy) | 17.2 | 17.7 |
| RSS | 3,632 KiB | 3,716 KiB |
| Rust/process threads | 8 | 8 |
| Terminal output | 8.0 KiB/s | 9.0 KiB/s |

The live five-host run remains below 0.5% CPU and 30 wakeups/s. The proxy
includes involuntary context switches and is not a hardware wakeup counter.
No new mouse/full-history/20-host measurements are claimed for R23.

Reference: system `ping -i 1` uses about 1 wakeup/s and 2.8 MiB per host.
The ignored test `render::bench::benchmark_full_history` reproduces the
frame-time and memory numbers.

## Local network (R23)

`src/netinfo.rs` owns the selected-link snapshot and formatting. The summary
uses the common outgoing interface of non-tailnet host routes, joined by BSD
interface name to native metadata. If those routes use different interfaces,
it uses the OS primary interface rather than claiming one medium describes
every host. A tailnet-only run also uses the OS primary underlay. This is
one run-wide context, separate from the per-host path notes; it does not infer
an exit node, a VPN provider, or a tunnel's physical underlay.

- Ethernet shows a positive negotiated link speed when available; this is
  not measured Internet throughput. iPhone USB is identified by Linux's
  `ipheth` driver or macOS's OS hardware label, not an SSID heuristic.
  Unrecognized localized USB labels retain their OS metadata but are not
  guessed to be an iPhone.
- Wi-Fi shows known band, RSSI and transmit link rate, without SSID/BSSID,
  scans, Location prompts, or configuration changes. Zero/error values and
  unknown fields are omitted. Metrics are sampled at most once per 10 s and
  only while the selected link is Wi-Fi.
- Low Data Mode, expensive and metered are shown only when reported on.
  Expensive is an OS policy, not proof of a particular bill or carrier;
  macOS exposes expensive and constrained but no independent metered bit.
  NetworkManager is absent on the measured Linux environment, so metered remains
  unknown and is omitted rather than inferred from Wi-Fi/USB.
- Linux's safe sysfs/rtnetlink/nl80211 adapter shares the existing 10 s route
  refresh cadence. The primary hint is the lowest-metric usable main-table
  default route, IPv4 first with IPv6 fallback; destination route lookup
  remains authoritative for ordinary host selection.
- The macOS boundary crate caches native cost flags by interface, using
  type-restricted NWPath monitors and SCDynamicStore notifications. Ambiguous
  path attribution is unknown, never global flags attached to another link.
  The main monitor caches interface metadata until native changes or an
  interface switch; CoreWLAN has a separate throttled sampling deadline.
  Drop unregisters notifications, cancels each path monitor, waits for its
  cancellation completion, drains its serial queue, and releases owned CF,
  Network and dispatch resources. No monitoring thread or process is leaked.
  SCDynamicStore owns an independent strong callback-state reference through
  its context retain/release hooks. Queue draining orders callbacks; it is not
  a native quiescence guarantee, and context lifetime does not depend on it.
  The read-only `SIOCGIFXMEDIA` request preserves extended Ethernet subtypes
  (e.g. 25G/40G) that legacy `SIOCGIFMEDIA` rewrites to an unknown media type.

Plain mode prints the selected context once after initial host resolution,
before normal probe output in the usual successful startup:
`network: Ethernet 1 Gb/s (en7)`. No periodic subprocesses are used on either
platform.

## Egress network (R24)

Enabled by default (Q27), this identifies the public **IPv4 egress network**,
not necessarily the physical or retail ISP, and not the route of every ping
target. IPv6-only connectivity leaves the field absent. The summary appends
the muted organization, e.g. `… · Ethernet 1 Gb/s · Example Network`.
When Tailscale LocalAPI status reports `ExitNodeStatus`, append ` (exit node)`.
The public address is never displayed or retained in the result.

`src/egress.rs` performs one background lookup at startup and repeats only
when the selected local network context changes. It adds no polling deadline
or recurring idle work. Each chain uses connected UDP to `1.1.1.1:53`:
`whoami.cloudflare` TXT/CH discovers IPv4, the reversed address under
`origin.asn.cymru.com` TXT/IN supplies the ASN, and `AS<n>.asn.cymru.com`
TXT/IN supplies its AS description. The chain has a one-second total DNS
deadline, bounded packets, random transaction IDs and matching questions.
Truncated, malformed, unsuccessful or unavailable responses add no field.
Rendering never waits for DNS. Network changes immediately clear the cached
name; generation ordering rejects late results from the old network.

Descriptions matching `PREFIX - Organization, CC` show only the organization;
otherwise the raw description is used. Control characters are stripped and
text is capped at 96 characters before rendering. No brand database is used.
Plain mode prints `egress: Example Network (AS64500)` once if known during
the run, and never delays completion for this optional result.

Privacy: Cloudflare and Team Cymru learn the public IP through these queries.
Direct plain DNS bypasses the configured resolver and is unauthenticated;
the label is informational, not security evidence. VPNs, exit nodes, CGNAT,
corporate routing and split tunnels can identify an upstream egress rather
than the user's access provider. There is no periodic public-address refresh;
changes without a local network-context event can remain undetected.

R21 paired idle measurement (linux-host, 2026-10-04; release binaries, five hosts
`127.0.0.1`, `::1`, `1.1.1.1`, `host-a`, `google.com`; 200×40 PTYs, 1 s
interval, 5 s warm-up, 30 s measurement, adapted `/tmp/pingping/perf/mine.py`):
before R24 (`8ede58b5fd`) versus R24: CPU 0.133% / 0.100%, all-thread
context-switch proxy 16.2 / 17.2 per second, 8 / 8 idle threads, RSS
4748 / 5084 KiB, terminal writes 14.6 / 14.4 KiB/s. The small proxy variation
is not a hardware wakeup count; no recurring egress timer or thread remains
after the one-shot lookup, and the existing idle cadence is unchanged.

## Plain output (R13)

```
google.com resolved to 192.178.194.101
google.com seq=1 time=42.4 ms
google.com seq=2 lost
google.com: 229 of 230 received, 0% loss, min/avg/max 31.0 ms / 64.1 ms / 250 ms
```

When the reader closes the pipe (`pingping host | head`), pingping stops probing
and exits 0 without an error message.

## Packaging

- Cargo workspace in `packages/@overeng/pingping/`: the binary at
  `src/main.rs` and the target-gated `crates/netinfo-macos`
  (`pingping-netinfo-macos`). The binary forbids unsafe code; the macOS
  boundary crate is the reviewed exception described in decision 0004.
- Dependencies are declared by the Cargo manifests. CLI parsing uses `clap`,
  dynamic completion uses `clap_complete`, terminal input uses `crossterm`,
  ICMP uses `socket2`, and bounded native reads use `nix`. Tailscale JSON uses
  `serde` / `serde_json`; clipping uses `unicode-width`. Native macOS bindings
  are target-gated and are not compiled on Linux.
- Buck2 product: `//packages/@overeng/pingping:pingping-product`, declared
  through `BUCK.genie.ts` and the repository Rust dependency graph. The
  package is exported as `.#pingping`; the binary is installed as `pingping`,
  without a machine-specific alias or Home Manager installation requirement.
- Shell registrations for fish, zsh and bash are generated from the installed
  binary and installed with the package, so registrations and the dynamic
  completion protocol stay version-aligned.
