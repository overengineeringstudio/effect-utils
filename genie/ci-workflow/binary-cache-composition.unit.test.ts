import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  binaryCachesExtraConfForJob,
  ConflictingBinaryCacheError,
  PrivateBinaryCacheRunnerError,
} from './binary-cache-composition.ts'
import {
  effectUtilsBinaryCaches,
  type BinaryCacheDescriptor as Cache,
} from './binary-cache-descriptors.ts'
import { BinaryCacheDescriptorSchema, readBinaryCacheDescriptors } from './binary-cache-schema.ts'
import {
  cachixPublisherStep,
  cachixPushStep,
  cachixStep,
  CachePublisherJobError,
  installNixStep,
} from './setup.ts'

const publicCache = effectUtilsBinaryCaches['overeng-effect-utils']!
const privateCache: Cache = {
  kind: 'nix-binary',
  name: 'private',
  visibility: 'private',
  uri: 'https://private.cachix.org',
  publicKey: 'private.cachix.org-1:key',
}

const protectedIf = "github.ref == 'refs/heads/main' && github.event_name == 'push'"

describe('build cache composition', () => {
  it('accepts public cache on non-fleet and private cache only on static fleet labels', () => {
    expect(binaryCachesExtraConfForJob({ runner: 'ubuntu-latest', caches: [publicCache] })).toBe(
      `extra-substituters = ${publicCache.kind === 'nix-binary' ? publicCache.uri : ''}\nextra-trusted-public-keys = ${publicCache.kind === 'nix-binary' ? publicCache.publicKey : ''}`,
    )
    expect(
      binaryCachesExtraConfForJob({ runner: ['sh-linux-x64', 'nix'], caches: [privateCache] }),
    ).toContain(privateCache.uri)
    expect(
      installNixStep({ runner: 'sh-linux-x64', binaryCaches: [privateCache] }).with['extra-conf'],
    ).toContain(privateCache.uri)
  })

  it('rejects private caches on untrusted, mixed and dynamic runners', () => {
    for (const runner of [
      'ubuntu-latest',
      'namespace-profile-linux-x86-64',
      'sh-unregistered',
      '${{ matrix.runner }}',
      ['sh-linux-x64', 'ubuntu-latest'],
      [],
    ]) {
      expect(() => binaryCachesExtraConfForJob({ runner, caches: [privateCache] })).toThrow(
        PrivateBinaryCacheRunnerError,
      )
    }
    expect(() => installNixStep({ binaryCaches: [privateCache] })).toThrow(
      PrivateBinaryCacheRunnerError,
    )
  })

  it('deduplicates by name and rejects conflicting identities and keys', () => {
    expect(
      binaryCachesExtraConfForJob({
        runner: 'ubuntu-latest',
        caches: [publicCache, publicCache],
      }).match(/https:\/\/overeng-effect-utils/g),
    ).toHaveLength(1)
    expect(() =>
      binaryCachesExtraConfForJob({
        runner: 'ubuntu-latest',
        caches: [publicCache, { ...publicCache, publicKey: 'changed:key' }],
      }),
    ).toThrow(ConflictingBinaryCacheError)
    expect(() =>
      binaryCachesExtraConfForJob({
        runner: 'ubuntu-latest',
        caches: [publicCache, { ...publicCache, name: 'other', publicKey: 'changed:key' }],
      }),
    ).toThrow(ConflictingBinaryCacheError)
  })

  it('validates tagged protocol shape and excludes REAPI from Nix settings', () => {
    const reapi = Schema.decodeUnknownSync(BinaryCacheDescriptorSchema)({
      kind: 'reapi',
      name: 'remote',
      visibility: 'public',
      endpoint: 'grpcs://example.test:443',
      instanceName: 'effect-utils',
      digest: 'SHA256',
    })
    expect(binaryCachesExtraConfForJob({ runner: 'ubuntu-latest', caches: [reapi] })).toBe(
      'extra-substituters = \nextra-trusted-public-keys = ',
    )
    expect(() =>
      Schema.decodeUnknownSync(BinaryCacheDescriptorSchema)({ ...reapi, digest: 'SHA1' }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(BinaryCacheDescriptorSchema, { onExcessProperty: 'error' })({
        ...reapi,
        authToken: 'secret',
      }),
    ).toThrow()
    expect(
      readBinaryCacheDescriptors(new URL('../../nix/binary-caches.json', import.meta.url)),
    ).toEqual(effectUtilsBinaryCaches)
  })
})

describe('Cachix publisher', () => {
  it('makes ordinary action read-only and limits push token to protected publisher', () => {
    expect(cachixStep({ name: 'example' }).with).toEqual({ name: 'example', skipPush: true })
    const publisher = cachixPublisherStep({
      name: 'example',
      authToken: 'secret-expression',
      jobIf: protectedIf,
      triggers: ['push'],
    })
    expect(publisher.with).toEqual({ name: 'example', authToken: 'secret-expression' })
    expect(publisher.if).toContain("github.ref == 'refs/heads/main'")
    const push = cachixPushStep({
      jobIf: protectedIf,
      triggers: ['push'],
      authToken: 'secret-expression',
      step: { run: 'cachix push example ./result', if: "steps.scope.outputs.publish == 'true'" },
    })
    expect(push.env).toEqual({ CACHIX_AUTH_TOKEN: 'secret-expression' })
    expect(push.if).toContain("github.ref == 'refs/heads/main'")
    expect(push.if).toContain("steps.scope.outputs.publish == 'true'")
    const scheduled = cachixPublisherStep({
      name: 'example',
      authToken: 'secret-expression',
      jobIf: "github.ref == 'refs/heads/main' && github.event_name == 'schedule'",
      triggers: ['schedule'],
    })
    expect(scheduled.if).toContain("github.event_name == 'schedule'")
  })

  it('rejects unprotected jobs and mismatched triggers', () => {
    for (const jobIf of [
      "github.event_name == 'push'",
      "github.ref == 'refs/heads/main' && github.event_name == 'pull_request'",
    ]) {
      expect(() =>
        cachixPublisherStep({ name: 'example', authToken: 'token', jobIf, triggers: ['push'] }),
      ).toThrow(CachePublisherJobError)
      expect(() =>
        cachixPushStep({
          jobIf,
          triggers: ['push'],
          authToken: 'token',
          step: { run: 'cachix push example ./result' },
        }),
      ).toThrow(CachePublisherJobError)
    }
  })
})
