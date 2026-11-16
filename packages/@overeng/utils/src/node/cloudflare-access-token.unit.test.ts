import { Redacted, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  AlchemyAccessTokenError,
  decodeAlchemyAccessTokenState,
} from './cloudflare-access-token.ts'

const stateJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

describe('decodeAlchemyAccessTokenState', () => {
  it('keeps the decoded broker payload redacted', () => {
    const state = Redacted.make(
      stateJson({
        resourceType: 'Cloudflare.Access.ServiceToken',
        attr: { clientId: 'fixture-client', clientSecret: { __redacted__: 'fixture-secret' } },
      }),
    )
    const credential = decodeAlchemyAccessTokenState(state)
    expect(String(credential)).not.toContain('fixture-secret')
    const decoded = Schema.decodeSync(
      Schema.fromJsonString(
        Schema.Struct({ clientId: Schema.String, clientSecret: Schema.String }),
      ),
    )(Redacted.value(credential))
    expect(decoded).toEqual({ clientId: 'fixture-client', clientSecret: 'fixture-secret' })
  })

  it.each([
    'fixture-secret invalid JSON',
    stateJson({ resourceType: 'Other.Resource', attr: { clientSecret: 'fixture-secret' } }),
    stateJson({
      resourceType: 'Cloudflare.Access.ServiceToken',
      attr: { clientId: '', clientSecret: { __redacted__: 'fixture-secret' } },
    }),
    stateJson({
      resourceType: 'Cloudflare.Access.ServiceToken',
      attr: { clientId: 'fixture-client', clientSecret: 'fixture-secret' },
    }),
  ])('rejects incompatible state with a credential-free error', (encoded) => {
    let failure: unknown
    try {
      decodeAlchemyAccessTokenState(Redacted.make(encoded))
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(AlchemyAccessTokenError)
    expect(String(failure)).not.toContain('fixture-secret')
    expect(String(failure)).not.toContain(encoded)
  })
})
