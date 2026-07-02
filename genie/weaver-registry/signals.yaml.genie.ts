/** Emits `signals.yaml` — all spans + metrics (which only REF the catalog). */
import { weaverSignals } from '../../packages/@overeng/genie/src/runtime/weaver/mod.ts'
import { weaver } from './registry.ts'

export default weaverSignals(weaver)
