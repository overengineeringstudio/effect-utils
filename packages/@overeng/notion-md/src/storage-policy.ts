import type { NmdFrontmatterV1 } from '@overeng/notion-effect-client'
import { classifyNmdFrontmatterPayload } from '@overeng/notion-effect-client'

export type StorageDecision =
  | {
      readonly _tag: 'keep_self_contained'
      readonly bytes: number
      readonly classification: 'small' | 'large'
    }
  | {
      readonly _tag: 'requires_sidecar'
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

/** Decide whether frontmatter storage is still an appropriate self-contained payload. */
export const decideStorage = (frontmatter: NmdFrontmatterV1): StorageDecision => {
  const payload = classifyNmdFrontmatterPayload(frontmatter)

  if (containsVolatileUrl(frontmatter.notion_md.storage) === true) {
    return { _tag: 'requires_sidecar', bytes: payload.bytes, reason: 'volatile_url' }
  }

  if (payload.classification === 'too_large') {
    return { _tag: 'requires_sidecar', bytes: payload.bytes, reason: 'too_large' }
  }

  return {
    _tag: 'keep_self_contained',
    bytes: payload.bytes,
    classification: payload.classification,
  }
}
