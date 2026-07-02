/** Emits the Weaver registry `manifest.yaml` (name/description/schema_url/dependencies). */
import { createGenieOutput } from '../packages/@overeng/genie/src/runtime/core.ts'
import { renderManifest } from '../packages/@overeng/genie/src/runtime/weaver/mod.ts'
import { compositionIssues, docProvenance, registry } from './registry.ts'

export default createGenieOutput({
  data: registry,
  stringify: () => renderManifest({ registry, provenance: docProvenance }),
  // Whole-registry integrity (namespace uniqueness, dangling refs) surfaces here: genie's
  // dep-free composition layer cannot raise Effect tagged errors, so it reports via genie's
  // native validation channel and `genie:check` blocks on any error-severity issue.
  validate: () => [...compositionIssues],
})
