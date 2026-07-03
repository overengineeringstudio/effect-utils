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

2. **Emission is bound to actual export success, not the child's exit code.** The
   resolvable-URL line is emitted iff **root ∧ successful OTLP export ∧ template
   configured**. It is emitted for a *failing* wrapped command too — a red build
   is exactly when the trace is wanted. Exit-scenario matrix:

   | Scenario | Trace queryable? | Surfaced |
   | --- | --- | --- |
   | child exit 0, export OK | yes | `trace:<id>  <url>` |
   | child exit non-zero, export OK | yes | `trace:<id>  <url>` |
   | child signal-terminated, export OK | yes | `trace:<id>  <url>` |
   | export fails / disabled by env, summary or export attempted | no (URL would 404) | bare `trace:<id>` (+ existing export-failure warning) |
   | `--summary-out` only, no OTLP | local only | bare `trace:<id>` |
   | pure passthrough (no summary, no export) | — | nothing (R04) |
   | otel-scrape can't spawn child | — | nothing (errors before export) |

3. **Two-tier surfacing (open question resolved B).** A **resolvable URL** is
   only printed when the trace is provably exported (URL never dead-links).
   When telemetry is active (summary written or export attempted) but no
   resolvable URL exists, the **bare trace id** is printed so it is always on
   hand for local correlation (grep `summary.json`, otelite capture, manual
   backend search).

4. **End-time, after export.** Surfacing happens after the child exits and export
   is attempted, so the URL is truthful. otel-scrape's single command span is not
   queryable mid-run anyway; the alternative (start-time, for live-watching
   otel-aware children streaming sub-spans) was rejected as the default because it
   can print dead URLs on later export failure.

5. **Backend-agnostic template (vision: "not a dashboarding system").** The
   public Rust binary does not construct Grafana URLs. It takes an opaque URL
   template with a `{traceId}` placeholder (replace-all) and substitutes the
   lowercase-hex trace id (URL-safe, survives encoding). Config surface:
   - `--trace-url-template <tmpl>` / `OTEL_SCRAPE_TRACE_URL_TEMPLATE` (flag wins).
   - The fleet fills the template with its URL-encoded Grafana Explore/TraceQL URL,
     marking the trace-id position, e.g. `…query%22%3A%22{traceId}%22…&orgId=1`.
     (The existing `OTEL_GRAFANA_LINK_URL` is pre-baked with the session's own
     trace id, *not* a placeholder template, so the fleet needs a small new
     placeholder-template export — a downstream/R26 concern, outside this
     public-contract decision.)

6. **On/off, no override past the R04 gate.** `--trace-link on|off` /
   `OTEL_SCRAPE_TRACE_LINK` (default `on`); `off` suppresses all surfacing even
   when the gate passes (for strict stderr consumers). There is no on-override:
   pure passthrough always stays silent (R04). Unknown values are warned about
   and ignored (mirrors the exporter-enum handling).

7. **Format** mirrors `otel-trace`, with an `otel-scrape:` prefix so the line is
   attributable on shared stderr:
   - stderr is a TTY → `otel-scrape: ` + OSC 8 hyperlink, label `trace:<id>`.
   - stderr piped/redirected → plain `otel-scrape: trace:<id>  <url>` (or
     `otel-scrape: trace:<id>` in bare mode).
   TTY detection selects the **encoding only**, never whether to emit — agents
   read *piped* stderr, so suppressing on non-TTY would defeat the feature.

8. **Terminal is not a sink (privacy, decision 0017 / R27).** The surfaced text
   is stderr-only. It MUST NOT enter the summary file or OTLP export. It carries
   only the random trace id (public-safe, not derived from argv/cwd) and the
   operator-supplied template; a private Grafana hostname in the URL is fine on
   the operator's own terminal. This is a required regression line: the template
   string and rendered URL are byte-absent from every sink.

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
