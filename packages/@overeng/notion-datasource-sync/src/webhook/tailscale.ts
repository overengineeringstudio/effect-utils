/** Relay provider kinds supported by the webhook boundary. */
export type WebhookRelayProviderKind = 'tailscale-funnel' | 'manual'

/** Public exposure details returned by a relay provider after startup. */
export type WebhookRelayExposure = {
  readonly provider: WebhookRelayProviderKind
  readonly publicUrl: string
  readonly localTarget: string
  readonly path: string
}

/** Health status for a configured webhook relay provider. */
export type WebhookRelayStatus =
  | {
      readonly _tag: 'running'
      readonly exposure: WebhookRelayExposure
    }
  | {
      readonly _tag: 'not-running'
      readonly provider: WebhookRelayProviderKind
      readonly reason: string
    }

/** Provider boundary used by CLI/daemon code without baking in Tailscale-specific behavior. */
export type WebhookRelayProvider = {
  readonly kind: WebhookRelayProviderKind
  readonly start: () => Promise<WebhookRelayExposure>
  readonly status: () => Promise<WebhookRelayStatus>
  readonly stop: () => Promise<void>
}

/** Result from an injected process runner; stdout/stderr are never logged by this module. */
export type TailscaleProcessResult = {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** Process runner seam that lets tests assert Tailscale CLI commands without shelling out. */
export type TailscaleProcessRunner = (
  command: string,
  args: readonly string[],
) => Promise<TailscaleProcessResult>

/** Options for exposing a local webhook receiver through Tailscale Funnel. */
export type TailscaleFunnelProviderOptions = {
  readonly localPort: number
  readonly path: string
  readonly httpsPort?: 443 | 8443 | 10000
  readonly tailscaleCommand?: string
  readonly run: TailscaleProcessRunner
}

/** Manual relay provider options for a user-managed HTTPS tunnel. */
export type ManualWebhookRelayProviderOptions = {
  readonly publicUrl: string
  readonly localTarget: string
  readonly path: string
}

/** Tailscale Funnel provider error with operation context but no raw webhook payload material. */
export class TailscaleFunnelProviderError extends Error {
  readonly _tag = 'TailscaleFunnelProviderError'
  readonly operation: string
  readonly exitCode: number | undefined
  readonly stderr: string | undefined

  constructor({
    operation,
    message,
    exitCode,
    stderr,
  }: {
    readonly operation: string
    readonly message: string
    readonly exitCode?: number
    readonly stderr?: string
  }) {
    super(message)
    this.name = 'TailscaleFunnelProviderError'
    this.operation = operation
    this.exitCode = exitCode
    this.stderr = stderr
  }
}

const normalizePath = (path: string): string => {
  if (path.length === 0) return '/'
  return path.startsWith('/') === true ? path : `/${path}`
}

const localTarget = (localPort: number): string => `localhost:${localPort.toString()}`

const startArgs = ({
  localPort,
  path,
  httpsPort,
}: {
  readonly localPort: number
  readonly path: string
  readonly httpsPort: 443 | 8443 | 10000
}): readonly string[] => [
  'funnel',
  '--bg',
  `--https=${httpsPort.toString()}`,
  `--set-path=${normalizePath(path)}`,
  localTarget(localPort),
]

const stopArgs = ({ path }: { readonly path: string }): readonly string[] => [
  'funnel',
  '--bg',
  `--set-path=${normalizePath(path)}`,
  'off',
]

type TailscaleStatusCandidate = {
  readonly publicUrl: string | undefined
  readonly path: string | undefined
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && Array.isArray(value) === false

const stringField = ({
  record,
  key,
}: {
  readonly record: Readonly<Record<string, unknown>>
  readonly key: string
}): string | undefined =>
  typeof record[key] === 'string' && record[key].length > 0 ? record[key] : undefined

const collectStatusCandidates = (value: unknown): readonly TailscaleStatusCandidate[] => {
  const candidates: TailscaleStatusCandidate[] = []
  const visit = (current: unknown): void => {
    if (Array.isArray(current) === true) {
      for (const item of current) visit(item)
      return
    }
    if (isRecord(current) === false) return
    const publicUrl =
      stringField({ record: current, key: 'URL' }) ??
      stringField({ record: current, key: 'Url' }) ??
      stringField({ record: current, key: 'url' }) ??
      stringField({ record: current, key: 'PublicURL' }) ??
      stringField({ record: current, key: 'publicUrl' }) ??
      stringField({ record: current, key: 'public_url' })
    const path =
      stringField({ record: current, key: 'Path' }) ??
      stringField({ record: current, key: 'path' }) ??
      stringField({ record: current, key: 'MountPoint' }) ??
      stringField({ record: current, key: 'mountPoint' })
    if (publicUrl !== undefined || path !== undefined) {
      candidates.push({ publicUrl, path })
    }
    for (const nested of Object.values(current)) visit(nested)
  }
  visit(value)
  return candidates
}

/** Extract the public Funnel URL from Tailscale's JSON status output. */
export const publicUrlFromTailscaleStatusJson = ({
  statusJson,
  path,
}: {
  readonly statusJson: string
  readonly path: string
}): string | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(statusJson)
  } catch {
    return undefined
  }
  const normalizedPath = normalizePath(path)
  const candidates = collectStatusCandidates(parsed)
  const exact = candidates.find(
    (candidate) => candidate.path === normalizedPath && candidate.publicUrl !== undefined,
  )
  return (
    exact?.publicUrl ?? candidates.find((candidate) => candidate.publicUrl !== undefined)?.publicUrl
  )
}

