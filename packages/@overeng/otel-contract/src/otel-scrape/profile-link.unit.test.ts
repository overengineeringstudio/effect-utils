import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  ContentManifest,
  casUriForDescriptor,
  getPinnedManifestDescriptor,
  makeFileSystemContentStore,
  pinManifest,
  putBytes,
  putManifest,
  resolveCasUri,
  utf8Bytes,
} from '@overeng/content-address'

import { OtelScrapeProfileLink, otelScrapeProfileLinkFromDescriptor } from '../mod.ts'

describe('otel-scrape profile links', () => {
  it('links profile bytes through CAS descriptors, URIs, manifests, and pins', async () => {
    const root = await mkdtemp(join(tmpdir(), 'otel-scrape-profile-link-'))
    const store = makeFileSystemContentStore({ root })

    try {
      const bytes = utf8Bytes('profile fixture')
      const descriptor = await Effect.runPromise(
        putBytes({
          store,
          bytes,
          mediaType: 'application/vnd.chrome.cpuprofile+json',
          schemaVersion: 1,
        }),
      )
      const uri = casUriForDescriptor(descriptor)
      const link = otelScrapeProfileLinkFromDescriptor({
        type: 'cpuprofile',
        descriptor,
        uri,
      })

      expect(Schema.decodeUnknownSync(OtelScrapeProfileLink)(link)).toEqual(link)
      expect(link).toMatchObject({
        type: 'cpuprofile',
        digest: descriptor.digest,
        uri,
        byteLength: bytes.byteLength,
        mediaType: 'application/vnd.chrome.cpuprofile+json',
        schemaVersion: 1,
      })

      const manifest = ContentManifest.make({
        schemaVersion: 1,
        role: 'otel-scrape-run',
        entries: [
          {
            descriptor,
            logicalPath: 'profiles/profile.cpuprofile',
            role: 'profile:cpuprofile',
          },
        ],
      })
      const manifestDescriptor = await Effect.runPromise(putManifest({ store, manifest }))
      await Effect.runPromise(
        pinManifest({
          store,
          name: 'otel-scrape/run-1',
          manifestDescriptor,
        }),
      )

      await expect(
        Effect.runPromise(getPinnedManifestDescriptor({ store, name: 'otel-scrape/run-1' })),
      ).resolves.toMatchObject({ digest: manifestDescriptor.digest })
      await expect(
        Effect.runPromise(resolveCasUri({ store, uri: link.uri, descriptor })),
      ).resolves.toEqual(bytes)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
