# 0020 — root trace surfacing: print trace id + URL to stderr when otel-scrape is the trace root

Status: accepted

**Context:** When `otel-scrape` mints the trace root (no inbound `traceparent`),
the trace it creates is only discoverable by opening the backend UI and
searching. Agents and humans who wrap a command with `otel-scrape` have the
trace id in hand the moment the run starts, but today nothing surfaces it — a
root run emits only the child's own stdout/stderr (verified in
`.experiments/0010-root-trace-stderr-gap.md`). The consumer must go to Grafana,
find the right time window, and guess which trace was theirs before they can use
it. This is friction for the exact workflow otel-scrape exists to serve.

The presentation half already exists at the fleet layer: the `otel-trace` shell
function (`nix/devenv-modules/otel.nix`) reads `TRACEPARENT` and prints a Grafana
Explore/TraceQL URL as an OSC 8 hyperlink on a TTY, or plain `trace:<id> <url>`
when piped. That convention is the template to mirror; the gap is that
otel-scrape mints a *fresh* root trace id per command, so the pre-baked session
link is not it.

**Decision:** When `otel-scrape` is the trace root and telemetry is active,
surface the trace identity to stderr (terminal-only), backend-agnostically.

1. **Root-only.** Surfacing happens only when otel-scrape mints the root
   (`parent_span_id == None`). A joined/nested run does not own the root and
   stays silent, so exactly one participant surfaces per trace.

   (The normative contract — exit-scenario matrix, config surface, two-tier rule,
   format, and privacy line — lives in spec.md "Root Trace Surfacing". This
   decision keeps the rationale for *why* each choice was made.)

2. **Bound to export acknowledgement, not the child's exit code.** The
   resolvable-URL line is emitted iff **root ∧ export acknowledged (2xx) ∧
   template configured**, and is emitted for a *failing* wrapped command too — a
   red build is exactly when the trace is wanted. "Acknowledged" is deliberately
   weaker than "ingested": a 2xx from otel-scrape's own command-span POST proves
   the collector accepted that span, not that a backend has ingested it (immediate
   clicks can transiently 404 under ingestion lag) nor that otel-aware children's
   sub-spans landed. The 2xx gate exists only to avoid printing a URL for a trace
   the collector outright rejected or never received.

3. **Two-tier surfacing (open question resolved B).** A **resolvable URL** is
   printed only under the acknowledged-export gate above; otherwise, when
   telemetry is active (summary written or export attempted), the **bare trace
   id** is printed so it is always on hand for local correlation (the summary
   records `trace.trace_id`, so it greps `summary.json`, an otelite capture, or a
   manual backend search). The alternative — always print a URL — was rejected
   because a URL for a rejected/never-sent trace is worse than no URL.

4. **End-time, after export.** Surfacing happens after the child exits and export
   is attempted, so the line reflects the export outcome. otel-scrape's single
   command span is not queryable mid-run anyway; the alternative (start-time, for
   live-watching otel-aware children streaming sub-spans) was rejected as the
   default because it would print a URL before knowing whether export was even
   accepted.

5. **Backend-agnostic template (vision: "not a dashboarding system").** The
   public Rust binary does not construct Grafana URLs; it substitutes the trace id
   into an opaque operator/fleet-supplied `{traceId}` template. This keeps the
   binary free of any backend coupling. A template without `{traceId}`, or a
   rendered URL carrying control characters, is rejected (warn + bare id) — the
   surfaced line is a single agent-parseable line, so neither a misleading static
   URL nor an injected newline/terminal-escape is allowed through. Supplying the
   placeholder template is a fleet/R26 concern; the existing `OTEL_GRAFANA_LINK_URL`
   is pre-baked with a specific session trace id, not a placeholder template, so
   the fleet needs a small new placeholder-template export.

6. **On/off, no override past the R04 gate.** `--trace-link on|off` (also
   `true|false`) / `OTEL_SCRAPE_TRACE_LINK`, default on; `off` suppresses all
   surfacing even when the gate passes (for strict stderr consumers). There is no
   on-override: pure passthrough always stays silent (R04).

7. **Format** mirrors the fleet `otel-trace` convention. TTY detection selects the
   **encoding only** (OSC 8 hyperlink vs plain text), never whether to emit —
   agents read *piped* stderr, so suppressing on non-TTY would defeat the feature.

8. **Privacy — operator-controlled, not "just ephemeral terminal".** The surfaced
   text is stderr-only and MUST NOT enter the summary file or OTLP export (a
   required regression line asserts byte-absence from every sink). It carries only
   the public-safe random trace id (not derived from argv/cwd) plus the operator's
   own URL template, which may embed a private backend hostname. Because this line
   also lands in piped and CI-captured stderr — the same public-repo vector
   [decision 0015](./0015-trust-assertion-is-per-named-sink.md) hardened the
   summary against — the safety is *not* the interactive-ephemerality argument of
   [decision 0017](./0017-adapter-structured-source-and-presentation.md). It is
   operator control: the hostname enters only through the operator's own opt-in
   template (never from the wrapped command), it is a distinct class from the
   argv/cwd secrets the trust gate governs, and `--trace-link off` disables the
   whole line.

**Consequences:**

- A root `otel-scrape -- <cmd>` with export configured and a template set now
  ends with one clickable/greppable trace line on stderr; agents can act on the
  trace with zero backend interaction.
- Not telemetry: no `telemetry-registry.json` change — this is terminal
  presentation, like the existing wrapper diagnostics/warnings, and is
  best-effort (not a stability-guaranteed stdout-style contract).
- The fleet must add a placeholder-template export alongside the existing
  `OTEL_GRAFANA_LINK_URL` wiring for the URL tier to light up; without it, the
  binary degrades to the bare-id tier.
