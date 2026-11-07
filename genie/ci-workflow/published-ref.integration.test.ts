import { describe, expect, it } from 'bun:test'

import ciWorkflow from '../../.github/workflows/ci.yml.genie.ts'
import { publishedRefSteps } from './published-ref.ts'

const main = 'a'.repeat(40)
const later = 'b'.repeat(40)
const tip = 'c'.repeat(40)
const reportStep = publishedRefSteps.at(-1)!

/** Fake only the remote API boundary; execute the actual generated shell and trailer parser. */
const runReport = ({
  message = `Publish products\n\nPublished-From: ${main}`,
  comparison = { status: 'identical', behind_by: 0 },
  fail = '',
}: {
  message?: string
  comparison?: { status?: string; behind_by?: number }
  fail?: string
} = {}) =>
  Bun.spawnSync(
    [
      'bash',
      '-euo',
      'pipefail',
      '-c',
      [
        'gh() {',
        '  printf "CALL %s\\n" "$*" >&2',
        '  case "$*" in',
        '    *"--method POST"*)',
        '      if [ "$FAIL" = post ]; then return 1; fi',
        '      echo POSTED',
        '      ;;',
        '    *git/ref/heads/published*)',
        '      if [ "$FAIL" = ref ]; then return 1; fi',
        '      printf "%s" "$REF_JSON" | jq -r "${@: -1}"',
        '      ;;',
        '    *git/commits/*)',
        '      if [ "$FAIL" = commit ]; then return 1; fi',
        '      printf "%s" "$COMMIT_JSON" | jq -r "${@: -1}"',
        '      ;;',
        '    *compare/*)',
        '      if [ "$FAIL" = compare ]; then return 1; fi',
        '      printf "%s" "$COMPARE_JSON" | jq -r "${@: -1}"',
        '      ;;',
        '    *) return 1 ;;',
        '  esac',
        '}',
        reportStep.run,
      ].join('\n'),
    ],
    {
      env: {
        ...process.env,
        GITHUB_SHA: main,
        GITHUB_REPOSITORY: 'example/repo',
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_RUN_ID: '123',
        REF_JSON: JSON.stringify({ object: { sha: tip } }),
        COMMIT_JSON: JSON.stringify({ message }),
        COMPARE_JSON: JSON.stringify(comparison),
        FAIL: fail,
      },
    },
  )

describe('promote-published verified status', () => {
  it('uses only contents:read and statuses:write, with reporting last and success-only', () => {
    const job = ciWorkflow.data.jobs['promote-published']!
    expect(job.permissions).toEqual({ contents: 'read', statuses: 'write' })
    expect(job.steps.at(-1)).toEqual(reportStep)
    expect(reportStep.id).toBe('report-verified-published-status')
    expect('if' in reportStep).toBe(false)
    expect(reportStep.env).toEqual({ GH_TOKEN: '${{ github.token }}' })
  })

  for (const status of ['identical', 'ahead']) {
    it(`posts success after freshly verifying ${status}, including a later main/no-op`, () => {
      const result = runReport({
        message: `Publish products\n\nPublished-From: ${later}`,
        comparison: { status, behind_by: 0 },
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toContain('POSTED')
      const calls = result.stderr.toString()
      expect(calls).toContain('git/ref/heads/published')
      expect(calls).toContain(`git/commits/${tip}`)
      expect(calls).toContain(`compare/${main}...${later}`)
      expect(calls.indexOf('compare/')).toBeLessThan(calls.indexOf('--method POST'))
      expect(calls).toContain(`statuses/${main}`)
      expect(calls).toContain('-f state=success -f context=published/current')
      expect(calls).toContain(
        '-f description=Published contains this main commit or a later main commit',
      )
      expect(calls).toContain('-f target_url=https://github.com/example/repo/actions/runs/123')
    })
  }

  for (const message of [
    'Missing trailer',
    'Publish products\n\nPublished-From: not-a-sha',
    `Publish products\n\nPublished-From: ${main}0`,
    `Publish products\n\nPublished-From: ${'g'.repeat(40)}`,
    `Publish products\n\nPublished-From: ${main}\nPublished-From: ${later}`,
    `Published-From: ${main}\n\nNot a trailer`,
  ]) {
    it(`warns without posting for invalid provenance: ${JSON.stringify(message)}`, () => {
      const result = runReport({ message })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toContain('::warning::')
      expect(result.stderr.toString()).not.toContain('compare/')
      expect(result.stderr.toString()).not.toContain('--method POST')
    })
  }

  for (const comparison of [
    { status: 'behind', behind_by: 1 },
    { status: 'diverged', behind_by: 0 },
    { status: 'ahead', behind_by: 1 },
    { status: 'identical', behind_by: 1 },
    {},
  ]) {
    it(`warns without posting for unverified ancestry: ${JSON.stringify(comparison)}`, () => {
      const result = runReport({ comparison })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toContain('::warning::')
      expect(result.stderr.toString()).not.toContain('--method POST')
    })
  }

  for (const fail of ['ref', 'commit', 'compare', 'post']) {
    it(`leaves ${fail} API failure to published-status without failing promotion`, () => {
      const result = runReport({ fail })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toContain('::warning::')
      expect(result.stdout.toString()).not.toContain('POSTED')
      if (fail !== 'post') expect(result.stderr.toString()).not.toContain('--method POST')
    })
  }
})
