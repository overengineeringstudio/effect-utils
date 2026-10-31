import { describe, expect, it } from 'vitest'

import {
  appManifest,
  appManifestDrift,
  appManifestForm,
  type AppManifestSource,
} from './manifest.ts'

const source: AppManifestSource = {
  name: 'Example App',
  url: 'https://example.com',
  redirectUrl: 'https://example.com/callback',
  permissions: { contents: 'read', pull_requests: 'write' },
  events: ['pull_request', 'push'],
}

describe('GitHub App manifest', () => {
  it('disables the webhook by default', () => {
    expect(appManifest(source).hook_attributes).toEqual({ url: source.url, active: false })
    expect(appManifest(source).public).toBe(false)
    expect(
      appManifest({ ...source, webhook: { url: 'https://example.com/hook', active: true } })
        .hook_attributes.active,
    ).toBe(true)
  })

  it('normalizes event ordering and automatic metadata permission', () => {
    expect(
      appManifestDrift({
        desired: source,
        observed: {
          permissions: { ...source.permissions, metadata: 'read' },
          events: ['push', 'pull_request', 'push'],
        },
      }),
    ).toEqual({ permissions: [], events: undefined })
  })

  it('reports additions, removals and permission escalation without mutating the source', () => {
    expect(
      appManifestDrift({
        desired: source,
        observed: {
          permissions: { contents: 'write', issues: 'read' },
          events: ['issues'],
        },
      }),
    ).toEqual({
      permissions: [
        { permission: 'contents', desired: 'read', observed: 'write' },
        { permission: 'issues', desired: undefined, observed: 'read' },
        { permission: 'pull_requests', desired: 'write', observed: undefined },
      ],
      events: { desired: ['pull_request', 'push'], observed: ['issues'] },
    })
    expect(source.permissions.contents).toBe('read')
  })

  it('escapes both manifest values and form URL as HTML attributes', () => {
    const html = appManifestForm({
      manifest: appManifest({ ...source, name: '"><script>alert(1)</script>' }),
      formUrl: 'https://github.com/settings/apps/new?state=a&other="',
    })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('state=a&amp;other=&quot;')
    expect(html).toContain('method="post"')
  })
})
