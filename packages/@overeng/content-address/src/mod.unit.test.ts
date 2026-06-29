import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  CasUriDescriptorMismatchError,
  ContentDescriptorMismatchError,
  ContentManifest,
  ContentObjectMissingError,
  InvalidManifestDescriptorError,
  InvalidManifestRecordError,
  InvalidCasUriError,
  UnsafePinNameError,
  UnsupportedCasSchemeError,
  UnsupportedDigestAlgorithmError,
  canonicalJsonCodec,
  canonicalJsonMediaType,
  casUriForDescriptor,
  descriptorForCanonicalJson,
  descriptorForUtf8,
  getBytes,
  getPinnedManifestDescriptor,
  hashCanonicalJson,
  hasBytes,
  hasPin,
  makeFileSystemContentStore,
  objectPathForDigest,
  pinManifest,
  putBytes,
  putManifest,
  resolveCasUri,
  utf8Bytes,
  verifyDescriptor,
} from './mod.ts'

const Payload = Schema.Struct({
  alpha: Schema.String,
  nested: Schema.Struct({
    zed: Schema.Number,
    beta: Schema.Array(Schema.String),
  }),
}).annotations({ identifier: 'ContentAddressTest.Payload' })

describe('@overeng/content-address', () => {
  it('hashes canonical JSON independent of object key insertion order', () => {
    const left = Payload.make({ alpha: 'a', nested: { zed: 1, beta: ['b'] } })
    const right = { nested: { beta: ['b'], zed: 1 }, alpha: 'a' }

    expect(hashCanonicalJson({ schema: Payload, value: left })).toBe(
      hashCanonicalJson({ schema: Payload, value: right }),
    )
  })

  it('describes canonical JSON with descriptor metadata', () => {
    const descriptor = descriptorForCanonicalJson({
      schema: Payload,
      value: Payload.make({ alpha: 'a', nested: { zed: 1, beta: ['b'] } }),
      schemaVersion: 1,
    })

    expect(descriptor).toMatchObject({
      _tag: 'ContentDescriptor',
      mediaType: 'application/json',
      codec: 'canonical-json',
      schemaVersion: 1,
    })
    expect(descriptor.digest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(descriptor.byteLength).toBeGreaterThan(0)
  })

  it('verifies matching bytes and fails closed on mismatches', async () => {
    const descriptor = descriptorForUtf8({ value: 'hello' })

    await expect(
      Effect.runPromise(verifyDescriptor({ descriptor, bytes: utf8Bytes('hello') })),
    ).resolves.toBeUndefined()
    const mismatch = await Effect.runPromise(
      verifyDescriptor({ descriptor, bytes: utf8Bytes('HELLO') }).pipe(Effect.either),
    )
    expect(mismatch._tag).toBe('Left')
    if (mismatch._tag === 'Left') {
      expect(mismatch.left).toBeInstanceOf(ContentDescriptorMismatchError)
    }
  })

  it('derives a stable object path segment from a digest', () => {
    expect(objectPathForDigest(`sha256:${'a'.repeat(64)}`)).toBe(`sha256/aa/${'a'.repeat(62)}`)
  })

  it('writes descriptor-addressed bytes and resolves them through a cas URI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'content-address-'))
    const store = makeFileSystemContentStore({ root })
    try {
      const descriptor = await Effect.runPromise(
        putBytes({
          store,
          bytes: utf8Bytes('profile-bytes'),
          mediaType: 'application/octet-stream',
        }),
      )
      const uri = casUriForDescriptor(descriptor)

      await expect(Effect.runPromise(hasBytes({ store, descriptor }))).resolves.toBe(true)
      await expect(Effect.runPromise(getBytes({ store, descriptor }))).resolves.toEqual(
        utf8Bytes('profile-bytes'),
      )
      await expect(Effect.runPromise(resolveCasUri({ store, uri, descriptor }))).resolves.toEqual(
        utf8Bytes('profile-bytes'),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed when cas URI and descriptor disagree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'content-address-'))
    const store = makeFileSystemContentStore({ root })
    try {
      const descriptor = await Effect.runPromise(
        putBytes({ store, bytes: utf8Bytes('left'), mediaType: 'text/plain' }),
      )
      const other = await Effect.runPromise(
        putBytes({ store, bytes: utf8Bytes('right'), mediaType: 'text/plain' }),
      )

      const mismatch = await Effect.runPromise(
        resolveCasUri({ store, uri: casUriForDescriptor(other), descriptor }).pipe(Effect.either),
      )

      expect(mismatch._tag).toBe('Left')
      if (mismatch._tag === 'Left') {
        expect(mismatch.left).toBeInstanceOf(CasUriDescriptorMismatchError)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails with a typed error for invalid cas URIs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'content-address-'))
    const store = makeFileSystemContentStore({ root })
    try {
      const descriptor = await Effect.runPromise(
        putBytes({ store, bytes: utf8Bytes('left'), mediaType: 'text/plain' }),
      )

      const invalid = await Effect.runPromise(
        resolveCasUri({ store, uri: 'cas:sha256/aa/not-enough', descriptor }).pipe(Effect.either),
      )

      expect(invalid._tag).toBe('Left')
      if (invalid._tag === 'Left') {
        expect(invalid.left).toBeInstanceOf(InvalidCasUriError)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('distinguishes unsupported cas schemes and digest algorithms', async () => {
    const root = await mkdtemp(join(tmpdir(), 'content-address-'))
    const store = makeFileSystemContentStore({ root })
    try {
      const descriptor = await Effect.runPromise(
        putBytes({ store, bytes: utf8Bytes('left'), mediaType: 'text/plain' }),
      )

      const unsupportedScheme = await Effect.runPromise(
        resolveCasUri({ store, uri: 'file:///tmp/profile', descriptor }).pipe(Effect.either),
      )
      const unsupportedAlgorithm = await Effect.runPromise(
        resolveCasUri({ store, uri: `cas:blake3/${'a'.repeat(64)}`, descriptor }).pipe(
          Effect.either,
        ),
      )

      expect(unsupportedScheme._tag).toBe('Left')
      if (unsupportedScheme._tag === 'Left') {
        expect(unsupportedScheme.left).toBeInstanceOf(UnsupportedCasSchemeError)
      }
      expect(unsupportedAlgorithm._tag).toBe('Left')
      if (unsupportedAlgorithm._tag === 'Left') {
        expect(unsupportedAlgorithm.left).toBeInstanceOf(UnsupportedDigestAlgorithmError)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps malformed sha256 cas paths as invalid URI errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'content-address-'))
    const store = makeFileSystemContentStore({ root })
    try {
      const descriptor = await Effect.runPromise(
        putBytes({ store, bytes: utf8Bytes('left'), mediaType: 'text/plain' }),
      )

      const invalid = await Effect.runPromise(
        resolveCasUri({ store, uri: 'cas:sha256/not-enough', descriptor }).pipe(Effect.either),
      )

      expect(invalid._tag).toBe('Left')
      if (invalid._tag === 'Left') {
        expect(invalid.left).toBeInstanceOf(InvalidCasUriError)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('stores canonical manifests and writes manifest pins as retention roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'content-address-'))
    const store = makeFileSystemContentStore({ root })
    try {
      const artifact = await Effect.runPromise(
        putBytes({ store, bytes: utf8Bytes('profile'), mediaType: 'application/octet-stream' }),
      )
      const manifest = ContentManifest.make({
        schemaVersion: 1,
        role: 'otel-scrape-run',
        entries: [{ descriptor: artifact, logicalPath: 'profiles/profile.cpuprofile' }],
      })
      const manifestDescriptor = await Effect.runPromise(putManifest({ store, manifest }))

      expect(manifestDescriptor.mediaType).toBe(canonicalJsonMediaType)
      expect(manifestDescriptor.codec).toBe(canonicalJsonCodec)
      await Effect.runPromise(pinManifest({ store, name: 'runs/run-1', manifestDescriptor }))

      await expect(Effect.runPromise(hasPin({ store, name: 'runs/run-1' }))).resolves.toBe(true)
      const pinSource = await readFile(join(root, 'pins', 'runs', 'run-1'), 'utf8')
      expect(pinSource).toContain(manifestDescriptor.digest)
      await expect(
        Effect.runPromise(getPinnedManifestDescriptor({ store, name: 'runs/run-1' })),
      ).resolves.toMatchObject({ digest: manifestDescriptor.digest })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects unsafe pin names before writing store metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'content-address-'))
    const store = makeFileSystemContentStore({ root })
    try {
      const artifact = await Effect.runPromise(
        putBytes({ store, bytes: utf8Bytes('profile'), mediaType: 'application/octet-stream' }),
      )
      const unsafe = await Effect.runPromise(
        pinManifest({ store, name: '../escape', manifestDescriptor: artifact }).pipe(Effect.either),
      )
      const dot = await Effect.runPromise(
        pinManifest({ store, name: '.', manifestDescriptor: artifact }).pipe(Effect.either),
      )
      const dotted = await Effect.runPromise(
        pinManifest({ store, name: 'runs/.', manifestDescriptor: artifact }).pipe(Effect.either),
      )

      expect(unsafe._tag).toBe('Left')
      if (unsafe._tag === 'Left') {
        expect(unsafe.left).toBeInstanceOf(UnsafePinNameError)
      }
      expect(dot._tag).toBe('Left')
      if (dot._tag === 'Left') {
        expect(dot.left).toBeInstanceOf(UnsafePinNameError)
      }
      expect(dotted._tag).toBe('Left')
      if (dotted._tag === 'Left') {
        expect(dotted.left).toBeInstanceOf(UnsafePinNameError)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects direct blob descriptors as manifest pins', async () => {
    const root = await mkdtemp(join(tmpdir(), 'content-address-'))
    const store = makeFileSystemContentStore({ root })
    try {
      const artifact = await Effect.runPromise(
        putBytes({ store, bytes: utf8Bytes('profile'), mediaType: 'application/octet-stream' }),
      )
      const invalidPin = await Effect.runPromise(
        pinManifest({ store, name: 'runs/run-1', manifestDescriptor: artifact }).pipe(
          Effect.either,
        ),
      )

      expect(invalidPin._tag).toBe('Left')
      if (invalidPin._tag === 'Left') {
        expect(invalidPin.left).toBeInstanceOf(InvalidManifestDescriptorError)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects manifest pins whose target object is not stored locally', async () => {
    const root = await mkdtemp(join(tmpdir(), 'content-address-'))
    const store = makeFileSystemContentStore({ root })
    try {
      const manifest = ContentManifest.make({
        schemaVersion: 1,
        role: 'otel-scrape-run',
        entries: [],
      })
      const missingDescriptor = descriptorForCanonicalJson({
        schema: ContentManifest,
        value: manifest,
        schemaVersion: 1,
      })

      const invalidPin = await Effect.runPromise(
        pinManifest({ store, name: 'runs/run-1', manifestDescriptor: missingDescriptor }).pipe(
          Effect.either,
        ),
      )

      expect(invalidPin._tag).toBe('Left')
      if (invalidPin._tag === 'Left') {
        expect(invalidPin.left).toBeInstanceOf(ContentObjectMissingError)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects manifest pins whose stored target does not decode as a manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'content-address-'))
    const store = makeFileSystemContentStore({ root })
    try {
      const malformedManifestDescriptor = await Effect.runPromise(
        putBytes({
          store,
          bytes: utf8Bytes('{}'),
          mediaType: canonicalJsonMediaType,
          codec: canonicalJsonCodec,
          schemaVersion: 1,
        }),
      )

      const invalidPin = await Effect.runPromise(
        pinManifest({
          store,
          name: 'runs/run-1',
          manifestDescriptor: malformedManifestDescriptor,
        }).pipe(Effect.either),
      )

      expect(invalidPin._tag).toBe('Left')
      if (invalidPin._tag === 'Left') {
        expect(invalidPin.left).toBeInstanceOf(InvalidManifestRecordError)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
