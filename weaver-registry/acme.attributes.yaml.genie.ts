/**
 * Emits `acme.attributes.yaml` — the DEFINE-once catalog for the `acme` namespace.
 *
 * NOTE: the genie engine maps ONE `.genie.ts` → ONE output file, so each namespace needs its
 * own emitter file (M1 has exactly one namespace). A future multi-namespace registry adds one
 * `<ns>.attributes.yaml.genie.ts` per namespace — no engine change (the RESOLVED FORK).
 */
import { createGenieOutput } from '../packages/@overeng/genie/src/runtime/core.ts'
import { renderAttributeGroup } from '../packages/@overeng/genie/src/runtime/weaver/mod.ts'
import { docProvenance, registry } from './registry.ts'

const NAMESPACE = 'acme'
const group = registry.groups.find((g) => g.namespace === NAMESPACE)
if (group === undefined) throw new Error(`registry is missing the ${NAMESPACE} namespace group`)

export default createGenieOutput({
  data: group,
  stringify: () => renderAttributeGroup({ group, provenance: docProvenance }),
})
