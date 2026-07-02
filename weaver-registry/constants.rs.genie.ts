/**
 * Emits `constants.rs` — Rust name constants (attribute keys + span names + metric names) for a
 * Rust telemetry producer (GEN-R06 / decision 0007's Rust target). This proves the committed
 * Rust-artifact path end-to-end for the live registry's own namespace; the first real external
 * consumer (otel-scrape) is follow-up epic #882.
 */
import { createGenieOutput } from '../packages/@overeng/genie/src/runtime/core.ts'
import { renderRustConstants } from '../packages/@overeng/genie/src/runtime/weaver/mod.ts'
import { registry, rustProvenance } from './registry.ts'

export default createGenieOutput({
  data: registry,
  // Rust-identity fingerprint (attr keys + span ids + metric names): a doc-only prose edit must
  // NOT churn this target, and a span/metric rename must.
  stringify: () => renderRustConstants({ registry, provenance: rustProvenance }),
})
