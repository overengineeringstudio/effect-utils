# Experiment 0006 — Trust-gate granularity (multi-sink non-leak)

Evidence for [decision 0015](../.decisions/0015-trust-assertion-is-per-named-sink.md)
(closing spec open-question DQ2). Question: is the trust assertion of
[0014](../.decisions/0014-command-identity-and-span-naming.md) / R27 a process-wide
boolean or per-named-sink, and can raw fields reach a sink the operator did not
assert?

## Method

Isolated worktree at the branch tip; `nix build .#otel-scrape`; a local OTLP/HTTP
JSON capture server as the "private" OTLP sink plus a temp `--summary-out` dir as
the "public-repo" sink, both configured on the same run. A throwaway patch added a
trust gate **scoped in code to the OTLP sink only** (reverted with the worktree).
Sentinel argv: a secret token flag plus a private-looking path (generic
`--token=SECRET… /a/private/path`).

## Findings

1. **Sink topology.** Two concurrent trust-gateable sinks: OTLP export (single
   endpoint — the resolver picks one value, no multi-OTLP) and the local summary
   (independently configured, `command.{argv_hash,cwd_hash}`). Both fire per run.
2. **Baseline (stock).** With the sentinel argv, both sinks carried only hashes;
   the sentinel token/path were byte-absent from both.
3. **Scoped gate, trust ON (`--trusted-sink otlp`).** OTLP payload carried raw
   `command.argv`/`command.cwd` incl. the sentinel; the **summary stayed
   `argv_hash`/`cwd_hash` — sentinel byte-absent**. The non-leak held only because
   the gate was scoped to one sink.
4. **Scoped gate, trust OFF.** Hashes only in both sinks; sentinel absent
   everywhere.

## Conclusion

A process-wide boolean would leak the sentinel into the summary (a public-repo
footgun). The assertion must be **per-named-sink**, the summary **hard-public-safe
by default**, and the **byte-level non-leak invariant** (sentinel absent from every
unasserted sink) a required regression test. See decision 0015.
