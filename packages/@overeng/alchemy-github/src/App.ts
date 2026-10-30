import { createHash, createPrivateKey, createPublicKey, randomBytes } from 'node:crypto'

import {
  effectiveGitHubBaseUrl,
  gitHubBaseUrlChanged,
  octokitFor,
} from '@alchemy.run/github/Octokit'
import { isResolved } from 'alchemy/Diff'
import * as Provider from 'alchemy/Provider'
import { Resource } from 'alchemy/Resource'
import { Clock, Effect, Redacted, Schema } from 'effect'
import sodium from 'libsodium-wrappers'

import { AppConversionRecoveryError, AppError, AppManifestDriftError } from './AppErrors.ts'
import {
  appManifest,
  appManifestDrift,
  appManifestForm,
  type AppManifest,
  type AppManifestSource,
} from './manifest.ts'
import type { Providers } from './Providers.ts'

/** Write-only repository or environment Actions secret destination for the App private key. */
export interface AppKeySecret {
  readonly owner: string
  readonly repository: string
  readonly name: string
  readonly environment?: string
}

/** Desired browser registration, optional adoption, and private-key sink configuration. */
export interface AppProps {
  readonly owner: string
  readonly ownerType?: 'organization' | 'user'
  readonly manifest: AppManifestSource
  /** The only destination of a newly generated private key. Never supplied as a Resource input. */
  readonly privateKeySecret: AppKeySecret
  /** Supply only after deploying the pending form and checking its callback state. */
  readonly conversion?: { readonly code: Redacted.Redacted<string>; readonly state: string }
  /** Adopt requires an existing Actions secret; its contents cannot be read or verified. */
  readonly adopt?: {
    readonly slug: string
    readonly appId?: number
    readonly clientId?: string
    /** Explicit assertion: public app metadata cannot prove installation identity or ownership. */
    readonly installationId?: number
  }
  readonly installationId?: number
  readonly baseUrl?: string
  /** GitHub has no delete-registration API. Default is a hard error, never silent state removal. */
  readonly destroy?: 'orphan'
}

/** Resumable browser manifest registration form with a bounded callback lifetime. */
export interface PendingApp {
  readonly status: 'pending'
  readonly manifest: AppManifest
  readonly manifestHtml: string
  readonly formUrl: string
  readonly state: string
  readonly startedAt: number
  readonly expiresAt: number
  /** GitHub server observation at form issuance; null means the secret was absent. */
  readonly secretBaseline: string | null
}

/** Nonsecret observed App identity, grants, public-key fingerprint, and secret metadata. */
export interface RegisteredApp {
  readonly status: 'registered'
  readonly appId: number
  readonly integrationId: number
  readonly slug: string
  readonly clientId?: string
  /** Last observed registration grants; used by plan-time drift checks against desired props. */
  readonly permissions: Readonly<Record<string, string>>
  readonly events: readonly string[]
  /** Not inferred from appId: a registration may have multiple installations. */
  readonly installationId?: number
  /** SHA-256 of the DER SubjectPublicKeyInfo, not the private key. Absent for adoption. */
  readonly keyFingerprint?: string
  readonly privateKeySecret: AppKeySecret & {
    readonly scope: 'repository' | 'environment'
    readonly createdAt?: string
    readonly updatedAt: string
  }
}

/** Durable state is either a browser registration request or a credential-free registration. */
export type AppAttributes = PendingApp | RegisteredApp
/** Alchemy resource contract for a GitHub App registration with a write-only key sink. */
export type App = Resource<'GitHub.App', AppProps, AppAttributes, never, Providers>

/**
 * Browser-only manifest registration with a write-only GitHub Actions private-key sink.
 * The private key is never a Resource input, output, or persisted state value.
 * Redacted is not sufficient protection for Alchemy state: only the encrypted Actions sink
 * receives the key. Secret metadata is observable, but the stored value cannot be read back.
 */
export const App = Resource<App>('GitHub.App')

const Metadata = Schema.Struct({
  id: Schema.Int,
  slug: Schema.NonEmptyString,
  client_id: Schema.optional(Schema.String),
  owner: Schema.Struct({ login: Schema.String }),
  permissions: Schema.Record(Schema.String, Schema.String),
  events: Schema.Array(Schema.String),
})
const Conversion = Schema.Struct({
  ...Metadata.fields,
  pem: Schema.String,
})
const PublicKey = Schema.Struct({ key: Schema.String, key_id: Schema.String })
const safe = <TValue>({ operation, run }: { operation: string; run: () => Promise<TValue> }) =>
  Effect.tryPromise({
    try: run,
    catch: () =>
      new AppError({
        operation,
        message: `GitHub App ${operation} failed; response and cause withheld to protect credentials.`,
      }),
  })
