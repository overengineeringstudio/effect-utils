import {
  NMD_LARGE_STORAGE_BYTES,
  NMD_SMALL_STORAGE_BYTES,
  type NmdSyncStateV1,
} from '@overeng/notion-effect-client'

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

/** Decide whether sidecar storage is still an appropriate self-contained payload. */
export const decideStorage = (syncState: NmdSyncStateV1): StorageDecision => {
  const bytes = new TextEncoder().encode(JSON.stringify(syncState.storage)).byteLength

  if (containsVolatileUrl(syncState.storage) === true) {
    return { _tag: 'requires_object_store', bytes, reason: 'volatile_url' }
  }

  if (bytes > NMD_LARGE_STORAGE_BYTES) {
    return { _tag: 'requires_object_store', bytes, reason: 'too_large' }
  }

  return {
    _tag: 'keep_self_contained',
    bytes,
    classification: bytes <= NMD_SMALL_STORAGE_BYTES ? 'small' : 'large',
  }
}
