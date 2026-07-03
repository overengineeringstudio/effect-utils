/**
 * Emits `constants.rs` — Rust name constants (attribute keys + span names + metric names) for a
 * Rust telemetry producer (GEN-R06 / decision 0007's Rust target). Uses the rust-identity
 * fingerprint (keys + signal names): a doc-only prose edit must NOT churn it, a span/metric
 * rename must. The first real external consumer (otel-scrape) is follow-up epic #882.
 */
import { weaverRustConstants } from '../../packages/@overeng/genie/src/runtime/weaver/mod.ts'
import { weaver } from './registry.ts'

export default weaverRustConstants(weaver)