const decode = <TSchema extends Schema.Constraint>({
  schema,
  value,
}: {
  schema: TSchema
  value: unknown
}) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(
      () =>
        new AppError({
          operation: 'decode',
          message: 'GitHub returned an invalid App response; response withheld.',
        }),
    ),
  )
const assertManifest = Effect.fn('GitHub.App.assertManifest')(function* (
  desired: AppManifestSource,
  observed: {
    readonly permissions: Readonly<Record<string, string>>
    readonly events: readonly string[]
  },
) {
  const drift = appManifestDrift({ desired: desired, observed: observed })
  if (drift.permissions.length > 0 || drift.events !== undefined) {
    return yield* new AppManifestDriftError({
      permissions: drift.permissions,
      ...(drift.events === undefined ? {} : { events: drift.events }),
      remedy:
        'Edit the GitHub App settings in the owner browser, approve changed permissions on existing installations, then deploy again. This provider never updates permissions or events.',
    })
  }
})

const secretPath = (secret: AppKeySecret): string => {
  const repo = `/repos/${encodeURIComponent(secret.owner)}/${encodeURIComponent(secret.repository)}`
  return secret.environment === undefined
    ? `${repo}/actions/secrets`
    : `${repo}/environments/${encodeURIComponent(secret.environment)}/secrets`
}

const verifySecret = Effect.fn('GitHub.App.verifySecret')(function* (props: AppProps) {
  const octokit = yield* octokitFor(props.baseUrl)
  const response = yield* safe({
    operation: 'verify Actions secret',
    run: () =>
      octokit.request(
        `GET ${secretPath(props.privateKeySecret)}/${encodeURIComponent(props.privateKeySecret.name)}`,
        {
          request: { retries: 0, redirect: 'error' },
        },
      ),
  })
  const observed = yield* decode({
    schema: Schema.Struct({
      name: Schema.String,
      created_at: Schema.optional(Schema.String),
      updated_at: Schema.String,
    }),
    value: response.data,
  })
  if (observed.name !== props.privateKeySecret.name) {
    return yield* new AppError({
      operation: 'verify Actions secret',
      message: 'GitHub returned a different Actions secret name than the declared key sink.',
    })
  }
  const metadata: RegisteredApp['privateKeySecret'] = {
    ...props.privateKeySecret,
    scope: props.privateKeySecret.environment === undefined ? 'repository' : 'environment',
    ...(observed.created_at === undefined ? {} : { createdAt: observed.created_at }),
    updatedAt: observed.updated_at,
  }
  return metadata
})

const readApp = Effect.fn('GitHub.App.read')(function* (props: AppProps, slug: string) {
  const octokit = yield* octokitFor(props.baseUrl)
  const response = yield* safe({
    operation: 'read registration',
    run: () => octokit.request('GET /apps/{app_slug}', { app_slug: slug }),
  })
  const metadata = yield* decode({ schema: Metadata, value: response.data })
  if (metadata.owner.login.toLowerCase() !== props.owner.toLowerCase()) {
    return yield* new AppError({
      operation: 'adopt',
      message: 'App owner does not match the declared owner.',
    })
  }
  return metadata
})

