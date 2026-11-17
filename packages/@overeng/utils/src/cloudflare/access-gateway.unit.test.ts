import { describe, expect, it } from 'vitest'

import { cloudflareAccessGateway } from './access-gateway.ts'

const unreachableOrigin = {
  fetch: async (): Promise<Response> => {
    throw new Error('Unauthenticated request reached the private origin')
  },
}

describe('cloudflareAccessGateway', () => {
  it('denies unauthenticated page, RPC and static asset requests before reaching the origin', async () => {
    const environment = { ORIGIN: unreachableOrigin }
    for (const path of ['/', '/_serverFn/private', '/index.json', '/assets/private.js']) {
      const response = await cloudflareAccessGateway.fetch(
        new Request(`https://gateway.example${path}`),
        environment,
        {},
      )
      expect(response.status).toBe(403)
    }
  })

  it('does not mistake client-supplied identity headers for native Access context', async () => {
    const response = await cloudflareAccessGateway.fetch(
      new Request('https://gateway.example/', {
        headers: {
          'Cf-Access-Jwt-Assertion': 'unverified',
          'Cf-Access-Authenticated-User-Email': 'user@example.com',
          'CF-Access-Client-Id': 'unverified',
          'CF-Access-Client-Secret': 'unverified',
        },
      }),
      { ORIGIN: unreachableOrigin },
      {},
    )
    expect(response.status).toBe(403)
  })

  it('forwards the original request and response without buffering or rewriting', async () => {
    const request = new Request('https://gateway.example/rpc?mode=review', {
      method: 'POST',
      body: 'request body',
    })
    const originResponse = new Response('origin body', {
      status: 202,
      headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' },
    })
    const response = await cloudflareAccessGateway.fetch(
      request,
      {
        ORIGIN: {
          fetch: async (forwardedRequest) => {
            expect(forwardedRequest).toBe(request)
            return originResponse
          },
        },
      },
      { access: { aud: 'platform-authenticated-audience' } },
    )
    expect(response).toBe(originResponse)
    expect(await request.text()).toBe('request body')
    expect(await response.text()).toBe('origin body')
  })
})
