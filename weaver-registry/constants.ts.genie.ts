/** Emits `constants.ts` — TS name constants + a key union (own-namespace keys only). */
import { createGenieOutput } from '../packages/@overeng/genie/src/runtime/core.ts'
import { renderTsConstants } from '../packages/@overeng/genie/src/runtime/weaver/mod.ts'
import { identityProvenance, registry } from './registry.ts'

export default createGenieOutput({
  data: registry,
  // Identity (keys-only) fingerprint: a doc-only prose edit must NOT churn this const target.
  stringify: () => renderTsConstants({ registry, provenance: identityProvenance }),
})