const adoptApp = Effect.fn('GitHub.App.adopt')(function* (
  props: AppProps,
  previous?: RegisteredApp,
  validateManifest = true,
) {
  const adoption = props.adopt
  if (previous !== undefined) {
    const a = previous.privateKeySecret
    const b = props.privateKeySecret
    if (
      a.owner !== b.owner ||
      a.repository !== b.repository ||
      a.name !== b.name ||
      a.environment !== b.environment ||
      (adoption !== undefined &&
        (adoption.slug !== previous.slug ||
          (adoption.appId !== undefined && adoption.appId !== previous.appId)))
    ) {
      return yield* new AppError({
        operation: 'adopt',
        message:
          'Existing App identity and key sink cannot be changed by adoption inputs. Use a new resource for explicit adoption.',
      })
    }
  }
  const slug = previous?.slug ?? adoption?.slug
  if (slug === undefined)
    return yield* new AppError({
      operation: 'adopt',
      message: 'Adoption requires an explicit slug.',
    })
  const secret = yield* verifySecret(props)
  const metadata = yield* readApp(props, slug)
  if (validateManifest === true) yield* assertManifest(props.manifest, metadata)
  const expectedId = previous?.appId ?? adoption?.appId
  const expectedClient = adoption?.clientId ?? previous?.clientId
  if (
    (expectedId !== undefined && expectedId !== metadata.id) ||
    (expectedClient !== undefined &&
      metadata.client_id !== undefined &&
      expectedClient !== metadata.client_id)
  ) {
    return yield* new AppError({
      operation: 'adopt',
      message: 'Explicit appId/clientId does not match public GitHub App metadata.',
    })
  }
  const clientId = metadata.client_id ?? expectedClient
  const installationId =
    props.installationId ?? adoption?.installationId ?? previous?.installationId
  const result: RegisteredApp = {
    status: 'registered',
    appId: metadata.id,
    integrationId: metadata.id,
    slug: metadata.slug,
    permissions: metadata.permissions,
    events: metadata.events,
    ...(clientId === undefined ? {} : { clientId }),
    ...(installationId === undefined ? {} : { installationId }),
    // A changed write timestamp invalidates our association with the original public key.
    ...(previous?.keyFingerprint === undefined ||
    previous.privateKeySecret.updatedAt !== secret.updatedAt
      ? {}
      : { keyFingerprint: previous.keyFingerprint }),
    privateKeySecret: secret,
  }
  return result
})

const observeSecretBaseline = Effect.fn('GitHub.App.observeSecretBaseline')(function* (
  props: AppProps,
) {
  const octokit = yield* octokitFor(props.baseUrl)
  const data = yield* safe({
    operation: 'inspect conversion sink',
    run: async () => {
      try {
        return (
          await octokit.request(
            `GET ${secretPath(props.privateKeySecret)}/${encodeURIComponent(props.privateKeySecret.name)}`,
            { request: { retries: 0, redirect: 'error' } },
          )
        ).data
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'status' in error &&
          error.status === 404
        )
          return undefined
        throw error
      }
    },
  })
  if (data === undefined) return null
  return (yield* decode({ schema: Schema.Struct({ updated_at: Schema.String }), value: data }))
    .updated_at
})

/** Browser origin corresponding to an upstream-normalized GitHub API base URL. */
export const appBrowserOrigin = (baseUrl: string | undefined): string => {
  const webUrl = new URL(baseUrl ?? 'https://github.com')
  if (webUrl.hostname === 'api.github.com') webUrl.hostname = 'github.com'
  else if (
    webUrl.hostname.startsWith('api.') === true &&
    webUrl.hostname.endsWith('.ghe.com') === true
  )
    webUrl.hostname = webUrl.hostname.slice('api.'.length)
  return webUrl.origin
}

/**
 * There is no transaction across manifest conversion, Actions PUT, and Alchemy state.
 * Preflight everything possible, disable POST retries and mask interruption until the sink
 * completes. A process crash/ambiguous response still requires manual key rotation + adoption;
 * never invent success from secret existence (it might be an older key), or replay a one-use code.
 */
