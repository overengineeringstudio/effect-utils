# PR Trace Access Prototype (2026-09-25)

## Question

An index-backed resolver can turn a PR number or deterministic trace ID into
usable trace links before backend attribute search becomes current, without a
provider API in the build path.

## Method

A scratch resolver ingested real CI span spools and Buck event logs into a
SQLite index, served a PR page and JSON, and generated trace-by-ID Grafana
links, Chrome trace conversion and a Perfetto handoff. A browser clicked
through the page, Grafana and Perfetto. A separate probe timed push/readback
and attribute search. Nothing was deployed or posted to GitHub; the scratch
outputs are not part of this VRS.

## Result

| Probe | Observation |
| --- | --- |
| Seal-time prediction | Full trace ID predicted from Buck UUID and `full` matched adapter output for three builds; the critical ID came from caller context. |
| PR lookup | One indexed PR run yielded four jobs, a run trace, and both Buck view links; resolver HTML and JSON exposed the same identities. |
| By-ID links | Grafana opened a run trace with 473 spans, a Buck critical view with 493 spans and a full view with 21,322 spans. |
| Pending state | A sealed but not ingested ID displayed pending instead of Grafana's empty trace; an unknown ID was distinguished. |
| Browser handoff | Chrome trace JSON was generated in 0.15–0.22 s for the sampled run/critical views and loaded in Perfetto via a one-click handoff. |
| Phone layout | The resolver page remained usable at 390 px; the Grafana dashboard variant was cramped. |
| Agent probe | A scratch compact CLI listed indexed runs/traces and the by-ID next command in 0.38 s; span fetch by ID took 3.4 s in its sample. |
| Push/readback | Critical 691 spans in one chunk: median push→complete 485 ms (n=5); full 7,681 spans in two chunks: median 1,058 ms (n=5), with partial reads in 3/5 samples. |
| Attribute search | Critical marker first visible after 45–51 min under load; full marker still absent at the last 51-min probe. |
| Single-run A/B | A merge-base comparison yielded 99 task rows, but unrelated tasks changed 29–61 s, exposing noisy single-run deltas. |

The CI tailnet join and upload duration were **not measured**; neither is a
claimed end-to-end latency result. The prototype used a one-run comparison,
not the accepted k=7 baseline. Its proposed ingester-written comment was
rejected by q34: CI's existing sticky comment is the writer instead.

## Conclusion

Use the ingest index and by-ID readback for discovery and readiness; do not
use Tempo search for PR links. The resolver provides the human page and
versioned JSON, while CI can publish seal-time links. The noisy A/B and the
PR page itself needed the subsequent variants review; see
[that experiment](./2026-09-26-pr-page-variants.md).

## VRS Impact

The [trace access spec](../spec.md) makes the index-backed resolver and
versioned JSON the canonical paths, with pending-by-ID semantics; the
[page variants](./2026-09-26-pr-page-variants.md) settle the A/B display.
