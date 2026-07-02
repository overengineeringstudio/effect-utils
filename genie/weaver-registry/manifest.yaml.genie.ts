/**
 * Emits the Weaver registry `manifest.yaml` (name/description/schema_url/dependencies).
 *
 * `weaverManifest` also surfaces whole-registry integrity issues (namespace uniqueness, dangling
 * refs) via `validate`, so `genie:check` blocks on any error-severity composition issue.
 */
import { weaverManifest } from '../../packages/@overeng/genie/src/runtime/weaver/mod.ts'
import { weaver } from './registry.ts'

export default weaverManifest(weaver)
