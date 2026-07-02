/** Emits `signals.yaml` — all spans + metrics (which only REF the catalog). */
import { createGenieOutput } from '../packages/@overeng/genie/src/runtime/core.ts'
import { renderSignals } from '../packages/@overeng/genie/src/runtime/weaver/mod.ts'
import { docProvenance, registry } from './registry.ts'

export default createGenieOutput({
  data: registry.signals,
  stringify: () => renderSignals({ signals: registry.signals, provenance: docProvenance }),
})