export const convertApp = Effect.fn('GitHub.App.convert')(function* (
  props: AppProps,
  pending: PendingApp,
) {
  const conversion = props.conversion
  if (conversion === undefined)
    return yield* new AppError({
      operation: 'convert',
      message: 'A manifest callback code is required.',
    })
  if (conversion.state !== pending.state)
    return yield* new AppError({
      operation: 'convert',
      message: 'Manifest callback state does not match the pending registration.',
    })
  const now = yield* Clock.currentTimeMillis
  if (now >= pending.expiresAt)
    return yield* new AppError({
      operation: 'convert',
      message:
        'The one-hour manifest registration window expired. Remove the conversion input and deploy a new form.',
    })
  const octokit = yield* octokitFor(props.baseUrl)
  const path = secretPath(props.privateKeySecret)
  const currentSecret = yield* observeSecretBaseline(props)
  if (pending.secretBaseline === undefined || currentSecret !== pending.secretBaseline)
    return yield* new AppConversionRecoveryError({
      message:
        'The declared Actions secret changed since this manifest form was issued (or this older pending state has no baseline). A previous conversion may have sunk a key, or another writer may have changed the secret. Conversion is blocked. Inspect the owner App settings: if an App was created, remove conversion and adopt its slug using the same secret; otherwise remove conversion, let this form expire, and deploy to issue a new form. No App existence or secret key identity is inferred.',
    })
  const keyResponse = yield* safe({
    operation: 'get Actions public key',
    run: () => octokit.request(`GET ${path}/public-key`),
  })
  const publicKey = yield* decode({ schema: PublicKey, value: keyResponse.data })
  yield* safe({
    operation: 'initialize sealed box',
    run: async () => {
      await sodium.ready
      const bytes = sodium.from_base64(publicKey.key, sodium.base64_variants.ORIGINAL)
      if (bytes.length !== sodium.crypto_box_PUBLICKEYBYTES)
        throw new TypeError('Invalid Actions public key')
    },
  })

  return yield* Effect.uninterruptible(
    Effect.gen(function* () {
      // All errors past this boundary deliberately omit the original cause/body/request.
      const response = yield* safe({
        operation: 'convert manifest',
        run: () =>
          octokit.request('POST /app-manifests/{code}/conversions', {
            code: Redacted.value(conversion.code),
            request: { retries: 0, redirect: 'error' },
          }),
      })
      const data = yield* decode({ schema: Conversion, value: response.data })
      const sealed = yield* safe({
        operation: 'seal private key',
        run: async () => {
          const plaintext = sodium.from_string(data.pem)
          try {
            const ciphertext = sodium.crypto_box_seal(
              plaintext,
              sodium.from_base64(publicKey.key, sodium.base64_variants.ORIGINAL),
            )
            const key = createPublicKey(createPrivateKey(data.pem))
            const fingerprint = createHash('sha256')
              .update(key.export({ type: 'spki', format: 'der' }))
              .digest('hex')
            return {
              ciphertext: sodium.to_base64(ciphertext, sodium.base64_variants.ORIGINAL),
              fingerprint,
            }
          } finally {
            sodium.memzero(plaintext)
          }
        },
      })
      yield* safe({
        operation: 'write Actions secret',
        run: () =>
          octokit.request(`PUT ${path}/${encodeURIComponent(props.privateKeySecret.name)}`, {
            encrypted_value: sealed.ciphertext,
            key_id: publicKey.key_id,
            request: { retries: 0, redirect: 'error' },
          }),
      })
      const secret = yield* verifySecret(props)
      // Drift is checked after sinking: never discard the only key because the owner edited the form.
      yield* assertManifest(props.manifest, data).pipe(
        Effect.mapError(
          (error) =>
            new AppManifestDriftError({
              permissions: error.permissions,
              ...(error.events === undefined ? {} : { events: error.events }),
              remedy: `The App "${data.slug}" was created and its private key was written to the declared Actions secret, but the owner changed the manifest grants. The one-use conversion code is consumed: do not retry it. Edit the App settings in the owner browser and approve changed permissions, then remove conversion and set adopt: { slug: "${data.slug}" } with the same privateKeySecret and deploy. Alchemy still has pending attributes; explicit adoption recovers them without replaying conversion.`,
            }),
        ),
      )
      if (data.owner.login.toLowerCase() !== props.owner.toLowerCase()) {
        return yield* new AppError({
          operation: 'convert',
          message:
            'Converted app owner differs from the declaration. Key was sunk; inspect the registration and adopt explicitly.',
        })
      }
      const result: RegisteredApp = {
        status: 'registered',
        appId: data.id,
        integrationId: data.id,
        slug: data.slug,
        permissions: data.permissions,
        events: data.events,
        ...(data.client_id === undefined ? {} : { clientId: data.client_id }),
        ...(props.installationId === undefined ? {} : { installationId: props.installationId }),
        keyFingerprint: sealed.fingerprint,
        privateKeySecret: secret,
      }
      return result
    }).pipe(
      Effect.catchTag('GitHubAppResourceError', () =>
        Effect.fail(
          new AppConversionRecoveryError({
            message:
              'Manifest conversion or the Actions secret write did not complete conclusively. The one-use code may be consumed, expired, or invalid. Do not retry automatically. Inspect the owner browser: if an App exists, revoke/replace its key if necessary, put the replacement in the declared Actions secret, remove conversion and adopt by slug. If no App was created, remove conversion and reissue a form after the pending form expires. A successful secret write with lost Alchemy state can be recovered by explicit adoption. No private key was persisted by Alchemy.',
          }),
        ),
      ),
    ),
  )
})

const assertUnchanged = Effect.fn('GitHub.App.assertUnchanged')(function* (
  olds: AppProps,
  news: AppProps,
) {
  const a = olds.privateKeySecret
  const b = news.privateKeySecret
  if (
    olds.owner !== news.owner ||
    olds.ownerType !== news.ownerType ||
    a.owner !== b.owner ||
    a.repository !== b.repository ||
    a.name !== b.name ||
    a.environment !== b.environment ||
    (yield* gitHubBaseUrlChanged(olds, news)) === true
  ) {
    return yield* new AppError({
      operation: 'identity',
      message:
        'App owner, host and private-key secret location are immutable. Move/rotate the key manually and adopt explicitly in a new resource; this provider cannot read back the key.',
    })
  }
})

