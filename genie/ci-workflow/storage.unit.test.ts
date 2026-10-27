import { describe, expect, it } from 'bun:test'

import { collectWorkflowPolicyViolations } from '../../packages/@overeng/genie/src/runtime/github-workflow/policy.ts'
import { fleetWorkflowPolicy } from './policy.ts'
import { linuxX64Runner } from './runners.ts'
import { artifactDownloadStep, artifactUploadStep, type ArtifactRef } from './storage.ts'

describe('CI storage rendering', () => {
  it('renders an identified upload with repository scope and only a PUT URL file input', () => {
    expect(
      artifactUploadStep({
        id: 'bundle',
        paths: ['dist', 'reports/result.json'],
        retention: 'handoff',
      }),
    ).toEqual({
      id: 'bundle',
      name: 'Upload CI artifact',
      uses: './.github/actions/ci-storage',
      with: {
        mode: 'upload',
        paths: '["dist","reports/result.json"]',
        retention: 'handoff',
        repo: '${{ github.repository }}',
        'put-url-file': '${{ env.CI_STORAGE_PUT_URL_FILE }}',
      },
    })
  })

  it('preserves every admitted retention class without translating to retention days', () => {
    for (const retention of ['diagnostic', 'handoff', 'release'] as const) {
      const step = artifactUploadStep({ id: retention, paths: ['bundle'], retention })
      expect(step.with?.retention).toBe(retention)
      expect(step.with).not.toHaveProperty('retention-days')
    }
  })

  it('encodes paths as JSON data, not shell arguments or a newline-delimited path list', () => {
    const paths = [
      'directory with spaces',
      "single'quote",
      'double"quote',
      '$(touch /tmp/ci-storage-injection)',
      '`touch /tmp/ci-storage-injection`',
      'first\nsecond',
      '--flag',
      '',
    ] as const
    const step = artifactUploadStep({ id: 'bundle', paths, retention: 'diagnostic' })
    expect(step.with?.paths).toBe(JSON.stringify(paths))
    expect(step).not.toHaveProperty('run')
    expect(step).not.toHaveProperty('shell')
  })

  it('keeps literal ref JSON and shell metacharacters in download inputs only', () => {
    const artifact: ArtifactRef = {
      repo: 'example/project',
      sha256: 'a'.repeat(64),
      retention: 'release',
    }
    const ref = JSON.stringify(artifact)
    const destination = 'output/$(touch /tmp/ci-storage-injection); "quoted"\nnext'
    expect(artifactDownloadStep({ ref, destination })).toEqual({
      name: 'Download CI artifact',
      uses: './.github/actions/ci-storage',
      with: {
        mode: 'download',
        ref,
        destination,
        'get-url-file': '${{ env.CI_STORAGE_GET_URL_FILE }}',
      },
    })
  })

  it('passes cross-job ref expressions through without quoting or evaluating them', () => {
    const ref = '${{ needs.build.outputs.ref }}'
    const destination = '${{ runner.temp }}/artifact'
    const step = artifactDownloadStep({ ref, destination })
    expect(step.with?.ref).toBe(ref)
    expect(step.with?.destination).toBe(destination)
    expect(step).not.toHaveProperty('run')
    expect(step.with).not.toHaveProperty('repo')
    expect(step.with).not.toHaveProperty('put-url-file')
  })

  it('composes upload output references without introducing forbidden storage or runner policy', () => {
    const upload = artifactUploadStep({ id: 'bundle', paths: ['dist'], retention: 'handoff' })
    const ref = '${{ steps.bundle.outputs.ref }}'
    const download = artifactDownloadStep({ ref, destination: 'restored' })
    expect(upload.id).toBe('bundle')
    expect(download.with?.ref).toBe(ref)
    expect(
      collectWorkflowPolicyViolations({
        workflow: {
          on: { push: {} },
          jobs: {
            handoff: {
              'runs-on': [...linuxX64Runner],
              steps: [upload, download],
            },
          },
        },
        policy: fleetWorkflowPolicy({
          repository: 'example/project',
          workflow: 'storage-fixture.yml',
          exceptionEntries: [],
        }),
      }),
    ).toEqual([])
  })
})
