import { Redacted } from 'effect'
import { describe, expect, it } from 'vitest'

import { sha256Hex } from '@overeng/utils'

import { notionTokenFingerprint } from './config.ts'

describe('notionTokenFingerprint', () => {
  it('formats as `<scheme>…#<8hex>` for a scheme-prefixed token', () => {
    const fp = notionTokenFingerprint(Redacted.make('ntn_SECRETBODYxyz'))
    expect(fp).toMatch(/^ntn_…#[0-9a-f]{8}$/u)
    /* The 8 hex chars are the first 8 of sha256(token). */
    expect(fp).toBe(`ntn_…#${sha256Hex('ntn_SECRETBODYxyz').slice(0, 8)}`)
  })

  it('never leaks token bytes beyond the scheme prefix', () => {
    const fp = notionTokenFingerprint(Redacted.make('ntn_SECRETBODYxyz'))
    expect(fp).not.toContain('SECRETBODY')
    expect(fp).not.toContain('xyz')
  })

  it('is stable across calls for the same token', () => {
    const token = Redacted.make('secret_abc123')
    expect(notionTokenFingerprint(token)).toBe(notionTokenFingerprint(token))
  })

  it('distinguishes two different tokens', () => {
    const a = notionTokenFingerprint(Redacted.make('ntn_aaaaaaaa'))
    const b = notionTokenFingerprint(Redacted.make('ntn_bbbbbbbb'))
    expect(a).not.toBe(b)
  })

  it('returns `<none>` for an empty token', () => {
    expect(notionTokenFingerprint(Redacted.make(''))).toBe('<none>')
  })

  it('emits an empty scheme (no leaked bytes) for a token with no underscore', () => {
    const fp = notionTokenFingerprint(Redacted.make('nounderscoreSECRET'))
    expect(fp).toMatch(/^…#[0-9a-f]{8}$/u)
    expect(fp).not.toContain('nounderscore')
    expect(fp).not.toContain('SECRET')
    expect(fp).toBe(`…#${sha256Hex('nounderscoreSECRET').slice(0, 8)}`)
  })
})
