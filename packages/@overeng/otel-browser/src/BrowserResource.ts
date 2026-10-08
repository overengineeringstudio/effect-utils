import { Effect } from 'effect'

/**
 * Page-owned OTLP resource identity. A browser has no truthful host identity; its relay must
 * preserve these attributes rather than supplying collector-host defaults.
 */
import type { ServiceIdentity } from '@overeng/otel-contract'

import { BrowserPlatform } from './BrowserPlatform.ts'

/** Scalar values supported by browser resource attributes. */
export type AttributeValue = string | number | boolean

/** Page-owned identity and deployment metadata. */
export interface ResourceOptions {
  readonly identity: ServiceIdentity
  /** `deployment.environment.name`, e.g. `dev` | `prod`. */
  readonly environment: string
  /** Extra low-cardinality resource attributes (contender, build flavor, ...). */
  readonly resourceAttributes?: Readonly<Record<string, AttributeValue>> | undefined
}

/**
 * Keys only the library sets; caller `resourceAttributes` cannot override them, and the relay must not
 * either. `session.id` survives reloads in the tab (sessionStorage); `service.instance.id` is one
 * page load.
 */
export const ownedKeys = [
  'service.name',
  'service.namespace',
  'service.version',
  'service.instance.id',
  'deployment.environment.name',
  'session.id',
  'telemetry.sdk.name',
  'telemetry.sdk.language',
  'user_agent.original',
  'browser.language',
] as const

/**
 * Host-identity keys that are meaningless for a browser. The library never sets them and refuses
 * them in caller `resourceAttributes`; the relay strips them from inbound payloads.
 */
export const forbiddenKeyPrefixes = [
  'host.',
  'os.',
  'process.',
  'container.',
  'k8s.',
  'cloud.',
] as const

const sessionKey = '@overeng/otel-browser/session-id'

/** Resolved OTLP resource and per-tab/page identities. */
export interface BrowserResource {
  readonly serviceName: string
  readonly serviceVersion: string
  /** Every resource attribute except `service.name`/`service.version` (OTLP fields of their own). */
  readonly attributes: Readonly<Record<string, AttributeValue>>
  readonly sessionId: string
  readonly instanceId: string
}

/** Builds the resource; dies on caller attributes that collide with owned or host keys. */
export const make = Effect.fnUntraced(function* (options: ResourceOptions) {
  const platform = yield* BrowserPlatform
  for (const key of Object.keys(options.resourceAttributes ?? {})) {
    if ((ownedKeys as ReadonlyArray<string>).includes(key) === true) {
      return yield* Effect.die(new Error(`resource attribute "${key}" is owned by otel-browser`))
    }
    if (forbiddenKeyPrefixes.some((prefix) => key.startsWith(prefix)) === true) {
      return yield* Effect.die(
        new Error(`resource attribute "${key}" is host identity; a browser must not send it`),
      )
    }
  }
  const stored = platform.sessionStorage?.getItem(sessionKey) ?? null
  const sessionId = stored ?? platform.randomId()
  if (stored === null) platform.sessionStorage?.setItem(sessionKey, sessionId)
  const instanceId = platform.randomId()
  const resource: BrowserResource = {
    serviceName: options.identity.name,
    serviceVersion: options.identity.version,
    sessionId,
    instanceId,
    attributes: {
      ...options.resourceAttributes,
      'service.namespace': options.identity.namespace,
      'service.instance.id': instanceId,
      'deployment.environment.name': options.environment,
      'session.id': sessionId,
      'telemetry.sdk.name': '@overeng/otel-browser',
      'telemetry.sdk.language': 'webjs',
      'user_agent.original': platform.userAgent,
      ...(platform.language === undefined ? {} : { 'browser.language': platform.language }),
    },
  }
  return resource
})
