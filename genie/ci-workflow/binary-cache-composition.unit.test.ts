import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { githubWorkflow } from '../../packages/@overeng/genie/src/runtime/mod.ts'
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
import { validateWorkflowCachePolicy } from './cache-policy.ts'
import {
  cachixPublisherStep,
  cachixPushStep,
  cachixStep,
  CachePublisherJobError,
  installNixStep,
} from './setup.ts'
import { ciWorkflow } from './shared.ts'

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
    expect(installNixStep({ binaryCaches: [privateCache] }).with['extra-conf']).toContain(
      privateCache.uri,
    )
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
    expect(() =>
      ciWorkflow({
        trustTier: 'public',
        on: { push: { branches: ['main'] } },
        jobs: {
          invalid: {
            'runs-on': 'ubuntu-latest',
            steps: [installNixStep({ binaryCaches: [privateCache] })],
          },
        },
      }),
    ).toThrow(PrivateBinaryCacheRunnerError)
  })

  it('validates final runner rather than any detached install argument', () => {
    const step = installNixStep({ binaryCaches: [privateCache] })
    for (const runsOn of [
      'ubuntu-latest',
      '${{ matrix.runner }}',
      ['sh-linux-x64', '${{ matrix.extra }}'],
      'sh-unregistered',
    ]) {
      expect(() =>
        ciWorkflow({
          trustTier: 'public',
          on: { push: { branches: ['main'] } },
          jobs: { build: { 'runs-on': runsOn, steps: [{ ...step }] } },
        }),
      ).toThrow(PrivateBinaryCacheRunnerError)
    }
    expect(() =>
      ciWorkflow({
        trustTier: 'public',
        on: { push: { branches: ['main'] } },
        jobs: { build: { 'runs-on': ['sh-linux-x64', 'nix'], steps: [step] } },
      }),
    ).not.toThrow()
    expect(() =>
      ciWorkflow({
        trustTier: 'public',
        on: { push: { branches: ['main'] } },
        binaryCaches: [privateCache],
        jobs: {
          build: {
            'runs-on': 'ubuntu-latest',
            env: { NIX_CONFIG: `extra-substituters = ${privateCache.uri}` },
            steps: [{ run: 'true' }],
          },
        },
      }),
    ).toThrow(PrivateBinaryCacheRunnerError)
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

  it('reads private Nix and REAPI descriptors through the JSON reader', () => {
    const privateReapi: Cache = {
      kind: 'reapi',
      name: 'private-reapi',
      visibility: 'private',
      endpoint: 'grpcs://reapi.example.test:443',
      instanceName: 'effect-utils',
      digest: 'SHA256',
    }
    const dir = mkdtempSync(join(tmpdir(), 'binary-caches-'))
    try {
      const file = join(dir, 'binary-caches.json')
      writeFileSync(
        file,
        JSON.stringify({ [privateCache.name]: privateCache, [privateReapi.name]: privateReapi }),
      )
      expect(readBinaryCacheDescriptors(pathToFileURL(file))).toEqual({
        [privateCache.name]: privateCache,
        [privateReapi.name]: privateReapi,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

it('guards private descriptors through direct githubWorkflow output', () => {
  expect(() =>
    githubWorkflow({
      on: { push: { branches: ['main'] } },
      jobs: {
        build: {
          'runs-on': 'ubuntu-latest',
          steps: [installNixStep({ binaryCaches: [privateCache] })],
        },
      },
    }),
  ).toThrow(PrivateBinaryCacheRunnerError)
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

  it('checks final job-level scope and workflow triggers, not publisher constructor claims', () => {
    const publisher = cachixPublisherStep({
      name: 'example',
      authToken: 'token',
      jobIf: protectedIf,
      triggers: ['push'],
    })
    for (const [on, condition] of [
      [{ pull_request: null }, protectedIf],
      [{ workflow_dispatch: null }, "github.ref == 'refs/heads/main'"],
      [
        { push: { branches: ['main'] } },
        "github.ref == 'refs/heads/main' && (github.event_name == 'push') || github.event_name == 'pull_request'",
      ],
    ] as const) {
      expect(() =>
        ciWorkflow({
          trustTier: 'public',
          on,
          jobs: { publish: { 'runs-on': 'ubuntu-latest', if: condition, steps: [publisher] } },
        }),
      ).toThrow(CachePublisherJobError)
    }
    expect(() =>
      ciWorkflow({
        trustTier: 'public',
        on: { push: { branches: ['main'] }, pull_request: null },
        jobs: {
          publish: {
            'runs-on': 'ubuntu-latest',
            if: "github.ref == 'refs/heads/main' && (github.event_name == 'push')",
            steps: [publisher],
          },
        },
      }),
    ).not.toThrow()
    expect(() =>
      validateWorkflowCachePolicy({
        workflow: {
          on: { schedule: [{ cron: '0 0 * * *' }] },
          jobs: {
            publish: {
              'runs-on': 'ubuntu-latest',
              if: "github.ref == 'refs/heads/main' && github.event_name == 'schedule'",
              steps: [{ run: 'cachix push example ./result', env: { CACHIX_AUTH_TOKEN: 'token' } }],
            },
          },
        },
      }),
    ).not.toThrow()
    expect(() =>
      validateWorkflowCachePolicy({
        workflow: {
          on: { workflow_dispatch: null },
          jobs: {
            publish: {
              'runs-on': 'ubuntu-latest',
              if: "github.event_name == 'workflow_dispatch'",
              steps: [{ run: 'cachix push example ./result', env: { CACHIX_AUTH_TOKEN: 'token' } }],
            },
          },
        },
      }),
    ).toThrow(CachePublisherJobError)
  })

  it('rejects implicit Cachix action writes and job-wide tokens', () => {
    for (const workflow of [
      {
        on: { push: { branches: ['main'] } },
        jobs: {
          build: {
            'runs-on': 'ubuntu-latest',
            steps: [{ uses: 'cachix/cachix-action@v16', with: { name: 'example' } }],
          },
        },
      },
      {
        on: { push: { branches: ['main'] } },
        jobs: {
          build: {
            'runs-on': 'ubuntu-latest',
            if: protectedIf,
            env: { CACHIX_AUTH_TOKEN: 'token' },
            steps: [{ run: 'true' }],
          },
        },
      },
    ] as const) {
      expect(() => validateWorkflowCachePolicy({ workflow })).toThrow(CachePublisherJobError)
    }
  })

  it('keeps named publisher secret expressions inside the publishing step', () => {
    const token = '${{ secrets.PUBLISH_TOKEN }}'
    const publisher = cachixPublisherStep({
      name: 'example',
      authToken: token,
      jobIf: protectedIf,
      triggers: ['push'],
    })
    const job = {
      'runs-on': 'ubuntu-latest',
      if: protectedIf,
      steps: [publisher],
    }
    const on = { push: { branches: ['main'] } } as const
    expect(() => githubWorkflow({ on, jobs: { publish: job } })).not.toThrow()
    expect(() =>
      githubWorkflow({
        on,
        env: { PUBLISH_TOKEN: token },
        jobs: { publish: job },
      }),
    ).toThrow(CachePublisherJobError)
    expect(() =>
      githubWorkflow({
        on,
        jobs: { publish: { ...job, env: { PUBLISH_TOKEN: token } } },
      }),
    ).toThrow(CachePublisherJobError)
    expect(() =>
      githubWorkflow({
        on,
        jobs: {
          publish: {
            ...job,
            steps: [{ run: 'echo read', env: { PUBLISH_TOKEN: token } }, publisher],
          },
        },
      }),
    ).toThrow(CachePublisherJobError)
    expect(() =>
      githubWorkflow({
        on,
        jobs: {
          publish: {
            ...job,
            steps: [{ uses: 'actions/cache@v4', with: { authToken: token } }, publisher],
          },
        },
      }),
    ).toThrow(CachePublisherJobError)
    expect(() =>
      githubWorkflow({
        on,
        jobs: { publish: { ...job, steps: [{ run: `echo ${token}` }, publisher] } },
      }),
    ).toThrow(CachePublisherJobError)
  })

  it('rejects bracket aliases and aggregate or dynamic secrets outside publisher steps', () => {
    const publisher = cachixPublisherStep({
      name: 'example',
      authToken: '${{ secrets.PUBLISH_TOKEN }}',
      jobIf: protectedIf,
      triggers: ['push'],
    })
    const on = { push: { branches: ['main'] } } as const
    const job = { 'runs-on': 'ubuntu-latest', if: protectedIf, steps: [publisher] }
    for (const alias of ["${{ secrets['PUBLISH_TOKEN'] }}", '${{ secrets["PUBLISH_TOKEN"] }}']) {
      expect(() =>
        githubWorkflow({
          on,
          env: { ALIAS: alias },
          jobs: { publish: job },
        }),
      ).toThrow(CachePublisherJobError)
      expect(() =>
        githubWorkflow({
          on,
          jobs: {
            publish: { ...job, steps: [{ run: 'echo read', env: { ALIAS: alias } }, publisher] },
          },
        }),
      ).toThrow(CachePublisherJobError)
    }
    for (const aggregate of [
      '${{ toJSON(secrets) }}',
      '${{ secrets[inputs.token] }}',
      '${{ secrets }}',
    ]) {
      expect(() =>
        githubWorkflow({
          on,
          env: { ALIAS: aggregate },
          jobs: { publish: job },
        }),
      ).toThrow(CachePublisherJobError)
      expect(() =>
        githubWorkflow({
          on,
          jobs: { publish: { ...job, env: { ALIAS: aggregate } } },
        }),
      ).toThrow(CachePublisherJobError)
      expect(() =>
        githubWorkflow({
          on,
          jobs: { publish: { ...job, steps: [{ run: `echo '${aggregate}'` }, publisher] } },
        }),
      ).toThrow(CachePublisherJobError)
    }
  })
})
