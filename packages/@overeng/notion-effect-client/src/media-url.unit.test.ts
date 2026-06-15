import { describe, expect, it } from '@effect/vitest'

import { canonicalizeMediaUrl, canonicalizeMediaUrlsInMarkdown } from './media-url.ts'

/*
 * A Notion-hosted signed S3 URL shaped like the live ones (synthetic values —
 * no real signature). The volatile `X-Amz-*` family rotates on every pull.
 */
const signedUrl =
  'https://prod-files-secure.s3.us-west-2.amazonaws.com/abc/def/photo.png' +
  '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
  '&X-Amz-Credential=ASIAEXAMPLE%2F20260615%2Fus-west-2%2Fs3%2Faws4_request' +
  '&X-Amz-Date=20260615T120000Z' +
  '&X-Amz-Expires=3600' +
  '&X-Amz-Signature=deadbeef' +
  '&X-Amz-SignedHeaders=host' +
  '&X-Amz-Security-Token=tok'

const canonicalSignedUrl = 'https://prod-files-secure.s3.us-west-2.amazonaws.com/abc/def/photo.png'

describe('canonicalizeMediaUrl', () => {
  it('strips the volatile signature/expiry params, keeping origin + path', () => {
    expect(canonicalizeMediaUrl(signedUrl)).toBe(canonicalSignedUrl)
  })

  it('is idempotent', () => {
    const once = canonicalizeMediaUrl(signedUrl)
    expect(canonicalizeMediaUrl(once)).toBe(once)
  })

  it('treats two rotated-signature variants as the same canonical form', () => {
    const rotated = signedUrl.replace('X-Amz-Signature=deadbeef', 'X-Amz-Signature=cafef00d')
    expect(canonicalizeMediaUrl(signedUrl)).toBe(canonicalizeMediaUrl(rotated))
  })

  it('leaves an external URL with a benign query param untouched', () => {
    const external = 'https://example.com/img.png?v=2&w=800'
    expect(canonicalizeMediaUrl(external)).toBe(external)
  })

  it('keeps non-volatile params while stripping volatile ones', () => {
    const mixed = `${signedUrl}&v=2`
    expect(canonicalizeMediaUrl(mixed)).toBe(`${canonicalSignedUrl}?v=2`)
  })

  it('leaves a bare external URL untouched', () => {
    const external = 'https://example.com/img.png'
    expect(canonicalizeMediaUrl(external)).toBe(external)
  })

  it('returns non-URL input unchanged', () => {
    expect(canonicalizeMediaUrl('not a url')).toBe('not a url')
  })
})

describe('canonicalizeMediaUrlsInMarkdown', () => {
  it('canonicalizes a hosted-media image URL inside markdown', () => {
    const md = `![caption](${signedUrl})\n`
    expect(canonicalizeMediaUrlsInMarkdown(md)).toBe(`![caption](${canonicalSignedUrl})\n`)
  })

  it('canonicalizes a hosted-media link URL inside markdown', () => {
    const md = `[a file](${signedUrl})\n`
    expect(canonicalizeMediaUrlsInMarkdown(md)).toBe(`[a file](${canonicalSignedUrl})\n`)
  })

  it('leaves external-URL media untouched', () => {
    const md = '![caption](https://example.com/img.png?v=2)\n'
    expect(canonicalizeMediaUrlsInMarkdown(md)).toBe(md)
  })

  it('does not rewrite a signed-looking URL that is plain prose text', () => {
    const md = 'See https://example.com/x?X-Amz-Signature=abc in prose.\n'
    expect(canonicalizeMediaUrlsInMarkdown(md)).toBe(md)
  })
})
