import type { NmdSyncStateV1 } from '@overeng/notion-effect-client'

/** Decision for whether `.nmd` auxiliary storage stays inline or moves to object storage. */
export type StorageDecision =
  | {
      readonly _tag: 'keep_self_contained'
      readonly bytes: number
      readonly classification: 'small' | 'large'
    }
  | {
      readonly _tag: 'requires_object_store'
      readonly bytes: number
      readonly reason: 'too_large' | 'volatile_url'
    }

const volatileUrlPatterns = [
  /X-Amz-Signature=/iu,
  /X-Amz-Expires=/iu,
  /secure\.notion-static\.com/iu,
]

const containsVolatileUrl = (value: unknown): boolean => {
  if (typeof value === 'string') {
    return volatileUrlPatterns.some((pattern) => pattern.test(value))
  }

  if (Array.isArray(value) === true) {
    return value.some(containsVolatileUrl)
  }

  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some(containsVolatileUrl)
  }

  return false
}

const smallBytes = 8_192
const largeBytes = 65_536

/** Decide whether sidecar storage is still an appropriate self-contained payload. */
export const decideStorage = (syncState: NmdSyncStateV1): StorageDecision => {
  const bytes = new TextEncoder().encode(JSON.stringify(syncState.storage)).byteLength

  if (containsVolatileUrl(syncState.storage) === true) {
    return { _tag: 'requires_object_store', bytes, reason: 'volatile_url' }
  }

  if (bytes > largeBytes) {
    return { _tag: 'requires_object_store', bytes, reason: 'too_large' }
  }

  return {
    _tag: 'keep_self_contained',
    bytes,
    classification: bytes <= smallBytes ? 'small' : 'large',
  }
}
