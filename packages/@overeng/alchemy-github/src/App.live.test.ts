import { fromToken } from '@alchemy.run/github/Credentials'
import { octokitFor } from '@alchemy.run/github/Octokit'
import { it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { describe, expect } from 'vitest'

import { reconcileApp, type AppProps } from './App.ts'
import { AppError } from './AppErrors.ts'
import { AppPermissions } from './manifest.ts'

const token = process.env.ALCHEMY_GITHUB_LIVE_TOKEN
const repository = process.env.ALCHEMY_GITHUB_LIVE_REPOSITORY
const slug = process.env.ALCHEMY_GITHUB_LIVE_APP_SLUG
const secretName = process.env.ALCHEMY_GITHUB_LIVE_SECRET_NAME
const environment = process.env.ALCHEMY_GITHUB_LIVE_SECRET_ENVIRONMENT
const enabled =
  process.env.ALCHEMY_GITHUB_LIVE === '1' &&
  token !== undefined &&
  repository !== undefined &&
  slug !== undefined &&
  secretName !== undefined

// Read-only: the owner must register the App and populate the Actions secret beforehand.
// No live conversion, key generation, secret write, installation, or browser automation.
describe.skipIf(!enabled)('manual GitHub App adoption', () => {
  it.effect(
    'observes existing App and Actions secret metadata without obtaining a private key',
    () =>
      Effect.gen(function* () {
        if (
          token === undefined ||
          repository === undefined ||
          slug === undefined ||
          secretName === undefined
        )
          return yield* Effect.die('Explicit live App adoption inputs are required')
        const [owner, name, extra] = repository.split('/')
        if (
          owner === undefined ||
          owner === '' ||
          name === undefined ||
          name === '' ||
          extra !== undefined
        )
          return yield* Effect.die('Live repository must be owner/repository')
        const program = Effect.gen(function* () {
          const octokit = yield* octokitFor(undefined)
          const response = yield* Effect.tryPromise({
            try: () => octokit.request('GET /apps/{app_slug}', { app_slug: slug }),
            catch: () =>
              new AppError({
                operation: 'live metadata',
                message: 'Unable to read live App metadata; request and response withheld.',
              }),
          })
          const metadata = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              id: Schema.Int,
              name: Schema.String,
              html_url: Schema.String,
              owner: Schema.Struct({ login: Schema.String }),
              permissions: AppPermissions,
              events: Schema.Array(Schema.String),
            }),
          )(response.data)
          const props: AppProps = {
            owner: metadata.owner.login,
            manifest: {
              name: metadata.name,
              url: metadata.html_url,
              redirectUrl: metadata.html_url,
              permissions: metadata.permissions,
              events: metadata.events,
            },
            privateKeySecret: {
              owner,
              repository: name,
              name: secretName,
              ...(environment === undefined ? {} : { environment }),
            },
            adopt: { slug, appId: metadata.id },
          }
          const result = yield* reconcileApp(props)
          expect(result.status).toBe('registered')
          if (result.status !== 'registered') return yield* Effect.die('Expected adopted App')
          expect(result.appId).toBe(metadata.id)
          expect(result.slug).toBe(slug)
          expect(result.privateKeySecret.name).toBe(secretName)
          expect(result.privateKeySecret.updatedAt).not.toBe('')
          expect(result).not.toHaveProperty('privateKey')
          expect(result).not.toHaveProperty('keyFingerprint')
          expect(result).not.toHaveProperty('installationId')
        })
        yield* program.pipe(Effect.provide(fromToken(token)))
      }),
  )
})
