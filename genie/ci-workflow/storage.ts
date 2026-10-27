import type { GitHubWorkflowArgs } from '../../packages/@overeng/genie/src/runtime/mod.ts'

type WorkflowStep = GitHubWorkflowArgs['jobs'][string]['steps'][number]
type StorageStep = WorkflowStep & { uses: string; with: Record<string, string> }

export type ArtifactClass = 'diagnostic' | 'handoff' | 'release'

/** Content identity only; presigned URLs and runner-local paths never belong in a ref. */
export type ArtifactRef = {
  readonly repo: string
  readonly sha256: string
  readonly retention: ArtifactClass
}

/**
 * Render an upload through the checked-out local composite action. The action packs and
 * uploads before exposing `steps.<id>.outputs.ref` (JSON) and `.sha256`.
 *
 * The caller supplies a presigned PUT URL file through CI_STORAGE_PUT_URL_FILE;
 * this helper never requests credentials or embeds URL contents in the workflow.
 */
export const artifactUploadStep = ({
  id,
  paths,
  retention,
}: {
  id: string
  paths: readonly string[]
  retention: ArtifactClass
}): StorageStep => ({
  id,
  name: 'Upload CI artifact',
  uses: './.github/actions/ci-storage',
  with: {
    mode: 'upload',
    paths: JSON.stringify(paths),
    retention,
    repo: '${{ github.repository }}',
    'put-url-file': '${{ env.CI_STORAGE_PUT_URL_FILE }}',
  },
})

/**
 * Render a verified download/extraction through the checked-out local composite action.
 * `ref` is JSON or an explicit expression such as `${{ needs.build.outputs.ref }}`;
 * it remains action input data, never interpolated into a generated shell command.
 * The caller supplies CI_STORAGE_GET_URL_FILE containing the presigned GET URL.
 */
export const artifactDownloadStep = ({
  ref,
  destination,
}: {
  ref: string
  destination: string
}): StorageStep => ({
  name: 'Download CI artifact',
  uses: './.github/actions/ci-storage',
  with: {
    mode: 'download',
    ref,
    destination,
    'get-url-file': '${{ env.CI_STORAGE_GET_URL_FILE }}',
  },
})
