/**
 * Emits `notion_md.attributes.yaml` — the DEFINE-once catalog for the `notion_md` namespace
 * (notion-md's own telemetry, migrated onto the registry seam).
 *
 * One `.genie.ts` → one output file, so each namespace has its own emitter file (the RESOLVED
 * FORK). This is the third namespace alongside `acme.attributes.yaml.genie.ts` and
 * `genie.attributes.yaml.genie.ts`.
 */
import { createGenieOutput } from '../packages/@overeng/genie/src/runtime/core.ts'
import { renderAttributeGroup } from '../packages/@overeng/genie/src/runtime/weaver/mod.ts'
import { docProvenance, registry } from './registry.ts'

const NAMESPACE = 'notion_md'
const group = registry.groups.find((g) => g.namespace === NAMESPACE)
if (group === undefined) throw new Error(`registry is missing the ${NAMESPACE} namespace group`)

export default createGenieOutput({
  data: group,
  stringify: () => renderAttributeGroup({ group, provenance: docProvenance }),
})
