# pingping — Vision

## The Problem

- **Problem 1:** `ping` prints one line per reply. Latency trends, spikes and
  loss are visible only by reading scrolling numbers.
- **Problem 2:** Comparing several hosts (a public resolver, a website, a
  tailnet peer) needs several terminals running `ping` side by side.
- **Problem 3:** On supported hosts `ping` comes from different implementations
  (iputils, BSD) with different flags and output.

## The Vision

- One live block per host shows the host, its address, a latency history and
  current / min / avg / max / received / loss at a glance (Problem 1).
- One command pings many hosts at the same time and summarizes them
  (Problem 2).
- One tool with one flag set and one look on Linux and macOS (Problem 3).
- The look is light and minimal, as in [the reference](./.reference/reference.jpeg).

## What This Is Not

- Not a traceroute, MTR, or bandwidth tool.
- Not a monitoring daemon; it runs while a person watches it.
- Not a privileged tool: no setuid binary and no file capabilities.

## Success Criteria

1. `pingping google.com` on Linux and macOS shows a live block that matches the
   reference layout.
2. `pingping google.com 1.1.1.1 host-a` shows three concurrently updating blocks and a
   summary line.
3. pingping runs as a normal user on every supported host without extra setup.
