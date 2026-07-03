/**
 * Emits `attributes.yaml` — ALL namespaces' DEFINE-once catalogs collapsed into ONE file
 * (design A'). Weaver accepts multiple `attribute_group` entries per file, so a single emitter
 * replaces the former per-namespace `<ns>.attributes.yaml.genie.ts` sprawl: adding a namespace
 * to the registry needs NO new `.genie.ts`.
 */
import { weaverAttributes } from '../../packages/@overeng/genie/src/runtime/weaver/mod.ts'
import { weaver } from './registry.ts'

export default weaverAttributes(weaver)
