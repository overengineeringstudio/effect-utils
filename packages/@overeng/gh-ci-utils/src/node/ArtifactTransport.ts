import { Effect, Stream } from 'effect'
import type { HttpClientResponse } from 'effect/http'

import { ARTIFACT_LIMITS, ArtifactError, type ArtifactSelection } from '../isomorphic/Artifacts.ts'

/** Repository/run selection, optionally narrowed to one retained artifact. */
export type ArtifactRequest = Pick<ArtifactSelection, 'repo' | 'runId'> & {
  readonly artifactId?: number
}

/** Build a sanitized failure without raw transport causes or signed URLs. */
export const artifactFailure = ({
  selection,
  reason,
  message,
}: {
  readonly selection: ArtifactRequest
  readonly reason: ArtifactError['reason']
  readonly message: string
}): ArtifactError =>
  new ArtifactError({
    repo: selection.repo,
    runId: selection.runId,
    artifactId: selection.artifactId ?? null,
    member: null,
    reason,
    message,
  })

const positiveId = (value: number) => Number.isSafeInteger(value) && value > 0

/** Validate bounded artifact selection before issuing any network request. */
export const validateArtifactRequest = Effect.fn('artifact-transport.validate')(function* (
  selection: ArtifactRequest,
  page = 1,
) {
  const validRepo =
    /^(?=.{1,39}\/)[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\/[A-Za-z0-9_.-]{1,100}$/u.exec(
      selection.repo,
    )?.[0] === selection.repo &&
    !selection.repo.endsWith('/.') &&
    !selection.repo.endsWith('/..')
  if (
    !validRepo ||
    !positiveId(selection.runId) ||
    (selection.artifactId !== undefined && !positiveId(selection.artifactId)) ||
    !positiveId(page) ||
    page > ARTIFACT_LIMITS.maxPage
  )
    return yield* artifactFailure({
      selection: {
        repo: validRepo ? selection.repo : '',
        runId: positiveId(selection.runId) ? selection.runId : 0,
        ...(selection.artifactId !== undefined && positiveId(selection.artifactId)
          ? { artifactId: selection.artifactId }
          : {}),
      },
      reason: 'invalid-selection',
      message: 'Expected owner/repo, positive safe integer IDs, and a page from 1 to 1000',
    })
})

/** Only GitHub's retained-artifact storage hosts, never arbitrary redirect targets. */
export const artifactStorageUrl = (location: string | undefined): URL | undefined => {
  if (location === undefined) return undefined
  const url = URL.parse(location)
  if (
    url === null ||
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    url.port !== ''
  )
    return undefined
  const host = url.hostname.toLowerCase()
  return ['.blob.core.windows.net', '.actions.githubusercontent.com'].some(
    (suffix) => host.endsWith(suffix) && host.length > suffix.length,
  )
    ? url
    : undefined
}

/** Enforce the ceiling before retaining each chunk, including chunked responses. */
export const readArtifactBody = Effect.fn('artifact-transport.read-body')(function* (
  response: HttpClientResponse.HttpClientResponse,
  selection: ArtifactRequest,
  limit: number,
) {
  const oversized = artifactFailure({
    selection: selection,
    reason: 'limit-exceeded',
    message: `Artifact HTTP response exceeds the ${limit}-byte limit`,
  })
  const length = response.headers['content-length']
  if (length !== undefined && /^\d+$/u.test(length) && BigInt(length) > BigInt(limit))
    return yield* oversized
  const chunks: Uint8Array[] = []
  let size = 0
  yield* response.stream.pipe(
    Stream.mapError(() =>
      artifactFailure({
        selection: selection,
        reason: 'transport',
        message: 'Failed to consume artifact response',
      }),
    ),
    Stream.runForEach((chunk) => {
      if (chunk.byteLength > limit - size) return Effect.fail(oversized)
      size += chunk.byteLength
      chunks.push(chunk)
      return Effect.void
    }),
  )
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
})