/** Resume browser registration, convert a callback directly into the key sink, or adopt metadata. */
export const reconcileApp = Effect.fn('GitHub.App.reconcile')(function* (
  news: AppProps,
  output?: AppAttributes,
  olds?: AppProps,
) {
  if (olds !== undefined) yield* assertUnchanged(olds, news)
  if (output?.status === 'registered') return yield* adoptApp(news, output)
  if (news.adopt !== undefined) return yield* adoptApp(news)
  if (news.conversion !== undefined) {
    if (output?.status !== 'pending')
      return yield* new AppError({
        operation: 'convert',
        message:
          'Deploy without a conversion first to persist the manifest form and callback state.',
      })
    return yield* convertApp(news, output)
  }
  const now = yield* Clock.currentTimeMillis
  if (
    output?.status === 'pending' &&
    now < output.expiresAt &&
    output.manifestHtml ===
      appManifestForm({ manifest: appManifest(news.manifest), formUrl: output.formUrl })
  )
    return output
  const baseUrl = yield* effectiveGitHubBaseUrl(news.baseUrl)
  const webOrigin = appBrowserOrigin(baseUrl)
  const registration =
    news.ownerType === 'user'
      ? '/settings/apps/new'
      : `/organizations/${encodeURIComponent(news.owner)}/settings/apps/new`
  const state = randomBytes(32).toString('hex')
  const formUrl = `${webOrigin}${registration}?state=${state}`
  const manifest = appManifest(news.manifest)
  const pending: PendingApp = {
    status: 'pending',
    manifest,
    formUrl,
    manifestHtml: appManifestForm({ manifest: manifest, formUrl: formUrl }),
    state,
    startedAt: now,
    expiresAt: now + 60 * 60 * 1000,
    secretBaseline: yield* observeSecretBaseline(news),
  }
  return pending
})

/** Refresh observed metadata even when the engine would otherwise plan a no-op. */
export const readAppState = Effect.fn('GitHub.App.observe')(function* (
  olds: AppProps,
  output?: AppAttributes,
) {
  if (output?.status === 'registered') return yield* adoptApp(olds, output, false)
  if (output?.status === 'pending') return output
  if (olds.adopt !== undefined) return yield* adoptApp(olds, undefined, false)
  return undefined
})

/** Compare desired grants with live observations, never with historical declaration props. */
export const diffApp = Effect.fn('GitHub.App.diff')(function* (
  news: AppProps,
  output?: AppAttributes,
  olds?: AppProps,
) {
  if (olds !== undefined) yield* assertUnchanged(olds, news)
  if (output?.status === 'registered') {
    // beta84 plans unchanged resources from persisted output without calling read.
    const observed = yield* adoptApp(news, output, false)
    yield* assertManifest(news.manifest, observed)
    return undefined
  }
  if (output?.status === 'pending') {
    const now = yield* Clock.currentTimeMillis
    if (
      news.adopt !== undefined ||
      news.conversion !== undefined ||
      now >= output.expiresAt ||
      output.manifestHtml !==
        appManifestForm({ manifest: appManifest(news.manifest), formUrl: output.formUrl })
    )
      return { action: 'update' as const }
  }
  return undefined
})

/** Forget pending forms or explicitly orphan registrations; never delete an unreadable key. */
export const deleteApp = Effect.fn('GitHub.App.delete')(function* (
  olds: AppProps,
  output: AppAttributes,
) {
  if (output.status === 'pending' || olds.destroy === 'orphan') return
  return yield* new AppError({
    operation: 'destroy',
    message:
      'GitHub App registrations require browser deletion. Delete it in the owner browser, then explicitly set destroy: orphan to remove Alchemy state. The Actions secret is retained. Installation deletion requires App JWT authentication; the write-only key sink intentionally cannot supply it.',
  })
})

/** Register the GitHub App lifecycle with Alchemy using the shared upstream GitHub credentials. */
export const AppProvider = Provider.succeed(App, {
  list: () => Effect.succeed([]),
  read: ({ olds, output }) => readAppState(olds, output),
  diff: ({ olds, news, output }) =>
    isResolved(news) === true ? diffApp(news, output, olds) : Effect.void,
  reconcile: ({ news, output, olds }) => reconcileApp(news, output, olds),
  delete: ({ olds, output }) => deleteApp(olds, output),
})
