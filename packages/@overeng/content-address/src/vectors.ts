const seededBytes = ({
  length,
  seed,
}: {
  readonly length: number
  readonly seed: number
}): Uint8Array => {
  const result = new Uint8Array(length)
  let state = seed >>> 0
  for (let index = 0; index < length; index++) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    result[index] = state & 255
  }
  return result
}

/** Deterministic SHA-256 byte fixtures shared by actual JS, wasm and native products. */
export const hashVectors = [
  {
    name: 'empty',
    bytes: new Uint8Array(),
    expected: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  },
  {
    name: 'abc',
    bytes: new TextEncoder().encode('abc'),
    expected: 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  },
  {
    name: '1MB',
    bytes: seededBytes({ length: 1024 * 1024, seed: 0x12345678 }),
    expected: 'sha256:5b64b12ad6e657f403f9e3e57e4ad6fbd1d8fb14c53a0c7e1dc5dbd2257166b1',
  },
  {
    name: 'random',
    bytes: seededBytes({ length: 65537, seed: 0xdecafbad }),
    expected: 'sha256:24f79c9f2d7473a10d5361fe21d5f077a57ebc51f487b2bd3ce05d59e69fb262',
  },
] as const
/** Acceptance expectation for a public descriptor and its portable projection. */
export interface DescriptorVector {
  readonly name: string
  readonly input: unknown
  readonly accept: boolean
}
/** Public descriptor boundaries independently exercised against Rust validation. */
export const descriptorVectors: readonly DescriptorVector[] = (() => {
  const valid = {
    _tag: 'ContentDescriptor',
    digest: hashVectors[1].expected,
    byteLength: 3,
    mediaType: 'text/plain',
  }
  return [
    { name: 'minimal', input: valid, accept: true },
    { name: 'metadata', input: { ...valid, codec: 'utf8', schemaVersion: 1 }, accept: true },
    {
      name: 'safe-integer-boundary',
      input: {
        ...valid,
        byteLength: Number.MAX_SAFE_INTEGER,
        schemaVersion: Number.MAX_SAFE_INTEGER,
      },
      accept: true,
    },
    { name: 'unicode-media', input: { ...valid, mediaType: 'é/中' }, accept: true },
    { name: 'non-trim-whitespace', input: { ...valid, mediaType: '\u0085x\u0085' }, accept: true },
    {
      name: 'digest-final-newline',
      input: { ...valid, digest: `${valid.digest}\n` },
      accept: false,
    },
    { name: 'unknown-field', input: { ...valid, extra: true }, accept: false },
    { name: 'negative', input: { ...valid, byteLength: -1 }, accept: false },
    { name: 'fraction', input: { ...valid, byteLength: 0.5 }, accept: false },
    {
      name: 'unsafe-integer',
      input: { ...valid, byteLength: Number.MAX_SAFE_INTEGER + 1 },
      accept: false,
    },
    { name: 'wrong-tag', input: { ...valid, _tag: 'Wrong' }, accept: false },
    {
      name: 'digest-upper',
      input: { ...valid, digest: valid.digest.toUpperCase() },
      accept: false,
    },
    { name: 'digest-short', input: { ...valid, digest: 'sha256:abc' }, accept: false },
    { name: 'media-empty', input: { ...valid, mediaType: '' }, accept: false },
    { name: 'media-leading-space', input: { ...valid, mediaType: ' text/plain' }, accept: false },
    {
      name: 'media-trailing-bom',
      input: { ...valid, mediaType: 'text/plain\ufeff' },
      accept: false,
    },
    { name: 'null-option', input: { ...valid, codec: null }, accept: false },
  ]
})()
