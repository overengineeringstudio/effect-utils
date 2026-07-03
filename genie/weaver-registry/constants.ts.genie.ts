/**
 * Emits `constants.ts` — TS name constants + a key union (own-namespace keys only). Uses the
 * identity (keys-only) fingerprint so a doc-only prose edit does NOT churn this const target.
 */
import { weaverTsConstants } from '../../packages/@overeng/genie/src/runtime/weaver/mod.ts'
import { weaver } from './registry.ts'

export default weaverTsConstants(weaver)
