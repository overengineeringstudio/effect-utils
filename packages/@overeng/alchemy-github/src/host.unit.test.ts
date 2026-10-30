import { fromToken } from '@alchemy.run/github/Credentials'
import { effectiveGitHubBaseUrl } from '@alchemy.run/github/Octokit'
import { it } from '@effect/vitest'
import { Effect } from 'effect'
import { expect } from 'vitest'

import { reconcileApp, type AppProps } from './App.ts'

const props: AppProps = {
  owner: 'example',
  manifest: {
    name: 'Example App',
    url: 'https://example.com',
    redirectUrl: 'https://example.com/callback',
    permissions: { contents: 'read' },
    events: ['push'],
  },
  privateKeySecret: {
    owner: 'example',
    repository: 'repo',
    name: 'APP_PRIVATE_KEY',
  },
}

const cases: ReadonlyArray<{
  readonly name: string
  readonly credentialBaseUrl?: string
  readonly resourceBaseUrl?: string
  readonly apiBaseUrl?: string
  readonly webOrigin: string
}> = [
  {
    name: 'data-residency browser hostname from credentials',
    credentialBaseUrl: 'example.ghe.com',
    apiBaseUrl: 'https://api.example.ghe.com',
    webOrigin: 'https://example.ghe.com',
  },
  {
    name: 'data-residency API hostname from credentials',
    credentialBaseUrl: 'https://api.example.ghe.com',
    apiBaseUrl: 'https://api.example.ghe.com',
    webOrigin: 'https://example.ghe.com',
  },
  {
    name: 'default github.com credentials',
    webOrigin: 'https://github.com',
  },
  {
    name: 'explicit github.com credentials',
    credentialBaseUrl: 'github.com',
    webOrigin: 'https://github.com',
  },
  {
    name: 'standard GitHub API credentials',
    credentialBaseUrl: 'https://api.github.com',
    webOrigin: 'https://github.com',
  },
  {
    name: 'Enterprise Server hostname and port from credentials',
    credentialBaseUrl: 'https://api.github.example.com:8443/api/v3',
    apiBaseUrl: 'https://api.github.example.com:8443/api/v3',
    webOrigin: 'https://api.github.example.com:8443',
  },
  {
    name: 'resource data-residency override',
    credentialBaseUrl: 'https://github.example.com:8443',
    resourceBaseUrl: 'example.ghe.com',
    apiBaseUrl: 'https://api.example.ghe.com',
    webOrigin: 'https://example.ghe.com',
  },
  {
    name: 'resource github.com override of enterprise credentials',
    credentialBaseUrl: 'example.ghe.com',
    resourceBaseUrl: 'https://api.github.com',
    webOrigin: 'https://github.com',
  },
  {
    name: 'resource Enterprise Server override preserving protocol and port',
    credentialBaseUrl: 'example.ghe.com',
    resourceBaseUrl: 'http://github.example.com:8080/api/v3',
    apiBaseUrl: 'http://github.example.com:8080/api/v3',
    webOrigin: 'http://github.example.com:8080',
  },
]

for (const testCase of cases) {
  it.effect(`uses the browser origin for ${testCase.name}`, () =>
    Effect.gen(function* () {
      // Use upstream normalization, not a hand-written credentials service or HTTP fixture.
      const apiBaseUrl = yield* effectiveGitHubBaseUrl(testCase.resourceBaseUrl)
      expect(apiBaseUrl).toBe(testCase.apiBaseUrl)
      const pending = yield* reconcileApp({
        ...props,
        ...(testCase.resourceBaseUrl === undefined ? {} : { baseUrl: testCase.resourceBaseUrl }),
      })
      expect(pending.status).toBe('pending')
      if (pending.status !== 'pending') return yield* Effect.die('Expected pending manifest')
      const formUrl = `${testCase.webOrigin}/organizations/example/settings/apps/new?state=${pending.state}`
      expect(pending.formUrl).toBe(formUrl)
      expect(pending.manifestHtml).toContain(`action="${formUrl}"`)
    }).pipe(
      Effect.provide(
        fromToken(
          'fixture-token',
          testCase.credentialBaseUrl === undefined ? {} : { baseUrl: testCase.credentialBaseUrl },
        ),
      ),
    ),
  )
}
