# pingping — Requirements

## Context

- Builds on [vision.md](./vision.md).
- Rust conventions: the package Cargo manifests.
- CLI output conventions: the inline CLI conventions described in the spec.

## Assumptions

- **A01 Unprivileged ICMP:** Every supported host allows unprivileged ICMP
  datagram sockets. NixOS hosts set `net.ipv4.ping_group_range = 0 2147483647`
  (checked on linux-host, 2026-10-02); macOS allows `SOCK_DGRAM` ICMP for every user.
- **A02 Modern terminal:** The interactive terminal supports ANSI cursor
  movement and 256 colors; truecolor is used when `COLORTERM` advertises it.

## Acceptable Tradeoffs

- **T01 No privileged fallback:** If the OS refuses unprivileged ICMP sockets,
  pingping exits with a fix hint instead of falling back to raw sockets, a
  setuid helper, or the system `ping`.
- **T02 Non-TTY summary on count only:** Without a TTY, the per-host summary is
  printed when `--count` completes; an interrupt (SIGINT) ends the output
  without a summary.

## Requirements

### Must be a drop-in for everyday `ping`

- **R01 Names:** The binary is `pingping`.
- **R02 Unprivileged:** pingping sends ICMP echo requests as a normal user on
  Linux and macOS, over IPv4 and IPv6, without setuid, file capabilities, or
  raw IP/ICMP sockets. Local control sockets (for example macOS `PF_ROUTE`)
  are allowed (decision 0002).
- **R03 Familiar flags:** `-c` (count), `-i` (interval), `-W` (reply timeout),
  `-4`, `-6` behave like their `ping` counterparts.
- **R04 Exit status:** Exit 0 when every host received at least one reply, 1
  when some host received none, 2 on a setup error (socket not permitted,
  terminal error).

### Must show latency at a glance

- **R05 Reference block:** On narrow terminals the live view shows for one
  host, in this order: Host, Address, a full-width RTT history, Current, Min,
  Avg, Max, Received (`N of M`), Loss — framed by a left vertical rule, styled
  as in the reference (muted labels, bold host, address in a subtle pill,
  amber values, green loss at 0%).
- **R18 Responsive layout:** Wider terminals use the horizontal space for the
  same information: statistics move beside or below a taller RTT chart
  (decision 0002). The layout adapts when the terminal is resized.
- **R06 Inline:** The live view redraws in place below the prompt; the final
  frame stays in the scrollback after exit (decision q1).
- **R07 Lost probes visible:** A lost probe is marked in the RTT history in a
  distinct color and counts toward Loss.
- **R08 Light and dark:** The palette follows the terminal background; it can
  be forced with a flag.

### Must handle many hosts

- **R09 Concurrent hosts:** Several hosts are probed concurrently; one slow or
  failing host does not delay others.
- **R10 Stacked by default:** With several hosts the view stacks one reference
  block per host plus a summary line (decision q2).
- **R11 Switchable layout:** A flag selects stacked or one-row-per-host
  layout, and a key toggles it while running (decision q2).
- **R12 Never scrolls:** If stacked blocks do not fit the terminal height,
  their charts get shorter first; if they still do not fit, the view switches
  to rows and says so.

### Must let the history be explored

- **R14 Zoom and pan:** While the live view runs, the RTT history can be
  zoomed (mouse wheel, keys) and panned (mouse drag, keys) to inspect older
  samples. All hosts share one time axis. Zooming out keeps spikes and losses
  visible. The live view keeps its zoom level and follows the newest sample;
  zooming out is always manual. A paused view says how far it is behind now
  and how to return to live. The statistics describe the visible window by
  default; a key switches them to the whole run, and the view names the
  active scope (decision Q20, 2026-10-04).
- **R15 Hover details:** Pointing at a timeline cell shows a short relative
  and absolute send time for it (and its RTT or loss) next to the pointer.
  While the pointer is over a timeline cell, a live view stops sliding so the
  hovered cell stays in place; it resumes when the pointer leaves
  (the user, 2026-10-04).

- **R16 Navigable overview:** In the stacked layout, a one-line overview of
  each host's whole run sits under its timeline at all times and marks the
  window, so zooming never changes the layout (the user, 2026-10-04).
  Clicking the overview moves the window there; dragging it moves the
  window; reaching the newest end resumes the live view.
- **R17 Unobtrusive hover marker:** The hover marker is visually distinct
  from the bars and never hides the hovered value.

### Must explain itself

- **R19 Path note:** Next to the address, a short note says how packets leave
  this machine: for a tailnet peer its Tailscale transport (direct, DERP
  region, or peer relay), for other hosts the outgoing interface and gateway.
  The note uses only local information (no extra probes), says when it is
  unknown instead of guessing, and keeps public endpoints and source addresses
  out of the default view (decision 0002).

- **R25 Drop indicator:** After three consecutive completed losses, the
  host's identity/address line says how long it has been since its last
  reply, or `no reply yet` if it never replied. The next reply clears it.
  The readout replaces the path note while down and yields to hover; rows
  put the compact drop age in Current (the user, Q28, 2026-10-04).

### Must be quick to type

- **R20 Shell completion:** fish, zsh and bash complete pingping's flags, enum
  values, and tailnet peer names (`pingping d<TAB>` offers `host-a`). A completion
  request answers within about 100 ms even when Tailscale is unavailable or
  hangs.

### Must stay cheap

- **R21 Resource efficient:** A long-running pingping costs close to what the
  probes themselves need: it wakes only for probe deadlines, replies, input,
  and changed frames; it redraws only what changed; its memory is bounded by
  the retained history and does not grow with run time.

### Must set expectations about the local network

- **R23 Local network context:** The summary line names the medium of the
  network pingping uses (Ethernet, Wi-Fi, iPhone USB, VPN) with its link
  speed, Wi-Fi band, signal and link rate when on Wi-Fi, and the OS cost
  flags (Low Data Mode, expensive, metered) only when they are on. Facts the
  OS does not provide are left out rather than guessed (decision 0004).

- **R24 Egress network:** The summary line also names the network that
  carries pingping's traffic to the internet (the AS of its public IPv4
  address, e.g. Example Network), looked up at start and when the local
  network changes. With a Tailscale exit node it says so. While unknown it
  shows nothing (decision Q27, 2026-10-04).

### Must let the rate change

- **R22 Adjustable rate:** The view shows the current ping rate, and keys
  change it while running. History before and after a change stays on one
  time axis (the user, 2026-10-04).

### Must work in pipes

- **R13 Plain output:** Without a TTY, pingping prints one line per probe
  outcome and no escape sequences.
