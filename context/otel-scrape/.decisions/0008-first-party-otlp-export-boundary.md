# 0008 — First-party OTLP export boundary before full SDK

**Status:** Accepted.

**Context:** The wrapper already proves passthrough, context propagation, adapter summaries, and CAS artifact links through local summary evidence. The next release slice needs real OTLP emission that can be captured by `otelite`, while preserving disabled-mode transparency and child exit behavior. Pulling in the full Rust OpenTelemetry SDK before the wrapper contract is stable risks making SDK lifecycle, batching, and metric semantics the center of the first implementation.

**Decision:** Implement the first OTLP slice as a small first-party OTLP/HTTP JSON exporter boundary. It is enabled only when an endpoint is configured, emits the wrapper command span plus adapter events/profile links, and treats exporter failures as degraded evidence that never changes child stdout, stderr, stdin, or exit status.

The full Rust OpenTelemetry SDK may be adopted later when it removes more implementation complexity than it adds, especially for batching, resource detection, protobuf encoding, or metrics.

**Consequences:**

- `otelite` can serve as the first E2E capture fixture for real emitted telemetry.
- The wrapper keeps disabled-mode and summary-only behavior mechanically simple.
- Adapter metrics are not forced into OTLP metric points before their trace-correlation semantics are explicit.
- The implementation must keep generated registry names as the source of truth so the small exporter does not become a parallel schema owner.