/** Build a Tailscale Funnel relay provider around an injected process runner. */
export const makeTailscaleFunnelProvider = (
  options: TailscaleFunnelProviderOptions,
): WebhookRelayProvider => {
  const httpsPort = options.httpsPort ?? 443
  const command = options.tailscaleCommand ?? 'tailscale'
  const path = normalizePath(options.path)
  const exposureFromStatus = async (): Promise<WebhookRelayExposure | undefined> => {
    const status = await options.run(command, ['funnel', 'status', '--json'])
    if (status.exitCode !== 0) return undefined
    const publicUrl = publicUrlFromTailscaleStatusJson({ statusJson: status.stdout, path })
    return publicUrl === undefined
      ? undefined
      : {
          provider: 'tailscale-funnel',
          publicUrl,
          localTarget: localTarget(options.localPort),
          path,
        }
  }

  return {
    kind: 'tailscale-funnel',
    start: async () => {
      const started = await options.run(
        command,
        startArgs({ localPort: options.localPort, path, httpsPort }),
      )
      if (started.exitCode !== 0) {
        throw new TailscaleFunnelProviderError({
          operation: 'tailscale-funnel-start',
          message: 'Unable to start Tailscale Funnel',
          exitCode: started.exitCode,
          stderr: started.stderr,
        })
      }
      const exposure = await exposureFromStatus()
      if (exposure === undefined) {
        await options.run(command, stopArgs({ path }))
        throw new TailscaleFunnelProviderError({
          operation: 'tailscale-funnel-status',
          message: 'Tailscale Funnel started but no public URL was reported',
        })
      }
      return exposure
    },
    status: async () => {
      const exposure = await exposureFromStatus()
      return exposure === undefined
        ? {
            _tag: 'not-running',
            provider: 'tailscale-funnel',
            reason: 'No Tailscale Funnel public URL was reported',
          }
        : { _tag: 'running', exposure }
    },
    stop: async () => {
      const stopped = await options.run(command, stopArgs({ path }))
      if (stopped.exitCode !== 0) {
        throw new TailscaleFunnelProviderError({
          operation: 'tailscale-funnel-stop',
          message: 'Unable to stop Tailscale Funnel',
          exitCode: stopped.exitCode,
          stderr: stopped.stderr,
        })
      }
    },
  }
}

/** Build a no-process relay provider for manual tunnels and tests. */
export const makeManualWebhookRelayProvider = (
  options: ManualWebhookRelayProviderOptions,
): WebhookRelayProvider => {
  const exposure = {
    provider: 'manual',
    publicUrl: options.publicUrl,
    localTarget: options.localTarget,
    path: normalizePath(options.path),
  } satisfies WebhookRelayExposure

  return {
    kind: 'manual',
    start: async () => exposure,
    status: async () => ({ _tag: 'running', exposure }),
    stop: async () => {},
  }
}
