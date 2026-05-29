import { describe, expect, it } from 'vitest'

import {
  makeManualWebhookRelayProvider,
  makeTailscaleFunnelProvider,
  publicUrlFromTailscaleStatusJson,
  type TailscaleProcessRunner,
} from './tailscale.ts'

describe('Tailscale Funnel webhook relay provider', () => {
  it('extracts a public URL from nested Tailscale status JSON without depending on one shape', () => {
    expect(
      publicUrlFromTailscaleStatusJson({
        path: '/notion-datasource-sync/nonce',
        statusJson: JSON.stringify({
          Services: {
            'https:443': {
              Mounts: {
                '/notion-datasource-sync/nonce': {
                  URL: 'https://machine.tailnet.ts.net/notion-datasource-sync/nonce',
                  Path: '/notion-datasource-sync/nonce',
                },
              },
            },
          },
        }),
      }),
    ).toBe('https://machine.tailnet.ts.net/notion-datasource-sync/nonce')

    expect(
      publicUrlFromTailscaleStatusJson({
        path: '/missing',
        statusJson: '{not-json',
      }),
    ).toBeUndefined()
  })

  it('starts Funnel using an injected process runner and then reads status', async () => {
    const calls: Array<{ readonly command: string; readonly args: readonly string[] }> = []
    const run: TailscaleProcessRunner = async (command, args) => {
      calls.push({ command, args })
      if (args.join(' ') === 'funnel status --json') {
        return {
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({
            Routes: [
              {
                path: '/notion-datasource-sync/nonce',
                publicUrl: 'https://machine.tailnet.ts.net/notion-datasource-sync/nonce',
              },
            ],
          }),
        }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    const provider = makeTailscaleFunnelProvider({
      localPort: 34567,
      path: 'notion-datasource-sync/nonce',
      run,
    })

    await expect(provider.start()).resolves.toEqual({
      provider: 'tailscale-funnel',
      publicUrl: 'https://machine.tailnet.ts.net/notion-datasource-sync/nonce',
      localTarget: 'localhost:34567',
      path: '/notion-datasource-sync/nonce',
    })

    expect(calls).toEqual([
      {
        command: 'tailscale',
        args: [
          'funnel',
          '--bg',
          '--https=443',
          '--set-path=/notion-datasource-sync/nonce',
          'localhost:34567',
        ],
      },
      { command: 'tailscale', args: ['funnel', 'status', '--json'] },
    ])
  })

  it('reports not-running when status does not expose a public URL', async () => {
    const provider = makeTailscaleFunnelProvider({
      localPort: 34567,
      path: '/notion-datasource-sync/nonce',
      run: async () => ({ exitCode: 0, stdout: JSON.stringify({}), stderr: '' }),
    })

    await expect(provider.status()).resolves.toEqual({
      _tag: 'not-running',
      provider: 'tailscale-funnel',
      reason: 'No Tailscale Funnel public URL was reported',
    })
  })

  it('stops Funnel if startup succeeds but no public URL is reported', async () => {
    const calls: Array<readonly string[]> = []
    const provider = makeTailscaleFunnelProvider({
      localPort: 34567,
      path: '/notion-datasource-sync/nonce',
      run: async (_command, args) => {
        calls.push(args)
        return { exitCode: 0, stdout: JSON.stringify({}), stderr: '' }
      },
    })

    await expect(provider.start()).rejects.toMatchObject({
      _tag: 'TailscaleFunnelProviderError',
      operation: 'tailscale-funnel-status',
    })
    expect(calls.map((args) => args.join(' '))).toEqual([
      'funnel --bg --https=443 --set-path=/notion-datasource-sync/nonce localhost:34567',
      'funnel status --json',
      'funnel --bg --set-path=/notion-datasource-sync/nonce off',
    ])
  })

  it('surfaces start failures without embedding command output in status objects', async () => {
    const provider = makeTailscaleFunnelProvider({
      localPort: 34567,
      path: '/notion-datasource-sync/nonce',
      run: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'funnel is disabled by policy',
      }),
    })

    await expect(provider.start()).rejects.toMatchObject({
      _tag: 'TailscaleFunnelProviderError',
      operation: 'tailscale-funnel-start',
      exitCode: 1,
    })
  })

  it('supports a fake/manual relay provider without shelling out', async () => {
    const provider = makeManualWebhookRelayProvider({
      publicUrl: 'https://example.test/notion/webhook',
      localTarget: 'localhost:34567',
      path: 'notion/webhook',
    })

    await expect(provider.start()).resolves.toEqual({
      provider: 'manual',
      publicUrl: 'https://example.test/notion/webhook',
      localTarget: 'localhost:34567',
      path: '/notion/webhook',
    })
    await expect(provider.status()).resolves.toEqual({
      _tag: 'running',
      exposure: {
        provider: 'manual',
        publicUrl: 'https://example.test/notion/webhook',
        localTarget: 'localhost:34567',
        path: '/notion/webhook',
      },
    })
    await expect(provider.stop()).resolves.toBeUndefined()
  })
})
